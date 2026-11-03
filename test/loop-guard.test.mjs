// The loop guard (src/loop-guard.js on the main thread, __ncFxLoop in src/plugin-host.js): every while, do-while and
// for(;;) condition gets one check; strings, comments, templates and regular expressions are left alone; the result
// still parses, keeps its lines, and a loop that runs past the budget throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardLoops, LOOP_GUARD } from '../src/loop-guard.js';
import { ncFxLoop } from '../src/plugin-host.js';

const G = `${LOOP_GUARD}()`;
const parses = (src) => { new Function(LOOP_GUARD, src); return true; };

test('wraps while, do-while and for(;;) conditions; leaves for-in, for-of and for await alone', () => {
  assert.equal(guardLoops('while (x < 3) x++;'), `while (${G} && (x < 3)) x++;`);
  assert.equal(guardLoops('do { i++ } while (i < n)'), `do { i++ } while (${G} && (i < n))`);
  assert.equal(guardLoops('for (let i = 0; i < n; i++) {}'), `for (let i = 0; ${G} && ( i < n); i++) {}`);
  assert.equal(guardLoops('for (;;) {}'), `for (; ${G};) {}`);
  for (const s of ['for (const k in o) {}', 'for (const v of a) {}', 'async function f() { for await (const x of y) {} }']) assert.equal(guardLoops(s), s);
});

test('skips loops inside strings, comments, regular expressions; finds them inside template expressions', () => {
  const s = 'const a = "while (1) {}"; const b = \'for (;;)\'; // while (true) {}\n/* for (;;) {} */ const r = /while (x)/g;';
  assert.equal(guardLoops(s), s);
  const t = guardLoops('const t = `x ${(() => { let i = 0; while (i < 2) i++; return i; })()} y while (z)`;');
  assert.equal(t, `const t = \`x \${(() => { let i = 0; while (${G} && (i < 2)) i++; return i; })()} y while (z)\`;`);
});

test('not a keyword after a dot; nested parens, brackets and strings in a for header; division vs regex', () => {
  assert.equal(guardLoops('a.while(1); b?.for(2);'), 'a.while(1); b?.for(2);');
  assert.equal(guardLoops('for (var i = 0, j = [1, 2].length; i < f(j, "a;b"); i++) {}'), `for (var i = 0, j = [1, 2].length; ${G} && ( i < f(j, "a;b")); i++) {}`);
  assert.equal(guardLoops('x = a / b / c; while (x / 2 > 1) x /= 2;'), `x = a / b / c; while (${G} && (x / 2 > 1)) x /= 2;`);
});

test('the result parses and keeps every line where it was', () => {
  const src = [
    'registerNcFxPlugin({ id: "a.b", version: "1.0.0", params: [], create: function (sr) {',
    '  var t = new Float32Array(4096); for (var i = 0; i < t.length; i++) t[i] = Math.sin(i);',
    '  return { process: function (a, b, c, d, n) {',
    '    var k = 0; do { k++; } while (k < 2);',
    '    for (var j = 0; j < n; j++) { c[j] = a[j]; d[j] = b[j]; }',
    '    outer: for (;;) { while (true) { break outer; } }',
    '  } };',
    '} });',
  ].join('\n');
  const g = guardLoops(src);
  assert.ok(parses(g));
  assert.equal(g.split('\n').length, src.split('\n').length);
  assert.equal((g.match(/__ncFxLoop\(\)/g) || []).length, 5);
});

test('guarded code runs as before, and an endless loop throws "stuck in a loop" once past the budget', () => {
  globalThis.__ncFxLoopStart(50);
  try {
    const sum = new Function(guardLoops('let s = 0; for (let i = 0; i < 100000; i++) s += i; return s;'));
    assert.equal(sum(), 4999950000);
  } finally { globalThis.__ncFxLoopEnd(); }
  const stuck = new Function(guardLoops('let x = 0; while (true) { x++; } return x;'));
  const t0 = Date.now();
  globalThis.__ncFxLoopStart(50);
  let tripped = 0;
  try { assert.throws(() => stuck(), /stuck in a loop/); } finally { tripped = globalThis.__ncFxLoopEnd(); }
  assert.equal(tripped, 1);
  const took = Date.now() - t0;
  assert.ok(took >= 50 && took < 2000, `stopped after ${took} ms`);
  assert.equal(globalThis.__ncFxLoop, ncFxLoop);
});

test('a plugin can\'t swallow it: after the first throw every check throws until the call ends', () => {
  const swallow = new Function(guardLoops('for (;;) { try { while (true) {} } catch (e) {} }'));
  globalThis.__ncFxLoopStart(20);
  try { assert.throws(() => swallow(), /stuck in a loop/); } finally { assert.equal(globalThis.__ncFxLoopEnd(), 1); }
});
