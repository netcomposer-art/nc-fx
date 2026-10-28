// @netcomposer/nc-fx: createFxCore (audio only) and createFx (core + lazy panel).
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// No framework, no imports outside this package. The worklet code is only fetched when an instance is
// created: from opts.moduleUrl if the app gives one (recommended for Vite: `?url`, see README), or else
// from a lazily imported string turned into a Blob URL. The panel (./ui.js) is only imported by mount().

import {
  EFFECTS, EFFECT_ORDER, STATE_VERSION, effectType, dialDef, clampDial, dialToDsp, PARAM_INDEX,
  sanitize, migrate, compile, cloneState, defaultState, delaySeconds
} from './params.js';

export { EFFECTS, EFFECT_ORDER, STATE_VERSION, sanitize, migrate, defaultState, delaySeconds };
export var PROCESSOR_NAME = 'nc-fx@1';

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
 * The chain as Web Audio nodes: input -> drive -> delay -> reverb -> pre-gain -> limiter -> output.
 * Usable at once (it is a plain wire until the worklet is up, then crossfades in on the audio clock).
 * @param {BaseAudioContext} ctx
 * @param {import('./index').FxCoreOptions} [opts]
 * @returns {import('./index').FxCore}
 */
export function createFxCore(ctx, opts) {
  var o = opts || {};
  var state = sanitize(o.state);
  var bpm = Math.min(400, Math.max(20, finiteOr(o.bpm, 120)));
  var limiter = o.limiter === 'soft' || o.limiter === 'lookahead' ? o.limiter : 'off'; // opt-in
  var bypassMode = o.bypassMode === 'run' ? 'run' : 'hold';
  var preGain = finiteOr(o.preGain, 1); // opt-in (ASTRID: 0.8)
  var fade = Math.max(0, finiteOr(o.crossfade, 0.012));
  var input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  wet.gain.value = 0;
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  var node = null, status = 'loading', error = null, disposed = false;
  var listeners = [];

  function post(msg) { if (node) node.port.postMessage(msg); }
  function emit(change) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](change); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
    }
  }
  function whenOf(at) { return typeof at === 'number' && isFinite(at) && at > 0 ? at : 0; }

  var ready = loadFxWorklet(ctx, o.moduleUrl).then(function () {
    if (disposed) return;
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { program: Array.from(compile(state)), bpm: bpm, bypassMode: bypassMode, limiter: limiter, preGain: preGain }
    });
    input.connect(node);
    node.connect(wet);
    // Wire -> chain, on the audio clock. Before the context has run, just switch.
    var t = ctx.currentTime;
    if (t <= 0 || fade === 0) { dry.gain.value = 0; wet.gain.value = 1; }
    else {
      dry.gain.setValueAtTime(1, t); dry.gain.linearRampToValueAtTime(0, t + fade);
      wet.gain.setValueAtTime(0, t); wet.gain.linearRampToValueAtTime(1, t + fade);
    }
    status = 'ready';
  }, function (e) {
    status = 'unavailable'; // stays a wire: the sound goes on, dry
    error = e;
  });

  function slotOf(type) { return state.chain[EFFECT_ORDER.indexOf(type)]; }

  var core = {
    input: input,
    output: output,
    /** Resolves when the chain is in the signal path (or when it gave up: see status). Never rejects. */
    ready: ready,
    get status() { return status; },
    get error() { return error; },
    /** Samples the chain delays the signal by (the lookahead limiter's 1.5 ms; 0 for 'soft'/'off'). */
    latencySamples: limiter === 'lookahead' ? Math.max(1, Math.round(0.0015 * ctx.sampleRate)) : 0,
    /**
     * Set one dial (UI units) or 'bypass' (boolean). `at` = AudioContext time; omitted = now.
     * Returns the value actually stored (clamped / snapped), or undefined for an unknown effect or dial.
     */
    setParam: function (effect, key, value, at) {
      var type = effectType(effect);
      if (!type || disposed) return undefined;
      var slot = slotOf(type), v;
      if (key === 'bypass') v = !!value;
      else {
        var d = dialDef(type, key);
        if (!d) return undefined;
        v = clampDial(d, value);
      }
      if (key === 'bypass') slot.bypass = v; else slot.dials[key] = v;
      post({ t: 'p', i: PARAM_INDEX[type][key], v: dialToDsp(type, key, v), when: whenOf(at) });
      emit({ effect: type, key: key, value: v });
      return v;
    },
    getParam: function (effect, key) {
      var type = effectType(effect);
      if (!type) return undefined;
      var slot = slotOf(type);
      return key === 'bypass' ? slot.bypass : slot.dials[key];
    },
    /** A JSON-safe copy: {v:1, chain:[{id, type, bypass, dials}]} in the fixed order. */
    getState: function () { return cloneState(state); },
    /** Load any saved state (nc-fx v1 or ASTRID's hacks array; see migrate()). */
    setState: function (s, setOpts) {
      if (disposed) return;
      state = sanitize(s);
      post({ t: 'load', program: Array.from(compile(state)), when: whenOf(setOpts && setOpts.at) });
      emit({ effect: null, key: null, value: null });
    },
    /** Host tempo (BPM) for the synced delay, optionally at an AudioContext time. */
    setTempo: function (nextBpm, at) {
      var b = finiteOr(nextBpm, NaN);
      if (!(b > 0) || disposed) return;
      bpm = Math.min(400, Math.max(20, b));
      post({ t: 'tempo', bpm: bpm, when: whenOf(at) });
      emit({ effect: null, key: 'tempo', value: bpm });
    },
    getTempo: function () { return bpm; },
    /** Panic: drop every tail now (or at an AudioContext time). */
    clear: function (at) { post({ t: 'clear', when: whenOf(at) }); },
    /** Called after every change with {effect, key, value} (effect null for whole-state or tempo changes). */
    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      status = 'disposed';
      listeners.length = 0;
      if (node) { node.port.postMessage({ t: 'dispose' }); node.port.close(); try { node.disconnect(); } catch (e) { /* */ } }
      [input, dry, wet, output].forEach(function (n) { try { n.disconnect(); } catch (e) { /* */ } });
    }
  };
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
  var panels = [];
  var dispose = fx.dispose;
  fx.mount = function (el, uiOpts) {
    return import('./ui.js').then(function (m) {
      var p = m.mountFxPanel(el, Object.assign({}, uiOpts, { fx: fx }));
      panels.push(p);
      return p;
    });
  };
  fx.dispose = function () { panels.splice(0).forEach(function (p) { p.destroy(); }); dispose(); };
  return fx;
}
