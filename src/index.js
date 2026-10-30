// @netcomposer/nc-fx: createFxCore (audio only) and createFx (core + lazy panel).
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// No framework, no imports outside this package. The worklet code is only fetched when an instance is
// created: from opts.moduleUrl if the app gives one (recommended for Vite: `?url`, see README), or else
// from a lazily imported string turned into a Blob URL. The panel (./ui.js) is only imported by mount().
//
// Two chains, one node: the fixed chain (drive -> delay -> plate, state v1), or with `slots` ASTRID's chain model
// (up to N effects of any type in any order, state v2; see src/chain.js and src/slots.js). Both end in the
// pre-gain and the limiter.

import {
  EFFECTS, EFFECT_ORDER, STATE_VERSION, effectType, effectDef, dialDef, clampDial, dialStep, dialToDsp, PARAM_INDEX,
  sanitize, migrate, compile, cloneState, defaultState, delaySeconds, describeParams, FORMATS
} from './params.js';
import { CATALOG, CATALOG_MENU, catalogType, catalogEntry, catalogDial, formatDial, describeCatalog } from './catalog.js';
import { SLOTS_VERSION, DEFAULT_SLOTS, migrateSlots, sanitizeSlots, newSlot, slotName, moveSlot, slotProgram, toAstridHacks, toAstridDocument } from './slots.js';

export { EFFECTS, EFFECT_ORDER, STATE_VERSION, sanitize, migrate, defaultState, delaySeconds, compile, dialToDsp, describeParams, FORMATS };
export { CATALOG, CATALOG_MENU, catalogEntry, catalogDial, formatDial, describeCatalog };
export { SLOTS_VERSION, DEFAULT_SLOTS, migrateSlots, sanitizeSlots, newSlot, slotName, moveSlot, toAstridHacks, toAstridDocument };
export var PROCESSOR_NAME = 'nc-fx@1';

var HORIZON_S = 600; // seconds ahead of ctx.currentTime a timed call may be (the engine refuses more)
var PENDING_MAX = 256; // calls queued before the worklet is ready
var MAX_SLOTS = 8;

var loads = typeof WeakMap === 'function' ? new WeakMap() : null;

/**
 * Register the 'nc-fx@1' processor on a context once (later calls share the promise).
 * @param {BaseAudioContext} ctx
 * @param {string|URL} [moduleUrl] where dist/worklet.js is served; omitted = Blob URL from a lazy chunk
 */
export function loadFxWorklet(ctx, moduleUrl) {
  var p = loads && loads.get(ctx);
  if (p) return p;
  p = (async function () {
    if (!ctx || !ctx.audioWorklet) throw new Error('nc-fx: AudioWorklet is not available in this context');
    if (moduleUrl) { await ctx.audioWorklet.addModule(String(moduleUrl)); return; }
    var src = (await import('../dist/worklet-source.js')).default;
    var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  })();
  if (loads) {
    loads.set(ctx, p);
    p.catch(function () { loads.delete(ctx); });
  }
  return p;
}

