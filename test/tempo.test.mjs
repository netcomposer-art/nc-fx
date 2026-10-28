import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bpmOf, applyTempoMap, followClock } from '../src/tempo.js';

const calls = () => { const c = []; return { c, fx: { setTempo: (bpm, at) => c.push([bpm, at]) } }; };

test('bpmOf reads numbers, {bpm} and {bpmAt}', () => {
  assert.equal(bpmOf(128), 128);
  assert.equal(bpmOf({ bpm: 90 }), 90);
  assert.equal(bpmOf({ bpmAt: (b) => (b < 4 ? 100 : 150) }, 5), 150);
  assert.ok(Number.isNaN(bpmOf(null)));
});

test('applyTempoMap schedules an nc-clock TempoMap window on the audio clock', () => {
  const map = { points: [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 90 }, { beat: 32, bpm: 60 }], bpmAt: (b) => (b < 8 ? 120 : b < 32 ? 90 : 60), timeAt: (b) => (b <= 8 ? b / 2 : 4 + (b - 8) * 60 / 90) };
  const { c, fx } = calls();
  assert.equal(applyTempoMap(fx, map, { fromBeat: 4, toBeat: 16, toAudioTime: (s) => s + 100 }), 2);
  assert.deepEqual(c, [[120, 102], [90, 104]]);
});

test('followClock follows NcClock tempo changes at their beat time, and unsubscribes', () => {
  let listener = null;
  const clock = {
    transport: { tempo: { bpmAt: () => 110 }, timeAt: (b) => b * 0.5, beatAt: (t) => t * 2 },
    onChange: (l) => { listener = l; return () => { listener = null; }; },
  };
  const { c, fx } = calls();
  const off = followClock(fx, clock, { toAudioTime: (s) => s + 1 });
  assert.deepEqual(c, [[110, undefined]]);
  listener({ kind: 'tempo', atBeat: 16, bpm: 140 });
  assert.deepEqual(c.at(-1), [140, 9]);
  off();
  assert.equal(listener, null);
});

// ---- With the real nc-clock (v0.3.0, vendored as a test fixture) on a shared (epoch) timebase (Zeta P2-1, P2-2)
import vm from 'node:vm';
import { NcClock, AudioClockMapper } from './fixtures/nc-clock-b753634.mjs';
import { createFxCore } from '../src/index.js';
import source from '../dist/worklet-source.js';
import { mockContext } from './mock-audio.mjs';

const SR = 48000, CTX_T = 1000; // the AudioContext has run 1000 s; shared time is epoch seconds
function sharedSetup() {
  let perf = 5000; // ms since timeOrigin
  const timeOrigin = 1.7e12;
  const ctx = mockContext({ currentTime: CTX_T });
  Object.assign(ctx, { state: 'running', outputLatency: 0, baseLatency: 0, getOutputTimestamp: () => ({ contextTime: ctx.currentTime, performanceTime: perf }) });
  const mapper = new AudioClockMapper(ctx, { timeOrigin, perfNow: () => perf });
  mapper.sample(); mapper.sample(); mapper.sample();
  const clock = new NcClock({ bpm: 120, minBpm: 20, maxBpm: 300, timebase: 'shared' });
  return { ctx, mapper, clock, advance: (s) => { perf += s * 1000; ctx.currentTime += s; } };
}
function worklet(opts) {
  const reg = {};
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage() {} }; } }
  const scope = vm.createContext({ AudioWorkletProcessor, sampleRate: SR, currentFrame: CTX_T * SR, registerProcessor: (n, c) => { reg[n] = c; }, Math, Float32Array, Float64Array, Int32Array, Uint8Array });
  vm.runInContext(source, scope);
  return { p: new reg['nc-fx@1']({ processorOptions: opts }), scope };
}

