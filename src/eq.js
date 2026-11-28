// nc-fx EQ graph: the EQ's frequency response as it really plays, and the control the nc-ui kit's EQ graph draws
// (the Studio Mix's insert cards, LUCY's Hacks): the combined curve, each band's own curve, a node per band to drag,
// and a live spectrum from the chain's output behind it (Peter, 2026-11-01: "a real-time visualizer ... that shows
// the frequency cuts and boosts").
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// The maths is the engine's own (src/units.js biquadSet: RBJ low shelf at 150 Hz with S = 1, bell, high shelf at
// 6 kHz), evaluated on the unit circle, so the curve is the sound: test/eq.test.mjs measures the real slot engine's
// impulse response against it (within 0.1 dB). nc-ui is never imported: eqGraph() returns the kit control as plain
// data (type 'eqGraph'), the way ui.js writes the kit's markup.
import { catalogDial, dialDsp } from './catalog.js';

/** The EQ's fixed shelves (ASTRID's widgets: low_hz 150, high_hz 6000) and its gain range. */
export var EQ_LOW_HZ = 150;
export var EQ_HIGH_HZ = 6000;
export var EQ_RANGE_DB = 18;
var TAU = 6.283185307179586;

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

/**
 * One band's coefficients, normalised [b0, b1, b2, a1, a2], exactly as the engine computes them (units.js biquadSet).
 * kind: 0 low shelf, 1 peak (bell), 2 high shelf.
 */
