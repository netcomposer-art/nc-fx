// nc-fx DSP engine: drive -> delay -> reverb (plate) -> pre-gain -> limiter, in a fixed order (createFxDsp).
// ASTRID's movable-slot chain is src/chain.js (createFxChainDsp); both run the effect units of src/units.js and
// share the limiter and event queue defined here.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// Pure ES2019; its only imports are src/mod.js and src/units.js (same rules), so it runs inside any
// AudioWorkletGlobalScope (dist/worklet.js inlines them) and in Node. The effects are ported from ASTRID
// (psemmelhack/NetComposer-Synth, lib/synth-audio/src/hacks-vendor/dsp.js, itself netcomposer.art create/hacks/dsp.js
// @ 3fb61f5): the same arithmetic in the same order, so ASTRID's chain and this one render the same samples
// (test/astrid-parity.test.mjs). What changed is where state lives: every buffer and every scalar is allocated once,
// in typed arrays. Nothing on the audio path allocates: not process(), not set(), not setTempo(), not a bypass,
// not a tempo change.

import { createModBus, modBlock, MOD_T_DRIVE_AMOUNT, MOD_T_DRIVE_TONE, MOD_T_DELAY_SEND } from './mod.js'; // @strip
import { createFxEnv, unitDrive, unitDelay, unitPlate, fxCoef, CLEAR_CHUNK, OP_NONE, OP_CLEAR, OP_FADE_BEGIN, OP_FADE_WORK, OP_FADE_DONE, OP_FADE_IDLE, OP_SLEEP, OP_BLOCK, OP_MOD_ON, OP_GRID_ON, OP_GRID, OP_SETTLE } from './units.js'; // @strip

/** Indexes of the engine's parameters (DSP units, see src/params.js for the dial laws). */
export var FX_PARAM = {
  DRIVE_ON: 0, DRIVE_DB: 1, DRIVE_OUT_DB: 2, DRIVE_MIX: 3,
  DELAY_ON: 4, DELAY_BEATS: 5, DELAY_FEEDBACK: 6, DELAY_MIX: 7,
  PLATE_ON: 8, PLATE_PREDELAY: 9, PLATE_SIZE: 10, PLATE_DECAY: 11, PLATE_DAMPING: 12, PLATE_MIX: 13,
  DRIVE_CURVE: 14, DRIVE_TONE: 15, DRIVE_MOD: 16, DRIVE_MOD_TONE: 17,
  DELAY_TONE: 18, DELAY_LOW_CUT: 19, DELAY_MODE: 20, DELAY_SEND: 21, DELAY_MOD_SEND: 22, DELAY_BEATS_FREE: 23
};
export var FX_NPARAMS = 24;
/** Event kinds besides a parameter index. */
export var EV_TEMPO = -1;
export var EV_CLEAR = -2;

var CEILING = 0.8912509381337456;
// 'soft' limiter: exactly linear up to the knee (-6 dBFS), then KNEE + KW * tanh((|x| - KNEE) / KW), which leaves
// the knee with slope 1 (C1) and approaches the ceiling (-1 dBFS).
var KNEE = 0.5011872336272722;
var KW = 0.8912509381337456 - 0.5011872336272722;
var QUEUE = 256;
var NO_EVENT = -99; // empty staging slot
export var HORIZON_S = 600; // events further ahead than this are refused
export var MOD_GRID = 128; // block-rate updates (drive tone, delay filters) land on absolute frames that are multiples of this, like Bass's mod[0]
// Fixed chain: which unit (0 drive, 1 delay, 2 plate) and which of its params each FX_PARAM index is.
var FIX_UNIT = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
var FIX_K = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 4, 5, 6, 7, 4, 5, 6, 7, 8, 9];

/**
 * The limiter stage (ncLimiter*: sample peak, stereo-linked, 1.5 ms lookahead, -1 dB ceiling, 50 ms release), after
 * the pre-gain. mode 0 off, 1 lookahead, 2 soft. step() multiplies E.IO by LM[4] (the pre-gain; the slot engine puts
 * its chain fade times the pre-gain there, in ASTRID's order) and limits it in place.
 */
