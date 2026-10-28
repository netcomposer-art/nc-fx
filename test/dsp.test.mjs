import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FX_PARAM as P, FX_NPARAMS, createFxDsp } from '../src/dsp.js';
import { compile, defaultState } from '../src/params.js';
import { SR, noiseBursts, renderDsp, identical, rmsDiff, engine } from './helpers.mjs';

const N = SR; // 1 s
const [inL, inR] = noiseBursts(N);
const PURE = {}; // the defaults: limiter off, pre-gain 1
function prog(edit) { const s = defaultState(); edit(s); return compile(s); }
const ON = {
  drive: (s) => { s.chain[0].bypass = false; s.chain[0].dials.drive_db = 18; },
  delay: (s) => { s.chain[1].bypass = false; s.chain[1].dials.mix = 50; s.chain[1].dials.feedback = 40; },
  plate: (s) => { s.chain[2].bypass = false; s.chain[2].dials.mix = 40; },
};

for (const mode of ['hold', 'run']) {
  test(`${mode}: all bypassed with default options is bit-identical to the input (exact unity)`, () => {
    const [oL, oR] = renderDsp(engine(compile(defaultState()), { ...PURE, bypassMode: mode }), inL, inR);
    assert.ok(identical(oL, inL) && identical(oR, inR));
  });
  for (const type of Object.keys(ON)) {
    test(`${mode}: ${type} changes the signal; bypassing it is bit-identical to the input`, () => {
      const [oL] = renderDsp(engine(prog(ON[type]), { ...PURE, bypassMode: mode }), inL, inR);
      assert.ok(rmsDiff(oL, inL) > 1e-3, `${type} rms diff ${rmsDiff(oL, inL)}`);
      const [bL, bR] = renderDsp(engine(prog((s) => { ON[type](s); s.chain.find((c) => c.type === type).bypass = true; }), { ...PURE, bypassMode: mode }), inL, inR);
      assert.ok(identical(bL, inL) && identical(bR, inR));
    });
  }
  test(`${mode}: bypassing an effect mid-stream fades out, then is bit-identical again`, () => {
    const fx = engine(prog((s) => { ON.drive(s); ON.delay(s); ON.plate(s); }), { ...PURE, bypassMode: mode });
    const half = N / 2;
    const a = renderDsp(fx, inL.subarray(0, half), inR.subarray(0, half));
    for (const i of [P.DRIVE_ON, P.DELAY_ON, P.PLATE_ON]) fx.set(i, 0);
    const [bL] = renderDsp(fx, inL.subarray(half), inR.subarray(half));
    assert.ok(a[0].some((v, i) => v !== inL[i]));
    const settle = Math.round(0.25 * SR); // 20 ms one-pole down to 0.001 takes ~140 ms
    assert.ok(identical(bL.subarray(settle), inL.subarray(half + settle)));
  });
}

test('default bypass is run: a bypassed delay keeps its tail ringing (ASTRID)', () => {
  const imp = new Float32Array(SR); imp[0] = 1;
  const fx = engine(prog((s) => { s.chain[1].bypass = false; s.chain[1].dials.mix = 100; s.chain[1].dials.feedback = 80; }));
  renderDsp(fx, imp.subarray(0, 4800), null);
  fx.set(P.DELAY_ON, 0);
  renderDsp(fx, new Float32Array(SR / 2), null);
  fx.set(P.DELAY_ON, 1);
  const [o] = renderDsp(fx, new Float32Array(SR), null);
  assert.ok(o.reduce((a, v) => a + v * v, 0) > 1e-4);
});

test('hold: a bypassed effect drops its tail; run keeps it (ASTRID)', () => {
  const imp = new Float32Array(SR), z = new Float32Array(SR); imp[0] = 1;
  const p = prog((s) => { s.chain[1].bypass = false; s.chain[1].dials.mix = 100; s.chain[1].dials.feedback = 80; });
  for (const mode of ['hold', 'run']) {
    const fx = engine(p, { ...PURE, bypassMode: mode });
    renderDsp(fx, imp.subarray(0, 4800), null);
    fx.set(P.DELAY_ON, 0);
    renderDsp(fx, z.subarray(0, SR / 2), null); // asleep long enough to clear
    fx.set(P.DELAY_ON, 1);
    const [o] = renderDsp(fx, z, null);
    const energy = o.reduce((a, v) => a + v * v, 0);
    if (mode === 'hold') assert.equal(energy, 0); else assert.ok(energy > 1e-4);
  }
});

