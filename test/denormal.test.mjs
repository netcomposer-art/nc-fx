// Denormals (Petra's review, P1-2): turn every effect down, smoothed, then feed 60 s of silence. Before the
// smoother snap the levels decayed through subnormal doubles after ~15 s and µs/block climbed. Timing is
// noisy on shared runners, so it compares medians: seconds 15-60 may cost at most 1.4x seconds 5-15 (+3 µs).
// At d9dc982 they cost 1.7x ('run') and 3.3x ('hold'); now 1.0x.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxDsp, FX_PARAM as P } from '../src/dsp.js';

const now = () => Number(process.hrtime.bigint()) / 1e3;
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

for (const bypassMode of ['run', 'hold']) {
  test(`60 s of silence after turning everything down: µs/block doesn't climb (bypass ${bypassMode})`, () => {
    const fx = createFxDsp(48000, { limiter: 'soft', bypassMode });
    fx.load([1, 12, -3, 0.8, 1, 0.75, 0.5, 0.4, 1, 0.02, 0.6, 0.7, 0.3, 0.35], 0, true);
    const b = new Float32Array(128);
    let f = 0;
    for (let k = 0; k < 2000; k++) { for (let i = 0; i < 128; i++) b[i] = Math.sin((f + i) * 0.05) * 0.5; fx.process(b, null, b, null, 128, f); f += 128; }
    for (const [i, v] of [[P.DRIVE_ON, 0], [P.DELAY_ON, 0], [P.PLATE_ON, 0], [P.DRIVE_MIX, 0], [P.DELAY_MIX, 0],
      [P.DELAY_FEEDBACK, 0], [P.PLATE_MIX, 0], [P.PLATE_PREDELAY, 0], [P.PLATE_DAMPING, 0]]) fx.set(i, v);
    const windows = [];
    let t = [], sub = 0;
    for (let k = 0; k < 375 * 60; k++) {
      b.fill(0);
      const a = now();
      fx.process(b, null, b, null, 128, f);
      t.push(now() - a);
      f += 128;
      for (let i = 0; i < 128; i++) if (b[i] !== 0 && Math.abs(b[i]) < 1.1754943508222875e-38) sub++;
      if (t.length === 375 * 5) { windows.push(median(t)); t = []; }
    }
    assert.equal(sub, 0, 'subnormal output samples');
    const ref = Math.max(windows[1], windows[2]), late = median(windows.slice(3));
    assert.ok(late <= ref * 1.4 + 3, `µs/block per 5 s: ${windows.map((x) => x.toFixed(1)).join(' ')}`);
  });
}
