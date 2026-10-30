// nc-fx catalog: every effect as plain data (JSON-safe), the one source the panel and any host UI (the Studio Mix's
// FX cards, ASTRID's Hacks panel) are generated from.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// Labels, ranges, defaults, options, dial laws and readouts are ASTRID's (psemmelhack/NetComposer-Synth 7292c57,
// lib/synth-audio/src/hacks.ts: HACK_DEFINITIONS, hackParams, the formatters), which copied them from the site's
// create/hacks/stack.js. test/catalog.test.mjs checks every dial and every readout against ASTRID's own hacks.ts.
// nc-fx's additions (drive Curve/Tone/accent depths, delay Tone/Low cut/Mode/Send/Free time, the 1/32 note) are
// marked `more: true` (shown under "More") and default to ASTRID's sound. One rename: the delay's `wet` dial is `mix`
// here (`astridKey: 'wet'`), like every other effect's.
//
// A dial: { key, label, min, max, default, step (null for option dials), k (its engine param: src/units.js),
//   unit, options?, more?, dsp?, format, ... }.
//   dsp    how the dial becomes the engine value: absent = as is; { div: n } = value / n; { law } = law(value).
//   law    { pow: [a, b], div } = a * b^(v / div), or { exp2: [a, m], div } = a * 2^(m * v / div); then
//          { round: true } = Math.round, or { fixed: n } = +x.toFixed(n); { zeroNull: true }: v <= 0 gives null.
//   format the readout (formatDial() renders it; hosts may too): { fmt, ... } with fmt one of
//          db (signed, U+2212 minus; zero: text at 0), pct, wet ('% wet'), signedPct, num (v + suffix),
//          fixed (((v / div) + add).toFixed(digits) + suffix), hz (law(v) in Hz; astrid: kHz above 1000 as hacks.ts
//          fmtHz; zero: text when the law gives null or v is 0; off: text at or above `offAt`), q ('Q ' + law
//          to 1 decimal), ratio (law to 1 decimal + ':1'), rate (hacks.ts fmtRate), balance, option (the option's
//          label), stages (v + ' stages'), tempoMs (the delay time in ms at the tempo), freeBeats (beats_free).

var NOTES = [[0.125, '1/32'], [0.25, '1/16'], [0.5, '1/8'], [0.75, '1/8 dotted'], [1, '1/4'], [1.5, '1/4 dotted'], [2, '1/2']];
/** ASTRID's delay notes (hacks.ts NOTES): nc-fx adds 1/32. */
export var ASTRID_NOTES = [0.25, 0.5, 0.75, 1, 1.5, 2];
export var MAX_DELAY_S = 4.9;

// The laws of hacks.ts, as data.
var L = {
  cutoff: { pow: [20000, 150 / 20000], div: 100, round: true, zeroNull: true }, // hackCutoffHz (lowpass)
  hpHz: { pow: [20, 100], div: 100, round: true, zeroNull: true },
  hpQ: { pow: [0.7071, 8 / 0.7071], div: 100, fixed: 3 },
  bpHz: { pow: [100, 80], div: 100, round: true },
  bpQ: { pow: [0.4, 20], div: 100, fixed: 2 },
  midHz: { pow: [200, 25], div: 100, round: true },
  eqQ: { pow: [0.3, 20], div: 100, fixed: 2 },
  ratio: { pow: [1, 20], div: 100, fixed: 2 }, // ratioOf
  rate: { pow: [0.05, 200], div: 100, fixed: 3 }, // hackRateHz
  driveTone: { exp2: [500, 5], div: 99, round: true }, // Bass's drive tone (500 Hz * 2^(5t), t = v / 99)
  delayTone: { exp2: [800, 4], div: 99, round: true }  // Bass's delay tone (800 Hz * 2^(4t))
};
var WET = { fmt: 'wet' }, PCT = { fmt: 'pct' }, DB = { fmt: 'db' }, SPCT = { fmt: 'signedPct' }, MS = { fmt: 'num', suffix: ' ms' };
var C100 = { div: 100 };
function d(key, label, min, max, value, k, format, extra) {
  var o = { key: key, label: label, min: min, max: max, default: value, step: 1, k: k, unit: null, format: format };
  if (extra) for (var x in extra) o[x] = extra[x];
  return o;
}
function opts(list) { return list.map(function (p) { return { value: p[0], label: p[1] }; }); }

