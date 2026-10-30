// Heap-delta gate for the slot engine (test/bench/alloc-gate-slots.mjs; the method of test/alloc.test.mjs): every
// effect type, with every dial, its bypass and the tempo moving, allocates 0 B in a 10 000-block window. Adding,
// removing and reordering effects (an add every 20 blocks, a reorder, clears) stays within a few boxed numbers per
// add, on the control path, with no garbage collection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../src/catalog.js';

const GATE = fileURLToPath(new URL('./bench/alloc-gate-slots.mjs', import.meta.url));
const run = (scenario) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--min-semi-space-size=64', '--max-semi-space-size=64', GATE, scenario],
  { encoding: 'utf8', env: { ...process.env, TRIES: '12' } }).trim().split('\n').pop());

for (const { type } of CATALOG) {
  test(`slot engine heap-delta gate: 0 B and 0 GCs (${type}, dials, bypass and tempo moving)`, () => {
    const r = run(type);
    assert.equal(r.gcs, 0, `${r.gcs} GCs`);
    assert.equal(r.min, 0, `no allocation-free window: ${r.bytes.join(', ')} B per ${r.blocks} blocks`);
  });
}
test('slot engine heap-delta gate: add / reorder / clear cycles stay bounded (at most 64 B per add) with 0 GCs', () => {
  const r = run('ops');
  assert.equal(r.gcs, 0, `${r.gcs} GCs`);
  assert.ok(r.min <= 500 * 64, `${r.min} B per 500 adds`);
});
