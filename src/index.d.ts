import type { FxState, FxEffectName, FxEffectType, FxEffectDef } from './params.js';
import type { FxPanel, FxPanelOptions } from './ui.js';
export type { FxState, FxSlot, FxEffectName, FxEffectType, FxEffectDef, FxDialDef, FxParamInfo } from './params.js';
export {
  EFFECTS, EFFECT_ORDER, STATE_VERSION, sanitize, migrate, defaultState, delaySeconds, compile, dialToDsp, describeParams, FORMATS
} from './params.js';
export type { FxType, FxCatalogEntry, FxCatalogDial, FxFormat, FxLaw } from './catalog.js';
export { CATALOG, CATALOG_MENU, catalogEntry, catalogDial, formatDial, describeCatalog } from './catalog.js';
export type { FxSlotState, FxSlotV2, AstridHackSlot } from './slots.js';
export { SLOTS_VERSION, DEFAULT_SLOTS, migrateSlots, sanitizeSlots, newSlot, slotName, moveSlot, toAstridHacks, toAstridDocument } from './slots.js';
import type { FxSlotState, AstridHackSlot } from './slots.js';
import type { FxType } from './catalog.js';

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
  /** Longest delay time in seconds; sizes the delay line (~0.4 MB per second at 48 kHz). Default 4.9, max 60. */
  maxDelaySeconds?: number;
  /**
   * Opt-in mod input: `fx.modInput` becomes a mono GainNode wired to the worklet's second input, for a control
   * signal such as Bass's accent CV (channel 0 of what is connected). Default false: one input, as before.
   * Nothing is routed from it yet, so the sound is bit-identical with or without it; later dials set its depths.
   */
  modInput?: boolean;
  /**
   * ASTRID's chain model instead of the fixed chain: up to this many effects (true = 3, ASTRID's; max 8) of any
   * catalog type, in any order, with click-free add / remove / move. The state is then v2 (FxSlotState); `state`
   * also takes v1, ASTRID's saved hacks (HackSlot[]), its widgets, or a schema-2 document.
   */
  slots?: true | number;
}
export interface FxChange { effect: FxEffectType | null; key: string | null; value: number | boolean | null }

export interface FxCore {
  readonly input: GainNode;
  readonly output: GainNode;
  /** The mod input (`modInput: true`), else null. Mono, channelCountMode 'explicit', 'discrete'. */
  readonly modInput: GainNode | null;
  /** Resolves once the chain is in the path, or it gave up (status 'unavailable'). Never rejects. */
  readonly ready: Promise<void>;
  /**
   * setParam / setState / setTempo / clear called before `ready` are queued in call order and replayed when the
   * worklet starts: a future `at` is applied exactly; a past or omitted one is clamped to now. They never change
   * the starting state (that is `opts.state` / `opts.bpm` at construction). Past 256 queued calls the queue
   * folds into one load of the current state plus the tempo, applied when the worklet starts.
   * A time more than 600 s ahead of ctx.currentTime (a time on the wrong clock) is refused with one warning.
   */
  readonly status: 'loading' | 'ready' | 'unavailable' | 'disposed';
  readonly error: unknown;
  readonly latencySamples: number;
  readonly limiter: 'off' | 'soft' | 'lookahead';
  /** A dial in UI units, or key 'bypass' with a boolean. at = AudioContext time. Returns the stored value. */
  setParam(effect: FxEffectName, key: string, value: number | boolean, at?: number): number | boolean | undefined;
  getParam(effect: FxEffectName, key: string): number | boolean | undefined;
  getState(): FxState;
  setState(state: unknown, opts?: { at?: number }): void;
  setTempo(bpm: number, at?: number): void;
  getTempo(): number;
  /** Drop the delay and reverb tails. fadeMs > 0 (max 1000) fades the wet out and back in. Not the limiter. */
  clear(at?: number | { at?: number; fadeMs?: number }): void;
  onChange(cb: (change: FxChange) => void): () => void;
  dispose(): void;
}
/** createFxCore(ctx, { slots }): ASTRID's chain model. `ref` is an effect id ('delay-1'), or a type for its first instance. */
export interface FxSlotCore extends Omit<FxCore, 'setParam' | 'getParam' | 'getState'> {
  readonly slots: number;
  setParam(ref: string, key: string, value: number | boolean, at?: number): number | boolean | undefined;
  getParam(ref: string, key: string): number | boolean | undefined;
  getState(): FxSlotState;
  /** Add an effect (default last). Returns its id, or undefined when the chain is full or the type is unknown. */
  addEffect(type: FxType | 'reverb', opts?: { index?: number; dials?: Record<string, number>; bypass?: boolean; at?: number }): string | undefined;
  removeEffect(ref: string, opts?: { at?: number }): boolean;
  moveEffect(ref: string, to: number, opts?: { at?: number }): boolean;
  getChain(): Array<{ id: string; type: FxType; name: string; bypass: boolean }>;
  /** ASTRID's saved-hacks shape (settings.hacks) for this chain, and what ASTRID can't hold. */
  toAstrid(): { hacks: AstridHackSlot[]; lossy: string[] };
}
export interface FxSlots extends FxSlotCore {
  mount(el: HTMLElement, opts?: Omit<FxPanelOptions, 'fx'>): Promise<FxPanel>;
}
export interface Fx extends FxCore {
  /** Lazy-loads the panel and renders it into el. If dispose() ran meanwhile, the panel comes back destroyed. */
  mount(el: HTMLElement, opts?: Omit<FxPanelOptions, 'fx'>): Promise<FxPanel>;
}

export function loadFxWorklet(ctx: BaseAudioContext, moduleUrl?: string | URL): Promise<void>;
export function createFxCore(ctx: BaseAudioContext, opts: FxCoreOptions & { slots: true | number }): FxSlotCore;
export function createFxCore(ctx: BaseAudioContext, opts?: FxCoreOptions): FxCore;
export function createFx(ctx: BaseAudioContext, opts: FxCoreOptions & { slots: true | number }): FxSlots;
export function createFx(ctx: BaseAudioContext, opts?: FxCoreOptions): Fx;
