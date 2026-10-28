// nc-fx renders exactly ASTRID's samples (same chain, same dials), from ASTRID's own DSP file.
// The fixture is NetComposer-Synth 024f200 lib/synth-audio/src/hacks-vendor/dsp.js, unmodified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFxDsp } from '../src/dsp.js';
import { compile, sanitize, delaySeconds, PARAM_INDEX, dialToDsp } from '../src/params.js';
import { SR, noiseBursts, renderDsp, identical } from './helpers.mjs';

const FIXTURE = new URL('./fixtures/astrid-hacks-dsp.cjs', import.meta.url);
const lib = createRequire(import.meta.url)(FIXTURE.pathname);

test('fixture is ASTRID\'s dsp.js (sha256 pinned to hacks-vendor/SOURCE.md)', () => {
  const h = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
  assert.equal(h, 'ae783eea575fc74d6f49b94ba1465717d070e8096b4ebf2907b62878e17985d2');
});

/** ASTRID's widgets for an nc-fx state (hacks.ts hackParams; delay `wet` is our `mix`). */
function astridWidgets(state, tempo) {
  return state.chain.filter((c) => !c.bypass || true).map((c) => {
    const d = c.dials;
    const params = c.type === 'drive' ? { drive_db: d.drive_db, output_db: d.output_db, mix: d.mix / 100 }
      : c.type === 'delay' ? { delay_s: +delaySeconds(d.delay_beats, tempo).toFixed(4), feedback: d.feedback / 100, wet: d.mix / 100 }
      : { predelay: d.predelay / 1000, size: d.size / 100, decay: d.decay / 100, damping: d.damping / 100, mix: d.mix / 100 };
    return { id: c.type + '-1', type: c.type, bypass: c.bypass, params };
  });
}

const CASES = [
  ['all on, mid settings', 120, { drive: [false, { drive_db: 12, output_db: -3, mix: 80 }], delay: [false, { delay_beats: 0.75, feedback: 50, mix: 40 }], plate: [false, { predelay: 20, size: 60, decay: 70, damping: 30, mix: 35 }] }],
  ['extremes', 97, { drive: [false, { drive_db: 24, output_db: 12, mix: 100 }], delay: [false, { delay_beats: 2, feedback: 90, mix: 100 }], plate: [false, { predelay: 200, size: 100, decay: 100, damping: 100, mix: 100 }] }],
  ['clean drive, short delay, small room', 174, { drive: [false, { drive_db: 0, output_db: -12, mix: 0 }], delay: [false, { delay_beats: 0.25, feedback: 0, mix: 10 }], plate: [false, { predelay: 0, size: 0, decay: 0, damping: 0, mix: 50 }] }],
  ['bypassed effects (ASTRID keeps running them)', 120, { drive: [true, { drive_db: 18 }], delay: [false, { mix: 30 }], plate: [true, { mix: 60 }] }],
];

for (const [name, tempo, spec] of CASES) {
  test(`parity: ${name}`, () => {
    const state = sanitize({ v: 1, chain: Object.entries(spec).map(([type, [bypass, dials]]) => ({ type, bypass, dials })) });
    const [inL, inR] = noiseBursts(SR * 2, tempo);
    const chain = lib.chainCreate(SR);
    lib.chainSet(chain, astridWidgets(state, tempo), false);
    const aL = new Float32Array(inL.length), aR = new Float32Array(inL.length);
    for (let o = 0; o < inL.length; o += 128) lib.render(chain, inL.subarray(o, o + 128), inR.subarray(o, o + 128), aL.subarray(o, o + 128), aR.subarray(o, o + 128));
    const fx = createFxDsp(SR, { bypassMode: 'run', limiter: 'lookahead', preGain: 0.8 }); // ASTRID's master settings
    fx.setTempo(tempo, 0, true);
    fx.load(compile(state), 0, true);
    const [bL, bR] = renderDsp(fx, inL, inR);
    assert.ok(identical(aL, bL) && identical(aR, bR), 'samples differ');
  });
}

