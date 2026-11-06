/** A Gate slot's steps: 16 levels (0-100 %) and 16 shapes (0-4, GATE_SHAPES). Steps 8 plays the first eight. */
export interface GatePattern { levels: number[]; shapes: number[] }
export interface GatePatternDef { name: string; note: string; dials: Record<string, number>; levels: number[]; shapes: number[] }
export const GATE_SHAPES: ReadonlyArray<'hard' | 'pump' | 'swell' | 'blip' | 'glide'>;
export const GATE_SHAPE_LABELS: ReadonlyArray<string>;
export const GATE_STEPS: 16;
/** The starting patterns, in the picker's order (Ducker first: where a new Gate starts). */
export const GATE_PATTERNS: ReadonlyArray<GatePatternDef>;
export const GATE_DEFAULT: 'Ducker';
/** A starting pattern by name (case-insensitive): its dials and steps (copies), or null. */
export function gatePreset(name: string): { name: string; dials: Record<string, number>; pattern: GatePattern } | null;
/** Any saved pattern to a clean one; missing or bad values are Ducker's. */
export function cleanPattern(raw: unknown): GatePattern;
/** The engine params for a pattern (k 10-15). */
export function packPattern(pattern: unknown): Array<[number, number]>;
/** The starting pattern a slot is on, or 'Custom'. */
export function gatePatternName(slot: { dials?: Record<string, number>; pattern?: unknown } | null | undefined): string;
/** Steps that play each pass (12 at most for 1/8T, which restarts every bar). */
export function gateStepsPlayed(dials: Record<string, number> | null | undefined): number;
/** The step (0-based) playing at `beat` (from bar 1), as the engine counts it. */
export function gateStepAt(dials: Record<string, number> | null | undefined, beat: number, beatsPerBar?: number): number;
/** The gain target (0..1) across step i, n + 1 samples: the step's shape at its level (Glide leans into the next). */
export function gateCurve(dials: Record<string, number> | null | undefined, pattern: unknown, i: number, n: number): number[];
