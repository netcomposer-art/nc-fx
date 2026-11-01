// nc-fx plugins, main thread: the manifest (validateManifest), its catalog entry (pluginEntryFromManifest,
// registerPlugin), loading one from a URL (loadPlugin), the listed registry (fetchRegistry, loadListedPlugin) and the
// mapping to Web Audio Modules 2.0 (toWamDescriptor, toWamParameterInfo). docs/plugins.md is the guide;
// schema/plugin-manifest.schema.json and schema/plugin-registry.schema.json are the same rules as JSON Schema.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// A plugin is two files in one folder: plugin.json (the manifest: name, version, author, licence, params) and one
// DSP file that runs in the AudioWorklet and calls registerNcFxPlugin() (src/plugin-host.js). Once registered, a
// plugin is a catalog entry like the built-in effects ('plugin:<id>'), so any host that renders the catalog (the
// Studio's insert cards, nc-fx's panel) shows its card, dials, meters and saves with no plugin-specific code.

import { addPluginEntry, catalogEntry } from './catalog.js';
import { loadFxWorklet } from './index.js';

/** The contract's version: a manifest's `ncPlugin`. */
export var PLUGIN_API = 1;
var MAX_PARAMS = 15;
var ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
var PARAM_ID = /^[a-z][a-z0-9_]{0,31}$/;
var SEMVER = /^\d+\.\d+\.\d+$/;
var SPDX = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/;
var DSP_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\.js$/;
var TOP_KEYS = ['$schema', 'ncPlugin', 'id', 'name', 'version', 'author', 'licence', 'description', 'website', 'keywords', 'dsp', 'params'];
var PARAM_KEYS = ['id', 'label', 'type', 'defaultValue', 'minValue', 'maxValue', 'discreteStep', 'exponent', 'choices', 'units', 'more'];

/** What a failed plugin's card says (the worklet's codes: src/plugin-host.js). */
export var PLUGIN_ERRORS = {
  1: 'It failed to start.',
  2: 'It crashed while playing.',
  3: 'It made bad numbers (NaN, infinity or runaway level).',
  4: 'It crashed when a dial moved.',
  5: 'Its code is not loaded.'
};

