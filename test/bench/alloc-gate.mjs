// Heap-delta allocation gate (Rhythm's perf:gate method, from Petra's nc-fx review): fixed 64 MB young
// generation, so no scavenge runs inside a window and the heapUsed delta is every byte allocated.
// Run: node --expose-gc --min-semi-space-size=64 --max-semi-space-size=64 test/bench/alloc-gate.mjs [scenario]
// Each scenario runs in its own process, like each AudioWorklet. Prints one JSON line per scenario.
import { PerformanceObserver } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFxDsp, FX_PARAM as P } from '../../src/dsp.js';

const BLOCKS = 10000, WARM = +(process.env.WARM || 20000), TRIES = +(process.env.TRIES || 3);
const PROG = [1, 12, -3, 0.8, 1, 0.75, 0.5, 0.4, 1, 0.02, 0.6, 0.7, 0.3, 0.35];
// Event values arrive boxed in a worklet (they come out of a message). Keep them boxed here too, in a
// generic array, so the harness doesn't allocate a number for every call and the delta is the engine's.
const BOXED = ['x', 0.2, 0.35, 0.5, 0.65, 0.8, 97.5, 101.25, 130.5, 133.33, 174.6];
const val = (k) => BOXED[1 + (k % 5)];
const bpm = (k) => BOXED[6 + (k % 5)];
// More pre-boxed values for the moving-parameter scenarios: 0.3 + (k % 5) / 10 or (k % 9) / 9 computed per call is a
// fresh HeapNumber in the harness (34,696 B over the delaySendMod window at TRIES=3, Zeta's PR C review), not the engine.
// Each array leads with a string so its elements are generic (boxed): an all-double literal gets unboxed
// PACKED_DOUBLE_ELEMENTS, and reading one out to pass to set() boxes it again, so the 34,696 B stayed.
const FREE = ['x', 0.3, 0.4, 0.5, 0.6, 0.7]; // delay free time, beats: FREE[1 + k % 5]
const NINTHS = ['x', 0, 1 / 9, 2 / 9, 3 / 9, 4 / 9, 5 / 9, 6 / 9, 7 / 9, 8 / 9]; // tones: NINTHS[1 + k % 9]
const DRV = ['x', 6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6]; // drive dB: DRV[1 + k % 7]

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
    const probe = process.memoryUsage().heapUsed - a; // what reading heapUsed costs
    const start = process.memoryUsage().heapUsed;
    for (let k = 0; k < BLOCKS; k++, i++) step(i);
    const end = process.memoryUsage().heapUsed;
    bytes[t] = Math.max(0, end - start - probe);
  }
  gcs += obs.takeRecords().length;
  obs.disconnect();
  return { bytes, min: Math.min(...bytes), gcs };
}
function mk(opts) { const fx = createFxDsp(48000, opts); fx.setTempo(174, 0, true); fx.load(PROG, 0, true); return fx; }
function sine(b, f) { for (let i = 0; i < b.length; i++) b[i] = Math.sin((f + i) * 0.05) * 0.5; }

