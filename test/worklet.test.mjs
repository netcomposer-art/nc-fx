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
