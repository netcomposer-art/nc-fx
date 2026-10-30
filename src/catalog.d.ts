/** A catalog type: every effect nc-fx has (ASTRID's Hacks). */
export type FxType = 'lowpass' | 'highpass' | 'bandpass' | 'delay' | 'plate' | 'flanger' | 'chorus' | 'phaser' | 'eq' | 'drive' | 'compressor' | 'width';
/** A dial law (hacks.ts): pow a * b^(v / div), or exp2 a * 2^(m * v / div); then Math.round or toFixed. */
export interface FxLaw { pow?: [number, number]; exp2?: [number, number]; div: number; round?: true; fixed?: number; zeroNull?: true }
/** How a dial is read out (see formatDial and src/catalog.js for each fmt). */
export interface FxFormat {
  fmt: 'db' | 'pct' | 'wet' | 'signedPct' | 'num' | 'fixed' | 'hz' | 'q' | 'ratio' | 'rate' | 'balance' | 'option' | 'stages' | 'tempoMs' | 'freeBeats';
  zero?: string; suffix?: string; law?: FxLaw; astrid?: true; offAt?: number; add?: number; div?: number; digits?: number;
}
export interface FxCatalogDial {
  key: string; label: string; min: number; max: number; default: number;
  /** 1 for sliders; null for option dials (beats_free: 0.001). */
  step: number | null;
  /** Its engine param (src/units.js); 0 is the on flag. */
  k: number;
  unit: 'dB' | '%' | 'beats' | 'ms' | 'Hz' | null;
  format: FxFormat;
  options?: ReadonlyArray<{ value: number; label: string }>;
  /** Shown under "More" (nc-fx's own dials; their defaults are ASTRID's sound). */
  more?: true;
  /** Dial -> engine value: absent = as is; { div } = value / div; { law }. */
  dsp?: { div?: number; law?: FxLaw };
  /** ASTRID's name for this dial where it differs (the delay's mix is ASTRID's wet). */
  astridKey?: string;
  stepWhen?: ReadonlyArray<{ key: string; value: number; step: number }>;
  curve?: 'log'; overriddenBy?: string; exact?: true; minOn?: number; tempoSynced?: true;
}
export interface FxCatalogEntry { type: FxType; label: string; hidden?: true; fixed?: true; tempoSynced?: true; note?: string; dials: ReadonlyArray<FxCatalogDial> }

export const CATALOG: ReadonlyArray<FxCatalogEntry>;
export const CATALOG_TYPES: ReadonlyArray<FxType>;
/** What "Add" offers, in ASTRID's order (the hidden filters are left out). */
export const CATALOG_MENU: ReadonlyArray<FxType>;
export const ASTRID_NOTES: ReadonlyArray<number>;
export const MAX_DELAY_S: 4.9;
export function catalogType(t: unknown): FxType | null;
export function catalogEntry(type: unknown): FxCatalogEntry | null;
export function catalogDial(type: unknown, key: string): FxCatalogDial | null;
export function lawValue(law: FxLaw, v: number): number | null;
export function dialDsp(dial: FxCatalogDial, v: number): number;
export function formatDial(dial: FxCatalogDial, v: number, bpm?: number): string;
export function delaySeconds(beats: number, bpm: number): number;
/** The catalog as plain JSON (a copy). */
export function describeCatalog(): FxCatalogEntry[];
