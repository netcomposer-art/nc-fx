// No allocation on the audio path: after warm-up, tens of thousands of blocks (with parameter, tempo
// and bypass events landing mid-block) must not trigger a single garbage collection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceObserver } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { createFxDsp, FX_PARAM as P } from '../src/dsp.js';

async function gcsDuring(fn) {
  if (globalThis.gc) globalThis.gc();
  let n = 0;
  const obs = new PerformanceObserver((l) => { n += l.getEntries().length; });
  obs.observe({ entryTypes: ['gc'] });
  fn();
  await new Promise((r) => setTimeout(r, 20));
  obs.disconnect();
  return n;
}

for (const [limiter, bypassMode, withMod] of [[undefined, undefined], ['lookahead', 'hold'], ['soft', 'run'], ['off', 'hold'], ['lookahead', 'run', true]]) {
  const label = (limiter ? `limiter ${limiter}, bypass ${bypassMode}` : 'default options') + (withMod ? ', mod input present' : '');
  test(`process() does not allocate (${label})`, async () => {
    const fx = createFxDsp(48000, limiter ? { limiter, bypassMode } : undefined);
    fx.setTempo(120, 0, true);
    fx.load([1, 12, -3, 0.8, 1, 0.75, 0.5, 0.4, 1, 0.02, 0.6, 0.7, 0.3, 0.35], 0, true);
    const inL = new Float32Array(128).map((_, i) => Math.sin(i)), inR = inL.slice();
    const oL = new Float32Array(128), oR = new Float32Array(128);
    const mod = withMod ? new Float32Array(128).map((_, i) => (i < 40 ? 0.8 : 0)) : null;
    let f = 0;
    const run = (blocks) => {
      for (let b = 0; b < blocks; b++) {
        if (b % 50 === 0) {
          fx.set(P.DRIVE_DB, 6 + (b % 7), f + 64);
          fx.setTempo(100 + (b % 40), f + 10);
          fx.set(P.DELAY_ON, (b / 50) % 2 ? 0 : 1, f + 3);
          fx.set(P.PLATE_ON, (b / 100) % 2 < 1 ? 1 : 0, f + 100);
        }
        fx.process(inL, inR, oL, oR, 128, f, mod);
        f += 128;
      }
    };
    run(6000); // warm up: let the optimiser settle
    const gcs = await gcsDuring(() => run(30000)); // 80 s of audio
    assert.equal(gcs, 0, `${gcs} GCs while processing`);
  });
}

test('hot path has no allocating syntax (static scan of the per-sample code)', () => {
  const src = readFileSync(new URL('../src/dsp.js', import.meta.url), 'utf8');
  const start = src.indexOf('// ---- Per-sample stages');
  const end = src.indexOf('var api = {');
  assert.ok(start > 0 && end > start);
  const hot = src.slice(start, end) + src.slice(src.indexOf('process: function'));
  for (const bad of [/\bnew\s/, /\[\s*\]/, /\{\s*\}/, /=>/, /\.\.\./, /\.(map|filter|slice|concat|forEach|reduce|push|splice)\(/, /`/, /\bJSON\./]) {
    assert.ok(!bad.test(hot), `hot path matches ${bad}`);
  }
});

// Heap-delta gate (Petra's review, Rhythm's perf:gate method): each scenario in its own process with a fixed
// 64 MB young generation, so nothing is collected inside a window and the heapUsed delta is every byte the
// engine allocated. The first windows still carry JIT tiering (compiled code; on Node 22 up to ~5 windows
// after warm-up, from deopts when bypass toggles first hit cold branches), so the gate is that one of 12
// 10 000-block window after warm-up allocates exactly 0 B: any per-block or per-event allocation would show
// up in every window. Event values are pre-boxed, as they are in a worklet, so the harness adds nothing.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const GATE = fileURLToPath(new URL('./bench/alloc-gate.mjs', import.meta.url));
for (const scenario of ['steady', 'events', 'tempo', 'sparse', 'holdToggles', 'clearFade', 'modInput']) {
  test(`heap-delta gate: 0 B and 0 GCs (${scenario})`, () => {
    const out = execFileSync(process.execPath, ['--expose-gc', '--min-semi-space-size=64', '--max-semi-space-size=64', GATE, scenario],
      { encoding: 'utf8', env: { ...process.env, TRIES: '12' } });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.gcs, 0, `${r.gcs} GCs`);
    assert.equal(r.min, 0, `no allocation-free window: ${r.bytes.join(', ')} B per ${r.blocks} blocks`);
  });
}
