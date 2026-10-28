// PR B: drive.curve (Smooth | Acid), drive.tone (100 = off), and the accent depths drive.mod_drive / drive.mod_tone
// (mod routes 0 and 1). Bit-exactness against Bass is test/bass-parity.test.mjs; ASTRID's (all new dials at their
// defaults) is test/astrid-parity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxDsp, FX_PARAM as P, FX_NPARAMS } from '../src/dsp.js';
import { sanitize, compile, defaultState, dialDef, dialToDsp, describeParams, clampDial, dialStep } from '../src/params.js';
import { createFxCore } from '../src/index.js';
import { mockContext } from './mock-audio.mjs';
import { SR, noiseBursts, identical } from './helpers.mjs';

const drive = (dials) => sanitize({ v: 1, chain: [{ type: 'drive', bypass: false, dials }] }).chain[0].dials;

test('drive_db: 0.1 dB steps in Acid, whole dB in Smooth (sanitize, describeParams)', () => {
  assert.equal(drive({ curve: 1, drive_db: 10.24 }).drive_db, 10.2);
  assert.equal(drive({ curve: 1, drive_db: 10.25 }).drive_db, 10.3);
  assert.equal(drive({ curve: 1, drive_db: 0.04 }).drive_db, 0);
  assert.equal(drive({ curve: 1, drive_db: 30 }).drive_db, 24);
  assert.equal(drive({ curve: 0, drive_db: 10.2 }).drive_db, 10);
  assert.equal(drive({ drive_db: 10.6 }).drive_db, 11);
  assert.equal(drive({ curve: 0.8, drive_db: 10.2 }).drive_db, 10.2, 'curve snaps to Acid first');
  const d = dialDef('drive', 'drive_db');
  assert.equal(dialStep(d, { curve: 1 }), 0.1);
  assert.equal(dialStep(d, { curve: 0 }), 1);
  assert.equal(clampDial(d, 7.77, 0.1), 7.8);
  for (let k = 0; k <= 240; k++) assert.equal(drive({ curve: 1, drive_db: k / 10 }).drive_db, k / 10); // grid is exact
  const info = describeParams().find((p) => p.effect === 'drive' && p.key === 'drive_db');
  assert.deepEqual(info.stepWhen, [{ key: 'curve', value: 1, step: 0.1 }]);
  const curve = describeParams().find((p) => p.effect === 'drive' && p.key === 'curve');
  assert.deepEqual([curve.index, curve.control, curve.unit, curve.options.map((o) => o.label)], [14, 'select', null, ['Smooth', 'Acid']]);
  assert.deepEqual(['tone', 'mod_drive', 'mod_tone'].map((k) => describeParams().find((p) => p.effect === 'drive' && p.key === k).index), [15, 16, 17]);
});

test('new dials: defaults, laws, readouts; an old state compiles to the old program plus the new defaults', () => {
  const s = defaultState().chain[0].dials;
  assert.deepEqual([s.curve, s.tone, s.mod_drive, s.mod_tone], [0, 100, 0, 0]);
  assert.equal(dialToDsp('drive', 'tone', 99), 1);
  assert.equal(dialToDsp('drive', 'tone', 30), 30 / 99);
  assert.ok(dialToDsp('drive', 'tone', 100) > 1, '100 = off');
  assert.equal(dialToDsp('drive', 'mod_drive', -50), -0.5);
  assert.equal(dialToDsp('drive', 'mod_tone', 30), 0.3);
  assert.equal(dialToDsp('drive', 'curve', 1), 1);
  assert.equal(dialDef('drive', 'tone').format(100), 'off');
  assert.equal(dialDef('drive', 'tone').format(0), '500 Hz');
  assert.equal(dialDef('drive', 'tone').format(99), '16000 Hz');
  assert.equal(dialDef('drive', 'mod_drive').format(-40), '\u221240%');
  assert.equal(dialDef('drive', 'curve').format(1), 'Acid');
  const p = compile([{ type: 'drive', bypass: false, dials: { drive_db: 12 } }]); // ASTRID's array form
  assert.equal(p.length, FX_NPARAMS);
  assert.deepEqual(Array.from(p.slice(14, 18)), [0, 100 / 99, 0, 0]);
});

