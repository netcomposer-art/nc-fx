// Gate (nc-fx's own, Peter's go 2026-11-06): catalog and Add menu, a new Gate on Ducker, the saved `pattern`, the
// pattern API, the beat clock (free-running while stopped, Play lines it up with a 10 ms glide, tempo changes keep
// the beat, Stop runs free from where it is), 1/8T restarting every bar, swing, the shapes, sleep when off, no
// clicks at the step edges, denormals, the worklet's clock report and the playhead helper, and followClock with the
// real nc-clock. Allocation: alloc-slots (every catalog type, with line-ups). CPU: test/bench/effects-cpu.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import source from '../dist/worklet-source.js';
import { createFxChainDsp } from '../src/chain.js';
import { CATALOG_MENU, catalogEntry } from '../src/catalog.js';
import { newSlot, slotProgram, sanitizeSlots, toAstridHacks } from '../src/slots.js';
import { GATE_PATTERNS, gatePreset, cleanPattern, packPattern, gatePatternName, gateStepAt, gateStepsPlayed, gateCurve } from '../src/gate.js';
import { createFxCore } from '../src/index.js';
import { followClock } from '../src/tempo.js';
import { mockContext } from './mock-audio.mjs';
import { NcClock, AudioClockMapper } from './fixtures/nc-clock-b753634.mjs';

const SR = 48000;
const P = Object.fromEntries(GATE_PATTERNS.map((g) => [g.name, g]));
/** A slot for a starting pattern, with dial overrides and a pattern override. */
function slotOf(name, dials = {}, pattern = null) {
  const s = newSlot('gate'), g = gatePreset(name);
  Object.assign(s.dials, g.dials, dials);
  s.pattern = pattern ? cleanPattern(pattern) : g.pattern;
  return s;
}
function chain(slot, { beat = null } = {}) {
  const fx = createFxChainDsp(SR, { bypassMode: 'run', limiter: 'off' });
  fx.setTempo(120, 0, true);
  if (beat !== null) fx.setBeat(beat, 0);
  fx.add(1, 'gate', 0);
  for (const [k, v] of slotProgram(slot)) fx.set(1, k, v, 0, true);
  fx.order([1], 0, true);
  return fx;
}
/** n frames of DC 0.5 through fx (the output x 2 is the gain curve); hook(fx, frame) before each block. */
function gain(fx, n, hook) {
  const out = new Float32Array(n), a = new Float32Array(128).fill(0.5), b = new Float32Array(128).fill(0.5), c = new Float32Array(128), d = new Float32Array(128);
  for (let f = 0; f < n; f += 128) {
    if (hook) hook(fx, f);
    fx.process(a, b, c, d, 128, f);
    out.set(c.subarray(0, Math.min(128, n - f)), f);
  }
  return out.map((v) => v * 2);
}
const rises = (g) => { const r = []; for (let i = 1; i < g.length; i++) if (g[i - 1] < 0.5 && g[i] >= 0.5) r.push(i); return r; };
// Hard sixteenths, open on even steps: an open step every 1/8 (12000 frames at 120).
const ALT = { levels: Array.from({ length: 16 }, (_, i) => (i % 2 ? 0 : 100)), shapes: Array(16).fill(0) };
const alt = (dials = {}) => slotOf('Stutter', { smooth: 1, ...dials }, ALT);

test('catalog: Gate after Ensemble in Add, nc-fx\'s own, its dials; ASTRID never gets it', () => {
  assert.deepEqual(CATALOG_MENU.slice(0, 6), ['delay', 'plate', 'hall', 'ensemble', 'gate', 'flanger']);
  const e = catalogEntry('gate');
  assert.equal(e.own, true); assert.equal(e.pattern, true); assert.equal(e.label, 'Gate');
  assert.deepEqual(e.dials.filter((d) => !d.more).map((d) => d.key), ['rate', 'swing', 'depth', 'mix']);
  assert.deepEqual(e.dials.filter((d) => d.more).map((d) => d.key), ['steps', 'mode', 'smooth', 'spread', 'res']);
  assert.deepEqual(e.dials.find((d) => d.key === 'rate').options.map((o) => o.label), ['1/4', '1/8', '1/16', '1/8T']);
  const r = toAstridHacks({ v: 2, chain: [newSlot('gate')] });
  assert.equal(r.hacks.length, 0); assert.match(r.lossy[0], /ASTRID has no Gate/);
});

