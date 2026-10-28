// Mod input plumbing (design-addendum-bass-gaps.md, PR A): fx.modInput -> node input 1 -> process()'s 7th
// argument -> the mod bus (src/mod.js). Nothing is routed yet, so with the mod signal absent, present and
// silent, or present and moving, every sample is bit-identical to the engine without it, at any block size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createFxDsp } from '../src/dsp.js';
import { createModBus, modRoute, modBlock, MOD_MAX_ROUTES, MOD_FIXED_ROUTES, MOD_SOURCES } from '../src/mod.js';
import { createFxCore } from '../src/index.js';
import { compile, defaultState } from '../src/params.js';
import source from '../dist/worklet-source.js';
import { mockContext } from './mock-audio.mjs';
import { SR, noiseBursts, identical } from './helpers.mjs';

const ALL_ON = [1, 12, -3, 0.8, 1, 0.75, 0.5, 0.4, 1, 0.02, 0.6, 0.7, 0.3, 0.35];
/** Bass-like accent CV: a decaying envelope on every 16th at 174 bpm, accented on every 3rd note. */
function accentCv(n) {
  const step = Math.round(SR * 60 / 174 / 4), cv = new Float32Array(n);
  for (let i = 0; i < n; i++) { const k = Math.floor(i / step); cv[i] = k % 3 === 0 ? 0.9 * Math.exp(-(i % step) / 1500) : 0; }
  return cv;
}
const MODS = { absent: () => null, 'present, silent': (n) => new Float32Array(n), 'present, moving': accentCv };
/** Renders through a fresh engine in chunks of `block` (or a repeating list of sizes), passing mod slices. */
function render(opts, program, inL, inR, mod, blocks = [128]) {
  const fx = createFxDsp(SR, opts); fx.setTempo(174, 0, true); fx.load(program, 0, true);
  const n = inL.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0, k = 0; o < n; k++) {
    const e = Math.min(n, o + blocks[k % blocks.length]);
    fx.process(inL.subarray(o, e), inR.subarray(o, e), oL.subarray(o, e), oR.subarray(o, e), e - o, o, mod ? mod.subarray(o, e) : mod);
    o = e;
  }
  return [oL, oR];
}

test('mod bus: idle until a route has a target and a depth, and only with a buffer covering the block', () => {
  assert.deepEqual(MOD_SOURCES, ['accent']);
  assert.equal(MOD_MAX_ROUTES, 8); assert.equal(MOD_FIXED_ROUTES, 3);
  const bus = createModBus(), cv = new Float32Array(128).fill(0.5);
  assert.deepEqual(Array.from(bus.RT), [0, 1, 2, -1, -1, -1, -1, -1], 'fixed routes 0-2 -> drive amount, drive tone, delay send');
  assert.ok(Array.from(bus.RD).every((d) => d === 0));
  assert.equal(modBlock(bus, cv, 128), 0, 'no depths')
  modRoute(bus, 0, 0, 7, 0); assert.equal(modBlock(bus, cv, 128), 0, 'zero depth');
  modRoute(bus, 4, 0, -1, 0.5); assert.equal(modBlock(bus, cv, 128), 0, 'no target');
  modRoute(bus, 4, 0, 3, 0.5);
  assert.equal(modBlock(bus, cv, 128), 1); assert.equal(bus.M[0], 1);
  assert.equal(modBlock(bus, null, 128), 0); assert.equal(modBlock(bus, undefined, 128), 0);
  assert.equal(modBlock(bus, cv.subarray(0, 64), 128), 0, 'shorter than the block');
  assert.equal(bus.M[0], 0);
  modRoute(bus, 4, 0, 3, NaN); assert.equal(bus.RD[4], 0);
  modRoute(bus, 8, 0, 3, 1); modRoute(bus, -1, 0, 3, 1); // out of range: ignored
  assert.equal(modBlock(bus, cv, 128), 0);
});

for (const [label, opts] of [['default options', undefined], ['ASTRID master (run, lookahead, preGain 0.8)', { bypassMode: 'run', limiter: 'lookahead', preGain: 0.8 }], ['hold, soft', { bypassMode: 'hold', limiter: 'soft' }]]) {
  test(`mod absent / present and silent / present and moving: bit-identical output (${label})`, () => {
    const [inL, inR] = noiseBursts(SR * 2, 7);
    const ref = render(opts, ALL_ON, inL, inR, null);
    for (const [name, mk] of Object.entries(MODS)) {
      const [L, R] = render(opts, ALL_ON, inL, inR, mk(inL.length));
      assert.ok(identical(L, ref[0]) && identical(R, ref[1]), name);
    }
  });
}

test('block sizes: 1, 7, 64, 128, 300 and a mixed list, with the mod present, match 128-frame blocks without it', () => {
  const [inL, inR] = noiseBursts(SR, 3), cv = accentCv(inL.length);
  const ref = render(undefined, ALL_ON, inL, inR, null);
  for (const blocks of [[1], [7], [64], [128], [300], [5, 128, 33, 1, 256]]) {
    const [L, R] = render(undefined, ALL_ON, inL, inR, cv, blocks);
    assert.ok(identical(L, ref[0]) && identical(R, ref[1]), `blocks ${blocks.join(',')}`);
  }
});

