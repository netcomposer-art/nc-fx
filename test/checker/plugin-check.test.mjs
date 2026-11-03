// Runs after the main suite (npm test), not beside it: each check spawns processes and an allocation gate, and the
// main suite's heap-delta gates are sensitive to CPU contention.
// nc-fx-check (scripts/check-plugin.mjs): the tremolo passes; each broken fixture fails on the check that names its
// mistake, with a fix, a nonzero exit and JSON an agent can read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECK = fileURLToPath(new URL('../../scripts/check-plugin.mjs', import.meta.url));
const dir = (n) => fileURLToPath(new URL(`../fixtures/plugins/${n}`, import.meta.url));
function check(name, ...extra) {
  const r = spawnSync(process.execPath, [CHECK, dir(name), '--json', '--no-browser', ...extra], { encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: JSON.parse(r.stdout) };
}

test('the tremolo passes every check (exit 0)', () => {
  const { code, out } = check('tremolo');
  assert.equal(code, 0, JSON.stringify(out.checks.filter((c) => !c.ok)));
  assert.equal(out.ok, true);
  for (const id of ['manifest', 'dsp-file', 'register', 'create', 'nan-inf', 'level', 'denormal-out', 'input', 'runaway', 'clicks', 'block-size', 'cpu', 'denormal-cpu', 'alloc', 'engine', 'bypass'])
    assert.ok(out.checks.some((c) => c.id === id && c.ok), id);
});

for (const [name, failing] of [['nan', 'nan-inf'], ['alloc', 'alloc'], ['click', 'clicks'], ['mismatch', 'register'], ['throws', 'nan-inf']]) {
  test(`${name}: fails on ${failing}, with a fix (exit 1)`, () => {
    const { code, out } = check(name);
    assert.equal(code, 1);
    assert.equal(out.ok, false);
    const c = out.checks.find((x) => x.id === failing);
    assert.ok(c && !c.ok && c.level === 'fail' && c.fix, JSON.stringify(out.checks.filter((x) => !x.ok)));
  });
}

test('stuck: a plugin stuck in an infinite loop fails (the loop guard stops it) instead of hanging the checker', () => {
  const t0 = Date.now();
  const { code, out } = check('stuck');
  assert.equal(code, 1);
  const c = out.checks.find((x) => x.id === 'nan-inf');
  assert.ok(c && !c.ok && /stuck in a loop/.test(c.detail ?? c.message ?? JSON.stringify(c)) && /loop/.test(c.fix), JSON.stringify(c));
  assert.ok(Date.now() - t0 < 60000, 'it ends');
});

test('a CPU budget it cannot meet fails the cpu check', () => {
  const { code, out } = check('tremolo', '--budget-us', '0.01');
  assert.equal(code, 1);
  assert.ok(out.checks.find((c) => c.id === 'cpu' && !c.ok));
});

test('usage: no target exits 2', () => {
  assert.equal(spawnSync(process.execPath, [CHECK], { encoding: 'utf8' }).status, 2);
});
