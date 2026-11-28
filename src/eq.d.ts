/** The EQ's default low shelf (Hz), high shelf (Hz) and its gain range (dB, each way). The shelves move since 2026-11-28 (low_hz, high_hz). */
export const EQ_LOW_HZ: 150;
export const EQ_HIGH_HZ: 6000;
export const EQ_RANGE_DB: 18;

/** EQ dials in UI units (as on the sliders): gains in dB, mid_hz / *_q 0-100 (laws), the other frequencies in Hz. */
export type EqDials = Partial<Record<'low_db' | 'low_hz' | 'lm_db' | 'lm_hz' | 'lm_q' | 'mid_db' | 'mid_hz' | 'mid_q' | 'hm_db' | 'hm_hz' | 'hm_q' | 'high_db' | 'high_hz', number>>;
export interface EqBand { id: 'low' | 'lowmid' | 'mid' | 'highmid' | 'high'; kind: 0 | 1 | 2; hz: number; db: number; q: number }

/** One band's normalised coefficients [b0, b1, b2, a1, a2], as the engine computes them. kind 0 low shelf, 1 bell, 2 high shelf. */
export function eqCoefficients(kind: 0 | 1 | 2, hz: number, db: number, q: number, sampleRate: number): [number, number, number, number, number];
/** The bands the dials play, in engine units. */
export function eqBands(dials: EqDials): EqBand[];
/** The response in dB at each frequency (Hz): the combined curve and each band's own (low, low-mid, mid, high-mid, high). */
export function eqResponse(dials: EqDials, sampleRate: number, freqs: ArrayLike<number>): { total: Float64Array; bands: Float64Array[] };
/** A graph patch (engine units) as dial changes, rounded to each dial's step; unchanged dials left out. */
export function eqPatchDials(dials: EqDials, id: string, patch: { hz?: number; db?: number; q?: number }): Array<[string, number]>;
/** The dials that put a band back to its default. */
export function eqResetDials(id: string): Array<[string, number]>;

/** A shared, ref-counted AnalyserNode on a chain's output: connected only while some graph has it open. */
export interface FxSpectrum { open(): AnalyserNode | null; close(): void }
export function fxSpectrum(fx: { output: AudioNode; status?: string }): FxSpectrum | null;

/** The nc-ui kit's EQ graph control (type 'eqGraph'), as plain data. */
export interface EqGraphBandSpec {
  id: string; label: string; kind: 'lowshelf' | 'peak' | 'highshelf';
  hz: number; db: number; q: number;
  moveHz: boolean; moveQ: boolean; minHz: number; maxHz: number; minQ: number; maxQ: number;
  valueText: string; help?: string;
}
export interface EqGraphSpec {
  type: 'eqGraph';
  id: string;
  label: string;
  range: number;
  sampleRate: number;
  on: boolean;
  bands: EqGraphBandSpec[];
  help?: string;
  response(freqs: Float64Array): { total: Float64Array; bands: Float64Array[] };
  spectrum?: FxSpectrum;
  onBand(id: string, patch: { hz?: number; db?: number; q?: number }): void;
  onReset(id: string): void;
}
export interface EqGraphOptions {
  /** The control's kit id. */
  id: string;
  /** The EQ sliders' own setter (dial key, value in UI units); it should re-render, as a slider move does. */
  set(key: string, value: number): void;
  label?: string;
  sampleRate?: number;
  /** false while the EQ is bypassed: the curve is drawn quiet. */
  on?: boolean;
  /** Hover words (data-nc-help) for the graph and each band's node. */
  help?: { graph?: string; low?: string; lowmid?: string; mid?: string; highmid?: string; high?: string };
  /** false: no spectrum behind the curve. */
  spectrum?: false;
}
export function eqGraph(
  fx: { getParam(ref: string, key: string): number | boolean | undefined; output?: AudioNode; status?: string } | null,
  ref: string,
  opts: EqGraphOptions,
): EqGraphSpec;
