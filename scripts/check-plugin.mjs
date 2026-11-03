#!/usr/bin/env node
// nc-fx-check: checks a NetComposer insert plugin (docs/plugins.md) the way the Studio will run it, and says what to
// fix. Run it until every line says PASS.
//
//   npx nc-fx-check <plugin folder | plugin.json | https://.../plugin.json> [--json] [--browser | --no-browser]
//                   [--budget-us 200] [--timeout 5]
//
// Node part (always): the manifest; the DSP file (one plain script, no imports); registration (id, version and
// params match the manifest); create() at 44.1, 48 and 96 kHz; test signals (silence, sine, noise, impulses, DC,
// full-scale square) at default, min, max and random settings, failing on NaN, infinity, runaway level or subnormal
// output; clicks when a dial jumps; denormal slowdown in silence; allocation on the audio path (a heap-delta gate
// in a child process); CPU per 128-frame block against a budget; bypass bit-transparent through nc-fx's real worklet
// engine; no writes to the input buffers. Browser part (when Playwright is installed, or --browser): loads the
// plugin with nc-fx's own loader into a real AudioWorklet in headless Chromium and renders it through a slot chain.
// Each check that runs the plugin's code runs in its own worker thread with a time limit (--timeout, in seconds,
// default 5): a check that does not finish in time is stopped and fails, and the rest still run.
// Exit 0 when nothing failed, 1 when something did, 2 for a usage error. nc-fx was created by Peter Semmelhack
// (https://psem.me/). MIT License.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { validateManifest } = await import(pathToFileURL(join(root, 'src/plugin.js')).href);
const { guardLoops } = await import(pathToFileURL(join(root, 'src/loop-guard.js')).href);
const WORKLET = readFileSync(join(root, 'dist/worklet.js'), 'utf8');
const BLOCK = 128;
/** The fix for a call the loop guard stopped (src/loop-guard.js: over 100 ms in one call, 1 s in create). */
const STUCK_FIX = 'a loop never ended (the Studio stops a plugin that loops past 100 ms in one call): make sure each while and for loop changes what its condition tests, and give it a bound (at most n samples)';
const MIN_NORMAL_F32 = 1.1754943508222875e-38;
/** What a check says when it ran past --timeout and was stopped. */
const timeoutMessage = (s) => `Timed out after ${s} s: the plugin may hang (for example a regular expression that never finishes)`;
const TIMEOUT_FIX = 'something in create(), process() or set() never finishes: a regular expression on a long string, a loop or a recursion with no end. In the Studio it would stop the sound';

// ---------------------------------------------------------------------------------------------------------------
// The audio thread, simulated: nc-fx's real worklet (dist/worklet.js) in a vm context, then the plugin's file.

function scope(sr, dsp, file) {
  const reg = {};
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage: (m) => this.port.sent.push(m), sent: [] }; } }
  const g = { AudioWorkletProcessor, sampleRate: sr, currentFrame: 0, currentTime: 0, registerProcessor: (n, c) => { reg[n] = c; }, console: { log() {}, warn() {}, error() {}, info() {} } };
  const ctx = vm.createContext(g);
  vm.runInContext(WORKLET, ctx, { filename: 'nc-fx/dist/worklet.js' });
  const calls = [];
  const real = ctx.registerNcFxPlugin;
  ctx.registerNcFxPlugin = (def) => { calls.push(timed(def, ctx)); return real(def); };
  let error = null;
  // With the loop guard on, as the Studio runs it: a plugin stuck in a loop throws "stuck in a loop" instead of
  // hanging the checker.
  try { vm.runInContext(guardLoops(dsp), ctx, { filename: file, timeout: 5000 }); } catch (e) { error = e; }
  return { ctx, Proc: reg['nc-fx@1'], calls, error };
}