function isRecord(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function num(v) { return typeof v === 'number' && isFinite(v); }
function str(v, max) { return typeof v === 'string' && v.trim().length > 0 && v.length <= max; }

/**
 * Check a manifest (parsed JSON). Returns { ok, errors, manifest }: errors are short sentences an author (or an
 * agent) can act on, each naming the field; manifest is a clean copy with every param's type, range and default
 * filled in (only when ok).
 */
export function validateManifest(raw) {
  var errors = [], m = raw;
  var err = function (path, msg) { errors.push(path + ': ' + msg); };
  if (!isRecord(m)) return { ok: false, errors: ['manifest: must be a JSON object'], manifest: null };
  Object.keys(m).forEach(function (k) { if (TOP_KEYS.indexOf(k) < 0) err(k, 'unknown field (allowed: ' + TOP_KEYS.slice(1).join(', ') + ')'); });
  if (m.ncPlugin !== PLUGIN_API) err('ncPlugin', 'must be ' + PLUGIN_API);
  if (typeof m.id !== 'string' || !ID.test(m.id) || m.id.length > 64) err('id', 'lowercase letters and digits, with dots or dashes between, up to 64 (e.g. "yourname.tremolo")');
  if (!str(m.name, 40)) err('name', 'a name of 1 to 40 characters');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) err('version', 'x.y.z, e.g. "1.0.0"');
  if (!str(m.author, 80)) err('author', 'who made it, 1 to 80 characters');
  if (typeof m.licence !== 'string' || !SPDX.test(m.licence) || m.licence.length > 64) err('licence', 'an SPDX licence id, e.g. "MIT"');
  if (m.description !== undefined && !(typeof m.description === 'string' && m.description.length <= 200)) err('description', 'up to 200 characters');
  if (m.website !== undefined && !(typeof m.website === 'string' && /^https:\/\/\S+$/.test(m.website) && m.website.length <= 2048)) err('website', 'an https:// address');
  if (m.keywords !== undefined && !(Array.isArray(m.keywords) && m.keywords.length <= 8 && m.keywords.every(function (k) { return str(k, 24); }))) err('keywords', 'up to 8 short strings');
  if (typeof m.dsp !== 'string' || !DSP_FILE.test(m.dsp)) err('dsp', 'the DSP file\'s name, in the same folder as plugin.json, ending in .js (e.g. "tremolo.dsp.js")');
  var params = [];
  if (!Array.isArray(m.params)) err('params', 'a list of params (may be empty)');
  else if (m.params.length > MAX_PARAMS) err('params', 'at most ' + MAX_PARAMS);
  else {
    var seen = {};
    m.params.forEach(function (p, i) {
      var at = 'params[' + i + ']';
      if (!isRecord(p)) { err(at, 'must be an object'); return; }
      Object.keys(p).forEach(function (k) { if (PARAM_KEYS.indexOf(k) < 0) err(at + '.' + k, 'unknown field (allowed: ' + PARAM_KEYS.join(', ') + ')'); });
      if (typeof p.id !== 'string' || !PARAM_ID.test(p.id) || p.id === 'bypass') err(at + '.id', 'lowercase, starting with a letter: letters, digits, _ (not "bypass")');
      else if (seen[p.id]) err(at + '.id', '"' + p.id + '" is used twice');
      else seen[p.id] = true;
      if (!str(p.label, 24)) err(at + '.label', 'the dial\'s name, 1 to 24 characters');
      var type = p.type === undefined ? 'float' : p.type;
      if (['float', 'int', 'boolean', 'choice'].indexOf(type) < 0) { err(at + '.type', 'float, int, boolean or choice'); return; }
      var q = { id: p.id, label: p.label, type: type };
      if (type === 'choice') {
        if (!Array.isArray(p.choices) || p.choices.length < 2 || p.choices.length > 16 || !p.choices.every(function (c) { return str(c, 24); })) { err(at + '.choices', '2 to 16 names'); return; }
        q.choices = p.choices.slice(); q.minValue = 0; q.maxValue = p.choices.length - 1; q.discreteStep = 1;
        if ((p.minValue !== undefined && p.minValue !== 0) || (p.maxValue !== undefined && p.maxValue !== q.maxValue)) err(at, 'a choice\'s values are 0 to choices.length - 1: leave out minValue and maxValue');
      } else if (type === 'boolean') {
        q.minValue = 0; q.maxValue = 1; q.discreteStep = 1;
        if ((p.minValue !== undefined && p.minValue !== 0) || (p.maxValue !== undefined && p.maxValue !== 1)) err(at, 'a boolean is 0 or 1: leave out minValue and maxValue');
      } else {
        if (!num(p.minValue) || !num(p.maxValue) || !(p.minValue < p.maxValue)) { err(at, 'minValue and maxValue: numbers, minValue < maxValue'); return; }
        q.minValue = p.minValue; q.maxValue = p.maxValue;
        if (p.discreteStep !== undefined && !(num(p.discreteStep) && p.discreteStep > 0 && p.discreteStep <= p.maxValue - p.minValue)) err(at + '.discreteStep', 'a number > 0, at most the range');
        q.discreteStep = type === 'int' ? Math.max(1, Math.round(p.discreteStep || 1)) : num(p.discreteStep) && p.discreteStep > 0 ? p.discreteStep : autoStep(p.maxValue - p.minValue);
        if (type === 'int' && (!Number.isInteger(p.minValue) || !Number.isInteger(p.maxValue))) err(at, 'an int has whole-number minValue and maxValue');
      }
      if (p.defaultValue === undefined) q.defaultValue = q.minValue;
      else if (!num(p.defaultValue) || p.defaultValue < q.minValue || p.defaultValue > q.maxValue) err(at + '.defaultValue', 'a number from ' + q.minValue + ' to ' + q.maxValue);
      else q.defaultValue = p.defaultValue;
      if (p.units !== undefined) { if (typeof p.units === 'string' && p.units.length <= 8) q.units = p.units; else err(at + '.units', 'up to 8 characters, e.g. "Hz", "ms", "%", "dB"'); }
      if (p.exponent !== undefined) { if (num(p.exponent) && p.exponent > 0) q.exponent = p.exponent; else err(at + '.exponent', 'a number > 0'); }
      if (p.more !== undefined) { if (typeof p.more === 'boolean') { if (p.more) q.more = true; } else err(at + '.more', 'true or false'); }
      params.push(q);
    });
  }
  if (errors.length) return { ok: false, errors: errors, manifest: null };
  var clean = { ncPlugin: PLUGIN_API, id: m.id, name: m.name.trim(), version: m.version, author: m.author.trim(), licence: m.licence, dsp: m.dsp, params: params };
  if (m.description) clean.description = m.description;
  if (m.website) clean.website = m.website;
  if (m.keywords) clean.keywords = m.keywords.slice();
  return { ok: true, errors: [], manifest: clean };
}
// A float's step when the manifest gives none: about a hundredth of the range, on a 1-2-5-free decade (0.001 to 1).
function autoStep(range) { var s = Math.pow(10, Math.floor(Math.log10(range / 100))); return s < 0.001 ? 0.001 : s > 1 ? 1 : +s.toFixed(3); }
function digitsOf(step) { var d = 0; while (d < 3 && Math.abs(Math.round(step * Math.pow(10, d)) - step * Math.pow(10, d)) > 1e-9) d++; return d; }

