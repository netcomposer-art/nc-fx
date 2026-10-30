// Denormals in the slot engine (the method of test/denormal.test.mjs): play every effect type with its dials up, turn
// everything down (smoothed: every dial to its minimum, then off), feed 60 s of silence. Each block is timed against a
// control engine with the same chain whose state is cleared every 5 s (it can't go subnormal), interleaved block by
// block. Seconds 15-60 may cost at most 1.4x the control, and no output sample may be subnormal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxChainDsp } from '../src/chain.js';
import { catalogEntry, dialDsp } from '../src/catalog.js';
import { newSlot, slotProgram } from '../src/slots.js';

const now = () => Number(process.hrtime.bigint()) / 1e3;
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const CHAINS = [['eq', 'compressor', 'width'], ['flanger', 'chorus', 'phaser'], ['lowpass', 'highpass', 'bandpass'], ['drive', 'delay', 'plate']];

for (const [types, bypassMode] of [...CHAINS.map((c) => [c, 'run']), [CHAINS[1], 'hold'], [CHAINS[0], 'hold']]) {
  test(`60 s of silence after turning ${types.join(' + ')} down: µs/block doesn't climb (bypass ${bypassMode})`, () => {
    const mk = () => {
      const fx = createFxChainDsp(48000, { limiter: 'soft', bypassMode });
      types.forEach((t, i) => {
        const s = newSlot(t);
        // Dials up: each at 70% of its range (options: the last), on.
        for (const d of catalogEntry(t).dials) s.dials[d.key] = d.options ? d.options.at(-1).value : Math.round(d.min + (d.max - d.min) * 0.7);
        fx.add(i + 1, t, 0);
        for (const [k, v] of slotProgram(s)) fx.set(i + 1, k, v, 0, true);
      });
      fx.order([1, 2, 3], 0, true);
      return fx;
    };
    const fx = mk(), ctl = mk();
    const b = new Float32Array(128), c = new Float32Array(128);
    let f = 0;
    for (let k = 0; k < 2000; k++) {
      for (let i = 0; i < 128; i++) b[i] = c[i] = Math.sin((f + i) * 0.05) * 0.5;
      fx.process(b, null, b, null, 128, f); ctl.process(c, null, c, null, 128, f); f += 128;
    }
    // Everything down, smoothed (the control snaps): every dial to its minimum, then off.
    types.forEach((t, i) => {
      for (const d of catalogEntry(t).dials) { const v = dialDsp(d, d.options ? d.options[0].value : d.min); fx.set(i + 1, d.k, v); ctl.set(i + 1, d.k, v, 0, true); }
      fx.set(i + 1, 0, 0); ctl.set(i + 1, 0, 0, 0, true);
    });
    const W = 375 * 5, ratios = [];
    let ta = [], tc = [], sub = 0;
    for (let k = 0; k < 375 * 60; k++) {
      if (k % W === 0) ctl.clear();
      b.fill(0); c.fill(0);
      let a;
      if (k & 1) {
        a = now(); fx.process(b, null, b, null, 128, f); ta.push(now() - a);
        a = now(); ctl.process(c, null, c, null, 128, f); tc.push(now() - a);
      } else {
        a = now(); ctl.process(c, null, c, null, 128, f); tc.push(now() - a);
        a = now(); fx.process(b, null, b, null, 128, f); ta.push(now() - a);
      }
      f += 128;
      for (let i = 0; i < 128; i++) if (b[i] !== 0 && Math.abs(b[i]) < 1.1754943508222875e-38) sub++;
      if (ta.length === W) { ratios.push(median(ta) / median(tc)); ta = []; tc = []; }
    }
    assert.equal(sub, 0, 'subnormal output samples');
    const late = median(ratios.slice(3));
    assert.ok(late <= 1.4, `µs/block vs a zeroed control, per 5 s: ${ratios.map((x) => x.toFixed(2)).join(' ')}`);
  });
}
