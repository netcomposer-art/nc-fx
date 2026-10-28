// Tempo helpers. nc-fx never imports nc-clock: these take anything shaped like its Transport or
// TempoMap (bpm, bpmAt(beat), timeAt(beat), points/tempoPoints [{beat, bpm}]) or a plain number.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.

/** BPM from a number, {bpm}, or {bpmAt(beat)} (at `beat`, default 0). NaN if none. */
export function bpmOf(source, beat) {
  if (typeof source === 'number') return source;
  if (!source) return NaN;
  if (typeof source.bpmAt === 'function') return +source.bpmAt(beat || 0);
  if (typeof source.bpm === 'number') return source.bpm;
  return NaN;
}

/**
 * Schedule a tempo map's changes between two beats on an fx instance, on the audio clock.
 * toAudioTime(seconds) maps the map's timeline seconds (map.timeAt) to AudioContext time.
 * Returns how many changes were scheduled. Call it per lookahead window, like any scheduler.
 * @param {{setTempo(bpm: number, at?: number): void}} fx
 */
export function applyTempoMap(fx, map, opts) {
  var o = opts || {};
  var from = typeof o.fromBeat === 'number' ? o.fromBeat : 0;
  var to = typeof o.toBeat === 'number' ? o.toBeat : Infinity;
  var toAudio = typeof o.toAudioTime === 'function' ? o.toAudioTime : function (s) { return s; };
  var points = (map && (map.points || map.tempoPoints)) || [];
  var n = 0;
  if (o.includeStart !== false) {
    var b0 = bpmOf(map, from);
    if (b0 > 0) { fx.setTempo(b0, typeof map.timeAt === 'function' ? toAudio(map.timeAt(from)) : undefined); n++; }
  }
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    if (!(p.beat > from && p.beat < to) || !(p.bpm > 0)) continue;
    fx.setTempo(p.bpm, typeof map.timeAt === 'function' ? toAudio(map.timeAt(p.beat)) : undefined);
    n++;
  }
  return n;
}

/**
 * Keep fx on an nc-clock NcClock (anything with onChange(cb) and transport {tempo, timeAt, beatAt}).
 * Tempo changes land at their beat's time on the audio clock; toAudioTime maps clock seconds to
 * AudioContext time (identity when the clock's timebase is the AudioContext, nc-clock's usual setup).
 * Returns the unsubscribe function from clock.onChange.
 * @param {{setTempo(bpm: number, at?: number): void}} fx
 * @param {{now?: () => number, toAudioTime?: (s: number) => number}} [opts]
 */
export function followClock(fx, clock, opts) {
  var o = opts || {};
  var toAudio = typeof o.toAudioTime === 'function' ? o.toAudioTime : function (s) { return s; };
  var tr = clock && clock.transport ? clock.transport : clock;
  var now = typeof o.now === 'function' ? o.now : null;
  function sync() {
    var beat = now && tr && typeof tr.beatAt === 'function' ? tr.beatAt(now()) : 0;
    var b = bpmOf(tr && tr.tempo ? tr.tempo : tr, beat);
    if (b > 0) fx.setTempo(b);
  }
  sync();
  if (!clock || typeof clock.onChange !== 'function') return function () {};
  return clock.onChange(function (c) {
    if (!c) return;
    if (c.kind === 'tempo' && c.bpm > 0) {
      var at = tr && typeof tr.timeAt === 'function' && typeof c.atBeat === 'number' ? toAudio(tr.timeAt(c.atBeat)) : undefined;
      fx.setTempo(c.bpm, at);
    } else if (c.kind === 'snapshot' || c.kind === 'start') sync();
  });
}
