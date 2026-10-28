// nc-clock v0.3.0 (netcomposer-art/nc-clock b753634), bundled with esbuild 0.25.10 for nc-fx's followClock tests.
// nc-clock was created by Peter Semmelhack (https://psem.me/). MIT License. Test fixture only; not shipped.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/core/tempo-map.ts
var EPS = 1e-9;
function clampBpm(bpm, min, max, fallback = 120) {
  if (!Number.isFinite(bpm)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, bpm));
}
var TempoMap = class _TempoMap {
  /** Create a map with one tempo from the anchor on. */
  constructor(options = {}) {
    /** Lowest accepted tempo. */
    __publicField(this, "minBpm");
    /** Highest accepted tempo. */
    __publicField(this, "maxBpm");
    __publicField(this, "maxPoints");
    __publicField(this, "segs");
    this.minBpm = options.minBpm ?? 1;
    this.maxBpm = options.maxBpm ?? 999;
    this.maxPoints = Math.max(2, options.maxPoints ?? 4096);
    const anchor = options.anchor ?? { beat: 0, time: 0 };
    this.segs = [{ beat: anchor.beat, time: anchor.time, bpm: this.clamp(options.bpm ?? 120) }];
  }
  /** The anchor: the first point's beat and time. */
  get anchor() {
    return { beat: this.segs[0].beat, time: this.segs[0].time };
  }
  /** All tempo points, oldest first. The first point is at the anchor beat. */
  get points() {
    return this.segs.map((s) => ({ beat: s.beat, bpm: s.bpm }));
  }
  /** Tempo of the last point (the tempo things end up at). */
  get bpm() {
    return this.segs[this.segs.length - 1].bpm;
  }
  /** Clamp a tempo into this map's range. */
  clamp(bpm) {
    return clampBpm(bpm, this.minBpm, this.maxBpm, this.segs?.[this.segs.length - 1]?.bpm ?? 120);
  }
  /**
   * Replace the whole map: anchor plus points. Points before the anchor beat are dropped;
   * if none sits exactly at the anchor, the tempo in force there is used.
   */
  reset(anchor, points) {
    const sorted = points.filter((p) => Number.isFinite(p.beat) && Number.isFinite(p.bpm)).slice().sort((a, b) => a.beat - b.beat);
    let first = sorted.length ? sorted[0].bpm : this.bpm;
    for (const p of sorted) if (p.beat <= anchor.beat + EPS) first = p.bpm;
    const segs = [{ beat: anchor.beat, time: anchor.time, bpm: this.clamp(first) }];
    for (const p of sorted) {
      if (p.beat <= anchor.beat + EPS) continue;
      const bpm = this.clamp(p.bpm);
      if (bpm === segs[segs.length - 1].bpm) continue;
      segs.push({ beat: p.beat, time: 0, bpm });
    }
    this.segs = segs;
    this.recompute(1);
  }
  /** Move the anchor to `anchor`, keeping one tempo (the current last tempo unless `bpm` is given). */
  restart(anchor, bpm = this.bpm) {
    this.segs = [{ beat: anchor.beat, time: anchor.time, bpm: this.clamp(bpm) }];
  }
  /**
   * Change tempo at `beat`. Points at or after `beat` are replaced. A beat at or before
   * the anchor re-tempos from the anchor (the anchor's time stays put).
   */
  setTempoAt(bpm, beat) {
    bpm = this.clamp(bpm);
    if (!Number.isFinite(beat) || beat <= this.segs[0].beat + EPS) {
      this.segs = [{ ...this.segs[0], bpm }];
      return;
    }
    while (this.segs.length > 1 && this.segs[this.segs.length - 1].beat >= beat - EPS) this.segs.pop();
    if (this.segs[this.segs.length - 1].bpm === bpm) return;
    this.segs.push({ beat, time: 0, bpm });
    this.recompute(this.segs.length - 1);
    if (this.segs.length > this.maxPoints) this.prune(this.segs[this.segs.length - this.maxPoints].beat);
  }
  /**
   * Ramp from the tempo at `startBeat` to `toBpm` over `beats`, as small constant steps
   * of `stepBeats` (default 1/4 beat). Peers without ramp support see ordinary points.
   */
  rampTempo(toBpm, startBeat, beats, stepBeats = 0.25) {
    const from = this.bpmAt(startBeat);
    if (!(beats > 0) || !(stepBeats > 0)) {
      this.setTempoAt(toBpm, startBeat);
      return;
    }
    const steps = Math.max(1, Math.round(beats / stepBeats));
    this.setTempoAt(from, startBeat);
    for (let i = 1; i <= steps; i++) this.setTempoAt(from + (toBpm - from) * i / steps, startBeat + beats * (i - 1) / steps);
  }
  /** Fold points that start at or before `beat` into the anchor (bounded memory; answers unchanged). */
  prune(beat) {
    let k = 0;
    for (let i = 1; i < this.segs.length; i++) if (this.segs[i].beat <= beat) k = i;
    if (k > 0) this.segs = this.segs.slice(k);
  }
  /** Tempo in force at `beat`. */
  bpmAt(beat) {
    return this.segAtBeat(beat).bpm;
  }
  /** Time (seconds) of `beat`. Beats before the anchor use the first tempo. */
  timeAt(beat) {
    const s = this.segAtBeat(beat);
    return s.time + (beat - s.beat) * 60 / s.bpm;
  }
  /** Beat at `time` (seconds). Times before the anchor use the first tempo. */
  beatAt(time) {
    const s = this.segAtTime(time);
    return s.beat + (time - s.time) * s.bpm / 60;
  }
  /** A deep copy. */
  clone() {
    const m = new _TempoMap({ minBpm: this.minBpm, maxBpm: this.maxBpm, maxPoints: this.maxPoints });
    m.segs = this.segs.map((s) => ({ ...s }));
    return m;
  }
  /** Shift every time by `seconds` (move the map to another timeline). Beats are unchanged. */
  shift(seconds) {
    this.segs[0].time += seconds;
    this.recompute(1);
  }
  recompute(from) {
    for (let i = Math.max(1, from); i < this.segs.length; i++) {
      const p = this.segs[i - 1];
      this.segs[i].time = p.time + (this.segs[i].beat - p.beat) * 60 / p.bpm;
    }
  }
  segAtBeat(beat) {
    const segs = this.segs;
    for (let i = segs.length - 1; i > 0; i--) if (segs[i].beat <= beat + EPS) return segs[i];
    return segs[0];
  }
  segAtTime(time) {
    const segs = this.segs;
    for (let i = segs.length - 1; i > 0; i--) if (segs[i].time <= time + EPS) return segs[i];
    return segs[0];
  }
};

