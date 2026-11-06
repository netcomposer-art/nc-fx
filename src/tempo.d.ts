/** setBeat / freeRun / setBar (an nc-fx core has them): followClock lines Gate's beat clock up on Play and lets it run free on Stop. */
export interface TempoTarget { setTempo(bpm: number, at?: number): void; setBeat?(beat: number, at?: number): void; freeRun?(at?: number): void; setBar?(beats: number, at?: number): void }
/** Anything shaped like nc-clock's TempoMap. */
export interface TempoMapLike { bpm?: number; bpmAt?(beat: number): number; timeAt?(beat: number): number; points?: ReadonlyArray<{ beat: number; bpm: number }>; tempoPoints?: ReadonlyArray<{ beat: number; bpm: number }> }
/** Anything shaped like nc-clock's NcClock. */
export interface ClockLike {
  onChange(cb: (c: { kind: string; atBeat?: number; bpm?: number; at?: number; beat?: number }) => void): () => void;
  transport: { tempo: TempoMapLike; bpm?: number; timeAt(beat: number): number; beatAt(time: number): number; running?: boolean; meter?: { beatsPerBar: number } };
  /** nc-clock's snapshot timebase: 'shared' clocks need a mapper or toAudioTime. */
  timebase?: string;
}
/** nc-clock's AudioClockMapper, or anything that maps clock seconds to AudioContext seconds. */
export interface AudioTimeMapper { toContextTime(clockSeconds: number): number; sharedNow?(): number }
export interface FollowClockOptions {
  /** Converts clock times (toContextTime) and gives "now" (sharedNow). */
  mapper?: AudioTimeMapper;
  /** Clock seconds -> AudioContext seconds (instead of a mapper). */
  toAudioTime?: (s: number) => number;
  /** Clock seconds now (instead of mapper.sharedNow). */
  now?: () => number;
}
export function bpmOf(source: number | TempoMapLike | null | undefined, beat?: number): number;
export function applyTempoMap(fx: TempoTarget, map: TempoMapLike, opts?: { fromBeat?: number; toBeat?: number; toAudioTime?: (s: number) => number; includeStart?: boolean }): number;
export function followClock(fx: TempoTarget, clock: ClockLike, opts?: FollowClockOptions): () => void;