function finiteOr(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

/**
 * What both chains share: the nodes, the worklet, the calls queued before it is ready, change listeners and the
 * 600 s horizon. start() gives the processorOptions (the chain's starting state); fold() replaces a full pre-ready
 * queue with one message list that loads the current state.
 */
function createHost(ctx, o, start, fold) {
  var bpm = Math.min(400, Math.max(20, finiteOr(o.bpm, 120)));
  var pending = [];
  var limiter = o.limiter === 'soft' || o.limiter === 'lookahead' ? o.limiter : 'off'; // opt-in
  var bypassMode = o.bypassMode === 'hold' ? 'hold' : 'run'; // default 'run': tails ring out
  var preGain = finiteOr(o.preGain, 1); // opt-in (ASTRID: 0.8)
  var fade = Math.max(0, finiteOr(o.crossfade, 0.012));
  var maxDelaySeconds = finiteOr(o.maxDelaySeconds, undefined);
  var input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  // Opt-in mod input (CV, e.g. Bass's accent): mono, channel 0 of whatever is connected, into node input 1.
  var modInput = null;
  if (o.modInput === true) {
    modInput = ctx.createGain();
    modInput.channelCount = 1; modInput.channelCountMode = 'explicit'; modInput.channelInterpretation = 'discrete';
  }
  wet.gain.value = 0;
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  var H = { node: null, status: 'loading', error: null, disposed: false, listeners: [], bpm: bpm };
  var startOpts = start(bpm);

  H.post = function (msg) {
    if (H.node) H.node.port.postMessage(msg);
    else if (!H.disposed) {
      // Capped: past PENDING_MAX the queue folds into one load of the current state plus the tempo (now).
      if (pending.length >= PENDING_MAX) pending = fold().concat([{ t: 'tempo', bpm: H.bpm, when: 0 }]);
      pending.push(msg);
    }
  };
  // Pending calls whose time has passed (or that had none) become 'now' and snap; future ones keep their time.
  function takePending(now) {
    var out = pending.map(function (m) {
      var c = Object.assign({}, m);
      if (!(c.when > now)) { c.when = 0; if (c.t !== 'clear') c.snap = true; }
      return c;
    });
    pending = [];
    return out;
  }
  H.emit = function (change) {
    for (var i = 0; i < H.listeners.length; i++) {
      try { H.listeners[i](change); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    }
  };
  H.whenOf = function (at) { return typeof at === 'number' && isFinite(at) && at > 0 ? at : 0; };
  // A time more than HORIZON_S past ctx.currentTime is almost always on the wrong clock (epoch seconds from
  // nc-clock's timeAt() without toContextTime()). Refuse it, once with a warning, and change nothing.
  var warned = false;
  H.tooFar = function (at) {
    if (!(typeof at === 'number' && at > ctx.currentTime + HORIZON_S)) return false;
    if (!warned && typeof console !== 'undefined') {
      warned = true;
      console.warn('nc-fx: ignoring a time ' + Math.round(at - ctx.currentTime) + ' s ahead of AudioContext time; ' +
        'convert clock times with toContextTime() (see followClock)');
    }
    return true;
  };

  var ready = loadFxWorklet(ctx, o.moduleUrl).then(function () {
    if (H.disposed) return;
    var po = Object.assign({ bpm: bpm, bypassMode: bypassMode, limiter: limiter, preGain: preGain, maxDelaySeconds: maxDelaySeconds }, startOpts);
    po.pending = takePending(ctx.currentTime);
    H.node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: modInput ? 2 : 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: po
    });
    input.connect(H.node);
    if (modInput) modInput.connect(H.node, 0, 1);
    H.node.connect(wet);
    // Wire -> chain, on the audio clock. Before the context has run, just switch.
    var t = ctx.currentTime;
    if (t <= 0 || fade === 0) { dry.gain.value = 0; wet.gain.value = 1; }
    else {
      dry.gain.setValueAtTime(1, t); dry.gain.linearRampToValueAtTime(0, t + fade);
      wet.gain.setValueAtTime(0, t); wet.gain.linearRampToValueAtTime(1, t + fade);
    }
    H.status = 'ready';
  }, function (e) {
    H.status = 'unavailable'; // stays a wire: the sound goes on, dry
    pending = [];
    H.error = e;
  });

  H.core = {
    input: input,
    output: output,
    modInput: modInput,
    /** Resolves when the chain is in the signal path (or when it gave up: see status). Never rejects. */
    ready: ready,
    get status() { return H.status; },
    get error() { return H.error; },
    /** Samples the chain delays the signal by (the lookahead limiter's 1.5 ms; 0 for 'soft'/'off'). */
    latencySamples: limiter === 'lookahead' ? Math.max(1, Math.round(0.0015 * ctx.sampleRate)) : 0,
    /** The limiter after the chain: 'off', 'soft' or 'lookahead'. */
    limiter: limiter,
    /** Host tempo (BPM) for the synced delay, optionally at an AudioContext time (at most 600 s ahead). */
    setTempo: function (nextBpm, at) {
      var b = finiteOr(nextBpm, NaN);
      if (!(b > 0) || H.disposed || H.tooFar(at)) return;
      H.bpm = Math.min(400, Math.max(20, b));
      H.post({ t: 'tempo', bpm: H.bpm, when: H.whenOf(at) });
      H.emit({ effect: null, key: 'tempo', value: H.bpm });
    },
    getTempo: function () { return H.bpm; },
    /**
     * Panic: drop the delay and reverb tails now, or at an AudioContext time: clear(at) or clear({at, fadeMs}).
     * fadeMs > 0 (max 1000) ramps the wet down first and back in after (no click). The instant clear also
     * resets the drive's one-sample state (with slots: every effect's state); neither resets the limiter.
     */
    clear: function (at) {
      var c = at && typeof at === 'object' ? at : { at: at };
      if (H.disposed || H.tooFar(c.at)) return;
      var fadeMs = finiteOr(c.fadeMs, 0);
      H.post({ t: 'clear', when: H.whenOf(c.at), fadeMs: fadeMs > 0 ? Math.min(1000, fadeMs) : 0 });
    },
    /** Called after every change with {effect, key, value} (effect null for whole-state, chain or tempo changes). */
    onChange: function (cb) {
      H.listeners.push(cb);
      return function () { var i = H.listeners.indexOf(cb); if (i >= 0) H.listeners.splice(i, 1); };
    },
    dispose: function () {
      if (H.disposed) return;
      H.disposed = true;
      H.status = 'disposed';
      pending = [];
      H.listeners.length = 0;
      if (H.node) { H.node.port.postMessage({ t: 'dispose' }); H.node.port.close(); try { H.node.disconnect(); } catch (e) { /* */ } }
      [input, dry, wet, output, modInput].forEach(function (n) { try { if (n) n.disconnect(); } catch (e) { /* */ } });
    }
  };
  return H;
}

