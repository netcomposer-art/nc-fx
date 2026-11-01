// The EQ graph's curve is the sound: eqResponse() against the real slot engine's impulse response (a DFT at test
// frequencies), and the graph control's drags, keys and resets land on the right dials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxChainDsp } from '../src/chain.js';
import { slotProgram } from '../src/slots.js';
import { catalogDial, dialDsp } from '../src/catalog.js';
import { eqResponse, eqBands, eqGraph, eqPatchDials, eqResetDials, eqCoefficients, fxSpectrum } from '../src/eq.js';
import { eqGraph as fromIndex } from '../src/index.js';

const SR = 48000;
const N = 1 << 15;

/** The engine's impulse response for one EQ slot (on, settled at the dials). */
function impulse(dials) {
  const dsp = createFxChainDsp(SR, { slots: 1 });
  dsp.add(1, 'eq', 0);
  for (const [k, v] of slotProgram({ id: 'eq-1', type: 'eq', bypass: false, dials })) dsp.set(1, k, v, 0, true);
  dsp.order([1], 0, true);
  const inL = new Float32Array(N), inR = new Float32Array(N), oL = new Float32Array(N), oR = new Float32Array(N);
  // Warm up on silence (the chain's 4 ms order fade and any smoother), then the impulse.
  const warm = 128 * 64;
  const zl = new Float32Array(128), zr = new Float32Array(128), xl = new Float32Array(128), xr = new Float32Array(128);
  for (let o = 0; o < warm; o += 128) dsp.process(zl, zr, xl, xr, 128, o);
  inL[0] = 1; inR[0] = 1;
  for (let o = 0; o < N; o += 128) dsp.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), oL.subarray(o, o + 128), oR.subarray(o, o + 128), 128, warm + o);
  return oL;
}
function dftDb(h, hz) {
  const w = 2 * Math.PI * hz / SR;
  let re = 0, im = 0;
  for (let i = 0; i < h.length; i++) { re += h[i] * Math.cos(w * i); im -= h[i] * Math.sin(w * i); }
  return 10 * Math.log10(re * re + im * im);
}
const FREQS = [25, 60, 100, 150, 220, 400, 700, 938, 1500, 2500, 4000, 6000, 9000, 14000, 19000];

const CASES = [
  { low_db: 3, mid_db: -18, mid_hz: 48, mid_q: 0, high_db: -18 }, // Peter's screenshot: +3, -18 at 938 Hz Q 0.3, -18
  { low_db: -12, mid_db: 9, mid_hz: 20, mid_q: 70, high_db: 6 },
  { low_db: 18, mid_db: 0, mid_hz: 50, mid_q: 40, high_db: 0 },
  { low_db: 0, mid_db: 14, mid_hz: 100, mid_q: 100, high_db: 18 },
];

test('eqResponse matches the engine\'s impulse response within 0.1 dB', () => {
  for (const dials of CASES) {
    const h = impulse(dials);
    const curve = eqResponse(dials, SR, FREQS).total;
    FREQS.forEach((hz, i) => {
      const measured = dftDb(h, hz);
      assert.ok(Math.abs(measured - curve[i]) < 0.1, `${JSON.stringify(dials)} at ${hz} Hz: engine ${measured.toFixed(3)} dB, curve ${curve[i].toFixed(3)} dB`);
    });
  }
});

test('the bands follow the dial laws; 0 dB bands are flat and the total is their sum', () => {
  const b = eqBands({ low_db: 3, mid_db: -18, mid_hz: 48, mid_q: 0, high_db: -18 });
  assert.deepEqual(b.map((x) => x.id), ['low', 'mid', 'high']);
  assert.equal(b[0].hz, 150); assert.equal(b[2].hz, 6000);
  assert.equal(b[1].hz, dialDsp(catalogDial('eq', 'mid_hz'), 48));
  assert.equal(b[1].hz, 938);
  assert.equal(b[1].q, 0.3);
  const r = eqResponse({ low_db: 0, mid_db: 6, mid_hz: 50, mid_q: 40, high_db: 0 }, SR, [100, 1000, 10000]);
  assert.deepEqual([...r.bands[0]], [0, 0, 0]);
  assert.deepEqual([...r.bands[2]], [0, 0, 0]);
  assert.ok(Math.abs(r.total[1] - 6) < 0.01, 'the bell peaks at its gain at its centre');
  const flat = eqResponse({}, SR, [100, 1000]);
  assert.deepEqual([...flat.total], [0, 0]);
  // Shelves: +g far into the shelf, half of it (in dB) at the corner (S = 1).
  const lo = eqCoefficients(0, 150, 12, 0.7071, SR);
  assert.ok(lo.every(Number.isFinite));
  const r2 = eqResponse({ low_db: 12 }, SR, [20, 150, 5000]);
  assert.ok(Math.abs(r2.total[0] - 12) < 0.3 && Math.abs(r2.total[1] - 6) < 0.05 && Math.abs(r2.total[2]) < 0.1);
});

