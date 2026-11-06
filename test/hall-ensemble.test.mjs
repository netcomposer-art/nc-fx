// Hall and Ensemble (nc-fx's own effects, Peter's mockup 2026-11-05): catalog (dials, defaults, readouts, the Add
// menu), parameter ranges, the sound (pre-delay, decay per band, density, no ringing, stereo, level at the default
// mix, peaks, no NaN), bypass ('hold' always: asleep costs nothing, back on starts from silence), voices 3 / 6 without
// a click, save / load, and ASTRID never gets them. Allocation and denormals: alloc-slots and denormal-slots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import source from '../dist/worklet-source.js';
import { createFxChainDsp } from '../src/chain.js';
import { CATALOG, CATALOG_MENU, catalogEntry, catalogDial, formatDial, dialDsp } from '../src/catalog.js';
import { newSlot, slotProgram, sanitizeSlots, toAstridHacks, toAstridDocument } from '../src/slots.js';
import { createFxCore } from '../src/index.js';
import { UNIT, UNIT_NPARAMS, createFxEnv, createUnit } from '../src/units.js';
import { PLUGIN_BASE } from '../src/plugin-host.js';
import { mockContext } from './mock-audio.mjs';

const SR = 48000;
const db = (x) => 20 * Math.log10(x);

/** Render [L, R] through one effect (dials in UI units over its defaults); on = false: bypassed. */
function render([L, R], type, dials = {}, on = true, opts = {}) {
  const fx = createFxChainDsp(SR, { limiter: 'off', ...opts });
  const s = newSlot(type);
  Object.assign(s.dials, dials);
  s.bypass = !on;
  fx.add(1, type, 0);
  for (const [k, v] of slotProgram(s)) fx.set(1, k, v, 0, true);
  fx.order([1], 0, true);
  const n = L.length, OL = new Float32Array(n), OR = new Float32Array(n);
  const a = new Float32Array(128), b = new Float32Array(128), c = new Float32Array(128), d = new Float32Array(128);
  for (let f = 0; f < n; f += 128) {
    const m = Math.min(128, n - f);
    a.fill(0); b.fill(0); a.set(L.subarray(f, f + m)); b.set(R.subarray(f, f + m));
    fx.process(a, b, c, d, 128, f);
    OL.set(c.subarray(0, m), f); OR.set(d.subarray(0, m), f);
  }
  return [OL, OR];
}
const rms = ([L, R], a = 0, b = L.length) => { let s = 0; for (let i = a; i < b; i++) s += L[i] * L[i] + R[i] * R[i]; return Math.sqrt(s / (2 * (b - a))); };
const peak = ([L, R]) => { let p = 0; for (let i = 0; i < L.length; i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i])); return p; };
/** A pad chord: detuned saws (A minor 9), soft low-pass, slow attack, deterministic. */
function pad(seconds) {
  const n = Math.round(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  const fs = [45, 52, 55, 60, 71].flatMap((m) => [-0.07, 0.07].map((d) => 440 * 2 ** ((m - 69 + d) / 12)));
  const ph = fs.map((_, i) => (i * 0.137) % 1);
  let l = 0, r = 0;
  const a = 1 - Math.exp(-2 * Math.PI * 2600 / SR);
  for (let i = 0; i < n; i++) {
    let sl = 0, sr = 0;
    fs.forEach((f, j) => { ph[j] = (ph[j] + f / SR) % 1; const s = 2 * ph[j] - 1; if (j & 1) sr += s; else sl += s; });
    l += a * (sl - l); r += a * (sr - r);
    const env = Math.min(1, i / (0.35 * SR));
    L[i] = l * env * 0.1; R[i] = r * env * 0.1;
  }
  return [L, R];
}
function noise(seconds, level = 0.1, seed = 5) {
  const n = Math.round(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2147483648 - 1; };
  for (let i = 0; i < n; i++) { L[i] = rnd() * level; R[i] = rnd() * level; }
  return [L, R];
}
function impulse(seconds) {
  const n = Math.round(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  L[0] = 1; R[0] = 1;
  return [L, R];
}
/** T60 by Schroeder integration (T20 x 3) of the response through an RBJ band-pass at fc (Q 1.4). */
function bandT60([L, R], fc) {
  const n = L.length, w = 2 * Math.PI * fc / SR, al = Math.sin(w) / 2.8, a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) { const x = L[i] + R[i]; const y = (al * x - al * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; e[i] = y * y; }
  for (let i = n - 2; i >= 0; i--) e[i] += e[i + 1];
  const at = (d) => { for (let i = 0; i < n; i++) if (10 * Math.log10(e[i] / e[0]) <= d) return i / SR; return NaN; };
  return (at(-25) - at(-5)) * 3;
}

test('catalog: Hall and Ensemble as mocked (dials, defaults, readouts), after Reverb in Add, nc-fx\'s own', () => {
  assert.deepEqual(CATALOG_MENU.slice(0, 5), ['delay', 'plate', 'hall', 'ensemble', 'flanger']);
  const hall = catalogEntry('hall'), ens = catalogEntry('ensemble');
  assert.equal(hall.label, 'Hall'); assert.equal(ens.label, 'Ensemble');
  assert.ok(hall.own && ens.own && !hall.hidden && !ens.hidden);
  const shown = (e) => e.dials.filter((d) => !d.more).map((d) => [d.label, formatDial(d, d.default, 120)]);
  const more = (e) => e.dials.filter((d) => d.more).map((d) => [d.label, formatDial(d, d.default, 120)]);
  assert.deepEqual(shown(hall), [['Size', '60%'], ['Decay', '3.5 s'], ['Pre-delay', '20 ms'], ['Tone', '7.0 kHz'], ['Mix', '25% wet']]);
  assert.deepEqual(more(hall), [['Low cut', '120 Hz'], ['Width', '100%'], ['Motion', '30%']]);
  assert.deepEqual(shown(ens), [['Rate', '0.32 Hz'], ['Depth', '60%'], ['Width', '80%'], ['Mix', '50% wet']]);
  assert.deepEqual(more(ens), [['Voices', '3'], ['Vibrato', '20%']]);
  // Ranges as specified: Decay 0.5-12 s, Pre-delay 0-250 ms, Tone shown as a frequency.
  const dec = catalogDial('hall', 'decay'), pre = catalogDial('hall', 'predelay'), tone = catalogDial('hall', 'tone');
  assert.deepEqual([formatDial(dec, dec.min), formatDial(dec, dec.max)], ['0.5 s', '12.0 s']);
  assert.deepEqual([dialDsp(dec, dec.min), dialDsp(dec, dec.max)], [0.5, 12]);
  assert.deepEqual([formatDial(pre, 0), formatDial(pre, 250), dialDsp(pre, 250)], ['0 ms', '250 ms', 0.25]);
  assert.deepEqual([formatDial(tone, 0), formatDial(tone, 100)], ['1.5 kHz', '19 kHz']);
  assert.equal(formatDial(catalogDial('hall', 'low_cut'), 0), 'off');
  assert.deepEqual(catalogDial('ensemble', 'voices').options.map((o) => o.value), [3, 6]);
  for (const e of [hall, ens]) assert.equal(UNIT_NPARAMS[UNIT[e.type]], e.dials.length + 1);
  assert.ok(PLUGIN_BASE >= 14, 'plugin codes start after the built-in units');
});

test('parameter ranges: every dial clamps to its unit\'s range; NaN is refused', () => {
  const E = createFxEnv(SR, {});
  const cases = {
    hall: [[1, -1, 0], [1, 2, 1], [2, 0, 0.5], [2, 99, 12], [3, -1, 0], [3, 1, 0.25], [4, 10, 1000], [4, 1e6, 20000], [5, 2, 1], [6, -5, 0], [6, 5000, 1000], [7, 3, 1], [8, -2, 0]],
    ensemble: [[1, 0, 0.01], [1, 99, 20], [2, 5, 1], [3, -1, 0], [4, 7, 1], [5, 4, 3], [5, 5, 6], [5, 99, 6], [6, 9, 1]],
  };
  for (const [type, list] of Object.entries(cases)) {
    const u = createUnit(E, UNIT[type]);
    for (const [k, v, want] of list) { E.V[0] = v; assert.equal(u.set(k, true), true, `${type} k${k}`); assert.equal(E.V[0], want, `${type} k${k} ${v}`); }
    E.V[0] = Number.NaN;
    assert.equal(u.set(1, true), false, `${type}: NaN refused`);
    assert.equal(u.set(99, true), false, `${type}: unknown param`);
  }
});

test('Hall: pre-delay onset, decay per band, dense and smooth, decorrelated stereo, never NaN', () => {
  for (const [pre, want] of [[0, 0], [20, 20], [250, 250]]) {
    const [L, R] = render(impulse(0.6), 'hall', { mix: 100, predelay: pre });
    let on = -1;
    for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 1e-4 || Math.abs(R[i]) > 1e-4) { on = (i / SR) * 1000; break; }
    assert.ok(Math.abs(on - want) <= 1, `pre-delay ${pre} ms: wet starts at ${on} ms`);
  }
  // Decay is the mid-band T60 (500 Hz) within 15%; lows ring a little longer, highs die sooner (Tone).
  for (const decay of [10, 35, 120]) {
    const ir = render(impulse(decay / 10 * 1.4 + 1), 'hall', { mix: 100, decay, low_cut: 0 });
    const t500 = bandT60(ir, 500), t4k = bandT60(ir, 4000), t125 = bandT60(ir, 125);
    assert.ok(Math.abs(t500 / (decay / 10) - 1) < 0.15, `Decay ${decay / 10} s: T60 at 500 Hz ${t500.toFixed(2)} s`);
    assert.ok(t4k < t500 && t125 >= t500 * 0.95 && t125 <= 2.1 * decay / 10, `bands: 125 Hz ${t125.toFixed(2)}, 4 kHz ${t4k.toFixed(2)}`);
  }
  // Density: 50-150 ms after the onset, samples beyond one standard deviation are near a Gaussian's share (Abel & Huang).
  const [L, R] = render(impulse(3.5), 'hall', { mix: 100 });
  const s0 = Math.round(0.07 * SR), s1 = Math.round(0.17 * SR);
  let m2 = 0, over = 0;
  for (let i = s0; i < s1; i++) m2 += L[i] * L[i];
  const sd = Math.sqrt(m2 / (s1 - s0));
  for (let i = s0; i < s1; i++) if (Math.abs(L[i]) > sd) over++;
  assert.ok(over / (s1 - s0) / 0.3173 > 0.65, `echo density ${(over / (s1 - s0) / 0.3173).toFixed(2)}`);
  // Stereo: the two sides of the tail are nearly uncorrelated at full width, and identical at width 0.
  let c = 0, pl = 0, pr = 0;
  for (let i = s0; i < 3 * SR; i++) { c += L[i] * R[i]; pl += L[i] * L[i]; pr += R[i] * R[i]; }
  assert.ok(Math.abs(c / Math.sqrt(pl * pr)) < 0.15, `L/R correlation ${(c / Math.sqrt(pl * pr)).toFixed(2)}`);
  const [ml, mr] = render(impulse(1), 'hall', { mix: 100, width: 0 });
  for (let i = 0; i < ml.length; i += 97) assert.ok(Math.abs(ml[i] - mr[i]) < 1e-7);
  for (const x of [L, R]) for (let i = 0; i < x.length; i++) assert.ok(Number.isFinite(x[i]));
});

test('Hall: no metallic ringing: the tail\'s spectrum has no narrow peak far above its neighbours (any size, motion on)', () => {
  // A 16384-point DFT of the tail (0.4-0.74 s) at 200 Hz-6 kHz; each bin against the median of the 129 around it.
  // Noise alone reaches about 11 dB this way; a ringing mode stands 25 dB or more above its neighbours.
  const N = 16384;
  for (const size of [0, 60, 100]) {
    const [L] = render(impulse(0.8), 'hall', { mix: 100, size, low_cut: 0 });
    const a = Math.round(0.4 * SR), P = [];
    const k0 = Math.round(200 / SR * N), k1 = Math.round(6000 / SR * N);
    for (let k = k0 - 64; k < k1 + 65; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < N; i += 1) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N), x = L[a + i] * w, ph = 2 * Math.PI * k * i / N; re += x * Math.cos(ph); im -= x * Math.sin(ph); }
      P.push(re * re + im * im);
    }
    let worst = 0;
    for (let j = 64; j < P.length - 64; j++) { const win = P.slice(j - 64, j + 65).sort((x, y) => x - y); worst = Math.max(worst, 10 * Math.log10(P[j] / win[64])); }
    assert.ok(worst < 24, `size ${size}%: the tail's strongest peak stands ${worst.toFixed(1)} dB above its neighbours`);
  }
});

