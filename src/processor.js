// nc-fx AudioWorkletProcessor 'nc-fx@1'. scripts/build.mjs inlines src/mod.js, src/units.js, src/dsp.js and
// src/chain.js above this file into dist/worklet.js (one self-contained module, no imports), so the lines below are
// stripped by the build. processorOptions.slots picks the engine: absent, the fixed chain (createFxDsp); a number,
// ASTRID's slot chain (createFxChainDsp) with that many slots.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
import { createFxDsp } from './dsp.js'; // @strip
import { createFxChainDsp } from './chain.js'; // @strip

var NC_FX_PROCESSOR = 'nc-fx@1';
/** How often the level taps report (seconds): about 30 a second, the kit's meter frame rate. */
var METER_S = 1 / 30;

class NcFxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var po = (options && options.processorOptions) || {};
    var eo = { bypassMode: po.bypassMode, limiter: po.limiter, preGain: po.preGain, maxDelaySeconds: po.maxDelaySeconds, startFrame: currentFrame };
    this.slots = typeof po.slots === 'number' && po.slots > 0;
    if (this.slots) eo.slots = po.slots;
    this.dsp = this.slots ? createFxChainDsp(sampleRate, eo) : createFxDsp(sampleRate, eo);
    if (typeof po.bpm === 'number') this.dsp.setTempo(po.bpm, 0, true);
    if (this.slots) { if (po.chain) this.sync(po.chain, po.order || [], 0); }
    else if (po.program) this.dsp.load(po.program, 0, true);
    this.alive = true;
    // The beat clock goes to the main thread when it changes (tempo, line-up, stop; a few times a session), as
    // { t: 'clk', d: [beat, frame, beats per frame, locked, beats per bar] }: the host reads the playhead from it.
    this.cSeen = -1;
    this.cBuf = new Float64Array(5);
    this.cMsg = { t: 'clk', d: this.cBuf };
    // Level taps (a host meter is open): every METER_S the peaks go out as one small message, { t: 'lv', d }, the same
    // buffer each time (postMessage copies it). Silence goes out once, then nothing until there is sound again.
    this.mOn = false;
    this.mN = 0;
    this.mEvery = Math.max(128, Math.round(sampleRate * METER_S));
    this.mBuf = new Float32Array(this.dsp.meterSize);
    this.mMsg = { t: 'lv', d: this.mBuf };
    this.mQuiet = false;
    // Plugin failures (src/plugin-host.js): uid, code pairs, posted as { t: 'perr', d } when one happens (rare).
    if (this.slots) { this.eBuf = new Int32Array(2 * (2 * this.dsp.slots + 2)); this.eMsg = { t: 'perr', d: this.eBuf, n: 0 }; }
    // Calls made on the main thread before this node existed, in call order. A time at or before the
    // current frame is clamped to now (and snaps); a future time is applied exactly. Equal frames keep
    // their order in the engine's queue. Runs once, in the constructor, before the first process().
    var pend = po.pending;
    if (pend && pend.length) {
      for (var k = 0; k < pend.length; k++) {
        var m = pend[k];
        if (!m || typeof m !== 'object') continue;
        var f = typeof m.when === 'number' && m.when > 0 ? Math.round(m.when * sampleRate) : 0;
        if (f <= currentFrame) this.dispatch(m, 0, true);
        else this.dispatch(m, f, !!m.snap);
      }
    }
    var self = this;
    // Messages are the one place the audio thread receives garbage (the structured clone of each message);
    // keep them few: one per user gesture or tempo change, never per block.
    this.port.onmessage = function (e) { self.onMessage(e.data); };
  }
  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    var frame = typeof m.when === 'number' && m.when > 0 ? Math.round(m.when * sampleRate) : 0;
    if (m.t === 'meter') {
      this.mOn = m.on === true;
      this.mN = 0;
      this.mQuiet = false;
      this.dsp.meter(this.mOn);
      return;
    }
    if (m.t === 'dispose') { this.alive = false; this.port.onmessage = null; return; }
    this.dispatch(m, frame, !!m.snap);
  }
  dispatch(m, frame, snap) {
    var d = this.dsp;
    switch (m.t) {
      case 'p': if (!this.slots) d.set(m.i, m.v, frame, snap); break;
      case 'load': if (!this.slots && m.program) d.load(m.program, frame, snap); break;
      case 'tempo': d.setTempo(m.bpm, frame, snap); break;
      // The beat clock (Gate): a line-up (Play), free-running (Stop), beats per bar.
      case 'beat': d.setBeat(m.beat, frame); break;
      case 'free': d.freeRun(frame); break;
      case 'bar': d.setBar(m.beats, frame); break;
      case 'clear': d.clear(frame, m.fadeMs); break;
      // Slot chain: add an effect (its params follow as snapped 'ps'), set one param, the order to play.
      case 'add':
        if (this.slots && !d.add(m.uid, m.type, frame) && typeof m.type === 'string' && m.type.indexOf('plugin:') === 0) {
          // A plugin whose DSP isn't registered in this scope: say so (the main thread shows it as missing).
          this.port.postMessage({ t: 'perr', d: [m.uid, d.hasPlugin(m.type) ? 1 : 5], n: 1 });
        }
        break;
      case 'ps': if (this.slots) d.set(m.uid, m.k, m.v, frame, snap); break;
      case 'order': if (this.slots && m.uids) d.order(m.uids, frame, snap || m.immediate === true); break;
      case 'sync': if (this.slots && m.chain) this.sync(m.chain, m.order || [], frame); break;
    }
  }
  /** A whole slot chain at once (the start, or a folded pre-ready queue): adds what is new, snaps every param, plays
   * the order without a fade. chain: [{uid, type, program: [[k, v], ...]}]. */
  sync(chain, order, frame) {
    var d = this.dsp;
    for (var c = 0; c < chain.length; c++) {
      var x = chain[c];
      if (!x || !x.program) continue;
      if (d.get(x.uid, 0) === undefined) d.add(x.uid, x.type, frame);
      for (var p = 0; p < x.program.length; p++) d.set(x.uid, x.program[p][0], x.program[p][1], frame, true);
    }
    d.order(order, frame, true);
  }
  process(inputs, outputs) {
    if (!this.alive) return false;
    var out = outputs[0];
    if (!out || !out[0]) return true;
    var inp = inputs[0];
    var inL = inp && inp.length > 0 ? inp[0] : null;
    var inR = inp && inp.length > 1 ? inp[1] : null;
    // Input 1 is the mod input (createFxCore({ modInput: true })): its channel 0. A never-connected fx.modInput still
    // feeds silence (the browser hands over silent channels), so mod is a zero buffer then, which renders the same as
    // no mod; null only when input 1 has no channels (e.g. after fx.modInput.disconnect()) or the node has one input.
    var mi = inputs.length > 1 ? inputs[1] : null;
    var mod = mi && mi.length > 0 ? mi[0] : null;
    this.dsp.process(inL, inR, out[0], out.length > 1 ? out[1] : null, out[0].length, currentFrame, mod);
    var ck = this.dsp.clock;
    if (ck[6] !== this.cSeen) {
      this.cSeen = ck[6];
      var cb = this.cBuf;
      cb[0] = ck[0]; cb[1] = ck[1]; cb[2] = ck[2]; cb[3] = ck[5]; cb[4] = ck[7];
      this.port.postMessage(this.cMsg);
    }
    if (this.slots && this.dsp.errorsPending[0] > 0) { this.eMsg.n = this.dsp.takeErrors(this.eBuf); this.port.postMessage(this.eMsg); }
    if (this.mOn) {
      this.mN += out[0].length;
      if (this.mN >= this.mEvery) {
        this.mN = 0;
        var n = this.dsp.takeMeter(this.mBuf), loud = false;
        for (var j = 0; j < n; j++) if ((j < 2 || (j > 2 && (j - 3) % 3 !== 0)) && this.mBuf[j] > 1e-5) { loud = true; break; }
        if (loud || !this.mQuiet) this.port.postMessage(this.mMsg);
        this.mQuiet = !loud;
      }
    }
    return true;
  }
}

try { registerProcessor(NC_FX_PROCESSOR, NcFxProcessor); } catch (e) { /* already registered in this scope */ }