test('a drag or a key on a node maps to the right dials, rounded to their steps', () => {
  const dials = { low_db: 3, mid_db: -18, mid_hz: 48, mid_q: 0, high_db: -18 };
  // Mid: up 6 dB, to 2 kHz, Q 1.
  const p = eqPatchDials(dials, 'mid', { db: -11.6, hz: 2000, q: 1 });
  const m = Object.fromEntries(p);
  assert.equal(m.mid_db, -12);
  assert.ok(Number.isInteger(m.mid_hz) && Number.isInteger(m.mid_q), 'whole dial steps');
  assert.ok(Math.abs(200 * 25 ** (m.mid_hz / 100) - 2000) / 2000 < 0.02);
  assert.ok(Math.abs(0.3 * 20 ** (m.mid_q / 100) - 1) < 0.02);
  // Shelves move gain only (a frequency or Q is ignored); clamped to +-18.
  assert.deepEqual(eqPatchDials(dials, 'low', { db: 40, hz: 900, q: 3 }), [['low_db', 18]]);
  assert.deepEqual(eqPatchDials(dials, 'high', { db: -18.2 }), []);
  assert.deepEqual(eqPatchDials(dials, 'high', { db: -0.2 }), [['high_db', 0]]);
  // Unchanged values are left out.
  assert.deepEqual(eqPatchDials(dials, 'mid', { hz: 938 }), []);
  // Reset: the catalog defaults.
  assert.deepEqual(eqResetDials('mid'), [['mid_db', 0], ['mid_hz', 50], ['mid_q', 40]]);
  assert.deepEqual(eqResetDials('low'), [['low_db', 0]]);
});

test('eqGraph: the kit control, wired to the host\'s setter', () => {
  const state = { low_db: 3, mid_db: -18, mid_hz: 48, mid_q: 0, high_db: -18 };
  const sets = [];
  const fx = { getParam: (ref, k) => (ref === 'eq-1' ? state[k] : undefined), output: null };
  const c = eqGraph(fx, 'eq-1', { id: 'g', set: (k, v) => sets.push([k, v]), help: { mid: 'words' } });
  assert.equal(fromIndex, eqGraph);
  assert.equal(c.type, 'eqGraph');
  assert.equal(c.range, 18);
  assert.deepEqual(c.bands.map((b) => [b.id, b.kind, b.hz, b.db]), [['low', 'lowshelf', 150, 3], ['mid', 'peak', 938, -18], ['high', 'highshelf', 6000, -18]]);
  assert.equal(c.bands[1].valueText, '−18 dB at 938 Hz, Q 0.3');
  assert.equal(c.bands[1].help, 'words');
  assert.equal(c.spectrum, undefined, 'no output, no spectrum');
  const r = c.response(new Float64Array([938]));
  assert.ok(Math.abs(r.bands[1][0] + 18) < 0.01);
  c.onBand('mid', { db: -12 });
  c.onReset('low');
  c.onReset('mid');
  assert.deepEqual(sets, [['mid_db', -12], ['low_db', 0], ['mid_db', 0], ['mid_hz', 50], ['mid_q', 40]]);
});

test('fxSpectrum: one analyser per chain, connected only while open', () => {
  const log = [];
  const analyser = { fftSize: 0 };
  const output = { context: { createAnalyser: () => { log.push('create'); return analyser; } }, connect: (n) => log.push(['connect', n === analyser]), disconnect: (n) => log.push(['disconnect', n === analyser]) };
  const fx = { output, status: 'ready' };
  const s = fxSpectrum(fx);
  assert.equal(fxSpectrum(fx), s, 'shared');
  assert.equal(s.open(), analyser);
  assert.equal(s.open(), analyser);
  s.close();
  assert.deepEqual(log, ['create', ['connect', true]]);
  s.close();
  s.close();
  assert.deepEqual(log, ['create', ['connect', true], ['disconnect', true]]);
  assert.equal(analyser.fftSize, 4096);
  assert.equal(fxSpectrum({ output: null }), null);
});