test('levels: engaging at the default mix moves the level less than 1 dB; peaks stay safe', () => {
  for (const [type, src, name] of [['hall', pad(7), 'pad'], ['hall', noise(7, 0.1), 'noise'], ['ensemble', pad(7), 'pad'], ['ensemble', noise(7, 0.1), 'noise']]) {
    const dry = render(src, type, {}, false), wet = render(src, type, {}, true);
    const jump = db(rms(wet, 2 * SR, 6.5 * SR)) - db(rms(dry, 2 * SR, 6.5 * SR));
    assert.ok(Math.abs(jump) < 1, `${type} on ${name} at its default mix: ${jump.toFixed(2)} dB`);
    // Peaks: on the pad (uniform test noise has no crest factor to keep; any reverb turns it Gaussian).
    if (name === 'pad') assert.ok(peak(wet) < peak(dry) * 1.26, `${type} on ${name}: peak ${db(peak(wet)).toFixed(1)} vs dry ${db(peak(dry)).toFixed(1)} dBFS`);
  }
  // The hall at its longest, biggest, fully wet, on a sustained pad: within 3 dB of the dry and under full scale.
  const src = pad(14), w = render(src, 'hall', { mix: 100, decay: 120, size: 100, low_cut: 0 });
  assert.ok(db(rms(w, 8 * SR, 13 * SR)) - db(rms(src, 8 * SR, 13 * SR)) < 3);
  assert.ok(peak(w) < 1);
});

