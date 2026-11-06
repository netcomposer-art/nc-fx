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
 * toAudioTime(seconds) maps the map's timeline seconds (map.timeAt) to AudioContext time: for nc-clock on a
 * shared timebase that is AudioClockMapper.toContextTime; identity only when the map runs on ctx.currentTime.
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
 * Keep fx on an nc-clock NcClock (anything with onChange(cb) and transport {tempo, bpm, timeAt, beatAt}).
 * Tempo changes land at their beat's time on the audio clock. Clock times are converted to AudioContext
 * time with opts.mapper (nc-clock's AudioClockMapper: toContextTime, and sharedNow for "now") or
 * opts.toAudioTime. A 'shared' clock (epoch seconds) needs one of them: without it, changes apply at once
 * (with one warning) instead of at an epoch time the audio clock never reaches. Other timebases ('audio',
 * 'local' on ctx.currentTime) are used as AudioContext time as they are.
 * On subscribe and on every start or snapshot the fx gets the tempo playing now (beatAt(now), with
 * opts.now or mapper.sharedNow) plus any later changes; without a "now", the transport's current tempo.
 * Returns the unsubscribe function from clock.onChange.
 * @param {{setTempo(bpm: number, at?: number): void}} fx
 * @param {{mapper?: {toContextTime(s: number): number, sharedNow?(): number}, toAudioTime?: (s: number) => number, now?: () => number}} [opts]
 */
export function followClock(fx, clock, opts) {
  var o = opts || {};
  var m = o.mapper && typeof o.mapper.toContextTime === 'function' ? o.mapper : null;
  var toAudio = typeof o.toAudioTime === 'function' ? o.toAudioTime
    : m ? function (s) { return m.toContextTime(s); }
    : clock && clock.timebase === 'shared' ? null : function (s) { return s; };
  var now = typeof o.now === 'function' ? o.now : m && typeof m.sharedNow === 'function' ? function () { return m.sharedNow(); } : null;
  var tr = clock && clock.transport ? clock.transport : clock;
  var map = tr && tr.tempo ? tr.tempo : tr;
  var warned = false;
  function audioAt(beat) {
    if (!toAudio) {
      if (!warned && typeof console !== 'undefined') {
        warned = true;
        console.warn('nc-fx followClock: a shared clock needs { mapper } (AudioClockMapper) or { toAudioTime }; applying tempo changes at once');
      }
      return undefined;
    }
    if (!tr || typeof tr.timeAt !== 'function' || typeof beat !== 'number') return undefined;
    var t = toAudio(tr.timeAt(beat));
    return typeof t === 'number' && isFinite(t) ? t : undefined;
  }
  function sync() {
    var beat = now && tr && typeof tr.beatAt === 'function' ? tr.beatAt(now()) : NaN;
    if (!isFinite(beat)) {
      var cur = tr && typeof tr.bpm === 'number' ? tr.bpm : bpmOf(map, 0);
      if (cur > 0) fx.setTempo(cur);
      return;
    }
    var b = bpmOf(map, beat);
    if (b > 0) fx.setTempo(b);
    var points = (map && (map.points || map.tempoPoints)) || [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (p.beat > beat && p.bpm > 0) { var at = audioAt(p.beat); if (at !== undefined) fx.setTempo(p.bpm, at); }
    }
  }
  // The beat clock (Gate): Play lines it up with the transport's beat (bar 1 = beat 0); Stop lets it run free at
  // the tempo from where it is, so a Gate keeps moving while stopped. A snapshot (joining a running clock) lines up.
  var beats = typeof fx.setBeat === 'function';
  function bar() {
    var m = tr && tr.meter, n = m && typeof m.beatsPerBar === 'number' ? m.beatsPerBar : 0;
    if (beats && n >= 1 && typeof fx.setBar === 'function') fx.setBar(n);
  }
  function audioTime(s) {
    if (!toAudio || typeof s !== 'number' || !isFinite(s)) return undefined;
    var t = toAudio(s);
    return typeof t === 'number' && isFinite(t) ? t : undefined;
  }
  function lineUp() {
    if (!beats) return;
    bar();
    if (!tr || !tr.running) { fx.freeRun(); return; }
    var b = now && typeof tr.beatAt === 'function' ? tr.beatAt(now()) : NaN;
    if (isFinite(b)) fx.setBeat(b, audioAt(b));
  }
  sync();
  lineUp();
  if (!clock || typeof clock.onChange !== 'function') return function () {};
  return clock.onChange(function (c) {
    if (!c) return;
    if (c.kind === 'tempo' && c.bpm > 0) fx.setTempo(c.bpm, audioAt(c.atBeat));
    else if (c.kind === 'snapshot') { sync(); lineUp(); }
    else if (c.kind === 'start') {
      sync();
      if (beats && typeof c.beat === 'number' && isFinite(c.beat)) { bar(); fx.setBeat(c.beat, audioTime(c.at)); }
    } else if (c.kind === 'stop' && beats) fx.freeRun(audioTime(c.at));
  });
}
