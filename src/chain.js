// nc-fx slot engine: ASTRID's chain model. Up to N effects (default 3) of any type, in any order the player picks,
// then the pre-gain and the limiter (fixed last). Adding, removing and reordering are click-free: ASTRID's
// ncChainOrder / ncFade / ncKeep (a 4 ms raised-cosine fade of the chain's output down, the new order, and up again).
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// ASTRID's chain (lib/synth-audio/src/hacks-vendor/dsp.js, ncChain*) keys hacks by string id in an object and makes
// a new hack (with its buffers) on every 'add'. Here the hacks live in a fixed pool of boxes, 2N + 2 of them, so the
// boxes of the order playing now, of the next order and of a few adds in flight always fit. A box keeps one unit of
// each type it has ever held: the first add of a type to a box allocates that unit (on the control path: add() runs
// in the worklet's message handler, never in process()); after that adding, removing and reordering allocate nothing.
// The host names each effect instance with a positive integer uid (createFxCore does this); uids are never reused.
//
// Events (sample-accurate, the same queue as createFxDsp): add (the box goes live: ncChainAdd), order (ncChainOrder;
// snap = immediate, as ncChainSet's), a param (ncChainPatch), tempo, clear (ncChainClear).

import { createFxEnv, createUnit, UNIT_TYPES, CLEAR_CHUNK, PI, OP_CLEAR, OP_FADE_BEGIN, OP_FADE_WORK, OP_FADE_DONE, OP_FADE_IDLE, OP_SLEEP, OP_BLOCK, OP_MOD_ON, OP_GRID_ON, OP_GRID, OP_SETTLE, OP_RESET } from './units.js'; // @strip
import { createLimiter, createQueue, fadeStep, EV_TEMPO, EV_CLEAR, HORIZON_S, MOD_GRID, QUEUE_SIZE, QUEUE_EMPTY } from './dsp.js'; // @strip

var EV_ADD = -1000;   // EV_ADD - b: box b goes live
var EV_ORDER = -2000; // EV_ORDER - l: order list l
var MAXK = 16;        // params per box in the event index (b * MAXK + k)
var NTYPES = 12;
var MAX_SLOTS = 8;

/**
 * @param {number} sampleRate
 * @param {{slots?: number, bypassMode?: 'hold'|'run', limiter?: 'lookahead'|'soft'|'off', preGain?: number,
 *   maxDelaySeconds?: number, startFrame?: number}} [opts]
 */
