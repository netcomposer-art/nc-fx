// Crunch (nc-fx's own, 2026-11-23, for NYX's break tools): catalog and Add menu, clean at the top (44.1 kHz,
// 16-bit) is the input exactly, the rate folds a 1 kHz sine to 5 kHz at 6 kHz, Bits gives the expected noise level,
// the 5 Hz DC blocker, a Bits move crossfades (no zipper), a Rate move carries on, Steps: Smooth is a straight line,
// and going clean -> crunched glides in. Allocation: alloc-slots (every catalog type). CPU: test/bench/effects-cpu.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxChainDsp } from '../src/chain.js';
import { CATALOG_MENU, catalogEntry, catalogDial, formatDial, lawValue } from '../src/catalog.js';
import { newSlot, slotProgram, toAstridHacks } from '../src/slots.js';
import { identical } from './helpers.mjs';

const SR = 48000;
const K = { rate: catalogDial('crunch', 'rate').k, bits: catalogDial('crunch', 'bits').k, hold: catalogDial('crunch', 'hold').k };

function chain(dsp, sr = SR) {
  const fx = createFxChainDsp(sr, { bypassMode: 'run', limiter: 'off' });
  fx.add(1, 'crunch', 0);
  for (const [k, v] of slotProgram(newSlot('crunch'))) fx.set(1, k, v, 0, true);
  fx.set(1, 0, 1, 0, true);
  for (const [k, v] of Object.entries(dsp)) fx.set(1, K[k], v, 0, true);
  fx.order([1], 0, true);
  return fx;
}
/** Render [L, R] through fx in 128-frame blocks; hook(fx, frame) before each block. */
function run(fx, L, R = L, hook) {
  const n = L.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let f = 0; f < n; f += 128) {
    if (hook) hook(fx, f);
    const e = Math.min(n, f + 128);
    fx.process(L.subarray(f, e), R.subarray(f, e), oL.subarray(f, e), oR.subarray(f, e), e - f, f);
  }
  return [oL, oR];
}
const sine = (n, hz, amp = 0.5, sr = SR) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
/** Magnitude (dB, re full scale sine) at hz over x (Hann window, plain DFT at one bin). */
function level(x, hz, sr = SR) {
  let re = 0, im = 0, w = 0;
  for (let i = 0; i < x.length; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1));
    re += x[i] * h * Math.cos((2 * Math.PI * hz * i) / sr);
    im -= x[i] * h * Math.sin((2 * Math.PI * hz * i) / sr);
    w += h;
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / w + 1e-20);
}

test('catalog: Crunch after Gate in Add, nc-fx\'s own; Rate on a 4-44.1 kHz log law, Bits 4-16, Steps under More', () => {
  assert.deepEqual(CATALOG_MENU.slice(0, 7), ['delay', 'plate', 'hall', 'ensemble', 'gate', 'crunch', 'flanger']);
  const e = catalogEntry('crunch');
  assert.equal(e.own, true);
  assert.equal(e.label, 'Crunch');
  assert.deepEqual(e.dials.filter((d) => !d.more).map((d) => d.key), ['rate', 'bits']);
  assert.deepEqual(e.dials.filter((d) => d.more).map((d) => d.key), ['hold']);
  const rate = catalogDial('crunch', 'rate');
  assert.equal(lawValue(rate.dsp.law, 0), 4000);
  assert.equal(lawValue(rate.dsp.law, 100), 44100);
  assert.equal(formatDial(rate, 78, 120), '26.0 kHz');
  assert.equal(formatDial(rate, 100, 120), '44.1 kHz');
  assert.equal(formatDial(catalogDial('crunch', 'bits'), 12, 120), '12-bit');
  assert.equal(formatDial(catalogDial('crunch', 'hold'), 1, 120), 'Smooth');
  assert.match(toAstridHacks({ v: 2, chain: [newSlot('crunch')] }).lossy[0], /ASTRID has no Crunch/);
});

test('clean (44.1 kHz, 16-bit) is the input exactly, at 44.1 and 48 kHz', () => {
  for (const sr of [44100, 48000]) {
    const x = Float32Array.from({ length: sr / 4 }, (_, i) => 0.7 * Math.sin(i * 0.37) * Math.sin(i * 0.0011) + 1e-9 * i);
    const [l, r] = run(chain({ rate: 44100, bits: 16 }, sr), x);
    assert.ok(identical(l, x) && identical(r, x), `clean at ${sr}`);
  }
});

test('Rate 6 kHz with no filter: a 1 kHz sine folds to 5 kHz (and 7 kHz), as a converter with no anti-alias filter', () => {
  const x = sine(SR, 1000, 0.5);
  const [l] = run(chain({ rate: 6000, bits: 16 }), x);
  const y = l.subarray(SR / 4);
  const base = level(y, 1000), alias = level(y, 5000), other = level(y, 3000);
  // Zero-order hold: the image at fs - f is down by sinc(5/6) / sinc(1/6) = -14 dB from the tone.
  assert.ok(Math.abs(alias - base + 14) < 2, `5 kHz image ${alias - base} dB`);
  assert.ok(other < base - 60, `nothing at 3 kHz (${other - base} dB)`);
  // Smooth steps (first-order hold): the image is lower still.
  const [s] = run(chain({ rate: 6000, bits: 16, hold: 1 }), x);
  assert.ok(level(s.subarray(SR / 4), 5000) < alias - 8);
});