/** Every effect, in ASTRID's HACK_DEFINITIONS order. `hidden`: loads, plays and shows, but isn't offered in "Add".
 * `fixed`: also one of createFxDsp's fixed chain (drive -> delay -> plate). */
export var CATALOG = [
  { type: 'lowpass', label: 'Low-pass filter', hidden: true, dials: [
    d('cutoff', 'Cutoff', 0, 100, 0, 1, { fmt: 'hz', law: L.cutoff, astrid: true, zero: 'open' })] },
  { type: 'highpass', label: 'High-pass filter', hidden: true, dials: [
    d('cutoff', 'Cutoff', 0, 100, 0, 1, { fmt: 'hz', law: L.hpHz, astrid: true, zero: 'off' }),
    d('q', 'Resonance', 0, 100, 0, 2, { fmt: 'q', law: L.hpQ }, { dsp: { law: L.hpQ } })] },
  { type: 'bandpass', label: 'Band-pass filter', hidden: true, dials: [
    d('centre_hz', 'Centre', 0, 100, 53, 1, { fmt: 'hz', law: L.bpHz, astrid: true }, { dsp: { law: L.bpHz } }),
    d('q', 'Q', 0, 100, 0, 2, { fmt: 'q', law: L.bpQ }, { dsp: { law: L.bpQ } }),
    d('mix', 'Mix', 0, 100, 100, 3, WET, { dsp: C100, unit: '%' })] },
  { type: 'delay', label: 'Delay', fixed: true, tempoSynced: true, dials: [
    d('delay_beats', 'Timing', 0.125, 2, 0.75, 1, { fmt: 'tempoMs' }, { step: null, unit: 'beats', options: opts(NOTES), overriddenBy: 'beats_free', tempoSynced: true }),
    d('feedback', 'Feedback', 0, 90, 35, 2, PCT, { dsp: C100, unit: '%' }),
    d('mix', 'Wet/dry', 0, 100, 0, 3, WET, { dsp: C100, unit: '%', astridKey: 'wet' }),
    // Added for Bass; the defaults are ASTRID's sound. tone: a one-pole low-pass at 800 Hz * 2^(4t), t = v / 99; 100 = off.
    d('tone', 'Tone', 0, 100, 100, 4, { fmt: 'hz', law: L.delayTone, offAt: 100 }, { dsp: { div: 99 }, more: true }),
    d('low_cut', 'Low cut', 0, 1000, 0, 5, { fmt: 'hz', zero: 'off' }, { unit: 'Hz', curve: 'log', more: true }),
    d('mode', 'Mode', 0, 1, 0, 6, { fmt: 'option' }, { step: null, options: opts([[0, 'Insert'], [1, 'Send']]), more: true }),
    d('send', 'Send', 0, 100, 100, 7, PCT, { dsp: C100, unit: '%', more: true }),
    d('mod_send', 'Accent → send', -100, 100, 0, 8, SPCT, { dsp: C100, unit: '%', more: true }),
    // beats_free: 0 = off (the Timing select plays); otherwise any 0.125-2 beats, kept exactly (Bass's division).
    d('beats_free', 'Free time', 0, 2, 0, 9, { fmt: 'freeBeats' }, { step: 0.001, exact: true, minOn: 0.125, unit: 'beats', tempoSynced: true, more: true })] },
  { type: 'plate', label: 'Reverb', fixed: true, dials: [
    d('predelay', 'Pre-delay', 0, 200, 0, 1, MS, { dsp: { div: 1000 }, unit: 'ms' }),
    d('size', 'Size', 0, 100, 50, 2, { fmt: 'fixed', div: 100, add: 0.5, digits: 2, suffix: '×' }, { dsp: C100, unit: '%' }),
    d('decay', 'Decay', 0, 100, 50, 3, PCT, { dsp: C100, unit: '%' }),
    d('damping', 'Damping', 0, 100, 0, 4, PCT, { dsp: C100, unit: '%' }),
    d('mix', 'Mix', 0, 100, 0, 5, WET, { dsp: C100, unit: '%' })] },
  // ASTRID's own (hacks-astrid/mod.js).
  { type: 'flanger', label: 'Flanger', dials: [
    d('rate', 'Rate', 0, 100, 26, 1, { fmt: 'rate', law: L.rate }, { dsp: { law: L.rate } }),
    d('depth', 'Depth', 0, 100, 70, 2, PCT, { dsp: C100, unit: '%' }),
    d('feedback', 'Feedback', -90, 90, 50, 3, SPCT, { dsp: C100, unit: '%' }),
    d('mix', 'Mix', 0, 100, 50, 4, WET, { dsp: C100, unit: '%' })] },
  { type: 'chorus', label: 'Chorus', dials: [
    d('rate', 'Rate', 0, 100, 52, 1, { fmt: 'rate', law: L.rate }, { dsp: { law: L.rate } }),
    d('depth', 'Depth', 0, 100, 50, 2, PCT, { dsp: C100, unit: '%' }),
    d('spread', 'Spread', 0, 100, 70, 3, PCT, { dsp: C100, unit: '%' }),
    d('mix', 'Mix', 0, 100, 40, 4, WET, { dsp: C100, unit: '%' })] },
  { type: 'phaser', label: 'Phaser', dials: [
    d('rate', 'Rate', 0, 100, 39, 1, { fmt: 'rate', law: L.rate }, { dsp: { law: L.rate } }),
    d('depth', 'Depth', 0, 100, 70, 2, PCT, { dsp: C100, unit: '%' }),
    d('stages', 'Stages', 4, 8, 6, 3, { fmt: 'stages' }, { step: null, options: opts([[4, '4'], [6, '6'], [8, '8']]) }),
    d('feedback', 'Feedback', 0, 90, 30, 4, PCT, { dsp: C100, unit: '%' }),
    d('mix', 'Mix', 0, 100, 50, 5, WET, { dsp: C100, unit: '%' })] },
  { type: 'eq', label: 'EQ', note: 'Low shelf 150 Hz, high shelf 6 kHz.', dials: [
    d('low_db', 'Low', -18, 18, 0, 1, DB, { unit: 'dB' }),
    d('mid_db', 'Mid', -18, 18, 0, 2, DB, { unit: 'dB' }),
    d('mid_hz', 'Mid at', 0, 100, 50, 3, { fmt: 'hz', law: L.midHz, astrid: true }, { dsp: { law: L.midHz } }),
    d('mid_q', 'Mid Q', 0, 100, 40, 5, { fmt: 'q', law: L.eqQ }, { dsp: { law: L.eqQ } }),
    d('high_db', 'High', -18, 18, 0, 4, DB, { unit: 'dB' })] },
  { type: 'drive', label: 'Drive', fixed: true, dials: [
    // drive_db: whole dB in Smooth (ASTRID); 0.1 dB in Acid, so Bass's amounts round-trip (stepWhen).
    d('drive_db', 'Drive', 0, 24, 0, 1, { fmt: 'db', zero: 'clean' }, { unit: 'dB', stepWhen: [{ key: 'curve', value: 1, step: 0.1 }] }),
    d('output_db', 'Output', -12, 12, 0, 2, DB, { unit: 'dB' }),
    d('mix', 'Mix', 0, 100, 100, 3, WET, { dsp: C100, unit: '%' }),
    // Added for Bass; the defaults are ASTRID's sound, so old states are unchanged.
    d('curve', 'Curve', 0, 1, 0, 4, { fmt: 'option' }, { step: null, options: opts([[0, 'Smooth'], [1, 'Acid']]), more: true }),
    d('tone', 'Tone', 0, 100, 100, 5, { fmt: 'hz', law: L.driveTone, offAt: 100 }, { dsp: { div: 99 }, more: true }),
    d('mod_drive', 'Accent → drive', -100, 100, 0, 6, SPCT, { dsp: C100, unit: '%', more: true }),
    d('mod_tone', 'Accent → tone', -100, 100, 0, 7, SPCT, { dsp: C100, unit: '%', more: true })] },
  { type: 'compressor', label: 'Compressor', dials: [
    d('threshold_db', 'Threshold', -60, 0, 0, 1, DB, { unit: 'dB' }),
    d('ratio', 'Ratio', 0, 100, 0, 2, { fmt: 'ratio', law: L.ratio }, { dsp: { law: L.ratio } }),
    d('attack_ms', 'Attack', 1, 100, 10, 3, MS, { unit: 'ms' }),
    d('release_ms', 'Release', 10, 1000, 150, 4, MS, { unit: 'ms' }),
    d('makeup_db', 'Makeup', 0, 24, 0, 5, DB, { unit: 'dB' })] },
  { type: 'width', label: 'Width', note: 'A mono sound has no sides, so width leaves it as it is.', dials: [
    d('width', 'Width', 0, 200, 100, 1, PCT, { dsp: C100, unit: '%' }),
    d('balance', 'Balance', -100, 100, 0, 2, { fmt: 'balance' }, { dsp: C100 })] }
];
/** Every type that loads (older files included), in catalog order. */
export var CATALOG_TYPES = CATALOG.map(function (e) { return e.type; });
/** What "Add" offers: everything not hidden, in ASTRID's order (Delay, Reverb, Flanger, Chorus, Phaser, EQ, Drive,
 * Compressor, Width). */
