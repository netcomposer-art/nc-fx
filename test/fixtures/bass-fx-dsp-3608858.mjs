// ASTRID-Bass apps/bass/src/modules/fx/fx-dsp.ts + types.ts at 3608858 (psemmelhack/ASTRID-Bass), bundled with
// esbuild 0.25.10 (--bundle --format=esm) for nc-fx's Acid drive parity test. Source sha256: fx-dsp.ts 57336ae3...7eaf,
// types.ts 72a98c9e...fcf5fd. ASTRID-Bass is by Peter Semmelhack (https://psem.me/). Test fixture only; not shipped.
var FX_KINDS = {
  /** Post-filter drive/distortion. Accent mod can push amount and tone. */
  drive: {
    amount: { min: 0, max: 1, default: 0.25 },
    tone: { min: 0, max: 1, default: 0.6 },
    mix: { min: 0, max: 1, default: 1 },
    modAmount: { min: -1, max: 1, default: 0 },
    modTone: { min: -1, max: 1, default: 0 }
  },
  /** Tempo-synced delay as a send. `division` is in beats. Wet low-cut defaults to 120 Hz. */
  delay: {
    division: { min: 0.125, max: 2, default: 0.75 },
    feedback: { min: 0, max: 0.9, default: 0.35 },
    send: { min: 0, max: 1, default: 0.25 },
    tone: { min: 0, max: 1, default: 0.5 },
    lowCut: { min: 20, max: 1e3, default: 120 },
    bpm: { min: 20, max: 300, default: 120 },
    modSend: { min: -1, max: 1, default: 0 }
  }
};
var FX_KIND_IDS = Object.keys(FX_KINDS);