export function eqCoefficients(kind, hz, db, q, sampleRate) {
  var A = Math.pow(10, db / 40);
  var w0 = TAU * hz / sampleRate;
  var c = Math.cos(w0), s = Math.sin(w0);
  var b0, b1, b2, a0, a1, a2, alpha, sq;
  if (kind === 0 || kind === 2) {
    alpha = s / 2 * Math.SQRT2;
    sq = 2 * Math.sqrt(A) * alpha;
    var sg = kind === 0 ? 1 : -1; // the high shelf mirrors the low shelf's (A - 1) terms
    b0 = A * ((A + 1) - sg * (A - 1) * c + sq);
    b1 = sg * 2 * A * ((A - 1) - sg * (A + 1) * c);
    b2 = A * ((A + 1) - sg * (A - 1) * c - sq);
    a0 = (A + 1) + sg * (A - 1) * c + sq;
    a1 = -sg * 2 * ((A - 1) + sg * (A + 1) * c);
    a2 = (A + 1) + sg * (A - 1) * c - sq;
  } else {
    alpha = s / (2 * q);
    b0 = 1 + alpha * A;
    b1 = -2 * c;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * c;
    a2 = 1 - alpha / A;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** |H(e^jw)| of normalised biquad coefficients at hz, in dB. */
export function biquadDb(co, hz, sampleRate) {
  var w = TAU * hz / sampleRate;
  var c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  var nr = co[0] + co[1] * c1 + co[2] * c2, ni = -(co[1] * s1 + co[2] * s2);
  var dr = 1 + co[3] * c1 + co[4] * c2, di = -(co[3] * s1 + co[4] * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

var DIAL = {};
function dial(key) { return DIAL[key] || (DIAL[key] = catalogDial('eq', key)); }
function dialValue(dials, key) {
  var d = dial(key), v = dials && typeof dials[key] === 'number' && isFinite(dials[key]) ? dials[key] : d.default;
  return clamp(v, d.min, d.max);
}

/**
 * The five bands an EQ's dials (UI units, as on the sliders and in the state) play, in engine units, low to high:
 * low shelf, low-mid bell, mid bell, high-mid bell, high shelf (Peter, 2026-11-28). kind 0 low shelf, 1 bell, 2 high shelf.
 */
export function eqBands(dials) {
  var bell = function (id, pre) {
    return { id: id, kind: 1, hz: dialDsp(dial(pre + '_hz'), dialValue(dials, pre + '_hz')), db: dialValue(dials, pre + '_db'), q: dialDsp(dial(pre + '_q'), dialValue(dials, pre + '_q')) };
  };
  return [
    { id: 'low', kind: 0, hz: dialValue(dials, 'low_hz'), db: dialValue(dials, 'low_db'), q: Math.SQRT1_2 },
    bell('lowmid', 'lm'),
    bell('mid', 'mid'),
    bell('highmid', 'hm'),
    { id: 'high', kind: 2, hz: dialValue(dials, 'high_hz'), db: dialValue(dials, 'high_db'), q: Math.SQRT1_2 }
  ];
}
/** Each band's dials: gain, frequency, and (bells) Q. */
var BAND_DIALS = {
  low: { db: 'low_db', hz: 'low_hz' }, lowmid: { db: 'lm_db', hz: 'lm_hz', q: 'lm_q' }, mid: { db: 'mid_db', hz: 'mid_hz', q: 'mid_q' },
  highmid: { db: 'hm_db', hz: 'hm_hz', q: 'hm_q' }, high: { db: 'high_db', hz: 'high_hz' }
};
var ALL_DIALS = ['low_db', 'low_hz', 'lm_db', 'lm_hz', 'lm_q', 'mid_db', 'mid_hz', 'mid_q', 'hm_db', 'hm_hz', 'hm_q', 'high_db', 'high_hz'];

/**
 * The EQ's response at each frequency in `freqs` (Hz), in dB: the combined curve and each band's own. A band at
 * 0 dB is exactly flat, as in the engine (all five at 0 dB is a wire).
 * @returns {{ total: Float64Array, bands: Float64Array[] }}
 */
export function eqResponse(dials, sampleRate, freqs) {
  var bands = eqBands(dials), n = freqs.length, total = new Float64Array(n), out = [];
  var nyq = sampleRate / 2;
  for (var b = 0; b < bands.length; b++) {
    var band = bands[b], arr = new Float64Array(n);
    if (band.db !== 0) {
      var co = eqCoefficients(band.kind, band.hz, band.db, band.q, sampleRate);
      for (var i = 0; i < n; i++) {
        var f = freqs[i] < nyq ? freqs[i] : nyq * 0.9999;
        arr[i] = biquadDb(co, f, sampleRate);
        total[i] += arr[i];
      }
    }
    out.push(arr);
  }
  return { total: total, bands: out };
}

/** The Mid at dial (0..100, unrounded) that plays hz: the inverse of its law (200 Hz * 25^(v / 100)). */
export function eqMidHzDial(hz) {
  var law = dial('mid_hz').dsp.law;
  return clamp(law.div * Math.log(hz / law.pow[0]) / Math.log(law.pow[1]), 0, 100);
}
/** The Mid Q dial (0..100, unrounded) that plays q: the inverse of 0.3 * 20^(v / 100). */
export function eqMidQDial(q) {
  var law = dial('mid_q').dsp.law;
  return clamp(law.div * Math.log(q / law.pow[0]) / Math.log(law.pow[1]), 0, 100);
}
/** A frequency dial's value for hz: Mid's through its law, the others are in Hz. */
function hzDial(key, hz) { return key === 'mid_hz' ? eqMidHzDial(hz) : hz; }

var LABEL = { low: 'Low', lowmid: 'Low-mid', mid: 'Mid', highmid: 'High-mid', high: 'High' };

/**
 * A band patch from the graph (engine units: hz, db, q) as dial changes, each rounded to its dial's step and
 * clamped, leaving out what doesn't change: [[key, value], ...].
 */
export function eqPatchDials(dials, id, patch) {
  var out = [];
  function push(k, x) {
    var d = dial(k), step = d.step || 1;
    x = clamp(Math.round(x / step) * step, d.min, d.max);
    if (x === 0) x = 0; // no -0
    if (x !== dialValue(dials, k)) out.push([k, x]);
  }
  var b = BAND_DIALS[id];
  if (!b) return out;
  if (typeof patch.db === 'number') push(b.db, patch.db);
  if (typeof patch.hz === 'number' && patch.hz > 0) push(b.hz, hzDial(b.hz, patch.hz));
  if (b.q && typeof patch.q === 'number' && patch.q > 0) push(b.q, eqMidQDial(patch.q));
  return out;
}
/** The dials that reset a band: its gain, frequency and (bells) Q back to the catalog default. */
export function eqResetDials(id) {
  var b = BAND_DIALS[id];
  var keys = b ? [b.db, b.hz].concat(b.q ? [b.q] : []) : [];
  return keys.map(function (k) { return [k, dial(k).default]; });
}

/**
 * One AnalyserNode on an nc-fx chain's output, shared by every graph that shows it and connected only while one is
 * open (so an EQ nobody is looking at costs nothing). The analyser is a side branch: it is never connected onward.
 */
var TAPS = typeof WeakMap === 'function' ? new WeakMap() : null;
export function fxSpectrum(fx) {
  var out = fx && fx.output;
  if (!out || !out.context || typeof out.context.createAnalyser !== 'function') return null;
  var tap = TAPS && TAPS.get(fx);
  if (tap) return tap.handle;
  tap = { node: null, users: 0, handle: null };
  tap.handle = {
    open: function () {
      if (fx.status === 'disposed') return null;
      if (!tap.node) {
        tap.node = out.context.createAnalyser();
        tap.node.fftSize = 4096;
        tap.node.smoothingTimeConstant = 0.8;
        tap.node.minDecibels = -110;
        tap.node.maxDecibels = 0;
      }
      if (tap.users++ === 0) out.connect(tap.node);
      return tap.node;
    },
    close: function () {
      if (tap.users === 0) return;
      if (--tap.users === 0 && tap.node) { try { out.disconnect(tap.node); } catch (e) { void e; } }
    }
  };
  if (TAPS) TAPS.set(fx, tap);
  return tap.handle;
}

/**
 * The kit's EQ graph control for one EQ in an nc-fx chain (put it first in the EQ's FX card).
 * @param {object} fx       the chain (anything with getParam(ref, key), and `output` for the spectrum)
 * @param {string} ref      the EQ's id in the chain ('eq-1'), or 'eq'
 * @param {object} opts     { id, set(key, value): the same setter the EQ's sliders use (it re-renders),
 *                            sampleRate?, on?, help?: { graph?, low?, mid?, high? }, spectrum?: false }
 */
export function eqGraph(fx, ref, opts) {
  var o = opts || {};
  var dials = {};
  ALL_DIALS.forEach(function (k) {
    var v = fx && typeof fx.getParam === 'function' ? fx.getParam(ref, k) : undefined;
    dials[k] = typeof v === 'number' ? v : dial(k).default;
  });
  var ctx = fx && fx.output && fx.output.context;
  var sr = o.sampleRate || (ctx && ctx.sampleRate) || 48000;
  var help = o.help || {};
  var bands = eqBands(dials).map(function (b) {
    var g = (b.db > 0 ? '+' : b.db < 0 ? '−' : '') + Math.abs(b.db) + ' dB';
    var at = b.hz >= 1000 ? (b.hz / 1000).toFixed(b.hz >= 10000 ? 0 : 1) + ' kHz' : Math.round(b.hz) + ' Hz';
    return {
      id: b.id,
      label: LABEL[b.id],
      kind: b.kind === 0 ? 'lowshelf' : b.kind === 1 ? 'peak' : 'highshelf',
      hz: b.hz, db: b.db, q: b.q,
      moveHz: true, moveQ: b.kind === 1,
      minHz: b.id === 'mid' ? 200 : dial(BAND_DIALS[b.id].hz).min, maxHz: b.id === 'mid' ? 5000 : dial(BAND_DIALS[b.id].hz).max,
      minQ: 0.3, maxQ: 6,
      valueText: b.kind === 1 ? g + ' at ' + at + ', Q ' + b.q.toFixed(1) : g + (b.id === 'low' ? ', shelf below ' : ', shelf above ') + at,
      help: help[b.id]
    };
  });
  var apply = function (list) { for (var i = 0; i < list.length; i++) o.set(list[i][0], list[i][1]); };
  return {
    type: 'eqGraph',
    id: o.id,
    label: o.label || 'EQ curve',
    range: EQ_RANGE_DB,
    sampleRate: sr,
    on: o.on !== false,
    bands: bands,
    help: help.graph,
    response: function (freqs) { return eqResponse(dials, sr, freqs); },
    spectrum: o.spectrum === false ? undefined : fxSpectrum(fx) || undefined,
    onBand: function (id, patch) { apply(eqPatchDials(dials, id, patch)); },
    onReset: function (id) { apply(eqResetDials(id).filter(function (p) { return p[1] !== dials[p[0]]; })); }
  };
}