test('a mod buffer shorter than the block is ignored (no throw, same output)', () => {
  const [inL, inR] = noiseBursts(128 * 40, 5);
  const ref = render(undefined, ALL_ON, inL, inR, null);
  const fx = createFxDsp(SR); fx.setTempo(174, 0, true); fx.load(ALL_ON, 0, true);
  const short = new Float32Array(16).fill(1), oL = new Float32Array(inL.length), oR = new Float32Array(inL.length);
  for (let o = 0; o < inL.length; o += 128) fx.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), oL.subarray(o, o + 128), oR.subarray(o, o + 128), 128, o, short);
  assert.ok(identical(oL, ref[0]) && identical(oR, ref[1]));
});

test('mod bus check is allocation-free syntax (static scan of modBlock)', () => {
  const src = readFileSync(new URL('../src/mod.js', import.meta.url), 'utf8');
  const hot = src.slice(src.indexOf('export function modBlock'));
  for (const bad of [/\bnew\s/, /\[\s*\]/, /\{\s*\}/, /=>/, /\.\.\./, /\.(map|filter|slice|concat|forEach|reduce|push|splice)\(/, /`/]) assert.ok(!bad.test(hot), `modBlock matches ${bad}`);
});

// The processor in a simulated AudioWorkletGlobalScope (dist/worklet.js): it passes input 1's channel 0 as mod.
function processor(program) {
  const reg = {};
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage() {} }; } }
  const ctx = vm.createContext({ AudioWorkletProcessor, sampleRate: SR, currentFrame: 0, registerProcessor: (n, c) => { reg[n] = c; }, Math, Float32Array, Float64Array, Int32Array, Uint8Array });
  vm.runInContext(source, ctx);
  const p = new reg['nc-fx@1']({ processorOptions: { program, bpm: 120 } });
  const seen = [], real = p.dsp.process;
  p.dsp.process = function (...a) { seen.push(a[6]); return real.apply(this, a); };
  return { p, ctx, seen };
}
test('worklet: input 1 channel 0 reaches process() as mod; no channels (disconnected) or missing gives null; output unchanged', () => {
  const s = defaultState(); s.chain[0].bypass = false; s.chain[1].bypass = false; s.chain[1].dials.mix = 50;
  const program = Array.from(compile(s));
  const inL = new Float32Array(128).map((_, i) => Math.sin(i / 3)), inR = inL.map((v) => -v), cv = new Float32Array(128).fill(0.7);
  const ref = createFxDsp(SR); ref.setTempo(120, 0, true); ref.load(program, 0, true);
  const { p, ctx, seen } = processor(program);
  const shapes = [[[inL, inR], [cv]], [[inL, inR], []], [[inL, inR]], [[inL, inR], [cv, cv]]];
  for (let b = 0; b < 40; b++) {
    ctx.currentFrame = b * 128;
    const out = [new Float32Array(128), new Float32Array(128)], o2 = [new Float32Array(128), new Float32Array(128)];
    assert.equal(p.process(shapes[b % 4], [out]), true);
    ref.process(inL, inR, o2[0], o2[1], 128, b * 128);
    assert.ok(identical(out[0], o2[0]) && identical(out[1], o2[1]), `block ${b}`);
  }
  assert.ok(seen[0] === cv && seen[1] === null && seen[2] === null && seen[3] === cv);
});

test('core: modInput: true creates a mono fx.modInput wired to node input 1; default is null and one input', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', modInput: true });
  assert.ok(fx.modInput);
  assert.equal(fx.modInput.channelCount, 1);
  assert.equal(fx.modInput.channelCountMode, 'explicit');
  assert.equal(fx.modInput.channelInterpretation, 'discrete');
  await fx.ready;
  assert.equal(ctx.node.options.numberOfInputs, 2);
  assert.deepEqual(fx.modInput.links, [[ctx.node, 0, 1]]);
  assert.deepEqual(fx.input.links.filter((l) => l[0] === ctx.node), [[ctx.node, 0, 0]]);
  fx.dispose();
  assert.equal(fx.modInput.out.size, 0);

  const ctx2 = mockContext();
  const plain = createFxCore(ctx2, { moduleUrl: '/w.js' });
  assert.equal(plain.modInput, null);
  await plain.ready;
  assert.equal(ctx2.node.options.numberOfInputs, 1);
  for (const v of [false, 1, 'yes']) assert.equal(createFxCore(mockContext(), { modInput: v }).modInput, null);
});

test('zero CV with nonzero depths renders bit-identical to no mod (a never-connected modInput feeds silence)', () => {
  const n = 4 * 9600, [inL, inR] = noiseBursts(n, 3);
  const cases = {
    'Smooth + accent depths': [{ curve: 0, drive_db: 12, mod_drive: 70, mod_tone: -40, tone: 50 }, {}],
    'Acid + accent depths': [{ curve: 1, drive_db: 9.5, mod_drive: 100, mod_tone: 30, tone: 60 }, {}],
    'Insert delay + send mod': [{}, { mix: 40, send: 60, mod_send: 80, tone: 40, low_cut: 120 }],
    'Send delay + send mod': [{}, { mode: 1, mix: 100, send: 25, mod_send: -50, beats_free: 0.3 }]
  };
  for (const name in cases) {
    const s = defaultState();
    s.chain[0].bypass = false; Object.assign(s.chain[0].dials, cases[name][0]);
    s.chain[1].bypass = false; Object.assign(s.chain[1].dials, cases[name][1]);
    const program = compile(s);
    const a = render({}, program, inL, inR, null), b = render({}, program, inL, inR, new Float32Array(n));
    assert.ok(identical(a[0], b[0]) && identical(a[1], b[1]), name);
  }
});