test('delay is tempo-synced: a 1/8 dotted echo lands at 0.375 s at 120 BPM, 0.25 s at 180', () => {
  for (const [bpm, at] of [[120, 0.375], [180, 0.25]]) {
    const fx = engine(prog((s) => { s.chain[1].bypass = false; s.chain[1].dials.mix = 100; s.chain[1].dials.feedback = 0; }), PURE);
    fx.setTempo(bpm, 0, true);
    const imp = new Float32Array(SR); imp[0] = 1;
    const [o] = renderDsp(fx, imp, null);
    let best = 0; for (let i = 1; i < SR; i++) if (Math.abs(o[i]) > Math.abs(o[best])) best = i;
    assert.ok(Math.abs(best - at * SR) <= 1, `${bpm} BPM echo at ${best}, want ${at * SR}`);
  }
});

test('tempo changes and parameter changes land on their frame (sample-accurate)', () => {
  const p = prog((s) => { s.chain[0].bypass = false; s.chain[0].dials.output_db = 0; });
  const a = engine(p, PURE), b = engine(p, PURE);
  const ones = new Float32Array(1024).fill(0.25);
  b.set(P.DRIVE_OUT_DB, -12, 300, true);
  const [oa] = renderDsp(a, ones, null), [ob] = renderDsp(b, ones, null);
  assert.ok(identical(oa.subarray(0, 300), ob.subarray(0, 300)));
  assert.ok(oa[300] !== ob[300]);
  assert.equal(b.getTempo(), 120);
  b.setTempo(90, 1024 + 5);
  renderDsp(b, ones.subarray(0, 5), null); assert.equal(b.getTempo(), 120);
  renderDsp(b, ones.subarray(0, 1), null); assert.equal(b.getTempo(), 90);
});

test('defaults are transparent: no limiter, unity pre-gain, no latency', () => {
  const loud = new Float32Array(4096).map((_, i) => 3 * Math.sin(i * 0.05));
  const fx = engine(compile(defaultState()));
  assert.equal(fx.latencySamples, 0);
  const [o] = renderDsp(fx, loud, null);
  assert.ok(identical(o, loud));
});

test('the lookahead limiter holds the -1 dB ceiling and reports 1.5 ms latency; soft has none', () => {
  const loud = new Float32Array(SR).map((_, i) => 3 * Math.sin(i * 0.05));
  const fx = engine(compile(defaultState()), { limiter: 'lookahead', preGain: 1 });
  assert.equal(fx.latencySamples, 72);
  const [o] = renderDsp(fx, loud, null);
  assert.ok(Math.max(...o.map(Math.abs)) <= 0.8912509381337456 + 1e-6);
  assert.ok(fx.takeGainReduction() < 0.5);
  const soft = engine(compile(defaultState()), { limiter: 'soft', preGain: 1 });
  assert.equal(soft.latencySamples, 0);
  const [s] = renderDsp(soft, loud, null);
  assert.ok(Math.max(...s.map(Math.abs)) <= 0.8912509381337456 + 1e-6);
});

test('bad input is silenced, not spread: NaN and Infinity in, finite out', () => {
  const fx = engine(prog((s) => { ON.delay(s); ON.plate(s); }));
  const x = new Float32Array(2048).fill(0.1); x[10] = NaN; x[20] = Infinity; x[30] = -Infinity;
  const [o] = renderDsp(fx, x, null);
  assert.ok(o.every(Number.isFinite));
});

test('mono in, mono out, and odd block sizes give the same samples as 128-frame blocks', () => {
  const p = prog((s) => { ON.drive(s); ON.delay(s); ON.plate(s); });
  const [a] = renderDsp(engine(p), inL, inR, 128);
  const [b] = renderDsp(engine(p), inL, inR, 77);
  assert.ok(identical(a, b));
  const fx = engine(p), o = new Float32Array(256);
  fx.process(inL.subarray(0, 256), null, o, null, 256);
  assert.ok(o.some((v) => v !== 0));
});

test('clear() drops every tail; get() reports applied values; bad values are ignored', () => {
  const fx = engine(prog((s) => { ON.delay(s); ON.plate(s); }), PURE);
  renderDsp(fx, inL.subarray(0, 4096), inR.subarray(0, 4096));
  fx.clear();
  const [o] = renderDsp(fx, new Float32Array(4096), null);
  assert.ok(o.every((v) => v === 0));
  fx.set(P.DELAY_FEEDBACK, 5); assert.equal(fx.get(P.DELAY_FEEDBACK), 0.9);
  fx.set(P.DELAY_FEEDBACK, NaN); assert.equal(fx.get(P.DELAY_FEEDBACK), 0.9);
  fx.set(99, 1); fx.set(-5, 1);
  assert.equal(FX_NPARAMS, 18);
});

// ---- Review fixes (Zeta, Petra)
const DELAY_ONLY = () => prog((s) => { s.chain[1].bypass = false; s.chain[1].dials.mix = 50; s.chain[1].dials.feedback = 60; });
function tailEnergy(fx, blocks) { const z = new Float32Array(128), oL = new Float32Array(128); let e = 0; for (let b = 0; b < blocks; b++) { fx.process(z, z, oL, null, 128); for (const x of oL) e += x * x; } return e; }