export function createFxChainDsp(sampleRate, opts) {
  var o = opts || {};
  var E = createFxEnv(sampleRate, o);
  var sr = E.sr, IO = E.IO, T = E.T, FC = E.FC;
  var N = o.slots > 0 ? (o.slots < MAX_SLOTS ? Math.floor(o.slots) : MAX_SLOTS) : 3;
  var NB = 2 * N + 2;
  var limMode = o.limiter === 'lookahead' ? 1 : o.limiter === 'soft' ? 2 : 0;
  var preGain = typeof o.preGain === 'number' && o.preGain >= 0 && o.preGain < 16 ? o.preGain : 1;
  var horizon = Math.round(HORIZON_S * sr);
  T[1] = o.startFrame > 0 ? Math.round(o.startFrame) : 0;
  var peak = new Float32Array(2);
  var lim = createLimiter(E, limMode);
  lim.LM[4] = preGain;
  var QUEUE = QUEUE_SIZE, NO_EVENT = QUEUE_EMPTY;

  // Boxes: TYPE (-1 empty), UID, STATE (0 free, 1 reserved: add scheduled, 2 live), CUR (its unit), POOL[b][t].
  var TYPE = new Int32Array(NB), UID = new Int32Array(NB), STATE = new Int32Array(NB), AGE = new Int32Array(NB);
  var POOL = [], CUR = [];
  for (var b0 = 0; b0 < NB; b0++) { TYPE[b0] = -1; POOL.push([]); CUR.push(null); for (var t0 = 0; t0 < NTYPES; t0++) POOL[b0].push(null); }
  // A stand-in unit for empty boxes, so the per-block loops never see null.
  var IDLE = createUnit(E, 5);
  for (b0 = 0; b0 < NB; b0++) CUR[b0] = IDLE;
  var PRM = new Float64Array(NB * MAXK);
  // The order playing (ORD, ON) and the next one (NXT, NN, HAS); FD: 0 phase (0 idle, 1 out, 2 in), 1 pos, 2 len.
  var ORD = new Int32Array(NB), NXT = new Int32Array(NB), NN = new Int32Array(1), ON = new Int32Array(1), HAS = new Int32Array(1);
  var FD = new Float64Array(3);
  FD[2] = Math.max(1, Math.round(0.004 * sr));
  // Order lists in flight (one per queued order event): boxes LISTS[l * NB + m] (for uid LUID[...]), LN[l] of them.
  var NL = QUEUE + 1, LISTS = new Int32Array(NL * NB), LUID = new Int32Array(NL * NB), LN = new Int32Array(NL);
  var LFREE = new Int32Array(NL), LTOP = new Int32Array(1);
  for (var l0 = 0; l0 < NL; l0++) LFREE[l0] = NL - 1 - l0;
  LTOP[0] = NL;
  var ZCV = new Float32Array(MOD_GRID);
  function zeroCv(n) { if (ZCV.length < n) ZCV = new Float32Array(n); return ZCV; }
  var Q = createQueue(0, null);
  var EI = Q.EI, EV = Q.EV, ES = Q.ES, EF = Q.EF, EN = Q.EN;
  var clock = 0;

  function boxOf(uid) {
    for (var b = 0; b < NB; b++) if (STATE[b] !== 0 && UID[b] === uid) return b;
    return -1;
  }
  function inOrder(b) { for (var m = 0; m < ON[0]; m++) if (ORD[m] === b) return true; return false; }
  function inNext(b) { for (var m = 0; m < NN[0]; m++) if (NXT[m] === b) return true; return false; }
  /** ncFade, per sample: the chain gain for this sample, times the pre-gain, into the limiter. At the bottom of the
   * fade out the next order takes over and ncKeep lets go of every live box that isn't in it. */
  function fade() {
    var ph = FD[0];
    if (ph === 0 || (ph === 1 && HAS[0] === 0)) { lim.LM[4] = preGain; return; }
    var len = FD[2];
    FD[1]++;
    var p = FD[1] / len;
    if (p > 1) p = 1;
    var g;
    if (ph === 1) {
      g = 0.5 * (1 + Math.cos(PI * p));
      if (FD[1] >= len) {
        for (var m = 0; m < NN[0]; m++) ORD[m] = NXT[m];
        ON[0] = NN[0]; HAS[0] = 0;
        for (var b = 0; b < NB; b++) if (STATE[b] === 2 && !inOrder(b)) STATE[b] = 0; // ncKeep
        FD[0] = 2; FD[1] = 0;
      }
    } else {
      g = 0.5 * (1 - Math.cos(PI * p));
      if (FD[1] >= len) { FD[0] = 0; FD[1] = 0; }
    }
    lim.LM[4] = g * preGain;
  }

  // Events: as createFxDsp's admit() and due() (see there), with this engine's event switch inside due().
  function admit() {
    var i = EI[QUEUE];
    if (i === NO_EVENT) return true;
    EI[QUEUE] = NO_EVENT;
    var v = EV[QUEUE], f = EF[QUEUE], mode = ES[QUEUE], now = !(f > T[1]);
    f = now ? T[1] : Math.round(f);
    if (f - T[1] > horizon) return false;
    var n = EN[0];
    if (n >= QUEUE) {
      if (f < EF[0]) {
        for (var q = n; q > 0; q--) { EF[q] = EF[q - 1]; EV[q] = EV[q - 1]; EI[q] = EI[q - 1]; ES[q] = ES[q - 1]; }
        EF[0] = f; EV[0] = v; EI[0] = i; ES[0] = mode === 1 ? 1 : 0;
        EN[0] = n + 1;
        T[4] = f; due();
        EI[QUEUE] = NO_EVENT;
        return true;
      }
      T[4] = EF[0]; due(); n = EN[0];
    }
    var j = n;
    while (j > 0 && EF[j - 1] > f) { EF[j] = EF[j - 1]; EV[j] = EV[j - 1]; EI[j] = EI[j - 1]; ES[j] = ES[j - 1]; j--; }
    EF[j] = f; EV[j] = v; EI[j] = i; ES[j] = mode === 1 ? 1 : 0;
    EN[0] = n + 1;
    if (now) { T[4] = T[1]; due(); }
    return true;
  }
  function due() {
    var n = EN[0], k = 0, b, m, u;
    while (k < n && EF[k] <= T[4]) {
      var i = EI[k], v = EV[k], snap = ES[k] === 1;
      k++;
      if (i >= 0) { // a param: ncChainPatch
        b = (i / MAXK) | 0;
        u = CUR[b];
        if (STATE[b] === 0 || u === IDLE) continue;
        E.V[0] = v;
        if (u.set(i - b * MAXK, snap)) PRM[i] = E.V[0];
        continue;
      }
      if (i === EV_TEMPO) {
        if (v !== v) continue;
        T[0] = v < 20 ? 20 : v > 400 ? 400 : v;
        for (b = 0; b < NB; b++) if (STATE[b] !== 0 && TYPE[b] === 1) CUR[b].retarget(snap);
        continue;
      }
      if (i === EV_CLEAR) {
        if (v > 0) {
          var fs = (v > 1000 ? 1000 : v) * 0.001 * sr;
          FC[2] = fs > 1 ? 1 / fs : 1;
          if (FC[0] !== 2) FC[0] = 1;
        } else {
          // ncChainClear: every box's state, and a reorder in flight is dropped (the order playing stays). The
          // limiter is left alone (as createFxDsp's instant clear; ASTRID rebuilds it).
          for (b = 0; b < NB; b++) if (STATE[b] === 2) CUR[b].ctl(OP_CLEAR, 0);
          FD[0] = 0; FD[1] = 0; HAS[0] = 0;
          FC[0] = 0; FC[1] = 1;
        }
        continue;
      }
      if (i <= EV_ORDER) { // ncChainOrder: the boxes that exist, in the order given
        var l = EV_ORDER - i, ln = LN[l], c = 0, at = l * NB;
        LFREE[LTOP[0]] = l; LTOP[0]++;
        NN[0] = 0;
        for (m = 0; m < ln; m++) {
          b = LISTS[at + m];
          if (STATE[b] === 2 && UID[b] === LUID[at + m] && !inNext(b)) { NXT[c] = b; c++; NN[0] = c; }
        }
        if (snap) { // immediate (a load): no fade
          for (m = 0; m < c; m++) ORD[m] = NXT[m];
          ON[0] = c; NN[0] = 0; HAS[0] = 0; FD[0] = 0; FD[1] = 0;
          for (b = 0; b < NB; b++) if (STATE[b] === 2 && !inOrder(b)) STATE[b] = 0;
          continue;
        }
        var same = c === ON[0];
        for (m = 0; same && m < c; m++) if (ORD[m] !== NXT[m]) same = false;
        if (same && FD[0] === 0) { NN[0] = 0; continue; }
        HAS[0] = 1;
        if (FD[0] !== 1) { FD[0] = 1; FD[1] = 0; }
        continue;
      }
      if (i <= EV_ADD) { b = EV_ADD - i; if (STATE[b] === 1) STATE[b] = 2; } // ncChainAdd
    }
    if (k > 0) {
      for (m = k; m < n; m++) { EF[m - k] = EF[m]; EI[m - k] = EI[m]; EV[m - k] = EV[m]; ES[m - k] = ES[m]; }
      EN[0] = n - k;
    }
  }
  function schedule(i, value, frame, mode) {
    EV[QUEUE] = +value; EF[QUEUE] = frame > 0 ? frame : -1; ES[QUEUE] = mode; EI[QUEUE] = i;
    return admit();
  }

  /** A box for a new effect: a free one (one that already holds this type first, so nothing is allocated), else a
   * live one that is in neither order (dropped by a clear mid-reorder, or never ordered), oldest first. */
  function pickBox(t) {
    var best = -1, b;
    for (b = 0; b < NB; b++) if (STATE[b] === 0 && POOL[b][t] !== null && (best < 0 || AGE[b] < AGE[best])) best = b;
    if (best >= 0) return best;
    for (b = 0; b < NB; b++) if (STATE[b] === 0 && (best < 0 || AGE[b] < AGE[best])) best = b;
    if (best >= 0) return best;
    for (b = 0; b < NB; b++) {
      if (STATE[b] !== 2 || inOrder(b) || (HAS[0] === 1 && inNext(b))) continue;
      if (best < 0 || AGE[b] < AGE[best]) best = b;
    }
    return best;
  }

  // ---- Per-sample stages: the boxes in order, the chain fade, the pre-gain and the limiter.
  function render(inL, inR, outL, outR, from, to) {
    var pL = T[2], pR = T[3];
    for (var i = from; i < to; i++) {
      var xL = inL ? inL[i] : 0;
      var xR = inR ? inR[i] : xL;
      if (xL !== xL || xL === Infinity || xL === -Infinity) xL = 0;
      if (xR !== xR || xR === Infinity || xR === -Infinity) xR = 0;
      IO[0] = xL; IO[1] = xR;
      if (fadeStep(FC)) for (var b = 0; b < NB; b++) if (STATE[b] === 2) CUR[b].ctl(OP_FADE_BEGIN, 0);
      var n = ON[0];
      for (var m = 0; m < n; m++) CUR[ORD[m]].step(i);
      fade();
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
  // clear({fadeMs}): every live box's tail (delay, plate) is zeroed CLEAR_CHUNK samples per block while the wet is 0.
  function fadeClearSome() {
    if (FC[0] !== 2) return;
    var left = CLEAR_CHUNK, idle = true, b;
    for (b = 0; b < NB; b++) if (STATE[b] === 2) { left = CUR[b].ctl(OP_FADE_WORK, left); if (CUR[b].ctl(OP_FADE_IDLE, 0) !== 1) idle = false; }
    if (idle) { for (b = 0; b < NB; b++) if (STATE[b] === 2) CUR[b].ctl(OP_FADE_DONE, 0); FC[0] = 3; }
  }

  var api = {
    sampleRate: sr,
    /** How many effects the chain holds. */
    slots: N,
    latencySamples: limMode === 1 ? lim.la : 0,
    peak: peak,
    takeGainReduction: function () { var lo = lim.LM[2]; lim.LM[2] = 1; return lo; },
    /**
     * Add an effect instance (uid > 0, never reused; type a UNIT_TYPES name or code) at a frame. It starts at the
     * unit's defaults, off; set its params (snap) at the same frame, then order() it in. Allocates the first time a
     * box holds this type (control path only). False if refused (bad type, uid in use, no box, frame too far).
     */
    add: function (uid, type, frame) {
      var t = typeof type === 'number' ? type | 0 : UNIT_TYPES.indexOf(type);
      uid = uid | 0;
      if (!(t >= 0 && t < NTYPES) || uid <= 0 || boxOf(uid) >= 0) return false;
      var b = pickBox(t);
      if (b < 0) return false;
      if (POOL[b][t] === null) POOL[b][t] = createUnit(E, t);
      var u = POOL[b][t];
      u.ctl(OP_RESET, 0);
      u.retarget(true);
      for (var k = 0; k < MAXK; k++) PRM[b * MAXK + k] = 0;
      TYPE[b] = t; UID[b] = uid; CUR[b] = u; STATE[b] = 1; AGE[b] = ++clock;
      if (!schedule(EV_ADD - b, 0, frame, 0)) { STATE[b] = 0; CUR[b] = IDLE; return false; }
      return true;
    },
    /** The order to play (uids, first to last; unknown ones are skipped). immediate = no fade (a load). */
    order: function (uids, frame, immediate) {
      if (LTOP[0] === 0) return false;
      LTOP[0]--;
      var l = LFREE[LTOP[0]], at = l * NB, c = 0;
      for (var m = 0; m < uids.length && c < NB; m++) { var b = boxOf(uids[m] | 0); if (b >= 0) { LISTS[at + c] = b; LUID[at + c] = UID[b]; c++; } }
      LN[l] = c;
      if (!schedule(EV_ORDER - l, 0, frame, immediate ? 1 : 0)) { LFREE[LTOP[0]] = l; LTOP[0]++; return false; }
      return true;
    },
    /** One param (k = 0 on flag; DSP units) of an effect instance. */
    set: function (uid, k, value, frame, snap) {
      var b = boxOf(uid | 0);
      k = k | 0;
      if (b < 0 || k < 0 || k >= MAXK) return false;
      return schedule(b * MAXK + k, value, frame, snap ? 1 : 0);
    },
    get: function (uid, k) { var b = boxOf(uid | 0); return b < 0 ? undefined : PRM[b * MAXK + (k | 0)]; },
    /** The uids playing now, in order (a new array: for tests and hosts, not the audio path). */
    playing: function () { var out = []; for (var m = 0; m < ON[0]; m++) out.push(UID[ORD[m]]); return out; },
    setTempo: function (bpm, frame, snap) { return schedule(EV_TEMPO, bpm, frame, snap ? 1 : 0); },
    getTempo: function () { return T[0]; },
    /** As createFxDsp's: instant (every effect's state, as ASTRID's ncChainClear) or fadeMs (delay and reverb tails). */
    clear: function (frame, fadeMs) { return schedule(EV_CLEAR, fadeMs > 0 ? fadeMs : 0, frame, 0); },
    process: function (inL, inR, outL, outR, frames, blockFrame, mod) {
      var start = blockFrame === undefined || blockFrame === null ? T[1] : +blockFrame;
      var b, m, any = false;
      for (b = 0; b < NB; b++) if (STATE[b] === 2 && CUR[b].ctl(OP_MOD_ON, 0) === 1) any = true;
      E.mod = !any ? null : mod !== null && mod !== undefined && mod.length >= frames ? mod : zeroCv(frames);
      for (b = 0; b < NB; b++) {
        var u = CUR[b];
        u.ctl(OP_BLOCK, 0);
        u.set(-1, false); u.retarget(-1); // keep them optimised (see createFxDsp's due())
      }
      T[2] = 0; T[3] = 0;
      admit();
      var i = 0;
      while (i < frames) {
        T[4] = start + i;
        due();
        var end = frames;
        if (EN[0] > 0) {
          var next = EF[0] - start;
          if (next < end) end = next > i ? next : i + 1;
        }
        var grid = false;
        for (m = 0; m < ON[0]; m++) if (CUR[ORD[m]].ctl(OP_GRID_ON, 0) === 1) grid = true;
        if (grid) {
          var ph = (start + i) % MOD_GRID;
          if (ph === 0) for (m = 0; m < ON[0]; m++) { var gu = CUR[ORD[m]]; if (gu.ctl(OP_GRID_ON, 0) === 1) gu.ctl(OP_GRID, i); }
          var nb = i + MOD_GRID - ph;
          if (nb < end) end = nb;
        }
        render(inL, inR, outL, outR, i, end);
        i = end;
      }
      T[1] = start + frames;
      peak[0] = T[2]; peak[1] = T[3];
      for (b = 0; b < NB; b++) if (STATE[b] !== 0) { CUR[b].ctl(OP_SETTLE, 0); CUR[b].ctl(OP_SLEEP, 0); }
      fadeClearSome();
    }
  };
  return api;
}
