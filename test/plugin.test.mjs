// Plugins on the main thread (src/plugin.js): the manifest, its catalog entry, slots that keep a plugin (registered
// or missing), the slot core (a missing plugin joins when it registers; worklet errors on the chain), the loader
// (integrity, URL rules), the registry, the JSON Schemas and the WAM 2.0 mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createFxCore, validateManifest, validateRegistry, registerPlugin, loadPlugin, loadPluginFiles, loadListedPlugin, sha256Integrity, catalogEntry,
  formatDial, sanitizeSlots, pluginEntries, toWamDescriptor, toWamParameterInfo, PLUGIN_ERRORS, toAstridHacks
} from '../src/index.js';
import { mockContext } from './mock-audio.mjs';

const fixture = (p) => readFileSync(new URL(`./fixtures/plugins/${p}`, import.meta.url));
const TREMOLO = JSON.parse(fixture('tremolo/plugin.json'));

test('validateManifest: the tremolo is valid; each mistake is named', () => {
  const v = validateManifest(TREMOLO);
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepEqual(v.manifest.params.map((p) => [p.id, p.type, p.minValue, p.maxValue, p.defaultValue]),
    [['rate', 'float', 0.1, 20, 5], ['depth', 'float', 0, 100, 50], ['shape', 'choice', 0, 2, 0]]);
  assert.ok(validateManifest(v.manifest).ok, 'a clean manifest is valid again');
  const bad = (patch, field) => {
    const r = validateManifest({ ...TREMOLO, ...patch });
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith(field)), `${field}: ${r.errors.join('; ')}`);
  };
  bad({ ncPlugin: 2 }, 'ncPlugin');
  bad({ id: 'My Tremolo' }, 'id');
  bad({ version: '1.0' }, 'version');
  bad({ licence: '' }, 'licence');
  bad({ dsp: '../x.js' }, 'dsp');
  bad({ dsp: 'https://evil.example/x.js' }, 'dsp');
  bad({ colour: 'red' }, 'colour');
  bad({ params: [{ id: 'rate', label: 'Rate', minValue: 1, maxValue: 0 }] }, 'params[0]');
  bad({ params: [{ id: 'bypass', label: 'B', type: 'boolean' }] }, 'params[0].id');
  bad({ params: [{ id: 'a', label: 'A', type: 'boolean' }, { id: 'a', label: 'A', type: 'boolean' }] }, 'params[1].id');
  bad({ params: [{ id: 'a', label: 'A', minValue: 0, maxValue: 1, defaultValue: 2 }] }, 'params[0].defaultValue');
  bad({ params: new Array(16).fill(0).map((_, i) => ({ id: `p${i}`, label: 'P', type: 'boolean' })) }, 'params');
});

test('a registered plugin is a catalog entry: dials, readouts, options, ids', () => {
  const e = registerPlugin(TREMOLO, { url: 'https://netcomposer.art/plugins/tremolo/plugin.json', listed: true });
  assert.equal(e.type, 'plugin:netcomposer.tremolo');
  assert.equal(catalogEntry('plugin:netcomposer.tremolo'), e);
  assert.equal(e.label, 'Tremolo');
  assert.equal(e.plugin.engine, 'plugin:netcomposer.tremolo@1.0.0');
  assert.deepEqual(e.dials.map((d) => d.k), [1, 2, 3]);
  assert.equal(formatDial(e.dials[0], 5), '5.0 Hz');
  assert.equal(formatDial(e.dials[1], 50), '50%');
  assert.equal(formatDial(e.dials[2], 2), 'Square');
  assert.deepEqual(pluginEntries().map((x) => x.type), ['plugin:netcomposer.tremolo']);
  assert.equal(registerPlugin(TREMOLO), e, 'registering again is the same entry');
  assert.throws(() => registerPlugin({ ...TREMOLO, version: '1.1.0' }), /already loaded/);
});