/** A plugin's catalog type: 'plugin:<id>'. */
export function pluginType(id) { return 'plugin:' + id; }

/**
 * A validated manifest as a catalog entry ({ type, label, note?, dials, plugin }), the shape of CATALOG's. Each param
 * is a dial: k = its position + 1 (k 0 is the On/Off), values in the param's own units (no law: the DSP gets what the
 * dial shows), a readout from `units`, choices and booleans as options.
 */
export function pluginEntryFromManifest(manifest, info) {
  var m = manifest, i = info || {};
  var dials = m.params.map(function (p, n) {
    var d = { key: p.id, label: p.label, min: p.minValue, max: p.maxValue, default: p.defaultValue, step: p.discreteStep, k: n + 1, unit: p.units || null, format: null };
    if (p.type === 'choice' || p.type === 'boolean') {
      var names = p.type === 'choice' ? p.choices : ['Off', 'On'];
      d.step = null;
      d.options = names.map(function (c, v) { return { value: v, label: c }; });
      d.format = { fmt: 'option' };
    } else {
      var u = p.units ? (/^[%°×]/.test(p.units) ? p.units : ' ' + p.units) : '';
      d.format = { fmt: 'fixed', div: 1, add: 0, digits: digitsOf(p.discreteStep), suffix: u };
    }
    if (p.more) d.more = true;
    return d;
  });
  var entry = {
    type: pluginType(m.id), label: m.name, dials: dials,
    plugin: {
      id: m.id, version: m.version, author: m.author, licence: m.licence, engine: 'plugin:' + m.id + '@' + m.version,
      idBase: m.id.split('.').pop(), url: typeof i.url === 'string' ? i.url : '', listed: i.listed === true
    }
  };
  if (m.description) entry.note = m.description;
  if (m.website) entry.plugin.website = m.website;
  return entry;
}

/**
 * Put a plugin in the catalog (its DSP must be registered in the worklet too: loadPlugin does both). One version of
 * a plugin per page: registering another version of a registered id throws (reload the page to switch). Returns
 * the catalog entry. Chains with that plugin's slots waiting ("missing") start playing them.
 */
export function registerPlugin(manifest, info) {
  var v = validateManifest(manifest);
  if (!v.ok) throw new Error('nc-fx plugin: ' + v.errors.join('; '));
  var had = catalogEntry(pluginType(v.manifest.id));
  if (had && had.plugin.version !== v.manifest.version) throw new Error('nc-fx plugin: ' + v.manifest.id + ' ' + had.plugin.version + ' is already loaded on this page; reload to use ' + v.manifest.version);
  if (had) return had;
  var entry = pluginEntryFromManifest(v.manifest, info);
  addPluginEntry(entry);
  return entry;
}

/** SRI-style integrity of bytes: 'sha256-<base64>'. */
export async function sha256Integrity(bytes) {
  var c = globalThis.crypto && globalThis.crypto.subtle;
  if (!c) throw new Error('nc-fx plugin: no WebCrypto here (integrity needs a secure context: https or localhost)');
  var h = new Uint8Array(await c.digest('SHA-256', bytes)), s = '';
  for (var j = 0; j < h.length; j++) s += String.fromCharCode(h[j]);
  return 'sha256-' + btoa(s);
}