test('Ensemble: the swept voices move (a chorus, not a fixed comb), 3 or 6 voices, width, no NaN', () => {
  // A steady sine through it fully wet: the level wobbles with the slow sweep (beating between voices).
  const n = 6 * SR, s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR);
  const [L, R] = render([s, s], 'ensemble', { mix: 100 });
  const env = [];
  for (let b = SR; b + 2400 <= n; b += 2400) env.push(rms([L.subarray(b, b + 2400), R.subarray(b, b + 2400)]));
  const spread = db(Math.max(...env)) - db(Math.min(...env));
  assert.ok(spread > 1, `wet level moves with the sweep (${spread.toFixed(1)} dB)`);
  let d = 0;
  for (let i = SR; i < n; i++) d += Math.abs(L[i] - R[i]);
  assert.ok(d / (n - SR) > 0.01, 'left and right differ at width 80%');
  const [ml, mr] = render([s, s], 'ensemble', { mix: 100, width: 0 });
  for (let i = 0; i < n; i += 101) assert.ok(Math.abs(ml[i] - mr[i]) < 1e-6, 'width 0 is mono');
  const six = render([s, s], 'ensemble', { mix: 100, voices: 6 });
  assert.ok(Math.abs(db(rms(six, SR, n)) - db(rms([L, R], SR, n))) < 1.5, 'six voices keep about the level of three');
  for (const x of [L, R, six[0], six[1]]) for (let i = 0; i < x.length; i++) assert.ok(Number.isFinite(x[i]));
});