const SCENARIOS = {
  steady: () => { const fx = mk({ limiter: 'soft' }); const b = new Float32Array(128); let f = 0;
    return window(() => { sine(b, f); fx.process(b, null, b, null, 128, f); f += 128; }); },
  events: () => { const fx = mk({ limiter: 'lookahead' }); const L = new Float32Array(128), R = new Float32Array(128); let f = 0;
    return window((k) => {
      if (k % 4 === 0) {
        fx.set(P.DRIVE_DB, 6 + (k % 7), f + 64);
        fx.set(P.PLATE_MIX, val(k), f + 90);
        fx.setTempo(bpm(k), f + 10);
        fx.set(P.DELAY_ON, (k >> 2) & 1, f + 3);
        fx.set(P.DELAY_MIX, val(k + 1));          // now
        fx.set(P.PLATE_SIZE, val(k + 2), f + 200); // next block
      }
      sine(L, f); R.set(L); fx.process(L, R, L, R, 128, f); f += 128;
    }); },
  tempo: () => { const fx = mk({ limiter: 'soft' }); const b = new Float32Array(128); let f = 0;
    return window((k) => { fx.setTempo(bpm(k), f + (k % 128)); sine(b, f); fx.process(b, null, b, null, 128, f); f += 128; }); },
  holdToggles: () => { const fx = mk({ limiter: 'lookahead', bypassMode: 'hold' }); const L = new Float32Array(128), R = new Float32Array(128); let f = 0;
    return window((k) => { if (k % 200 === 0) { fx.set(P.DELAY_ON, (k / 200) & 1, f); fx.set(P.PLATE_ON, (k / 200) & 1, f + 5); } sine(L, f); R.set(L); fx.process(L, R, L, R, 128, f); f += 128; }); },
  sparse: () => { const fx = mk({ limiter: 'soft' }); const b = new Float32Array(128); let f = 0;
    return window((k) => { if (k % 16 === 0) fx.set(P.DRIVE_DB, 12, f + 64); sine(b, f); fx.process(b, null, b, null, 128, f); f += 128; }); },
  modInput: () => { const fx = mk({ limiter: 'lookahead' }); const L = new Float32Array(128), R = new Float32Array(128), m = new Float32Array(128); let f = 0;
    return window((k) => { if (k % 4 === 0) fx.set(P.DRIVE_DB, 6 + (k % 7), f + 64); for (let i = 0; i < 128; i++) m[i] = (k & 3) === 0 ? 0.9 * Math.exp(-i / 40) : 0;
      sine(L, f); R.set(L); fx.process(L, R, L, R, 128, f, m); f += 128; }); },
  // PR B: Acid curve + tone + accent -> drive and -> tone, a moving CV every block, drive and tone moved too.
  acidMod: () => { const fx = mk({ limiter: 'lookahead' }); const L = new Float32Array(128), R = new Float32Array(128), m = new Float32Array(128); let f = 0;
    fx.load([1, 12, 0, 1, 0, 0.75, 0.35, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0.5, 0.6, 0.4], f, true);
    return window((k) => { if (k % 4 === 0) { fx.set(P.DRIVE_DB, DRV[1 + (k % 7)], f + 64); fx.set(P.DRIVE_TONE, NINTHS[1 + (k % 9)], f + 30); }
      for (let i = 0; i < 128; i++) m[i] = 0.9 * Math.exp(-(i + (k & 3) * 128) / 160);
      sine(L, f); for (let i = 0; i < 128; i++) R[i] = L[i] * 0.7; fx.process(L, R, L, R, 128, f, m); f += 128; }); },
  // PR C: Send delay with tone + low cut, free time moving and the accent on the send (mod route 2).
  delaySendMod: () => { const fx = mk({ limiter: 'soft' }); const L = new Float32Array(128), R = new Float32Array(128), m = new Float32Array(128); let f = 0;
    fx.load([0, 0, 0, 1, 1, 0.75, 0.6, 1, 0, 0, 0.5, 0.5, 0, 0, 0, 100 / 99, 0, 0, 0.5, 120, 1, 0.4, 0.6, 0.3], f, true);
    return window((k) => { if (k % 8 === 0) { fx.set(P.DELAY_BEATS_FREE, FREE[1 + (k % 5)], f + 50); fx.set(P.DELAY_TONE, NINTHS[1 + (k % 9)], f + 20); fx.set(P.DELAY_LOW_CUT, 20 + (k % 7) * 50, f + 90); }
      if (k % 64 === 0) { fx.set(P.DELAY_MODE, (k / 64) % 2, f + 5); fx.setTempo(110 + (k % 30), f + 40); }
      for (let i = 0; i < 128; i++) m[i] = 0.9 * Math.exp(-(i + (k & 3) * 128) / 160);
      sine(L, f); for (let i = 0; i < 128; i++) R[i] = L[i] * 0.7; fx.process(L, R, L, R, 128, f, m); f += 128; }); },
  clearFade: () => { const fx = mk({ limiter: 'soft' }); const b = new Float32Array(128); let f = 0;
    return window((k) => { if (k % 300 === 0) fx.clear(f + 7, 5); if (k % 300 === 150) fx.clear(); sine(b, f); fx.process(b, null, b, null, 128, f); f += 128; }); },
};

const only = process.argv[2];
if (only) console.log(JSON.stringify({ scenario: only, blocks: BLOCKS, ...SCENARIOS[only]() }));
else for (const name of Object.keys(SCENARIOS)) {
  const out = execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), name], { encoding: 'utf8' });
  console.log(out.trim().split('\n').pop());
}