/** http(s) only; plain http only on this machine (a local server while you build a plugin). */
function checkUrl(u) {
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return;
  throw new Error('nc-fx plugin: load plugins over https (http only from localhost): ' + u.href);
}
async function fetchBytes(url, fetchFn, integrity, what) {
  var res = await fetchFn(url, { credentials: 'omit', cache: 'no-cache' });
  if (!res.ok) throw new Error('nc-fx plugin: ' + what + ' ' + url + ' answered ' + res.status);
  var bytes = new Uint8Array(await res.arrayBuffer());
  if (integrity) {
    var got = await sha256Integrity(bytes);
    if (got !== integrity) throw new Error('nc-fx plugin: ' + what + ' ' + url + ' does not match the registry (expected ' + integrity + ', got ' + got + ')');
  }
  return new TextDecoder().decode(bytes);
}

var loaded = typeof WeakMap === 'function' ? new WeakMap() : null;

/**
 * Load a plugin from its manifest's URL onto a context: fetch plugin.json, check it, fetch its DSP file, load that
 * into the context's AudioWorklet (after nc-fx's own module, so registerNcFxPlugin exists), and register it in the
 * catalog. Only on a user's action: this runs the plugin's code. Resolves { entry, manifest, url }; rejects with a
 * sentence to show (bad manifest, network, integrity, another version loaded).
 * @param {BaseAudioContext} ctx
 * @param {string|URL} url  plugin.json's address (https, or http on localhost)
 * @param {{ moduleUrl?: string|URL, integrity?: { manifest?: string, dsp?: string }, listed?: boolean,
 *   expect?: { id?: string, version?: string }, fetch?: typeof fetch, base?: string }} [opts]
 */
export async function loadPlugin(ctx, url, opts) {
  var o = opts || {};
  var u = new URL(String(url), o.base || (typeof location !== 'undefined' ? location.href : undefined));
  checkUrl(u);
  var fetchFn = o.fetch || globalThis.fetch.bind(globalThis), integ = o.integrity || {};
  var text = await fetchBytes(u.href, fetchFn, integ.manifest, 'plugin.json');
  var raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error('nc-fx plugin: ' + u.href + ' is not JSON'); }
  var v = validateManifest(raw);
  if (!v.ok) throw new Error('nc-fx plugin: ' + u.href + ': ' + v.errors.join('; '));
  var m = v.manifest;
  if (o.expect && ((o.expect.id && o.expect.id !== m.id) || (o.expect.version && o.expect.version !== m.version))) throw new Error('nc-fx plugin: ' + u.href + ' is ' + m.id + ' ' + m.version + ', not what the registry lists');
  var had = catalogEntry(pluginType(m.id));
  if (had && had.plugin.version !== m.version) throw new Error('nc-fx plugin: ' + m.name + ' ' + had.plugin.version + ' is already loaded on this page. Reload the page to use ' + m.version + '.');
  var dspUrl = new URL(m.dsp, u);
  var key = m.id + '@' + m.version, per = loaded && loaded.get(ctx);
  if (!per && loaded) { per = {}; loaded.set(ctx, per); }
  if (!per || !per[key]) {
    var p = (async function () {
      var src = await fetchBytes(dspUrl.href, fetchFn, integ.dsp, 'DSP file');
      await loadFxWorklet(ctx, o.moduleUrl);
      // The bytes that were checked are the bytes that run: a Blob URL of the fetched text (CSP: worker-src blob:).
      var blob = URL.createObjectURL(new Blob([src + '\n//# sourceURL=' + dspUrl.href + '\n'], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(blob); } finally { URL.revokeObjectURL(blob); }
    })();
    if (per) { per[key] = p; p.catch(function () { delete per[key]; }); }
    await p;
  } else await per[key];
  var entry = registerPlugin(m, { url: u.href, listed: o.listed === true });
  return { entry: entry, manifest: m, url: u.href };
}

/**
 * Check a registry (parsed JSON): { v: 1, plugins: [{ id, name, version, author, licence, description?, manifest,
 * integrity: { manifest, dsp }, checked }] }. Returns { ok, errors, registry } (registry: the valid entries).
 */