test('a new Gate starts on Ducker; the picker names it; any change makes it Custom', () => {
  const s = newSlot('gate');
  assert.equal(gatePatternName(s), 'Ducker');
  assert.deepEqual(s.dials, { rate: 4, swing: 0, depth: 90, mix: 100, steps: 8, mode: 0, smooth: 4, spread: 0, res: 20 });
  for (const g of GATE_PATTERNS) assert.equal(gatePatternName(slotOf(g.name)), g.name);
  const c = slotOf('Tide'); c.pattern.levels[3] = 7;
  assert.equal(gatePatternName(c), 'Custom');
  // Steps 8 ignores steps 9-16 when it names a pattern.
  const d = slotOf('Ducker'); d.pattern.levels[12] = 3;
  assert.equal(gatePatternName(d), 'Ducker');
});

test('saves: `pattern` round-trips, bad values clamp to the range or fall back to Ducker\'s, other types never get one', () => {
  const s = slotOf('Sieve');
  const back = sanitizeSlots(JSON.parse(JSON.stringify({ v: 2, chain: [s] })), 3).chain[0];
  assert.deepEqual(back, s);
  const bad = sanitizeSlots({ v: 2, chain: [{ id: 'gate-1', type: 'gate', dials: { rate: 99 }, pattern: { levels: [-5, 250, 'x', 33.4], shapes: [9, -1, 2.6] } }] }, 3).chain[0];
  assert.deepEqual(bad.pattern.levels.slice(0, 5), [0, 100, 100, 33, 100]);
  assert.deepEqual(bad.pattern.shapes.slice(0, 4), [4, 0, 3, 1]);
  assert.equal(bad.dials.rate, 16);
  const none = sanitizeSlots({ v: 2, chain: [{ id: 'gate-1', type: 'gate' }] }, 3).chain[0];
  assert.deepEqual(none.pattern, gatePreset('Ducker').pattern);
  const delay = sanitizeSlots({ v: 2, chain: [{ id: 'delay-1', type: 'delay', pattern: { levels: [1] } }] }, 3).chain[0];
  assert.equal('pattern' in delay, false);
  // An old save (no Gate in it) is exactly as before.
  const old = { v: 2, chain: [{ id: 'hall-1', type: 'hall', bypass: false, dials: catalogEntry('hall').dials.reduce((o, d) => ({ ...o, [d.key]: d.default }), {}) }] };
  assert.deepEqual(sanitizeSlots(old, 3), old);
});

test('the pattern packs into engine params 10-15 exactly (levels base 101, shapes base 5)', () => {
  const p = { levels: Array.from({ length: 16 }, (_, i) => (i * 7) % 101), shapes: Array.from({ length: 16 }, (_, i) => i % 5) };
  const pk = packPattern(p);
  assert.deepEqual(pk.map((x) => x[0]), [10, 11, 12, 13, 14, 15]);
  for (let g = 0; g < 4; g++) { let v = pk[g][1]; for (let i = 0; i < 4; i++) { assert.equal(v % 101, p.levels[g * 4 + i]); v = Math.floor(v / 101); } }
  for (let g = 0; g < 2; g++) { let v = pk[4 + g][1]; for (let i = 0; i < 8; i++) { assert.equal(v % 5, p.shapes[g * 8 + i]); v = Math.floor(v / 5); } }
  assert.ok(pk.every(([, v]) => Number.isSafeInteger(v)));
});

