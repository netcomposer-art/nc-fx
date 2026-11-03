// nc-fx's audio watchdog (src/watchdog.js): notices an AudioContext whose audio thread has stopped.

export interface AudioStallOptions {
  /** Once, when the context is 'running' but its clock hasn't moved for stallMs. */
  onStall: (info: { frozenMs: number; at: number }) => void;
  /** When the clock moves again after a stall (a long but finite hang). */
  onResume?: () => void;
  /** Default 1500. */
  stallMs?: number;
  /** How often it looks, in ms. Default 250. */
  everyMs?: number;
  /** For tests. */
  now?: () => number;
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (id: never) => void;
}
/** Watch a context's clock; never touches the context (closing a stalled one can hang the page). */
export function watchAudioStall(
  ctx: { readonly currentTime: number; readonly state: string },
  opts: AudioStallOptions,
): { stop(): void; stalled(): boolean };