test('frames more than 600 s ahead are refused (false), so epoch seconds as audio time can\'t queue', () => {
  const fx = engine(compile(defaultState()));
  assert.equal(fx.setTempo(90, 1793171004.86 * SR), false);
  assert.equal(fx.set(P.DELAY_MIX, 0.9, 601 * SR), false);
  assert.equal(fx.set(P.DELAY_MIX, 0.9, 599 * SR), true);
  renderDsp(fx, new Float32Array(1280), null);
  assert.equal(fx.getTempo(), 120);
});

test('a full queue applies its earliest events early instead of dropping any', () => {
  const fx = engine(compile(defaultState()));
  for (let k = 0; k < 300; k++) assert.equal(fx.setTempo(100 + k * 0.1, 1000 + k), true);
  assert.equal(fx.getTempo(), 100 + 43 * 0.1); // 256 queued, the 44 earliest applied early
  renderDsp(fx, new Float32Array(1408), null);
  assert.equal(fx.getTempo(), 100 + 299 * 0.1);
});

test('load() skips values that are already scheduled, unless snap', () => {
  const fx = engine(compile(defaultState()));
  const p = compile(defaultState()); p[P.DELAY_MIX] = 0.7;
  fx.set(P.DELAY_MIX, 0.2, 5000);
  fx.load(p, 1000);                 // 0.7 at 1000 is older than the 0.2 at 5000: still queued, 0.2 wins
  renderDsp(fx, new Float32Array(6400), null);
  assert.equal(fx.get(P.DELAY_MIX), 0.2);
  fx.load(p); assert.equal(fx.get(P.DELAY_MIX), 0.7);
});

test('clear() with the lookahead limiter keeps the dry signal (no 72-sample hole)', () => {
  const fx = engine(compile(defaultState()), { limiter: 'lookahead' });
  const x = new Float32Array(4800).fill(0.25), oL = new Float32Array(128);
  let zeros = 0;
  for (let o = 0; o < x.length; o += 128) { if (o === 2560) fx.clear(); fx.process(x.subarray(o, o + 128), null, oL, null, 128); if (o >= 1280) for (const v of oL) if (v === 0) zeros++; }
  assert.equal(zeros, 0);
});

test('clear(frame, fadeMs) fades the tail out and back in without a step; instant clear still drops it', () => {
  const run = (fade) => {
    const fx = engine(DELAY_ONLY());
    const [nl, nr] = noiseBursts(19200); // 0.4 s: the first echo (0.375-0.4375 s) is sounding
    renderDsp(fx, nl, nr);
    if (fade >= 0) fx.clear(undefined, fade);
    const z = new Float32Array(128), oL = new Float32Array(128), out = [];
    for (let b = 0; b < 200; b++) { fx.process(z, z, oL, null, 128); out.push(...oL); }
    return { out, after: tailEnergy(fx, 100) };
  };
  const ref = run(-1), inst = run(0), fade = run(5);
  assert.ok(ref.after > 0);
  assert.equal(inst.after, 0);
  assert.ok(inst.out.every((v) => v === 0));
  assert.equal(fade.after, 0);
  let err = 0; // 5 ms = 240 samples: the wet ramps linearly to 0
  for (let i = 0; i < 240; i++) err = Math.max(err, Math.abs(fade.out[i] - ref.out[i] * (1 - (i + 1) / 240)));
  assert.ok(err < 1e-6, `ramp error ${err}`);
  assert.ok(Math.abs(fade.out[0]) > 0.05, 'the fade starts from the tail');
  assert.ok(fade.out.slice(240).every((v) => v === 0), 'silent once faded');
});

test('maxDelaySeconds sizes the delay line and caps the delay time', () => {
  const echoAt = (opts, beats, bpm) => {
    const fx = createFxDsp(SR, opts);
    const p = DELAY_ONLY(); p[P.DELAY_BEATS] = beats; p[P.DELAY_FEEDBACK] = 0;
    fx.setTempo(bpm, 0, true); fx.load(p, 0, true);
    const x = new Float32Array(SR * 12); x[0] = 1;
    const [o] = renderDsp(fx, x, null);
    let at = -1; for (let i = 1; i < o.length; i++) if (Math.abs(o[i]) > 0.1) { at = i; break; }
    return at / SR;
  };
  assert.ok(Math.abs(echoAt({}, 8, 60) - 4.9) < 0.002);               // ASTRID's 4.9 s cap
  assert.ok(Math.abs(echoAt({ maxDelaySeconds: 10 }, 8, 60) - 8) < 0.002);
  assert.ok(Math.abs(echoAt({ maxDelaySeconds: 1 }, 2, 60) - 1) < 0.002);
});