test('stopped (no line-up ever sent): steps at the tempo from the moment it is made', () => {
  const r = rises(gain(chain(alt()), SR * 2));
  assert.ok(r.length >= 7);
  for (let i = 1; i < r.length; i++) assert.ok(Math.abs(r[i] - r[i - 1] - 12000) <= 1, `period ${r[i] - r[i - 1]}`);
});

test('Play lines it up: beat 0 at the Play frame is step 1, reached within the 10 ms glide', () => {
  const play = 30011; // mid-step of the free-running clock
  const g = gain(chain(alt()), SR * 2, (fx, f) => { if (f === 29952) fx.setBeat(0, play); });
  assert.ok(g[play + 0.012 * SR] > 0.98, `12 ms after Play: ${g[play + 576]}`);
  const r = rises(g).filter((x) => x > play + 1000);
  assert.ok(r.length >= 3);
  for (let i = 0; i < r.length; i++) assert.ok(Math.abs(r[i] - (play + 12000 * (i + 1))) <= 60, `rise ${i} at ${r[i] - play}`);
});

test('a tempo change keeps the beat and steps on at the new tempo; Stop runs on from where it is', () => {
  const g = gain(chain(alt(), { beat: 0 }), SR * 3, (fx, f) => { if (f === 47872) fx.setTempo(90, 48000); if (f === 95872) fx.freeRun(96000); });
  const r = rises(g);
  assert.deepEqual(r.filter((x) => x < 48000).map((x) => Math.round(x / 12000)), [1, 2, 3]);
  const after = r.filter((x) => x > 48000);
  for (let i = 1; i < after.length; i++) assert.ok(Math.abs(after[i] - after[i - 1] - 16000) <= 1, `period at 90: ${after[i] - after[i - 1]}`);
});

test('1/8T restarts the pattern every bar: 12 steps a bar, the same bar every bar', () => {
  // One open step (step 1) in 16: with 1/8T it opens once a bar (every 4 beats = 96000 frames), never drifting.
  const one = { levels: [100, ...Array(15).fill(0)], shapes: Array(16).fill(0) };
  const g = gain(chain(slotOf('Stutter', { rate: 12, steps: 16, smooth: 1 }, one), { beat: 0 }), SR * 8);
  const r = rises(g);
  assert.deepEqual(r.map((x) => Math.round(x / 96000)), [1, 2, 3]);
  for (const x of r) assert.ok(Math.abs(x % 96000) <= 60 || 96000 - (x % 96000) <= 60, `rise at ${x}`);
  assert.equal(gateStepsPlayed({ rate: 12, steps: 16 }), 12);
  assert.equal(gateStepsPlayed({ rate: 12, steps: 8 }), 8);
  assert.equal(gateStepsPlayed({ rate: 16, steps: 16 }), 16);
});

test('swing: the second step of each pair starts late (Swing 100 % = 75 % of the pair)', () => {
  const off = { levels: Array.from({ length: 16 }, (_, i) => (i % 2 ? 100 : 0)), shapes: Array(16).fill(0) };
  const r = rises(gain(chain(slotOf('Stutter', { swing: 100, smooth: 1 }, off), { beat: 0 }), SR));
  assert.ok(Math.abs(r[0] - 9000) <= 60, `the off-step at ${r[0]} (straight 6000, 75 %: 9000)`);
});

test('gateStepAt (the playhead) matches the step the engine plays: rates, steps, swing, 1/8T', () => {
  for (const dials of [{ rate: 16, steps: 16, swing: 0 }, { rate: 8, steps: 8, swing: 60 }, { rate: 4, steps: 8, swing: 0 }, { rate: 12, steps: 16, swing: 30 }, { rate: 12, steps: 8, swing: 0 }]) {
    for (let s = 0; s < 16; s++) {
      const solo = { levels: Array.from({ length: 16 }, (_, i) => (i === s ? 100 : 0)), shapes: Array(16).fill(0) };
      const g = gain(chain(slotOf('Stutter', { ...dials, smooth: 1 }, solo), { beat: 0 }), SR * 9);
      for (let f = 2000; f < g.length; f += 1777) {
        const beat = f / 24000, at = gateStepAt(dials, beat);
        // Away from the edges (the 1 ms ramp), the gain is open exactly where the helper says step s plays.
        const edge = gateStepAt(dials, beat - 0.004) !== at || gateStepAt(dials, beat + 0.004) !== at;
        if (!edge) assert.equal(g[f] > 0.5, at === s, `${JSON.stringify(dials)} step ${s} at beat ${beat.toFixed(3)}`);
      }
    }
  }
});

