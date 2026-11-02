// nc-fx plugin host, audio thread: the registry a plugin's DSP file calls (registerNcFxPlugin) and the unit that runs
// a registered plugin as one box of the slot chain (src/chain.js), next to the built-in effects.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// Pure ES2019, no imports: scripts/build.mjs inlines this file into dist/worklet.js (after src/units.js, before
// src/chain.js), and it defines globalThis.registerNcFxPlugin in the worklet's scope, so a plugin's DSP file (loaded
// with audioWorklet.addModule after nc-fx's own module) can register itself. See docs/plugins.md for the contract.
//
// A plugin's DSP never sees the chain's per-sample contract (units.js): it gets blocks of 1-128 frames, in place of
// the box's step(). The unit around it does what every built-in unit does for itself:
//   - the on/off crossfade (the same 20 ms smoother and equal-power smoothstep as units.js finish()), so a bypassed
//     plugin's output is its input, bit for bit, and switching it is click-free;
//   - 'hold' (the core's bypassMode): fully off, the plugin isn't called at all;
//   - a guard: if create(), set(), process() or reset() throws, or process() writes NaN, an infinity or a sample past
//     +-64 (+36 dBFS: runaway feedback), the unit stops calling the plugin and passes its input through (the block it
//     caught is replaced by the dry input). It reports once (ctl OP_ERR), and the processor tells the main thread,
//     which shows it on the card. A fresh add of the plugin (a new slot) gets a fresh chance;
//   - a ceiling: a plugin's output is held within +-4 (+12 dBFS, the checker's level limit), so a plugin that gets
//     too loud, but not loud enough to count as runaway, can't blast the rest of the chain. A plugin that passes
//     nc-fx-check never reaches it, so it changes nothing for one that does;
//   - subnormal samples from the plugin are flushed to 0 (below 1e-30), so a decaying tail can't slow the chain.
// Every buffer is made when the unit is made (on the control path); run() allocates nothing.

/** Plugin unit type codes start here (after the 12 built-in units, UNIT_TYPES). */
export var PLUGIN_BASE = 12;
/** The most frames a plugin's process() is given at once. */
export var PLUGIN_BLOCK = 128;
/** Params a plugin may have (the chain's 16 per box, less the on flag). */
export var PLUGIN_MAX_PARAMS = 15;
/** ctl() op: the unit's error code (0 none). */
export var OP_ERR = 13;
/** Error codes (the main thread names them: src/plugin.js PLUGIN_ERRORS). */
export var PERR_CREATE = 1, PERR_PROCESS = 2, PERR_OUTPUT = 3, PERR_SET = 4, PERR_MISSING = 5;
var RUNAWAY = 64;
/** The most a plugin's output may be (+12 dBFS): louder samples are held there. */
export var PLUGIN_CEILING = 4;
var PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** Registered plugins, in registration order (code = PLUGIN_BASE + index). */
export var NC_PLUGINS = [];

/** A plugin's engine name: 'plugin:<id>@<version>'. */
export function pluginEngineName(id, version) { return 'plugin:' + id + '@' + version; }

/**
 * Called by a plugin's DSP file: registerNcFxPlugin({ id, version, params: ['rate', ...], create(sampleRate) }).
 * Returns true when it is registered (or already was, the same id and version). Never throws: a bad definition is
 * refused (false) with one console line, and loading it in a slot reports a missing plugin.
 */
export function registerNcFxPlugin(def) {
  var why = '';
  if (!def || typeof def !== 'object') why = 'no definition';
  else if (typeof def.id !== 'string' || !PLUGIN_ID.test(def.id) || def.id.length > 64) why = 'id must be lowercase letters and digits, dots or dashes between';
  else if (typeof def.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(def.version)) why = 'version must be x.y.z';
  else if (!Array.isArray(def.params) || def.params.length > PLUGIN_MAX_PARAMS || def.params.some(function (p) { return typeof p !== 'string'; })) why = 'params must be up to 15 param ids';
  else if (typeof def.create !== 'function') why = 'create(sampleRate) is missing';
  if (why) {
    if (typeof console !== 'undefined') console.error('nc-fx plugin refused: ' + why);
    return false;
  }
  var name = pluginEngineName(def.id, def.version);
  for (var i = 0; i < NC_PLUGINS.length; i++) if (NC_PLUGINS[i].name === name) return true;
  NC_PLUGINS.push({ name: name, id: def.id, version: def.version, params: def.params.slice(), create: def.create });
  return true;
}
/** A registered plugin's unit type code, or -1. */
export function pluginCode(name) {
  for (var i = 0; i < NC_PLUGINS.length; i++) if (NC_PLUGINS[i].name === name) return PLUGIN_BASE + i;
  return -1;
}
if (typeof globalThis !== 'undefined' && typeof globalThis.registerNcFxPlugin !== 'function') globalThis.registerNcFxPlugin = registerNcFxPlugin;

/**
 * The unit for registered plugin `code` on env E (units.js). Allocates: control path only. Besides the unit
 * contract it has `block: 1` and run(BL, BR, from, to, n): BL/BR (Float64Array) hold the box's input at
 * [from, from + n) and get its output there.
 */
