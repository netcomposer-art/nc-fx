import type { FxState, FxEffectName, FxEffectType, FxEffectDef } from './params.js';
import type { FxPanel, FxPanelOptions } from './ui.js';
export type { FxState, FxSlot, FxEffectName, FxEffectType, FxEffectDef, FxDialDef } from './params.js';
export { EFFECTS, EFFECT_ORDER, STATE_VERSION, sanitize, migrate, defaultState, delaySeconds } from './params.js';

export const PROCESSOR_NAME: 'nc-fx@1';

export interface FxCoreOptions {
  /** Starting state (nc-fx v1 or ASTRID's hacks array). Default: all three bypassed at ASTRID's dials. */
  state?: unknown;
  /** Starting tempo. Default 120. */
  bpm?: number;
  /** URL of dist/worklet.js (e.g. Vite `import u from '@netcomposer/nc-fx/worklet?url'`). Omitted: Blob URL. */
  moduleUrl?: string | URL;
  /** Default 'run' (tails ring out, like ASTRID). 'hold': zero CPU while bypassed, tails dropped. */
  bypassMode?: 'hold' | 'run';
  /** Default 'off' (transparent). Opt in: 'soft' (zero latency) or 'lookahead' (1.5 ms latency). */
  limiter?: 'lookahead' | 'soft' | 'off';
  /** Default 1 (transparent). ASTRID's master uses 0.8. */
  preGain?: number;
  /** Seconds for the wire -> chain crossfade when the worklet arrives. Default 0.012. */
  crossfade?: number;
}
export interface FxChange { effect: FxEffectType | null; key: string | null; value: number | boolean | null }

export interface FxCore {
  readonly input: GainNode;
  readonly output: GainNode;
  /** Resolves once the chain is in the path, or it gave up (status 'unavailable'). Never rejects. */
  readonly ready: Promise<void>;
  /**
   * setParam / setState / setTempo / clear called before `ready` are queued in call order and replayed when the
   * worklet starts: a future `at` is applied exactly; a past or omitted one is clamped to now. They never change
   * the starting state (that is `opts.state` / `opts.bpm` at construction).
   */
  readonly status: 'loading' | 'ready' | 'unavailable' | 'disposed';
  readonly error: unknown;
  readonly latencySamples: number;
  /** A dial in UI units, or key 'bypass' with a boolean. at = AudioContext time. Returns the stored value. */
  setParam(effect: FxEffectName, key: string, value: number | boolean, at?: number): number | boolean | undefined;
  getParam(effect: FxEffectName, key: string): number | boolean | undefined;
  getState(): FxState;
  setState(state: unknown, opts?: { at?: number }): void;
  setTempo(bpm: number, at?: number): void;
  getTempo(): number;
  clear(at?: number): void;
  onChange(cb: (change: FxChange) => void): () => void;
  dispose(): void;
}
export interface Fx extends FxCore {
  /** Lazy-loads the panel and renders it into el. */
  mount(el: HTMLElement, opts?: Omit<FxPanelOptions, 'fx'>): Promise<FxPanel>;
}

export function loadFxWorklet(ctx: BaseAudioContext, moduleUrl?: string | URL): Promise<void>;
export function createFxCore(ctx: BaseAudioContext, opts?: FxCoreOptions): FxCore;
export function createFx(ctx: BaseAudioContext, opts?: FxCoreOptions): Fx;
