// The Acid drive curve renders exactly ASTRID-Bass's drive samples (same settings), from Bass's own DSP file.
// The fixture is ASTRID-Bass 3608858 apps/bass/src/modules/fx/fx-dsp.ts (+ types.ts), bundled by esbuild, unmodified.
// Effects only: Bass's chain input is its voice times preGain (0.8) in a Float32Array; nc-fx gets that same float32
// signal (preGain 1), with delay and plate bypassed and the limiter off (the defaults), so only the drive differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFxDsp } from '../src/dsp.js';
import { compile, sanitize } from '../src/params.js';
import { SR, renderDsp } from './helpers.mjs';

const FIXTURE = new URL('./fixtures/bass-fx-dsp-3608858.mjs', import.meta.url);
const { FxChainDsp, KIND_DRIVE } = await import(FIXTURE.href);

test('fixture is ASTRID-Bass 3608858 fx-dsp.ts (sha256 pinned)', () => {
  const h = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
  assert.equal(h, '6fc1eb5afe770e343a85db3ad983285701e14dd1089366895e68c616e84f38ca');
});

const N = 3 * 9600;
/** Bass voice-like probe: saws at 55 Hz (-12 dBFS) and 110 Hz (-6 dBFS), then a noise burst; R is a 82.5 Hz saw. */
function probe() {
  const L = new Float64Array(N), R = new Float64Array(N);
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < N; i++) {
    const seg = Math.floor(i / 9600);
    L[i] = seg === 0 ? 0.251 * (2 * ((i * 55 / SR) % 1) - 1) : seg === 1 ? 0.501 * (2 * ((i * 110 / SR) % 1) - 1)
      : (i % 9600 < 3000 ? 0.7 * (rnd() * 2 - 1) : 0);
    R[i] = 0.4 * (2 * ((i * 82.5 / SR) % 1) - 1);
  }
  return [L, R];
}
/** AcidVoice-like accent CV: a 16th-note pattern at 120 BPM, accented steps decay from 1 (about 200 ms). */
function accent() {
  const cv = new Float32Array(N), pat = [1, 0, 0, 1, 0, 1, 0, 0];
  for (let i = 0; i < N; i++) { const st = Math.floor(i / 6000), ph = i % 6000; cv[i] = pat[st % 8] ? Math.exp(-ph / 1600) : 0; }
  return cv;
}
const [L, R] = probe(), CV = accent();
const PRE = 0.8;
// Bass's voice output is a Float32Array; its chain input is out[i] = input[i] * preGain, stored float32 again.
const vL = Float32Array.from(L), vR = Float32Array.from(R);
const inL = new Float32Array(N), inR = new Float32Array(N);
for (let i = 0; i < N; i++) { inL[i] = vL[i] * PRE; inR[i] = vR[i] * PRE; }

function bass(x, p) {
  const d = new FxChainDsp(SR, 4);
  d.configure(0, KIND_DRIVE, false, p);
  d.setOrder([0]);
  const y = new Float32Array(N), src = x;
  for (let o = 0; o < N; o += 128) d.process(src.subarray(o, o + 128), CV.subarray(o, o + 128), y.subarray(o, o + 128), o);
  return y;
}
/** nc-fx with the converter's dials (INTEGRATION-bass.md). */
function ncfx(dials, block) {
  const s = sanitize({ v: 1, chain: [{ type: 'drive', bypass: false, dials: Object.assign({ curve: 1, output_db: 0 }, dials) }] });
  const fx = createFxDsp(SR);
  fx.load(compile(s), 0, true);
  const oL = new Float32Array(N), oR = new Float32Array(N);
  for (let o = 0; o < N; o += block) {
    const e = Math.min(N, o + block);
    fx.process(inL.subarray(o, e), inR.subarray(o, e), oL.subarray(o, e), oR.subarray(o, e), e - o, o, CV.subarray(o, e));
  }
  return [oL, oR, s.chain[0].dials];
}
const maxAbs = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; };

/** Bass params -> nc-fx dials (the converter), and the Bass params those dials stand for (what Bass is run with). */
function convert(amount, tone, mix, modAmount, modTone) {
  const dials = { drive_db: Math.round(10 * 20 * Math.log10(1 + 9 * amount)) / 10, tone: Math.round(99 * tone),
    mix: Math.round(100 * mix), mod_drive: Math.round(100 * modAmount), mod_tone: Math.round(100 * modTone) };
  const p = [(Math.pow(10, dials.drive_db / 20) - 1) / 9, dials.tone / 99, dials.mix / 100, dials.mod_drive / 100, dials.mod_tone / 100];
  return { dials, p };
}

test('Acid == Bass drive, bit for bit: amount x tone x mix x accent depths (240 settings, L and R)', () => {
  let worst = 0, n = 0;
  for (const amount of [0, 0.1, 0.25, 0.5, 1]) for (const tone of [0, 0.3, 0.6, 1]) for (const mix of [0.5, 1])
    for (const modAmount of [0, 0.5, 1]) for (const modTone of [0, 0.3]) {
      const { dials, p } = convert(amount, tone, mix, modAmount, modTone);
      const [oL, oR, got] = ncfx(dials, 128);
      for (const k in dials) assert.equal(got[k], dials[k], 'dials survive sanitize (0.1 dB in Acid): ' + k);
      const dL = maxAbs(oL, bass(vL, p)), dR = maxAbs(oR, bass(vR, p));
      worst = Math.max(worst, dL, dR); n++;
      assert.equal(dL, 0, `L ${JSON.stringify(dials)}`);
      assert.equal(dR, 0, `R ${JSON.stringify(dials)}`);
    }
  assert.equal(n, 240);
  console.log(`bass parity: ${n} settings x 2 channels x ${N} samples, max abs diff ${worst}`);
});

test('Acid == Bass at any host block size (tone mod on the absolute 128-frame grid)', () => {
  const { dials, p } = convert(0.25, 0.6, 1, 0.5, 0.3); // Bass's defaults plus accent mod
  const ref = bass(vL, p);
  for (const block of [1, 37, 64, 128, 256, 1000]) assert.equal(maxAbs(ncfx(dials, block)[0], ref), 0, `block ${block}`);
});

test('the converter round-trips Bass amounts within 0.0065 (0.1 dB steps in Acid)', () => {
  let worst = 0;
  for (let a = 0; a <= 1.0000001; a += 0.001) worst = Math.max(worst, Math.abs(convert(a, 0.6, 1, 0, 0).p[0] - a));
  assert.ok(worst < 0.0065, String(worst));
});
