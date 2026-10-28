// PR C: the delay's tone and low cut (in the feedback loop), Insert / Send, send + Accent -> send (mod route 2),
// 1/32 and Free time. design-addendum-bass-gaps.md §3-§5. Bass parity is bass-delay-parity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxDsp, FX_PARAM as P } from '../src/dsp.js';
import { compile, defaultState, migrate } from '../src/params.js';
import { SR, identical } from './helpers.mjs';

function program(dials) { const s = defaultState(); s.chain[1].bypass = false; Object.assign(s.chain[1].dials, dials); return compile(s); }
function run(prog, inL, opts = {}) {
  const fx = createFxDsp(SR); fx.setTempo(opts.bpm || 120, 0, true); fx.load(prog, 0, true);
  const n = inL.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0; o < n; o += 128) {
    const e = Math.min(n, o + 128);
    if (opts.at) opts.at(fx, o);
    fx.process(inL.subarray(o, e), inL.subarray(o, e), oL.subarray(o, e), oR.subarray(o, e), e - o, o, opts.mod ? opts.mod.subarray(o, e) : null);
  }
  return oL;
}
const impulse = (n) => { const x = new Float32Array(n); x[0] = 0.5; return x; };
const firstEcho = (o, from) => { let k = from; while (k < o.length && Math.abs(o[k]) < 1e-4) k++; return k; };
const sine = (n, hz = 220) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / SR));
const maxStep = (o, a, b) => { let m = 0; for (let i = a + 1; i < b; i++) m = Math.max(m, Math.abs(o[i] - o[i - 1])); return m; };

test('defaults are ASTRID: an old (18-value) program and the new defaults render the same samples', () => {
  const x = sine(48000);
  const p = program({ mix: 40, feedback: 60 }), old = p.slice(0, 18);
  assert.deepEqual(Array.from(p.slice(18)), [100 / 99, 0, 0, 1, 0, 0]);
  assert.ok(identical(run(p, x), run(old, x)));
});

test('Free time overrides the select (and 1/32 is a note): echo positions at 120 bpm', () => {
  const x = impulse(30000);
  assert.equal(firstEcho(run(program({ mode: 1, mix: 100, feedback: 0, delay_beats: 2, beats_free: 0.5 }), x), 10), 12000);
  assert.equal(firstEcho(run(program({ mode: 1, mix: 100, feedback: 0, delay_beats: 0.125 }), x), 10), 3000);
  assert.equal(firstEcho(run(program({ mode: 1, mix: 100, feedback: 0, delay_beats: 0.75, beats_free: 0 }), x), 10), 18000);
  // ASTRID's saved 1/16 stays 1/16; a saved value below 3/16 now lands on 1/32.
  assert.equal(migrate([{ type: 'delay', dials: { delay_beats: 0.25 } }]).state.chain[1].dials.delay_beats, 0.25);
  assert.equal(migrate([{ type: 'delay', dials: { delay_beats: 0.15 } }]).state.chain[1].dials.delay_beats, 0.125);
});

test('Send: mix 0 is the dry signal exactly; send 0 feeds nothing into the line', () => {
  const x = sine(24000);
  assert.ok(identical(run(program({ mode: 1, mix: 0, feedback: 50 }), x), x));
  const o = run(program({ mode: 1, mix: 100, send: 0, feedback: 50 }), x);
  assert.ok(identical(o, x), 'send 0: no wet at all');
});

test('Accent -> send: the CV opens the send (depth 100 from send 0)', () => {
  const n = 30000, x = sine(n), cv = new Float32Array(n);
  for (let i = 0; i < 2000; i++) cv[i] = 1;
  const o = run(program({ mode: 1, mix: 100, send: 0, mod_send: 100, feedback: 0, beats_free: 0.5 }), x, { mod: cv });
  let e = 0; for (let i = 12000; i < 14000; i++) e += (o[i] - x[i]) ** 2;
  assert.ok(e > 10, `echo of the accented 2000 samples: ${e}`);
  let q = 0; for (let i = 15000; i < 24000; i++) q += (o[i] - x[i]) ** 2;
  assert.equal(q, 0, 'unaccented: nothing sent');
});