test('setParam: drive_db follows the curve (0.1 dB in Acid; back to whole dB, posted and notified, in Smooth)', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js' });
  await fx.ready;
  const seen = [];
  fx.onChange((c) => seen.push(c));
  assert.equal(fx.setParam('drive', 'drive_db', 10.26), 10);
  assert.equal(fx.setParam('drive', 'curve', 1), 1);
  assert.deepEqual(ctx.posted.at(-1), { t: 'p', i: 14, v: 1, when: 0 });
  assert.equal(fx.setParam('drive', 'drive_db', 10.26), 10.3);
  assert.deepEqual(ctx.posted.at(-1), { t: 'p', i: 1, v: 10.3, when: 0 });
  const n = ctx.posted.length;
  assert.equal(fx.setParam('drive', 'curve', 0, 1.5), 0);
  assert.deepEqual(ctx.posted.slice(n), [{ t: 'p', i: 14, v: 0, when: 1.5 }, { t: 'p', i: 1, v: 10, when: 1.5 }]);
  assert.equal(fx.getParam('drive', 'drive_db'), 10);
  assert.deepEqual(seen.slice(-2), [{ effect: 'drive', key: 'curve', value: 0 }, { effect: 'drive', key: 'drive_db', value: 10 }]);
  assert.equal(fx.setParam('drive', 'tone', 100.4), 100);
  assert.deepEqual(ctx.posted.at(-1), { t: 'p', i: 15, v: 100 / 99, when: 0 });
  assert.equal(fx.setParam('drive', 'mod_tone', -250), -100);
});

const N = SR;
const [inL, inR] = noiseBursts(N, 3);
function accent() { const cv = new Float32Array(N); for (let i = 0; i < N; i++) { const ph = i % 6000; cv[i] = (i / 6000 | 0) % 4 ? 0 : Math.exp(-ph / 1600); } return cv; }
const CV = accent();
function run(prog, block = 128, mod = CV, opts) {
  const fx = createFxDsp(SR, opts);
  fx.load(prog, 0, true);
  const oL = new Float32Array(N), oR = new Float32Array(N);
  for (let o = 0; o < N; o += block) {
    const e = Math.min(N, o + block);
    fx.process(inL.subarray(o, e), inR.subarray(o, e), oL.subarray(o, e), oR.subarray(o, e), e - o, o, mod ? mod.subarray(o, e) : null);
  }
  return [oL, oR];
}
const BASE = [1, 12, 0, 1, 0, 0.75, 0.35, 0, 0, 0, 0.5, 0.5, 0, 0];
const prog = (curve, tone, md, mt) => BASE.concat([curve, tone, md, mt]);
const rms = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / (to - from)); };
const hf = (a) => { let s = 0; for (let i = 1; i < a.length; i++) { const d = a[i] - a[i - 1]; s += d * d; } return Math.sqrt(s / a.length); };
const finite = (a) => a.every((v) => Number.isFinite(v));

test('new settings off: Smooth, tone off, depths 0 with mod -> bit-identical to the old engine; depths with no CV == a silent CV', () => {
  const ref = run(BASE, 128, null), withCv = run(prog(0, 100 / 99, 0, 0), 128, CV);
  assert.ok(identical(withCv[0], ref[0]) && identical(withCv[1], ref[1]), 'defaults, with mod');
  // Depths set: no CV, a CV shorter than the block and a silent CV are all the same sound (Zeta, PR B P2-a). It is not
  // the old engine: the depths keep the mod paths on (e.g. the tone LP with a tone mod), as they would with a silent CV.
  const p = prog(0, 100 / 99, 0.7, 0.4), silent = run(p, 128, new Float32Array(N)), none = run(p, 128, null);
  const fx = createFxDsp(SR); fx.load(p, 0, true); const oL = new Float32Array(N), oR = new Float32Array(N);
  for (let o = 0; o < N; o += 128) fx.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), oL.subarray(o, o + 128), oR.subarray(o, o + 128), 128, o, CV.subarray(o, o + 64));
  assert.ok(identical(none[0], silent[0]) && identical(none[1], silent[1]), 'depths, no mod');
  assert.ok(identical(oL, silent[0]) && identical(oR, silent[1]), 'depths, mod shorter than the block');
});

