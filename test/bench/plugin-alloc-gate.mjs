// Heap-delta gate for a slot chain with a plugin box (test/plugin-engine.test.mjs runs this with a fixed 64 MB young
// generation): the tremolo fixture between a chorus and a delay. argv[2]: 'plugin' (the tremolo) or 'builtin' (a
// width in its place, for comparison); argv[3]: 'steady' or 'events' (its dials, bypass and the chain order moving:
// the control path, which costs the same few boxed numbers per event for a built-in box).
// Prints { bytes, median } for 12 windows of 2000 blocks after warm-up.
import { readFileSync } from 'node:fs';
import { createFxChainDsp } from '../../src/chain.js';
import '../../src/plugin-host.js';
import { newSlot, slotProgram } from '../../src/slots.js';

const dspSrc = readFileSync(new URL('../fixtures/plugins/tremolo/tremolo.dsp.js', import.meta.url), 'utf8');
new Function(dspSrc)(); // registers netcomposer.tremolo@1.0.0 (registerNcFxPlugin is global)
const dsp = createFxChainDsp(48000, { slots: 4, limiter: 'lookahead' });
const chorus = newSlot('chorus', []), delay = newSlot('delay', []);
delay.dials.mix = 30;
dsp.add(1, 'chorus', 0); for (const [k, v] of slotProgram(chorus)) dsp.set(1, k, v, 0, true);
const kind = process.argv[2] || 'plugin', events = process.argv[3] === 'events';
if (kind === 'plugin') { dsp.add(2, 'plugin:netcomposer.tremolo@1.0.0', 0); for (const [k, v] of [[0, 1], [1, 5], [2, 60], [3, 2]]) dsp.set(2, k, v, 0, true); }
else { dsp.add(2, 'width', 0); for (const [k, v] of [[0, 1], [1, 1], [2, 0]]) dsp.set(2, k, v, 0, true); }
dsp.add(3, 'delay', 0); for (const [k, v] of slotProgram(delay)) dsp.set(3, k, v, 0, true);
dsp.order([1, 2, 3], 0, true);
const inL = new Float32Array(128).map((_, i) => Math.sin(i * 0.05) * 0.5), inR = inL.slice();
const oL = new Float32Array(128), oR = new Float32Array(128);
const vals = [0.5, 7.5, 12, 3]; // pre-boxed, as a worklet's messages are
const orders = [[1, 2, 3], [2, 1, 3]];
let f = 0;
const run = (n) => {
  for (let b = 0; b < n; b++) {
    if (events && b % 50 === 0) dsp.set(2, 1, vals[(b / 50) & 3], f + 17, false);
    if (events && b % 400 === 0) dsp.set(2, 0, (b / 400) & 1, f + 3, false);
    if (events && b % 1000 === 0) dsp.order(orders[(b / 1000) & 1], f + 5, false);
    dsp.process(inL, inR, oL, oR, 128, f);
    f += 128;
  }
};
run(6000);
const bytes = [];
globalThis.gc(); globalThis.gc();
for (let t = 0; t < 12; t++) {
  const a = process.memoryUsage().heapUsed;
  const probe = process.memoryUsage().heapUsed - a;
  const h0 = process.memoryUsage().heapUsed;
  run(2000);
  bytes.push(Math.max(0, process.memoryUsage().heapUsed - h0 - probe));
}
const sorted = bytes.slice().sort((x, y) => x - y);
process.stdout.write(JSON.stringify({ bytes, median: sorted[6] }) + '\n');
