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

var NOTES = [[0.125, '1/32'], [0.25, '1/16'], [0.5, '1/8'], [0.75, '1/8 dotted'], [1, '1/4'], [1.5, '1/4 dotted'], [2, '1/2']];
var fmtDb = function (v) { return (v > 0 ? '+' : v < 0 ? '\u2212' : '') + Math.abs(v) + ' dB'; };
var pct = function (v) { return v + '%'; };
var wet = function (v) { return v + '% wet'; };
var signedPct = function (v) { return (v > 0 ? '+' : v < 0 ? '\u2212' : '') + Math.abs(v) + '%'; };
function dial(key, label, min, max, value, format) { return { key: key, label: label, min: min, max: max, step: 1, default: value, format: format }; }

/** The delay time in seconds for a note length at a tempo (ASTRID's delayS). */
export function delaySeconds(beats, bpm) { return Math.min(MAX_DELAY_S, beats * 60 / (bpm > 0 ? bpm : 120)); }

/**
 * Effect definitions. `format(value, bpm)` gives the readout. Everything but `format` is plain data.
 * @type {ReadonlyArray<import('./index').FxEffectDef>}
 */
export var EFFECTS = [
  { type: 'drive', label: 'Drive', dials: [
    // drive_db: whole dB in Smooth (ASTRID); 0.1 dB in Acid, so Bass's amounts round-trip (stepWhen).
    Object.assign(dial('drive_db', 'Drive', 0, 24, 0, function (v) { return v === 0 ? 'clean' : fmtDb(v); }),
      { stepWhen: [{ key: 'curve', value: 1, step: 0.1 }] }),
    dial('output_db', 'Output', -12, 12, 0, fmtDb),
    dial('mix', 'Mix', 0, 100, 100, wet),
    // Added after 0.1.0's first cut (indexes 14-17); the defaults are ASTRID's sound, so old states are unchanged.
    { key: 'curve', label: 'Curve', min: 0, max: 1, step: null, default: 0,
      options: [{ value: 0, label: 'Smooth' }, { value: 1, label: 'Acid' }],
      format: function (v) { return v === 1 ? 'Acid' : 'Smooth'; } },
    dial('tone', 'Tone', 0, 100, 100, function (v) { return v >= 100 ? 'off' : Math.round(500 * Math.pow(2, 5 * v / 99)) + ' Hz'; }),
    dial('mod_drive', 'Accent \u2192 drive', -100, 100, 0, signedPct),
    dial('mod_tone', 'Accent \u2192 tone', -100, 100, 0, signedPct)] },
  { type: 'delay', label: 'Delay', tempoSynced: true, dials: [
    // overriddenBy: the UI shows the select as overridden while Free time is on.
    { key: 'delay_beats', label: 'Timing', min: 0.125, max: 2, step: null, default: 0.75, overriddenBy: 'beats_free',
      options: NOTES.map(function (n) { return { value: n[0], label: n[1] }; }),
      format: function (v, bpm) { return Math.round(delaySeconds(v, bpm) * 1000) + ' ms'; } },
    dial('feedback', 'Feedback', 0, 90, 35, pct),
    dial('mix', 'Wet/dry', 0, 100, 0, wet),
    // Added for Bass (indexes 18-23); the defaults are ASTRID's sound, so old states are unchanged.
    // tone: 0-99 -> a one-pole low-pass at 800 Hz * 2^(4t), t = v / 99 (Bass's law); 100 = off.
    dial('tone', 'Tone', 0, 100, 100, function (v) { return v >= 100 ? 'off' : Math.round(800 * Math.pow(2, 4 * v / 99)) + ' Hz'; }),
    Object.assign(dial('low_cut', 'Low cut', 0, 1000, 0, function (v) { return v === 0 ? 'off' : v + ' Hz'; }), { curve: 'log' }),
    { key: 'mode', label: 'Mode', min: 0, max: 1, step: null, default: 0,
      options: [{ value: 0, label: 'Insert' }, { value: 1, label: 'Send' }],
      format: function (v) { return v === 1 ? 'Send' : 'Insert'; } },
    dial('send', 'Send', 0, 100, 100, pct),
    dial('mod_send', 'Accent \u2192 send', -100, 100, 0, signedPct),
    // beats_free: 0 = off (the Timing select plays); otherwise any 0.125-2 beats, kept exactly (Bass's division).
    Object.assign(dial('beats_free', 'Free time', 0, 2, 0, function (v, bpm) {
      return v === 0 ? 'off' : 'free ' + +v.toFixed(3) + ' beats \u00b7 ' + Math.round(delaySeconds(v, bpm) * 1000) + ' ms';
    }), { step: 0.001, exact: true, minOn: 0.125 })] },
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

/** The dial's step for a slot's other dials: `stepWhen` (drive_db's 0.1 in Acid) or `step`. */
export function dialStep(d, dials) {
  if (d.stepWhen && dials) for (var i = 0; i < d.stepWhen.length; i++) if (dials[d.stepWhen[i].key] === d.stepWhen[i].value) return d.stepWhen[i].step;
  return d.step;
}
/**
 * ASTRID's dialValue: non-numbers fall back to the default; options snap to the nearest; others round (to
 * `step`, default whole numbers) and clamp.
 */
export function clampDial(d, raw, step) {
  if (typeof raw !== 'number' || !isFinite(raw)) return d.default;
  if (d.options) {
    // Nearest option; a tie (exactly halfway) goes to the earlier option in the list, i.e. the shorter note
    // (strict <, ASTRID's rule): 0.1875 -> 1/32, 0.375 -> 1/16, 0.625 -> 1/8, 0.875 -> 1/8 dotted, 1.25 -> 1/4, 1.75 -> 1/4 dotted.
    var best = d.options[0].value;
    for (var i = 1; i < d.options.length; i++) if (Math.abs(d.options[i].value - raw) < Math.abs(best - raw)) best = d.options[i].value;
    return best;
  }
  if (d.exact) { // beats_free: kept as given (Bass's exact division); 0 = off, else minOn..max
    if (!(raw > 0)) return 0;
    return raw < d.minOn ? d.minOn : raw > d.max ? d.max : raw;
  }
  var inv = step > 0 && step < 1 ? Math.round(1 / step) : 1; // 0.1 -> x10: Math.round(raw * 10) / 10 lands on 10.2, not 10.200000000000001
  return Math.max(d.min, Math.min(d.max, Math.round(raw * inv) / inv)) + 0; // + 0: no -0 in saved state
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
    restep(type, slot.dials, dials);
  }
  return { state: out, dropped: dropped };
}
/** Re-clamps the dials whose step depends on another dial (drive_db in Acid), from their raw values. */
export function restep(type, dials, raw) {
  var e = effectDef(type);
  for (var i = 0; i < e.dials.length; i++) {
    var d = e.dials[i];
    if (d.stepWhen) dials[d.key] = clampDial(d, raw && typeof raw[d.key] === 'number' ? raw[d.key] : dials[d.key], dialStep(d, dials));
  }
}
/** migrate() without the report. */
export function sanitize(raw) { return migrate(raw).state; }

