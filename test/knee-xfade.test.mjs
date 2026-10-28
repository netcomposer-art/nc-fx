// Peter's answers on nc-fx #1 (via Zeta): a soft knee on the 'soft' limiter, a smooth bypass crossfade, and
// Zeta's full-queue P3. These are the places nc-fx now deliberately differs from ASTRID (see README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxDsp, FX_PARAM as P } from '../src/dsp.js';
import { compile, defaultState } from '../src/params.js';
import { SR, renderDsp } from './helpers.mjs';

const KNEE = Math.pow(10, -6 / 20), CEIL = Math.pow(10, -1 / 20);
function sine(db, n = SR) { const A = Math.pow(10, db / 20), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = A * Math.sin(2 * Math.PI * 997 * i / SR); return x; }
function limiterGain(limiter, db) {
  const fx = createFxDsp(SR, { limiter }), x = sine(db), [y] = renderDsp(fx, x, null), lat = fx.latencySamples;
  let ex = 0, ey = 0, exact = true;
  for (let i = SR / 2; i < SR; i++) { ex += x[i - lat] ** 2; ey += y[i] ** 2; if (y[i] !== x[i - lat]) exact = false; }
  return { db: 10 * Math.log10(ey / ex), exact };
}

test("soft limiter: bit-transparent up to the -6 dBFS knee, then a C1 curve that never passes the -1 dBFS ceiling", () => {
  for (const db of [-24, -12, -6]) assert.ok(limiterGain('soft', db).exact, `${db} dBFS not bit-exact`);
  const g3 = limiterGain('soft', -3).db, g0 = limiterGain('soft', 0).db;
  assert.ok(g3 < 0 && g3 > -0.2, `-3 dBFS: ${g3}`);  // was -1.22 dB (full-range tanh)
  assert.ok(g0 < -0.5 && g0 > -1.2, `0 dBFS: ${g0}`); // was -2.18 dB
  // The static curve: identity to the knee, slope 1 there, monotonic, below the ceiling even at +24 dBFS.
  const fx = createFxDsp(SR, { limiter: 'soft' }), x = new Float32Array(4096), y = new Float32Array(4096);
  for (let i = 0; i < 4096; i++) x[i] = (i / 4095) * 16 * (i & 1 ? -1 : 1);
  fx.process(x, null, y, null, 4096);
  let prev = 0;
  for (let i = 0; i < 4096; i += 2) {
    assert.ok(Math.abs(y[i]) < CEIL, `|y| ${y[i]} at ${x[i]}`);
    if (x[i] <= KNEE) assert.equal(y[i], x[i]);
    assert.ok(y[i] >= prev); prev = y[i];
    assert.equal(y[i + 1 < 4096 ? i + 1 : i], -Math.abs(y[i + 1 < 4096 ? i + 1 : i])); // odd samples negative, symmetric curve
  }
  const h = 1e-4, at = (v) => { const a = new Float32Array([v]), b = new Float32Array(1); createFxDsp(SR, { limiter: 'soft' }).process(a, null, b, null, 1); return b[0]; };
  const slopeAbove = (at(KNEE + h) - at(KNEE)) / h;
  assert.ok(Math.abs(slopeAbove - 1) < 2e-3, `slope just above the knee ${slopeAbove}`);
});

test('lookahead limiter: no knee needed, it is bit-transparent below its ceiling (after the release settles)', () => {
  for (const db of [-24, -12, -6, -3]) assert.ok(limiterGain('lookahead', db).exact, `${db} dBFS not bit-exact`);
  assert.ok(Math.abs(limiterGain('lookahead', 0).db + 1) < 0.01);
  const n = SR * 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (i < SR / 10 ? 1 : 0.25) * Math.sin(i * 0.13);
  const fx = createFxDsp(SR, { limiter: 'lookahead' }), [y] = renderDsp(fx, x, null), lat = fx.latencySamples;
  for (let i = SR + lat; i < n; i++) assert.equal(y[i], x[i - lat], `sample ${i}`);
});

// Bypass crossfade: exact endpoints, no step when it lands.
function prog(type, on) { const s = defaultState(); const c = s.chain.find((x) => x.type === type); c.bypass = !on;
  if (type === 'drive') c.dials.drive_db = 18; if (type === 'delay') { c.dials.mix = 50; c.dials.feedback = 40; } if (type === 'plate') c.dials.mix = 40; return compile(s); }