test('gateCurve draws what the engine plays over a step (Volume, Depth 100 %, Smooth 1 ms)', () => {
  for (const name of ['Ducker', 'Tide', 'Lope', 'Embers']) {
    const g = gatePreset(name), dials = { ...g.dials, depth: 100, swing: 0, smooth: 1 };
    const out = gain(chain(slotOf(name, dials), { beat: 0 }), SR * 4);
    const per = 4 / dials.rate * 24000; // frames per step at 120
    for (let i = 0; i < dials.steps; i++) {
      const c = gateCurve(dials, g.pattern, i, 10);
      for (let k = 2; k <= 8; k++) {
        const f = Math.round((i + k / 10) * per);
        assert.ok(Math.abs(out[f] - c[k]) < 0.06, `${name} step ${i} at ${k / 10}: ${out[f]} vs ${c[k]}`);
      }
    }
  }
});

test('shapes, both modes, spread: finite, never NaN; Volume never passes the input', () => {
  for (const g of GATE_PATTERNS) for (const spread of [0, 100]) {
    const out = gain(chain(slotOf(g.name, { spread }), { beat: 0 }), SR);
    const top = g.dials.mode ? 1.41 : 1.0001; // Filter's resonance may ring over a little on a step's opening
    for (const v of out) assert.ok(Number.isFinite(v) && v <= top && v >= -0.41, `${g.name} spread ${spread}: ${v}`);
  }
});

test('no clicks: Stutter on a sine has nothing above 4 kHz louder than -90 dB at Smooth 4 ms', () => {
  const fx = chain(slotOf('Stutter'), { beat: 0 });
  const N = SR * 2, L = new Float32Array(N).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 220 * i / SR)), O = new Float32Array(N), O2 = new Float32Array(N);
  for (let f = 0; f < N; f += 128) fx.process(L.subarray(f, f + 128), L.subarray(f, f + 128), O.subarray(f, f + 128), O2.subarray(f, f + 128), 128, f);
  const w = 2 * Math.PI * 4000 / SR, al = Math.sin(w) / 1.4142, c = Math.cos(w);
  const b0 = (1 + c) / 2 / (1 + al), b1 = -(1 + c) / (1 + al), a1 = -2 * c / (1 + al), a2 = (1 - al) / (1 + al);
  let x = O;
  for (let pass = 0; pass < 2; pass++) {
    const y = new Float32Array(N); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < N; i++) { const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
    x = y;
  }
  let worst = 0;
  for (let i = SR / 10; i + 240 < N; i += 240) { let s = 0; for (let j = 0; j < 240; j++) s += x[i + j] ** 2; worst = Math.max(worst, Math.sqrt(s / 240)); }
  const db = 20 * Math.log10(worst / (0.5 / Math.SQRT2));
  assert.ok(db < -90, `${db.toFixed(1)} dB`);
});

test('engaging a new Gate (Ducker) on a pad: level drops by its duck, about 1-2 dB (no make-up gain, by design)', () => {
  const n = SR * 4, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / SR) + 0.1 * Math.sin(2 * Math.PI * 331 * i / SR); R[i] = L[i]; }
  const fx = chain(newSlot('gate'), { beat: 0 }), O = new Float32Array(n), O2 = new Float32Array(n);
  for (let f = 0; f < n; f += 128) fx.process(L.subarray(f, f + 128), R.subarray(f, f + 128), O.subarray(f, f + 128), O2.subarray(f, f + 128), 128, f);
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const d = 20 * Math.log10(rms(O) / rms(L));
  assert.ok(d < -0.5 && d > -2.5, `${d.toFixed(2)} dB`);
});

