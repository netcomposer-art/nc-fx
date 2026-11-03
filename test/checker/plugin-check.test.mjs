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
  assert.equal(out.checks.length, 16); // 17 with the browser part (below)
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

test('stuck-regex: a check that hangs (a regular expression no loop guard sees) times out, fails, and the rest still run', () => {
  const t0 = Date.now();
  const { code, out } = check('stuck-regex', '--timeout', '2');
  const took = Date.now() - t0;
  assert.equal(code, 1);
  assert.equal(out.ok, false);
  // It passes its input for 1000 blocks, then hangs: the long checks (runaway, cpu, alloc) get there, the 1 s ones don't.
  for (const id of ['runaway', 'cpu', 'denormal-cpu', 'alloc']) {
    const c = out.checks.find((x) => x.id === id);
    assert.ok(c && !c.ok && c.level === 'fail' && /^Timed out after 2 s: the plugin may hang \(for example a regular expression that never finishes\)/.test(c.message) && c.fix, JSON.stringify(c));
  }
  for (const id of ['nan-inf', 'clicks', 'block-size', 'engine', 'bypass'])
    assert.ok(out.checks.some((c) => c.id === id && c.ok), `${id} still ran after the time-out`);
  assert.ok(took < 40000, `it ends within the budget (${took} ms)`);
});

// With a real Chromium: 17 of 17. Where Chromium is not installed (the CI test job), the browser check is skipped.
for (const extra of [[], ['--browser']]) {
  test(`the tremolo passes all 17 checks with the browser part (${extra.length ? '--browser' : 'no flag'})`, (t) => {
    const r = spawnSync(process.execPath, [CHECK, dir('tremolo'), '--json', ...extra], { encoding: 'utf8', timeout: 180000 });
    const out = JSON.parse(r.stdout);
    const b = out.checks.find((c) => c.id === 'browser');
    if (b && (b.level === 'skip' || /could not run|not installed/.test(b.message))) return t.skip(`no Chromium here: ${b.message}`);
    assert.equal(r.status, 0, JSON.stringify(out.checks.filter((c) => !c.ok)));
    assert.equal(out.checks.length, 17);
    assert.ok(out.checks.every((c) => c.ok && c.level === 'pass'), JSON.stringify(out.checks.filter((c) => c.level !== 'pass')));
  });
}

test('--timeout must be a number of seconds', () => {
  assert.equal(spawnSync(process.execPath, [CHECK, dir('tremolo'), '--no-browser', '--timeout', 'soon'], { encoding: 'utf8' }).status, 2);
});

test('a CPU budget it cannot meet fails the cpu check', () => {
  const { code, out } = check('tremolo', '--budget-us', '0.01');
  assert.equal(code, 1);
  assert.ok(out.checks.find((c) => c.id === 'cpu' && !c.ok));
});

test('usage: no target exits 2', () => {
  assert.equal(spawnSync(process.execPath, [CHECK], { encoding: 'utf8' }).status, 2);
});
