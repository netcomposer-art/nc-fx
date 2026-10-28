// nc-fx parameters: the dials, their laws (dial -> DSP units) and the JSON state.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// Dials, ranges, defaults, formats and laws are ASTRID's (NetComposer-Synth 024f200,
// lib/synth-audio/src/hacks.ts: HACK_DEFINITIONS, dialValue, sanitizeHacks, hackParams), which copied
// them from the site's create/hacks/stack.js. One rename: the delay's `wet` dial is `mix` here, like the
// other two effects; ASTRID's saved chains are migrated (see migrate()).


export var STATE_VERSION = 1;
export var MAX_DELAY_S = 4.9;
/** Fixed order. 'plate' is the effect the UI calls Reverb; 'reverb' is accepted as an alias. */
export var EFFECT_ORDER = ['drive', 'delay', 'plate'];

var NOTES = [[0.25, '1/16'], [0.5, '1/8'], [0.75, '1/8 dotted'], [1, '1/4'], [1.5, '1/4 dotted'], [2, '1/2']];
var fmtDb = function (v) { return (v > 0 ? '+' : v < 0 ? '\u2212' : '') + Math.abs(v) + ' dB'; };
var pct = function (v) { return v + '%'; };
var wet = function (v) { return v + '% wet'; };
function dial(key, label, min, max, value, format) { return { key: key, label: label, min: min, max: max, step: 1, default: value, format: format }; }

/** The delay time in seconds for a note length at a tempo (ASTRID's delayS). */
export function delaySeconds(beats, bpm) { return Math.min(MAX_DELAY_S, beats * 60 / (bpm > 0 ? bpm : 120)); }

/**
 * Effect definitions. `format(value, bpm)` gives the readout. Everything but `format` is plain data.
 * @type {ReadonlyArray<import('./index').FxEffectDef>}
 */
export var EFFECTS = [
  { type: 'drive', label: 'Drive', dials: [
    dial('drive_db', 'Drive', 0, 24, 0, function (v) { return v === 0 ? 'clean' : fmtDb(v); }),
    dial('output_db', 'Output', -12, 12, 0, fmtDb),
    dial('mix', 'Mix', 0, 100, 100, wet)] },
  { type: 'delay', label: 'Delay', tempoSynced: true, dials: [
    { key: 'delay_beats', label: 'Timing', min: 0.25, max: 2, step: null, default: 0.75,
      options: NOTES.map(function (n) { return { value: n[0], label: n[1] }; }),
      format: function (v, bpm) { return Math.round(delaySeconds(v, bpm) * 1000) + ' ms'; } },
    dial('feedback', 'Feedback', 0, 90, 35, pct),
    dial('mix', 'Wet/dry', 0, 100, 0, wet)] },
  { type: 'plate', label: 'Reverb', dials: [
    dial('predelay', 'Pre-delay', 0, 200, 0, function (v) { return v + ' ms'; }),
    dial('size', 'Size', 0, 100, 50, function (v) { return (0.5 + v / 100).toFixed(2) + '\u00d7'; }),
    dial('decay', 'Decay', 0, 100, 50, pct),
    dial('damping', 'Damping', 0, 100, 0, pct),
    dial('mix', 'Mix', 0, 100, 0, wet)] }
];

var ALIAS = { reverb: 'plate' };
/** 'reverb' -> 'plate'; anything unknown -> null. */
export function effectType(t) {
  var x = ALIAS[t] || t;
  return EFFECT_ORDER.indexOf(x) >= 0 ? x : null;
}
export function effectDef(type) {
  var t = effectType(type);
  for (var i = 0; i < EFFECTS.length; i++) if (EFFECTS[i].type === t) return EFFECTS[i];
  return null;
}
export function dialDef(type, key) {
  var e = effectDef(type);
  if (!e) return null;
  for (var i = 0; i < e.dials.length; i++) if (e.dials[i].key === key) return e.dials[i];
  return null;
}