test('tone darkens (Smooth and Acid); accent -> drive moves the drive only on accents; outputs finite', () => {
  for (const c of [0, 1]) {
    const open = run(prog(c, 100 / 99, 0, 0), 128, null)[0], dark = run(prog(c, 10 / 99, 0, 0), 128, null)[0];
    assert.ok(finite(dark) && hf(dark) < 0.5 * hf(open), `curve ${c}: ${hf(dark)} vs ${hf(open)}`);
    const flat = run(BASE.slice(0, 1).concat([2], BASE.slice(2), [c, 100 / 99, 0, 0]), 128, null)[0];
    const pushed = run(BASE.slice(0, 1).concat([2], BASE.slice(2), [c, 100 / 99, 1, 0]), 128, CV)[0];
    const diff = flat.map((v, i) => pushed[i] - v);
    assert.ok(finite(pushed) && rms(diff, 0, 3000) > 0.1 * rms(flat, 0, 3000), `curve ${c}: the accent moves the drive`);
    assert.ok(rms(diff, 12100, 15000) < 1e-6 && rms(flat, 12100, 15000) > 0.05, `curve ${c}: no accent, no change`); // 2nd burst, CV 0
  }
});

test('block-size invariant with the tone mod (128-frame absolute grid), Smooth and Acid', () => {
  for (const c of [0, 1]) {
    const p = prog(c, 40 / 99, 0.5, 0.6), ref = run(p, 128);
    for (const b of [1, 7, 64, 100, 256, 1024]) { const o = run(p, b); assert.ok(identical(o[0], ref[0]) && identical(o[1], ref[1]), `curve ${c} block ${b}`); }
  }
});

test('switching curve mid-stream, tone on/off, depths, panic: no NaN, no jump beyond the signal', () => {
  const fx = createFxDsp(SR, { limiter: 'soft' });
  fx.load(prog(0, 50 / 99, 0.5, 0.5), 0, true);
  const oL = new Float32Array(N), oR = new Float32Array(N);
  for (let o = 0, k = 0; o < N; o += 128, k++) {
    if (k % 20 === 5) fx.set(P.DRIVE_CURVE, (k / 20 | 0) % 2 ? 0 : 1, o + 17);
    if (k % 30 === 9) fx.set(P.DRIVE_TONE, (k / 30 | 0) % 2 ? 100 / 99 : 0.2, o + 3);
    if (k % 50 === 11) fx.set(P.DRIVE_MOD, -1, o);
    if (k === 300) fx.clear(o + 5);
    fx.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), oL.subarray(o, o + 128), oR.subarray(o, o + 128), 128, o, CV.subarray(o, o + 128));
  }
  assert.ok(finite(oL) && finite(oR));
  assert.ok(oL.every((v) => Math.abs(v) <= 1.0001));
});