/** A deep copy, so callers can't reach into an instance's state. */
export function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

/** Engine parameter count (dsp.js FX_NPARAMS; repeated so the main thread never loads the engine). */
export var NPARAMS = 24;
/** Which engine index each dial drives (dsp.js FX_PARAM; a test keeps the two in step). */
export var PARAM_INDEX = {
  drive: { bypass: 0, drive_db: 1, output_db: 2, mix: 3, curve: 14, tone: 15, mod_drive: 16, mod_tone: 17 },
  delay: { bypass: 4, delay_beats: 5, feedback: 6, mix: 7, tone: 18, low_cut: 19, mode: 20, send: 21, mod_send: 22, beats_free: 23 },
  plate: { bypass: 8, predelay: 9, size: 10, decay: 11, damping: 12, mix: 13 }
};

/** One dial (UI units, already clamped) to its engine value (hacks.ts hackParams). bypass -> the on flag. */
export function dialToDsp(type, key, v) {
  if (key === 'bypass') return v ? 0 : 1;
  switch (type) {
    // tone: 0-99 -> t = v / 99 (Bass's 0-1 law, 500 Hz * 2^(5t)); 100 -> 100/99 > 1, which the engine reads as off.
    case 'drive': return key === 'mix' || key === 'mod_drive' || key === 'mod_tone' ? v / 100 : key === 'tone' ? v / 99 : v;
    // delay: tone 0-99 -> v / 99 (100 -> 100/99 > 1 = off); low_cut in Hz; mode 0/1; beats_free in beats (0 = off).
    case 'delay': return key === 'delay_beats' || key === 'low_cut' || key === 'mode' || key === 'beats_free' ? v : key === 'tone' ? v / 99 : v / 100;
    case 'plate': return key === 'predelay' ? v / 1000 : v / 100;
  }
  return 0;
}

var UNITS = { drive_db: 'dB', output_db: 'dB', delay_beats: 'beats', predelay: 'ms', curve: null, low_cut: 'Hz', mode: null, beats_free: 'beats' }; // others: '%'
/**
 * Every control as plain JSON (no functions), for hosts that build their own UI or automation:
 * {effect, key, label, index, unit, min, max, step, default, curve, control, tempoSynced[, options]}.
 * index = engine parameter (FX_PARAM; for a bypass toggle that is the effect's on flag, engine value = !bypass).
 * Readouts are separate: FORMATS['delay.feedback'](value, bpm).
 */
export function describeParams() {
  var out = [];
  EFFECTS.forEach(function (e) {
    var synced = !!e.tempoSynced;
    out.push({ effect: e.type, key: 'bypass', label: 'Bypass', index: PARAM_INDEX[e.type].bypass, unit: null, min: 0, max: 1, step: 1,
      default: true, curve: 'linear', control: 'toggle', tempoSynced: false });
    e.dials.forEach(function (d) {
      var r = { effect: e.type, key: d.key, label: d.label, index: PARAM_INDEX[e.type][d.key], unit: d.key in UNITS ? UNITS[d.key] : '%',
        min: d.min, max: d.max, step: d.step, default: d.default, curve: d.options ? 'stepped' : d.curve || 'linear',
        control: d.options ? 'select' : 'knob', tempoSynced: synced && (d.key === 'delay_beats' || d.key === 'beats_free') };
      if (d.options) r.options = d.options.map(function (x) { return { value: x.value, label: x.label }; });
      if (d.overriddenBy) r.overriddenBy = d.overriddenBy;
      if (d.exact) { r.offValue = 0; r.minOn = d.minOn; }
      if (d.stepWhen) r.stepWhen = d.stepWhen.map(function (w) { return { key: w.key, value: w.value, step: w.step }; });
      out.push(r);
    });
  });
  return out;
}
/** Readout per control, by 'effect.key': FORMATS['plate.size'](50) === '1.00×'. bpm matters for tempo-synced ones. */
export var FORMATS = {};
EFFECTS.forEach(function (e) { e.dials.forEach(function (d) { FORMATS[e.type + '.' + d.key] = d.format; }); });

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
