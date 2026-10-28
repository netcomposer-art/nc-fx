// The delay in Send mode renders exactly ASTRID-Bass's delay samples (same settings), from Bass's own DSP file
// (the pinned fixture, see bass-parity.test.mjs). Effects only: Bass gets its voice (Float32Array) and applies its
// preGain 0.8; nc-fx gets that same float32 chain input (preGain 1) with drive and plate bypassed, limiter off.
// The dials are the converter's (INTEGRATION-bass.md): beats_free = Bass's division, mode Send, mix 100, ...
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxDsp } from '../src/dsp.js';
import { compile, sanitize } from '../src/params.js';
import { SR } from './helpers.mjs';

const { FxChainDsp, KIND_DELAY, KIND_DRIVE } = await import(new URL('./fixtures/bass-fx-dsp-3608858.mjs', import.meta.url).href);

/** Saws, then a noise burst and silence (the tail rings out through the feedback); n samples. */
function probe(n) {
  const L = new Float64Array(n), R = new Float64Array(n);
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) {
    const seg = Math.floor(i / 9600) % 3;
    L[i] = seg === 0 ? 0.251 * (2 * ((i * 55 / SR) % 1) - 1) : seg === 1 ? 0.501 * (2 * ((i * 110 / SR) % 1) - 1)
      : (i % 9600 < 3000 ? 0.7 * (rnd() * 2 - 1) : 0);
    R[i] = 0.4 * (2 * ((i * 82.5 / SR) % 1) - 1);
  }
  return [Float32Array.from(L), Float32Array.from(R)];
}
function accent(n) {
  const cv = new Float32Array(n), pat = [1, 0, 0, 1, 0, 1, 0, 0];
  for (let i = 0; i < n; i++) { const st = Math.floor(i / 6000), ph = i % 6000; cv[i] = pat[st % 8] ? Math.exp(-ph / 1600) : 0; }
  return cv;
}
function signal(n) {
  const [vL, vR] = probe(n), cv = accent(n);
  const inL = new Float32Array(n), inR = new Float32Array(n);
  for (let i = 0; i < n; i++) { inL[i] = vL[i] * 0.8; inR[i] = vR[i] * 0.8; } // Bass: out[i] = input[i] * preGain, float32
  return { n, vL, vR, inL, inR, cv };
}
const S = signal(3 * 9600);

/** Bass's FxChainDsp: [drive params] (optional, slot 0) then the delay, 128-frame blocks with the accent CV. */
function bass(x, sig, delayP, driveP, maxDelaySeconds) {
  const d = new FxChainDsp(SR, 2, maxDelaySeconds);
  if (driveP) { d.configure(0, KIND_DRIVE, false, driveP); d.configure(1, KIND_DELAY, false, delayP); d.setOrder([0, 1]); }
  else { d.configure(0, KIND_DELAY, false, delayP); d.setOrder([0]); }
  const y = new Float32Array(sig.n);
  for (let o = 0; o < sig.n; o += 128) d.process(x.subarray(o, o + 128), sig.cv.subarray(o, o + 128), y.subarray(o, o + 128), o);
  return y;
}
/** nc-fx from the converter's dials. */
function ncfx(sig, delay, bpm, block, opts, drive) {
  const chain = [{ type: 'delay', bypass: false, dials: delay }];
  if (drive) chain.push({ type: 'drive', bypass: false, dials: drive });
  const s = sanitize({ v: 1, chain });
  const fx = createFxDsp(SR, opts);
  fx.setTempo(bpm, 0, true);
  fx.load(compile(s), 0, true);
  const oL = new Float32Array(sig.n), oR = new Float32Array(sig.n);
  for (let o = 0; o < sig.n; o += block) {
    const e = Math.min(sig.n, o + block);
    fx.process(sig.inL.subarray(o, e), sig.inR.subarray(o, e), oL.subarray(o, e), oR.subarray(o, e), e - o, o, sig.cv.subarray(o, e));
  }
  return [oL, oR, s.chain[1].dials];
}
const maxAbs = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; };