test('slots keep plugins: registered ones clean, missing ones as saved; ASTRID exports skip them', () => {
  const s = sanitizeSlots({ v: 2, chain: [
    { type: 'plugin:netcomposer.tremolo', dials: { rate: 3.33, depth: 500 } },
    { type: 'plugin:someone.fuzz', id: 'fuzz-1', bypass: true, dials: { gain: 6, junk: 'x' }, plugin: { version: '2.1.0', url: 'https://example.com/fuzz/plugin.json', name: 'Fuzz' } },
    { type: 'plugin:someone.bad', plugin: { url: 'javascript:alert(1)' } },
    { type: 'delay' },
    { type: 'plugin:me.mangler', plugin: { version: '0.1.0', url: 'local:me.mangler', name: 'Mangler' } },
    { type: 'plugin:me.odd', plugin: { url: 'local:../etc' } }
  ] }, 8);
  assert.deepEqual(s.chain[0], { id: 'tremolo-1', type: 'plugin:netcomposer.tremolo', bypass: false, dials: { rate: 3.3, depth: 100, shape: 0 },
    plugin: { id: 'netcomposer.tremolo', version: '1.0.0', url: 'https://netcomposer.art/plugins/tremolo/plugin.json', name: 'Tremolo' } });
  assert.deepEqual(s.chain[1], { id: 'fuzz-1', type: 'plugin:someone.fuzz', bypass: true, dials: { gain: 6 }, plugin: { id: 'someone.fuzz', version: '2.1.0', url: 'https://example.com/fuzz/plugin.json', name: 'Fuzz' } });
  assert.equal(s.chain[2].plugin.url, '', 'only http(s) URLs are kept');
  assert.equal(s.chain[3].type, 'delay');
  assert.equal(s.chain[4].plugin.url, 'local:me.mangler', 'local:<id> (a plugin from files) is kept');
  assert.equal(s.chain[5].plugin.url, '', 'local: only with an id');
  assert.deepEqual(sanitizeSlots(JSON.parse(JSON.stringify(s)), 8), s, 'round trip');
  const a = toAstridHacks(s);
  assert.deepEqual(a.hacks.map((h) => h.type), ['delay']);
  assert.ok(a.lossy.some((l) => /plugins/.test(l)));
});

test('slot core: a missing plugin waits (not in the worklet), then joins when it registers', async () => {
  const ctx = mockContext();
  const fx = createFxCore(ctx, { slots: 8, state: { v: 2, chain: [{ type: 'eq' }, { type: 'plugin:later.gain', id: 'gain-1', dials: { gain: 0.5 }, plugin: { version: '1.0.0', name: 'Gain', url: 'https://example.com/g/plugin.json' } }] } });
  await fx.ready;
  const po = ctx.node.options.processorOptions;
  assert.deepEqual(po.chain.map((c) => c.type), ['eq']);
  assert.equal(po.order.length, 1);
  let chain = fx.getChain();
  assert.deepEqual(chain[1].plugin, { id: 'later.gain', version: '1.0.0', url: 'https://example.com/g/plugin.json', name: 'Gain', status: 'missing' });
  assert.equal(fx.getParam('gain-1', 'gain'), 0.5, 'its dials are kept');
  assert.equal(fx.setParam('gain-1', 'gain', 1), undefined, 'a missing plugin\'s dials wait');
  assert.equal(fx.setParam('gain-1', 'bypass', true), true);
  const changes = [];
  fx.onChange((c) => changes.push(c.key));
  const before = ctx.posted.length;
  registerPlugin({ ncPlugin: 1, id: 'later.gain', name: 'Gain', version: '1.0.0', author: 'T', licence: 'MIT', dsp: 'gain.js', params: [{ id: 'gain', label: 'Gain', minValue: 0, maxValue: 2, defaultValue: 1, discreteStep: 0.01 }] }, { url: 'https://example.com/g/plugin.json' });
  const sent = ctx.posted.slice(before);
  assert.deepEqual(sent.map((m) => m.t), ['add', 'ps', 'ps', 'order']);
  assert.equal(sent[0].type, 'plugin:later.gain@1.0.0');
  assert.deepEqual(sent.filter((m) => m.t === 'ps').map((m) => [m.k, m.v]), [[0, 0], [1, 0.5]]);
  assert.ok(changes.includes('plugin'));
  chain = fx.getChain();
  assert.equal(chain[1].plugin.status, 'ready');
  // The worklet stops it (code 3): the chain says so; a fresh add clears it.
  ctx.node.port.onmessage?.({ data: { t: 'perr', d: [sent[0].uid, 3], n: 1 } });
  chain = fx.getChain();
  assert.equal(chain[1].plugin.status, 'failed');
  assert.equal(chain[1].plugin.error, PLUGIN_ERRORS[3]);
  // State keeps the plugin's ref and dials.
  const st = fx.getState();
  assert.deepEqual(st.chain[1], { id: 'gain-1', type: 'plugin:later.gain', bypass: true, dials: { gain: 0.5 }, plugin: { id: 'later.gain', version: '1.0.0', url: 'https://example.com/g/plugin.json', name: 'Gain' } });
  fx.removeEffect('gain-1');
  const id = fx.addEffect('plugin:later.gain');
  assert.equal(fx.getChain().find((c) => c.id === id).plugin.status, 'ready');
  fx.dispose();
});

