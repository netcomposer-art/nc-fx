// nc-fx AudioWorkletProcessor 'nc-fx@1'. scripts/build.mjs inlines src/dsp.js above this file into
// dist/worklet.js (one self-contained module, no imports), so the line below is stripped by the build.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
import { createFxDsp } from './dsp.js'; // @strip

var NC_FX_PROCESSOR = 'nc-fx@1';

class NcFxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var po = (options && options.processorOptions) || {};
    this.dsp = createFxDsp(sampleRate, {
      bypassMode: po.bypassMode, limiter: po.limiter, preGain: po.preGain, maxDelaySeconds: po.maxDelaySeconds, startFrame: currentFrame
    });
    if (typeof po.bpm === 'number') this.dsp.setTempo(po.bpm, 0, true);
    if (po.program) this.dsp.load(po.program, 0, true);
    this.alive = true;
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
    if (m.t === 'dispose') { this.alive = false; this.port.onmessage = null; return; }
    this.dispatch(m, frame, !!m.snap);
  }
  dispatch(m, frame, snap) {
    var d = this.dsp;
    switch (m.t) {
      case 'p': d.set(m.i, m.v, frame, snap); break;
      case 'load': if (m.program) d.load(m.program, frame, snap); break;
      case 'tempo': d.setTempo(m.bpm, frame, snap); break;
      case 'clear': d.clear(frame, m.fadeMs); break;
    }
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
    return true;
  }
}

try { registerProcessor(NC_FX_PROCESSOR, NcFxProcessor); } catch (e) { /* already registered in this scope */ }
