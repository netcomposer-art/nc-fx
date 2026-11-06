// Level taps (fxMeter): the engines measure each effect's input and output only while a meter is open, the worklet
// reports about 30 times a second (silence once), and the host ref-counts every open over the chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import source from '../dist/worklet-source.js';
import { createFxCore, fxMeter } from '../src/index.js';
import { createFxChainDsp } from '../src/chain.js';
import { createFxDsp } from '../src/dsp.js';
import { compile, defaultState } from '../src/params.js';
import { slotProgram, sanitizeSlots } from '../src/slots.js';
import { mockContext } from './mock-audio.mjs';
import { identical } from './helpers.mjs';

const SR = 48000;
const sine = (n, amp) => new Float32Array(n).map((_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR));

/** A slot-chain DSP with one drive (+12 dB, on) and one width (bypassed), both in order. */
function chainWith() {
  const d = createFxChainDsp(SR, { slots: 3 });
  const st = sanitizeSlots({ v: 2, chain: [
    { id: 'drive-1', type: 'drive', bypass: false, dials: { drive_db: 12, output_db: 6 } },
    { id: 'width-1', type: 'width', bypass: true, dials: {} },
  ] }, 3);
  st.chain.forEach((s, i) => {
    d.add(i + 1, s.type, 0);
    for (const [k, v] of slotProgram(s)) d.set(i + 1, k, v, 0, true);
  });
  d.order([1, 2], 0, true);
  return d;
}
function run(d, inL, blocks = 20) {
  const outL = new Float32Array(128), outR = new Float32Array(128), all = [];
  for (let b = 0; b < blocks; b++) {
    d.process(inL.subarray(b * 128, b * 128 + 128), null, outL, outR, 128, b * 128);
    all.push(Float32Array.from(outL), Float32Array.from(outR));
  }
  return all;
}

test('slot chain: per effect input and output peaks, in order; off, the same samples and nothing measured', () => {
  const inL = sine(128 * 20, 0.25);
  const plain = chainWith(), metered = chainWith();
  metered.meter(true);
  const a = run(plain, inL), b = run(metered, inL);
  for (let i = 0; i < a.length; i++) assert.ok(identical(a[i], b[i]), 'metering changes no sample');
  const out = new Float32Array(metered.meterSize);
  const n = metered.takeMeter(out);
  assert.equal(n, 3 + 3 * 2);
  assert.equal(out[2], 2);
  assert.ok(Math.abs(out[0] - 0.25) < 0.01, `chain in ${out[0]}`);
  assert.equal(out[3], 1);
  assert.ok(Math.abs(out[4] - 0.25) < 0.01, `drive in ${out[4]}`);
  assert.ok(out[5] > out[4] * 1.5, `drive out ${out[5]} louder than its input`);
  assert.equal(out[6], 2);
  assert.ok(Math.abs(out[7] - out[5]) < 1e-6, 'the width sees what the drive put out');
  assert.ok(out[8] > 0, 'a bypassed effect still reports (its input passes)');
  assert.ok(out[1] > 0, 'chain out');
  // Reset on take; off measures nothing.
  metered.takeMeter(out);
  assert.equal(out[4], 0);
  plain.takeMeter(out);
  run(plain, inL, 2);
  plain.takeMeter(out);
  assert.equal(out[0], 0);
  assert.equal(out[4], 0);
});

test('fixed chain: the chain input and output peaks', () => {
  const d = createFxDsp(SR);
  const s = defaultState(); s.chain[0].bypass = false; s.chain[0].dials.drive_db = 12; s.chain[0].dials.output_db = 6;
  d.load(Array.from(compile(s)), 0, true);
  d.meter(true);
  run(d, sine(128 * 10, 0.5), 10);
  const out = new Float32Array(d.meterSize);
  assert.equal(d.takeMeter(out), 3);
  assert.ok(Math.abs(out[0] - 0.5) < 0.01);
  assert.ok(out[1] > 0.5);
  assert.equal(out[2], 0);
});

function processor(po) {
  const reg = {}, posted = [], clocks = [];
  // The beat clock's reports (Gate: once at the start, then only when the clock changes) are kept apart.
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage: (m) => (m.t === 'clk' ? clocks : posted).push({ t: m.t, d: Float32Array.from(m.d) }) }; } }
  const scope = vm.createContext({ AudioWorkletProcessor, sampleRate: SR, currentFrame: 0, registerProcessor: (n, c) => { reg[n] = c; } });
  vm.runInContext(source, scope);
  const p = new reg['nc-fx@1']({ processorOptions: po });
  const block = (inL) => { const out = [new Float32Array(128), new Float32Array(128)]; p.process([[inL, inL]], [out]); };
  return { p, posted, clocks, block, scope };
}