test('slot core: an unregistered DSP in the worklet shows as missing (code 5)', async () => {
  registerPlugin({ ncPlugin: 1, id: 'test.ghost', name: 'Ghost', version: '1.0.0', author: 'T', licence: 'MIT', dsp: 'g.js', params: [] });
  const ctx = mockContext();
  const fx = createFxCore(ctx, { slots: 2 });
  await fx.ready;
  fx.addEffect('plugin:test.ghost');
  const add = ctx.posted.find((m) => m.t === 'add');
  ctx.node.port.onmessage?.({ data: { t: 'perr', d: [add.uid, 5], n: 1 } });
  assert.equal(fx.getChain()[0].plugin.status, 'missing');
  fx.dispose();
});

// A fetch over the fixtures folder, as https://plugins.test/<folder>/<file>.
function fakeFetch(map = {}) {
  const seen = [];
  const f = async (url) => {
    seen.push(url);
    const u = new URL(url);
    let body = map[u.pathname];
    if (body === undefined) { try { body = fixture(u.pathname.slice(1)); } catch { return { ok: false, status: 404 }; } }
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), json: async () => JSON.parse(new TextDecoder().decode(bytes)) };
  };
  f.seen = seen;
  return f;
}

test('loadPlugin: fetches plugin.json and the DSP, loads nc-fx first, then the DSP (from a Blob), registers', async () => {
  const ctx = mockContext();
  const fetch = fakeFetch({ '/n/plugin.json': JSON.stringify({ ...TREMOLO, id: 'test.loaded' }), '/n/tremolo.dsp.js': 'registerNcFxPlugin({})' });
  const r = await loadPlugin(ctx, 'https://plugins.test/n/plugin.json', { fetch, moduleUrl: '/nc-fx/worklet.js' });
  assert.equal(r.entry.type, 'plugin:test.loaded');
  assert.equal(r.entry.plugin.url, 'https://plugins.test/n/plugin.json');
  assert.deepEqual(fetch.seen, ['https://plugins.test/n/plugin.json', 'https://plugins.test/n/tremolo.dsp.js']);
  assert.equal(ctx.modules[0], '/nc-fx/worklet.js');
  assert.match(ctx.modules[1], /^blob:/);
  await loadPlugin(ctx, 'https://plugins.test/n/plugin.json', { fetch });
  assert.equal(ctx.modules.length, 2, 'once per context');
});