export function createLimiter(E, mode) {
  var IO = E.IO;
  var la = Math.round(0.0015 * E.sr);
  if (la < 1) la = 1;
  var limL = new Float32Array(la), limR = new Float32Array(la), limG = new Float32Array(la);
  var LM = new Float64Array(5); // 0 w, 1 env, 2 lo, 3 rel, 4 the gain in front of it for this sample
  LM[3] = fxCoef(0.05, E.sr);
  LM[4] = 1;
  function reset() { limL.fill(0); limR.fill(0); limG.fill(1); LM[0] = 0; LM[1] = 1; LM[2] = 1; }
  reset();
  function step() {
    var g = LM[4];
    var xL = IO[0] * g, xR = IO[1] * g;
    if (mode === 0) { IO[0] = xL; IO[1] = xR; return; }
    if (mode === 2) {
      // Soft knee, zero latency, stateless: bit-transparent below the knee (no antialiasing filter there either).
      var sL = xL < 0 ? -xL : xL, sR = xR < 0 ? -xR : xR;
      if (sL > KNEE) { sL = KNEE + KW * Math.tanh((sL - KNEE) / KW); IO[0] = xL < 0 ? -sL : sL; } else IO[0] = xL;
      if (sR > KNEE) { sR = KNEE + KW * Math.tanh((sR - KNEE) / KW); IO[1] = xR < 0 ? -sR : sR; } else IO[1] = xR;
      return;
    }
    var aL = xL < 0 ? -xL : xL;
    var aR = xR < 0 ? -xR : xR;
    var pk = aR > aL ? aR : aL;
    var req = pk > CEILING ? CEILING / pk : 1;
    var w = LM[0];
    var dL = limL[w], dR = limR[w];
    var gMin = req;
    for (var k = 0; k < la; k++) if (limG[k] < gMin) gMin = limG[k];
    var env = LM[1];
    if (gMin < env) env = gMin;
    else env += (gMin - env) * LM[3];
    LM[1] = env;
    if (env < LM[2]) LM[2] = env;
    limG[w] = req;
    limL[w] = xL;
    limR[w] = xR;
    w++;
    LM[0] = w >= la ? 0 : w;
    IO[0] = dL * env;
    IO[1] = dR * env;
  }
  return { la: la, LM: LM, step: step, reset: reset };
}

/**
 * The event queue's storage: sample-accurate events sorted by frame (equal frames keep call order); slot QUEUE stages
 * the incoming event. Each engine keeps its own admit() and due() (with its event switch inside due(), which
 * process() calls every block): code that runs only on events would run unoptimised, and unoptimised code boxes
 * (allocates) every double it touches.
 */
export function createQueue(nIdx, start) {
  var Q = {
    EF: new Float64Array(QUEUE + 1), EI: new Int32Array(QUEUE + 1), EV: new Float64Array(QUEUE + 1),
    ES: new Uint8Array(QUEUE + 1), // 1 = snap (no smoothing) when it lands
    EN: new Int32Array(1),
    // The latest value per index (0..nIdx-1) and its frame, so load() can skip unchanged ones.
    LV: new Float64Array(nIdx > 0 ? nIdx : 1), LF: new Float64Array(nIdx > 0 ? nIdx : 1)
  };
  Q.EI[QUEUE] = NO_EVENT;
  if (start) Q.LV.set(start);
  return Q;
}
export var QUEUE_SIZE = QUEUE;
export var QUEUE_EMPTY = NO_EVENT;

/** clear({fadeMs}) per sample: the wet gain FC[1] ramps out (phase 1), holds at 0 (2), ramps back in (3). True on the sample it reaches 0. */
export function fadeStep(FC) {
  var ph = FC[0], g;
  if (ph === 1) { g = FC[1] - FC[2]; if (g <= 0) { g = 0; FC[0] = 2; } FC[1] = g; return FC[0] === 2; }
  if (ph === 3) { g = FC[1] + FC[2]; if (g >= 1) { g = 1; FC[0] = 0; } FC[1] = g; }
  return false;
}

/**
 * The fixed-chain engine. Allocates everything up front (about 1.9 MB of delay line and 0.3 MB of plate at 48 kHz).
 * @param {number} sampleRate
 * @param {{bypassMode?: 'hold'|'run', limiter?: 'lookahead'|'soft'|'off', preGain?: number}} [opts]
 */