test('Ensemble: switching 3 -> 6 voices while playing glides (no click)', () => {
  const fx = createFxChainDsp(SR, { limiter: 'off' });
  const sl = newSlot('ensemble');
  fx.add(1, 'ensemble', 0);
  for (const [k, v] of slotProgram(sl)) fx.set(1, k, v, 0, true);
  fx.order([1], 0, true);
  const a = new Float32Array(128), b = new Float32Array(128), c = new Float32Array(128), d = new Float32Array(128);
  let prev = 0, worst = 0, f = 0;
  const vk = catalogDial('ensemble', 'voices').k;
  for (let k = 0; k < 600; k++) {
    if (k === 300) fx.set(1, vk, 6, f);
    for (let i = 0; i < 128; i++) { a[i] = 0.3 * Math.sin(2 * Math.PI * 220 * (f + i) / SR); b[i] = a[i]; }
    fx.process(a, b, c, d, 128, f);
    for (let i = 0; i < 128; i++) { if (k > 10) worst = Math.max(worst, Math.abs(c[i] - prev)); prev = c[i]; }
    f += 128;
  }
  // A 220 Hz sine at 0.3 moves at most 2 * pi * 220 / 48000 * 0.3 * (gains) per sample: a click would jump far beyond.
  assert.ok(worst < 0.03, `largest sample step ${worst.toFixed(4)}`);
});