// src/core/transport.ts
var DEFAULT_METER = Object.freeze({ beatsPerBar: 4, beatUnit: 4 });
var EPS2 = 1e-9;
function floorBeat(beat) {
  return Math.floor(beat + EPS2);
}
function nextGridBeat(beat, grid, strict = false) {
  if (!(grid > 0)) return beat;
  const k = Math.ceil(beat / grid - EPS2);
  const b = k * grid;
  return strict && b <= beat + EPS2 ? b + grid : b;
}
var Transport = class {
  /** Create a stopped transport. */
  constructor(options = {}) {
    /** The tempo map (beat ↔ time). */
    __publicField(this, "tempo");
    /** Meter used for bars. */
    __publicField(this, "meter");
    /** Time the current run starts, or null while stopped. */
    __publicField(this, "startTime", null);
    /** Time the current run stops, or null when no stop is scheduled. */
    __publicField(this, "stopTime", null);
    /** Beat held while stopped. */
    __publicField(this, "stoppedBeat", 0);
    this.tempo = new TempoMap({ bpm: options.bpm, minBpm: options.minBpm, maxBpm: options.maxBpm });
    this.meter = { ...options.meter ?? DEFAULT_METER };
  }
  /** Current (last) tempo. */
  get bpm() {
    return this.tempo.bpm;
  }
  /** True when a run has started and no stop is scheduled. Use {@link isPlayingAt} for a time. */
  get running() {
    return this.startTime !== null && this.stopTime === null;
  }
  /** Is the transport playing at `time`? */
  isPlayingAt(time) {
    return this.startTime !== null && time >= this.startTime - EPS2 && (this.stopTime === null || time < this.stopTime - EPS2);
  }
  /** Start at `at` from `beat` (default 0). Replaces any earlier run and tempo history. */
  start(options) {
    const beat = options.beat ?? 0;
    this.tempo.restart({ beat, time: options.at }, options.bpm ?? this.tempo.bpm);
    this.startTime = options.at;
    this.stopTime = null;
    this.stoppedBeat = beat;
  }
  /** Stop at `at`. The beat there is kept as {@link stoppedBeat}. */
  stop(options) {
    if (this.startTime === null) return;
    const at = Math.max(options.at, this.startTime);
    this.stoppedBeat = this.tempo.beatAt(at);
    this.stopTime = at;
  }
  /** Forget any run (stopped at `beat`, default 0). */
  reset(beat = 0) {
    this.startTime = null;
    this.stopTime = null;
    this.stoppedBeat = beat;
  }
  /**
   * Change tempo from `atBeat` on. While stopped (or with no beat) the whole map takes the
   * new tempo. Returns the beat the change lands on.
   */
  setTempo(bpm, atBeat) {
    if (!this.running || atBeat === void 0) {
      const anchor = this.tempo.anchor;
      this.tempo.setTempoAt(bpm, anchor.beat);
      return anchor.beat;
    }
    this.tempo.setTempoAt(bpm, atBeat);
    return atBeat;
  }
  /** Beat at `time`. Frozen at {@link stoppedBeat} before a start and after a stop. */
  beatAt(time) {
    if (this.startTime === null) return this.stoppedBeat;
    if (this.stopTime !== null && time >= this.stopTime - EPS2) return this.stoppedBeat;
    return this.tempo.beatAt(time);
  }
  /** Time of `beat` on the current run's tempo map (also valid for future or past beats). */
  timeAt(beat) {
    return this.tempo.timeAt(beat);
  }
  /** Bar position of `beat` using {@link meter}. */
  position(beat) {
    const n = Math.max(1, this.meter.beatsPerBar);
    const bar = floorBeat(beat / n);
    const beatInBar = Math.max(0, beat - bar * n);
    return { beat, bar, beatInBar, barPhase: beatInBar / n };
  }
  /** First bar line at or after `beat` (`strict`: after). */
  nextBar(beat, strict = false) {
    return nextGridBeat(beat, Math.max(1, this.meter.beatsPerBar), strict);
  }
  /** Anchor of the tempo map. */
  get anchor() {
    return this.tempo.anchor;
  }
  /** Tempo points. */
  get tempoPoints() {
    return this.tempo.points;
  }
};

