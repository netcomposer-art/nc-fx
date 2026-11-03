// watchAudioStall (src/watchdog.js): a 'running' context whose clock stops for stallMs is reported once; a suspended
// one, a late timer (background tab, sleep) or a clock that moves is not; onResume when it moves again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchAudioStall } from '../src/watchdog.js';

function harness(stallMs = 1000, everyMs = 250) {
  let t = 0, tick = null;
  const ctx = { currentTime: 0, state: 'running' };
  const events = [];
  const w = watchAudioStall(ctx, {
    stallMs, everyMs, now: () => t,
    setInterval: (cb) => { tick = cb; return 1; }, clearInterval: () => { tick = null; },
    onStall: (info) => events.push(['stall', info.frozenMs, info.at]),
    onResume: () => events.push(['resume']),
  });
  const step = (ms, moved = true) => { t += ms; if (moved) ctx.currentTime += ms / 1000; tick?.(); };
  return { ctx, events, w, step, stopped: () => tick === null };
}

test('a clock that moves is never a stall', () => {
  const h = harness();
  for (let i = 0; i < 40; i++) h.step(250);
  assert.deepEqual(h.events, []);
  assert.equal(h.w.stalled(), false);
});

test('a running context frozen for stallMs is reported once, then resume when it moves', () => {
  const h = harness();
  h.step(250);
  for (let i = 0; i < 3; i++) h.step(250, false);
  assert.deepEqual(h.events, []);
  h.step(250, false);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0][0], 'stall');
  assert.equal(h.events[0][1], 1000);
  assert.equal(h.w.stalled(), true);
  for (let i = 0; i < 10; i++) h.step(250, false);
  assert.equal(h.events.length, 1, 'once');
  h.step(250);
  assert.deepEqual(h.events[1], ['resume']);
  assert.equal(h.w.stalled(), false);
});

test('suspended or closed is not a stall; a late timer starts the count again', () => {
  const h = harness();
  h.ctx.state = 'suspended';
  for (let i = 0; i < 20; i++) h.step(250, false);
  assert.deepEqual(h.events, []);
  h.ctx.state = 'running';
  h.step(250, false); h.step(250, false); h.step(250, false);
  h.step(5000, false); // the tab slept: no evidence either way
  h.step(250, false); h.step(250, false); h.step(250, false);
  assert.deepEqual(h.events, []);
  h.step(250, false);
  assert.equal(h.events.length, 1);
});

test('stop() clears its timer', () => {
  const h = harness();
  h.w.stop();
  assert.equal(h.stopped(), true);
});