test('bypass: fully off, each sleeps (output = input, almost no CPU) and comes back from silence', () => {
  for (const type of ['hall', 'ensemble']) {
    // A hit, then bypass while the tail rings (the chain in 'run' mode: these sleep anyway), then back on in silence.
    const fx = createFxChainDsp(SR, { limiter: 'off', bypassMode: 'run' });
    const sl = newSlot(type);
    fx.add(1, type, 0);
    for (const [k, v] of slotProgram(sl)) fx.set(1, k, v, 0, true);
    fx.set(1, catalogDial(type, 'mix').k, 1, 0, true);
    fx.order([1], 0, true);
    const a = new Float32Array(128), b = new Float32Array(128), c = new Float32Array(128), d = new Float32Array(128);
    let f = 0;
    const blk = (fill) => { for (let i = 0; i < 128; i++) { a[i] = fill(f + i); b[i] = a[i]; } fx.process(a, b, c, d, 128, f); f += 128; };
    blk((i) => (i < 64 ? 0.8 : 0));
    for (let k = 0; k < 20; k++) blk(() => 0);
    fx.set(1, 0, 0, f);
    for (let k = 0; k < 200; k++) blk(() => 0);
    // Asleep: the input passes untouched.
    blk((i) => 0.25 * Math.sin(i * 0.01));
    for (let i = 0; i < 128; i++) assert.equal(c[i], a[i], `${type} asleep: output = input`);
    // Asleep costs next to nothing: time 2000 blocks asleep vs the same engine with nothing in it.
    const empty = createFxChainDsp(SR, { limiter: 'off' });
    const t = (eng) => { const s = process.hrtime.bigint(); for (let k = 0; k < 2000; k++) eng.process(a, b, c, d, 128, f); return Number(process.hrtime.bigint() - s) / 2000 / 1e3; };
    t(fx); t(empty);
    const asleep = Math.min(t(fx), t(fx)), none = Math.min(t(empty), t(empty));
    assert.ok(asleep < none + 6, `${type} asleep ${asleep.toFixed(1)} µs/block vs empty ${none.toFixed(1)}`);
    // Back on in silence: the old tail is gone (cleared while asleep).
    fx.set(1, 0, 1, f);
    let tail = 0;
    for (let k = 0; k < 20; k++) { blk(() => 0); for (let i = 0; i < 128; i++) tail = Math.max(tail, Math.abs(c[i])); }
    assert.equal(tail, 0, `${type}: switched back on, no old tail (${tail})`);
  }
});

test('save / load: slots with Hall and Ensemble round-trip, bad values clamp, older saves are untouched', async () => {
  const state = [
    { id: 'hall-1', type: 'hall', bypass: false, dials: { size: 80, decay: 90, predelay: 40, tone: 45, mix: 30, low_cut: 200, width: 70, motion: 50 } },
    { id: 'ensemble-1', type: 'ensemble', bypass: true, dials: { rate: 20, depth: 70, width: 100, mix: 40, voices: 6, vibrato: 10 } },
  ];
  const s = sanitizeSlots(state, 8);
  assert.deepEqual(s.chain, state);
  assert.deepEqual(sanitizeSlots(JSON.parse(JSON.stringify(s)), 8), s);
  const bad = sanitizeSlots([{ id: 'hall-1', type: 'hall', dials: { decay: 999, predelay: -5, voices: 5 } }, { type: 'ensemble', dials: { voices: 5 } }], 8);
  assert.equal(bad.chain[0].dials.decay, 120);
  assert.equal(bad.chain[0].dials.predelay, 0);
  assert.ok([3, 6].includes(bad.chain[1].dials.voices));
  const fresh = newSlot('hall');
  assert.deepEqual(fresh.dials, { size: 60, decay: 35, predelay: 20, tone: 60, mix: 25, low_cut: 120, width: 100, motion: 30 });
  // Through the core: set, get, set again.
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', slots: true, state });
  await fx.ready;
  assert.deepEqual(fx.getState().chain, state);
  const id = fx.addEffect('ensemble');
  fx.setParam(id, 'voices', 6);
  assert.equal(fx.getState().chain.at(-1).dials.voices, 6);
  // ASTRID has neither: its saves leave them out and say so.
  const astrid = toAstridHacks(s);
  assert.deepEqual(astrid.hacks, []);
  assert.deepEqual(astrid.lossy, ['hall-1: ASTRID has no Hall', 'ensemble-1: ASTRID has no Ensemble']);
  assert.deepEqual(toAstridDocument(s, 120).chain.map((h) => h.type), ['limiter']);
  // An older save (no Hall, no Ensemble) loads exactly as before.
  const old = [{ id: 'plate-1', type: 'plate', bypass: false, dials: { predelay: 10, size: 50, decay: 50, damping: 0, mix: 30 } }];
  assert.deepEqual(sanitizeSlots(old, 8).chain, old);
});

test('the shipped worklet (dist) runs Hall and Ensemble: its catalog codes match', () => {
  const reg = {};
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage() {} }; } }
  const scope = vm.createContext({ AudioWorkletProcessor, sampleRate: SR, currentFrame: 0, registerProcessor: (n, c) => { reg[n] = c; } });
  vm.runInContext(source, scope);
  assert.ok(reg['nc-fx@1']);
  assert.ok(source.includes('function unitHall') && source.includes('function unitEnsemble'));
  for (const e of CATALOG.filter((x) => x.own)) assert.ok(source.includes(`'${e.type}'`), e.type);
});