test('worklet: reports only while a meter is open, about 30 a second, silence once', () => {
  const w = processor({ slots: 3, chain: [{ uid: 7, type: 'drive', program: [[0, 1]] }], order: [7] });
  const loud = sine(128, 0.3), quiet = new Float32Array(128);
  for (let i = 0; i < 40; i++) w.block(loud);
  assert.equal(w.posted.length, 0, 'nothing while no meter is open');
  w.p.port.onmessage({ data: { t: 'meter', on: true } });
  for (let i = 0; i < 375; i++) w.block(loud); // 1 s
  assert.ok(w.posted.length >= 28 && w.posted.length <= 31, `${w.posted.length} reports in a second`);
  const last = w.posted.at(-1);
  assert.equal(last.t, 'lv');
  assert.equal(last.d[2], 1);
  assert.equal(last.d[3], 7);
  assert.ok(last.d[4] > 0.2);
  const before = w.posted.length;
  for (let i = 0; i < 375; i++) w.block(quiet);
  // The drive's output and its smoothing settle within a report or two; after that, silence is sent once.
  const sent = w.posted.length - before;
  assert.ok(sent >= 1 && sent <= 3, `${sent} reports over a silent second`);
  assert.equal(w.posted.at(-1).d[4], 0);
  w.p.port.onmessage({ data: { t: 'meter', on: false } });
  const off = w.posted.length;
  for (let i = 0; i < 100; i++) w.block(loud);
  assert.equal(w.posted.length, off, 'off: no reports');
  assert.equal(w.clocks.length, 1, 'the beat clock reported once (it never changed)');
});

test('host: fxMeter handles are cached per ref, opens are counted over the chain, peaks by effect id', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { slots: 3, state: { v: 2, chain: [{ id: 'drive-1', type: 'drive', bypass: false, dials: {} }, { id: 'eq-1', type: 'eq', bypass: false, dials: {} }] } });
  assert.equal(fxMeter(null), null);
  assert.equal(fxMeter({}), null);
  const a = fxMeter(fx, 'drive-1'), b = fxMeter(fx, 'eq-1');
  assert.equal(fxMeter(fx, 'drive-1'), a, 'one handle per ref');
  assert.deepEqual(a.read(), { in: 0, out: 0 });
  // Before the worklet: the open is queued and reaches it in processorOptions.pending.
  assert.equal(a.open(), true);
  await fx.ready;
  assert.ok(ctx.node.options.processorOptions.pending.some((m) => m.t === 'meter' && m.on === true));
  assert.equal(b.open(), true);
  assert.equal(ctx.posted.filter((m) => m.t === 'meter').length, 0, 'the second open sends nothing');
  const d = new Float32Array([0.5, 0.6, 2, 1, 0.5, 0.9, 2, 0.9, 0.7]);
  ctx.node.port.onmessage({ data: { t: 'lv', d } });
  assert.deepEqual({ ...a.read() }, { in: 0.5, out: Math.fround(0.9) });
  assert.deepEqual({ ...b.read() }, { in: Math.fround(0.9), out: Math.fround(0.7) });
  assert.deepEqual({ ...fxMeter(fx).read() }, { in: 0, out: 0 }, 'a closed handle reads zeros');
  // A move keeps the effect's own peaks (by uid, not position).
  fx.moveEffect('eq-1', 0);
  ctx.node.port.onmessage({ data: { t: 'lv', d: new Float32Array([0.5, 0.6, 2, 2, 0.1, 0.2, 1, 0.3, 0.4]) } });
  assert.deepEqual({ ...b.read() }, { in: Math.fround(0.1), out: Math.fround(0.2) });
  a.close();
  assert.equal(ctx.posted.filter((m) => m.t === 'meter').length, 0);
  b.close();
  b.close(); // extra closes are ignored
  assert.deepEqual(ctx.posted.filter((m) => m.t === 'meter'), [{ t: 'meter', on: false }]);
  assert.deepEqual({ ...b.read() }, { in: 0, out: 0 });
  fx.dispose();
  assert.equal(a.open(), false, 'a disposed chain does not meter');
});

test('host: old peaks read as silence (a suspended context sends nothing)', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, {});
  await fx.ready;
  const m = fxMeter(fx);
  m.open();
  const real = performance.now;
  try {
    let t = 1000;
    performance.now = () => t;
    ctx.node.port.onmessage({ data: { t: 'lv', d: new Float32Array([0.4, 0.5, 0]) } });
    assert.equal(m.read().in, Math.fround(0.4));
    t += 300;
    assert.equal(m.read().in, 0);
  } finally { performance.now = real; }
  m.close();
});