test('off: sleeps (output = input); back on starts clean', () => {
  const s = slotOf('Sieve'); s.bypass = true;
  const g = gain(chain(s, { beat: 0 }), SR);
  for (let i = 0; i < g.length; i++) assert.ok(Math.abs(g[i] - 1) < 1e-6);
});

test('denormals: 60 s of silence after Sieve and Tide (Spread 100 %): µs per block does not climb, silence out', () => {
  const now = () => Number(process.hrtime.bigint()) / 1e3, med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  for (const name of ['Sieve', 'Tide']) {
    const fx = chain(slotOf(name, { spread: 100 }), { beat: 0 });
    const a = new Float32Array(128), b = new Float32Array(128), c = new Float32Array(128), d = new Float32Array(128);
    let f = 0;
    for (; f < SR * 2; f += 128) { for (let i = 0; i < 128; i++) { a[i] = Math.sin((f + i) * 0.03) * 0.5; b[i] = a[i]; } fx.process(a, b, c, d, 128, f); }
    a.fill(0); b.fill(0);
    const early = [], late = [];
    for (let k = 0; f < SR * 62; f += 128, k++) {
      const t0 = now(); fx.process(a, b, c, d, 128, f); const dt = now() - t0;
      if (k > 200 && k < 2200) early.push(dt);
      if (f > SR * 58) late.push(dt);
    }
    assert.ok(med(late) < med(early) * 1.5 + 0.5, `${name}: ${med(early).toFixed(2)} -> ${med(late).toFixed(2)} µs`);
    assert.ok(c.every((v) => v === 0) && d.every((v) => v === 0));
  }
});

// ---- createFxCore: the API, the worklet (dist), its clock report, followClock with the real nc-clock.
function worklet(ctx, frame0 = 0) {
  const reg = {}, got = [];
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage: (m) => got.push(JSON.parse(JSON.stringify({ t: m.t, d: m.d ? Array.from(m.d) : null }))) }; } }
  const scope = vm.createContext({ AudioWorkletProcessor, sampleRate: SR, currentFrame: frame0, registerProcessor: (n, c) => { reg[n] = c; }, Math, Float32Array, Float64Array, Int32Array, Uint8Array });
  vm.runInContext(source, scope);
  const p = new reg['nc-fx@1']({ processorOptions: ctx.node.options.processorOptions });
  let sent = 0; // every message since the node was made (the processor starts from its options)
  return { p, scope, got, flush() { for (; sent < ctx.posted.length; sent++) p.port.onmessage({ data: ctx.posted[sent] }); } };
}

test('API: setPattern (partial), getPattern, setGatePattern; changes reach the worklet; saves carry the pattern', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', slots: 3 });
  await fx.ready;
  const id = fx.addEffect('gate');
  assert.equal(id, 'gate-1');
  assert.equal(gatePatternName(fx.getState().chain[0]), 'Ducker');
  const seen = []; fx.onChange((c) => seen.push(c.key));
  const mark = ctx.posted.length;
  const lv = fx.getPattern(id).levels; lv[2] = 40;
  const back = fx.setPattern(id, { levels: lv });
  assert.equal(back.levels[2], 40); assert.deepEqual(back.shapes, Array(16).fill(1));
  assert.ok(seen.includes('pattern'));
  const ps = ctx.posted.slice(mark).filter((m) => m.t === 'ps' && m.k >= 10);
  assert.deepEqual(ps.map((m) => m.k), [10]); // only the changed group of four
  assert.ok(fx.setGatePattern(id, 'Sieve'));
  assert.equal(gatePatternName(fx.getState().chain[0]), 'Sieve');
  assert.equal(fx.setPattern('nope', { levels: [] }), undefined);
  // The worklet plays it: rebuilt from the saved state, same params.
  const fx2 = createFxCore(mockContext(), { moduleUrl: '/w.js', slots: 3, state: fx.getState() });
  assert.deepEqual(fx2.getPattern(id), fx.getPattern(id));
});

