// Heap-delta allocation gate for the slot engine (createFxChainDsp), the method of alloc-gate.mjs: fixed 64 MB young
// generation, one scenario per process, 0 B in at least one 10 000-block window after warm-up.
// Run: node --expose-gc --min-semi-space-size=64 --max-semi-space-size=64 test/bench/alloc-gate-slots.mjs <scenario>
// Scenarios: one per catalog type (that effect between two others, every dial and its bypass moving), and 'ops'
// (add, remove and reorder while playing, every box cycling through types).
import { PerformanceObserver } from 'node:perf_hooks';
import { createFxChainDsp } from '../../src/chain.js';
import { CATALOG, dialDsp } from '../../src/catalog.js';
import { newSlot, slotProgram } from '../../src/slots.js';

const BLOCKS = 10000, WARM = +(process.env.WARM || 20000), TRIES = +(process.env.TRIES || 3);
function window(step) {
  let i = 0;
  for (; i < WARM; i++) step(i);
  let gcs = 0;
  const bytes = new Array(TRIES).fill(0);
  const obs = new PerformanceObserver((l) => { gcs += l.getEntries().length; });
  globalThis.gc(); globalThis.gc();
  obs.observe({ entryTypes: ['gc'] });
  for (let t = 0; t < TRIES; t++) {
    const a = process.memoryUsage().heapUsed;
    const probe = process.memoryUsage().heapUsed - a;
    const start = process.memoryUsage().heapUsed;
    for (let k = 0; k < BLOCKS; k++, i++) step(i);
    bytes[t] = Math.max(0, process.memoryUsage().heapUsed - start - probe);
  }
  gcs += obs.takeRecords().length;
  obs.disconnect();
  return { bytes, min: Math.min(...bytes), gcs };
}
function sine(b, f) { for (let i = 0; i < b.length; i++) b[i] = Math.sin((f + i) * 0.05) * 0.5; }
function load(fx, uid, type) { fx.add(uid, type, 0); for (const [k, v] of slotProgram(newSlot(type))) fx.set(uid, k, v, 0, true); }

// Event values arrive boxed in a worklet (out of a message): pre-boxed here too, so the harness adds nothing.
function effectScenario(type) {
  const e = CATALOG.find((x) => x.type === type);
  const fx = createFxChainDsp(48000, { limiter: 'lookahead', preGain: 0.8 });
  fx.setTempo(120, 0, true);
  load(fx, 1, 'eq'); load(fx, 2, type); load(fx, 3, 'plate');
  fx.set(1, 0, 1, 0, true); fx.set(2, 0, 1, 0, true); fx.set(3, 0, 1, 0, true);
  fx.order([1, 2, 3], 0, true);
  // Each dial at a few values across its range (DSP units), as boxed numbers.
  const moves = [];
  for (const d of e.dials) {
    const vals = d.options ? d.options.map((o) => o.value) : [d.min, (d.min + d.max) / 2, d.max, Math.round(d.min + (d.max - d.min) * 0.3)];
    for (const v of vals) moves.push([d.k, dialDsp(d, v)]);
  }
  const boxed = moves.map(([k, v]) => [k, { v }.v]);
  const L = new Float32Array(128), R = new Float32Array(128);
  let f = 0;
  return window((k) => {
    if (k % 3 === 0) { const m = boxed[(k / 3) % boxed.length]; fx.set(2, m[0], m[1], f + 40); }
    if (k % 97 === 0) fx.set(2, 0, (k / 97) & 1, f + 7);
    if (k % 211 === 0) fx.setTempo(100 + (k % 50), f + 3);
    sine(L, f); for (let i = 0; i < 128; i++) R[i] = L[i] * 0.6;
    fx.process(L, R, L, R, 128, f); f += 128;
  });
}
function opsScenario() {
  const fx = createFxChainDsp(48000, { limiter: 'soft' });
  fx.setTempo(120, 0, true);
  const types = CATALOG.map((e) => e.type);
  // The harness itself allocates nothing per step: the live uids in a ring (0 = none, which order() skips).
  const live = new Int32Array(3), ord = new Int32Array(3);
  let uid = 1, f = 0;
  const L = new Float32Array(128), R = new Float32Array(128);
  return window((k) => {
    if (k % 20 === 0) {
      // Replace the oldest effect with the next type (cycling every type through every box), then reorder.
      const n = k / 20, t = types[n % types.length], u = uid++;
      fx.add(u, t, f + 5);
      fx.set(u, 0, 1, f + 5, true);
      live[n % 3] = u;
      for (let j = 0; j < 3; j++) ord[j] = live[(j + n) % 3];
      fx.order(ord, f + 5);
    }
    if (k % 60 === 30) fx.clear(f + 2, k % 120 === 30 ? 4 : 0); // instant and faded clears
    sine(L, f); R.set(L);
    fx.process(L, R, L, R, 128, f); f += 128;
  });
}
const only = process.argv[2];
const r = only === 'ops' ? opsScenario() : effectScenario(only);
console.log(JSON.stringify({ scenario: only, blocks: BLOCKS, ...r }));
