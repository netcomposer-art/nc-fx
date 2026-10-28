// Denormals (Petra's review, P1-2): turn every effect down, smoothed, then feed 60 s of silence. Before the
// smoother snap the levels decayed through subnormal doubles after ~15 s and µs/block climbed. Shared CI
// runners change speed by 2x mid-run, so the timing is relative: each block is timed against a control
// engine with the same settings whose state is cleared to exact zeros every 5 s (it can't go subnormal),
// interleaved block by block so both see the same machine. Seconds 15-60 may cost at most 1.4x the control.
// At d9dc982 the ratio climbed to 1.57x ('run') and 3.4x ('hold'); now ~1.0x.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxDsp, FX_PARAM as P } from '../src/dsp.js';

const now = () => Number(process.hrtime.bigint()) / 1e3;
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const PROG = [1, 12, -3, 0.8, 1, 0.75, 0.5, 0.4, 1, 0.02, 0.6, 0.7, 0.3, 0.35];
// PR B: Acid curve, tone 30, accent -> drive 50%, -> tone 30% (the tone LP decays through the silence too).
const ACID = PROG.concat([1, 30 / 99, 0.5, 0.3]);
const DOWN = [[P.DRIVE_ON, 0], [P.DELAY_ON, 0], [P.PLATE_ON, 0], [P.DRIVE_MIX, 0], [P.DELAY_MIX, 0],
  [P.DELAY_FEEDBACK, 0], [P.PLATE_MIX, 0], [P.PLATE_PREDELAY, 0], [P.PLATE_DAMPING, 0]];

for (const [bypassMode, withMod] of [['run'], ['hold'], ['run', true], ['run', 'acid']]) {
  test(`60 s of silence after turning everything down: µs/block doesn't climb (bypass ${bypassMode}${withMod === 'acid' ? ', Acid + tone + accent mod' : withMod ? ', mod input present' : ''})`, () => {
    const mk = () => {
      const fx = createFxDsp(48000, { limiter: 'soft', bypassMode });
      fx.load(withMod === 'acid' ? ACID : PROG, 0, true);
      return fx;
    };
    const fx = mk(), ctl = mk();
    const b = new Float32Array(128), c = new Float32Array(128);
    // With the mod input present (PR A): both engines get the same silent CV, so the ratio still isolates denormals.
    const m = withMod ? new Float32Array(128) : null;
    if (withMod === 'acid') for (let i = 0; i < 128; i++) m[i] = Math.exp(-i / 40); // moving accent CV, every block
    let f = 0;
    for (let k = 0; k < 2000; k++) {
      for (let i = 0; i < 128; i++) b[i] = c[i] = Math.sin((f + i) * 0.05) * 0.5;
      fx.process(b, null, b, null, 128, f, m); ctl.process(c, null, c, null, 128, f, m); f += 128;
    }
    for (const [i, v] of DOWN) { fx.set(i, v); ctl.set(i, v, 0, true); }
    const W = 375 * 5, ratios = [];
    let ta = [], tc = [], sub = 0;
    for (let k = 0; k < 375 * 60; k++) {
      if (k % W === 0) ctl.clear();
      b.fill(0); c.fill(0);
      let a;
      if (k & 1) {
        a = now(); fx.process(b, null, b, null, 128, f, m); ta.push(now() - a);
        a = now(); ctl.process(c, null, c, null, 128, f, m); tc.push(now() - a);
      } else {
        a = now(); ctl.process(c, null, c, null, 128, f, m); tc.push(now() - a);
        a = now(); fx.process(b, null, b, null, 128, f, m); ta.push(now() - a);
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