// The checker calls a plugin's create, process, set and reset itself: time each call with the worklet's loop guard,
// as nc-fx's unit does (fixed arity: no allocation per call). Anything else on the definition passes through.
function timed(def, g) {
  if (!def || typeof def !== 'object' || typeof def.create !== 'function') return def;
  const start = g.__ncFxLoopStart, end = g.__ncFxLoopEnd;
  if (typeof start !== 'function') return def;
  const call = (budget, fn) => { start(budget); try { return fn(); } finally { end(); } };
  return Object.assign({}, def, {
    create(sr) {
      const inst = call(1000, () => def.create(sr));
      if (!inst || typeof inst !== 'object' || typeof inst.process !== 'function') return inst;
      const p = inst.process, st = inst.set, rs = inst.reset, w = Object.create(inst);
      w.process = function (a, b, c, d, n) { start(100); try { return p.call(inst, a, b, c, d, n); } finally { end(); } };
      if (typeof st === 'function') w.set = function (k, v) { start(100); try { return st.call(inst, k, v); } finally { end(); } };
      if (typeof rs === 'function') w.reset = function () { start(100); try { return rs.call(inst); } finally { end(); } };
      return w;
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Child mode: the allocation gate (fixed young generation: every byte allocated shows in heapUsed).
function allocChild() {
  const [, , , dspPath, manPath] = process.argv;
  const m = JSON.parse(readFileSync(manPath, 'utf8'));
  const s = scope(48000, readFileSync(dspPath, 'utf8'), dspPath);
  const def = s.calls[0];
  const inst = def.create(48000);
  m.params.forEach((p) => inst.set && inst.set(p.id, p.defaultValue));
  const inL = new Float32Array(BLOCK), inR = new Float32Array(BLOCK), oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
  let seed = 7;
  for (let i = 0; i < BLOCK; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; inL[i] = (seed / 4294967296 - 0.5) * 0.8; inR[i] = -inL[i]; }
  // Values for set(), boxed up front (as a worklet's message handler would have them).
  const moves = [];
  m.params.forEach((p) => { moves.push([p.id, p.minValue], [p.id, p.maxValue], [p.id, p.defaultValue]); });
  const run = (n, withSet) => {
    for (let b = 0; b < n; b++) {
      if (withSet && moves.length && b % 25 === 0) { const mv = moves[(b / 25) % moves.length]; inst.set(mv[0], mv[1]); }
      inst.process(inL, inR, oL, oR, BLOCK);
    }
  };
  const out = {};
  try {
  for (const withSet of [false, true]) {
    run(4000, withSet);
    const bytes = [];
    globalThis.gc(); globalThis.gc();
    for (let t = 0; t < 12; t++) {
      const a = process.memoryUsage().heapUsed;
      const probe = process.memoryUsage().heapUsed - a; // what reading heapUsed costs
      const h0 = process.memoryUsage().heapUsed;
      run(2000, withSet);
      bytes.push(Math.max(0, process.memoryUsage().heapUsed - h0 - probe));
    }
    // The median window: JIT warm-up can cost a stray window, and a scavenge inside one hides its bytes (0 B).
    const sorted = bytes.slice().sort((x, y) => x - y);
    out[withSet ? 'withSet' : 'steady'] = { median: sorted[6], bytes, setCalls: withSet && moves.length ? 2000 / 25 : 0 };
  }
  } catch (e) { out.error = String(e && e.message || e); }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments.
// Shared by the main thread (which prints) and the check workers (which post each result to it).
let JSON_OUT = false, BUDGET_US = 200, TIMEOUT_S = 5;
const results = [];
function report(id, ok, message, fix, data, level) {
  if (!isMainThread) { parentPort.postMessage({ t: 'report', args: [id, ok, message, fix, data, level] }); return; }
  const r = { id, ok, level: level || (ok ? 'pass' : 'fail'), message };
  if (!ok && fix) r.fix = fix;
  if (data !== undefined) r.data = data;
  results.push(r);
  if (!JSON_OUT) {
    const tag = r.level === 'warn' ? 'WARN' : r.level === 'skip' ? 'SKIP' : ok ? 'PASS' : 'FAIL';
    console.log(`${tag} ${id.padEnd(18)} ${message}`);
    if (!ok && fix) console.log(`     ${''.padEnd(18)} fix: ${fix}`);
  }
}
const warn = (id, message, fix, data) => report(id, true, message, undefined, data, 'warn') && undefined;
function finish() {
  const failed = results.filter((r) => r.level === 'fail');
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: failed.length === 0, plugin: plugin && { id: plugin.id, version: plugin.version, name: plugin.name }, checks: results }, null, 2) + '\n');
  else console.log(failed.length ? `RESULT FAIL: ${failed.length} of ${results.length} checks failed. Fix them and run again.` : `RESULT PASS: ${results.length} checks.`);
  process.exit(failed.length ? 1 : 0);
}
let manifestText, dspText, plugin = null;

// ---------------------------------------------------------------------------------------------------------------
// The checks that run the plugin's code. Each runs in a worker thread (see runSection) so that one that hangs can
// be stopped; s48 is the plugin loaded at 48 kHz in that worker.
let s48 = null, ids = [], defaults = {};
const SECTIONS = {
  // 3. Registration.
  register() {
    s48 = scope(48000, dspText, plugin.dsp);
    let def = null;
    if (s48.error) report('register', false, `the file threw while loading: ${s48.error.message}`, 'run it in your head top to bottom: only registerNcFxPlugin({...}) should run at load');
    else if (s48.calls.length !== 1) report('register', false, `registerNcFxPlugin was called ${s48.calls.length} times`, 'call registerNcFxPlugin({ id, version, params, create }) exactly once');
    else {
      def = s48.calls[0];
      const bad = [];
      if (!def || def.id !== plugin.id) bad.push(`id is ${JSON.stringify(def && def.id)}, plugin.json says "${plugin.id}"`);
      if (!def || def.version !== plugin.version) bad.push(`version is ${JSON.stringify(def && def.version)}, plugin.json says "${plugin.version}"`);
      if (!def || !Array.isArray(def.params) || def.params.join() !== ids.join()) bad.push(`params are ${JSON.stringify(def && def.params)}, plugin.json's ids in order are ${JSON.stringify(ids)}`);
      if (!def || typeof def.create !== 'function') bad.push('create(sampleRate) is missing');
      if (bad.length) { report('register', false, bad.join('; '), 'make registerNcFxPlugin\'s id, version and params match plugin.json exactly'); def = null; }
      else report('register', true, `registers ${plugin.id}@${plugin.version} with params [${ids.join(', ')}]`);
    }
  },
  // 4. create() and set().
  create() {
    try {
      for (const sr of [44100, 48000, 96000]) {
        const inst = make(sr);
        for (const p of plugin.params) for (const x of [p.minValue, p.maxValue, p.defaultValue]) inst.set && inst.set(p.id, x);
        if (inst.reset) inst.reset();
      }
      report('create', true, 'create() at 44.1, 48 and 96 kHz, set() at every param\'s min, max and default, reset()');
    } catch (e) {
      report('create', false, `threw: ${e.message}`, 'create(sampleRate) must return { set(key, value), process(inL, inR, outL, outR, frames), reset() }; set() must accept every value in range');
    }
  },
  // 5. Test signals at many settings: NaN, infinity, level, subnormal output, writes to the input.
  signals() {
    guarded('nan-inf', () => {
      const bad = [], hot = [], subs = [];
      let wrote = false, runs = 0;
      for (const [name, vals] of settingsList()) {
        for (const kind of ['silence', 'sine', 'noise', 'impulses', 'dc', 'square']) {
          const inst = make(SR);
          setAll(inst, vals);
          const [L, R] = signal(kind, SR); // 1 s
          const out = render(inst, L, R);
          runs++;
          if (out.wroteInput) wrote = true;
          const sc = scan(out);
          if (sc.nan) bad.push(`${kind} at ${name} (${describe(vals)}): ${sc.nan} NaN/infinite samples, first at sample ${sc.at}`);
          else if (sc.peak > 4) hot.push(`${kind} at ${name} (${describe(vals)}): peak ${sc.peak.toFixed(2)} (${(20 * Math.log10(sc.peak)).toFixed(1)} dBFS)`);
          if (sc.sub) subs.push(`${kind} at ${name}: ${sc.sub} subnormal samples`);
        }
      }
      if (bad.length) report('nan-inf', false, `${bad.length} run(s) made NaN or infinity: ${bad.slice(0, 3).join('; ')}`, 'look for 0/0, log(0), sqrt of a negative, a filter or feedback that blows up at extreme dials; clamp what you divide by');
      else report('nan-inf', true, `${runs} runs (6 signals x ${runs / 6} settings, 1 s each): no NaN or infinity`);
      if (hot.length) report('level', false, `${hot.length} run(s) went past +12 dBFS: ${hot.slice(0, 3).join('; ')}`, 'keep the output near the input level: limit feedback below 100 %, scale gain stages, or soft-clip (tanh)');
      else report('level', true, 'never past +12 dBFS (the host stops a plugin at +36 dBFS)');
      if (subs.length) report('denormal-out', false, `subnormal output: ${subs.slice(0, 3).join('; ')}`, 'flush tiny values to 0 (if (Math.abs(x) < 1e-30) x = 0), especially in feedback and smoothers');
      else report('denormal-out', true, 'no subnormal output samples');
      if (wrote) report('input', false, 'process() wrote into inL or inR', 'treat inL/inR as read-only; write only outL/outR');
      else report('input', true, 'inL and inR are left as they were');
    });
  },
  // 6. Runaway: extreme settings, loud noise, then silence. The tail must not grow.
  runaway() {
    guarded('runaway', () => {
      const fails = [];
      for (const [name, vals] of settingsList().slice(0, 3)) {
        const inst = make(SR);
        setAll(inst, vals);
        const [L, R] = signal('noise', SR * 2);
        render(inst, L, R);
        const quiet = render(inst, new Float32Array(SR * 4), new Float32Array(SR * 4));
        const peakAt = (from, to) => { let p = 0; for (const a of [quiet.L, quiet.R]) for (let i = from; i < to; i++) { const x = Math.abs(a[i]); if (x > p || x !== x) p = x !== x ? Infinity : x; } return p; };
        const early = peakAt(0, SR / 2), late = peakAt(SR * 3.5, SR * 4);
        if (!(late <= Math.max(0.1, early * 2))) fails.push(`${name}: after the input stops the output grows from ${early.toFixed(3)} to ${late.toFixed(3)}`);
      }
      if (fails.length) report('runaway', false, fails.join('; '), 'feedback must stay below 1 (clamp it), and every recursive filter must be stable at every dial setting');
      else report('runaway', true, 'tails die away (or hold) after the input stops, at default, min and max settings');
    });
  },
  // 7. Clicks: each dial jumps min -> max -> min on a sine; the jump must not step harder than the steady sound.
  clicks() {
    guarded('clicks', () => {
      const maxDelta = (a, from, to) => { let d = 0; for (let i = Math.max(1, from); i < to; i++) { const x = Math.abs(a[i] - a[i - 1]); if (x > d) d = x; } return d; };
      const clicks = [];
      for (const p of plugin.params) {
        for (const [a, b] of [[p.minValue, p.maxValue], [p.maxValue, p.minValue]]) {
          const inst = make(SR);
          setAll(inst, { ...defaults, [p.id]: a });
          const [L, R] = signal('sine', SR * 2);
          const jumpAt = SR + 7 * BLOCK; // block-aligned, and not on a zero crossing of the 220 / 330 Hz sines
          const out = render(inst, L, R, BLOCK, (blk, o) => { if (o === jumpAt && inst.set) inst.set(p.id, b); });
          const steady = Math.max(maxDelta(out.L, jumpAt - SR / 4, jumpAt), maxDelta(out.L, SR * 2 - SR / 4, SR * 2), maxDelta(out.R, jumpAt - SR / 4, jumpAt), maxDelta(out.R, SR * 2 - SR / 4, SR * 2));
          const jump = Math.max(maxDelta(out.L, jumpAt, jumpAt + SR / 100), maxDelta(out.R, jumpAt, jumpAt + SR / 100));
          if (jump > 2 * steady + 0.02) clicks.push(`${p.id} ${a} -> ${b}: a step of ${jump.toFixed(3)} against ${steady.toFixed(3)} steady`);
        }
      }
      if (clicks.length) report('clicks', false, `${clicks.length} dial jump(s) click: ${clicks.slice(0, 3).join('; ')}`, 'smooth the value inside process() (a one-pole: x += (target - x) * k, k for 2-20 ms) instead of jumping to it');
      else report('clicks', true, `${plugin.params.length * 2} dial jumps (min to max and back) on a sine: no clicks`);
    });
  },
  // 8. Block sizes: the host may pass 1-128 frames.
  'block-size'() {
    guarded('block-size', () => {
      const inst1 = make(SR), inst2 = make(SR);
      setAll(inst1, defaults); setAll(inst2, defaults);
      const [L, R] = signal('noise', SR / 2, 3);
      const a = render(inst1, L, R, 128), b = render(inst2, L, R, 37);
      const sc = scan(b);
      let same = true;
      for (let i = 0; i < a.L.length && same; i++) if (Math.abs(a.L[i] - b.L[i]) > 1e-6 || Math.abs(a.R[i] - b.R[i]) > 1e-6) same = false;
      if (sc.nan) report('block-size', false, 'blocks of 37 frames make NaN or infinity', 'loop to `frames`, never to inL.length or 128');
      else if (!same) warn('block-size', 'blocks of 37 frames sound slightly different from blocks of 128 (fine if you update something once per block)');
      else report('block-size', true, 'blocks of 37 frames sound exactly like blocks of 128');
    });
  },
  // 9. CPU per block, and the denormal slowdown in silence.
  cpu() {
    guarded('cpu', () => {
      let worst = 0, worstName = '';
      for (const [name, vals] of settingsList().slice(0, 3)) {
        const inst = make(SR);
        setAll(inst, vals);
        const [L, R] = signal('noise', BLOCK);
        timeBlocks(inst, L, R, 3000); // warm up
        const us = timeBlocks(inst, L, R, 5000);
        if (us > worst) { worst = us; worstName = name; }
      }
      const pct = (worst / (BLOCK / SR * 1e6)) * 100;
      if (worst > BUDGET_US) report('cpu', false, `${worst.toFixed(1)} µs per 128-frame block at ${worstName} (budget ${BUDGET_US} µs; ${pct.toFixed(1)} % of the audio thread at 48 kHz)`, 'do less per sample: update coefficients per block or when a dial moves, use tables, avoid Math.pow/exp per sample', { us: worst });
      else report('cpu', true, `${worst.toFixed(1)} µs per 128-frame block at worst (${worstName}); budget ${BUDGET_US} µs; ${pct.toFixed(1)} % of the audio thread at 48 kHz`, undefined, { us: worst });
      // Denormals inside the state show as CPU that climbs in silence after a sound.
      const inst = make(SR);
      setAll(inst, defaults);
      const [L, R] = signal('noise', SR);
      render(inst, L, R);
      const loud = timeBlocks(inst, L, R, 2000);
      const z = new Float32Array(BLOCK);
      render(inst, new Float32Array(SR * 20), new Float32Array(SR * 20)); // 20 s of silence: anything decaying gets tiny
      const quiet = timeBlocks(inst, z, z, 2000);
      if (quiet > 4 * loud && quiet > 20) report('denormal-cpu', false, `CPU climbs from ${loud.toFixed(1)} to ${quiet.toFixed(1)} µs per block after 20 s of silence`, 'something decays toward 0 forever: snap it to 0 below 1e-30 (filters, envelopes, smoothers, feedback)');
      else report('denormal-cpu', true, `CPU in long silence ${quiet.toFixed(1)} µs per block (with sound ${loud.toFixed(1)})`);
    });
  },
  // 11. Bypass and the real engine: nc-fx's slot chain in the simulated worklet, the plugin in a slot.
  engine() {
    {
      const engine = plugin.id + '@' + plugin.version;
      const program = [[0, 0]].concat(plugin.params.map((p, i) => [i + 1, p.defaultValue]));
      const [L, R] = signal('noise', SR, 5);
      const fails = [];
      let differs = false, perr = null;
      for (const bypassMode of ['run', 'hold']) {
        const s = scope(SR, dspText, plugin.dsp);
        const proc = new s.Proc({ processorOptions: { slots: 1, bypassMode, chain: [{ uid: 1, type: 'plugin:' + engine, program }], order: [1] } });
        const outB = new Float32Array(SR), outOn = new Float32Array(SR);
        for (let o = 0; o < SR; o += BLOCK) {
          s.ctx.currentFrame = o;
          const oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
          proc.process([[L.subarray(o, o + BLOCK), R.subarray(o, o + BLOCK)]], [[oL, oR]]);
          for (let i = 0; i < BLOCK; i++) { outB[o + i] = oL[i]; if (!Object.is(oL[i], L[o + i]) || !Object.is(oR[i], R[o + i])) { if (fails.length < 1) fails.push(`${bypassMode}: sample ${o + i} is ${oL[i]}, the input was ${L[o + i]}`); } }
        }
        proc.port.onmessage({ data: { t: 'ps', uid: 1, k: 0, v: 1, snap: true } });
        for (let o = 0; o < SR; o += BLOCK) {
          s.ctx.currentFrame = SR + o;
          const oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
          proc.process([[L.subarray(o, o + BLOCK), R.subarray(o, o + BLOCK)]], [[oL, oR]]);
          for (let i = 0; i < BLOCK; i++) { outOn[o + i] = oL[i]; if (oL[i] !== L[o + i]) differs = true; }
        }
        const e = proc.port.sent.find((m) => m && m.t === 'perr');
        if (e) perr = e;
      }
      if (perr) report('engine', false, `nc-fx stopped the plugin (code ${perr.d[1]}: ${['', 'it failed to start', 'process() threw', 'bad numbers or past +36 dBFS', 'set() threw', 'not registered', 'stuck in a loop past its time budget'][perr.d[1]]})`, 'see the checks above; the Studio shows this on the card and bypasses the slot');
      else report('engine', true, 'runs in nc-fx\'s slot chain (the real worklet engine) without being stopped');
      if (fails.length) report('bypass', false, `bypassed output is not the input: ${fails[0]}`, 'this is the host\'s job: report it to nc-fx (an nc-fx bug)');
      else report('bypass', true, 'bypassed (bypassMode run and hold) the output is the input, bit for bit');
      if (!differs) warn('audible', 'switched on at its defaults it leaves the sound exactly as it was', 'fine for a utility; otherwise pick defaults you can hear');
    }
  },
};
/** The check ids each section reports: the ones it had not reported yet fail when it times out. */
const SECTION_IDS = { register: ['register'], create: ['create'], signals: ['nan-inf', 'level', 'denormal-out', 'input'], runaway: ['runaway'], clicks: ['clicks'], 'block-size': ['block-size'], cpu: ['cpu', 'denormal-cpu'], engine: ['engine', 'bypass'] };

// Helpers for the sections.
function make(sr) {
  const s = sr === 48000 ? s48 : scope(sr, dspText, plugin.dsp);
  const inst = s.calls[0].create(sr);
  if (!inst || typeof inst.process !== 'function') throw new Error('create() did not return { process }');
  return inst;
}
function setAll(inst, values) {
  for (const p of plugin.params) if (inst.set) {
    try { inst.set(p.id, values[p.id]); } catch (e) { throw new Threw(`set('${p.id}', ${values[p.id]}) threw "${e && e.message}"`); }
  }
}
// ---------------------------------------------------------------------------------------------------------------
// 5. Test signals.
const SR = 48000;
function signal(kind, n, seed = 1) {
  const L = new Float32Array(n), R = new Float32Array(n);
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    if (kind === 'sine') { x = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR); y = 0.5 * Math.sin(2 * Math.PI * 330 * i / SR); }
    else if (kind === 'noise') { x = rnd() * 2 - 1; y = rnd() * 2 - 1; }
    else if (kind === 'impulses') { x = y = i % 12000 === 0 ? 1 : 0; }
    else if (kind === 'dc') { x = y = 1; }
    else if (kind === 'square') { x = y = (i % 218) < 109 ? 1 : -1; }
    L[i] = x; R[i] = y;
  }
  return [L, R];
}
/** Run inst over a signal; returns { L, R, wroteInput }. */
class Threw extends Error {}
/** A test section: a throw from the plugin fails it (named), anything else is the checker's own bug. */
function guarded(id, fn) {
  try { fn(); } catch (e) {
    if (!(e instanceof Threw)) throw e;
    report(id, false, e.message, /stuck in a loop/.test(e.message) ? STUCK_FIX : 'process() and set() must never throw: check array bounds, and guard every value a dial can reach');
  }
}
function render(inst, L, R, block = BLOCK, onBlock) {
  const n = L.length, oL = new Float32Array(n), oR = new Float32Array(n);
  const iL = new Float32Array(BLOCK), iR = new Float32Array(BLOCK), bL = new Float32Array(BLOCK), bR = new Float32Array(BLOCK);
  let wroteInput = false;
  for (let o = 0, b = 0; o < n; o += block, b++) {
    const f = Math.min(block, n - o);
    if (onBlock) onBlock(b, o);
    for (let i = 0; i < f; i++) { iL[i] = L[o + i]; iR[i] = R[o + i]; }
    bL.fill(0); bR.fill(0);
    try { inst.process(iL, iR, bL, bR, f); } catch (e) { throw new Threw(`process() threw "${e && e.message}" at block ${b}`); }
    for (let i = 0; i < f; i++) { if (iL[i] !== L[o + i] || iR[i] !== R[o + i]) wroteInput = true; oL[o + i] = bL[i]; oR[o + i] = bR[i]; }
  }
  return { L: oL, R: oR, wroteInput };
}
function scan(out) {
  let nan = 0, sub = 0, peak = 0, at = -1;
  for (const a of [out.L, out.R]) for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x !== x || x === Infinity || x === -Infinity) { if (!nan && at < 0) at = i; nan++; continue; }
    const ax = Math.abs(x);
    if (ax > 0 && ax < MIN_NORMAL_F32) sub++;
    if (ax > peak) peak = ax;
  }
  return { nan, sub, peak, at };
}
function settingsList() {
  const list = [['defaults', { ...defaults }]];
  list.push(['all min', Object.fromEntries(plugin.params.map((p) => [p.id, p.minValue]))]);
  list.push(['all max', Object.fromEntries(plugin.params.map((p) => [p.id, p.maxValue]))]);
  for (const p of plugin.params) {
    list.push([`${p.id}=min`, { ...defaults, [p.id]: p.minValue }]);
    list.push([`${p.id}=max`, { ...defaults, [p.id]: p.maxValue }]);
  }
  let s = 99;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let k = 0; k < 6; k++) list.push([`random ${k + 1}`, Object.fromEntries(plugin.params.map((p) => {
    const st = p.discreteStep || 0.001, x = p.minValue + rnd() * (p.maxValue - p.minValue);
    return [p.id, Math.min(p.maxValue, Math.max(p.minValue, Math.round(x / st) * st))];
  }))]);
  return list;
}
const describe = (vals) => plugin.params.map((p) => `${p.id} ${vals[p.id]}`).join(', ');
const timeBlocks = (inst, L, R, blocks) => {
  const iL = L.subarray(0, BLOCK), iR = R.subarray(0, BLOCK), oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
  const chunk = [];
  for (let c = 0; c < 10; c++) {
    const t0 = process.hrtime.bigint();
    try { for (let b = 0; b < blocks / 10; b++) inst.process(iL, iR, oL, oR, BLOCK); } catch (e) { throw new Threw(`process() threw "${e && e.message}" while timing`); }
    chunk.push(Number(process.hrtime.bigint() - t0) / 1000 / (blocks / 10));
  }
  chunk.sort((x, y) => x - y);
  return chunk[5];
};

