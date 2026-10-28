// CPU per 128-frame stereo block: drive curves, tone and accent mod (PR B). Engines run interleaved, block by block,
// so each sees the same machine; medians over 20 rounds of 2000 blocks. Drive only (delay, plate bypassed; 'hold'),
// and the full chain ('run', everything on). Usage: node test/bench/acid-cpu.mjs
import { createFxDsp } from '../../src/dsp.js';

const now = () => Number(process.hrtime.bigint()) / 1e3;
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const DRV = [1, 12, 0, 1, 0, 0.75, 0.35, 0, 0, 0, 0.5, 0.5, 0, 0];
const ALL = [1, 12, -3, 0.8, 1, 0.75, 0.5, 0.4, 1, 0.02, 0.6, 0.7, 0.3, 0.35];
const CASES = {
  smooth: [0, 100 / 99, 0, 0], acid: [1, 100 / 99, 0, 0], 'smooth+tone+mod': [0, 0.5, 0.5, 0.3], 'acid+tone+mod': [1, 0.5, 0.5, 0.3],
};
for (const [chain, base, mode] of [['drive only', DRV, 'hold'], ['full chain', ALL, 'run']]) {
  const names = Object.keys(CASES);
  const fxs = names.map((n) => { const fx = createFxDsp(48000, { bypassMode: mode }); fx.setTempo(120, 0, true); fx.load(base.concat(CASES[n]), 0, true); return fx; });
  const L = new Float32Array(128), R = new Float32Array(128), OL = new Float32Array(128), OR = new Float32Array(128), m = new Float32Array(128), t = names.map(() => []);
  let f = 0;
  for (let r = 0; r < 22; r++) {
    const acc = names.map(() => 0);
    for (let k = 0; k < 2000; k++) {
      for (let i = 0; i < 128; i++) { L[i] = 0.5 * Math.sin((f + i) * 0.02); R[i] = 0.4 * Math.sin((f + i) * 0.031); m[i] = (k & 7) < 2 ? Math.exp(-(i + (k & 1) * 128) / 100) : 0; }
      for (let j = 0; j < fxs.length; j++) { const a = now(); fxs[j].process(L, R, OL, OR, 128, f, m); acc[j] += now() - a; }
      f += 128;
    }
    if (r >= 2) acc.forEach((v, j) => t[j].push(v / 2000)); // first 2 rounds: warm-up
  }
  const res = Object.fromEntries(names.map((n, j) => [n, +median(t[j]).toFixed(2)]));
  console.log(JSON.stringify({ chain, usPerBlock: res, acidVsSmooth: +(res.acid / res.smooth).toFixed(2) }));
}
