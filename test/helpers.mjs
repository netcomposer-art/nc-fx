import { createFxDsp } from '../src/dsp.js';
export const SR = 48000;
export function noiseBursts(n, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = (i % 12000) < 3000 ? 1 : 0;
    L[i] = env * (0.5 * Math.sin(i * 0.03) + 0.3 * (rnd() * 2 - 1));
    R[i] = env * (0.4 * Math.sin(i * 0.021) + 0.3 * (rnd() * 2 - 1));
  }
  return [L, R];
}
/** Render through an engine in 128-frame blocks. */
export function renderDsp(fx, inL, inR, block = 128) {
  const n = inL.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0; o < n; o += block) {
    const e = Math.min(n, o + block);
    fx.process(inL.subarray(o, e), inR ? inR.subarray(o, e) : null, oL.subarray(o, e), oR.subarray(o, e), e - o);
  }
  return [oL, oR];
}
export function identical(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false; return true; }
export function rmsDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s / a.length); }
export function engine(program, opts) { const fx = createFxDsp(SR, opts); if (program) fx.load(program, 0, true); return fx; }
