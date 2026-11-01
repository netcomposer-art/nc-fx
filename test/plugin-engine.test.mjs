// Plugins in the slot engine (src/plugin-host.js + src/chain.js): a plugin box next to built-in ones, the guard
// (auto-bypass on a throw, NaN or runaway, reported once), bypass bit-transparent, 'hold' sleeping, and no allocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFxChainDsp } from '../src/chain.js';
import { registerNcFxPlugin, pluginCode, NC_PLUGINS } from '../src/plugin-host.js';
import { slotProgram, newSlot } from '../src/slots.js';
import { noiseBursts } from './helpers.mjs';

const SR = 48000;
// A pass-through, a gain, and plugins that fail in each way the guard knows.
registerNcFxPlugin({ id: 'test.wire', version: '1.0.0', params: [], create: () => ({ process(a, b, c, d, n) { for (let i = 0; i < n; i++) { c[i] = a[i]; d[i] = b[i]; } } }) });
registerNcFxPlugin({ id: 'test.gain', version: '1.0.0', params: ['gain'], create: () => { const s = new Float64Array([1]); return { set(k, v) { s[0] = v; }, process(a, b, c, d, n) { for (let i = 0; i < n; i++) { c[i] = a[i] * s[0]; d[i] = b[i] * s[0]; } } }; } });
let calls = 0;
registerNcFxPlugin({ id: 'test.nan', version: '1.0.0', params: [], create: () => ({ process(a, b, c, d, n) { calls++; for (let i = 0; i < n; i++) { c[i] = calls > 10 ? NaN : a[i]; d[i] = b[i]; } } }) });
registerNcFxPlugin({ id: 'test.throw', version: '1.0.0', params: [], create: () => ({ process() { throw new Error('boom'); } }) });
registerNcFxPlugin({ id: 'test.loud', version: '1.0.0', params: [], create: () => ({ process(a, b, c, d, n) { for (let i = 0; i < n; i++) { c[i] = 100; d[i] = 100; } } }) });
registerNcFxPlugin({ id: 'test.nocreate', version: '1.0.0', params: [], create: () => { throw new Error('no'); } });

const name = (id) => `plugin:test.${id}@1.0.0`;
function run(dsp, inL, inR, block = 128, onBlock) {
  const n = inL.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0, b = 0; o < n; o += block, b++) {
    if (onBlock) onBlock(b, o);
    const e = Math.min(n, o + block);
    dsp.process(inL.subarray(o, e), inR.subarray(o, e), oL.subarray(o, e), oR.subarray(o, e), e - o, o);
  }
  return [oL, oR];
}
function chain(items, opts) {
  const dsp = createFxChainDsp(SR, { slots: 8, ...opts });
  items.forEach(([type, program], i) => {
    assert.ok(dsp.add(i + 1, type, 0), `add ${type}`);
    for (const [k, v] of program) dsp.set(i + 1, k, v, 0, true);
  });
  dsp.order(items.map((_, i) => i + 1), 0, true);
  return dsp;
}
const close = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1e-6);
const same = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

test('registerNcFxPlugin: refuses bad definitions, keeps one per id@version', () => {
  assert.equal(registerNcFxPlugin({ id: 'Bad Id', version: '1.0.0', params: [], create() {} }), false);
  assert.equal(registerNcFxPlugin({ id: 'test.x', version: '1', params: [], create() {} }), false);
  assert.equal(registerNcFxPlugin({ id: 'test.x', version: '1.0.0', params: new Array(16).fill('a'), create() {} }), false);
  const n = NC_PLUGINS.length;
  assert.equal(registerNcFxPlugin({ id: 'test.wire', version: '1.0.0', params: [], create() {} }), true);
  assert.equal(NC_PLUGINS.length, n);
  assert.ok(pluginCode(name('wire')) >= 12);
  assert.equal(pluginCode('plugin:test.none@1.0.0'), -1);
  assert.equal(createFxChainDsp(SR).add(1, 'plugin:test.none@1.0.0', 0), false);
});

test('built-in boxes sound the same with a plugin in the chain (bypassed plugin = no plugin), any block size', () => {
  const [L, R] = noiseBursts(SR * 2, 3);
  const chorus = newSlot('chorus', []); chorus.dials.mix = 60;
  const delay = newSlot('delay', []); delay.dials.mix = 40;
  const ref = run(chain([['chorus', slotProgram(chorus)], ['delay', slotProgram(delay)]], { limiter: 'lookahead' }), L, R);
  for (const block of [128, 37]) {
    const got = run(chain([['chorus', slotProgram(chorus)], [name('wire'), [[0, 0]]], ['delay', slotProgram(delay)]], { limiter: 'lookahead' }), L, R, block);
    assert.ok(same(ref[0], got[0]) && same(ref[1], got[1]), `block ${block}`);
    // A plugin that is on and passes its input through: also identical.
    // A plugin that is on and passes its input through: the same within float32 rounding (a plugin's buffers are
    // Float32Array, as an AudioWorklet's are; the chain between built-in boxes is double).
    const on = run(chain([['chorus', slotProgram(chorus)], [name('wire'), [[0, 1]]], ['delay', slotProgram(delay)]], { limiter: 'lookahead' }), L, R, block);
    assert.ok(close(ref[0], on[0]) && close(ref[1], on[1]), `on, block ${block}`);
  }
});

