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
  assert.deepEqual(Array.from(p.slice(14)), [0, 100 / 99, 0, 0]);
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

test('new settings off: Smooth, tone off, depths set but no mod / depths 0 with mod -> bit-identical to the old engine', () => {
  const ref = run(BASE, 128, null);
  for (const [label, p, mod] of [['defaults', prog(0, 100 / 99, 0, 0), CV], ['depths, no mod', prog(0, 100 / 99, 0.7, 0.4), null],
    ['depths, mod shorter than the block', prog(0, 100 / 99, 0.7, 0.4), 'short']]) {
    const out = mod === 'short' ? (() => { const fx = createFxDsp(SR); fx.load(p, 0, true); const oL = new Float32Array(N), oR = new Float32Array(N);
      for (let o = 0; o < N; o += 128) fx.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), oL.subarray(o, o + 128), oR.subarray(o, o + 128), 128, o, CV.subarray(o, o + 64)); return [oL, oR]; })()
      : run(p, 128, mod);
    assert.ok(identical(out[0], ref[0]) && identical(out[1], ref[1]), label);
  }
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