/** The converter (INTEGRATION-bass.md) for Bass's delay params, and the Bass params those dials stand for. */
function convert(division, feedback, send, tone, lowCut, bpm, modSend) {
  const dials = { beats_free: division, delay_beats: nearestNote(division), mode: 1, mix: 100, feedback: Math.round(100 * feedback),
    send: Math.round(100 * send), mod_send: Math.round(100 * modSend), tone: Math.round(99 * tone), low_cut: Math.round(lowCut) };
  const p = [division, dials.feedback / 100, dials.send / 100, dials.tone / 99, dials.low_cut, bpm, dials.mod_send / 100];
  return { dials, p };
}
const NOTES = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2];
function nearestNote(v) { let b = NOTES[0]; for (const n of NOTES) if (Math.abs(n - v) < Math.abs(b - v)) b = n; return b; }

let total = 0, worst = 0;
function check(c, label, sig = S, block = 128, opts) {
  const [oL, oR, got] = ncfx(sig, c.dials, c.p[5], block, opts);
  for (const k in c.dials) assert.equal(got[k], c.dials[k], 'dial survives sanitize: ' + k);
  const dL = maxAbs(oL, bass(sig.vL, sig, c.p)), dR = maxAbs(oR, bass(sig.vR, sig, c.p));
  worst = Math.max(worst, dL, dR); total++;
  assert.equal(dL, 0, `L ${label} ${JSON.stringify(c.dials)} @${c.p[5]}`);
  assert.equal(dR, 0, `R ${label} ${JSON.stringify(c.dials)} @${c.p[5]}`);
}

test('Send == Bass delay: tone x low cut (9 settings)', () => {
  for (const tone of [0, 0.5, 1]) for (const lowCut of [20, 120, 1000]) check(convert(0.75, 0.35, 1, tone, lowCut, 120, 0.5), 'tone/cut');
});
test('Send == Bass delay: send x mod send x feedback x division (72 settings)', () => {
  for (const send of [0, 0.25, 1]) for (const modSend of [0, 0.5]) for (const fb of [0, 0.35, 0.9])
    for (const division of [0.125, 0.25, 0.75, 1.5]) check(convert(division, fb, send, 0.5, 120, 120, modSend), 'send');
});
test('Send == Bass delay: free divisions (incl. 0.75) x tempo 120/125/150 (21 settings)', () => {
  for (const bpm of [120, 125, 150]) for (const division of [0.125, 0.3, 0.6, 0.75, 1.37, 1.9, 2])
    check(convert(division, 0.35, 1, 0.5, 120, bpm, 0.5), 'free');
});
test('Send == Bass delay at any host block size (filters on the absolute 128-frame grid)', () => {
  const c = convert(0.3, 0.6, 0.25, 0.5, 120, 125, 0.5);
  for (const block of [1, 37, 64, 128, 256, 1000]) check(c, 'block ' + block, S, block);
  console.log(`bass delay parity: ${total} settings x 2 channels x ${S.n} samples, max abs diff ${worst}`);
});
test('Acid drive -> Send delay == Bass drive -> delay (the chain, effects only)', () => {
  for (const [division, bpm] of [[0.75, 120], [0.3, 125], [1.37, 150]]) {
    const c = convert(division, 0.5, 1, 0.5, 120, bpm, 0.5);
    const drive = { curve: 1, drive_db: Math.round(10 * 20 * Math.log10(1 + 9 * 0.25)) / 10, tone: Math.round(99 * 0.6), mix: 100, mod_drive: 50, mod_tone: 30, output_db: 0 };
    const dp = [(Math.pow(10, drive.drive_db / 20) - 1) / 9, drive.tone / 99, 1, 0.5, 0.3];
    const [oL] = ncfx(S, c.dials, bpm, 128, undefined, drive);
    assert.equal(maxAbs(oL, bass(S.vL, S, c.p, dp)), 0, `chain ${division} @${bpm}`);
  }
});
test('past the line length (6 s): exact when the lines match (Bass reads rp = wp - d, so the wrap point matters)', () => {
  const long = signal(6 * SR);
  const c = convert(0.3, 0.9, 1, 0.5, 120, 125, 0.5);
  // nc-fx's line is ceil(maxDelaySeconds * sr) + 8 samples; Bass's 4 s line is 192000.
  check(c, 'long, matched lines', long, 128, { maxDelaySeconds: 191991.5 / SR });
  const [oL] = ncfx(long, c.dials, 125, 128);
  const r = maxAbs(oL, bass(long.vL, long, c.p));
  console.log(`bass delay parity past 4 s with nc-fx's default 4.9 s line: max abs diff ${r}`);
  assert.ok(r < 1e-6, String(r));
});