test('followClock + real NcClock + AudioClockMapper: setTempo(90) at beat 8 reaches the engine at its audio time', async () => {
  const { ctx, mapper, clock } = sharedSetup();
  assert.ok(mapper.ready);
  clock.play({ at: mapper.sharedNow() }); // beat 0 now (ctx time 1000)
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', bpm: 120 });
  await fx.ready;
  followClock(fx, clock, { mapper });
  clock.setTempo({ bpm: 90, atBeat: 8 }); // 8 beats at 120 = 4 s: ctx time 1004
  const tempo = ctx.posted.filter((m) => m.t === 'tempo');
  assert.equal(tempo.at(-1).bpm, 90);
  assert.ok(Math.abs(tempo.at(-1).when - 1004) < 1e-6, `when ${tempo.at(-1).when}`);
  // Into the real processor: the change lands on frame 1004 * 48000, not 1.7e9 s away.
  const { p, scope } = worklet(ctx.node.options.processorOptions);
  for (const m of ctx.posted) p.port.onmessage({ data: m });
  const L = new Float32Array(128), out = [new Float32Array(128), new Float32Array(128)];
  const flip = 1004 * SR;
  for (let f = CTX_T * SR; f < flip + 256; f += 128) {
    scope.currentFrame = f;
    p.process([[L, L]], [out]);
    assert.equal(p.dsp.getTempo(), f + 128 <= flip ? 120 : 90, `frame ${f}`);
  }
});

test('followClock on a shared clock without a mapper applies at once (one warning), never at an epoch time', () => {
  const { clock, mapper } = sharedSetup();
  clock.play({ at: mapper.sharedNow() });
  const { c, fx } = calls();
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    followClock(fx, clock);
    clock.setTempo({ bpm: 90, atBeat: 8 });
    clock.setTempo({ bpm: 100, atBeat: 16 });
  } finally { console.warn = warn; }
  assert.deepEqual(c, [[120, undefined], [90, undefined], [100, undefined]]);
  assert.equal(warned, 1);
});

test('createFxCore refuses a time more than 600 s ahead (epoch seconds as audio time), once with a warning', async () => {
  const { ctx } = sharedSetup();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', bpm: 120 });
  await fx.ready;
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    fx.setTempo(90, 1.7e9);
    assert.equal(fx.setParam('delay', 'mix', 40, 1.7e9), undefined);
    fx.clear({ at: 1.7e9 });
    fx.setTempo(95, CTX_T + 599);
  } finally { console.warn = warn; }
  assert.equal(warned, 1);
  assert.equal(fx.getTempo(), 95);
  assert.equal(fx.getParam('delay', 'mix'), 0);
  assert.deepEqual(ctx.posted.filter((m) => m.t !== 'load').map((m) => [m.t, m.when]), [['tempo', CTX_T + 599]]);
});

test('late joiner: followClock after a tempo change gets the tempo playing now, not bpmAt(0)', () => {
  const { clock, mapper, advance } = sharedSetup();
  clock.play({ at: mapper.sharedNow() });
  clock.setTempo({ bpm: 90, atBeat: 8 });
  advance(60); // a minute in: well past beat 8
  const a = calls(); followClock(a.fx, clock)(); // no mapper, no now: the transport's current tempo
  assert.deepEqual(a.c, [[90, undefined]]);
  const b = calls(); followClock(b.fx, clock, { mapper })(); // beatAt(sharedNow)
  assert.deepEqual(b.c, [[90, undefined]]);
  // A peer that joins by snapshot hears the same.
  const peer = new NcClock({ bpm: 120, minBpm: 20, maxBpm: 300, timebase: 'shared' });
  const d = calls(); followClock(d.fx, peer); d.c.length = 0;
  peer.applySnapshot(clock.toSnapshot());
  assert.deepEqual(d.c, [[90, undefined]]);
  // A change still ahead is scheduled at its time, after the tempo playing now.
  const beatNow = clock.transport.beatAt(mapper.sharedNow());
  clock.setTempo({ bpm: 150, atBeat: Math.ceil(beatNow) + 8 });
  const e = calls(); followClock(e.fx, clock, { mapper });
  assert.equal(e.c.length, 2);
  assert.deepEqual(e.c[0], [90, undefined]);
  assert.equal(e.c[1][0], 150);
  assert.ok(Math.abs(e.c[1][1] - mapper.toContextTime(clock.transport.timeAt(Math.ceil(beatNow) + 8))) < 1e-9);
  assert.ok(e.c[1][1] > 1060 && e.c[1][1] < 1070, `at ${e.c[1][1]}`);
});