const ONIDX = { drive: P.DRIVE_ON, delay: P.DELAY_ON, plate: P.PLATE_ON };

for (const type of ['drive', 'delay', 'plate']) {
  for (const to of [1, 0]) {
    test(`bypass crossfade (${type} ${to ? 'on' : 'off'}): exact before, exact once it lands (~140 ms)`, () => {
      const L = new Float32Array(SR), R = new Float32Array(SR); // continuous, so every sample shows the gains
      for (let i = 0; i < SR; i++) { L[i] = 0.5 * Math.sin(i * 0.031); R[i] = 0.4 * Math.sin(i * 0.017 + 1); }
      const mk = (on) => { const f = createFxDsp(SR, { bypassMode: 'run' }); f.load(prog(type, on), 0, true); return f; };
      const fx = mk(!to), from = renderDsp(mk(!to), L, R), dest = renderDsp(mk(to), L, R);
      const at = 4800;
      fx.set(ONIDX[type], to, at);
      const [yL, yR] = renderDsp(fx, L, R);
      for (let i = 0; i < at; i++) assert.ok(yL[i] === from[0][i] && yR[i] === from[1][i], `before ${i}`);
      let land = -1;
      for (let i = L.length - 1; i >= at; i--) if (yL[i] !== dest[0][i] || yR[i] !== dest[1][i]) { land = i + 1; break; }
      assert.ok(land > at + 0.1 * SR && land < at + 0.2 * SR, `lands at ${land - at} samples`);
    });
  }
}

test('bypass crossfade has no step: the last move onto the endpoint is no bigger than the ones before it', () => {
  // DC through the drive: dry 0.25, wet a constant, so y traces the crossfade gains exactly.
  const n = SR / 2, x = new Float32Array(n).fill(0.25);
  for (const to of [1, 0]) {
    const st = defaultState(), d = st.chain.find((c) => c.type === 'drive');
    d.bypass = !!to; d.dials.drive_db = 18; d.dials.output_db = -12; // wet ~ a quarter of dry
    const fx = createFxDsp(SR); fx.load(compile(st), 0, true);
    fx.set(P.DRIVE_ON, to, 1000);
    const [y] = renderDsp(fx, x, null);
    const end = y[n - 1], span = Math.abs(end - y[999]);
    assert.ok(span > 0.05);
    let land = n - 1; while (land > 1000 && y[land - 1] === end) land--;
    let maxStep = 0; for (let i = 1001; i < land; i++) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
    const last = Math.abs(y[land] - y[land - 1]);
    // ASTRID: last = 0.0016 * span (a 1000x jump over the samples before it). Now it is float32 rounding.
    assert.ok(last < 1e-6, `last step ${last} (span ${span}, max ${maxStep})`);
    for (let i = land - 200; i < land; i++) assert.ok(Math.abs(y[i] - y[i - 1]) <= Math.abs(y[i - 50] - y[i - 51]) + 1e-7, `steps shrink into the endpoint (${i})`);
  }
});

test("full queue (Zeta P3): mix 0.8 at frame 10000, then 0.2 now, ends at 0.8 (the head isn't pushed out early)", () => {
  const fx = createFxDsp(SR);
  fx.set(P.DELAY_MIX, 0.8, 10000);
  for (let k = 0; k < 255; k++) fx.set(P.PLATE_SIZE, (k % 10) / 10, 20000 + k);  // queue full: 256
  fx.set(P.DELAY_MIX, 0.2);                                                       // now
  assert.equal(fx.get(P.DELAY_MIX), 0.2);
  const b = new Float32Array(128);
  for (let f = 0; f < 9984; f += 128) fx.process(b, null, b, null, 128, f);
  assert.equal(fx.get(P.DELAY_MIX), 0.2);           // 0.8 not applied early
  for (let f = 9984; f < 30000; f += 128) fx.process(b, null, b, null, 128, f);
  assert.equal(fx.get(P.DELAY_MIX), 0.8);
  assert.equal(fx.get(P.PLATE_SIZE), 0.4);          // and every queued event still landed
});
