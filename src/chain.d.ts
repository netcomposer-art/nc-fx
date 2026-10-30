import type { FxDspOptions } from './dsp.js';
export interface FxChainDspOptions extends FxDspOptions {
  /** How many effects the chain holds: 1-8, default 3 (ASTRID's). */
  slots?: number;
}
/** ASTRID's chain model, for embedding in an app's own AudioWorkletProcessor. uids are the host's (> 0, never reused). */
export interface FxChainDsp {
  readonly sampleRate: number;
  readonly slots: number;
  readonly latencySamples: number;
  readonly peak: Float32Array;
  takeGainReduction(): number;
  /** An effect instance (catalog type), off at its defaults; then set() its params (snap) and order() it in. */
  add(uid: number, type: string | number, frame?: number): boolean;
  /** The order to play; immediate = no fade (a load). Otherwise ASTRID's 4 ms chain fade. */
  order(uids: ArrayLike<number>, frame?: number, immediate?: boolean): boolean;
  /** k 0 = on flag; the others are the catalog dials' `k`, in engine units (catalog dialDsp). */
  set(uid: number, k: number, value: number, frame?: number, snap?: boolean): boolean;
  get(uid: number, k: number): number | undefined;
  playing(): number[];
  setTempo(bpm: number, frame?: number, snap?: boolean): boolean;
  getTempo(): number;
  clear(frame?: number, fadeMs?: number): boolean;
  process(inL: Float32Array | null, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, frames: number, blockFrame?: number, mod?: Float32Array | null): void;
}
export function createFxChainDsp(sampleRate: number, opts?: FxChainDspOptions): FxChainDsp;
