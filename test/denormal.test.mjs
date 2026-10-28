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
const DSEND = PROG.concat([0, 100 / 99, 0, 0, 0.5, 120, 1, 0.6, 0.5, 0.3]); // PR C: Send + tone + low cut + send mod + free time
const DOWN = [[P.DRIVE_ON, 0], [P.DELAY_ON, 0], [P.PLATE_ON, 0], [P.DRIVE_MIX, 0], [P.DELAY_MIX, 0],
  [P.DELAY_FEEDBACK, 0], [P.PLATE_MIX, 0], [P.PLATE_PREDELAY, 0], [P.PLATE_DAMPING, 0]];

for (const [bypassMode, withMod] of [['run'], ['hold'], ['run', true], ['run', 'acid'], ['run', 'delay'], ['hold', 'delay']]) {
  test(`60 s of silence after turning everything down: µs/block doesn't climb (bypass ${bypassMode}${withMod === 'acid' ? ', Acid + tone + accent mod' : withMod === 'delay' ? ', Send delay + filters + send mod' : withMod ? ', mod input present' : ''})`, () => {
    const mk = () => {
      const fx = createFxDsp(48000, { limiter: 'soft', bypassMode });
      fx.load(withMod === 'acid' ? ACID : withMod === 'delay' ? DSEND : PROG, 0, true);
      return fx;
    };
    const fx = mk(), ctl = mk();
    const b = new Float32Array(128), c = new Float32Array(128);
    // With the mod input present (PR A): both engines get the same silent CV, so the ratio still isolates denormals.
    const m = withMod ? new Float32Array(128) : null;
    if (withMod === 'acid' || withMod === 'delay') for (let i = 0; i < 128; i++) m[i] = Math.exp(-i / 40); // moving accent CV, every block
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

// Zeta's PR C review (P3): a Send tail with feedback > 0.5 and the filters off stuck in float32 subnormals on the line
// (x * fb rounds back up to the smallest subnormal), 5.6e-45 after 90 s. Both modes, filters off, long feedback tails
// (1/32 at 240 bpm, so hundreds of repeats fit): the output must reach exactly 0. Subnormal output samples are allowed
// only at the tail's very end, once its peak is below 1e-30 (near-zero samples of a tail that small, and the fractional read of the last line values, as in Bass;
// Chrome flushes them). Before the fix the Send tail sat at 5.6e-45 for good.
for (const mode of [0, 1]) for (const fb of [0.6, 0.9]) {
  test(`delay tail with the filters off reaches exact 0, no subnormals (${mode ? 'Send' : 'Insert'}, feedback ${fb})`, () => {
    const fx = createFxDsp(48000, { limiter: 'off', bypassMode: 'hold' });
    fx.setTempo(240, 0, true);
    // drive, plate bypassed; delay on, 1/32, mix 100 % (Send) / 50 % (Insert), filters off, send 100, no mod
    fx.load([0, 0, 0, 1, 1, 0.125, fb, mode ? 1 : 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 100 / 99, 0, 0, 100 / 99, 0, mode, 1, 0, 0], 0, true);
    const b = new Float32Array(128);
    let f = 0, lastNonZero = -1, firstSub = -1, firstTiny = -1;
    for (let k = 0; k < 375 * 40; k++) { // 40 s
      if (k < 40) for (let i = 0; i < 128; i++) b[i] = Math.sin((f + i) * 0.05) * 0.5; else b.fill(0);
      fx.process(b, null, b, null, 128, f); f += 128;
      let pk = 0;
      for (let i = 0; i < 128; i++) if (b[i] !== 0) {
        pk = Math.max(pk, Math.abs(b[i])); lastNonZero = k; if (firstSub < 0 && Math.abs(b[i]) < 1.1754943508222875e-38) firstSub = k;
      }
      if (k > 40 && firstTiny < 0 && pk < 1e-30) firstTiny = k;
    }
    if (mode === 0) assert.equal(firstSub, -1, 'Insert: no subnormal output samples');
    else assert.ok(firstSub < 0 || (firstTiny >= 0 && firstSub >= firstTiny), `first subnormal output at block ${firstSub}, tail under 1e-30 at ${firstTiny}`);
    assert.ok(lastNonZero < 375 * 35, `tail still non-zero at block ${lastNonZero} of ${375 * 40}`);
  });
}