test('loadPlugin: refuses http (except localhost), bad manifests, and files that miss their sha256', async () => {
  const ctx = mockContext();
  await assert.rejects(loadPlugin(ctx, 'http://example.com/plugin.json', { fetch: fakeFetch() }), /https/);
  await assert.rejects(loadPlugin(ctx, 'https://plugins.test/n/plugin.json', { fetch: fakeFetch({ '/n/plugin.json': '{"ncPlugin":1}' }) }), /id:/);
  const m = JSON.stringify({ ...TREMOLO, id: 'test.sha' }), dsp = 'registerNcFxPlugin({})';
  const integrity = { manifest: await sha256Integrity(new TextEncoder().encode(m)), dsp: await sha256Integrity(new TextEncoder().encode(dsp)) };
  const files = { '/s/plugin.json': m, '/s/tremolo.dsp.js': dsp };
  await assert.rejects(loadPlugin(ctx, 'https://plugins.test/s/plugin.json', { fetch: fakeFetch({ ...files, '/s/tremolo.dsp.js': dsp + ' ' }), integrity }), /does not match the registry/);
  const item = { id: 'test.sha', version: '1.0.0', manifest: 's/plugin.json', integrity };
  const ok = await loadListedPlugin(ctx, item, 'https://plugins.test/registry.json', { fetch: fakeFetch(files) });
  assert.equal(ok.entry.plugin.listed, true);
  await assert.rejects(loadListedPlugin(ctx, { ...item, version: '2.0.0' }, 'https://plugins.test/registry.json', { fetch: fakeFetch(files) }), /not what the registry lists/);
  const local = loadPlugin(ctx, 'http://localhost:5990/plugin.json', { fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(local, /404/, 'http on localhost is allowed (it gets as far as the fetch)');
});

test('loadPluginFiles: loads plugin.json and the DSP from their text (no fetch), saves as local:<id>', async () => {
  const ctx = mockContext();
  const m = JSON.stringify({ ...TREMOLO, id: 'test.files' });
  const r = await loadPluginFiles(ctx, { manifest: m, dsp: 'registerNcFxPlugin({})', dspName: TREMOLO.dsp }, { moduleUrl: '/nc-fx/worklet.js' });
  assert.equal(r.entry.type, 'plugin:test.files');
  assert.equal(r.url, 'local:test.files');
  assert.equal(r.entry.plugin.url, 'local:test.files');
  assert.equal(r.entry.plugin.listed, false);
  assert.equal(ctx.modules[0], '/nc-fx/worklet.js');
  assert.match(ctx.modules[1], /^blob:/);
  await loadPluginFiles(ctx, { manifest: JSON.parse(m), dsp: 'registerNcFxPlugin({})' });
  assert.equal(ctx.modules.length, 2, 'once per context');
  await assert.rejects(loadPluginFiles(ctx, { manifest: '{', dsp: 'x' }), /not JSON/);
  await assert.rejects(loadPluginFiles(ctx, { manifest: '{"ncPlugin":1}', dsp: 'x' }), /id:/);
  const other = JSON.stringify({ ...TREMOLO, id: 'test.files2' });
  await assert.rejects(loadPluginFiles(ctx, { manifest: other, dsp: '' }), /needs its DSP file/);
  await assert.rejects(loadPluginFiles(ctx, { manifest: other, dsp: 'x', dspName: 'other.js' }), /names its DSP file/);
  await assert.rejects(loadPluginFiles(ctx, { manifest: other, dsp: 'x'.repeat(256 * 1024 + 1) }), /over 256 KB/);
  await assert.rejects(loadPluginFiles(ctx, { manifest: JSON.stringify({ ...TREMOLO, id: 'test.files', version: '2.0.0' }), dsp: 'x' }), /already loaded/);
});

test('validateRegistry: entries need ids, versions, a manifest and sha256 for both files', () => {
  const good = { id: 'netcomposer.tremolo', name: 'Tremolo', version: '1.0.0', author: 'P', licence: 'MIT', manifest: 'tremolo/plugin.json', integrity: { manifest: 'sha256-' + 'A'.repeat(43) + '=', dsp: 'sha256-' + 'B'.repeat(43) + '=' }, checked: '2026-11-01' };
  assert.ok(validateRegistry({ v: 1, plugins: [good] }).ok);
  const r = validateRegistry({ v: 1, plugins: [good, { ...good, id: 'x.y', integrity: {} }, good] });
  assert.equal(r.registry.plugins.length, 1);
  assert.equal(r.errors.length, 2);
  assert.ok(!validateRegistry({ plugins: [] }).ok);
});

test('the JSON Schemas name the same fields as the validator', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/plugin-manifest.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.properties).sort(), ['$schema', 'author', 'description', 'dsp', 'id', 'keywords', 'licence', 'name', 'ncPlugin', 'params', 'version', 'website'].sort());
  assert.deepEqual(Object.keys(schema.$defs.param.properties).sort(), ['choices', 'defaultValue', 'discreteStep', 'exponent', 'id', 'label', 'maxValue', 'minValue', 'more', 'type', 'units'].sort());
  const reg = JSON.parse(readFileSync(new URL('../schema/plugin-registry.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(reg.properties.plugins.items.required.sort(), ['author', 'checked', 'id', 'integrity', 'licence', 'manifest', 'name', 'version']);
});

test('WAM 2.0: the manifest maps onto WamDescriptor and WamParameterInfo', () => {
  const d = toWamDescriptor(validateManifest(TREMOLO).manifest);
  assert.equal(d.identifier, 'netcomposer.tremolo');
  assert.equal(d.vendor, 'Peter Semmelhack');
  assert.equal(d.isInstrument, false);
  assert.equal(d.hasAudioInput && d.hasAudioOutput, true);
  const p = toWamParameterInfo(TREMOLO);
  assert.deepEqual(p.shape, { id: 'shape', label: 'Shape', type: 'choice', defaultValue: 0, minValue: 0, maxValue: 2, discreteStep: 1, exponent: 0, choices: ['Sine', 'Triangle', 'Square'], units: '' });
  assert.equal(p.rate.units, 'Hz');
});
