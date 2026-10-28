// nc-fx DSP engine: drive -> delay -> reverb (plate) -> pre-gain -> limiter, in a fixed order.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// Pure ES2019 with no imports, so it runs inside any AudioWorkletGlobalScope (dist/worklet.js inlines
// this file) and in Node. The effects are ported from ASTRID (psemmelhack/NetComposer-Synth 024f200,
// lib/synth-audio/src/hacks-vendor/dsp.js, itself netcomposer.art create/hacks/dsp.js @ 3fb61f5):
// the same arithmetic in the same order, so ASTRID's chain and this one render the same samples
// (test/astrid-parity.test.mjs). What changed is where state lives: every buffer and every scalar is
// allocated once, here, in typed arrays. Nothing on the audio path allocates: not process(), not set(),
// not setTempo(), not a bypass, not a tempo change.

/** Indexes of the engine's parameters (DSP units, see src/params.js for the dial laws). */
export var FX_PARAM = {
  DRIVE_ON: 0, DRIVE_DB: 1, DRIVE_OUT_DB: 2, DRIVE_MIX: 3,
  DELAY_ON: 4, DELAY_BEATS: 5, DELAY_FEEDBACK: 6, DELAY_MIX: 7,
  PLATE_ON: 8, PLATE_PREDELAY: 9, PLATE_SIZE: 10, PLATE_DECAY: 11, PLATE_DAMPING: 12, PLATE_MIX: 13
};
export var FX_NPARAMS = 14;
/** Event kinds besides a parameter index. */
var EV_TEMPO = -1;
var EV_CLEAR = -2;

var FS = 29761;
var PI = 3.141592653589793;
var HALFPI = 1.5707963267948966;
var TWOPI = 6.283185307179586;
var CEILING = 0.8912509381337456;
var BW = 0.9995;
var MAX_DELAY_S = 4.9;
var QUEUE = 256;
var NO_EVENT = -99; // empty staging slot
var CLEAR_CHUNK = 4096;
var SNAP_EPS = 1e-30; // smoothers snap onto their target this close: only a 0 target gets here, long before subnormals (2.2e-308)
var HORIZON_S = 600; // events further ahead than this are refused
// Dattorro's line lengths at FS (0 is the pre-delay, sized separately).
var PLATE_PAPER = [0, 142, 107, 379, 277, 672, 908, 4453, 4217, 1800, 2656, 3720, 3163];
var L_PRE = 0, L_IN = 1, L_AP1 = 5, L_D1 = 7, L_AP2 = 9, L_D2 = 11, N_LINES = 13;
var PLATE_IG = [0.75, 0.75, 0.625, 0.625];

function fxCoef(seconds, sr) { return 1 - Math.exp(-1 / (seconds * sr)); }

/**
 * The engine. Allocates everything up front (about 1.9 MB of delay line and 0.3 MB of plate at 48 kHz).
 * @param {number} sampleRate
 * @param {{bypassMode?: 'hold'|'run', limiter?: 'lookahead'|'soft'|'off', preGain?: number}} [opts]
 */