// apps/bass/src/modules/fx/fx-dsp.ts
var KIND_NONE = -1;
var KIND_DRIVE = 0;
var KIND_DELAY = 1;
var KIND_CODE = { drive: KIND_DRIVE, delay: KIND_DELAY };
var PARAM_STRIDE = 8;
var MAX_EVENTS = 64;
var TWO_PI = Math.PI * 2;
function paramIndex(kind, param) {
  return Object.keys(FX_KINDS[kind]).indexOf(param);
}
var FxChainDsp = class {
  sampleRate;
  maxSlots;
  maxDelay;
  kind;
  bypass;
  params;
  smooth;
  st;
  lines;
  writePos;
  order;
  orderLen = 0;
  preGain = 0.8;
  evFrame = new Float64Array(MAX_EVENTS);
  evSlot = new Int8Array(MAX_EVENTS);
  evParam = new Int8Array(MAX_EVENTS);
  evValue = new Float64Array(MAX_EVENTS);
  evCount = 0;
  constructor(sampleRate, maxSlots, maxDelaySeconds = 4) {
    this.sampleRate = sampleRate;
    this.maxSlots = maxSlots;
    this.maxDelay = Math.ceil(maxDelaySeconds * sampleRate);
    this.kind = new Int8Array(maxSlots).fill(KIND_NONE);
    this.bypass = new Uint8Array(maxSlots);
    this.params = new Float64Array(maxSlots * PARAM_STRIDE);
    this.smooth = new Float64Array(maxSlots * PARAM_STRIDE);
    this.st = new Float64Array(maxSlots * PARAM_STRIDE);
    this.lines = new Array(maxSlots).fill(null);
    this.writePos = new Int32Array(maxSlots);
    this.order = new Int8Array(maxSlots);
  }
  /** Message path: set a slot's kind and params. May allocate a delay line once. */
  configure(slot, kind, bypass, params) {
    if (slot < 0 || slot >= this.maxSlots) return;
    if (this.kind[slot] !== kind) {
      for (let i = 0; i < PARAM_STRIDE; i++) this.st[slot * PARAM_STRIDE + i] = 0;
      const line = this.lines[slot];
      if (line) line.fill(0);
    }
    this.kind[slot] = kind;
    this.bypass[slot] = bypass ? 1 : 0;
    if (kind === KIND_DELAY && !this.lines[slot])
      this.lines[slot] = new Float32Array(this.maxDelay);
    for (let i = 0; i < PARAM_STRIDE; i++) {
      const v = i < params.length ? params[i] : 0;
      this.params[slot * PARAM_STRIDE + i] = v;
      this.smooth[slot * PARAM_STRIDE + i] = v;
    }
  }
  setOrder(slots) {
    this.orderLen = Math.min(slots.length, this.maxSlots);
    for (let i = 0; i < this.orderLen; i++) this.order[i] = slots[i];
  }
  /** Message path: schedule a param change at `frame` (≤ now applies at the next block). */
  schedule(frame, slot, param, value) {
    if (this.evCount >= MAX_EVENTS) {
      this.params[slot * PARAM_STRIDE + param] = value;
      return;
    }
    const i = this.evCount++;
    this.evFrame[i] = frame;
    this.evSlot[i] = slot;
    this.evParam[i] = param;
    this.evValue[i] = value;
  }
  /** True when nothing in the chain is active (the adapter then bypasses the node). */
  get idle() {
    for (let i = 0; i < this.orderLen; i++) {
      const s = this.order[i];
      if (this.kind[s] !== KIND_NONE && !this.bypass[s]) return false;
    }
    return true;
  }
  process(input, mod, out, frame) {
    const n = out.length;
    let w = 0;
    for (let e = 0; e < this.evCount; e++) {
      if (this.evFrame[e] < frame + n) {
        this.params[this.evSlot[e] * PARAM_STRIDE + this.evParam[e]] = this.evValue[e];
      } else {
        this.evFrame[w] = this.evFrame[e];
        this.evSlot[w] = this.evSlot[e];
        this.evParam[w] = this.evParam[e];
        this.evValue[w] = this.evValue[e];
        w++;
      }
    }
    this.evCount = w;
    const g = this.preGain;
    for (let i = 0; i < n; i++) out[i] = input[i] * g;
    const modAtStart = mod ? mod[0] : 0;
    for (let o = 0; o < this.orderLen; o++) {
      const s = this.order[o];
      const k = this.kind[s];
      if (k === KIND_NONE || this.bypass[s]) continue;
      const base = s * PARAM_STRIDE;
      for (let i = 0; i < PARAM_STRIDE; i++) {
        this.smooth[base + i] += (this.params[base + i] - this.smooth[base + i]) * 0.25;
      }
      if (k === KIND_DRIVE) this.drive(base, out, mod, n, modAtStart);
      else if (k === KIND_DELAY) this.delay(s, base, out, mod, n);
    }
  }
  drive(base, buf, mod, n, modAtStart) {
    const p = this.smooth;
    const st = this.st;
    const amount = p[base];
    let tone = p[base + 1] + p[base + 4] * modAtStart;
    tone = tone < 0 ? 0 : tone > 1 ? 1 : tone;
    const mix = p[base + 2];
    const modAmount = p[base + 3];
    const fc = 500 * 2 ** (tone * 5);
    const a = 1 - Math.exp(-TWO_PI * fc / this.sampleRate);
    let lp = st[base];
    for (let i = 0; i < n; i++) {
      let amt = amount + (mod ? modAmount * mod[i] : 0);
      amt = amt < 0 ? 0 : amt > 1 ? 1 : amt;
      const k = 1 + amt * 9;
      const x = buf[i];
      const shaped = Math.tanh(x * k) / Math.tanh(k) * 0.9;
      lp += (shaped - lp) * a;
      buf[i] = x + (lp - x) * mix;
    }
    st[base] = lp;
  }
  delay(slot, base, buf, mod, n) {
    const line = this.lines[slot];
    if (!line) return;
    const p = this.smooth;
    const st = this.st;
    const sr = this.sampleRate;
    const len = line.length;
    let d = p[base] * 60 / (p[base + 5] > 1 ? p[base + 5] : 120) * sr;
    if (d < 1) d = 1;
    if (d > len - 2) d = len - 2;
    const fb = p[base + 1];
    const send = p[base + 2];
    const toneA = 1 - Math.exp(-TWO_PI * (800 * 2 ** (p[base + 3] * 4)) / sr);
    const cutA = 1 - Math.exp(-TWO_PI * p[base + 4] / sr);
    const modSend = p[base + 6];
    let lp = st[base];
    let hp = st[base + 1];
    let wp = this.writePos[slot];
    for (let i = 0; i < n; i++) {
      let rp = wp - d;
      if (rp < 0) rp += len;
      const i0 = rp | 0;
      const frac = rp - i0;
      const i1 = i0 + 1 >= len ? 0 : i0 + 1;
      const tap = line[i0] + (line[i1] - line[i0]) * frac;
      lp += (tap - lp) * toneA;
      hp += (lp - hp) * cutA;
      const wet = lp - hp;
      const x = buf[i];
      let amt = send + (mod ? modSend * mod[i] : 0);
      amt = amt < 0 ? 0 : amt > 1 ? 1 : amt;
      line[wp] = x * amt + wet * fb;
      buf[i] = x + wet;
      wp++;
      if (wp >= len) wp = 0;
    }
    st[base] = lp;
    st[base + 1] = hp;
    this.writePos[slot] = wp;
  }
};
export {
  FxChainDsp,
  KIND_CODE,
  KIND_DELAY,
  KIND_DRIVE,
  KIND_NONE,
  PARAM_STRIDE,
  paramIndex
};