// With a mod signal on process()'s 7th argument (PR A: nothing routed), every case is still ASTRID's samples.
test('parity with a mod signal present (mod input, nothing routed): all cases bit-identical to ASTRID', () => {
  for (const [name, tempo, spec] of CASES) {
    const state = sanitize({ v: 1, chain: Object.entries(spec).map(([type, [bypass, dials]]) => ({ type, bypass, dials })) });
    const [inL, inR] = noiseBursts(SR * 2, tempo);
    const chain = lib.chainCreate(SR);
    lib.chainSet(chain, astridWidgets(state, tempo), false);
    const fx = createFxDsp(SR, { bypassMode: 'run', limiter: 'lookahead', preGain: 0.8 });
    fx.setTempo(tempo, 0, true);
    fx.load(compile(state), 0, true);
    const n = inL.length, aL = new Float32Array(n), aR = new Float32Array(n), bL = new Float32Array(n), bR = new Float32Array(n);
    const cv = new Float32Array(n).map((_, i) => (i % 2756 < 400 ? 0.9 : 0));
    for (let o = 0; o < n; o += 128) {
      lib.render(chain, inL.subarray(o, o + 128), inR.subarray(o, o + 128), aL.subarray(o, o + 128), aR.subarray(o, o + 128));
      fx.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), bL.subarray(o, o + 128), bR.subarray(o, o + 128), 128, o, cv.subarray(o, o + 128));
    }
    assert.ok(identical(aL, bL) && identical(aR, bR), `${name}: samples differ`);
  }
});

// Changes while playing (Zeta's dynamic probe). Dial changes stay bit-identical. A bypass CHANGE differs on purpose
// since Peter chose a smooth crossfade (no 0.0016 step at 0.999/0.001): identical up to it, different from it on.
const ALL = CASES[0][2];
const EVENTS = [{ block: 100, type: 'delay', key: 'mix', v: 90 }, { block: 150, type: 'plate', key: 'size', v: 10 }, { block: 200, type: 'drive', key: 'drive_db', v: 3 },
  { block: 260, type: 'delay', key: 'feedback', v: 85 }, { block: 300, type: 'plate', key: 'bypass', v: true }, { block: 420, type: 'plate', key: 'bypass', v: false },
  { block: 500, type: 'delay', key: 'delay_beats', v: 0.25 }, { block: 560, type: 'drive', key: 'bypass', v: true }, { block: 600, type: 'plate', key: 'predelay', v: 150 }];
function firstDiff(events) {
  const tempo = 120, state = sanitize({ v: 1, chain: Object.entries(ALL).map(([type, [bypass, dials]]) => ({ type, bypass, dials: { ...dials } })) });
  const [inL, inR] = noiseBursts(SR * 2, tempo);
  const chain = lib.chainCreate(SR); lib.chainSet(chain, astridWidgets(state, tempo), false);
  const patch = lib.fns.find((f) => f.name === 'ncChainPatch');
  const fx = createFxDsp(SR, { bypassMode: 'run', limiter: 'lookahead', preGain: 0.8 }); fx.setTempo(tempo, 0, true); fx.load(compile(state), 0, true);
  const n = inL.length, aL = new Float32Array(n), aR = new Float32Array(n), bL = new Float32Array(n), bR = new Float32Array(n);
  for (let o = 0; o < n; o += 128) {
    for (const ev of events) if (ev.block * 128 === o) {
      const slot = state.chain.find((c) => c.type === ev.type);
      if (ev.key === 'bypass') slot.bypass = ev.v; else slot.dials[ev.key] = ev.v;
      fx.set(PARAM_INDEX[ev.type][ev.key], dialToDsp(ev.type, ev.key, ev.v));
      for (const w of astridWidgets(state, tempo)) patch(chain, w.id, w.params, w.bypass, false);
    }
    lib.render(chain, inL.subarray(o, o + 128), inR.subarray(o, o + 128), aL.subarray(o, o + 128), aR.subarray(o, o + 128));
    fx.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), bL.subarray(o, o + 128), bR.subarray(o, o + 128), 128);
  }
  for (let i = 0; i < n; i++) if (aL[i] !== bL[i] || aR[i] !== bR[i]) return i;
  return -1;
}
test('parity while playing: dial changes are bit-identical to ASTRID', () => {
  assert.equal(firstDiff(EVENTS.filter((e) => e.key !== 'bypass')), -1);
});
test('parity while playing: identical up to the first bypass change, then the smooth crossfade differs (on purpose)', () => {
  assert.equal(firstDiff(EVENTS), 300 * 128 + Math.round(0.0015 * SR));
});