test('worklet: setBeat / freeRun / setBar arrive, and the clock goes back to the main thread (beatAt, locked)', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', slots: 3, bpm: 120 });
  await fx.ready;
  fx.addEffect('gate');
  const w = worklet(ctx);
  const L = new Float32Array(128), out = [new Float32Array(128), new Float32Array(128)];
  const run = (blocks) => { for (let k = 0; k < blocks; k++) { w.flush(); w.p.process([[L, L]], [out]); w.scope.currentFrame += 128; } };
  run(2);
  const clk = () => w.got.filter((m) => m.t === 'clk').at(-1).d;
  assert.equal(clk()[3], 0, 'free-running at first');
  ctx.currentTime = 0.5;
  fx.setBeat(0, 1.0); // Play: beat 0 at 1 s
  fx.setBar(3);
  run(400);
  const c = clk();
  assert.equal(c[3], 1, 'locked'); assert.equal(c[4], 3);
  assert.ok(Math.abs(c[0] + (SR * 1.0 - c[1]) * c[2]) < 1e-9, 'beat 0 at 1 s');
  // The main thread reads it back (the playhead): beatAt(time).
  w.got.filter((m) => m.t === 'clk').forEach((m) => ctx.node.port.onmessage({ data: { t: 'clk', d: Float64Array.from(m.d) } }));
  const b = fx.beatAt(1.5);
  assert.ok(Math.abs(b.beat - 1) < 1e-9 && b.locked && Math.abs(b.bpm - 120) < 1e-9 && b.beatsPerBar === 3, JSON.stringify(b));
  fx.freeRun();
  run(2);
  assert.equal(clk()[3], 0, 'free again after Stop');
});

test('followClock + real nc-clock: Play lines the Gate up at its audio time, Stop lets it run free', async () => {
  let perf = 5000;
  const CTX_T = 1000, ctx = mockContext({ currentTime: CTX_T });
  Object.assign(ctx, { state: 'running', outputLatency: 0, baseLatency: 0, getOutputTimestamp: () => ({ contextTime: ctx.currentTime, performanceTime: perf }) });
  const mapper = new AudioClockMapper(ctx, { timeOrigin: 1.7e12, perfNow: () => perf });
  mapper.sample(); mapper.sample(); mapper.sample();
  const clock = new NcClock({ bpm: 120, minBpm: 20, maxBpm: 300, timebase: 'shared' });
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', slots: 3, bpm: 120 });
  await fx.ready;
  fx.addEffect('gate');
  followClock(fx, clock, { mapper });
  assert.equal(ctx.posted.filter((m) => m.t === 'free').length, 1, 'stopped: runs free from the start');
  clock.play({ at: mapper.sharedNow() + 2 }); // Play: beat 0 at ctx time 1002
  const beat = ctx.posted.filter((m) => m.t === 'beat').at(-1);
  assert.equal(beat.beat, 0);
  assert.ok(Math.abs(beat.when - 1002) < 1e-6, `when ${beat.when}`);
  const w = worklet(ctx, CTX_T * SR);
  const L = new Float32Array(128), out = [new Float32Array(128), new Float32Array(128)];
  for (let f = CTX_T * SR; f < 1002.5 * SR; f += 128) { w.scope.currentFrame = f; w.flush(); w.p.process([[L, L]], [out]); }
  const B = w.p.dsp.clock;
  assert.equal(B[5], 1);
  assert.ok(Math.abs(B[0] + (1002 * SR - B[1]) * B[2]) < 1e-6, 'beat 0 lands on frame 1002 * SR');
  perf += 3000; ctx.currentTime += 3;
  clock.stop({ at: mapper.sharedNow() });
  assert.ok(ctx.posted.at(-1).t === 'free');
});