/** In a worker: load the plugin (unless this is the registration check, which does that itself), run one section. */
function workerMain() {
  ({ manifestText, dspText, plugin, BUDGET_US } = workerData);
  ids = plugin.params.map((p) => p.id);
  defaults = Object.fromEntries(plugin.params.map((p) => [p.id, p.defaultValue]));
  parentPort.postMessage({ t: 'ready' });
  if (workerData.ncFxCheck !== 'register') s48 = scope(48000, dspText, plugin.dsp);
  SECTIONS[workerData.ncFxCheck]();
  parentPort.postMessage({ t: 'done' });
}

/** In the main thread: run a section in a worker, stop it after TIMEOUT_S, and fail what it had not reported. */
function runSection(name) {
  return new Promise((done) => {
    const reported = new Set();
    let timer = null, over = false;
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { ncFxCheck: name, manifestText, dspText, plugin, BUDGET_US }, stdout: true, stderr: true });
    const end = (why) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      for (const id of SECTION_IDS[name]) if (!reported.has(id)) {
        if (why === 'timeout') report(id, false, timeoutMessage(TIMEOUT_S), TIMEOUT_FIX);
        else if (why) report(id, false, `the check could not finish: ${why}`, 'process() and set() must never throw');
      }
      w.terminate().then(() => done(), () => done());
    };
    w.on('message', (m) => {
      if (m.t === 'ready') timer = setTimeout(() => end('timeout'), TIMEOUT_S * 1000);
      else if (m.t === 'report') { reported.add(m.args[0]); report(...m.args); }
      else if (m.t === 'done') end(null);
    });
    w.on('error', (e) => end(String(e && e.message || e).split('\n')[0]));
    w.on('exit', () => end(over ? null : 'the worker exited'));
  });
}

