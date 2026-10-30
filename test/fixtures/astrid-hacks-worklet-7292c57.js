var FS=29761,PI=3.141592653589793,HALFPI=1.5707963267948966,TWOPI=6.283185307179586,Q=0.7071067811865476,CEILING=0.8912509381337456,MASTER=0.8,BW=0.9995;
var NC_NONE=[];
var NC_IO=new Float64Array(2);
function ncFlush(x) {
    return (x > -1e-15 && x < 1e-15) ? 0 : x;
  }
function ncCutoffHz(v) {
    return v <= 0 ? 0 : Math.round(20000 * Math.pow(150 / 20000, v / 100));
  }
function ncCoef(seconds, sr) {
    return 1 - Math.exp(-1 / (seconds * sr));
  }
function ncLine(paper, sr) {
    var kMax = (sr / FS) * 1.5;
    var n = Math.ceil(paper * kMax + 8 * (sr / FS) + 16);
    if (n < 16) n = 16;
    return { buf: new Float32Array(n), w: 0, n: n, paper: paper };
  }
function ncIdx(w, n, ago) {
    var i = (w - ago) % n;
    if (i < 0) i += n;
    return i;
  }
function ncReadFrac(line, ago) {
    if (ago < 1) ago = 1;
    var max = line.n - 2;
    if (ago > max) ago = max;
    var i0 = Math.floor(ago);
    var f = ago - i0;
    var a = ncIdx(line.w, line.n, i0);
    var b = a === 0 ? line.n - 1 : a - 1;
    return line.buf[a] * (1 - f) + line.buf[b] * f;
  }
function ncWrite(line, x) {
    line.buf[line.w] = x;
    var w = line.w + 1;
    line.w = w >= line.n ? 0 : w;
  }
function ncLattice(line, x, g, len) {
    var d = ncReadFrac(line, len);
    var v = ncFlush(x - g * d);
    var y = ncFlush(g * v + d);
    ncWrite(line, v);
    return y;
  }
function ncZeroLine(line) {
    line.buf.fill(0);
    line.w = 0;
  }