// ---- Zeta's PR B review (P2-a, P2-b, P3-2)
function renderMod(dials, mod, n = SR, opts) {
  let s = 5; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const L = new Float32Array(n).map((_, i) => 0.5 * Math.sin(i * 0.05) + 0.2 * (rnd() * 2 - 1)), R = L.map((v) => -0.7 * v);
  const fx = createFxDsp(SR, opts); fx.load(compile(sanitize({ v: 1, chain: [{ type: 'drive', bypass: false, dials }] })), 0, true);
  const oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0; o < n; o += 128) fx.process(L.subarray(o, o + 128), R.subarray(o, o + 128), oL.subarray(o, o + 128), oR.subarray(o, o + 128), 128, o, typeof mod === 'function' ? mod(o) : mod ? mod.subarray(o, o + 128) : null);
  return [oL, oR];
}
test('a silent CV sounds exactly like no CV, at any depths (72 settings; also a CV shorter than the block)', () => {
  const n = 24000, Z = new Float32Array(n), short = new Float32Array(64);
  for (const curve of [0, 1]) for (const drive_db of [0, 12]) for (const tone of [100, 60]) for (const mod_drive of [0, 50, -50]) for (const mod_tone of [0, -50, 50]) {
    const d = { curve, drive_db, tone, mix: 100, output_db: 0, mod_drive, mod_tone };
    const a = renderMod(d, null, n), b = renderMod(d, Z, n), c = renderMod(d, () => short, n);
    assert.ok(identical(a[0], b[0]) && identical(a[1], b[1]), 'zero CV ' + JSON.stringify(d));
    assert.ok(identical(a[0], c[0]) && identical(a[1], c[1]), 'short CV ' + JSON.stringify(d));
  }
});
test('a NaN or infinite CV sample counts as 0: nothing non-finite, and no state is poisoned', () => {
  const n = 24000;
  for (const bad of [NaN, Infinity, -Infinity]) for (const at of [12805, 12800]) for (const d of [
    { curve: 1, drive_db: 10, tone: 100, mod_drive: 50 }, { curve: 1, drive_db: 10, tone: 60, mod_tone: 50 },
    { curve: 0, drive_db: 6, tone: 100, mod_drive: 50 }, { curve: 0, drive_db: 6, tone: 60, mod_tone: 50 }]) {
    const cv = new Float32Array(n).fill(0.3), ref = cv.slice(); cv[at] = bad; ref[at] = 0;
    const [a] = renderMod(d, cv, n), [b] = renderMod(d, ref, n);
    assert.ok(a.every(Number.isFinite), `${bad} at ${at} ${JSON.stringify(d)}`);
    assert.ok(identical(a, b), `${bad} at ${at} renders as a 0 sample`);
  }
});
test('load() of a shorter (older) program fills the rest with the defaults (no stale values)', () => {
  const fx = createFxDsp(SR);
  fx.load(compile(sanitize({ v: 1, chain: [{ type: 'drive', bypass: false, dials: { curve: 1, tone: 30, mod_drive: 50, mod_tone: 20 } }] })), 0, true);
  fx.load([1, 12, 0, 1, 0, 0.75, 0.35, 0, 0, 0, 0.5, 0.5, 0, 0], 0, true); // a 14-value (0.1.0) program
  assert.deepEqual([fx.get(P.DRIVE_CURVE), fx.get(P.DRIVE_TONE), fx.get(P.DRIVE_MOD), fx.get(P.DRIVE_MOD_TONE)], [0, 100 / 99, 0, 0]);
});

test('no CV with depths set, blocks of 128 to 8192 frames: the same sound as a silent CV (zeroCv is preallocated to 4096)', () => {
  const p = prog(1, 60 / 99, 0.5, -0.5), n = 16384;
  for (const B of [128, 1024, 4096, 8192]) {
    const L = new Float32Array(n).map((_, i) => 0.5 * Math.sin(i * 0.05)), R = L.map((v) => -0.7 * v);
    const go = (cv) => { const fx = createFxDsp(SR); fx.load(p, 0, true); const oL = new Float32Array(n), oR = new Float32Array(n);
      for (let o = 0; o < n; o += B) fx.process(L.subarray(o, o + B), R.subarray(o, o + B), oL.subarray(o, o + B), oR.subarray(o, o + B), B, o, cv ? cv.subarray(o, o + B) : null);
      return [oL, oR]; };
    const a = go(null), z = go(new Float32Array(n));
    assert.ok(identical(a[0], z[0]) && identical(a[1], z[1]), `block ${B}`);
  }
});