export function createFxDsp(sampleRate, opts) {
  var o = opts || {};
  var E = createFxEnv(sampleRate, o);
  var sr = E.sr, IO = E.IO, T = E.T, FC = E.FC;
  // Transparent by default: limiter off and pre-gain 1, so an all-bypassed chain is bit-identical to its input.
  var limMode = o.limiter === 'lookahead' ? 1 : o.limiter === 'soft' ? 2 : 0;
  var preGain = typeof o.preGain === 'number' && o.preGain >= 0 && o.preGain < 16 ? o.preGain : 1;
  var horizon = Math.round(HORIZON_S * sr);
  T[1] = o.startFrame > 0 ? Math.round(o.startFrame) : 0; // a worklet passes currentFrame (for the horizon)
  var peak = new Float32Array(2);
  var MB = createModBus(); // mod bus (src/mod.js): routes and the per-block on flag
  // Each parameter's starting value; PRM = last applied (targets).
  var START = [0, 0, 0, 1, 0, 0.75, 0.35, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 100 / 99, 0, 0, 100 / 99, 0, 0, 1, 0, 0];
  var PRM = new Float64Array(START);
  var drive = unitDrive(E), delay = unitDelay(E), plate = unitPlate(E);
  var lim = createLimiter(E, limMode);
  lim.LM[4] = preGain;
  var ZCV = new Float32Array(MOD_GRID); // zero CV: no CV sounds exactly like a silent one (Zeta, PR B P2-a)
  function zeroCv(n) { if (ZCV.length < n) ZCV = new Float32Array(n); return ZCV; } // grows once per larger block size

  var Q = createQueue(FX_NPARAMS, START);
  var EI = Q.EI, EV = Q.EV, ES = Q.ES, EF = Q.EF, EN = Q.EN, LV = Q.LV, LF = Q.LF;
  // Applies queued event k, inside process()'s optimised code (the queue calls it): no double crosses a call.
  // Events: the API stages one event in slot QUEUE (EI/EV/EF/ES) and calls admit(), which process() also calls
  // every block, so admit() runs optimised and the cold API never reads a double (a cold read boxes it).
  // Sorted by frame; equal frames keep call order. A full queue applies its earliest frame's events early
  // (the smallest timing error), or the new event itself when it is due before them, never drops one; frames beyond
  // the horizon are refused, so junk can't fill it.
  function admit() {
    var i = EI[QUEUE];
    if (i === NO_EVENT) return true;
    EI[QUEUE] = NO_EVENT;
    var v = EV[QUEUE], f = EF[QUEUE], mode = ES[QUEUE], now = !(f > T[1]);
    f = now ? T[1] : Math.round(f);
    if (f - T[1] > horizon) return false;
    if (i >= 0) {
      if (mode === 2 && v === LV[i] && f >= LF[i]) return true; // load(): unchanged
      if (f >= LF[i]) { LF[i] = f; LV[i] = v; }
    }
    var n = EN[0];
    if (n >= QUEUE) {
      if (f < EF[0]) {
        // Full, and this one is due before the head (or now): apply it on its own. Pushing the head out early
        // instead would let a later change be undone by this earlier one.
        for (var q = n; q > 0; q--) { EF[q] = EF[q - 1]; EV[q] = EV[q - 1]; EI[q] = EI[q - 1]; ES[q] = ES[q - 1]; }
        EF[0] = f; EV[0] = v; EI[0] = i; ES[0] = mode === 1 ? 1 : 0;
        EN[0] = n + 1;
        T[4] = f; due();
        EI[QUEUE] = NO_EVENT;
        return true;
      }
      T[4] = EF[0]; due(); n = EN[0]; // the earliest frame goes out early: the smallest timing error
    }
    var j = n;
    while (j > 0 && EF[j - 1] > f) { EF[j] = EF[j - 1]; EV[j] = EV[j - 1]; EI[j] = EI[j - 1]; ES[j] = ES[j - 1]; j--; }
    EF[j] = f; EV[j] = v; EI[j] = i; ES[j] = mode === 1 ? 1 : 0;
    EN[0] = n + 1;
    if (now) { T[4] = T[1]; due(); }
    return true;
  }
  /**
   * Apply every queued event at or before frame T[4]. Everything is in this one function, called by process() every
   * block, so it runs optimised: no call takes or returns a double, nothing is boxed. The units' set() and ctl() are
   * kept optimised the same way (process() touches them every block).
   */
  function due() {
    var n = EN[0], k = 0;
    while (k < n && EF[k] <= T[4]) {
      var i = EI[k], v = EV[k], snap = ES[k] === 1;
      k++;
      if (i === EV_CLEAR) {
        if (v > 0) {
          var fs = (v > 1000 ? 1000 : v) * 0.001 * sr;
          FC[2] = fs > 1 ? 1 / fs : 1;
          if (FC[0] !== 2) FC[0] = 1;
        } else {
          // The instant clear: delay and plate tails and the drive's one-sample state. The limiter is left alone.
          drive.ctl(OP_CLEAR, 0); delay.ctl(OP_CLEAR, 0); plate.ctl(OP_CLEAR, 0);
          FC[0] = 0; FC[1] = 1;
        }
        continue;
      }
      if (i === EV_TEMPO) {
        if (v !== v) continue;
        T[0] = v < 20 ? 20 : v > 400 ? 400 : v;
        delay.retarget(snap);
        continue;
      }
      if (i < 0 || i >= FX_NPARAMS) continue;
      var u = FIX_UNIT[i], ok;
      E.V[0] = v;
      if (u === 0) ok = drive.set(FIX_K[i], snap); else if (u === 1) ok = delay.set(FIX_K[i], snap); else ok = plate.set(FIX_K[i], snap);
      if (!ok) continue;
      PRM[i] = E.V[0];
      if (i === 16) MB.RD[MOD_T_DRIVE_AMOUNT] = E.V[0]; else if (i === 17) MB.RD[MOD_T_DRIVE_TONE] = E.V[0]; else if (i === 22) MB.RD[MOD_T_DELAY_SEND] = E.V[0];
    }
    if (k > 0) {
      for (var m = k; m < n; m++) { EF[m - k] = EF[m]; EI[m - k] = EI[m]; EV[m - k] = EV[m]; ES[m - k] = ES[m]; }
      EN[0] = n - k;
    }
  }
  /**
   * Queue one event (mode 1 = snap, 2 = skip if unchanged). Omitted, past or current frames apply at once.
   * A frame more than the horizon (600 s) ahead is refused (false): it is almost always a time on the wrong
   * clock, such as epoch seconds passed as an AudioContext time. Only stores here; admit() does the rest.
   */
  function schedule(i, value, frame, mode) {
    EV[QUEUE] = +value; EF[QUEUE] = frame > 0 ? frame : -1; ES[QUEUE] = mode; EI[QUEUE] = i;
    return admit();
  }
  // clear({fadeMs}): while the gain is 0 nothing goes in or out of the delay and the plate, and their lines are zeroed
  // CLEAR_CHUNK samples per block (the delay's first, then the plate's). Called every block (kept hot), works in phase 2.
  function fadeClearSome() {
    if (FC[0] !== 2) return;
    plate.ctl(OP_FADE_WORK, delay.ctl(OP_FADE_WORK, CLEAR_CHUNK));
    if (delay.ctl(OP_FADE_IDLE, 0) === 1 && plate.ctl(OP_FADE_IDLE, 0) === 1) { delay.ctl(OP_FADE_DONE, 0); plate.ctl(OP_FADE_DONE, 0); FC[0] = 3; }
  }

  // ---- Per-sample stages (src/units.js), then the pre-gain and the limiter.
  function render(inL, inR, outL, outR, from, to) {
    var pL = T[2], pR = T[3];
    for (var i = from; i < to; i++) {
      var xL = inL ? inL[i] : 0;
      var xR = inR ? inR[i] : xL;
      if (xL !== xL || xL === Infinity || xL === -Infinity) xL = 0;
      if (xR !== xR || xR === Infinity || xR === -Infinity) xR = 0;
      IO[0] = xL; IO[1] = xR;
      if (fadeStep(FC)) { delay.ctl(OP_FADE_BEGIN, 0); plate.ctl(OP_FADE_BEGIN, 0); }
      drive.step(i);
      delay.step(i);
      plate.step(i);
      lim.step();
      var yL = IO[0], yR = IO[1];
      outL[i] = yL;
      if (outR && outR !== outL) outR[i] = yR;
      if (yL < 0) yL = -yL;
      if (yR < 0) yR = -yR;
      if (yL > pL) pL = yL;
      if (yR > pR) pR = yR;
    }
    T[2] = pL; T[3] = pR;
  }

  var api = {
    sampleRate: sr,
    /** Samples of delay the chain adds (the lookahead limiter's 1.5 ms; 0 for 'soft' and 'off'). */
    latencySamples: limMode === 1 ? lim.la : 0,
    /** Post-chain block peaks [L, R], refreshed by every process() call. */
    peak: peak,
    /** Lowest limiter gain since the last read of `takeGainReduction()`. */
    takeGainReduction: function () { var lo = lim.LM[2]; lim.LM[2] = 1; return lo; },
    /**
     * Set one parameter (DSP units, FX_PARAM index) at an absolute frame (omitted/past = now). snap = no smoothing.
     * Returns false when the frame is more than 600 s ahead (refused: a time on the wrong clock).
     */
    set: function (index, value, frame, snap) { return schedule(index | 0, value, frame, snap ? 1 : 0); },
    get: function (index) { return PRM[index | 0]; },
    /** Copy a whole program (Float64Array or array of FX_NPARAMS DSP values) in at a frame. Unchanged values are skipped unless snap. */
    load: function (program, frame, snap) {
      // A shorter (older) program gets the defaults for the rest, so nothing stays at a stale value.
      for (var i = 0; i < FX_NPARAMS; i++) schedule(i, i < program.length ? program[i] : START[i], frame, snap ? 1 : 2);
    },
    /** Tempo for synced params (the delay). A change glides the delay time (80 ms), tape-style. False if refused. */
    setTempo: function (bpm, frame, snap) { return schedule(EV_TEMPO, bpm, frame, snap ? 1 : 0); },
    getTempo: function () { return T[0]; },
    /**
     * Panic: drop the delay and reverb tails now (or at a frame). fadeMs > 0 ramps the wet signal down over that
     * long first, then zeroes the lines a chunk per block and ramps back in (no click, no big fill). The instant
     * clear also resets the drive's one-sample antialiasing state; neither touches the limiter. False if refused.
     */
    clear: function (frame, fadeMs) { return schedule(EV_CLEAR, fadeMs > 0 ? fadeMs : 0, frame, 0); },
    /**
     * Render `frames` samples. inR null = mono in (R = L). outR null = mono out (left only).
     * blockFrame is the absolute frame of sample 0 (AudioWorklet `currentFrame`); omitted = continues.
     */
    process: function (inL, inR, outL, outR, frames, blockFrame, mod) {
      var start = blockFrame === undefined || blockFrame === null ? T[1] : +blockFrame;
      // Mod bus (src/mod.js): the depths always apply; the CV is the mod buffer when it covers the block and a route
      // has depth (modBlock), else silence (ZCV), so no CV, a short one and a silent one all sound the same. With
      // every depth at 0 the render below is the same code as without a mod input.
      var mon = modBlock(MB, mod, frames);
      E.mod = mon === 1 ? mod : drive.ctl(OP_MOD_ON, 0) === 1 || delay.ctl(OP_MOD_ON, 0) === 1 ? zeroCv(frames) : null;
      drive.ctl(OP_BLOCK, 0); delay.ctl(OP_BLOCK, 0);
      T[2] = 0; T[3] = 0;
      admit(); // keeps admit() hot (optimised) even when events are rare; the slot is normally empty
      drive.set(-1, false); delay.set(-1, false); plate.set(-1, false); delay.retarget(-1); // keep them hot (see due)
      var i = 0;
      while (i < frames) {
        T[4] = start + i;
        due();
        var end = frames;
        if (EN[0] > 0) {
          var next = EF[0] - start;
          if (next < end) end = next > i ? next : i + 1;
        }
        var dt = drive.ctl(OP_GRID_ON, 0) === 1, lt = delay.ctl(OP_GRID_ON, 0) === 1;
        if (dt || lt) {
          // Drive tone / delay filters in use: block-rate updates on the absolute MOD_GRID (Bass reads mod[0] and
          // smooths per 128-frame block), so the result doesn't depend on the host's block size.
          var ph = (start + i) % MOD_GRID;
          if (ph === 0) { if (dt) drive.ctl(OP_GRID, i); if (lt) delay.ctl(OP_GRID, i); }
          var nb = i + MOD_GRID - ph;
          if (nb < end) end = nb;
        }
        render(inL, inR, outL, outR, i, end);
        i = end;
      }
      T[1] = start + frames;
      peak[0] = T[2]; peak[1] = T[3];
      drive.ctl(OP_SETTLE, 0); delay.ctl(OP_SETTLE, 0); plate.ctl(OP_SETTLE, 0);
      delay.ctl(OP_SLEEP, 0); plate.ctl(OP_SLEEP, 0);
      fadeClearSome();
    }
  };
  return api;
}