// ---------------------------------------------------------------------------------------------------------------
async function main() {
  // Arguments.
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--budget-us', '--timeout'].includes(args[i - 1])));
  if (!target || flag('--help')) {
    console.error('usage: nc-fx-check <plugin folder | plugin.json | https://.../plugin.json> [--json] [--browser | --no-browser] [--budget-us 200] [--timeout 5]');
    process.exit(2);
  }
  JSON_OUT = flag('--json');
  BUDGET_US = +opt('--budget-us', '200');
  TIMEOUT_S = +opt('--timeout', '5');
  if (!(TIMEOUT_S > 0)) { console.error('--timeout is in seconds and must be more than 0'); process.exit(2); }

  // ---------------------------------------------------------------------------------------------------------------
  // Load the files.
  let manifestUrl, dspPath = null, manifestPath = null;
  try {
    if (/^https?:\/\//.test(target)) {
      manifestUrl = target;
      const r = await fetch(target);
      if (!r.ok) throw new Error(`${target} answered ${r.status}`);
      manifestText = await r.text();
    } else {
      const p = resolve(target);
      manifestPath = existsSync(p) && statSync(p).isDirectory() ? join(p, 'plugin.json') : p;
      if (!existsSync(manifestPath)) throw new Error(`no plugin.json at ${manifestPath}`);
      manifestText = readFileSync(manifestPath, 'utf8');
    }
  } catch (e) {
    report('files', false, String(e.message || e), 'point nc-fx-check at the folder that holds plugin.json');
    finish();
  }

  // 1. The manifest.
  let raw;
  try { raw = JSON.parse(manifestText); } catch (e) {
    report('manifest', false, `plugin.json is not valid JSON (${e.message})`, 'check commas and quotes; https://jsonlint.com shows where');
    finish();
  }
  const v = validateManifest(raw);
  if (!v.ok) {
    report('manifest', false, `${v.errors.length} problem(s): ${v.errors.join('; ')}`, 'edit plugin.json; schema/plugin-manifest.schema.json lists every field');
    finish();
  }
  plugin = v.manifest;
  report('manifest', true, `${plugin.name} ${plugin.version} (${plugin.id}) by ${plugin.author}, ${plugin.licence}, ${plugin.params.length} param(s)`);

  // 2. The DSP file.
  try {
    if (manifestUrl) {
      const r = await fetch(new URL(plugin.dsp, manifestUrl));
      if (!r.ok) throw new Error(`${plugin.dsp} answered ${r.status}`);
      dspText = await r.text();
    } else {
      dspPath = join(dirname(manifestPath), plugin.dsp);
      dspText = readFileSync(dspPath, 'utf8');
    }
  } catch (e) {
    report('dsp-file', false, `can't read the DSP file: ${e.message}`, `put ${plugin.dsp} next to plugin.json, or fix "dsp"`);
    finish();
  }
  {
    const kb = Buffer.byteLength(dspText) / 1024;
    const problems = [];
    if (/^\s*(import|export)\b/m.test(dspText)) problems.push('it has import/export lines');
    if (kb > 256) problems.push(`it is ${kb.toFixed(0)} KB (max 256 KB)`);
    if (problems.length) report('dsp-file', false, problems.join('; '), 'one plain script with everything inline: no import or export (it is loaded with audioWorklet.addModule from a Blob)');
    else report('dsp-file', true, `${plugin.dsp}, ${kb.toFixed(1)} KB, one plain script`);
    const odd = ['document', 'window', 'fetch', 'XMLHttpRequest', 'localStorage', 'WebSocket', 'importScripts', 'eval', 'new Function'].filter((w) => new RegExp(`\\b${w.replace(' ', '\\s+')}\\b`).test(dspText.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
    if (odd.length) warn('dsp-scope', `uses ${odd.join(', ')}: not there in an AudioWorklet (or not allowed in listed plugins)`, 'remove them: the DSP only turns input into output');
  }

  // 3. and 4.: registration, create() and set(). Nothing else can run without them.
  for (const name of ['register', 'create']) {
    await runSection(name);
    if (results.some((r) => r.id === name && r.level === 'fail')) finish();
  }
  // 5. to 9.
  for (const name of ['signals', 'runaway', 'clicks', 'block-size', 'cpu']) await runSection(name);

  // 10. Allocation on the audio path: a child process with a fixed young generation.
  if (dspPath && manifestPath) {
    try {
      const out = execFileSync(process.execPath, ['--expose-gc', '--min-semi-space-size=64', '--max-semi-space-size=64', fileURLToPath(import.meta.url), '--alloc-child', dspPath, manifestPath], { encoding: 'utf8', timeout: TIMEOUT_S * 1000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
      const r = JSON.parse(out.trim().split('\n').pop());
      if (r.error) report('alloc', false, `process() or set() threw "${r.error}"`, /stuck in a loop/.test(r.error) ? STUCK_FIX : 'process() and set() must never throw');
      else if (r.steady.median > 0) report('alloc', false, `process() allocates: about ${r.steady.median} bytes per 2000 blocks (${Math.round(r.steady.median / 2000)} per block)`, 'no new arrays or objects, closures, array methods (map, slice, push), string building or console in process(); make buffers in create()', r);
      // set() runs only when a dial moves, so V8 may run it unoptimised, which boxes a number or two (a few bytes a
      // call, like the message that carried the value). An array or object per call is more than 32 bytes.
      else if (r.withSet.setCalls && r.withSet.median / r.withSet.setCalls > 32) report('alloc', false, `set() allocates about ${Math.round(r.withSet.median / r.withSet.setCalls)} bytes per call`, 'set() runs on the audio thread too: store the value (in a typed array), don\'t build arrays, objects or strings there', r);
      else report('alloc', true, `process() allocates nothing (0 B per 2000-block window); set() ${r.withSet.setCalls ? Math.round(r.withSet.median / r.withSet.setCalls) + ' B per call' : 'not used'}`, undefined, r);
    } catch (e) {
      if (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL') report('alloc', false, timeoutMessage(TIMEOUT_S), TIMEOUT_FIX);
      else report('alloc', false, `the allocation check could not run: ${String(e.message).split('\n')[0]}`, 'make sure the plugin runs in Node 20+');
    }
  } else report('alloc', true, 'skipped for a URL (run it on the folder to check allocation)', undefined, undefined, 'skip');

  // 11.
  await runSection('engine');

  // 12. In a real browser.
  if (!flag('--no-browser')) {
    let pw = null;
    try { pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch { pw = null; }
    if (!pw) {
      if (flag('--browser')) report('browser', false, 'Playwright is not installed', 'npm i -D playwright && npx playwright install chromium (or set PLAYWRIGHT_MODULE)');
      else report('browser', true, 'skipped: Playwright is not installed (npm i -D playwright, or --browser to require it)', undefined, undefined, 'skip');
    } else {
      try {
        const r = await browserCheck(pw.chromium || pw.default.chromium);
        if (r.timedOut) report('browser', false, `in Chromium: ${timeoutMessage(TIMEOUT_S)}`, TIMEOUT_FIX);
        else if (r.error) report('browser', false, `in Chromium: ${r.error}`, 'open the Studio, load the plugin from a local server and read the console');
        else report('browser', true, `loaded with nc-fx's loader into a real AudioWorklet (Chromium ${r.version}): it plays (peak ${r.peak.toFixed(3)}), and bypassed it is the input bit for bit`);
      } catch (e) {
        const why = String(e.message).split('\n')[0];
        // No browser binary (npm i playwright without `playwright install`): skipped unless --browser asked for it.
        if (flag('--browser')) report('browser', false, `Chromium check could not run: ${why}`, 'npx playwright install chromium');
        else report('browser', true, `skipped: Chromium could not start (${why}); npx playwright install chromium, or --browser to require it`, undefined, undefined, 'skip');
      }
    }
  }
  finish();
}

async function browserCheck(chromium) {
  const files = new Map();
  const ORIGIN = 'https://nc-fx-check.invalid';
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(`${ORIGIN}/**`, async (route) => {
      const p = new URL(route.request().url()).pathname;
      const type = p.endsWith('.json') ? 'application/json' : p.endsWith('.html') ? 'text/html' : 'text/javascript';
      if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>nc-fx-check</title>' });
      if (p === '/plugin/plugin.json') return route.fulfill({ status: 200, contentType: type, body: manifestText });
      if (p === '/plugin/' + plugin.dsp) return route.fulfill({ status: 200, contentType: type, body: dspText });
      if (p.startsWith('/nc-fx/')) {
        const f = join(root, p.slice(7));
        if (!files.has(f)) files.set(f, existsSync(f) ? readFileSync(f, 'utf8') : null);
        if (files.get(f) !== null) return route.fulfill({ status: 200, contentType: type, body: files.get(f) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    // The time limit starts once Chromium is up: loading the page, the plugin and both renders.
    let timer = null;
    const late = new Promise((r) => { timer = setTimeout(() => r({ timedOut: true }), TIMEOUT_S * 1000); });
    const work = page.goto(`${ORIGIN}/`).then(() => page.evaluate(async ({ type }) => {
      try {
        const fx = await import('/nc-fx/src/index.js');
        const run = async (bypass) => {
          const ctx = new OfflineAudioContext(2, 48000, 48000);
          // No moduleUrl: nc-fx's Blob-URL fallback (worklet-source.js), as a plugin's DSP is loaded from a Blob too.
          await fx.loadPlugin(ctx, '/plugin/plugin.json');
          const core = fx.createFxCore(ctx, { slots: 1, crossfade: 0 });
          const id = core.addEffect(type, { bypass });
          await core.ready;
          const buf = ctx.createBuffer(2, 48000, 48000);
          for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * (c ? 330 : 220) * i / 48000); }
          const src = ctx.createBufferSource(); src.buffer = buf;
          src.connect(core.input); core.output.connect(ctx.destination); src.start();
          const out = await ctx.startRendering();
          const chain = core.getChain();
          return { out: out.getChannelData(0), dry: buf.getChannelData(0), status: chain[0] && chain[0].plugin && chain[0].plugin.status, id };
        };
        const on = await run(false);
        let peak = 0, bad = 0;
        for (const x of on.out) { if (x !== x || Math.abs(x) === Infinity) bad++; else if (Math.abs(x) > peak) peak = Math.abs(x); }
        if (!on.id) return { error: 'the slot chain did not take the plugin' };
        if (bad) return { error: `${bad} NaN/infinite samples` };
        if (peak < 1e-4) return { error: 'silent: nothing came out (did registerNcFxPlugin run? is the slot on?)' };
        const off = await run(true);
        for (let i = 0; i < off.out.length; i++) if (off.out[i] !== off.dry[i]) return { error: `bypassed, sample ${i} is ${off.out[i]}, the input was ${off.dry[i]}` };
        return { peak, version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '?' };
      } catch (e) { return { error: String(e && e.message || e) }; }
    }, { type: 'plugin:' + plugin.id }));
    work.catch(() => {}); // after a time-out, closing the browser rejects it
    try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
  } finally {
    // A page stuck in the plugin still closes; if Chromium does not answer, finish() exits and takes it with it.
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000).unref())]);
  }
}

// Workers run one section, --alloc-child is the allocation gate, anything else is the checker.
if (!isMainThread && workerData && workerData.ncFxCheck) workerMain();
else if (process.argv[2] === '--alloc-child') allocChild();
else await main();
