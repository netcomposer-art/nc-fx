// createFxCore({ slots }) end to end: the messages it posts drive the real dist/worklet.js (simulated scope), and an
// ASTRID preset loaded through it plays ASTRID's samples, including adding, removing and moving effects while playing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import source from '../dist/worklet-source.js';
import { createFxCore, createFx, CATALOG_MENU, toAstridHacks } from '../src/index.js';
import { mockContext } from './mock-audio.mjs';
import { astridWorklet, astridHacks } from './astrid.mjs';
import { noiseBursts } from './helpers.mjs';

const SR = 48000;
const W = astridWorklet(SR);
const H = await astridHacks();

/** The processor from dist/worklet.js, made with the node's options; returns render(n blocks) and the scope. */
function processorFor(ctx) {
  const reg = {};
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage() {} }; } }
  const scope = vm.createContext({ AudioWorkletProcessor, sampleRate: SR, currentFrame: 0, registerProcessor: (n, c) => { reg[n] = c; } });
  vm.runInContext(source, scope);
  const p = new reg['nc-fx@1']({ processorOptions: ctx.node.options.processorOptions });
  let sent = ctx.posted.length;
  return {
    p, scope,
    /** Deliver the messages posted since the last call (as the port would, before the next block). */
    flush() { for (; sent < ctx.posted.length; sent++) p.port.onmessage({ data: ctx.posted[sent] }); },
  };
}
function play(ctx, w, inL, inR, hook) {
  const n = inL.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0; o < n; o += 128) {
    if (hook) hook(o);
    w.flush();
    w.scope.currentFrame = o;
    const out = [new Float32Array(128), new Float32Array(128)];
    w.p.process([[inL.subarray(o, o + 128), inR.subarray(o, o + 128)]], [out]);
    oL.set(out[0], o); oR.set(out[1], o);
  }
  return [oL, oR];
}
const firstDiff = (a, b) => { for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) if (!Object.is(a[c][i], b[c][i])) return i; return -1; };

test('slots: an ASTRID preset loaded with createFxCore plays ASTRID\'s samples (worklet, ASTRID\'s master options)', async () => {
  const preset = [
    { id: 'eq-1', type: 'eq', bypass: false, dials: { low_db: 5, mid_db: -6, mid_hz: 40, mid_q: 60, high_db: 4 } },
    { id: 'chorus-1', type: 'chorus', bypass: false, dials: { rate: 60, depth: 80, spread: 100, mix: 50 } },
    { id: 'delay-1', type: 'delay', bypass: false, dials: { delay_beats: 0.75, feedback: 45, wet: 35 } },
  ];
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', slots: true, state: preset, bpm: 128, limiter: 'lookahead', preGain: 0.8 });
  await fx.ready;
  assert.equal(ctx.node.options.processorOptions.slots, 3);
  const [inL, inR] = noiseBursts(SR, 4);
  const chain = W.ncChainCreate(SR); W.ncChainSet(chain, H.hackWidgets(preset, 128), false);
  const a = [new Float32Array(SR), new Float32Array(SR)];
  for (let o = 0; o < SR; o += 128) W.ncRender(chain, inL.subarray(o, o + 128), inR.subarray(o, o + 128), a[0].subarray(o, o + 128), a[1].subarray(o, o + 128));
  assert.equal(firstDiff(a, play(ctx, processorFor(ctx), inL, inR)), -1);
  assert.deepEqual(fx.toAstrid(), { hacks: H.sanitizeHacks(preset), lossy: [] });
});

test('slots: add, move, remove, dial and preset changes through the API play ASTRID\'s samples (as HackOutput.sync)', async () => {
  const start = [{ id: 'drive-1', type: 'drive', bypass: false, dials: { drive_db: 9, output_db: -3, mix: 100 } }];
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', slots: 3, state: start, limiter: 'lookahead', preGain: 0.8 });
  await fx.ready;
  const w = processorFor(ctx);
  // ASTRID's side: HackOutput.sync on the same chain edits.
  const chain = W.ncChainCreate(SR); let sent = H.hackWidgets(start, 120);
  W.ncChainSet(chain, sent, false);
  const sync = (hacks) => {
    const want = H.hackWidgets(hacks, 120), had = new Map(sent.map((x) => [x.id, x]));
    for (const x of want) if (!had.has(x.id) || had.get(x.id).type !== x.type) W.ncChainAdd(chain, x);
    if (want.map((x) => x.id).join('\n') !== sent.map((x) => x.id).join('\n')) W.ncChainOrder(chain, want.map((x) => x.id), false);
    for (const x of want) { const old = had.get(x.id); if (old && old.type === x.type && JSON.stringify(old) !== JSON.stringify(x)) W.ncChainPatch(chain, x.id, x.params, x.bypass, false); }
    sent = want;
  };
  const astridOf = () => toAstridHacks(fx.getState()).hacks;
  const steps = {
    40: () => fx.addEffect('flanger'),
    80: () => fx.addEffect('eq', { index: 0, dials: { low_db: 6 } }),
    120: () => fx.setParam('flanger-1', 'feedback', -70),
    160: () => fx.moveEffect('drive-1', 2),
    200: () => fx.removeEffect('eq-1'),
    240: () => fx.setParam('drive', 'drive_db', 18),
    280: () => fx.setState([{ id: 'phaser-1', type: 'phaser', bypass: false, dials: { rate: 70 } }, { id: 'drive-1', type: 'drive', bypass: false, dials: { drive_db: 18, output_db: -3, mix: 100 } }]),
  };
  const [inL, inR] = noiseBursts(128 * 560, 8);
  const a = [new Float32Array(inL.length), new Float32Array(inL.length)];
  // Each block: the API call (and the same edit synced into ASTRID's chain), then both render that block.
  const b = play(ctx, w, inL, inR, (o) => {
    const s = steps[o / 128];
    if (s) { s(); sync(astridOf()); }
    W.ncRender(chain, inL.subarray(o, o + 128), inR.subarray(o, o + 128), a[0].subarray(o, o + 128), a[1].subarray(o, o + 128));
  });
  assert.equal(firstDiff(a, b), -1);
  assert.deepEqual(fx.getChain().map((x) => x.id), ['phaser-1', 'drive-1']);
});