/**
 * The chain as Web Audio nodes: input -> effects -> pre-gain -> limiter -> output.
 * Without `slots`: the fixed chain, drive -> delay -> reverb. With `slots` (true = 3, or 1-8): ASTRID's chain model.
 * Usable at once (it is a plain wire until the worklet is up, then crossfades in on the audio clock).
 * @param {BaseAudioContext} ctx
 * @param {import('./index').FxCoreOptions} [opts]
 * @returns {import('./index').FxCore}
 */
export function createFxCore(ctx, opts) {
  var o = opts || {};
  if (o.slots) return createSlotCore(ctx, o);
  var state = sanitize(o.state);
  // The worklet starts from the construction-time state and tempo. Calls made before it is ready are
  // queued (in call order) and replayed at their AudioContext times, never folded into this start.
  var startProgram = Array.from(compile(state));
  var H = createHost(ctx, o, function () { return { program: startProgram }; },
    function () { return [{ t: 'load', program: Array.from(compile(state)), when: 0 }]; });
  var core = H.core;
  function slotOf(type) { return state.chain[EFFECT_ORDER.indexOf(type)]; }
  /**
   * Set one dial (UI units) or 'bypass' (boolean). `at` = AudioContext time; omitted = now.
   * Returns the value actually stored (clamped / snapped), or undefined for an unknown effect or dial, or
   * for a time more than 600 s ahead (refused: see tooFar).
   */
  core.setParam = function (effect, key, value, at) {
    var type = effectType(effect);
    if (!type || H.disposed || H.tooFar(at)) return undefined;
    var slot = slotOf(type), v;
    if (key === 'bypass') v = !!value;
    else {
      var d = dialDef(type, key);
      if (!d) return undefined;
      v = clampDial(d, value, dialStep(d, slot.dials));
    }
    if (key === 'bypass') slot.bypass = v; else slot.dials[key] = v;
    H.post({ t: 'p', i: PARAM_INDEX[type][key], v: dialToDsp(type, key, v), when: H.whenOf(at) });
    H.emit({ effect: type, key: key, value: v });
    // A dial whose step depends on this one (drive_db: 0.1 dB in Acid, whole dB in Smooth) is re-rounded.
    effectDef(type).dials.forEach(function (dd) {
      if (!dd.stepWhen || !dd.stepWhen.some(function (w) { return w.key === key; })) return;
      var was = slot.dials[dd.key], now = clampDial(dd, was, dialStep(dd, slot.dials));
      if (now === was) return;
      slot.dials[dd.key] = now;
      H.post({ t: 'p', i: PARAM_INDEX[type][dd.key], v: dialToDsp(type, dd.key, now), when: H.whenOf(at) });
      H.emit({ effect: type, key: dd.key, value: now });
    });
    return v;
  };
  core.getParam = function (effect, key) {
    var type = effectType(effect);
    if (!type) return undefined;
    var slot = slotOf(type);
    return key === 'bypass' ? slot.bypass : slot.dials[key];
  };
  /** A JSON-safe copy: {v:1, chain:[{id, type, bypass, dials}]} in the fixed order. */
  core.getState = function () { return cloneState(state); };
  /** Load any saved state (nc-fx v1 or ASTRID's hacks array; see migrate()). */
  core.setState = function (s, setOpts) {
    if (H.disposed || H.tooFar(setOpts && setOpts.at)) return;
    state = sanitize(s);
    H.post({ t: 'load', program: Array.from(compile(state)), when: H.whenOf(setOpts && setOpts.at) });
    H.emit({ effect: null, key: null, value: null });
  };
  return core;
}

/**
 * ASTRID's chain model on the node: up to N effects (`slots`), any type, any order; state v2 (src/slots.js). Each
 * effect instance has an id ('delay-1') for the host and a uid (a number, never reused) for the worklet. Changes go
 * out the way ASTRID's HackOutput.sync sends them: an add (with its params snapped) for a new effect, an order when
 * the order changes (ASTRID's 4 ms chain fade), a param for each changed dial.
 */