export var CATALOG_MENU = CATALOG.filter(function (e) { return !e.hidden; }).map(function (e) { return e.type; });

var ALIAS = { reverb: 'plate' };
/** A catalog type for a name ('reverb' is 'plate'), or null. */
export function catalogType(t) {
  var x = ALIAS[t] || t;
  return CATALOG_TYPES.indexOf(x) >= 0 ? x : null;
}
export function catalogEntry(type) {
  var t = catalogType(type);
  for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].type === t) return CATALOG[i];
  return null;
}
export function catalogDial(type, key) {
  var e = catalogEntry(type);
  if (!e) return null;
  for (var i = 0; i < e.dials.length; i++) if (e.dials[i].key === key) return e.dials[i];
  return null;
}

/** A law (see the header) at dial value v. */
export function lawValue(law, v) {
  if (law.zeroNull && v <= 0) return null;
  var x = law.pow ? law.pow[0] * Math.pow(law.pow[1], v / law.div) : law.exp2[0] * Math.pow(2, law.exp2[1] * v / law.div);
  return law.fixed !== undefined ? +x.toFixed(law.fixed) : law.round ? Math.round(x) : x;
}
/** A dial value (UI units, already clamped) to its engine value. */
export function dialDsp(dial, v) {
  var s = dial.dsp;
  if (!s) return v;
  if (s.div) return v / s.div;
  var x = lawValue(s.law, v);
  return x === null ? 0 : x;
}