/** ASTRID's dialValue: non-numbers fall back to the default; options snap to the nearest; others round and clamp. */
export function clampDial(d, raw) {
  if (typeof raw !== 'number' || !isFinite(raw)) return d.default;
  if (d.options) {
    var best = d.options[0].value;
    for (var i = 1; i < d.options.length; i++) if (Math.abs(d.options[i].value - raw) < Math.abs(best - raw)) best = d.options[i].value;
    return best;
  }
  return Math.max(d.min, Math.min(d.max, Math.round(raw))) + 0; // + 0: no -0 in saved state
}

/** The starting state: every effect present, bypassed, at ASTRID's starting dials. */
export function defaultState() {
  return { v: STATE_VERSION, chain: EFFECTS.map(function (e) {
    var dials = {};
    e.dials.forEach(function (d) { dials[d.key] = d.default; });
    return { id: e.type, type: e.type, bypass: true, dials: dials };
  }) };
}

function isRecord(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Any saved state to a clean v1 state. Accepts:
 *  - nc-fx v1 `{v:1, chain:[...]}` in any order, with missing effects filled in (bypassed);
 *  - ASTRID's saved hacks (a bare HackSlot[] array): its drive/delay/plate slots are taken, the rest
 *    (filters, EQ, modulation...) are not in this package yet and are dropped (see `dropped`).
 *    An effect absent from an ASTRID chain was not playing, so it comes in bypassed.
 * Never throws. Unknown keys and bad values fall back to defaults.
 * @returns {{state: object, dropped: string[]}}
 */
export function migrate(raw) {
  var list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.chain) ? raw.chain : [];
  var legacy = Array.isArray(raw);
  var out = defaultState();
  var seen = {};
  var dropped = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!isRecord(item)) continue;
    var type = effectType(item.type);
    if (!type) { if (typeof item.type === 'string') dropped.push(item.type); continue; }
    if (seen[type]) { dropped.push(type); continue; } // one of each; the first wins, as ASTRID plays them in order
    seen[type] = true;
    var slot = out.chain[EFFECT_ORDER.indexOf(type)];
    var dials = isRecord(item.dials) ? item.dials : {};
    if (type === 'delay' && dials.mix === undefined && dials.wet !== undefined) dials = Object.assign({}, dials, { mix: dials.wet });
    slot.bypass = legacy ? item.bypass === true : item.bypass !== false;
    effectDef(type).dials.forEach(function (d) { slot.dials[d.key] = clampDial(d, dials[d.key]); });
  }
  return { state: out, dropped: dropped };
}
/** migrate() without the report. */
export function sanitize(raw) { return migrate(raw).state; }

/** A deep copy, so callers can't reach into an instance's state. */
export function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

/** Engine parameter count (dsp.js FX_NPARAMS; repeated so the main thread never loads the engine). */
export var NPARAMS = 14;
/** Which engine index each dial drives (dsp.js FX_PARAM; a test keeps the two in step). */
export var PARAM_INDEX = {
  drive: { bypass: 0, drive_db: 1, output_db: 2, mix: 3 },
  delay: { bypass: 4, delay_beats: 5, feedback: 6, mix: 7 },
  plate: { bypass: 8, predelay: 9, size: 10, decay: 11, damping: 12, mix: 13 }
};

/** One dial (UI units, already clamped) to its engine value (hacks.ts hackParams). bypass -> the on flag. */
export function dialToDsp(type, key, v) {
  if (key === 'bypass') return v ? 0 : 1;
  switch (type) {
    case 'drive': return key === 'mix' ? v / 100 : v;
    case 'delay': return key === 'delay_beats' ? v : v / 100;
    case 'plate': return key === 'predelay' ? v / 1000 : v / 100;
  }
  return 0;
}

/** A clean state to the engine's program: FX_NPARAMS values in FX_PARAM order. */
export function compile(state, into) {
  var p = into || new Float64Array(NPARAMS);
  var s = sanitize(state);
  s.chain.forEach(function (slot) {
    var idx = PARAM_INDEX[slot.type];
    p[idx.bypass] = slot.bypass ? 0 : 1;
    Object.keys(slot.dials).forEach(function (k) { p[idx[k]] = dialToDsp(slot.type, k, slot.dials[k]); });
  });
  return p;
}