function createSlotCore(ctx, o) {
  var N = o.slots === true ? DEFAULT_SLOTS : Math.max(1, Math.min(MAX_SLOTS, Math.floor(+o.slots) || DEFAULT_SLOTS));
  var state = sanitizeSlots(o.state, N);
  var nextUid = 1, uids = {}; // slot id -> uid
  function uidFor(slot) { if (!uids[slot.id]) uids[slot.id] = nextUid++; return uids[slot.id]; }
  function wire(chain) { return chain.map(function (s) { return { uid: uidFor(s), type: s.type, program: slotProgram(s) }; }); }
  var start = wire(state.chain), startOrder = state.chain.map(function (s) { return uids[s.id]; });
  var H = createHost(ctx, o, function () { return { slots: N, chain: start, order: startOrder }; },
    function () { return [{ t: 'sync', chain: wire(state.chain), order: state.chain.map(function (s) { return uids[s.id]; }), when: 0 }]; });
  var core = H.core;

  /** A slot by id, or the first of a type ('delay', 'reverb'). */
  function find(ref) {
    var i;
    for (i = 0; i < state.chain.length; i++) if (state.chain[i].id === ref) return state.chain[i];
    var t = catalogType(ref);
    if (t) for (i = 0; i < state.chain.length; i++) if (state.chain[i].type === t) return state.chain[i];
    return null;
  }
  function postSlot(s, when) {
    var uid = uidFor(s);
    H.post({ t: 'add', uid: uid, type: s.type, when: when });
    slotProgram(s).forEach(function (p) { H.post({ t: 'ps', uid: uid, k: p[0], v: p[1], when: when, snap: true }); });
  }
  function postOrder(when) { H.post({ t: 'order', uids: state.chain.map(function (s) { return uids[s.id]; }), when: when }); }
  /** Go to `next` (a clean v2 state) the way ASTRID's HackOutput.sync does: adds, then the order, then params. */
  function apply(next, when) {
    var old = {};
    state.chain.forEach(function (s) { old[s.id] = s; });
    var oldIds = state.chain.map(function (s) { return uids[s.id]; }).join();
    next.chain.forEach(function (s) {
      var was = old[s.id];
      if (!was || was.type !== s.type) { delete uids[s.id]; postSlot(s, when); return; } // a new effect: a fresh uid
      var p0 = {};
      slotProgram(was).forEach(function (p) { p0[p[0]] = p[1]; });
      slotProgram(s).forEach(function (p) { if (p0[p[0]] !== p[1]) H.post({ t: 'ps', uid: uids[s.id], k: p[0], v: p[1], when: when }); });
    });
    // Ids that left the chain don't come back with their old instance: forget their uids.
    var keep = {};
    next.chain.forEach(function (s) { keep[s.id] = true; });
    Object.keys(uids).forEach(function (id) { if (!keep[id]) delete uids[id]; });
    state = next;
    if (state.chain.map(function (s) { return uids[s.id]; }).join() !== oldIds) postOrder(when);
  }

  core.slots = N;
  /** Set one dial (UI units) or 'bypass' of the effect `ref` (an id, or a type for its first instance). */
  core.setParam = function (ref, key, value, at) {
    var slot = find(ref);
    if (!slot || H.disposed || H.tooFar(at)) return undefined;
    var e = catalogEntry(slot.type), v, d = null;
    if (key === 'bypass') v = !!value;
    else {
      for (var i = 0; i < e.dials.length; i++) if (e.dials[i].key === key) d = e.dials[i];
      if (!d) return undefined;
      v = clampDial(d, value, dialStep(d, slot.dials));
    }
    var p0 = {}, stepped = {};
    slotProgram(slot).forEach(function (p) { p0[p[0]] = p[1]; });
    e.dials.forEach(function (dd) { if (dd.stepWhen) stepped[dd.key] = slot.dials[dd.key]; });
    if (key === 'bypass') slot.bypass = v; else slot.dials[key] = v;
    // A dial whose step depends on this one (drive_db: 0.1 dB in Acid, whole dB in Smooth) is re-rounded too.
    e.dials.forEach(function (dd) { if (dd.stepWhen) slot.dials[dd.key] = clampDial(dd, slot.dials[dd.key], dialStep(dd, slot.dials)); });
    var when = H.whenOf(at), uid = uids[slot.id];
    slotProgram(slot).forEach(function (p) { if (p0[p[0]] !== p[1] || (d && p[0] === d.k)) H.post({ t: 'ps', uid: uid, k: p[0], v: p[1], when: when }); });
    H.emit({ effect: slot.id, key: key, value: v });
    Object.keys(stepped).forEach(function (k) { if (k !== key && slot.dials[k] !== stepped[k]) H.emit({ effect: slot.id, key: k, value: slot.dials[k] }); });
    return v;
  };
  core.getParam = function (ref, key) {
    var slot = find(ref);
    if (!slot) return undefined;
    return key === 'bypass' ? slot.bypass : slot.dials[key];
  };
  /** A JSON-safe copy: {v: 2, chain: [{id, type, bypass, dials}]}, first to last. */
  core.getState = function () { return JSON.parse(JSON.stringify(state)); };
  /** Load any saved chain (v2, v1, ASTRID's hacks, widgets or schema-2 document): click-free, as ASTRID's sync. */
  core.setState = function (s, setOpts) {
    if (H.disposed || H.tooFar(setOpts && setOpts.at)) return;
    apply(sanitizeSlots(s, N), H.whenOf(setOpts && setOpts.at));
    H.emit({ effect: null, key: null, value: null });
  };
  /** Add an effect (a catalog type) at `index` (default last). Returns its id, or undefined when the chain is full. */
  core.addEffect = function (type, addOpts) {
    var ao = addOpts || {};
    var s = newSlot(type, state.chain);
    if (!s || state.chain.length >= N || H.disposed || H.tooFar(ao.at)) return undefined;
    if (ao.dials) { var c = sanitizeSlots({ v: 2, chain: [{ id: s.id, type: s.type, dials: ao.dials }] }, 1).chain[0]; s.dials = c.dials; }
    if (ao.bypass === true) s.bypass = true;
    var next = state.chain.slice(), at = typeof ao.index === 'number' ? Math.max(0, Math.min(next.length, ao.index)) : next.length;
    next.splice(at, 0, s);
    apply({ v: 2, chain: next }, H.whenOf(ao.at));
    H.emit({ effect: s.id, key: 'chain', value: 'add' });
    return s.id;
  };
  /** Remove an effect (by id). True if it was there. */
  core.removeEffect = function (ref, rmOpts) {
    var slot = find(ref), at = rmOpts && rmOpts.at;
    if (!slot || H.disposed || H.tooFar(at)) return false;
    apply({ v: 2, chain: state.chain.filter(function (s) { return s !== slot; }) }, H.whenOf(at));
    H.emit({ effect: slot.id, key: 'chain', value: 'remove' });
    return true;
  };
  /** Move an effect to position `to` (0 = first; clamped). True if the order changed. */
  core.moveEffect = function (ref, to, mvOpts) {
    var slot = find(ref), at = mvOpts && mvOpts.at;
    if (!slot || H.disposed || H.tooFar(at)) return false;
    var next = moveSlot(state.chain, state.chain.indexOf(slot), to);
    if (next === state.chain) return false;
    apply({ v: 2, chain: next }, H.whenOf(at));
    H.emit({ effect: slot.id, key: 'chain', value: 'move' });
    return true;
  };
  /** The chain as [{id, type, name, bypass}], first to last. */
  core.getChain = function () { return state.chain.map(function (s) { return { id: s.id, type: s.type, name: slotName(s), bypass: s.bypass }; }); };
  /** ASTRID's saved-hacks shape for this chain (settings.hacks), and what ASTRID can't hold. */
  core.toAstrid = function () { return toAstridHacks(state); };
  return core;
}

/**
 * createFxCore plus a panel: `await fx.mount(el)` imports ./ui.js on first use and renders into el.
 * @param {BaseAudioContext} ctx
 * @param {import('./index').FxCoreOptions} [opts]
 * @returns {import('./index').Fx}
 */
export function createFx(ctx, opts) {
  var fx = createFxCore(ctx, opts);
  var panels = [], disposed = false;
  var dispose = fx.dispose;
  // If dispose() ran while ./ui.js loaded, the panel is destroyed before it resolves (same frame: never
  // painted, nothing left listening), so a late mount can't leak.
  fx.mount = function (el, uiOpts) {
    return import('./ui.js').then(function (m) {
      var p = m.mountFxPanel(el, Object.assign({}, uiOpts, { fx: fx }));
      if (disposed) p.destroy(); else panels.push(p);
      return p;
    });
  };
  fx.dispose = function () { disposed = true; panels.splice(0).forEach(function (p) { p.destroy(); }); dispose(); };
  return fx;
}
void STATE_VERSION; void formatDial; void CATALOG;
