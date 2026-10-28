export const FX_PARAM: Readonly<{
  DRIVE_ON: 0; DRIVE_DB: 1; DRIVE_OUT_DB: 2; DRIVE_MIX: 3;
  DELAY_ON: 4; DELAY_BEATS: 5; DELAY_FEEDBACK: 6; DELAY_MIX: 7;
  PLATE_ON: 8; PLATE_PREDELAY: 9; PLATE_SIZE: 10; PLATE_DECAY: 11; PLATE_DAMPING: 12; PLATE_MIX: 13;
}>;
export const FX_NPARAMS: 14;

export interface FxDspOptions {
  /** 'hold' (default): a bypassed effect costs nothing and its tail is dropped. 'run': it keeps running (ASTRID). */
  bypassMode?: 'hold' | 'run';
  /** 'off' (default), 'lookahead' (-1 dB ceiling, 1.5 ms latency), 'soft' (zero-latency tanh clip to -1 dB). */
  limiter?: 'lookahead' | 'soft' | 'off';
  /** Gain before the limiter. Default 1 (ASTRID's master uses 0.8). */
  preGain?: number;
}

/** The engine, for embedding in an app's own AudioWorkletProcessor. Frames are absolute sample frames. */
export interface FxDsp {
  readonly sampleRate: number;
  readonly latencySamples: number;
  /** Post-chain peaks [L, R] of the last process() call. */
  readonly peak: Float32Array;
  takeGainReduction(): number;
  /** DSP units (see params.compile / dialToDsp). snap = no smoothing. */
  set(index: number, value: number, frame?: number, snap?: boolean): void;
  get(index: number): number;
  load(program: ArrayLike<number>, frame?: number, snap?: boolean): void;
  setTempo(bpm: number, frame?: number, snap?: boolean): void;
  getTempo(): number;
  clear(frame?: number): void;
  /** inR null = mono in; outR null = mono out. blockFrame = AudioWorklet currentFrame. Allocation-free. */
  process(inL: Float32Array | null, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, frames: number, blockFrame?: number): void;
}
export function createFxDsp(sampleRate: number, opts?: FxDspOptions): FxDsp;
