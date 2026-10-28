export type FxEffectType = 'drive' | 'delay' | 'plate';
/** 'reverb' is accepted wherever an effect type is (it means 'plate'). */
export type FxEffectName = FxEffectType | 'reverb';

export interface FxDialDef {
  key: string;
  label: string;
  min: number;
  max: number;
  /** 1 for sliders; null for option dials. */
  step: number | null;
  default: number;
  options?: ReadonlyArray<{ value: number; label: string }>;
  /** Readout text. bpm matters for the delay's Timing (shown in ms). */
  format(value: number, bpm?: number): string;
}
export interface FxEffectDef { type: FxEffectType; label: string; tempoSynced?: true; dials: ReadonlyArray<FxDialDef> }

export interface FxSlot { id: string; type: FxEffectType; bypass: boolean; dials: Record<string, number> }
/** JSON-safe; always all three effects, in the fixed order drive, delay, plate. */
export interface FxState { v: 1; chain: FxSlot[] }

export const STATE_VERSION: 1;
export const MAX_DELAY_S: 4.9;
export const EFFECT_ORDER: ReadonlyArray<FxEffectType>;
export const EFFECTS: ReadonlyArray<FxEffectDef>;
export const NPARAMS: 14;
export const PARAM_INDEX: Readonly<Record<FxEffectType, Readonly<Record<string, number>>>>;

export function delaySeconds(beats: number, bpm: number): number;
export function effectType(t: unknown): FxEffectType | null;
export function effectDef(type: unknown): FxEffectDef | null;
export function dialDef(type: unknown, key: string): FxDialDef | null;
export function clampDial(d: FxDialDef, raw: unknown): number;
export function defaultState(): FxState;
/** Any saved state (nc-fx v1, or ASTRID's HackSlot[] array) to a clean v1 state; never throws. */
export function migrate(raw: unknown): { state: FxState; dropped: string[] };
export function sanitize(raw: unknown): FxState;
export function cloneState(s: FxState): FxState;
export function dialToDsp(type: FxEffectType, key: string, value: number | boolean): number;
export function compile(state: unknown, into?: Float64Array): Float64Array;
