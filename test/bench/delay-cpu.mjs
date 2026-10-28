// CPU per 128-frame stereo block: the delay's Insert (ASTRID) vs Send (Bass), filters and send mod (PR C).
// One engine per process, like one AudioWorklet scope: engines in one process share V8 feedback and optimised code
// (all closures come from createFxDsp's literals), so interleaving cases in one process measures a polymorphic mix
// (this bench's first version did, and showed Insert at +47 % for that reason alone). Median of 20 rounds of 2000
// blocks after 2 warm-up rounds. Delay only (drive, plate bypassed; 'hold') and the full chain ('run', all on).
// Usage: node test/bench/delay-cpu.mjs        (one child process per chain x case; prints one JSON line per chain)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFxDsp } from '../../src/dsp.js';

const DLY = [0, 0, 0, 1, 1, 0.75, 0.5, 0.4, 0, 0, 0.5, 0.5, 0, 0, 0, 100 / 99, 0, 0];
const ALL = [1, 12, -3, 0.8, 1, 0.75, 0.5, 0.4, 1, 0.02, 0.6, 0.7, 0.3, 0.35, 0, 100 / 99, 0, 0];
const CASES = { // tone, lowCut, mode, send, modSend, beatsFree ('old': an 18-value program)
  old: [], insert: [100 / 99, 0, 0, 1, 0, 0], 'insert+filters': [0.5, 120, 0, 1, 0, 0], send: [100 / 99, 0, 1, 1, 0, 0.3],
  'send+filters+mod': [0.5, 120, 1, 0.4, 0.5, 0.3],
};
const [chain, name] = process.argv.slice(2);
if (chain) {
  const now = () => Number(process.hrtime.bigint()) / 1e3, median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const fx = createFxDsp(48000, { bypassMode: chain === 'delay' ? 'hold' : 'run' });
  fx.setTempo(120, 0, true); fx.load((chain === 'delay' ? DLY : ALL).concat(CASES[name]), 0, true);
  const L = new Float32Array(128), R = new Float32Array(128), OL = new Float32Array(128), OR = new Float32Array(128), m = new Float32Array(128), t = [];
  let f = 0;
  for (let r = 0; r < 22; r++) {
    let acc = 0;
    for (let k = 0; k < 2000; k++) {
      for (let i = 0; i < 128; i++) { L[i] = 0.5 * Math.sin((f + i) * 0.02); R[i] = 0.4 * Math.sin((f + i) * 0.031); m[i] = (k & 7) < 2 ? Math.exp(-(i + (k & 1) * 128) / 100) : 0; }
      const a = now(); fx.process(L, R, OL, OR, 128, f, m); acc += now() - a; f += 128;
    }
    if (r >= 2) t.push(acc / 2000);
  }
  console.log(median(t).toFixed(2));
} else {
  const self = fileURLToPath(import.meta.url);
  for (const c of ['delay', 'full']) {
    const res = {};
    for (const n of Object.keys(CASES)) res[n] = +execFileSync(process.execPath, [self, c, n], { encoding: 'utf8' }).trim();
    console.log(JSON.stringify({ chain: c === 'delay' ? 'delay only' : 'full chain', usPerBlock: res }));
  }
}
