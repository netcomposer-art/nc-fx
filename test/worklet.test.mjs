// dist/worklet.js is fresh, self-contained, and runs as an AudioWorklet module (simulated scope).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import source from '../dist/worklet-source.js';
import { compile, defaultState } from '../src/params.js';
import { createFxDsp } from '../src/dsp.js';
import { identical } from './helpers.mjs';

const root = new URL('..', import.meta.url);

test('generated files match their sources (npm run build is up to date)', () => {
  execFileSync(process.execPath, ['scripts/build.mjs', '--check'], { cwd: root });
  assert.equal(readFileSync(new URL('dist/worklet.js', root), 'utf8'), source);
});

function scope() {
  const reg = {};
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage() {} }; } }
  const ctx = vm.createContext({ AudioWorkletProcessor, sampleRate: 48000, currentFrame: 0, registerProcessor: (n, c) => { if (reg[n]) throw new Error('dup'); reg[n] = c; }, Math, Float32Array, Float64Array, Int32Array, Uint8Array });
  vm.runInContext(source, ctx);
  return { reg, ctx };
}

test('registers nc-fx@1 with no imports, and renders like the engine', () => {
  assert.ok(!/^\s*(import|export)\b/m.test(source));
  const { reg, ctx } = scope();
  assert.deepEqual(Object.keys(reg), ['nc-fx@1']);
  const s = defaultState(); s.chain[2].bypass = false; s.chain[2].dials.mix = 50;
  const program = Array.from(compile(s));
  const p = new reg['nc-fx@1']({ processorOptions: { program, bpm: 100 } });
  const ref = createFxDsp(48000); ref.setTempo(100, 0, true); ref.load(program, 0, true);
  const inL = new Float32Array(128).map((_, i) => Math.sin(i / 3)), inR = inL.map((v) => -v);
  for (let b = 0; b < 20; b++) {
    ctx.currentFrame = b * 128;
    const out = [new Float32Array(128), new Float32Array(128)], o2 = [new Float32Array(128), new Float32Array(128)];
    assert.equal(p.process([[inL, inR]], [out]), true);
    ref.process(inL, inR, o2[0], o2[1], 128, b * 128);
    assert.ok(identical(out[0], o2[0]) && identical(out[1], o2[1]));
  }
  // Messages: when (seconds) becomes a frame; dispose ends the node.
  p.port.onmessage({ data: { t: 'p', i: 13, v: 0, when: 1 } });
  p.port.onmessage({ data: { t: 'tempo', bpm: 140 } });
  p.port.onmessage({ data: { t: 'dispose' } });
  assert.equal(p.process([[inL]], [[new Float32Array(128), new Float32Array(128)]]), false);
});

test('no input connected: renders tails from silence without throwing', () => {
  const { reg } = scope();
  const p = new reg['nc-fx@1']({});
  const out = [new Float32Array(128), new Float32Array(128)];
  assert.equal(p.process([[]], [out]), true);
  assert.ok(out[0].every((v) => v === 0));
});

// Pre-ready queue: processorOptions.pending replays in call order, future times exactly, past times at now.
function renderBoth(p, ref, ctx, startFrame, blocks, inL) {
  const outs = [], refs = [];
  for (let b = 0; b < blocks; b++) {
    const f = startFrame + b * 128;
    ctx.currentFrame = f;
    const x = inL.subarray(b * 128, b * 128 + 128);
    const out = [new Float32Array(128), new Float32Array(128)], o2 = [new Float32Array(128), new Float32Array(128)];
    p.process([[x, x]], [out]);
    ref.process(x, x, o2[0], o2[1], 128, f);
    outs.push(out[0]); refs.push(o2[0]);
  }
  const cat = (a) => { const r = new Float32Array(a.length * 128); a.forEach((v, i) => r.set(v, i * 128)); return r; };
  return [cat(outs), cat(refs)];
}
const delayOn = () => { const s = defaultState(); s.chain[1].bypass = false; s.chain[1].dials.mix = 0; s.chain[1].dials.feedback = 0; return Array.from(compile(s)); };
const clicks = (n) => { const x = new Float32Array(n); for (let i = 0; i < n; i += 6000) x[i] = 0.5; return x; };

test('pending: a future time is applied exactly at its frame (bit-identical to the engine)', () => {
  const { reg, ctx } = scope();
  ctx.currentFrame = 0;
  const program = delayOn();
  const p = new reg['nc-fx@1']({ processorOptions: { program, bpm: 120, pending: [{ t: 'p', i: 7, v: 1, when: 0.5 }] } });
  const ref = createFxDsp(48000); ref.setTempo(120, 0, true); ref.load(program, 0, true); ref.set(7, 1, 24000, false);
  const blocks = 300, inL = clicks(blocks * 128);
  const [out, want] = renderBoth(p, ref, ctx, 0, blocks, inL);
  assert.ok(identical(out, want));
  assert.ok(identical(out.subarray(0, 24000), inL.subarray(0, 24000))); // dry (mix 0) until 0.5 s
  assert.ok(!identical(out.subarray(24000), inL.subarray(24000)));     // echoes after
});

test('pending: a past time is clamped to now (first sample, snapped), never folded into the start', () => {
  const { reg, ctx } = scope();
  ctx.currentFrame = 480000; // the node is created 10 s in; the call was for 3 s
  const program = delayOn();
  const p = new reg['nc-fx@1']({ processorOptions: { program, bpm: 120, pending: [{ t: 'p', i: 7, v: 1, when: 3 }] } });
  const ref = createFxDsp(48000); ref.setTempo(120, 0, true); ref.load(program, 0, true); ref.set(7, 1, 0, true);
  const blocks = 100, inL = clicks(blocks * 128);
  const [out, want] = renderBoth(p, ref, ctx, 480000, blocks, inL);
  assert.ok(identical(out, want));
  // Mix 0 (the start) would pass the click dry; mix 1 from the first sample takes the dry away at once.
  assert.equal(inL[0], 0.5);
  assert.ok(Math.abs(out[0]) < 1e-6);
});

test('pending: order is preserved (call order wins for past and equal future times)', () => {
  const { reg, ctx } = scope();
  ctx.currentFrame = 480000;
  const program = delayOn();
  const pending = [
    { t: 'p', i: 7, v: 0.2, when: 9 }, { t: 'p', i: 7, v: 0.7, when: 2 },        // both past: the later call wins
    { t: 'p', i: 6, v: 0.1, when: 10.5 }, { t: 'p', i: 6, v: 0.6, when: 10.5 }   // same future frame: queue order
  ];
  const p = new reg['nc-fx@1']({ processorOptions: { program, bpm: 120, pending } });
  const ref = createFxDsp(48000); ref.setTempo(120, 0, true); ref.load(program, 0, true);
  ref.set(7, 0.7, 0, true); ref.set(6, 0.6, 504000, false);
  const blocks = 400, inL = clicks(blocks * 128);
  const [out, want] = renderBoth(p, ref, ctx, 480000, blocks, inL);
  assert.ok(identical(out, want));
  const wrong = createFxDsp(48000); wrong.setTempo(120, 0, true); wrong.load(program, 0, true);
  wrong.set(7, 0.2, 0, true); wrong.set(6, 0.1, 504000, false);
  const { reg: reg2, ctx: ctx2 } = scope(); ctx2.currentFrame = 480000;
  const p2 = new reg2['nc-fx@1']({ processorOptions: { program, bpm: 120, pending } });
  const [out2, bad] = renderBoth(p2, wrong, ctx2, 480000, blocks, inL);
  assert.ok(identical(out2, out) && !identical(out2, bad));
});