test('Bits: quantisation noise at the textbook level (6 dB a bit), no dither', () => {
  const x = sine(SR, 997, 0.9);
  for (const bits of [6, 8, 12]) {
    const [l] = run(chain({ rate: 44100, bits }), x);
    // Remove the tone (and the DC blocker's tiny phase) by least squares, then measure what is left.
    const a = SR / 2, n = SR / 2;
    let ss = 0, sc = 0, cc = 0, ys = 0, yc = 0;
    for (let i = a; i < a + n; i++) {
      const s = Math.sin((2 * Math.PI * 997 * i) / SR), c = Math.cos((2 * Math.PI * 997 * i) / SR);
      ss += s * s; cc += c * c; sc += s * c; ys += l[i] * s; yc += l[i] * c;
    }
    const det = ss * cc - sc * sc, A = (ys * cc - yc * sc) / det, B = (yc * ss - ys * sc) / det;
    let e = 0;
    for (let i = a; i < a + n; i++) {
      const d = l[i] - A * Math.sin((2 * Math.PI * 997 * i) / SR) - B * Math.cos((2 * Math.PI * 997 * i) / SR);
      e += d * d;
    }
    const noise = 10 * Math.log10(e / n);
    const q = 1 / 2 ** (bits - 1);
    const want = 10 * Math.log10((q * q) / 12);
    assert.ok(Math.abs(noise - want) < 1.5, `${bits}-bit noise ${noise.toFixed(1)} dB, want ${want.toFixed(1)}`);
  }
});

test('the DC blocker: under -100 dBFS of offset at 6 kHz / 4-bit, and a step of DC dies away', () => {
  const n = SR * 4;
  const x = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i * 0.05) * Math.exp(-((i % 24000) / 6000)) + 0.04);
  const [l] = run(chain({ rate: 6000, bits: 4 }), x);
  let m = 0;
  for (let i = n - SR; i < n; i++) m += l[i];
  const dc = 20 * Math.log10(Math.abs(m / SR) + 1e-20);
  assert.ok(dc < -100, `DC ${dc.toFixed(1)} dBFS`);
});

test('a Bits move crossfades over 5 ms: no step bigger than the new depth\'s own', () => {
  const x = sine(SR / 2, 110, 0.8);
  const steady = run(chain({ rate: 44100, bits: 4 }), x)[0];
  let bar = 0;
  for (let i = 1000; i < steady.length; i++) bar = Math.max(bar, Math.abs(steady[i] - steady[i - 1]));
  const at = 12800;
  const [l] = run(chain({ rate: 44100, bits: 10 }), x, undefined, (fx, f) => { if (f === at) fx.set(1, K.bits, 4, f); });
  let worst = 0;
  for (let i = at; i < at + 0.01 * SR; i++) worst = Math.max(worst, Math.abs(l[i] - l[i - 1]));
  assert.ok(worst <= bar * 1.001, `worst step ${worst} vs ${bar}`);
  // and the fade takes 5 ms: before 5 ms it is between the two, after it the new depth.
  const four = run(chain({ rate: 44100, bits: 4 }), x)[0];
  const ten = run(chain({ rate: 44100, bits: 10 }), x)[0];
  const mid = at + 0.0025 * SR;
  assert.ok(Math.abs(l[mid] - four[mid]) > 1e-4 && Math.abs(l[mid] - ten[mid]) > 1e-4);
  const after = at + Math.ceil(0.0052 * SR);
  assert.ok(Math.abs(l[after] - four[after]) < 1e-3);
});

test('a Rate move carries the held value on (no jump); clean -> crunched glides in over 5 ms', () => {
  const x = sine(SR / 2, 220, 0.6);
  const at = 6400;
  const [l] = run(chain({ rate: 12000, bits: 16 }), x, undefined, (fx, f) => { if (f === at) fx.set(1, K.rate, 5000, f); });
  let bar = 0;
  const ref = run(chain({ rate: 5000, bits: 16 }), x)[0];
  for (let i = 2000; i < ref.length; i++) bar = Math.max(bar, Math.abs(ref[i] - ref[i - 1]));
  let worst = 0;
  for (let i = at - 10; i < at + 400; i++) worst = Math.max(worst, Math.abs(l[i] - l[i - 1]));
  assert.ok(worst <= bar * 1.01, `rate move ${worst} vs ${bar}`);
  // Clean, then Bits to 6 at `at`: the first frames after the move are mostly the input.
  const [g] = run(chain({ rate: 44100, bits: 16 }), x, undefined, (fx, f) => { if (f === at) fx.set(1, K.bits, 6, f); });
  assert.ok(identical(g.subarray(0, at), x.subarray(0, at)));
  const six = run(chain({ rate: 44100, bits: 6 }), x)[0];
  const early = at + 10;
  assert.ok(Math.abs(g[early] - x[early]) < Math.abs(six[early] - x[early]) + 1e-9);
});

test('Steps: Smooth draws a straight line between held values (one converter period late); Hard holds', () => {
  const slope = 0.5 / 4800;
  const x = Float32Array.from({ length: 4800 }, (_, i) => i * slope - 0.25);
  const jump = (hold) => {
    const [l] = run(chain({ rate: 4800, bits: 16, hold }), x);
    let m = 0;
    for (let i = 1000; i < 4000; i++) m = Math.max(m, Math.abs(l[i] - l[i - 1]));
    return m / slope;
  };
  // 4.8 kHz at 48 kHz: a period is 10 frames. Hard: one 10-frame step a period; Smooth: the ramp's own slope.
  assert.ok(Math.abs(jump(0) - 10) < 0.5, `hard ${jump(0)}`);
  assert.ok(jump(1) < 2, `smooth ${jump(1)}`); // (a period of 10 or 11 frames as the phase adds up: a little over the slope)
});