export function validateRegistry(raw) {
  var errors = [];
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.plugins)) return { ok: false, errors: ['registry: { "v": 1, "plugins": [...] }'], registry: { v: 1, plugins: [] } };
  var out = [], ids = {};
  raw.plugins.forEach(function (p, i) {
    var at = 'plugins[' + i + ']', bad = [];
    if (!isRecord(p)) { errors.push(at + ': must be an object'); return; }
    if (typeof p.id !== 'string' || !ID.test(p.id)) bad.push('id');
    if (!str(p.name, 40)) bad.push('name');
    if (typeof p.version !== 'string' || !SEMVER.test(p.version)) bad.push('version');
    if (!str(p.author, 80)) bad.push('author');
    if (typeof p.licence !== 'string' || !SPDX.test(p.licence)) bad.push('licence');
    if (typeof p.manifest !== 'string' || !p.manifest) bad.push('manifest');
    if (!isRecord(p.integrity) || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(p.integrity.manifest || '') || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(p.integrity.dsp || '')) bad.push('integrity');
    if (typeof p.checked !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(p.checked)) bad.push('checked');
    if (ids[p.id]) bad.push('id (listed twice)');
    if (bad.length) { errors.push(at + ': bad ' + bad.join(', ')); return; }
    ids[p.id] = true;
    var e = { id: p.id, name: p.name, version: p.version, author: p.author, licence: p.licence, manifest: p.manifest, integrity: { manifest: p.integrity.manifest, dsp: p.integrity.dsp }, checked: p.checked };
    if (typeof p.description === 'string') e.description = p.description.slice(0, 200);
    out.push(e);
  });
  return { ok: errors.length === 0, errors: errors, registry: { v: 1, plugins: out } };
}

/** Fetch and check the listed registry (e.g. '/plugins/registry.json'). Resolves { registry, url, errors }. */
export async function fetchRegistry(url, opts) {
  var o = opts || {};
  var u = new URL(String(url), o.base || (typeof location !== 'undefined' ? location.href : undefined));
  var res = await (o.fetch || globalThis.fetch.bind(globalThis))(u.href, { credentials: 'omit', cache: 'no-cache' });
  if (!res.ok) throw new Error('nc-fx plugins: the registry ' + u.href + ' answered ' + res.status);
  var v = validateRegistry(await res.json());
  return { registry: v.registry, url: u.href, errors: v.errors };
}

/** Load a listed plugin (a registry entry), checking both files against the registry's sha256. */
export function loadListedPlugin(ctx, item, registryUrl, opts) {
  return loadPlugin(ctx, new URL(item.manifest, registryUrl).href, Object.assign({}, opts, { integrity: item.integrity, listed: true, expect: { id: item.id, version: item.version } }));
}

/** The manifest as a Web Audio Modules 2.0 WamDescriptor (what a WAM host shows; NetComposer effects are stereo
 * audio in, audio out, no MIDI). */
export function toWamDescriptor(manifest) {
  var m = manifest;
  return {
    identifier: m.id, name: m.name, vendor: m.author, version: m.version, apiVersion: '2.0.0', thumbnail: '',
    keywords: (m.keywords || []).slice(), isInstrument: false, description: m.description || '', website: m.website || '',
    hasAudioInput: true, hasAudioOutput: true, hasAutomationInput: true, hasAutomationOutput: false, hasMidiInput: false, hasMidiOutput: false,
    hasMpeInput: false, hasMpeOutput: false, hasOscInput: false, hasOscOutput: false, hasSysexInput: false, hasSysexOutput: false
  };
}
/** The params as WAM 2.0 WamParameterInfo configurations, keyed by id (the manifest uses WAM's field names). */
export function toWamParameterInfo(manifest) {
  var v = validateManifest(manifest);
  if (!v.ok) throw new Error('nc-fx plugin: ' + v.errors.join('; '));
  var out = {};
  v.manifest.params.forEach(function (p) {
    out[p.id] = { id: p.id, label: p.label, type: p.type, defaultValue: p.defaultValue, minValue: p.minValue, maxValue: p.maxValue,
      discreteStep: p.discreteStep, exponent: p.exponent || 0, choices: p.choices ? p.choices.slice() : [], units: p.units || '' };
  });
  return out;
}