export function createFxDsp(sampleRate, opts) {
  var o = opts || {};
  var sr = +sampleRate > 0 ? +sampleRate : 48000;
  var hold = o.bypassMode === 'hold'; // default 'run': bypassed effects keep running, so tails ring out (ASTRID)
  // Transparent by default: limiter off and pre-gain 1, so an all-bypassed chain is bit-identical to its input.
  var limMode = o.limiter === 'lookahead' ? 1 : o.limiter === 'soft' ? 2 : 0;
  var preGain = typeof o.preGain === 'number' && o.preGain >= 0 && o.preGain < 16 ? o.preGain : 1;
  var kFast = fxCoef(0.02, sr), kSlow = fxCoef(0.08, sr);
  // Longest delay (the delay line is sized from it). Default 4.9 s, ASTRID's.
  var maxDelay = typeof o.maxDelaySeconds === 'number' && o.maxDelaySeconds > 0 ? (o.maxDelaySeconds < 60 ? o.maxDelaySeconds : 60) : MAX_DELAY_S;
  var horizon = Math.round(HORIZON_S * sr);

  // Shared scratch: IO carries the two samples between stages; T holds bpm, the frame clock and the meter.
  var IO = new Float64Array(2);
  var T = new Float64Array(5); // 0 bpm, 1 next frame, 2 peakL, 3 peakR, 4 due-up-to frame
  T[0] = 120;
  T[1] = o.startFrame > 0 ? Math.round(o.startFrame) : 0; // a worklet passes currentFrame (for the horizon)
  var peak = new Float32Array(2);
  // Each parameter's starting value; PRM = last applied (targets), LV/LF = value and frame of the latest-frame
  // set() so far (load() skips values that wouldn't change anything).
  var START = [0, 0, 0, 1, 0, 0.75, 0.35, 0, 0, 0, 0.5, 0.5, 0, 0];
  var PRM = new Float64Array(START), LV = new Float64Array(START), LF = new Float64Array(FX_NPARAMS);
  var FC = new Float64Array(6); // clear({fadeMs}) state, see fadeClearSome()
  FC[1] = 1;

  // ---- Drive (ncDrive*: tanh with first-order antiderivative antialiasing, level kept at -12 dBFS)
  var DR = new Float64Array(12); // 0 u0, 1 u1, 2 f0, 3 f1, 4 driveS, 5 driveT, 6 outS, 7 outT, 8 mixS, 9 mixT, 10 on, 11 onT
  DR[8] = 1; DR[9] = 1;

  // ---- Delay (ncDelay*: one stereo tap, linear interpolation, equal-power wet/dry)
  var dn = Math.ceil(maxDelay * sr) + 8;
  var dBufL = new Float32Array(dn), dBufR = new Float32Array(dn);
  var DL = new Float64Array(12); // 0 w, 1 dlyS, 2 dlyT, 3 fbS, 4 fbT, 5 wetS, 6 wetT, 7 on, 8 onT, 9 beats, 10 clearPos, 11 sleep (0 awake, 1 clearing, 2 clear)
  DL[1] = 0.75 * sr; DL[2] = 0.75 * sr; DL[3] = 0.35; DL[4] = 0.35; DL[9] = 0.75;

  // ---- Plate (ncPlate*: Dattorro, JAES 1997, "Effect Design Part 1")
  var PB = [], PN = new Int32Array(N_LINES), PW = new Int32Array(N_LINES);
  var kMax = (sr / FS) * 1.5;
  for (var li = 0; li < N_LINES; li++) {
    var n;
    if (li === L_PRE) n = Math.ceil(0.2 * sr) + 8;
    else { n = Math.ceil(PLATE_PAPER[li] * kMax + 8 * (sr / FS) + 16); if (n < 16) n = 16; }
    PN[li] = n;
    PB.push(new Float32Array(n));
  }
  // 0 preS, 1 preT, 2 sizeS, 3 sizeT, 4 decayS, 5 decayT, 6 dampS, 7 dampT, 8 mixS, 9 mixT, 10 on, 11 onT,
  // 12 bw, 13 damp0, 14 damp1, 15 leftEnd, 16 rightEnd, 17 phase, 18 clear line, 19 clear pos, 20 sleep (as the delay's)
  var PL = new Float64Array(21);
  PL[2] = 0.5; PL[3] = 0.5; PL[4] = 0.5; PL[5] = 0.5;

  // ---- Limiter (ncLimiter*: sample peak, stereo-linked, 1.5 ms lookahead, -1 dB ceiling, 50 ms release)
  var la = Math.round(0.0015 * sr);
  if (la < 1) la = 1;
  var limL = new Float32Array(la), limR = new Float32Array(la), limG = new Float32Array(la);
  var LM = new Float64Array(8); // 0 w, 1 env, 2 lo, 3 rel, 4 soft u0, 5 soft u1, 6 soft f0, 7 soft f1
  LM[3] = fxCoef(0.05, sr);
  function limReset() {
    limL.fill(0); limR.fill(0); limG.fill(1);
    LM[0] = 0; LM[1] = 1; LM[2] = 1; LM[4] = 0; LM[5] = 0; LM[6] = 0; LM[7] = 0;
  }
  limReset();

  // ---- Event queue: sample-accurate parameter and tempo changes, sorted by frame
  // Slot QUEUE stages the incoming event (see admit()).
  var EF = new Float64Array(QUEUE + 1), EI = new Int32Array(QUEUE + 1), EV = new Float64Array(QUEUE + 1);
  var ES = new Uint8Array(QUEUE + 1); // 1 = snap (no smoothing) when it lands
  EI[QUEUE] = NO_EVENT;
  var EN = new Int32Array(1);

  // Hot-path helpers never take or return a double (see S below); the tiny formulas are written in place.
  // The plate's helpers take their numbers through S, not as arguments or return values: the plate is too
  // big for the engine to paste them in place, and a double crossing a call boundary is boxed (allocated).
  // S: 0 read position (samples ago), 1 result, 2 x, 3 g, 4 scale, 5 g2, 6 modulated length.
  var S = new Float64Array(7);
  function readFrac(li) {
    var ago = S[0];
    if (ago < 1) ago = 1;
    var n = PN[li];
    var max = n - 2;
    if (ago > max) ago = max;
    var i0 = Math.floor(ago);
    var f = ago - i0;
    var a = (PW[li] - i0) % n;
    if (a < 0) a += n;
    var b = a === 0 ? n - 1 : a - 1;
    var buf = PB[li];
    S[1] = buf[a] * (1 - f) + buf[b] * f;
  }
  function write(li) {
    PB[li][PW[li]] = S[2];
    var w = PW[li] + 1;
    PW[li] = w >= PN[li] ? 0 : w;
  }
  /** x in S[2], g in S[3], length in S[0]; result in S[1]. */
  function lattice(li) {
    var x = S[2], g = S[3];
    readFrac(li);
    var d = S[1];
    var v = x - g * d;
    if (v > -1e-15 && v < 1e-15) v = 0;
    var y = g * v + d;
    if (y > -1e-15 && y < 1e-15) y = 0;
    S[2] = v;
    write(li);
    S[1] = y;
  }
  /** x in S[2], modulated length in S[6], scale in S[4], g2 in S[5]; result in S[1]. */
  function tank(side) {
    var scale = S[4];
    S[0] = S[6]; S[3] = -0.7;
    lattice(L_AP1 + side);
    var x = S[1];
    S[0] = PLATE_PAPER[L_D1 + side] * scale;
    readFrac(L_D1 + side);
    var d = S[1];
    S[2] = x;
    write(L_D1 + side);
    var dmp = PL[6];
    var y = (1 - dmp) * d + dmp * PL[13 + side];
    if (y > -1e-15 && y < 1e-15) y = 0;
    PL[13 + side] = y;
    S[2] = y; S[3] = S[5]; S[0] = PLATE_PAPER[L_AP2 + side] * scale;
    lattice(L_AP2 + side);
    x = S[1];
    S[0] = PLATE_PAPER[L_D2 + side] * scale;
    readFrac(L_D2 + side);
    d = S[1];
    S[2] = x;
    write(L_D2 + side);
    S[1] = d;
  }

  function clearDrive() { DR[0] = 0; DR[1] = 0; DR[2] = 0; DR[3] = 0; }
  function clearDelay() { dBufL.fill(0); dBufR.fill(0); DL[0] = 0; DL[10] = 0; }
  function clearPlateState() {
    for (var i = 0; i < N_LINES; i++) PW[i] = 0;
    PL[12] = 0; PL[13] = 0; PL[14] = 0; PL[15] = 0; PL[16] = 0; PL[17] = 0; PL[18] = 0; PL[19] = 0;
  }
  function clearPlate() {
    for (var i = 0; i < N_LINES; i++) PB[i].fill(0);
    clearPlateState();
  }
  // 'hold' bypass clears tails a piece per block while an effect sleeps, so no block pays for a big fill.
  function clearSome() {
    var left = CLEAR_CHUNK, end;
    if (DL[11] === 1) {
      end = DL[10] + CLEAR_CHUNK;
      if (end >= dn) { clearDelay(); DL[11] = 2; } else { dBufL.fill(0, DL[10], end); dBufR.fill(0, DL[10], end); DL[10] = end; }
    }
    while (PL[20] === 1 && left > 0) {
      var li = PL[18], pos = PL[19], n = PN[li];
      end = pos + left;
      if (end > n) end = n;
      PB[li].fill(0, pos, end);
      left -= end - pos;
      if (end >= n) {
        PW[li] = 0;
        if (li + 1 >= N_LINES) { clearPlate(); PL[20] = 2; break; }
        PL[18] = li + 1; PL[19] = 0;
      } else PL[19] = end;
    }
  }
  // clear({fadeMs}): FC 0 phase (0 off, 1 fading out, 2 clearing, 3 fading in), 1 wet gain, 2 gain step per
  // sample, 3 delay position, 4 plate line, 5 plate position. While the gain is 0 nothing goes in or out of
  // the delay and the plate, and their lines are zeroed CLEAR_CHUNK samples per block.
  function fadeClearSome() {
    var left = CLEAR_CHUNK, end = FC[3] + CLEAR_CHUNK;
    if (FC[3] < dn) {
      if (end > dn) end = dn;
      dBufL.fill(0, FC[3], end); dBufR.fill(0, FC[3], end);
      left -= end - FC[3];
      FC[3] = end;
    }
    while (left > 0 && FC[4] < N_LINES) {
      var li = FC[4], pos = FC[5], n = PN[li];
      end = pos + left;
      if (end > n) end = n;
      PB[li].fill(0, pos, end);
      left -= end - pos;
      if (end >= n) { FC[4] = li + 1; FC[5] = 0; } else FC[5] = end;
    }
    if (FC[3] >= dn && FC[4] >= N_LINES) { DL[0] = 0; clearPlateState(); FC[0] = 3; }
  }
  /** The instant clear: delay and plate tails and the drive's one-sample state. The limiter is left alone. */
  function clearAll() {
    clearDrive(); clearDelay(); clearPlate();
    FC[0] = 0; FC[1] = 1;
  }
  // Events: the API stages one event in slot QUEUE (EI/EV/EF/ES) and calls admit(), which process() also calls
  // every block, so admit() runs optimised and the cold API never reads a double (a cold read boxes it).
  // Sorted by frame; equal frames keep call order. A full queue applies its earliest frame's events early
  // (the smallest timing error), never drops one; frames beyond the horizon are refused, so junk can't fill it.
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
    if (n >= QUEUE) { T[4] = EF[0]; due(); n = EN[0]; }
    var j = n;
    while (j > 0 && EF[j - 1] > f) { EF[j] = EF[j - 1]; EV[j] = EV[j - 1]; EI[j] = EI[j - 1]; ES[j] = ES[j - 1]; j--; }
    EF[j] = f; EV[j] = v; EI[j] = i; ES[j] = mode === 1 ? 1 : 0;
    EN[0] = n + 1;
    if (now) { T[4] = T[1]; due(); }
    return true;
  }
  /**
   * Apply every queued event at or before frame T[4]. Everything is in this one function, called by
   * process() every block, so it runs optimised: no call takes or returns a double, nothing is boxed.
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
        } else clearAll();
        continue;
      }
      if (i < EV_TEMPO || i >= FX_NPARAMS) continue;
      var on = v ? 1 : 0, flag = i >= 0 && (i & 3) === 0 && i < 12;
      if (!flag && v !== v) continue;
      var lo = 0, hi = 1;
      if (i === EV_TEMPO) { lo = 20; hi = 400; } else if (i === 1) hi = 24; else if (i === 2) { lo = -12; hi = 12; }
      else if (i === 5) { lo = 0.0625; hi = 8; } else if (i === 6) hi = 0.9; else if (i === 9) hi = 0.2;
      var x = v < lo ? lo : v > hi ? hi : v, retarget = false;
      switch (i) {
        case -1: T[0] = x; retarget = true; break;
        case 0: if (on && DR[11] === 0) clearDrive(); DR[11] = on; if (snap) DR[10] = on; break;
        case 1: DR[5] = x; if (snap) DR[4] = x; break;
        case 2: DR[7] = x; if (snap) DR[6] = x; break;
        case 3: DR[9] = x; if (snap) DR[8] = x; break;
        case 4: if (on) { if (DL[11] === 1) clearDelay(); DL[11] = 0; } DL[8] = on; if (snap) DL[7] = on; break;
        case 5: DL[9] = x; retarget = true; break;
        case 6: DL[4] = x; if (snap) DL[3] = x; break;
        case 7: DL[6] = x; if (snap) DL[5] = x; break;
        case 8: if (on) { if (PL[20] === 1) clearPlate(); PL[20] = 0; } PL[11] = on; if (snap) PL[10] = on; break;
        case 9: PL[1] = x; if (snap) PL[0] = x; break;
        case 10: PL[3] = x; if (snap) PL[2] = x; break;
        case 11: PL[5] = x; if (snap) PL[4] = x; break;
        case 12: PL[7] = x; if (snap) PL[6] = x; break;
        case 13: PL[9] = x; if (snap) PL[8] = x; break;
      }
      if (retarget) {
        // Delay target in samples from beats and tempo (hacks.ts: +delayS(beats, tempo).toFixed(4)).
        var bpm = T[0], s = DL[9] * 60 / (bpm > 0 ? bpm : 120);
        if (s > maxDelay) s = maxDelay;
        s = Math.round(s * 1e4) / 1e4;
        if (!(s > 0)) s = 0;
        if (s > maxDelay) s = maxDelay;
        var smp = s * sr;
        if (smp < 1) smp = 1;
        if (smp > dn - 4) smp = dn - 4;
        DL[2] = smp;
        if (snap) DL[1] = smp;
      }
      if (i >= 0) PRM[i] = flag ? on : x;
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
  /** Snap a smoother (state A[s], target A[s + 1]) onto its target once within SNAP_EPS (no subnormals). */
  function settle(A, s) {
    var d = A[s + 1] - A[s];
    if (d < SNAP_EPS && d > -SNAP_EPS) A[s] = A[s + 1];
  }
  function settleAll() {
    settle(DR, 4); settle(DR, 6); settle(DR, 8); settle(DR, 10);
    settle(DL, 1); settle(DL, 3); settle(DL, 5); settle(DL, 7);
    settle(PL, 0); settle(PL, 2); settle(PL, 4); settle(PL, 6); settle(PL, 8); settle(PL, 10);
  }
  // ---- Per-sample stages. Each reads IO[0], IO[1] and writes the result back.
  function driveStage() {
    var xL = IO[0], xR = IO[1];
    var k = kFast;
    DR[10] += (DR[11] - DR[10]) * k;
    var b = DR[10];
    if (hold && DR[11] === 0 && b <= 0.001) return;
    var oL, oR;
    DR[4] += (DR[5] - DR[4]) * k;
    DR[6] += (DR[7] - DR[6]) * k;
    DR[8] += (DR[9] - DR[8]) * k;
    if (Math.abs(DR[5] - DR[4]) < 1e-5) DR[4] = DR[5];
    if (Math.abs(DR[7] - DR[6]) < 1e-5) DR[6] = DR[7];
    if (Math.abs(DR[9] - DR[8]) < 1e-6) DR[8] = DR[9];
    var trim = DR[6] === 0 ? 1 : Math.pow(10, DR[6] / 20);
    if (DR[4] === 0) {
      DR[0] = 0; DR[1] = 0; DR[2] = 0; DR[3] = 0;
      oL = xL * trim; oR = xR * trim;
    } else {
      var g = Math.pow(10, DR[4] / 20) - 1;
      var comp = 0.25 / Math.tanh(0.25 * g) / g;
      var u = g * xL, ab = u < 0 ? -u : u, f = ab + Math.log(1 + Math.exp(-2 * ab)) - 0.6931471805599453, d = u - DR[0];
      var a = (d > 1e-5 || d < -1e-5) ? (f - DR[2]) / d : Math.tanh(0.5 * (u + DR[0]));
      DR[0] = u; DR[2] = f;
      u = g * xR; ab = u < 0 ? -u : u; f = ab + Math.log(1 + Math.exp(-2 * ab)) - 0.6931471805599453; d = u - DR[1];
      var c = (d > 1e-5 || d < -1e-5) ? (f - DR[3]) / d : Math.tanh(0.5 * (u + DR[1]));
      DR[1] = u; DR[3] = f;
      var m = DR[8];
      oL = trim * ((1 - m) * xL + m * g * comp * a);
      oR = trim * ((1 - m) * xR + m * g * comp * c);
    }
    if (b >= 0.999) { IO[0] = oL; IO[1] = oR; return; }
    if (b <= 0.001) return;
    var dryG = Math.cos(b * HALFPI), wetG = Math.sin(b * HALFPI);
    IO[0] = dryG * xL + wetG * oL;
    IO[1] = dryG * xR + wetG * oR;
  }
  function delayStage() {
    var xL = IO[0], xR = IO[1];
    var kf = kFast, ks = kSlow;
    DL[7] += (DL[8] - DL[7]) * kf;
    var b = DL[7];
    if (hold && DL[8] === 0 && b <= 0.001) { if (DL[11] === 0) { DL[11] = 1; DL[10] = 0; } return; }
    DL[1] += (DL[2] - DL[1]) * ks;
    DL[3] += (DL[4] - DL[3]) * kf;
    DL[5] += (DL[6] - DL[5]) * kf;
    var ago = DL[1];
    var i0 = Math.floor(ago);
    var f = ago - i0;
    if (i0 < 1) { i0 = 1; f = 0; }
    var max = dn - 3;
    if (i0 > max) { i0 = max; f = 0; }
    var w = DL[0];
    var aL = (w - i0) % dn;
    if (aL < 0) aL += dn;
    var bL = aL === 0 ? dn - 1 : aL - 1;
    var tg = FC[1]; // 1 except during clear({fadeMs}); x * 1 is exact, so this changes no sample otherwise
    var dL = (dBufL[aL] * (1 - f) + dBufL[bL] * f) * tg;
    var dR = (dBufR[aL] * (1 - f) + dBufR[bL] * f) * tg;
    var fb = DL[3];
    var wl = xL * tg + fb * dL; dBufL[w] = (wl > -1e-15 && wl < 1e-15) ? 0 : wl;
    var wr = xR * tg + fb * dR; dBufR[w] = (wr > -1e-15 && wr < 1e-15) ? 0 : wr;
    w++;
    DL[0] = w >= dn ? 0 : w;
    var wet = DL[5];
    var dg = Math.cos(wet * HALFPI), wg = Math.sin(wet * HALFPI);
    var oL = dg * xL + wg * dL, oR = dg * xR + wg * dR;
    if (b >= 0.999) { IO[0] = oL; IO[1] = oR; return; }
    if (b <= 0.001) return;
    var dryG = Math.cos(b * HALFPI), wetG = Math.sin(b * HALFPI);
    IO[0] = dryG * xL + wetG * oL;
    IO[1] = dryG * xR + wetG * oR;
  }
  function plateStage() {
    var xL = IO[0], xR = IO[1];
    var kf = kFast, ks = kSlow;
    PL[10] += (PL[11] - PL[10]) * kf;
    var b = PL[10];
    if (hold && PL[11] === 0 && b <= 0.001) { if (PL[20] === 0) { PL[20] = 1; PL[18] = 0; PL[19] = 0; } return; }
    PL[0] += (PL[1] - PL[0]) * kf;
    PL[2] += (PL[3] - PL[2]) * ks;
    PL[4] += (PL[5] - PL[4]) * kf;
    PL[6] += (PL[7] - PL[6]) * kf;
    PL[8] += (PL[9] - PL[8]) * kf;
    var tg = FC[1];
    var mono = 0.5 * (xL + xR) * tg;
    var preSamps = PL[0] * sr;
    var preOut;
    if (preSamps < 1) {
      var pn = PN[L_PRE], pi = (PW[L_PRE] - 1) % pn;
      if (pi < 0) pi += pn;
      preOut = mono * (1 - preSamps) + PB[L_PRE][pi] * preSamps;
    } else { S[0] = preSamps; readFrac(L_PRE); preOut = S[1]; }
    S[2] = mono;
    write(L_PRE);
    var bw = BW * preOut + (1 - BW) * PL[12];
    if (bw > -1e-15 && bw < 1e-15) bw = 0;
    PL[12] = bw;
    var scale = (0.5 + PL[2]) * (sr / FS);
    S[2] = bw;
    for (var i = 0; i < 4; i++) { S[3] = PLATE_IG[i]; S[0] = PLATE_PAPER[L_IN + i] * scale; lattice(L_IN + i); S[2] = S[1]; }
    var x = S[2];
    var decay = PL[4];
    if (decay < 0) decay = 0;
    if (decay > 1) decay = 1;
    var fb = decay > 0.97 ? 0.97 : decay;
    var g2 = decay + 0.15;
    if (g2 < 0.25) g2 = 0.25;
    if (g2 > 0.5) g2 = 0.5;
    var exc = 8 * (sr / FS);
    var phase = PL[17];
    var modL = PLATE_PAPER[L_AP1] * scale + exc * Math.sin(phase);
    var modR = PLATE_PAPER[L_AP1 + 1] * scale + exc * Math.cos(phase);
    if (modL < 1) modL = 1;
    if (modR < 1) modR = 1;
    S[4] = scale; S[5] = g2;
    var leftIn = x + fb * PL[16];
    if (leftIn > -1e-15 && leftIn < 1e-15) leftIn = 0;
    S[2] = leftIn; S[6] = modL;
    tank(0);
    var leftEnd = S[1];
    var rightIn = x + fb * leftEnd;
    if (rightIn > -1e-15 && rightIn < 1e-15) rightIn = 0;
    S[2] = rightIn; S[6] = modR;
    tank(1);
    var rightEnd = S[1];
    PL[15] = leftEnd;
    PL[16] = rightEnd;
    phase += TWOPI / sr;
    if (phase >= TWOPI) phase -= TWOPI;
    PL[17] = phase;
    // Same taps, same order of additions as ncPlateStep.
    var acc;
    S[0] = 266 * scale; readFrac(L_D1 + 1); acc = S[1];
    S[0] = 2974 * scale; readFrac(L_D1 + 1); acc = acc + S[1];
    S[0] = 1913 * scale; readFrac(L_AP2 + 1); acc = acc - S[1];
    S[0] = 1996 * scale; readFrac(L_D2 + 1); acc = acc + S[1];
    S[0] = 1990 * scale; readFrac(L_D1); acc = acc - S[1];
    S[0] = 187 * scale; readFrac(L_AP2); acc = acc - S[1];
    S[0] = 1066 * scale; readFrac(L_D2); acc = acc - S[1];
    var yl = 0.6 * acc;
    S[0] = 353 * scale; readFrac(L_D1); acc = S[1];
    S[0] = 3627 * scale; readFrac(L_D1); acc = acc + S[1];
    S[0] = 1228 * scale; readFrac(L_AP2); acc = acc - S[1];
    S[0] = 2673 * scale; readFrac(L_D2); acc = acc + S[1];
    S[0] = 2111 * scale; readFrac(L_D1 + 1); acc = acc - S[1];
    S[0] = 335 * scale; readFrac(L_AP2 + 1); acc = acc - S[1];
    S[0] = 121 * scale; readFrac(L_D2 + 1); acc = acc - S[1];
    var yr = 0.6 * acc * tg;
    yl *= tg;
    var m = PL[8];
    var dg = Math.cos(m * HALFPI), wg = Math.sin(m * HALFPI);
    var oL = dg * xL + wg * yl, oR = dg * xR + wg * yr;
    if (b >= 0.999) { IO[0] = oL; IO[1] = oR; return; }
    if (b <= 0.001) return;
    var dryG = Math.cos(b * HALFPI), wetG = Math.sin(b * HALFPI);
    IO[0] = dryG * xL + wetG * oL;
    IO[1] = dryG * xR + wetG * oR;
  }
  function limitStage() {
    var xL = IO[0] * preGain, xR = IO[1] * preGain;
    if (limMode === 0) { IO[0] = xL; IO[1] = xR; return; }
    if (limMode === 2) {
      // Zero-latency soft clip to the ceiling: c * tanh(x / c), antialiased like the drive.
      var u = xL / CEILING, ab = u < 0 ? -u : u, f = ab + Math.log(1 + Math.exp(-2 * ab)) - 0.6931471805599453, d = u - LM[4];
      IO[0] = CEILING * ((d > 1e-5 || d < -1e-5) ? (f - LM[6]) / d : Math.tanh(0.5 * (u + LM[4])));
      LM[4] = u; LM[6] = f;
      u = xR / CEILING; ab = u < 0 ? -u : u; f = ab + Math.log(1 + Math.exp(-2 * ab)) - 0.6931471805599453; d = u - LM[5];
      IO[1] = CEILING * ((d > 1e-5 || d < -1e-5) ? (f - LM[7]) / d : Math.tanh(0.5 * (u + LM[5])));
      LM[5] = u; LM[7] = f;
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

  function render(inL, inR, outL, outR, from, to) {
    var pL = T[2], pR = T[3];
    for (var i = from; i < to; i++) {
      var xL = inL ? inL[i] : 0;
      var xR = inR ? inR[i] : xL;
      if (xL !== xL || xL === Infinity || xL === -Infinity) xL = 0;
      if (xR !== xR || xR === Infinity || xR === -Infinity) xR = 0;
      IO[0] = xL; IO[1] = xR;
      var ph = FC[0];
      if (ph === 1) { var g = FC[1] - FC[2]; if (g <= 0) { g = 0; FC[0] = 2; FC[3] = 0; FC[4] = 0; FC[5] = 0; } FC[1] = g; }
      else if (ph === 3) { g = FC[1] + FC[2]; if (g >= 1) { g = 1; FC[0] = 0; } FC[1] = g; }
      driveStage();
      delayStage();
      plateStage();
      limitStage();
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
    latencySamples: limMode === 1 ? la : 0,
    /** Post-chain block peaks [L, R], refreshed by every process() call. */
    peak: peak,
    /** Lowest limiter gain since the last read of `takeGainReduction()`. */
    takeGainReduction: function () { var lo = LM[2]; LM[2] = 1; return lo; },
    /**
     * Set one parameter (DSP units, FX_PARAM index) at an absolute frame (omitted/past = now). snap = no smoothing.
     * Returns false when the frame is more than 600 s ahead (refused: a time on the wrong clock).
     */
    set: function (index, value, frame, snap) { return schedule(index | 0, value, frame, snap ? 1 : 0); },
    get: function (index) { return PRM[index | 0]; },
    /** Copy a whole program (Float64Array or array of FX_NPARAMS DSP values) in at a frame. Unchanged values are skipped unless snap. */
    load: function (program, frame, snap) {
      for (var i = 0; i < FX_NPARAMS && i < program.length; i++) schedule(i, program[i], frame, snap ? 1 : 2);
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
    process: function (inL, inR, outL, outR, frames, blockFrame) {
      var start = blockFrame === undefined || blockFrame === null ? T[1] : +blockFrame;
      T[2] = 0; T[3] = 0;
      admit(); // keeps admit() hot (optimised) even when events are rare; the slot is normally empty
      var i = 0;
      while (i < frames) {
        T[4] = start + i;
        due();
        var end = frames;
        if (EN[0] > 0) {
          var next = EF[0] - start;
          if (next < end) end = next > i ? next : i + 1;
        }
        render(inL, inR, outL, outR, i, end);
        i = end;
      }
      T[1] = start + frames;
      peak[0] = T[2]; peak[1] = T[3];
      settleAll();
      if (DL[11] === 1 || PL[20] === 1) clearSome();
      if (FC[0] === 2) fadeClearSome();
    }
  };
  return api;
}