test('a reorder with a plugin fades and swaps like the built-in chain', () => {
  const [L, R] = noiseBursts(SR, 9);
  const eq = newSlot('eq', []); eq.dials.low_db = 6;
  const a = chain([['eq', slotProgram(eq)], [name('gain'), [[0, 1], [1, 1]]]]);
  const b = chain([['eq', slotProgram(eq)], ['width', [[0, 1], [1, 1], [2, 0]]]]);
  const flip = (dsp) => (blk) => { if (blk === 40) dsp.order([2, 1], 0, false); };
  const oa = run(a, L, R, 128, flip(a)), ob = run(b, L, R, 128, flip(b));
  // The gain plugin at 1 and width at 100 % are both wires: the outputs, fades included, are the same (to float32).
  assert.ok(close(oa[0], ob[0]) && close(oa[1], ob[1]));
  assert.deepEqual(a.playing(), [2, 1]);
});

test('bypassed: the output is the input, bit for bit (run and hold), and switching is click-free', () => {
  const [L, R] = noiseBursts(SR, 4);
  for (const bypassMode of ['run', 'hold']) {
    const [oL, oR] = run(chain([[name('gain'), [[0, 0], [1, 0.25]]]], { bypassMode }), L, R);
    assert.ok(same(oL, L) && same(oR, R), bypassMode);
  }
  const dsp = chain([[name('gain'), [[0, 0], [1, 0]]]]);
  const dc = new Float32Array(SR).fill(0.5);
  const [o] = run(dsp, dc, dc, 128, (b) => { if (b === 10) dsp.set(1, 0, 1, 0, false); });
  let step = 0;
  for (let i = 1; i < o.length; i++) step = Math.max(step, Math.abs(o[i] - o[i - 1]));
  assert.ok(step < 0.002, `largest step ${step}`);
  assert.ok(Math.abs(o[o.length - 1]) < 1e-6, 'fully on at the end: gain 0');
});

for (const [id, code, what] of [['nan', 3, 'NaN'], ['throw', 2, 'a throw'], ['loud', 3, 'runaway level'], ['nocreate', 1, 'create() throwing']]) {
  test(`auto-bypass on ${what}: the slot passes its input, the chain plays on, reported once (code ${code})`, () => {
    calls = 0;
    const [L, R] = noiseBursts(SR / 2, 5);
    const dsp = chain([['width', [[0, 1], [1, 1], [2, 0]]], [name(id), [[0, 1]]]]);
    const errs = new Int32Array(36);
    let reports = 0, got = null;
    const [oL] = run(dsp, L, R, 128, () => {
      if (dsp.errorsPending[0] > 0) { const n = dsp.takeErrors(errs); reports += n; got = [errs[0], errs[1]]; }
    });
    if (dsp.errorsPending[0] > 0) { reports += dsp.takeErrors(errs); got = [errs[0], errs[1]]; }
    assert.equal(reports, 1);
    assert.deepEqual(got, [2, code]);
    assert.ok(oL.every((x) => Number.isFinite(x) && Math.abs(x) <= 1));
    // From the failure on, the box is a wire: the last half matches the dry input exactly.
    assert.ok(same(oL.subarray(SR / 4), L.subarray(SR / 4)));
  });
}

test('the guard: a fresh add of a failed plugin gets a fresh chance; an instant clear calls reset()', () => {
  let resets = 0;
  registerNcFxPlugin({ id: 'test.reset', version: '1.0.0', params: [], create: () => ({ reset() { resets++; }, process(a, b, c, d, n) { for (let i = 0; i < n; i++) { c[i] = a[i]; d[i] = b[i]; } } }) });
  const dsp = chain([[name('reset'), [[0, 1]]]]);
  const z = new Float32Array(128);
  dsp.process(z, z, new Float32Array(128), new Float32Array(128), 128, 0);
  const before = resets;
  dsp.clear(0);
  dsp.process(z, z, new Float32Array(128), new Float32Array(128), 128, 128);
  assert.equal(resets, before + 1);
});

const gate = (kind, scenario) => {
  const file = fileURLToPath(new URL('./bench/plugin-alloc-gate.mjs', import.meta.url));
  const out = execFileSync(process.execPath, ['--expose-gc', '--min-semi-space-size=64', '--max-semi-space-size=64', file, kind, scenario], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
};
test('heap-delta gate: a chain with a plugin renders with 0 B allocated', () => {
  const r = gate('plugin', 'steady');
  assert.equal(r.median, 0, `bytes per window: ${r.bytes.join(', ')}`);
});
test('heap-delta gate: a plugin\'s dial, bypass and order events cost no more than a built-in box\'s', () => {
  const p = gate('plugin', 'events'), b = gate('builtin', 'events');
  assert.ok(p.median <= b.median + 1024, `plugin ${p.median} B, built-in ${b.median} B per 2000 blocks`);
});

test('hot path has no allocating syntax (static scan of plugin-host run() and chain renderPlug())', () => {
  const host = readFileSync(new URL('../src/plugin-host.js', import.meta.url), 'utf8');
  const chainSrc = readFileSync(new URL('../src/chain.js', import.meta.url), 'utf8');
  const hot = host.slice(host.indexOf('function run('), host.indexOf('function ctl(')) + chainSrc.slice(chainSrc.indexOf('function renderPlug('), chainSrc.indexOf('// Plugin errors'));
  for (const bad of [/\bnew\s/, /\[\s*\]/, /\{\s*\}/, /=>/, /\.\.\./, /\.(map|filter|slice|concat|forEach|reduce|push|splice)\(/, /`/]) assert.ok(!bad.test(hot), `matches ${bad}`);
});