// src/core/snapshot.ts
var SNAPSHOT_FORMAT = "nc-clock/snapshot";
var SNAPSHOT_VERSION = 1;
function toSnapshot(transport, timebase = "local") {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    timebase,
    anchor: transport.tempo.anchor,
    tempo: transport.tempo.points,
    meter: { ...transport.meter },
    playing: transport.running,
    startTime: transport.startTime,
    stopTime: transport.stopTime,
    stoppedBeat: transport.stoppedBeat
  };
}
function applySnapshot(transport, snapshot) {
  const s = validateSnapshot(snapshot);
  transport.tempo.reset(s.anchor, s.tempo);
  transport.meter = { ...s.meter };
  transport.startTime = s.startTime;
  transport.stopTime = s.stopTime;
  transport.stoppedBeat = s.stoppedBeat;
}
function fromSnapshot(snapshot, options = {}) {
  const t = new Transport(options);
  applySnapshot(t, snapshot);
  return t;
}
function shiftSnapshot(snapshot, offsetSeconds, timebase = snapshot.timebase) {
  const add = (t) => t === null ? null : t + offsetSeconds;
  return {
    ...snapshot,
    timebase,
    anchor: { beat: snapshot.anchor.beat, time: snapshot.anchor.time + offsetSeconds },
    tempo: snapshot.tempo.map((p) => ({ ...p })),
    meter: { ...snapshot.meter },
    startTime: add(snapshot.startTime),
    stopTime: add(snapshot.stopTime)
  };
}
var num = (v) => typeof v === "number" && Number.isFinite(v);
var numOrNull = (v) => v === null || num(v);
function validateSnapshot(value) {
  const s = value;
  const fail = (why) => {
    throw new TypeError(`Invalid nc-clock snapshot: ${why}`);
  };
  if (!s || typeof s !== "object") fail("not an object");
  if (s.format !== SNAPSHOT_FORMAT) fail("format");
  if (!num(s.version) || Math.floor(s.version) !== SNAPSHOT_VERSION) fail(`unsupported version ${String(s.version)}`);
  if (!s.anchor || !num(s.anchor.beat) || !num(s.anchor.time)) fail("anchor");
  if (!Array.isArray(s.tempo) || !s.tempo.length || !s.tempo.every((p) => p && num(p.beat) && num(p.bpm) && p.bpm > 0)) fail("tempo");
  if (!s.meter || !num(s.meter.beatsPerBar) || s.meter.beatsPerBar < 1 || !num(s.meter.beatUnit)) fail("meter");
  if (!numOrNull(s.startTime) || !numOrNull(s.stopTime) || !num(s.stoppedBeat)) fail("transport times");
  return s;
}

// src/core/clock.ts
var NcClock = class {
  /** Create a stopped clock. */
  constructor(options = {}) {
    /** The transport (read beats and times from here). */
    __publicField(this, "transport");
    /** Snapshot timebase label. */
    __publicField(this, "timebase");
    __publicField(this, "authority", null);
    __publicField(this, "listeners", /* @__PURE__ */ new Set());
    this.transport = new Transport(options);
    this.timebase = options.timebase ?? "local";
  }
  /** True when an authority owns time (local calls are requests). */
  get external() {
    return this.authority !== null;
  }
  /** Hand time to `authority` (null: back to standalone). */
  setAuthority(authority) {
    this.authority = authority;
  }
  /** Listen to committed changes. Returns an unsubscribe function. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * Start. Standalone: starts at `request.at` (required) from `request.beat` (default 0) and
   * returns true. External: forwards to the authority and returns false (nothing changed yet).
   */
  play(request) {
    if (this.authority) {
      this.authority.requestStart(request);
      return false;
    }
    this.commitStart(request.at, request.beat ?? 0, request.bpm);
    return true;
  }
  /** Stop. Standalone: stops at `request.at` and returns true. External: forwards, returns false. */
  stop(request) {
    if (this.authority) {
      this.authority.requestStop(request);
      return false;
    }
    this.commitStop(request.at, request.all ?? false);
    return true;
  }
  /**
   * Change tempo. Standalone: lands on `atBeat` (or the whole map while stopped) and returns
   * true. External: forwards, returns false.
   */
  setTempo(request) {
    if (this.authority) {
      this.authority.requestTempo(request);
      return false;
    }
    this.commitTempo(request.bpm, request.atBeat);
    return true;
  }
  /** Set the meter (local only; in sync the leader's meter arrives in snapshots). */
  setMeter(meter) {
    this.transport.meter = { ...meter };
  }
  /** Commit a start (authorities call this; standalone `play` does too). */
  commitStart(at, beat = 0, bpm) {
    this.transport.start({ at, beat, bpm });
    this.emit({ kind: "start", at, beat });
  }
  /** Commit a stop. */
  commitStop(at, all = false) {
    this.transport.stop({ at });
    this.emit({ kind: "stop", at, all });
  }
  /** Commit a tempo change. */
  commitTempo(bpm, atBeat) {
    const beat = this.transport.setTempo(bpm, atBeat);
    this.emit({ kind: "tempo", atBeat: beat, bpm: this.transport.tempo.bpmAt(beat) });
  }
  /** Replace the whole state with an authoritative snapshot (e.g. from the NC Sync leader). */
  applySnapshot(snapshot) {
    applySnapshot(this.transport, snapshot);
    this.emit({ kind: "snapshot", snapshot });
  }
  /** The current state as JSON-safe data. */
  toSnapshot() {
    return toSnapshot(this.transport, this.timebase);
  }
  emit(change) {
    for (const l of [...this.listeners]) l(change);
  }
};

// src/core/index.ts
var NC_CLOCK_VERSION = "0.3.0";

// src/protocol.ts
var PROTOCOL = "nc-sync/1";
var PROTOCOL_MAJOR = 1;
var DEFAULT_CHANNEL = "nc-sync";
var LEADER_LOCK = "nc-sync-leader";
var MESSAGE_TYPES = ["hello", "bye", "heartbeat", "state", "transport", "tempo", "snapshot", "ping", "pong", "notes"];
var SWING_UNSET = 0;
var SWING_STRAIGHT = 0.5;
var SWING_MAX = 0.75;
function readSwing(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= SWING_STRAIGHT && value <= SWING_MAX ? value : null;
}
var DEFAULT_CAPABILITIES = Object.freeze({
  tempoRange: [20, 300],
  tempoRamps: false,
  swing: false,
  meter: false,
  prefersLeader: false,
  canLead: true,
  sampleAccurate: false
});
var num2 = (v) => typeof v === "number" && Number.isFinite(v);
var str = (v) => typeof v === "string" && v.length > 0;
function parseMessage(value) {
  const m = value;
  if (!m || typeof m !== "object") return null;
  if (typeof m.proto !== "string" || !m.proto.startsWith("nc-sync/")) return null;
  if (parseInt(m.proto.slice(8), 10) !== PROTOCOL_MAJOR) return null;
  if (!str(m.type) || !str(m.from) || !num2(m.term) || !num2(m.seq) || !num2(m.sentAt)) return null;
  switch (m.type) {
    case "hello":
      return str(m.app) && typeof m.capabilities === "object" && m.capabilities ? m : null;
    case "bye":
      return m;
    case "heartbeat":
      return m;
    case "state":
      return m.clock && typeof m.clock === "object" ? m : null;
    case "transport":
      return m.action === "start" || m.action === "stop" ? m : null;
    case "tempo":
      return num2(m.bpm) && m.bpm > 0 ? m : null;
    case "snapshot":
      return (m.op === "recall" || m.op === "stopSequence" || m.op === "store") && num2(m.slot) ? m : null;
    case "ping":
    case "pong":
      return str(m.id) ? m : null;
    case "notes":
      return Array.isArray(m.notes) ? m : null;
    default:
      return null;
  }
}
function envelope(body, from, term, seq, sentAt) {
  return { proto: PROTOCOL, from, term, seq, sentAt, ...body };
}

