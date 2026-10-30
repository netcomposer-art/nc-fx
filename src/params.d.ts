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
  /** A finer step while another dial of the same effect has a value: drive_db is 0.1 dB when curve is 1 (Acid). */
  stepWhen?: ReadonlyArray<{ key: string; value: number; step: number }>;
  /** delay.low_cut: 'log' (a UI hint). */
  curve?: 'log';
  /** delay.delay_beats: overridden while this dial (beats_free) is non-zero. */
  overriddenBy?: string;
  /** delay.beats_free: kept as given (no step rounding); 0 = off, else clamped to minOn..max. */
  exact?: true;
  minOn?: number;
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
export const NPARAMS: 18;
export const PARAM_INDEX: Readonly<Record<FxEffectType, Readonly<Record<string, number>>>>;

export function delaySeconds(beats: number, bpm: number): number;
export function effectType(t: unknown): FxEffectType | null;
export function effectDef(type: unknown): FxEffectDef | null;
export function dialDef(type: unknown, key: string): FxDialDef | null;
/** Round (to `step`, default 1) and clamp, or snap to an option; non-numbers give the default. */
export function clampDial(d: { min: number; max: number; default: number; options?: ReadonlyArray<{ value: number }>; exact?: true; minOn?: number }, raw: unknown, step?: number | null): number;
/** ASTRID's delay Timing for a raw value: the nearest of ASTRID's notes (no 1/32). */
export function astridBeats(raw: number): number;
/** The dial's step given its effect's other dials (`stepWhen`), else `d.step`. */
export function dialStep(d: FxDialDef, dials?: Record<string, number>): number | null;
/** Re-clamps the dials whose step depends on another dial, from `raw` (or their current values). */
export function restep(type: FxEffectType, dials: Record<string, number>, raw?: Record<string, unknown>): void;
export function defaultState(): FxState;
/** Any saved state (nc-fx v1, or ASTRID's HackSlot[] array) to a clean v1 state; never throws. */
export function migrate(raw: unknown): { state: FxState; dropped: string[] };
export function sanitize(raw: unknown): FxState;
export function cloneState(s: FxState): FxState;
export function dialToDsp(type: FxEffectType, key: string, value: number | boolean): number;
export function compile(state: unknown, into?: Float64Array): Float64Array;
export interface FxParamInfo {
  effect: FxEffectType; key: string; label: string; index: number; unit: 'dB' | '%' | 'beats' | 'ms' | 'Hz' | null;
  min: number; max: number; step: number | null; default: number | boolean; curve: 'linear' | 'stepped' | 'log';
  control: 'knob' | 'select' | 'toggle'; tempoSynced: boolean; options?: Array<{ value: number; label: string }>;
  /** drive.drive_db: [{ key: 'curve', value: 1, step: 0.1 }] (0.1 dB in Acid; whole dB in Smooth). */
  stepWhen?: Array<{ key: string; value: number; step: number }>;
  /** delay.delay_beats: 'beats_free' (the select is overridden while it is non-zero). */
  overriddenBy?: string;
  /** delay.beats_free: 0 is off; otherwise values are at least minOn (0.125). */
  offValue?: 0; minOn?: number;
}
/** Every control as plain JSON (no functions). */
export function describeParams(): FxParamInfo[];
/** Readouts by 'effect.key' (e.g. 'delay.delay_beats'); bpm is used by tempo-synced ones. */
export const FORMATS: Readonly<Record<string, (value: number, bpm?: number) => string>>;