test('slots: API shape, limits and notifications', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', slots: 2 });
  await fx.ready;
  const seen = [];
  fx.onChange((c) => seen.push([c.effect, c.key, c.value]));
  assert.equal(fx.slots, 2);
  assert.equal(fx.addEffect('reverb'), 'plate-1');
  assert.equal(fx.addEffect('delay', { bypass: true }), 'delay-1');
  assert.equal(fx.addEffect('chorus'), undefined, 'full');
  assert.equal(fx.addEffect('nope'), undefined);
  assert.deepEqual(fx.getChain(), [{ id: 'plate-1', type: 'plate', name: 'Reverb', bypass: false }, { id: 'delay-1', type: 'delay', name: 'Delay', bypass: true }]);
  assert.equal(fx.setParam('plate-1', 'mix', 140), 100);
  assert.equal(fx.getParam('reverb', 'mix'), 100);
  assert.equal(fx.setParam('plate-1', 'nope', 1), undefined);
  assert.equal(fx.setParam('chorus', 'mix', 1), undefined);
  assert.equal(fx.moveEffect('delay-1', 0), true);
  assert.equal(fx.moveEffect('delay-1', 0), false);
  assert.equal(fx.removeEffect('plate-1'), true);
  assert.equal(fx.removeEffect('plate-1'), false);
  assert.deepEqual(fx.getState(), { v: 2, chain: [{ id: 'delay-1', type: 'delay', bypass: true, dials: { delay_beats: 0.75, feedback: 35, mix: 0, tone: 100, low_cut: 0, mode: 0, send: 100, mod_send: 0, beats_free: 0 } }] });
  assert.deepEqual(seen.map((x) => x.slice(0, 2)), [['plate-1', 'chain'], ['delay-1', 'chain'], ['plate-1', 'mix'], ['delay-1', 'chain'], ['plate-1', 'chain']]);
  // Acid re-rounds drive_db and says so.
  fx.addEffect('drive');
  fx.setParam('drive-1', 'curve', 1); fx.setParam('drive-1', 'drive_db', 7.3);
  seen.length = 0;
  fx.setParam('drive-1', 'curve', 0);
  assert.deepEqual(seen, [['drive-1', 'curve', 0], ['drive-1', 'drive_db', 7]]);
  assert.deepEqual(CATALOG_MENU, ['delay', 'plate', 'flanger', 'chorus', 'phaser', 'eq', 'drive', 'compressor', 'width']);
});

test('slots: calls before the worklet is ready are queued and replayed in order (and a long queue folds)', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { moduleUrl: '/w.js', slots: true, state: [{ id: 'eq-1', type: 'eq', dials: { low_db: 3 } }] });
  fx.addEffect('width');
  fx.setParam('width-1', 'width', 150, 0.5);
  fx.moveEffect('width-1', 0);
  await fx.ready;
  const po = ctx.node.options.processorOptions;
  assert.deepEqual(po.chain.map((c) => c.type), ['eq']);
  assert.deepEqual(po.pending.map((m) => m.t), ['add', 'ps', 'ps', 'ps', 'order', 'ps', 'order']);
  assert.equal(po.pending.find((m) => m.t === 'ps' && m.when === 0.5).v, 1.5);
  // The worklet ends up with the API's chain.
  const w = processorFor(ctx);
  assert.deepEqual(Array.from(w.p.dsp.playing()), [2, 1]);
  // 300 calls before ready: folded into one sync of the current chain.
  const ctx2 = mockContext();
  const fx2 = createFxCore(ctx2, { moduleUrl: '/w.js', slots: true });
  fx2.addEffect('delay');
  for (let i = 0; i < 300; i++) fx2.setParam('delay-1', 'feedback', i % 90);
  await fx2.ready;
  const pend = ctx2.node.options.processorOptions.pending;
  assert.ok(pend.length <= 257 && pend.some((m) => m.t === 'sync'));
  const w2 = processorFor(ctx2);
  assert.equal(w2.p.dsp.playing().length, 1);
  assert.equal(w2.p.dsp.get(w2.p.dsp.playing()[0], 2), (299 % 90) / 100);
});

test('slots: createFx mounts the panel module lazily like the fixed chain', async () => {
  const fx = createFx(mockContext(), { moduleUrl: '/w.js', slots: true });
  assert.equal(typeof fx.mount, 'function');
  fx.dispose();
});
