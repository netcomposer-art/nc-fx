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