/** The delay time in seconds for a note length at a tempo (hacks.ts delayS). */
export function delaySeconds(beats, bpm) { return Math.min(MAX_DELAY_S, beats * 60 / (bpm > 0 ? bpm : 120)); }
var minus = function (v) { return v > 0 ? '+' : v < 0 ? '−' : ''; };
/** hacks.ts fmtHz. */
function fmtHz(h) { return h == null ? 'open' : h >= 1000 ? (h / 1000).toFixed(h >= 10000 ? 0 : 1) + ' kHz' : h + ' Hz'; }

/** The readout for a dial at value v (bpm for tempo-synced dials). */
export function formatDial(dial, v, bpm) {
  var f = dial.format, h;
  switch (f.fmt) {
    case 'db': return v === 0 && f.zero ? f.zero : minus(v) + Math.abs(v) + ' dB';
    case 'pct': return v + '%';
    case 'wet': return v + '% wet';
    case 'signedPct': return minus(v) + Math.abs(v) + '%';
    case 'num': return v + f.suffix;
    case 'fixed': return (f.add + v / f.div).toFixed(f.digits) + f.suffix;
    case 'hz':
      if (f.offAt !== undefined && v >= f.offAt) return 'off';
      if (!f.law) return v === 0 && f.zero ? f.zero : v + ' Hz';
      h = lawValue(f.law, v);
      if (h === null) return f.zero || 'open';
      return f.astrid ? fmtHz(h) : h + ' Hz';
    case 'q': return 'Q ' + lawValue(f.law, v).toFixed(1);
    case 'ratio': return lawValue(f.law, v).toFixed(1) + ':1';
    case 'rate': h = lawValue(f.law, v); return (h < 1 ? h.toFixed(2) : h < 10 ? h.toFixed(1) : h.toFixed(0)) + ' Hz';
    case 'balance': return v === 0 ? 'centre' : v < 0 ? 'L ' + (-v) : 'R ' + v;
    case 'stages': return v + ' stages';
    case 'option':
      for (var i = 0; i < dial.options.length; i++) if (dial.options[i].value === v) return dial.options[i].label;
      return String(v);
    case 'tempoMs': return Math.round(delaySeconds(v, bpm) * 1000) + ' ms';
    case 'freeBeats': return v === 0 ? 'off' : 'free ' + +v.toFixed(3) + ' beats · ' + Math.round(delaySeconds(v, bpm) * 1000) + ' ms';
  }
  return String(v);
}

/** The catalog as JSON (a deep copy: hosts can keep or change it freely). */
export function describeCatalog() { return JSON.parse(JSON.stringify(CATALOG)); }