export function createPluginUnit(E, code) {
  var def = NC_PLUGINS[code - PLUGIN_BASE];
  var sr = E.sr, keys = def.params, np = keys.length;
  var iL = new Float32Array(PLUGIN_BLOCK), iR = new Float32Array(PLUGIN_BLOCK);
  var oL = new Float32Array(PLUGIN_BLOCK), oR = new Float32Array(PLUGIN_BLOCK);
  // 0 on smoother, 1 its target, 2 error code, 3 asleep ('hold', fully off), 4 error reported
  var A = new Float64Array(5);
  var P = new Float64Array(np);
  var inst = null;
  try { inst = def.create(sr); } catch (e) { inst = null; }
  if (!inst || typeof inst.process !== 'function') { inst = null; A[2] = PERR_CREATE; }
  var hasSet = !!(inst && typeof inst.set === 'function'), hasReset = !!(inst && typeof inst.reset === 'function');
  function fail(code) { if (A[2] === 0) A[2] = code; }
  function reset() {
    if (inst === null || A[2] !== 0 || !hasReset) return;
    try { inst.reset(); } catch (e) { fail(PERR_PROCESS); }
  }
  function set(k, snap) {
    if (k < 0) return false;
    if (k === 0) {
      var x0 = E.V[0] ? 1 : 0;
      E.V[0] = x0;
      if (x0 && A[3] === 1) { reset(); A[3] = 0; }
      A[1] = x0;
      if (snap) A[0] = x0;
      return true;
    }
    if (k > np) return false;
    var v = E.V[0];
    if (v !== v || v === Infinity || v === -Infinity) return false;
    P[k - 1] = v;
    if (inst !== null && A[2] === 0 && hasSet) {
      try { inst.set(keys[k - 1], v); } catch (e) { fail(PERR_SET); }
    }
    return true;
  }
  function run(BL, BR, from, n) {
    var k = E.kFast, b = A[0], t = A[1], j, x, y;
    // 'hold' and fully off: the plugin sleeps (no CPU), the box is a wire.
    if (E.hold && t === 0 && b <= 0.001) { A[3] = 1; A[0] = b + (t - b) * k; return; }
    if (inst === null || A[2] !== 0) { A[0] = b; for (j = 0; j < n; j++) b += (t - b) * k; A[0] = b; return; }
    for (j = 0; j < n; j++) { iL[j] = BL[from + j]; iR[j] = BR[from + j]; oL[j] = 0; oR[j] = 0; }
    try { inst.process(iL, iR, oL, oR, n); } catch (e) { fail(PERR_PROCESS); }
    if (A[2] === 0) {
      for (j = 0; j < n; j++) {
        x = oL[j]; y = oR[j];
        if (!(x > -RUNAWAY && x < RUNAWAY && y > -RUNAWAY && y < RUNAWAY)) { fail(PERR_OUTPUT); break; }
      }
    }
    if (A[2] !== 0) { for (j = 0; j < n; j++) b += (t - b) * k; A[0] = b; return; } // the dry input stays in BL/BR
    for (j = 0; j < n; j++) {
      b += (t - b) * k;
      x = oL[j]; y = oR[j];
      if (x > -1e-30 && x < 1e-30) x = 0;
      if (y > -1e-30 && y < 1e-30) y = 0;
      if (x > 4) x = 4; else if (x < -4) x = -4; // PLUGIN_CEILING, as a literal: no lookup on the audio path
      if (y > 4) y = 4; else if (y < -4) y = -4;
      if (b >= 0.999) { BL[from + j] = x; BR[from + j] = y; }
      else if (b > 0.001) {
        var xt = (b - 0.001) * 1.002004008016032, xs = xt * xt * (3 - 2 * xt);
        var dryG = Math.cos(xs * 1.5707963267948966), wetG = Math.sin(xs * 1.5707963267948966);
        BL[from + j] = dryG * BL[from + j] + wetG * x;
        BR[from + j] = dryG * BR[from + j] + wetG * y;
      }
      // b <= 0.001: bypassed; the dry input stays, bit for bit (the plugin still ran, so tails carry on)
    }
    A[0] = b;
  }
  function ctl(op, a) {
    switch (op) {
      case 1: reset(); return 1; // OP_CLEAR
      case 3: return a; // OP_FADE_WORK: no tail clearing of ours
      case 5: return 1; // OP_FADE_IDLE
      case 11: if (A[0] !== A[1] && Math.abs(A[0] - A[1]) < 1e-30) A[0] = A[1]; return 1; // OP_SETTLE
      case 12: A[0] = 0; A[1] = 0; A[3] = 0; if (A[2] === PERR_SET || A[2] === PERR_PROCESS || A[2] === PERR_OUTPUT) { if (inst !== null) A[2] = 0; } A[4] = 0; reset(); return 1; // OP_RESET
      case 13: return A[2] | 0; // OP_ERR
    }
    return 0;
  }
  function step() { /* never called: the chain runs plugin boxes through run() */ }
  return { type: code, block: 1, step: step, run: run, set: set, ctl: ctl, retarget: function (snap) { return snap; }, reset: function () { ctl(12, 0); } };
}
