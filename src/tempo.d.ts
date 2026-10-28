export interface TempoTarget { setTempo(bpm: number, at?: number): void }
/** Anything shaped like nc-clock's TempoMap. */
export interface TempoMapLike { bpm?: number; bpmAt?(beat: number): number; timeAt?(beat: number): number; points?: ReadonlyArray<{ beat: number; bpm: number }>; tempoPoints?: ReadonlyArray<{ beat: number; bpm: number }> }
/** Anything shaped like nc-clock's NcClock. */
export interface ClockLike {
  onChange(cb: (c: { kind: string; atBeat?: number; bpm?: number }) => void): () => void;
  transport: { tempo: TempoMapLike; timeAt(beat: number): number; beatAt(time: number): number };
}
export function bpmOf(source: number | TempoMapLike | null | undefined, beat?: number): number;
export function applyTempoMap(fx: TempoTarget, map: TempoMapLike, opts?: { fromBeat?: number; toBeat?: number; toAudioTime?: (s: number) => number; includeStart?: boolean }): number;
export function followClock(fx: TempoTarget, clock: ClockLike, opts?: { now?: () => number; toAudioTime?: (s: number) => number }): () => void;
