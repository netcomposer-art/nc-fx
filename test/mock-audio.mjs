// A tiny Web Audio stand-in for testing createFxCore's wiring and messages in Node.
export class Param { constructor(v) { this.value = v; this.events = []; } setValueAtTime(v, t) { this.events.push(['set', v, t]); this.value = v; } linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]); this.value = v; } }
export class Node { constructor() { this.out = new Set(); this.links = []; } connect(n, output = 0, input = 0) { this.out.add(n); this.links.push([n, output, input]); return n; } disconnect() { this.out.clear(); this.links = []; } }
export class Gain extends Node { constructor() { super(); this.gain = new Param(1); } }
export function mockContext({ fail = false, currentTime = 0 } = {}) {
  const posted = [];
  const ctx = {
    sampleRate: 48000, currentTime, modules: [],
    createGain: () => new Gain(),
    audioWorklet: { addModule: async (url) => { ctx.modules.push(url); if (fail) throw new Error('no worklets here'); } },
    posted,
  };
  globalThis.AudioWorkletNode = class extends Node {
    constructor(c, name, options) { super(); this.name = name; this.options = options; this.port = { postMessage: (m) => posted.push(m), close() {} }; c.node = this; }
  };
  return ctx;
}