// src/audio-mapper.ts
function retimeForStep(when, step, renderedUntil) {
  return when > renderedUntil ? when + step.stepSeconds : when;
}
function sharedNow() {
  return (performance.timeOrigin + performance.now()) / 1e3;
}
function median(values) {
  const s = values.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
var MIN_STAMP = 3e-3;
var READY_SAMPLES = 3;
var STAMP_WAIT_MS = 500;
var AudioClockMapper = class {
  /** Wrap a context. Call {@link start} to sample in the background, or {@link sample} yourself. */
  constructor(ctx, options = {}) {
    __publicField(this, "ctx");
    __publicField(this, "keep");
    __publicField(this, "intervalMs");
    __publicField(this, "latencyIntervalMs");
    __publicField(this, "timeOrigin");
    __publicField(this, "perfNow");
    __publicField(this, "offsets", []);
    __publicField(this, "timer", null);
    __publicField(this, "lastLatencyRead", -Infinity);
    __publicField(this, "latency", null);
    __publicField(this, "onSink", () => {
      this.offsets = [];
      this.clearPending();
      this.waitSince = null;
      this.readLatency(true);
      this.sample();
    });
    // When the timestamp had nothing real yet (zeros, or a placeholder below MIN_STAMP), since when (perfNow ms).
    __publicField(this, "waitSince", null);
    __publicField(this, "readyStamp");
    __publicField(this, "stepThreshold");
    __publicField(this, "stepConfirmations");
    __publicField(this, "stepCheckMs");
    __publicField(this, "stepTimer", null);
    __publicField(this, "pendingStep", null);
    __publicField(this, "pendingCount", 0);
    __publicField(this, "stepConfirmMs");
    __publicField(this, "confirmTimer", null);
    // contextTime of the last reading counted towards the pending step (the same stamp twice is one reading).
    __publicField(this, "pendingStamp", 0);
    __publicField(this, "stepCount", 0);
    __publicField(this, "stepListeners", /* @__PURE__ */ new Set());
    /** Manual offset in ms (the ±250 ms per-tab slider). */
    __publicField(this, "userOffsetMs");
    this.ctx = ctx;
    this.keep = Math.max(1, options.samples ?? 9);
    this.intervalMs = options.intervalMs ?? 250;
    this.latencyIntervalMs = options.latencyIntervalMs ?? 5e3;
    this.userOffsetMs = options.userOffsetMs ?? 0;
    this.timeOrigin = options.timeOrigin ?? performance.timeOrigin;
    this.perfNow = options.perfNow ?? (() => performance.now());
    this.stepThreshold = Math.max(0, options.stepThresholdMs ?? 2) / 1e3;
    this.stepConfirmations = Math.max(1, options.stepConfirmations ?? 3);
    this.stepCheckMs = options.stepCheckMs ?? 50;
    this.stepConfirmMs = Math.max(0, options.stepConfirmMs ?? 10);
  }
  /** Device clock steps re-anchored so far. */
  get reanchors() {
    return this.stepCount;
  }
  /** Hear confirmed device clock steps (repost your snapshot, re-time queued events). Returns an unsubscribe. */
  onStep(listener) {
    this.stepListeners.add(listener);
    return () => {
      this.stepListeners.delete(listener);
    };
  }
  /**
   * One step check. A device clock step (a dropped or repeated output buffer moves contextTime against
   * wall time by a whole buffer, ~10 ms) would otherwise take the 9-sample median ~1–2 s to follow.
   * Only real output timestamps count: `contextTime` and `performanceTime` must both be > 0, so a
   * glitch reading (performanceTime 0, position frozen) never confirms a step. Returns true on a re-anchor.
   * Approach and constants from OLIVE Bass `clock-link` (Olive, ASTRID-Bass PR #1).
   */
  checkStep() {
    if (this.stepThreshold === 0 || this.ctx.state !== "running" || !this.offsets.length) return false;
    const ts = typeof this.ctx.getOutputTimestamp === "function" ? this.ctx.getOutputTimestamp() : null;
    const c = ts?.contextTime ?? 0, p = ts?.performanceTime ?? 0;
    if (!(c >= MIN_STAMP && p > 0) || !Number.isFinite(c) || !Number.isFinite(p)) return false;
    const raw = c - (this.timeOrigin + p) / 1e3;
    const step = raw - median(this.offsets);
    if (Math.abs(step) <= this.stepThreshold) {
      this.clearPending();
      return false;
    }
    if (this.pendingStep !== null && Math.abs(step - this.pendingStep) < this.stepThreshold / 2) {
      if (c === this.pendingStamp) {
        this.followUp();
        return false;
      }
      this.pendingStamp = c;
      if (++this.pendingCount < this.stepConfirmations) {
        this.followUp();
        return false;
      }
      this.offsets = [raw];
      this.clearPending();
      this.stepCount++;
      const event = { stepSeconds: step, confirmedAt: this.ctx.currentTime, reanchors: this.stepCount };
      for (const l of [...this.stepListeners]) l(event);
      return true;
    }
    this.pendingStep = step;
    this.pendingCount = 1;
    this.pendingStamp = c;
    if (this.stepConfirmations === 1) return this.checkStep();
    this.followUp();
    return false;
  }
  /** While started, take the next confirming reading after stepConfirmMs instead of the next periodic check. */
  followUp() {
    if (!this.stepTimer || this.stepConfirmMs === 0 || this.confirmTimer) return;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      this.checkStep();
    }, this.stepConfirmMs);
  }
  clearPending() {
    this.pendingStep = null;
    this.pendingCount = 0;
    this.pendingStamp = 0;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
  }
  /** Shared time now (seconds). */
  sharedNow() {
    return (this.timeOrigin + this.perfNow()) / 1e3;
  }
  /** Take one sample. Returns false when the context can't give a trustworthy one yet. */
  sample() {
    const ctx = this.ctx;
    if (ctx.state !== "running") return false;
    this.readLatency(false);
    let offset = null;
    const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
    if (ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime) && ts.contextTime >= MIN_STAMP && ts.performanceTime > 0) {
      offset = ts.contextTime - (this.timeOrigin + ts.performanceTime) / 1e3;
      this.waitSince = null;
    } else if (!ts || !(ts.contextTime >= MIN_STAMP) && !(ts.contextTime > 0 && !(ts.performanceTime > 0))) {
      if (ts) {
        const now = this.perfNow();
        if (this.waitSince === null) this.waitSince = now;
        if (now - this.waitSince < STAMP_WAIT_MS) return false;
      }
      if (ctx.currentTime > 0) offset = ctx.currentTime - (this.latency ?? 0) - this.sharedNow();
    }
    if (offset === null || !Number.isFinite(offset)) return false;
    this.offsets.push(offset);
    if (this.offsets.length > this.keep) this.offsets.shift();
    return true;
  }
  /**
   * True once READY_SAMPLES (3) good samples exist. Pure: reading it never samples (use {@link sampleIfNotReady}
   * to move it along). Until then {@link offset} is only a guess (`currentTime − now`, off by the output
   * latency): wait for `ready` before scheduling against it.
   */
  get ready() {
    return this.offsets.length >= Math.min(READY_SAMPLES, this.keep);
  }
  /**
   * While not {@link ready}: take one sample if the output timestamp is new since the last call (the same stamp
   * twice adds nothing to the median). Returns `ready`. Call it from a short retry loop before the first
   * scheduling; the background timer (every `intervalMs`) gets there too, only slower.
   */
  sampleIfNotReady() {
    if (this.ready) return true;
    const ts = typeof this.ctx.getOutputTimestamp === "function" ? this.ctx.getOutputTimestamp() : null;
    const real = !!ts && ts.contextTime >= MIN_STAMP && ts.performanceTime > 0;
    if (!real || ts.contextTime !== this.readyStamp) {
      this.readyStamp = real ? ts.contextTime : void 0;
      this.sample();
    }
    return this.ready;
  }
  /** contextTime − sharedTime (seconds), median of recent samples, plus the user offset. */
  get offset() {
    if (!this.offsets.length) this.sample();
    const base = this.offsets.length ? median(this.offsets) : this.ctx.currentTime - this.sharedNow();
    return base + this.userOffsetMs / 1e3;
  }
  /** Shared time (s) → context time (s). */
  toContextTime(shared) {
    return shared + this.offset;
  }
  /** Context time (s) → shared time (s). */
  toSharedTime(contextTime) {
    return contextTime - this.offset;
  }
  /** Output latency in ms (outputLatency, else baseLatency), or null when the browser doesn't say. */
  get outputLatencyMs() {
    this.readLatency(false);
    return this.latency === null ? null : this.latency * 1e3;
  }
  /** Sample every `intervalMs` and listen for output-device changes. */
  start() {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (this.stepThreshold > 0) this.stepTimer = setInterval(() => this.checkStep(), this.stepCheckMs);
    this.ctx.addEventListener?.("sinkchange", this.onSink);
    this.ctx.addEventListener?.("statechange", this.onSink);
  }
  /** Stop background sampling. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stepTimer) clearInterval(this.stepTimer);
    this.stepTimer = null;
    this.clearPending();
    this.ctx.removeEventListener?.("sinkchange", this.onSink);
    this.ctx.removeEventListener?.("statechange", this.onSink);
  }
  readLatency(force) {
    const now = this.perfNow();
    if (!force && now - this.lastLatencyRead < this.latencyIntervalMs) return;
    this.lastLatencyRead = now;
    const out = this.ctx.outputLatency, base = this.ctx.baseLatency;
    this.latency = Number.isFinite(out) && out > 0 ? out : Number.isFinite(base) && base > 0 ? base : null;
  }
};

// src/ticker.ts
var WORKER_SOURCE = "let t=null;onmessage=e=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}";
function canUseWorker() {
  const g = globalThis;
  return typeof g.Worker === "function" && typeof g.Blob === "function" && typeof g.document === "object" && typeof g.URL?.createObjectURL === "function";
}
function createTicker(onTick, options = {}) {
  const intervalMs = options.intervalMs ?? 20;
  const now = options.now ?? (typeof performance !== "undefined" ? () => performance.now() : () => Date.now());
  let worker = null;
  let url = null;
  let timer = null;
  let last = -Infinity;
  let running = false;
  const fire = () => {
    if (!running) return;
    const t = now();
    if (t - last < intervalMs / 2) return;
    last = t;
    onTick();
  };
  if (options.worker === true || options.worker !== false && canUseWorker()) {
    try {
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = fire;
    } catch {
      worker = null;
      if (url) URL.revokeObjectURL(url);
      url = null;
    }
  }
  return {
    get running() {
      return running;
    },
    get kind() {
      return worker ? "worker+timer" : "timer";
    },
    start() {
      if (running) return;
      running = true;
      timer = setInterval(fire, intervalMs);
      worker?.postMessage(intervalMs);
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      worker?.postMessage(0);
    },
    dispose() {
      this.stop();
      worker?.terminate();
      worker = null;
      if (url) URL.revokeObjectURL(url);
      url = null;
    }
  };
}

// src/peer.ts
var NcSyncPeer = class {
  /** Create a peer (not joined until {@link start}). */
  constructor(options) {
    /** This instance's id. */
    __publicField(this, "id");
    /** Current leader term. */
    __publicField(this, "term", 0);
    /** Other live peers by id. */
    __publicField(this, "peers", /* @__PURE__ */ new Map());
    __publicField(this, "o");
    __publicField(this, "caps");
    __publicField(this, "clock");
    __publicField(this, "channel", null);
    __publicField(this, "channelOption");
    __publicField(this, "locks");
    __publicField(this, "seq", 0);
    __publicField(this, "lastSeq", /* @__PURE__ */ new Map());
    __publicField(this, "leader", false);
    __publicField(this, "joinedAt", 0);
    __publicField(this, "heartbeat", null);
    __publicField(this, "grace", null);
    __publicField(this, "releaseLock", null);
    __publicField(this, "lockAbort", null);
    __publicField(this, "yielding", false);
    __publicField(this, "stopAll", false);
    __publicField(this, "roleListeners", /* @__PURE__ */ new Set());
    __publicField(this, "peerListeners", /* @__PURE__ */ new Set());
    __publicField(this, "snapshotListeners", /* @__PURE__ */ new Set());
    __publicField(this, "messageListeners", /* @__PURE__ */ new Set());
    __publicField(this, "swingListeners", /* @__PURE__ */ new Set());
    __publicField(this, "appliedSwing", null);
    const g = globalThis;
    this.clock = options.clock;
    this.caps = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.channelOption = options.channel ?? DEFAULT_CHANNEL;
    this.locks = options.locks === void 0 ? g.navigator?.locks ?? null : options.locks;
    this.id = options.instanceId ?? g.crypto?.randomUUID?.() ?? `p-${Math.random().toString(36).slice(2)}`;
    this.o = {
      app: options.app,
      version: options.version,
      clock: options.clock,
      now: options.now ?? (() => (g.performance.timeOrigin + g.performance.now()) / 1e3),
      audio: options.audio ?? (() => "none"),
      hidden: options.hidden ?? (() => g.document?.visibilityState === "hidden"),
      outputLatencyMs: options.outputLatencyMs ?? (() => null),
      swing: options.swing ?? (() => null),
      heartbeatMs: options.heartbeatMs ?? 1e3,
      peerTimeoutMs: options.peerTimeoutMs ?? 3e3,
      hiddenPeerTimeoutMs: options.hiddenPeerTimeoutMs ?? 65e3,
      startLeadSeconds: options.startLeadSeconds ?? 0.2,
      minLeadSeconds: options.minLeadSeconds ?? 0.1,
      joinGraceMs: options.joinGraceMs ?? 300
    };
  }
  /** True while this peer leads. */
  get isLeader() {
    return this.leader;
  }
  /** This peer's capabilities. */
  get capabilities() {
    return { ...this.caps };
  }
  /** Join: open the channel, take the clock's authority, say hello, and enter election. */
  async start() {
    if (this.channel) return;
    this.channel = typeof this.channelOption === "string" ? new BroadcastChannel(this.channelOption) : this.channelOption;
    this.channel.onmessage = (e) => this.receive(e.data);
    this.joinedAt = this.o.now();
    this.clock.setAuthority(this);
    this.send({ type: "hello", app: this.o.app, version: this.o.version, capabilities: this.caps, audio: this.o.audio(), outputLatencyMs: this.o.outputLatencyMs(), joinedAt: this.joinedAt });
    this.heartbeat = setInterval(() => this.beat(), this.o.heartbeatMs);
    if (this.locks) this.elect();
    else this.grace = setTimeout(() => {
      this.grace = null;
      this.elect();
    }, this.o.joinGraceMs);
  }
  /** Leave: say bye, release the lock, give the clock back (standalone). */
  stop() {
    if (!this.channel) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.grace) clearTimeout(this.grace);
    this.grace = null;
    this.yielding = true;
    this.lockAbort?.abort();
    this.lockAbort = null;
    this.releaseLock?.();
    this.releaseLock = null;
    this.setLeader(false);
    this.send({ type: "bye" });
    this.channel.onmessage = null;
    if (typeof this.channelOption === "string") this.channel.close();
    this.channel = null;
    this.clock.setAuthority(null);
    this.peers.clear();
  }
  /** Hear role changes. Returns an unsubscribe function. */
  onRole(listener) {
    this.roleListeners.add(listener);
    return () => this.roleListeners.delete(listener);
  }
  /** Hear peer list changes. */
  onPeers(listener) {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }
  /** Hear snapshot slot actions from other peers. */
  onSnapshot(listener) {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
  /** Hear every valid message from other peers (after dedupe). */
  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  /**
   * Hear the session swing change (0.5 to 0.75): from the leader's `state`, or this peer's own while it leads.
   * Fires only when the value changes, and never for "unset", so it is safe to feed it straight into your swing
   * control. Returns an unsubscribe function.
   */
  onSwing(listener) {
    this.swingListeners.add(listener);
    return () => this.swingListeners.delete(listener);
  }
  /** The session swing (0.5 to 0.75) from the latest `state` that set one, or null if no leader has set swing yet. */
  get swing() {
    return this.appliedSwing;
  }
  /**
   * Leader only: send `state` again now, e.g. after a swing edit when the transport did not change. Returns true
   * if it was sent, false on a follower (a follower's swing is local until the leader's next `state`).
   */
  publishState() {
    if (!this.leader || !this.channel) return false;
    this.broadcastState();
    return true;
  }
  /** Send a snapshot slot action (`recall` is idempotent; receivers never echo it). */
  sendSnapshot(op, slot, extra = {}) {
    this.send({ type: "snapshot", op, slot, ...extra });
  }
  /** ClockAuthority: local Play. */
  requestStart(request) {
    if (!this.leader && !this.knownLeader()) this.becomeLeaderIfAlone();
    if (this.leader) {
      this.decideStart();
      return;
    }
    this.send({ type: "transport", action: "start", ...request.beat !== void 0 ? { atBeat: request.beat } : {} });
  }
  /** ClockAuthority: local Stop. */
  requestStop(request) {
    if (!this.leader && !this.knownLeader()) this.becomeLeaderIfAlone();
    if (this.leader) {
      this.decideStop(request.all ?? false);
      return;
    }
    this.send({ type: "transport", action: "stop", all: request.all ?? false });
  }
  /** ClockAuthority: local tempo change. */
  requestTempo(request) {
    if (!this.leader && !this.knownLeader()) this.becomeLeaderIfAlone();
    if (this.leader) {
      this.decideTempo(request.bpm, request.atBeat, request.rampBeats);
      return;
    }
    this.send({ type: "tempo", bpm: request.bpm, ...request.atBeat !== void 0 ? { atBeat: request.atBeat } : {}, ...request.rampBeats ? { rampBeats: request.rampBeats } : {} });
  }
  // ---- leader decisions -------------------------------------------------------------
  decideStart() {
    const t = this.clock.transport, now = this.o.now();
    if (t.isPlayingAt(now) && t.stopTime === null) {
      const bar = t.nextBar(t.beatAt(now + this.o.minLeadSeconds));
      this.clock.commitStart(t.timeAt(bar), 0);
    } else {
      this.clock.commitStart(now + this.o.startLeadSeconds, 0);
    }
    this.broadcastState();
  }
  decideStop(all) {
    this.stopAll = all;
    this.clock.commitStop(this.o.now() + this.o.minLeadSeconds, all);
    this.broadcastState();
    this.stopAll = false;
  }
  decideTempo(bpm, atBeat, rampBeats) {
    const [lo, hi] = this.tempoRange();
    bpm = Math.min(hi, Math.max(lo, bpm));
    const t = this.clock.transport, now = this.o.now();
    if (!t.running) {
      this.clock.commitTempo(bpm);
      this.broadcastState();
      return;
    }
    const earliest = t.beatAt(now + this.o.minLeadSeconds);
    const beat = Math.max(atBeat ?? nextGridBeat(earliest, 1), earliest);
    if (rampBeats && rampBeats > 0) {
      t.tempo.rampTempo(bpm, beat, rampBeats);
      this.clock.applySnapshot(this.clock.toSnapshot());
    } else this.clock.commitTempo(bpm, beat);
    this.broadcastState();
  }
  /** Intersection of every live peer's tempo range with ours. */
  tempoRange() {
    let [lo, hi] = this.caps.tempoRange;
    for (const p of this.peers.values()) {
      lo = Math.max(lo, p.capabilities.tempoRange[0]);
      hi = Math.min(hi, p.capabilities.tempoRange[1]);
    }
    return lo <= hi ? [lo, hi] : this.caps.tempoRange;
  }
  broadcastState() {
    if (!this.leader) return;
    const own = this.o.swing();
    const swing = typeof own === "number" && Number.isFinite(own) ? Math.min(SWING_MAX, Math.max(SWING_STRAIGHT, own)) : SWING_UNSET;
    this.send({ type: "state", clock: this.clock.toSnapshot(), swing, leaderApp: this.o.app, ...this.stopAll ? { stopAll: true } : {} });
    this.noteSwing(swing);
  }
  noteSwing(value) {
    const swing = readSwing(value);
    if (swing === null || swing === this.appliedSwing) return;
    this.appliedSwing = swing;
    for (const l of [...this.swingListeners]) l(swing);
  }
  // ---- receiving --------------------------------------------------------------------
  receive(data) {
    const m = parseMessage(data);
    if (!m || m.from === this.id) return;
    const last = this.lastSeq.get(m.from);
    if (last !== void 0 && m.seq <= last) return;
    this.lastSeq.set(m.from, m.seq);
    if (m.term > this.term && m.type !== "state") this.term = Math.max(this.term, m.term);
    switch (m.type) {
      case "hello":
      case "heartbeat": {
        const known = this.peers.has(m.from);
        this.peers.set(m.from, {
          id: m.from,
          app: m.app,
          capabilities: { ...DEFAULT_CAPABILITIES, ...m.capabilities },
          audio: m.audio,
          hidden: m.type === "heartbeat" ? m.hidden : false,
          leader: m.type === "heartbeat" ? m.leader : false,
          joinedAt: m.joinedAt,
          lastSeen: this.o.now(),
          outputLatencyMs: m.outputLatencyMs
        });
        if (!known) this.emitPeers();
        if (m.type === "hello") {
          if (this.leader) this.broadcastState();
          this.sendHeartbeat();
        }
        this.elect();
        break;
      }
      case "bye":
        this.peers.delete(m.from);
        this.lastSeq.delete(m.from);
        this.emitPeers();
        this.elect();
        break;
      case "state": {
        if (m.term < this.term) return;
        if (this.leader) {
          if (m.term === this.term && this.outranks(m.from)) {
            this.broadcastState();
            return;
          }
          this.setLeader(false);
        }
        this.term = m.term;
        for (const p of this.peers.values()) p.leader = p.id === m.from;
        const sender = this.peers.get(m.from);
        if (!sender) {
          this.peers.set(m.from, {
            id: m.from,
            app: m.leaderApp,
            capabilities: { ...DEFAULT_CAPABILITIES },
            audio: "none",
            hidden: false,
            leader: true,
            joinedAt: m.sentAt,
            lastSeen: this.o.now(),
            outputLatencyMs: null
          });
          this.emitPeers();
        } else sender.lastSeen = this.o.now();
        this.clock.applySnapshot(m.clock);
        this.noteSwing(m.swing);
        if (m.stopAll) this.clock.commitStop(m.clock.stopTime ?? this.o.now(), true);
        break;
      }
      case "transport":
        if (this.leader) {
          if (m.action === "start") this.decideStart();
          else this.decideStop(m.all ?? false);
        }
        break;
      case "tempo":
        if (this.leader) this.decideTempo(m.bpm, m.atBeat, m.rampBeats);
        break;
      case "snapshot":
        for (const l of [...this.snapshotListeners]) l(m);
        break;
      case "ping":
        this.send({ type: "pong", id: m.id, receivedAt: this.o.now() });
        break;
      default:
        break;
    }
    for (const l of [...this.messageListeners]) l(m);
  }
  // ---- election ---------------------------------------------------------------------
  /** A live peer that prefers leading while we don't: we should not lead. */
  outranked() {
    if (!this.caps.canLead) return true;
    for (const p of this.peers.values()) {
      if (!p.capabilities.canLead) continue;
      if (p.capabilities.prefersLeader && !this.caps.prefersLeader) return true;
    }
    return false;
  }
  elect() {
    if (!this.channel) return;
    const outranked = this.outranked();
    if (this.locks) {
      if (outranked) {
        this.yielding = true;
        this.lockAbort?.abort();
        this.lockAbort = null;
        if (this.releaseLock) {
          const r = this.releaseLock;
          this.releaseLock = null;
          r();
        }
        return;
      }
      this.yielding = false;
      if (this.releaseLock || this.lockAbort) return;
      const abort = new AbortController();
      this.lockAbort = abort;
      this.locks.request(LEADER_LOCK, { signal: abort.signal }, () => {
        this.lockAbort = null;
        if (!this.channel || this.yielding) return Promise.resolve();
        return new Promise((resolve) => {
          this.releaseLock = () => {
            this.setLeader(false);
            resolve();
          };
          this.setLeader(true);
        });
      }).catch(() => {
      }).finally(() => {
        if (this.lockAbort === abort) this.lockAbort = null;
        if (this.channel && !this.releaseLock && !this.lockAbort && !this.yielding) queueMicrotask(() => this.elect());
      });
      return;
    }
    if (this.grace) return;
    const rank = (prefers, joinedAt, id) => [prefers ? 0 : 1, joinedAt, id];
    let best = rank(this.caps.prefersLeader, this.joinedAt, this.id), bestId = this.caps.canLead ? this.id : null;
    for (const p of this.peers.values()) {
      if (!p.capabilities.canLead) continue;
      const r = rank(p.capabilities.prefersLeader, p.joinedAt, p.id);
      if (bestId === null || r[0] < best[0] || r[0] === best[0] && (r[1] < best[1] || r[1] === best[1] && r[2] < best[2])) {
        best = r;
        bestId = p.id;
      }
    }
    this.setLeader(bestId === this.id);
  }
  /** Do we rank above peer `id` for leading (prefersLeader, then oldest, then lowest id)? */
  outranks(id) {
    const p = this.peers.get(id);
    if (!p) return this.id < id;
    const a = [this.caps.prefersLeader ? 0 : 1, this.joinedAt], b = [p.capabilities.prefersLeader ? 0 : 1, p.joinedAt];
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] < b[1];
    return this.id < id;
  }
  knownLeader() {
    return [...this.peers.values()].some((p) => p.leader);
  }
  becomeLeaderIfAlone() {
    if (!this.peers.size && !this.locks && this.caps.canLead) this.setLeader(true);
  }
  setLeader(on) {
    if (on === this.leader) return;
    this.leader = on;
    if (on) {
      this.term += 1;
      this.broadcastState();
    }
    for (const l of [...this.roleListeners]) l(on ? "leader" : "follower");
    this.beat();
  }
  // ---- housekeeping -----------------------------------------------------------------
  beat() {
    if (!this.channel) return;
    const now = this.o.now();
    let changed = false;
    for (const p of [...this.peers.values()]) {
      const limit = (p.hidden ? this.o.hiddenPeerTimeoutMs : this.o.peerTimeoutMs) / 1e3;
      if (now - p.lastSeen > limit) {
        this.peers.delete(p.id);
        changed = true;
      }
    }
    if (changed) {
      this.emitPeers();
      this.elect();
    }
    this.sendHeartbeat();
  }
  sendHeartbeat() {
    this.send({
      type: "heartbeat",
      app: this.o.app,
      leader: this.leader,
      audio: this.o.audio(),
      hidden: this.o.hidden(),
      outputLatencyMs: this.o.outputLatencyMs(),
      joinedAt: this.joinedAt,
      capabilities: this.caps
    });
  }
  emitPeers() {
    const list = [...this.peers.values()];
    for (const l of [...this.peerListeners]) l(list);
  }
  send(body) {
    if (!this.channel) return;
    this.channel.postMessage(envelope(body, this.id, this.term, ++this.seq, this.o.now()));
  }
};
export {
  AudioClockMapper,
  DEFAULT_CAPABILITIES,
  DEFAULT_CHANNEL,
  DEFAULT_METER,
  LEADER_LOCK,
  MESSAGE_TYPES,
  NC_CLOCK_VERSION,
  NcClock,
  NcSyncPeer,
  PROTOCOL,
  PROTOCOL_MAJOR,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  SWING_MAX,
  SWING_STRAIGHT,
  SWING_UNSET,
  TempoMap,
  Transport,
  applySnapshot,
  clampBpm,
  createTicker,
  envelope,
  floorBeat,
  fromSnapshot,
  median,
  nextGridBeat,
  parseMessage,
  readSwing,
  retimeForStep,
  sharedNow,
  shiftSnapshot,
  toSnapshot,
  validateSnapshot
};