test('tone and low cut sit in the feedback loop: each repeat is darker / thinner', () => {
  const n = 48000 * 2, x = new Float32Array(n);
  let s = 5; for (let i = 0; i < 2400; i++) x[i] = ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
  const o = run(program({ mode: 1, mix: 100, feedback: 80, beats_free: 0.25, tone: 20, low_cut: 400 }), x);
  // Repeats every 6000 samples: high-frequency share (first difference energy / energy) falls repeat to repeat.
  const hf = (a) => { let e = 0, d = 0; for (let i = a + 1; i < a + 2400; i++) { e += o[i] ** 2; d += (o[i] - o[i - 1]) ** 2; } return [e, d / e]; };
  const r1 = hf(6000), r2 = hf(12000), r3 = hf(18000);
  assert.ok(r2[0] < r1[0] && r3[0] < r2[0], 'energy falls');
  assert.ok(Number.isFinite(r3[1]) && r1[0] > 0);
  const flat = run(program({ mode: 1, mix: 100, feedback: 80, beats_free: 0.25 }), x);
  let a = 0, b = 0; for (let i = 18000; i < 20400; i++) { a += o[i] ** 2; b += flat[i] ** 2; }
  assert.ok(a < 0.5 * b, `third repeat with filters ${a} vs without ${b}`);
});

test('Free time glides exactly like the Timing select (same 80 ms glide): 0 -> 0.25 == select 0.75 -> 1/16', () => {
  const x = sine(48000 * 2, 110);
  for (const mode of [0, 1]) {
    const a = run(program({ mode, mix: 50, feedback: 30 }), x, { at: (fx, o) => { if (o === 48000) fx.set(P.DELAY_BEATS_FREE, 0.25); } });
    const b = run(program({ mode, mix: 50, feedback: 30 }), x, { at: (fx, o) => { if (o === 48000) fx.set(P.DELAY_BEATS, 0.25); } });
    assert.ok(identical(a, b), 'mode ' + mode);
  }
});

test('Free time and tempo changes glide (no jumps); switching mode and low cut off fade (no clicks)', () => {
  const n = 48000 * 3, x = sine(n, 110);
  const steady = maxStep(run(program({ mode: 1, mix: 50, feedback: 30 }), x), 30000, 48000);
  const cases = {
    'beats_free 0.3 -> 0.32': (fx, o) => { if (o === 0) fx.set(P.DELAY_BEATS_FREE, 0.3, 0, true); if (o === 48000) fx.set(P.DELAY_BEATS_FREE, 0.32); },
    'tempo 120 -> 124 (free)': (fx, o) => { if (o === 0) fx.set(P.DELAY_BEATS_FREE, 0.6, 0, true); if (o === 48000) fx.setTempo(124); },
    'mode Send -> Insert': (fx, o) => { if (o === 48000) fx.set(P.DELAY_MODE, 0); },
    'low cut 500 -> off': (fx, o) => { if (o === 0) fx.set(P.DELAY_LOW_CUT, 500, 0, true); if (o === 48000) fx.set(P.DELAY_LOW_CUT, 0); },
    'send 1 -> 0.2': (fx, o) => { if (o === 48000) fx.set(P.DELAY_SEND, 0.2); },
  };
  for (const name in cases) {
    const o = run(program({ mode: 1, mix: 50, feedback: 30 }), x, { at: cases[name] });
    const m = maxStep(o, 47000, 60000);
    assert.ok(m < 1.6 * steady, `${name}: max sample step ${m} vs steady ${steady}`);
    assert.ok(o.every(Number.isFinite));
  }
});

test('Insert with tone / low cut / send: finite, and back to the ASTRID path when they return to off / 100', () => {
  const x = sine(48000 * 2);
  const o = run(program({ mix: 50, feedback: 60, tone: 30, low_cut: 200, send: 50 }), x, { at: (fx, o) => {
    if (o === 48000) { fx.set(P.DELAY_TONE, 100 / 99, o, true); fx.set(P.DELAY_LOW_CUT, 0, o, true); fx.set(P.DELAY_SEND, 1, o, true); }
  } });
  assert.ok(o.every(Number.isFinite));
});
