// nc-fx renders exactly ASTRID's samples (same chain, same dials), from ASTRID's own DSP file.
// The fixture is NetComposer-Synth 024f200 lib/synth-audio/src/hacks-vendor/dsp.js, unmodified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFxDsp } from '../src/dsp.js';
import { compile, sanitize, delaySeconds } from '../src/params.js';
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
