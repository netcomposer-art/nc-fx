// CPU per 128-frame stereo block, per effect, in the slot engine (one effect on at its starting dials, limiter off,
// bypass 'run'), and the empty chain. One engine per process, like one AudioWorklet scope (see delay-cpu.mjs for
// why). Median of 20 rounds of 2000 blocks after 2 warm-up rounds.
// Usage: node test/bench/effects-cpu.mjs          (one child process per effect; prints a table and one JSON line)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFxChainDsp } from '../../src/chain.js';
import { CATALOG } from '../../src/catalog.js';
import { newSlot, slotProgram } from '../../src/slots.js';

const which = process.argv[2];
if (which) {
  const now = () => Number(process.hrtime.bigint()) / 1e3, median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const fx = createFxChainDsp(48000, { bypassMode: 'run' });
  fx.setTempo(120, 0, true);
  if (which !== 'empty') {
    const s = newSlot(which);
    if (which === 'eq') Object.assign(s.dials, { low_db: 4, mid_db: -3, high_db: 2 });  // flat EQ is a wire: make it work
    if (which === 'compressor') Object.assign(s.dials, { threshold_db: -24, ratio: 60 });
    if (which === 'width') s.dials.width = 150;
    if (which === 'drive') s.dials.drive_db = 12;
    if (which === 'lowpass' || which === 'highpass') s.dials.cutoff = 50;
    if (which === 'delay' || which === 'plate') s.dials.mix = 40;
    fx.add(1, which, 0);
    for (const [k, v] of slotProgram(s)) fx.set(1, k, v, 0, true);
    fx.order([1], 0, true);
  }
  const L = new Float32Array(128), R = new Float32Array(128), OL = new Float32Array(128), OR = new Float32Array(128), t = [];
  let f = 0;
  for (let r = 0; r < 22; r++) {
    let acc = 0;
    for (let k = 0; k < 2000; k++) {
      for (let i = 0; i < 128; i++) { L[i] = 0.5 * Math.sin((f + i) * 0.02); R[i] = 0.4 * Math.sin((f + i) * 0.031); }
      const a = now(); fx.process(L, R, OL, OR, 128, f); acc += now() - a; f += 128;
    }
    if (r >= 2) t.push(acc / 2000);
  }
  console.log(median(t).toFixed(2));
} else {
  const self = fileURLToPath(import.meta.url), res = {};
  for (const n of ['empty', ...CATALOG.map((e) => e.type)]) res[n] = +execFileSync(process.execPath, [self, n], { encoding: 'utf8' }).trim();
  for (const [n, v] of Object.entries(res)) console.log(`${n.padEnd(12)} ${v.toFixed(2).padStart(6)} µs / 128-frame block`);
  console.log(JSON.stringify({ usPerBlock: res }));
}
