import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxCore, createFx, PROCESSOR_NAME, defaultState } from '../src/index.js';
import { compile } from '../src/params.js';
import { mockContext } from './mock-audio.mjs';

test('wires input -> node -> output once the worklet loads, sending the compiled program and tempo', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', bpm: 132, state: [{ type: 'delay', bypass: false, dials: { wet: 25 } }] });
  assert.equal(fx.status, 'loading');
  await fx.ready;
  assert.equal(fx.status, 'ready');
  assert.deepEqual(ctx.modules, ['/w.js']);
  assert.equal(ctx.node.name, PROCESSOR_NAME);
  assert.equal(ctx.node.options.processorOptions.bpm, 132);
  assert.equal(ctx.node.options.processorOptions.program[7], 0.25); // ASTRID chain migrated (wet -> mix)
  assert.equal(ctx.node.options.processorOptions.program[4], 1);
  assert.ok(fx.input.out.has(ctx.node));
  assert.equal(fx.latencySamples, 0); // limiter off by default
  assert.equal(ctx.node.options.processorOptions.limiter, 'off');
  assert.equal(ctx.node.options.processorOptions.preGain, 1);
  assert.equal(ctx.node.options.processorOptions.bypassMode, 'run');
  assert.equal(createFxCore(mockContext(), { limiter: 'lookahead' }).latencySamples, 72);
});

test('setParam clamps, stores, posts DSP units with the audio-clock time, and notifies', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js' });
  await fx.ready;
  const seen = [];
  const off = fx.onChange((c) => seen.push(c));
  assert.equal(fx.setParam('reverb', 'mix', 140, 2.5), 100);
  assert.equal(fx.getParam('plate', 'mix'), 100);
  assert.deepEqual(ctx.posted.at(-1), { t: 'p', i: 13, v: 1, when: 2.5 });
  assert.equal(fx.setParam('delay', 'bypass', false), false);
  assert.deepEqual(ctx.posted.at(-1), { t: 'p', i: 4, v: 1, when: 0 });
  assert.equal(fx.setParam('delay', 'delay_beats', 0.6), 0.5);
  assert.equal(fx.setParam('flanger', 'mix', 1), undefined);
  assert.equal(fx.setParam('drive', 'nope', 1), undefined);
  assert.deepEqual(seen[0], { effect: 'plate', key: 'mix', value: 100 });
  off();
  fx.setParam('drive', 'drive_db', 3);
  assert.equal(seen.length, 3);
});

test('getState/setState round-trip as JSON; setTempo and clear post on the audio clock', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js' });
  await fx.ready;
  fx.setParam('plate', 'size', 80);
  const s = fx.getState();
  s.chain[0].dials.drive_db = 9; // a copy: does not touch the instance
  assert.equal(fx.getParam('drive', 'drive_db'), 0);
  const fx2 = createFxCore(mockContext(), { moduleUrl: '/w.js', state: JSON.parse(JSON.stringify(fx.getState())) });
  assert.deepEqual(fx2.getState(), fx.getState());
  fx.setState(s, { at: 4 });
  assert.equal(ctx.posted.at(-1).t, 'load');
  assert.equal(ctx.posted.at(-1).when, 4);
  assert.equal(ctx.posted.at(-1).program[1], 9);
  fx.setTempo(999, 1.25);
  assert.deepEqual(ctx.posted.at(-1), { t: 'tempo', bpm: 400, when: 1.25 });
  assert.equal(fx.getTempo(), 400);
  fx.setTempo(NaN);
  assert.equal(fx.getTempo(), 400);
  fx.clear(3);
  assert.deepEqual(ctx.posted.at(-1), { t: 'clear', when: 3 });
});

test('crossfades from the wire to the chain on the audio clock when the context is running', async () => {
  const ctx = mockContext({ currentTime: 10 });
  const fx = createFxCore(ctx, { moduleUrl: '/w.js' });
  await fx.ready;
  // dry is the first node input connects to (other than the worklet).
  const dry = [...fx.input.out].find((n) => n !== ctx.node);
  assert.deepEqual(dry.gain.events, [['set', 1, 10], ['ramp', 0, 10.012]]);
});

test('without AudioWorklet it stays a dry wire and says so (no throw)', async () => {
  const ctx = mockContext({ fail: true });
  const fx = createFxCore(ctx, { moduleUrl: '/w.js' });
  await fx.ready;
  assert.equal(fx.status, 'unavailable');
  assert.ok(fx.error instanceof Error);
  assert.equal(fx.setParam('drive', 'mix', 50), 50); // state still works
  fx.dispose();
  assert.equal(fx.status, 'disposed');
});

test('dispose tells the processor to stop and disconnects; createFx adds mount()', async () => {
  const ctx = mockContext();
  const fx = createFx(ctx, { moduleUrl: '/w.js' });
  assert.equal(typeof fx.mount, 'function');
  await fx.ready;
  fx.dispose();
  assert.deepEqual(ctx.posted.at(-1), { t: 'dispose' });
  assert.equal(fx.input.out.size, 0);
  assert.equal(fx.setParam('drive', 'mix', 10), undefined);
  assert.deepEqual(defaultState().chain.map((c) => c.bypass), [true, true, true]);
});

test('calls before the worklet is ready are queued in order, kept off the starting state, and clamped if past', async () => {
  const ctx = mockContext({ currentTime: 0 });
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', bpm: 120 });
  fx.setParam('delay', 'mix', 100, 12.5);        // future: kept exactly
  fx.setParam('drive', 'bypass', false, 3);      // past by the time the node exists: clamped to now
  fx.setTempo(90);                               // untimed: now
  fx.setState({ v: 1, chain: [] }, { at: 4 });   // past: now
  fx.clear(11);                                  // future
  fx.setParam('delay', 'mix', 40, 12.5);         // same time as the first: must stay after it
  assert.equal(fx.getParam('delay', 'mix'), 40); // the mirror is current at once
  ctx.currentTime = 10;                          // the context ran on while the module loaded
  await fx.ready;
  assert.deepEqual(ctx.posted, []);              // nothing was dropped or sent early
  const po = ctx.node.options.processorOptions;
  assert.deepEqual(po.program, Array.from(compile(defaultState()))); // the start is the construction state
  assert.equal(po.bpm, 120);
  assert.deepEqual(po.pending.map((m) => [m.t, m.when, m.snap]), [
    ['p', 12.5, undefined], ['p', 0, true], ['tempo', 0, true], ['load', 0, true], ['clear', 11, undefined], ['p', 12.5, undefined]
  ]);
  assert.deepEqual([po.pending[0].i, po.pending[0].v, po.pending[5].v], [7, 1, 0.4]);
  fx.setParam('drive', 'mix', 10);               // after ready: posted live, not queued
  assert.deepEqual(ctx.posted.at(-1), { t: 'p', i: 3, v: 0.1, when: 0 });
});

test('a queue built before ready is dropped on dispose or when the worklet is unavailable', async () => {
  const ctx = mockContext({ fail: true });
  const fx = createFxCore(ctx, { moduleUrl: '/w.js' });
  fx.setParam('delay', 'mix', 100, 1);
  await fx.ready;
  assert.equal(fx.status, 'unavailable');
  const ctx2 = mockContext();
  const fx2 = createFxCore(ctx2, { moduleUrl: '/w.js' });
  fx2.setParam('delay', 'mix', 100, 1);
  fx2.dispose();
  await fx2.ready;
  assert.equal(ctx2.node, undefined);
});
