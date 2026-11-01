// Zero cost: with no plugin in a chain, the worklet renders exactly what the build before plugins rendered
// (test/fixtures/nc-fx-worklet-085e5b0.js, dist/worklet.js at nc-fx 085e5b0), sample for sample, through the same
// messages: adds, reorders (with their 4 ms fades), removes, dials, bypass, tempo, clears and level meters. It also
// holds with a plugin registered in the scope but not in the chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import source from '../dist/worklet-source.js';
import { createFxCore } from '../src/index.js';
import { mockContext } from './mock-audio.mjs';
import { noiseBursts } from './helpers.mjs';

const OLD = readFileSync(new URL('./fixtures/nc-fx-worklet-085e5b0.js', import.meta.url), 'utf8');

function scope(src, extra) {
  const reg = {};
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage() {} }; } }
  const ctx = vm.createContext({ AudioWorkletProcessor, sampleRate: 48000, currentFrame: 0, registerProcessor: (n, c) => { reg[n] = c; } });
  vm.runInContext(src, ctx);
  if (extra) vm.runInContext(extra, ctx);
  return { P: reg['nc-fx@1'], ctx };
}

// A chain session through the real createFxCore (mock context): the messages it posts, per block.
function session(seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const ctx = mockContext();
  const fx = createFxCore(ctx, { slots: 8, limiter: rnd() < 0.5 ? 'lookahead' : 'soft', state: { v: 2, chain: [{ type: 'chorus', dials: { mix: 60 } }, { type: 'delay', dials: { mix: 40 } }] } });
  const start = { ...ctx.node?.options?.processorOptions };
  return { ctx, fx, rnd, start };
}

const TYPES = ['delay', 'plate', 'flanger', 'chorus', 'phaser', 'eq', 'drive', 'compressor', 'width'];
const PLUGIN = `registerNcFxPlugin({ id: 'test.gain', version: '1.0.0', params: ['gain'], create: function () {
  var g = 1; return { set: function (k, v) { g = v; }, process: function (a, b, c, d, n) { for (var i = 0; i < n; i++) { c[i] = a[i] * g; d[i] = b[i] * g; } } }; } });`;

for (const [seed, extra] of [[1, null], [7, null], [42, PLUGIN]]) {
  test(`no plugin in the chain: sample-identical to the build before plugins (seed ${seed}${extra ? ', a plugin registered' : ''})`, async () => {
    const { ctx, fx, rnd } = session(seed);
    await fx.ready;
    const po = ctx.node.options.processorOptions;
    const a = scope(OLD), b = scope(source, extra);
    const pa = new a.P({ processorOptions: po }), pb = new b.P({ processorOptions: po });
    const [inL, inR] = noiseBursts(128 * 600, seed);
    let sent = 0;
    for (let blk = 0; blk < 600; blk++) {
      if (blk % 15 === 0) {
        const chain = fx.getChain(), r = rnd();
        if (r < 0.2 && chain.length < 8) fx.addEffect(TYPES[Math.floor(rnd() * TYPES.length)], { dials: { mix: 50 } });
        else if (r < 0.35 && chain.length > 1) fx.moveEffect(chain[0].id, chain.length - 1);
        else if (r < 0.45 && chain.length > 2) fx.removeEffect(chain[1].id);
        else if (r < 0.6 && chain.length) fx.setParam(chain[0].id, 'bypass', !chain[0].bypass);
        else if (r < 0.7) fx.setTempo(80 + Math.floor(rnd() * 80));
        else if (r < 0.75) fx.clear(rnd() < 0.5 ? undefined : { fadeMs: 30 });
        else if (r < 0.8) { const m = fx.meter(); m.open(); }
        else if (chain.length) fx.setParam(chain[chain.length - 1].id, 'mix', Math.floor(rnd() * 100));
        for (; sent < ctx.posted.length; sent++) {
          const m = JSON.parse(JSON.stringify(ctx.posted[sent]));
          pa.port.onmessage({ data: m }); pb.port.onmessage({ data: JSON.parse(JSON.stringify(m)) });
        }
      }
      a.ctx.currentFrame = b.ctx.currentFrame = blk * 128;
      const L = inL.subarray(blk * 128, blk * 128 + 128), R = inR.subarray(blk * 128, blk * 128 + 128);
      const oa = [new Float32Array(128), new Float32Array(128)], ob = [new Float32Array(128), new Float32Array(128)];
      pa.process([[L, R]], [oa]); pb.process([[L, R]], [ob]);
      for (let i = 0; i < 128; i++) {
        if (!Object.is(oa[0][i], ob[0][i]) || !Object.is(oa[1][i], ob[1][i])) assert.fail(`block ${blk} sample ${i}: ${oa[0][i]} vs ${ob[0][i]}`);
      }
    }
    fx.dispose();
  });
}