function ncLowpassCreate(sr) {
    return {
      type: 'lowpass', sr: sr,
      z1L: 0, z2L: 0, z1R: 0, z2R: 0,
      b0: 1, b1: 0, b2: 0, a1: 0, a2: 0,
      openS: 1, openT: 1, logS: 6.907755278982137, logT: 6.907755278982137,
      cutoffT: 0, bypass: 1, bypassT: 1,
      kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function ncLowpassCoeffs(st, hz) {
    var w0 = TWOPI * hz / st.sr;
    var c = Math.cos(w0);
    var s = Math.sin(w0);
    var alpha = s / (2 * Q);
    var b0 = (1 - c) * 0.5;
    var b1 = 1 - c;
    var a0 = 1 + alpha;
    st.b0 = b0 / a0;
    st.b1 = b1 / a0;
    st.b2 = b0 / a0;
    st.a1 = (-2 * c) / a0;
    st.a2 = (1 - alpha) / a0;
  }
function ncLowpassApply(st, p, snap) {
    var c = p.cutoff == null ? st.cutoffT : +p.cutoff;
    if (!(c > 0)) c = 0;
    if (c > 100) c = 100;
    st.cutoffT = c;
    if (c <= 0) st.openT = 1;
    else {
      st.openT = 0;
      var hz = p.cutoff_hz;
      if (!(hz > 0)) hz = ncCutoffHz(c);
      var ny = st.sr * 0.49;
      if (hz > ny) hz = ny;
      if (hz < 20) hz = 20;
      st.logT = Math.log(hz);
    }
    if (snap) { st.openS = st.openT; st.logS = st.logT; }
  }
function ncApplyGlide(st) {
    var a = st.auto;
    if (!a || !(a.from > 0) || !(a.to > 0)) return;
    var param = st.type === 'bandpass' ? 'centre_hz' : 'cutoff_hz';
    if (a.param !== param) return;
    var u = st.pos || 0;
    if (u < 0) u = 0;
    if (u > 1) u = 1;
    var hz = Math.exp(Math.log(a.from) + (Math.log(a.to) - Math.log(a.from)) * u);
    var ny = st.sr * 0.49;
    if (hz > ny) hz = ny;
    if (hz < 20) hz = 20;
    st.logT = Math.log(hz);
    st.openT = 0;
  }
function ncStamp(chain, order) {
    var pos = chain.pos || 0;
    if (pos < 0) pos = 0;
    if (pos > 1) pos = 1;
    var m, st;
    for (m = 0; m < order.length; m++) {
      st = chain.box[order[m]];
      if (st) st.pos = pos;
    }
    if (chain.step) {
      pos += chain.step;
      if (pos > 1) pos = 1;
      chain.pos = pos;
    }
  }
function ncLowpassStep(st, io, out) {
    var xL = io[0], xR = io[1];
    if (st.auto) ncApplyGlide(st);
    var k = st.immediate ? 1 : st.kFast;
    st.openS += (st.openT - st.openS) * k;
    st.logS += (st.logT - st.logS) * k;
    if (st.openS > 0.9999 && st.openT > 0.5) {
      st.z1L = 0; st.z2L = 0; st.z1R = 0; st.z2R = 0;
      out[0] = xL; out[1] = xR;
      return;
    }
    var hz = Math.exp(st.logS);
    ncLowpassCoeffs(st, hz);
    var yL = st.b0 * xL + st.z1L;
    st.z1L = ncFlush(st.b1 * xL - st.a1 * yL + st.z2L);
    st.z2L = ncFlush(st.b2 * xL - st.a2 * yL);
    var yR = st.b0 * xR + st.z1R;
    st.z1R = ncFlush(st.b1 * xR - st.a1 * yR + st.z2R);
    st.z2R = ncFlush(st.b2 * xR - st.a2 * yR);
    var o = st.openS;
    out[0] = o * xL + (1 - o) * yL;
    out[1] = o * xR + (1 - o) * yR;
  }
function ncDelayCreate(sr) {
    var n = Math.ceil(4.9 * sr) + 8;
    return {
      type: 'delay', sr: sr, n: n, w: 0,
      bufL: new Float32Array(n), bufR: new Float32Array(n),
      dlyS: 0.75 * sr, dlyT: 0.75 * sr, fbS: 0.35, fbT: 0.35, wetS: 0, wetT: 0,
      bypass: 1, bypassT: 1, kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function ncDelayApply(st, p, snap) {
    var s = p.delay_s == null ? st.dlyT / st.sr : +p.delay_s;
    if (!(s > 0)) s = 0;
    if (s > 4.9) s = 4.9;
    var samples = s * st.sr;
    if (samples < 1) samples = 1;
    var max = st.n - 4;
    if (samples > max) samples = max;
    st.dlyT = samples;
    var fb = p.feedback == null ? st.fbT : +p.feedback;
    if (!(fb > 0)) fb = 0;
    if (fb > 0.9) fb = 0.9;
    st.fbT = fb;
    var wet = p.wet == null ? st.wetT : +p.wet;
    if (!(wet > 0)) wet = 0;
    if (wet > 1) wet = 1;
    st.wetT = wet;
    if (snap) { st.dlyS = st.dlyT; st.fbS = st.fbT; st.wetS = st.wetT; }
  }
function ncDelayStep(st, io, out) {
    var xL = io[0], xR = io[1];
    var kf = st.immediate ? 1 : st.kFast;
    var ks = st.immediate ? 1 : st.kSlow;
    st.dlyS += (st.dlyT - st.dlyS) * ks;
    st.fbS += (st.fbT - st.fbS) * kf;
    st.wetS += (st.wetT - st.wetS) * kf;
    var ago = st.dlyS;
    var i0 = Math.floor(ago);
    var f = ago - i0;
    if (i0 < 1) { i0 = 1; f = 0; }
    var max = st.n - 3;
    if (i0 > max) { i0 = max; f = 0; }
    var aL = ncIdx(st.w, st.n, i0);
    var bL = aL === 0 ? st.n - 1 : aL - 1;
    var dL = st.bufL[aL] * (1 - f) + st.bufL[bL] * f;
    var dR = st.bufR[aL] * (1 - f) + st.bufR[bL] * f;
    var fb = st.fbS;
    st.bufL[st.w] = ncFlush(xL + fb * dL);
    st.bufR[st.w] = ncFlush(xR + fb * dR);
    var w = st.w + 1;
    st.w = w >= st.n ? 0 : w;
    var wet = st.wetS;
    var dryG = Math.cos(wet * HALFPI);
    var wetG = Math.sin(wet * HALFPI);
    out[0] = dryG * xL + wetG * dL;
    out[1] = dryG * xR + wetG * dR;
  }
function ncDiff2(decay) {
    var g = decay + 0.15;
    if (g < 0.25) g = 0.25;
    if (g > 0.5) g = 0.5;
    return g;
  }
function ncPlateCreate(sr) {
    var preN = Math.ceil(0.2 * sr) + 8;
    return {
      type: 'plate', sr: sr,
      pre: { buf: new Float32Array(preN), w: 0, n: preN, paper: 0 },
      bw: 0,
      inAp: [ncLine(142, sr), ncLine(107, sr), ncLine(379, sr), ncLine(277, sr)],
      ap1: [ncLine(672, sr), ncLine(908, sr)],
      d1: [ncLine(4453, sr), ncLine(4217, sr)],
      ap2: [ncLine(1800, sr), ncLine(2656, sr)],
      d2: [ncLine(3720, sr), ncLine(3163, sr)],
      damp: [0, 0], leftEnd: 0, rightEnd: 0, phase: 0,
      preS: 0, preT: 0, sizeS: 0.5, sizeT: 0.5, decayS: 0.5, decayT: 0.5,
      dampS: 0, dampT: 0, mixS: 0, mixT: 0,
      bypass: 1, bypassT: 1, kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function ncPlateApply(st, p, snap) {
    function clamp(v, d, lo, hi) {
      var x = v == null ? d : +v;
      if (x !== x) x = d;
      if (x < lo) x = lo;
      if (x > hi) x = hi;
      return x;
    }
    st.preT = clamp(p.predelay, st.preT, 0, 0.2);
    st.sizeT = clamp(p.size, st.sizeT, 0, 1);
    st.decayT = clamp(p.decay, st.decayT, 0, 1);
    st.dampT = clamp(p.damping, st.dampT, 0, 1);
    st.mixT = clamp(p.mix, st.mixT, 0, 1);
    if (snap) {
      st.preS = st.preT; st.sizeS = st.sizeT; st.decayS = st.decayT;
      st.dampS = st.dampT; st.mixS = st.mixT;
    }
  }
function ncTank(st, side, x, modLen, scale, g2) {
    x = ncLattice(st.ap1[side], x, -0.7, modLen);
    var d1 = st.d1[side];
    var d = ncReadFrac(d1, d1.paper * scale);
    ncWrite(d1, x);
    var dmp = st.dampS;
    var y = ncFlush((1 - dmp) * d + dmp * st.damp[side]);
    st.damp[side] = y;
    x = ncLattice(st.ap2[side], y, g2, st.ap2[side].paper * scale);
    var d2 = st.d2[side];
    d = ncReadFrac(d2, d2.paper * scale);
    ncWrite(d2, x);
    return d;
  }
function ncPlateStep(st, io, out) {
    var xL = io[0], xR = io[1];
    var kf = st.immediate ? 1 : st.kFast;
    var ks = st.immediate ? 1 : st.kSlow;
    st.preS += (st.preT - st.preS) * kf;
    st.sizeS += (st.sizeT - st.sizeS) * ks;
    st.decayS += (st.decayT - st.decayS) * kf;
    st.dampS += (st.dampT - st.dampS) * kf;
    st.mixS += (st.mixT - st.mixS) * kf;
    var L, LL, D, ago, i0, f, a, b, n, w, d, v, y, tx, dmp, t1, t2, t3, t4, t5, t6, t7;
    var mono = 0.5 * (xL + xR);
    var preSamps = st.preS * st.sr;
    var preOut;
    if (preSamps < 1) {
      L = st.pre; a = (L.w - 1) % L.n; if (a < 0) a += L.n;
      preOut = mono * (1 - preSamps) + L.buf[a] * preSamps;
    } else {
    L = st.pre; ago = preSamps; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    preOut = L.buf[a] * (1 - f) + L.buf[b] * f;
    }
    L = st.pre; L.buf[L.w] = mono; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    y = BW * preOut + (1 - BW) * st.bw; if (y > -1e-15 && y < 1e-15) y = 0;
    st.bw = y;
    var size = st.sizeS;
    var scale = (0.5 + size) * (st.sr / FS);
    var x = st.bw;
    LL = st.inAp[0];
    L = LL; ago = st.inAp[0].paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    v = x - 0.75 * d; if (v > -1e-15 && v < 1e-15) v = 0;
    y = 0.75 * v + d; if (y > -1e-15 && y < 1e-15) y = 0;
    L = LL; L.buf[L.w] = v; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    x = y;
    LL = st.inAp[1];
    L = LL; ago = st.inAp[1].paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    v = x - 0.75 * d; if (v > -1e-15 && v < 1e-15) v = 0;
    y = 0.75 * v + d; if (y > -1e-15 && y < 1e-15) y = 0;
    L = LL; L.buf[L.w] = v; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    x = y;
    LL = st.inAp[2];
    L = LL; ago = st.inAp[2].paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    v = x - 0.625 * d; if (v > -1e-15 && v < 1e-15) v = 0;
    y = 0.625 * v + d; if (y > -1e-15 && y < 1e-15) y = 0;
    L = LL; L.buf[L.w] = v; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    x = y;
    LL = st.inAp[3];
    L = LL; ago = st.inAp[3].paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    v = x - 0.625 * d; if (v > -1e-15 && v < 1e-15) v = 0;
    y = 0.625 * v + d; if (y > -1e-15 && y < 1e-15) y = 0;
    L = LL; L.buf[L.w] = v; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    x = y;
    var decay = st.decayS;
    if (decay < 0) decay = 0;
    if (decay > 1) decay = 1;
    var fb = decay > 0.97 ? 0.97 : decay;
    var g2 = decay + 0.15; if (g2 < 0.25) g2 = 0.25; if (g2 > 0.5) g2 = 0.5;
    var exc = 8 * (st.sr / FS);
    var modL = st.ap1[0].paper * scale + exc * Math.sin(st.phase);
    var modR = st.ap1[1].paper * scale + exc * Math.cos(st.phase);
    if (modL < 1) modL = 1;
    if (modR < 1) modR = 1;
    var leftIn, leftEnd, rightIn, rightEnd;
    leftIn = x + fb * st.rightEnd; if (leftIn > -1e-15 && leftIn < 1e-15) leftIn = 0;
    LL = st.ap1[0];
    L = LL; ago = modL; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    v = leftIn - -0.7 * d; if (v > -1e-15 && v < 1e-15) v = 0;
    y = -0.7 * v + d; if (y > -1e-15 && y < 1e-15) y = 0;
    L = LL; L.buf[L.w] = v; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    tx = y;
    D = st.d1[0];
    L = D; ago = D.paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = D; L.buf[L.w] = tx; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    dmp = st.dampS;
    y = (1 - dmp) * d + dmp * st.damp[0]; if (y > -1e-15 && y < 1e-15) y = 0;
    st.damp[0] = y;
    LL = st.ap2[0];
    L = LL; ago = st.ap2[0].paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    v = y - g2 * d; if (v > -1e-15 && v < 1e-15) v = 0;
    y = g2 * v + d; if (y > -1e-15 && y < 1e-15) y = 0;
    L = LL; L.buf[L.w] = v; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    tx = y;
    D = st.d2[0];
    L = D; ago = D.paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = D; L.buf[L.w] = tx; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    leftEnd = d;
    rightIn = x + fb * leftEnd; if (rightIn > -1e-15 && rightIn < 1e-15) rightIn = 0;
    LL = st.ap1[1];
    L = LL; ago = modR; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    v = rightIn - -0.7 * d; if (v > -1e-15 && v < 1e-15) v = 0;
    y = -0.7 * v + d; if (y > -1e-15 && y < 1e-15) y = 0;
    L = LL; L.buf[L.w] = v; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    tx = y;
    D = st.d1[1];
    L = D; ago = D.paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = D; L.buf[L.w] = tx; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    dmp = st.dampS;
    y = (1 - dmp) * d + dmp * st.damp[1]; if (y > -1e-15 && y < 1e-15) y = 0;
    st.damp[1] = y;
    LL = st.ap2[1];
    L = LL; ago = st.ap2[1].paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    v = y - g2 * d; if (v > -1e-15 && v < 1e-15) v = 0;
    y = g2 * v + d; if (y > -1e-15 && y < 1e-15) y = 0;
    L = LL; L.buf[L.w] = v; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    tx = y;
    D = st.d2[1];
    L = D; ago = D.paper * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    d = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = D; L.buf[L.w] = tx; w = L.w + 1; L.w = w >= L.n ? 0 : w;
    rightEnd = d;
    st.leftEnd = leftEnd;
    st.rightEnd = rightEnd;
    st.phase += TWOPI / st.sr;
    if (st.phase >= TWOPI) st.phase -= TWOPI;
    L = st.d1[1]; ago = 266 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t1 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.d1[1]; ago = 2974 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t2 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.ap2[1]; ago = 1913 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t3 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.d2[1]; ago = 1996 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t4 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.d1[0]; ago = 1990 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t5 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.ap2[0]; ago = 187 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t6 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.d2[0]; ago = 1066 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t7 = L.buf[a] * (1 - f) + L.buf[b] * f;
    var yl = 0.6 * (t1 + t2 - t3 + t4 - t5 - t6 - t7);
    L = st.d1[0]; ago = 353 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t1 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.d1[0]; ago = 3627 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t2 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.ap2[0]; ago = 1228 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t3 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.d2[0]; ago = 2673 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t4 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.d1[1]; ago = 2111 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t5 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.ap2[1]; ago = 335 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t6 = L.buf[a] * (1 - f) + L.buf[b] * f;
    L = st.d2[1]; ago = 121 * scale; if (ago < 1) ago = 1; n = L.n; if (ago > n - 2) ago = n - 2;
    i0 = Math.floor(ago); f = ago - i0; a = (L.w - i0) % n; if (a < 0) a += n; b = a === 0 ? n - 1 : a - 1;
    t7 = L.buf[a] * (1 - f) + L.buf[b] * f;
    var yr = 0.6 * (t1 + t2 - t3 + t4 - t5 - t6 - t7);
    var m = st.mixS;
    var dryG = Math.cos(m * HALFPI);
    var wetG = Math.sin(m * HALFPI);
    out[0] = dryG * xL + wetG * yl;
    out[1] = dryG * xR + wetG * yr;
  }
function ncBiquad() { return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, z1L: 0, z2L: 0, z1R: 0, z2R: 0 }; }
function ncBiquadSet(f, kind, hz, db, q, sr) {
    var A = Math.pow(10, db / 40);
    var w0 = 6.283185307179586 * hz / sr;
    var c = Math.cos(w0), s = Math.sin(w0);
    var b0, b1, b2, a0, a1, a2, alpha;
    if (kind === 0) {
      alpha = s / 2 * Math.SQRT2;
      var sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * c + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * c);
      b2 = A * ((A + 1) - (A - 1) * c - sq);
      a0 = (A + 1) + (A - 1) * c + sq;
      a1 = -2 * ((A - 1) + (A + 1) * c);
      a2 = (A + 1) + (A - 1) * c - sq;
    } else if (kind === 2) {
      alpha = s / 2 * Math.SQRT2;
      var sq2 = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * c + sq2);
      b1 = -2 * A * ((A - 1) + (A + 1) * c);
      b2 = A * ((A + 1) + (A - 1) * c - sq2);
      a0 = (A + 1) - (A - 1) * c + sq2;
      a1 = 2 * ((A - 1) - (A + 1) * c);
      a2 = (A + 1) - (A - 1) * c - sq2;
    } else {
      alpha = s / (2 * q);
      b0 = 1 + alpha * A;
      b1 = -2 * c;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * c;
      a2 = 1 - alpha / A;
    }
    f.b0 = b0 / a0; f.b1 = b1 / a0; f.b2 = b2 / a0; f.a1 = a1 / a0; f.a2 = a2 / a0;
  }
function ncBiquadStep(f, io, out) {
    var xL = io[0], xR = io[1];
    var yL = f.b0 * xL + f.z1L;
    f.z1L = ncFlush(f.b1 * xL - f.a1 * yL + f.z2L);
    f.z2L = ncFlush(f.b2 * xL - f.a2 * yL);
    var yR = f.b0 * xR + f.z1R;
    f.z1R = ncFlush(f.b1 * xR - f.a1 * yR + f.z2R);
    f.z2R = ncFlush(f.b2 * xR - f.a2 * yR);
    out[0] = yL; out[1] = yR;
  }
function ncEqCreate(sr) {
    return {
      type: 'eq', sr: sr, f: [ncBiquad(), ncBiquad(), ncBiquad()],
      lowS: 0, lowT: 0, midS: 0, midT: 0, hiS: 0, hiT: 0, logHzS: 6.907755278982137, logHzT: 6.907755278982137,
      lowHz: 250, highHz: 4000, midQ: 0.9, range: 12,
      flat: true, dirty: true, tick: 0,
      bypass: 1, bypassT: 1, kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function ncEqApply(st, p, snap) {
    function clamp(v, d, lo, hi) {
      var x = v == null ? d : +v;
      if (x !== x) x = d;
      return x < lo ? lo : x > hi ? hi : x;
    }
    var v2 = p.low_hz != null || p.high_hz != null || p.mid_q != null;
    if (v2) st.range = 18;
    if (p.low_hz != null) st.lowHz = clamp(p.low_hz, st.lowHz, 40, 400);
    if (p.high_hz != null) st.highHz = clamp(p.high_hz, st.highHz, 2000, 12000);
    if (p.mid_q != null) st.midQ = clamp(p.mid_q, st.midQ, 0.3, 6);
    var r = st.range;
    st.lowT = clamp(p.low_db, st.lowT, -r, r);
    st.midT = clamp(p.mid_db, st.midT, -r, r);
    st.hiT = clamp(p.high_db, st.hiT, -r, r);
    var hz = clamp(p.mid_hz, Math.exp(st.logHzT), 200, 5000);
    st.logHzT = Math.log(hz);
    st.dirty = true;
    if (snap) { st.lowS = st.lowT; st.midS = st.midT; st.hiS = st.hiT; st.logHzS = st.logHzT; }
  }
function ncEqStep(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    var moving = st.lowS !== st.lowT || st.midS !== st.midT || st.hiS !== st.hiT || st.logHzS !== st.logHzT;
    if (moving) {
      st.lowS += (st.lowT - st.lowS) * k;
      st.midS += (st.midT - st.midS) * k;
      st.hiS += (st.hiT - st.hiS) * k;
      st.logHzS += (st.logHzT - st.logHzS) * k;
      if (Math.abs(st.lowT - st.lowS) < 1e-4) st.lowS = st.lowT;
      if (Math.abs(st.midT - st.midS) < 1e-4) st.midS = st.midT;
      if (Math.abs(st.hiT - st.hiS) < 1e-4) st.hiS = st.hiT;
      if (Math.abs(st.logHzT - st.logHzS) < 1e-5) st.logHzS = st.logHzT;
    }
    var flat = st.lowS === 0 && st.midS === 0 && st.hiS === 0;
    if (flat) {
      if (!st.flat) { ncEqClear(st); st.flat = true; }
      out[0] = xL; out[1] = xR;
      return;
    }
    if (st.flat) { st.flat = false; st.dirty = true; st.tick = 0; }
    // Coefficients follow moving dials every 16 samples, then once more when they settle.
    var redo = false;
    if (moving) { st.dirty = true; redo = (st.tick++ & 15) === 0; }
    else if (st.dirty) { redo = true; st.dirty = false; st.tick = 0; }
    if (redo) {
      ncBiquadSet(st.f[0], 0, st.lowHz, st.lowS, 0.7071, st.sr);
      ncBiquadSet(st.f[1], 1, Math.exp(st.logHzS), st.midS, st.midQ, st.sr);
      ncBiquadSet(st.f[2], 2, st.highHz, st.hiS, 0.7071, st.sr);
    }
    (NC_IO[0] = xL, NC_IO[1] = xR, ncBiquadStep(st.f[0], NC_IO, out));
    (NC_IO[0] = out[0], NC_IO[1] = out[1], ncBiquadStep(st.f[1], NC_IO, out));
    (NC_IO[0] = out[0], NC_IO[1] = out[1], ncBiquadStep(st.f[2], NC_IO, out));
  }
function ncEqClear(st) {
    var i;
    for (i = 0; i < 3; i++) { st.f[i].z1L = 0; st.f[i].z2L = 0; st.f[i].z1R = 0; st.f[i].z2R = 0; }
  }
function ncPassSet(f, kind, hz, q, sr) {
    var w0 = 6.283185307179586 * hz / sr;
    var c = Math.cos(w0), s = Math.sin(w0);
    var alpha = s / (2 * q), a0 = 1 + alpha;
    if (kind === 'hp') {
      f.b0 = (1 + c) * 0.5 / a0; f.b1 = -(1 + c) / a0; f.b2 = (1 + c) * 0.5 / a0;
    } else {
      f.b0 = alpha / a0; f.b1 = 0; f.b2 = -alpha / a0;
    }
    f.a1 = -2 * c / a0; f.a2 = (1 - alpha) / a0;
  }
function ncPassCreate(type, sr) {
    var hp = type === 'highpass';
    return {
      type: type, sr: sr, f: ncBiquad(), tick: 0, dirty: true,
      openS: hp ? 1 : 0, openT: hp ? 1 : 0,
      logS: hp ? 2.995732273553991 : 6.907755278982137, logT: hp ? 2.995732273553991 : 6.907755278982137,
      qS: hp ? 0.7071 : 0.7, qT: hp ? 0.7071 : 0.7, mixS: 1, mixT: 1,
      bypass: 1, bypassT: 1, kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function ncPassApply(st, p, snap) {
    function clamp(v, d, lo, hi) {
      var x = v == null ? d : +v;
      if (x !== x) x = d;
      return x < lo ? lo : x > hi ? hi : x;
    }
    var ny = st.sr * 0.45;
    if (st.type === 'highpass') {
      var c = clamp(p.cutoff, st.openT ? 0 : 1, 0, 100);
      st.openT = c <= 0 ? 1 : 0;
      if (c > 0) {
        var hz = clamp(p.cutoff_hz, 20 * Math.pow(100, c / 100), 20, 2000);
        st.logT = Math.log(hz > ny ? ny : hz);
      }
      st.qT = clamp(p.q, st.qT, 0.5, 8);
    } else {
      var hz2 = clamp(p.centre_hz, Math.exp(st.logT), 100, 8000);
      st.logT = Math.log(hz2 > ny ? ny : hz2);
      st.qT = clamp(p.q, st.qT, 0.4, 8);
      st.mixT = clamp(p.mix, st.mixT, 0, 1);
    }
    st.dirty = true;
    if (snap) { st.openS = st.openT; st.logS = st.logT; st.qS = st.qT; st.mixS = st.mixT; }
  }
function ncPassStep(st, io, out) {
    var xL = io[0], xR = io[1];
    if (st.auto) ncApplyGlide(st);
    var k = st.immediate ? 1 : st.kFast;
    var moving = st.openS !== st.openT || st.logS !== st.logT || st.qS !== st.qT || st.mixS !== st.mixT;
    if (moving) {
      st.openS += (st.openT - st.openS) * k;
      st.logS += (st.logT - st.logS) * k;
      st.qS += (st.qT - st.qS) * k;
      st.mixS += (st.mixT - st.mixS) * k;
      if (Math.abs(st.openT - st.openS) < 1e-4) st.openS = st.openT;
      if (Math.abs(st.logT - st.logS) < 1e-5) st.logS = st.logT;
      if (Math.abs(st.qT - st.qS) < 1e-5) st.qS = st.qT;
      if (Math.abs(st.mixT - st.mixS) < 1e-6) st.mixS = st.mixT;
    }
    if (st.openS === 1) {
      var f0 = st.f;
      f0.z1L = 0; f0.z2L = 0; f0.z1R = 0; f0.z2R = 0;
      st.dirty = true;
      out[0] = xL; out[1] = xR;
      return;
    }
    var redo = false;
    if (moving) { st.dirty = true; redo = (st.tick++ & 15) === 0; }
    else if (st.dirty) { redo = true; st.dirty = false; st.tick = 0; }
    if (redo) ncPassSet(st.f, st.type === 'highpass' ? 'hp' : 'bp', Math.exp(st.logS), st.qS, st.sr);
    (NC_IO[0] = xL, NC_IO[1] = xR, ncBiquadStep(st.f, NC_IO, out));
    var o = st.type === 'highpass' ? st.openS : 1 - st.mixS;
    if (o > 0) {
      out[0] = o * xL + (1 - o) * out[0];
      out[1] = o * xR + (1 - o) * out[1];
    }
  }
function ncLogCosh(u) {
    var a = u < 0 ? -u : u;
    return a + Math.log(1 + Math.exp(-2 * a)) - 0.6931471805599453;
  }
function ncTanhAdaa(st, ch, u) {
    var f = ncLogCosh(u);
    var d = u - st.u[ch];
    var y = (d > 1e-5 || d < -1e-5) ? (f - st.f[ch]) / d : Math.tanh(0.5 * (u + st.u[ch]));
    st.u[ch] = u;
    st.f[ch] = f;
    return y;
  }
function ncDriveCreate(sr) {
    return {
      type: 'drive', sr: sr, u: [0, 0], f: [0, 0],
      driveS: 0, driveT: 0, outS: 0, outT: 0, mixS: 1, mixT: 1,
      bypass: 1, bypassT: 1, kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function ncDriveApply(st, p, snap) {
    function clamp(v, d, lo, hi) {
      var x = v == null ? d : +v;
      if (x !== x) x = d;
      return x < lo ? lo : x > hi ? hi : x;
    }
    st.driveT = clamp(p.drive_db, st.driveT, 0, 24);
    st.outT = clamp(p.output_db, st.outT, -12, 12);
    st.mixT = clamp(p.mix, st.mixT, 0, 1);
    if (snap) { st.driveS = st.driveT; st.outS = st.outT; st.mixS = st.mixT; }
  }
function ncDriveStep(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.driveS += (st.driveT - st.driveS) * k;
    st.outS += (st.outT - st.outS) * k;
    st.mixS += (st.mixT - st.mixS) * k;
    if (Math.abs(st.driveT - st.driveS) < 1e-5) st.driveS = st.driveT;
    if (Math.abs(st.outT - st.outS) < 1e-5) st.outS = st.outT;
    if (Math.abs(st.mixT - st.mixS) < 1e-6) st.mixS = st.mixT;
    var trim = st.outS === 0 ? 1 : Math.pow(10, st.outS / 20);
    if (st.driveS === 0) {
      st.u[0] = 0; st.u[1] = 0; st.f[0] = 0; st.f[1] = 0;
      out[0] = xL * trim; out[1] = xR * trim;
      return;
    }
    var g = Math.pow(10, st.driveS / 20) - 1;
    // tanh(g x) * r / tanh(g r) keeps a −12 dBFS (r = 0.25) level where it was.
    var comp = 0.25 / Math.tanh(0.25 * g) / g;
    var a = ncTanhAdaa(st, 0, g * xL);
    var b = ncTanhAdaa(st, 1, g * xR);
    var m = st.mixS;
    out[0] = trim * ((1 - m) * xL + m * g * comp * a);
    out[1] = trim * ((1 - m) * xR + m * g * comp * b);
  }
function ncCompCreate(sr) {
    return {
      type: 'compressor', sr: sr, yl: 0, gr: 0,
      thrS: 0, thrT: 0, ratioS: 1, ratioT: 1, mkS: 0, mkT: 0, att: 10, rel: 150,
      aA: ncCoef(0.010, sr), aR: ncCoef(0.150, sr),
      bypass: 1, bypassT: 1, kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function ncCompApply(st, p, snap) {
    function clamp(v, d, lo, hi) {
      var x = v == null ? d : +v;
      if (x !== x) x = d;
      return x < lo ? lo : x > hi ? hi : x;
    }
    st.thrT = clamp(p.threshold_db, st.thrT, -60, 0);
    st.ratioT = clamp(p.ratio, st.ratioT, 1, 20);
    st.mkT = clamp(p.makeup_db, st.mkT, 0, 24);
    st.att = clamp(p.attack_ms, st.att, 0.1, 100);
    st.rel = clamp(p.release_ms, st.rel, 10, 1000);
    st.aA = ncCoef(st.att / 1000, st.sr);
    st.aR = ncCoef(st.rel / 1000, st.sr);
    if (snap) { st.thrS = st.thrT; st.ratioS = st.ratioT; st.mkS = st.mkT; }
  }
function ncCompStep(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.thrS += (st.thrT - st.thrS) * k;
    st.ratioS += (st.ratioT - st.ratioS) * k;
    st.mkS += (st.mkT - st.mkS) * k;
    if (Math.abs(st.ratioT - st.ratioS) < 1e-6) st.ratioS = st.ratioT;
    if (Math.abs(st.mkT - st.mkS) < 1e-6) st.mkS = st.mkT;
    if (Math.abs(st.thrT - st.thrS) < 1e-6) st.thrS = st.thrT;
    if (st.ratioS === 1 && st.mkS === 0 && st.yl === 0) { out[0] = xL; out[1] = xR; return; }
    var aL = xL < 0 ? -xL : xL, aR = xR < 0 ? -xR : xR;
    var peak = aL > aR ? aL : aR;
    var xg = peak > 1e-6 ? 8.685889638065035 * Math.log(peak) : -120;
    var T = st.thrS, R = st.ratioS, W = 6, over = xg - T, yg;
    if (2 * over < -W) yg = xg;
    else if (2 * over > W) yg = T + over / R;
    else { var t = over + W / 2; yg = xg + (1 / R - 1) * t * t / (2 * W); }
    var want = xg - yg;
    var yl = st.yl;
    yl += (want - yl) * (want > yl ? st.aA : st.aR);
    if (yl < 1e-9) yl = 0;
    st.yl = yl;
    st.gr = yl;
    var g = Math.exp((st.mkS - yl) * 0.11512925464970229);
    out[0] = xL * g; out[1] = xR * g;
  }
function ncWidthCreate(sr) {
    return {
      type: 'width', sr: sr, wS: 1, wT: 1, balS: 0, balT: 0,
      bypass: 1, bypassT: 1, kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function ncWidthApply(st, p, snap) {
    var w = p.width == null ? st.wT : +p.width;
    if (w !== w) w = st.wT;
    st.wT = w < 0 ? 0 : w > 2 ? 2 : w;
    var b = p.balance == null ? st.balT : +p.balance;
    if (b !== b) b = st.balT;
    st.balT = b < -1 ? -1 : b > 1 ? 1 : b;
    if (snap) { st.wS = st.wT; st.balS = st.balT; }
  }
function ncWidthStep(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.wS += (st.wT - st.wS) * k;
    st.balS += (st.balT - st.balS) * k;
    if (Math.abs(st.wT - st.wS) < 1e-6) st.wS = st.wT;
    if (Math.abs(st.balT - st.balS) < 1e-6) st.balS = st.balT;
    var yL = xL, yR = xR;
    if (st.wS !== 1) {
      var m = 0.5 * (xL + xR), s = 0.5 * (xL - xR) * st.wS;
      yL = m + s; yR = m - s;
    }
    var b = st.balS;
    if (b > 0) yL *= 1 - b;
    else if (b < 0) yR *= 1 + b;
    out[0] = yL; out[1] = yR;
  }
function ncLimiterCreate(sr) {
    var la = Math.round(0.0015 * sr);
    if (la < 1) la = 1;
    var gains = new Float32Array(la);
    var i;
    for (i = 0; i < la; i++) gains[i] = 1;
    return {
      la: la, w: 0, env: 1, lo: 1, ceiling: CEILING,
      rel: ncCoef(0.05, sr),
      bufL: new Float32Array(la), bufR: new Float32Array(la), gains: gains
    };
  }
function ncLimiterStep(lim, io, out) {
    var xL = io[0], xR = io[1];
    var aL = xL < 0 ? -xL : xL;
    var aR = xR < 0 ? -xR : xR;
    var peak = aR > aL ? aR : aL;
    var req = peak > lim.ceiling ? lim.ceiling / peak : 1;
    var w = lim.w;
    var dL = lim.bufL[w];
    var dR = lim.bufR[w];
    var gMin = req;
    var gains = lim.gains;
    var k, la = lim.la;
    for (k = 0; k < la; k++) if (gains[k] < gMin) gMin = gains[k];
    var env = lim.env;
    if (gMin < env) env = gMin;
    else env += (gMin - env) * lim.rel;
    lim.env = env;
    if (env < lim.lo) lim.lo = env;
    gains[w] = req;
    lim.bufL[w] = xL;
    lim.bufR[w] = xR;
    w++;
    lim.w = w >= la ? 0 : w;
    out[0] = dL * env;
    out[1] = dR * env;
  }
function ncVendorWidgetCreate(type, sr) {
    if (type === 'lowpass') return ncLowpassCreate(sr);
    if (type === 'delay') return ncDelayCreate(sr);
    if (type === 'plate') return ncPlateCreate(sr);
    if (type === 'eq') return ncEqCreate(sr);
    if (type === 'highpass' || type === 'bandpass') return ncPassCreate(type, sr);
    if (type === 'drive') return ncDriveCreate(sr);
    if (type === 'compressor') return ncCompCreate(sr);
    if (type === 'width') return ncWidthCreate(sr);
    return null;
  }
function ncVendorWidgetApply(st, p, snap, bypass, auto) {
    p = p || {};
    if (st.type === 'lowpass') ncLowpassApply(st, p, snap);
    else if (st.type === 'delay') ncDelayApply(st, p, snap);
    else if (st.type === 'plate') ncPlateApply(st, p, snap);
    else if (st.type === 'eq') ncEqApply(st, p, snap);
    else if (st.type === 'highpass' || st.type === 'bandpass') ncPassApply(st, p, snap);
    else if (st.type === 'drive') ncDriveApply(st, p, snap);
    else if (st.type === 'compressor') ncCompApply(st, p, snap);
    else if (st.type === 'width') ncWidthApply(st, p, snap);
    if (bypass != null) {
      st.bypassT = bypass ? 0 : 1;
      if (snap) st.bypass = st.bypassT;
    }
    if (auto !== undefined) st.auto = auto || null;
  }
function ncVendorClearState(st) {
    if (!st) return;
    if (st.type === 'lowpass') { st.z1L = 0; st.z2L = 0; st.z1R = 0; st.z2R = 0; return; }
    if (st.type === 'delay') { st.bufL.fill(0); st.bufR.fill(0); st.w = 0; return; }
    if (st.type === 'eq') { ncEqClear(st); return; }
    if (st.type === 'highpass' || st.type === 'bandpass') { st.f.z1L = 0; st.f.z2L = 0; st.f.z1R = 0; st.f.z2R = 0; return; }
    if (st.type === 'drive') { st.u[0] = 0; st.u[1] = 0; st.f[0] = 0; st.f[1] = 0; return; }
    if (st.type === 'compressor') { st.yl = 0; st.gr = 0; return; }
    if (st.type === 'plate') {
      ncZeroLine(st.pre);
      var i;
      for (i = 0; i < 4; i++) ncZeroLine(st.inAp[i]);
      for (i = 0; i < 2; i++) {
        ncZeroLine(st.ap1[i]); ncZeroLine(st.d1[i]); ncZeroLine(st.ap2[i]); ncZeroLine(st.d2[i]);
      }
      st.bw = 0; st.damp[0] = 0; st.damp[1] = 0; st.leftEnd = 0; st.rightEnd = 0; st.phase = 0;
    }
  }
function ncVendorWidgetStep(st, io, out) {
    var byType = NC_STEP_BY_TYPE[st.type];
    if (byType !== undefined) { byType(st, io, out); return; }
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    out[0] = xL; out[1] = xR;
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_lowpass(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncLowpassStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_delay(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncDelayStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_plate(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncPlateStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_eq(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncEqStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_highpass(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncPassStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_bandpass(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncPassStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_drive(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncDriveStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_compressor(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncCompStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
function ncVendorStep_width(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    ncWidthStep(st, io, out);
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
var NC_STEP_BY_TYPE = Object.assign(Object.create(null), { lowpass: ncVendorStep_lowpass, delay: ncVendorStep_delay, plate: ncVendorStep_plate, eq: ncVendorStep_eq, highpass: ncVendorStep_highpass, bandpass: ncVendorStep_bandpass, drive: ncVendorStep_drive, compressor: ncVendorStep_compressor, width: ncVendorStep_width });
function ncChainCreate(sr) {
    return {
      sr: sr, box: {}, order: [], nextOrder: null,
      lim: ncLimiterCreate(sr), tmp: [0, 0],
      immediate: false, fadePhase: 'idle', fadePos: 0,
      fadeLen: Math.max(1, Math.round(0.004 * sr)), master: MASTER
    };
  }
function ncKeep(chain) {
    for (var id in chain.box) if (chain.order.indexOf(id) < 0) delete chain.box[id];
  }
function ncFade(chain) {
    if (chain.immediate || chain.fadePhase === 'idle') return 1;
    if (chain.fadePhase === 'out' && !chain.nextOrder) return 1;
    var len = chain.fadeLen;
    chain.fadePos++;
    var p = chain.fadePos / len;
    if (p > 1) p = 1;
    var g;
    if (chain.fadePhase === 'out') {
      g = 0.5 * (1 + Math.cos(PI * p));
      if (chain.fadePos >= len) {
        chain.order = chain.nextOrder;
        chain.nextOrder = null;
        ncKeep(chain);
        chain.fadePhase = 'in';
        chain.fadePos = 0;
      }
      return g;
    }
    g = 0.5 * (1 - Math.cos(PI * p));
    if (chain.fadePos >= len) { chain.fadePhase = 'idle'; chain.fadePos = 0; }
    return g;
  }
function ncChainSet(chain, widgets, immediate) {
    chain.box = {};
    chain.order = [];
    chain.nextOrder = null;
    chain.fadePhase = 'idle';
    chain.fadePos = 0;
    chain.immediate = !!immediate;
    chain.lim = ncLimiterCreate(chain.sr);
    var list = widgets || [];
    var i;
    for (i = 0; i < list.length && chain.order.length < 10; i++) {
      var w = list[i];
      if (!w || w.type === 'limiter' || w.fixed || chain.box[w.id]) continue;
      var st = ncWidgetCreate(w.type, chain.sr);
      if (!st) continue;
      ncWidgetApply(st, w.params || {}, true, !!w.bypass, w.auto);
      chain.box[w.id] = st;
      chain.order.push(w.id);
    }
  }
function ncChainAdd(chain, w) {
    if (!w || w.type === 'limiter' || w.fixed) return;
    var n = 0;
    for (var id in chain.box) if (id !== w.id) n++;
    if (n >= 10) return;
    var st = ncWidgetCreate(w.type, chain.sr);
    if (!st) return;
    ncWidgetApply(st, w.params || {}, true, !!w.bypass, w.auto);
    chain.box[w.id] = st;
  }
function ncSame(a, b) {
    if (a.length !== b.length) return false;
    var i;
    for (i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
function ncChainOrder(chain, ids, immediate) {
    var next = [];
    var i;
    for (i = 0; i < ids.length && next.length < 10; i++) if (chain.box[ids[i]]) next.push(ids[i]);
    if (immediate || chain.immediate) {
      chain.order = next;
      chain.nextOrder = null;
      chain.fadePhase = 'idle';
      chain.fadePos = 0;
      ncKeep(chain);
      return;
    }
    if (ncSame(chain.order, next) && chain.fadePhase === 'idle') return;
    chain.nextOrder = next;
    if (chain.fadePhase !== 'out') { chain.fadePhase = 'out'; chain.fadePos = 0; }
  }
function ncChainPatch(chain, id, params, bypass, immediate, auto) {
    var st = chain.box[id];
    if (!st) return;
    ncWidgetApply(st, params || {}, !!immediate, bypass, auto);
  }
function ncChainClear(chain) {
    for (var id in chain.box) ncClearState(chain.box[id]);
    chain.lim = ncLimiterCreate(chain.sr);
    chain.fadePhase = 'idle';
    chain.fadePos = 0;
    chain.nextOrder = null;
  }
function ncTrackSlot(track) {
    if (track == null) return -1;
    if (typeof track !== 'number' || track !== track || track < 0 || track >= 8) return -2;
    return track | 0;
  }
function ncTrackRender(chain, inL, inR, outL, outR) {
    var n = outL.length;
    var order = chain.order;
    var i, m, st, yL, yR, tmp, xL, xR;
    if (!order.length) {
      for (i = 0; i < n; i++) {
        xL = inL ? inL[i] : 0;
        xR = inR ? inR[i] : xL;
        if (xL !== xL || xL === Infinity || xL === -Infinity) xL = 0;
        if (xR !== xR || xR === Infinity || xR === -Infinity) xR = 0;
        outL[i] = xL;
        if (outR && outR !== outL) outR[i] = xR;
      }
      return;
    }
    tmp = chain.tmp;
    for (m = 0; m < order.length; m++) {
      st = chain.box[order[m]];
      if (st) st.immediate = chain.immediate;
    }
    for (i = 0; i < n; i++) {
      yL = inL ? inL[i] : 0;
      yR = inR ? inR[i] : yL;
      if (yL !== yL || yL === Infinity || yL === -Infinity) yL = 0;
      if (yR !== yR || yR === Infinity || yR === -Infinity) yR = 0;
      if (chain.pos || chain.step) ncStamp(chain, order);
      for (m = 0; m < order.length; m++) {
        st = chain.box[order[m]];
        if (!st) continue;
        (NC_IO[0] = yL, NC_IO[1] = yR, ncWidgetStep(st, NC_IO, tmp));
        yL = tmp[0];
        yR = tmp[1];
      }
      outL[i] = yL;
      if (outR && outR !== outL) outR[i] = yR;
    }
  }
function ncMixRender(tracks, master, inputs, outL, outR) {
    var n = outL.length;
    var busL = master._busL;
    var busR = master._busR;
    if (!busL || busL.length < n) {
      busL = master._busL = new Float32Array(n < 128 ? 128 : n);
      busR = master._busR = new Float32Array(busL.length);
    }
    var i, t, input, inL, inR, tr, tmpL, tmpR, dL, dR, dry;
    for (i = 0; i < n; i++) { busL[i] = 0; busR[i] = 0; }
    for (t = 0; t < 8; t++) {
      input = inputs[t] || NC_NONE;
      inL = input[0] || null;
      inR = input[1] || inL;
      tr = tracks[t];
      if (!tr || (!inL && !tr.order.length)) continue;
      tmpL = tr._outL;
      tmpR = tr._outR;
      if (!tmpL || tmpL.length < n) {
        tmpL = tr._outL = new Float32Array(n < 128 ? 128 : n);
        tmpR = tr._outR = new Float32Array(tmpL.length);
      }
      if (tr._vL === undefined || tr._vn !== n || tr._vb !== tmpL) { tr._vL = tmpL.subarray(0, n); tr._vR = tmpR.subarray(0, n); tr._vn = n; tr._vb = tmpL; }
      ncTrackRender(tr, inL, inR, tr._vL, tr._vR);
      for (i = 0; i < n; i++) { busL[i] += tmpL[i]; busR[i] += tmpR[i]; }
    }
    dry = inputs[8] || NC_NONE;
    dL = dry[0] || null;
    dR = dry[1] || dL;
    if (dL) {
      for (i = 0; i < n; i++) {
        busL[i] += dL[i];
        busR[i] += dR ? dR[i] : dL[i];
      }
    }
    if (master._vL === undefined || master._vn !== n || master._vb !== busL) { master._vL = busL.subarray(0, n); master._vR = busR.subarray(0, n); master._vn = n; master._vb = busL; }
    ncRender(master, master._vL, master._vR, outL, outR);
  }
function ncRender(chain, inL, inR, outL, outR) {
    var n = outL.length;
    var tmp = chain.tmp;
    var order = chain.order;
    var m, i, st;
    for (m = 0; m < order.length; m++) {
      st = chain.box[order[m]];
      if (st) st.immediate = chain.immediate;
    }
    for (i = 0; i < n; i++) {
      var xL = inL ? inL[i] : 0;
      var xR = inR ? inR[i] : xL;
      if (xL !== xL || xL === Infinity || xL === -Infinity) xL = 0;
      if (xR !== xR || xR === Infinity || xR === -Infinity) xR = 0;
      var       yL = xL, yR = xR;
      order = chain.order;
      if (chain.pos || chain.step) ncStamp(chain, order);
      for (m = 0; m < order.length; m++) {
        st = chain.box[order[m]];
        if (!st) continue;
        (NC_IO[0] = yL, NC_IO[1] = yR, ncWidgetStep(st, NC_IO, tmp));
        yL = tmp[0];
        yR = tmp[1];
      }
      var g = ncFade(chain) * chain.master;
      (NC_IO[0] = yL * g, NC_IO[1] = yR * g, ncLimiterStep(chain.lim, NC_IO, tmp));
      outL[i] = tmp[0];
      if (outR && outR !== outL) outR[i] = tmp[1];
    }
  }
function asIsMod(type) { return type === 'flanger' || type === 'chorus' || type === 'phaser'; }
function asClamp(v, d, lo, hi) {
    var x = v == null ? d : +v;
    if (x !== x) x = d;
    return x < lo ? lo : x > hi ? hi : x;
  }
function asTap(buf, w, n, ago) {
    if (ago < 1) ago = 1;
    if (ago > n - 2) ago = n - 2;
    var p = w - ago;
    if (p < 0) p += n;
    var i0 = Math.floor(p);
    var f = p - i0;
    var i1 = i0 + 1;
    if (i1 >= n) i1 = 0;
    return buf[i0] * (1 - f) + buf[i1] * f;
  }
function asSmooth(st, k) {
    st.rateS += (st.rateT - st.rateS) * k;
    st.depthS += (st.depthT - st.depthS) * k;
    st.fbS += (st.fbT - st.fbS) * k;
    st.mixS += (st.mixT - st.mixS) * k;
    if (Math.abs(st.mixT - st.mixS) < 1e-6) st.mixS = st.mixT;
  }
function asModBase(type, sr, seconds, rate, depth, fb, mix) {
    var n = Math.ceil(seconds * sr) + 4;
    return {
      type: type, sr: sr, n: n, w: 0, ph: 0,
      bufL: new Float32Array(n), bufR: new Float32Array(n),
      rateS: rate, rateT: rate, depthS: depth, depthT: depth, fbS: fb, fbT: fb, mixS: mix, mixT: mix,
      bypass: 1, bypassT: 1, kFast: ncCoef(0.02, sr), kSlow: ncCoef(0.08, sr), immediate: false
    };
  }
function asModApply(st, p, snap, fbLo) {
    st.rateT = asClamp(p.rate_hz, st.rateT, 0.01, 20);
    st.depthT = asClamp(p.depth, st.depthT, 0, 1);
    st.fbT = asClamp(p.feedback, st.fbT, fbLo, 0.9);
    st.mixT = asClamp(p.mix, st.mixT, 0, 1);
    if (snap) { st.rateS = st.rateT; st.depthS = st.depthT; st.fbS = st.fbT; st.mixS = st.mixT; }
  }
function asAdvance(st) {
    var ph = st.ph + st.rateS / st.sr;
    st.ph = ph >= 1 ? ph - 1 : ph;
  }
function asFlangerCreate(sr) { return asModBase('flanger', sr, 0.008, 0.2, 0.7, 0.5, 0.5); }
function asFlangerStep(st, io, out) {
    var xL = io[0], xR = io[1];
    asSmooth(st, st.immediate ? 1 : st.kFast);
    var ms = st.sr / 1000;
    var dL = (0.3 + st.depthS * 5 * (0.5 + 0.5 * Math.sin(TWOPI * st.ph))) * ms;
    var dR = (0.3 + st.depthS * 5 * (0.5 + 0.5 * Math.sin(TWOPI * (st.ph + 0.25)))) * ms;
    var wL = asTap(st.bufL, st.w, st.n, dL);
    var wR = asTap(st.bufR, st.w, st.n, dR);
    st.bufL[st.w] = ncFlush(xL + st.fbS * wL);
    st.bufR[st.w] = ncFlush(xR + st.fbS * wR);
    st.w = st.w + 1 >= st.n ? 0 : st.w + 1;
    asAdvance(st);
    var dg = Math.cos(st.mixS * HALFPI), wg = Math.sin(st.mixS * HALFPI);
    out[0] = dg * xL + wg * wL;
    out[1] = dg * xR + wg * wR;
  }
function asChorusCreate(sr) {
    var st = asModBase('chorus', sr, 0.022, 0.8, 0.5, 0, 0.4);
    st.spreadS = 0.7; st.spreadT = 0.7;
    return st;
  }
function asChorusApply(st, p, snap) {
    asModApply(st, p, snap, 0);
    st.spreadT = asClamp(p.spread, st.spreadT, 0, 1);
    if (snap) st.spreadS = st.spreadT;
  }
function asChorusStep(st, io, out) {
    var xL = io[0], xR = io[1];
    var k = st.immediate ? 1 : st.kFast;
    asSmooth(st, k);
    st.spreadS += (st.spreadT - st.spreadS) * k;
    var ms = st.sr / 1000;
    st.bufL[st.w] = ncFlush(xL);
    st.bufR[st.w] = ncFlush(xR);
    var w = st.w + 1 >= st.n ? 0 : st.w + 1;
    var sumL = 0, sumR = 0, gl = 0, gr = 0, i, ago, pan, a, b;
    for (i = 0; i < 3; i++) {
      ago = (10 + st.depthS * 8 * (0.5 + 0.5 * Math.sin(TWOPI * (st.ph + i / 3)))) * ms;
      pan = (i - 1) * st.spreadS;            // −1 left … +1 right
      a = Math.cos((pan + 1) * 0.25 * PI);   // equal power
      b = Math.sin((pan + 1) * 0.25 * PI);
      sumL += a * asTap(st.bufL, w, st.n, ago);
      sumR += b * asTap(st.bufR, w, st.n, ago);
      gl += a * a; gr += b * b;
    }
    st.w = w;
    asAdvance(st);
    var dg = Math.cos(st.mixS * HALFPI), wg = Math.sin(st.mixS * HALFPI);
    out[0] = dg * xL + wg * (gl > 0 ? sumL / Math.sqrt(gl) : 0);
    out[1] = dg * xR + wg * (gr > 0 ? sumR / Math.sqrt(gr) : 0);
  }
function asPhaserCreate(sr) {
    var st = asModBase('phaser', sr, 0, 0.4, 0.7, 0.3, 0.5);
    st.bufL = null; st.bufR = null;
    st.stages = 6;
    st.zL = new Float64Array(8); st.zR = new Float64Array(8);
    st.yL = 0; st.yR = 0;
    return st;
  }
function asPhaserApply(st, p, snap) {
    asModApply(st, p, snap, 0);
    var s = p.stages == null ? st.stages : +p.stages;
    st.stages = s === 4 || s === 8 ? s : 6;
  }
function asAllpassCoef(fc, sr) {
    var ny = sr * 0.45;
    if (fc > ny) fc = ny;
    var t = Math.tan(PI * fc / sr);
    return (t - 1) / (t + 1);
  }
function asPhaserStep(st, io, out) {
    var xL = io[0], xR = io[1];
    asSmooth(st, st.immediate ? 1 : st.kFast);
    var oct = 5 * st.depthS;
    var aL = asAllpassCoef(150 * Math.pow(2, oct * (0.5 + 0.5 * Math.sin(TWOPI * st.ph))), st.sr);
    var aR = asAllpassCoef(150 * Math.pow(2, oct * (0.5 + 0.5 * Math.sin(TWOPI * (st.ph + 0.25)))), st.sr);
    var yL = xL + st.fbS * st.yL, yR = xR + st.fbS * st.yR, y, i;
    for (i = 0; i < st.stages; i++) {
      y = aL * yL + st.zL[i]; st.zL[i] = ncFlush(yL - aL * y); yL = y;
      y = aR * yR + st.zR[i]; st.zR[i] = ncFlush(yR - aR * y); yR = y;
    }
    st.yL = ncFlush(yL); st.yR = ncFlush(yR);
    asAdvance(st);
    var dg = Math.cos(st.mixS * HALFPI), wg = Math.sin(st.mixS * HALFPI);
    out[0] = dg * xL + wg * yL;
    out[1] = dg * xR + wg * yR;
  }
function ncWidgetCreate(type, sr) {
    if (type === 'flanger') return asFlangerCreate(sr);
    if (type === 'chorus') return asChorusCreate(sr);
    if (type === 'phaser') return asPhaserCreate(sr);
    return ncVendorWidgetCreate(type, sr);
  }
function ncWidgetApply(st, p, snap, bypass, auto) {
    p = p || {};
    if (st.type === 'flanger') asModApply(st, p, snap, -0.9);
    else if (st.type === 'chorus') asChorusApply(st, p, snap);
    else if (st.type === 'phaser') asPhaserApply(st, p, snap);
    ncVendorWidgetApply(st, p, snap, bypass, auto);
  }
function ncClearState(st) {
    if (st && asIsMod(st.type)) {
      if (st.bufL) { st.bufL.fill(0); st.bufR.fill(0); st.w = 0; }
      if (st.zL) { st.zL.fill(0); st.zR.fill(0); st.yL = 0; st.yR = 0; }
      return;
    }
    ncVendorClearState(st);
  }
function ncWidgetStep(st, io, out) {
    var xL = io[0], xR = io[1];
    if (!asIsMod(st.type)) { (NC_IO[0] = xL, NC_IO[1] = xR, ncVendorWidgetStep(st, NC_IO, out)); return; }
    var k = st.immediate ? 1 : st.kFast;
    st.bypass += (st.bypassT - st.bypass) * k;
    if (st.type === 'flanger') (NC_IO[0] = xL, NC_IO[1] = xR, asFlangerStep(st, NC_IO, out));
    else if (st.type === 'chorus') (NC_IO[0] = xL, NC_IO[1] = xR, asChorusStep(st, NC_IO, out));
    else (NC_IO[0] = xL, NC_IO[1] = xR, asPhaserStep(st, NC_IO, out));
    var b = st.bypass;
    if (b >= 0.999) return;
    if (b <= 0.001) { out[0] = xL; out[1] = xR; return; }
    var dryG = Math.cos(b * HALFPI);
    var wetG = Math.sin(b * HALFPI);
    out[0] = dryG * xL + wetG * out[0];
    out[1] = dryG * xR + wetG * out[1];
  }
// One AudioWorklet for the whole hack stack. DSP functions are prepended by engine.js.
function ncNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  try {
    if (typeof Temporal !== 'undefined' && Temporal.Now) return Number(Temporal.Now.instant().epochNanoseconds / 1000n) / 1000;
  } catch (err) {}
  return 0;
}
class NCHackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chain = ncChainCreate(sampleRate);
    this.tracks = [];
    var t;
    for (t = 0; t < 8; t++) this.tracks.push(ncChainCreate(sampleRate));
    var opt = options && options.processorOptions;
    this.piece = opt && +opt.piece > 0 ? +opt.piece : 0;
    if (opt && opt.widgets) ncChainSet(this.chain, opt.widgets, opt.immediate !== false);
    this.warm = 8;
    this.cpuN = 0;
    this.cpuSum = 0;
    this.cpuMax = 0;
    this.cpuOn = false;
    this.clock = ncNow() > 0;
    // Limiter gain for the scope: off until the page asks, then the lowest gain every 8 blocks.
    this.grOn = false;
    this.grMin = 1;
    this.grN = 0;
    var self = this;
    this.port.onmessage = function (e) { self.onMsg(e.data || {}); };
    this.port.postMessage({ ready: 1, sr: sampleRate, clock: this.clock });
  }
  onMsg(msg) {
    if (msg.op === 'clock') {
      var pos = +msg.pos;
      var step = +msg.step;
      if (!(pos > 0)) pos = 0;
      if (pos > 1) pos = 1;
      if (!(step > 0) || step !== step) step = 0;
      this.chain.pos = pos;
      this.chain.step = step;
      var ti;
      for (ti = 0; ti < this.tracks.length; ti++) {
        this.tracks[ti].pos = pos;
        this.tracks[ti].step = step;
      }
      if (msg.ack) this.port.postMessage({ ack: msg.ack });
      return;
    }
    var slot = ncTrackSlot(msg.track);
    if (slot === -2) {
      if (msg.ack) this.port.postMessage({ ack: msg.ack });
      return;
    }
    var chain = slot >= 0 ? this.tracks[slot] : this.chain;
    if (msg.op === 'chain') ncChainSet(chain, msg.widgets, !!msg.hold);
    else if (msg.op === 'add') ncChainAdd(chain, msg.widget);
    else if (msg.op === 'order') ncChainOrder(chain, msg.ids || [], !!msg.immediate);
    else if (msg.op === 'patch') ncChainPatch(chain, msg.id, msg.params, msg.bypass, !!msg.immediate, msg.auto);
    else if (msg.op === 'clear') ncChainClear(chain);
    else if (msg.op === 'cpu') { this.cpuOn = !!msg.on; this.cpuSum = 0; this.cpuMax = 0; this.cpuN = 0; this.warm = 8; }
    else if (msg.op === 'scope') { this.grOn = !!msg.on; this.grMin = 1; this.grN = 0; }
    if (msg.ack) this.port.postMessage({ ack: msg.ack });
  }
  process(inputs, outputs) {
    var t0 = this.cpuOn ? ncNow() : 0;
    var output = outputs[0] || NC_NONE;
    var outL = output[0];
    var outR = output[1] || outL;
    if (!outL) return true;
    if (this.piece > 0) {
      var u = currentTime / this.piece;
      if (!(u > 0)) u = 0;
      if (u > 1) u = 1;
      var stepU = u >= 1 ? 0 : 1 / (this.piece * sampleRate);
      this.chain.pos = u;
      this.chain.step = stepU;
      var ti;
      for (ti = 0; ti < this.tracks.length; ti++) {
        this.tracks[ti].pos = u;
        this.tracks[ti].step = stepU;
      }
    }
    ncMixRender(this.tracks, this.chain, inputs, outL, outR);
    if (this.grOn) {
      var lim = this.chain.lim;
      if (lim.lo < this.grMin) this.grMin = lim.lo;
      lim.lo = 1;
      if (++this.grN >= 8) {
        this.port.postMessage({ gr: this.grMin });
        this.grMin = 1;
        this.grN = 0;
      }
    }
    if (!this.clock || !this.cpuOn) return true;
    var dt = ncNow() - t0;
    if (this.warm > 0) { this.warm--; return true; }
    this.cpuSum += dt;
    if (dt > this.cpuMax) this.cpuMax = dt;
    this.cpuN++;
    if (this.cpuN >= 32) {
      var budget = (outL.length / sampleRate) * 1000;
      this.port.postMessage({
        cpu: {
          avg: this.cpuSum / this.cpuN,
          max: this.cpuMax,
          budget: budget,
          sr: sampleRate,
          n: this.cpuN,
          block: outL.length
        }
      });
      this.cpuSum = 0;
      this.cpuMax = 0;
      this.cpuN = 0;
    }
    return true;
  }
}
registerProcessor('nc-hack-stack', NCHackProcessor);
