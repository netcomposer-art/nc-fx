// nc-fx: the audio watchdog, main thread. Notices when an AudioContext's audio thread has stopped: the context says
// 'running' but its clock (currentTime) hasn't moved for `stallMs`. That is what a hang on the audio thread looks
// like from outside (a plugin stuck in something the loop guard can't see, src/loop-guard.js): every node on that
// context goes silent at once, and nothing on the page can stop the thread. Closing or suspending such a context, or
// reloading the page, waits for the thread and can hang the tab, so the watchdog only reports: the host decides what
// to do (stop running the plugins that were playing, move the audio to a fresh context or page, say what happened).
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// It polls (a timer, every `everyMs`); it never touches the context. A late timer (the tab in the background, the
// computer asleep, a busy main thread) doesn't count as frozen time: only gaps under 4 x everyMs add up.

/**
 * Watch `ctx` for a stalled audio thread. Calls onStall({ frozenMs, at }) once when its clock stops for stallMs while
 * it is 'running', and onResume() if the clock moves again after that (a long but finite hang).
 * @param {{ readonly currentTime: number, readonly state: string }} ctx
 * @param {{ onStall: (info: { frozenMs: number, at: number }) => void, onResume?: () => void, stallMs?: number,
 *   everyMs?: number, now?: () => number, setInterval?: typeof setInterval, clearInterval?: typeof clearInterval }} opts
 * @returns {{ stop(): void, stalled(): boolean }}
 */
export function watchAudioStall(ctx, opts) {
  var o = opts || {};
  var stallMs = o.stallMs > 0 ? o.stallMs : 1500, every = o.everyMs > 0 ? o.everyMs : 250;
  var now = o.now || function () { return typeof performance !== 'undefined' ? performance.now() : Date.now(); };
  var setI = o.setInterval || setInterval, clearI = o.clearInterval || clearInterval;
  var last = ctx.currentTime, lastTick = now(), frozen = 0, stalled = false;
  var timer = setI(function () {
    var t = now(), gap = t - lastTick, ct = ctx.currentTime;
    lastTick = t;
    if (ctx.state !== 'running' || ct !== last) {
      last = ct;
      frozen = 0;
      if (stalled && ctx.state === 'running') { stalled = false; if (o.onResume) o.onResume(); }
      return;
    }
    if (gap > 4 * every) { frozen = 0; return; } // a late timer: start counting again
    frozen += gap;
    if (!stalled && frozen >= stallMs) {
      stalled = true;
      if (o.onStall) o.onStall({ frozenMs: frozen, at: ct });
    }
  }, every);
  return {
    stop: function () { clearI(timer); },
    stalled: function () { return stalled; }
  };
}
