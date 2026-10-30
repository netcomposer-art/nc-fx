// State v2 (the slot chain): ASTRID's saves load exactly as ASTRID loads them, and go back out unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astridHacks } from './astrid.mjs';
import { migrateSlots, sanitizeSlots, toAstridHacks, toAstridDocument, newSlot, slotName, moveSlot, slotProgram, SLOTS_VERSION } from '../src/slots.js';
import { CATALOG, catalogEntry } from '../src/catalog.js';
import { createFxChainDsp } from '../src/chain.js';
import { createFxDsp } from '../src/dsp.js';
import { compile, defaultState, sanitize } from '../src/params.js';
import { noiseBursts, identical } from './helpers.mjs';

const H = await astridHacks();
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
/** -0 as 0: ASTRID's dialValue can round to -0 (Math.round(-0.2)); nc-fx saves 0 (JSON writes both as 0). */
const z = (x) => JSON.parse(JSON.stringify(x));
/** ASTRID's sanitized hacks as nc-fx slots: wet -> mix, and nc-fx's extra dials at their defaults. */
function expected(hacks) {
  hacks = z(hacks);
  return hacks.map((h) => {
    const e = catalogEntry(h.type), dials = {};
    for (const d of e.dials) dials[d.key] = d.more ? d.default : h.dials[d.astridKey || d.key];
    return { id: h.id, type: h.type, bypass: h.bypass, dials };
  });
}
/** Saved-hacks garbage: valid hacks, unknown types, bad ids and dials, duplicates, more than three. */
function garbage(r) {
  const types = [...H.HACK_TYPES, 'limiter', 'nope', 'flanger'];
  const out = [];
  const n = Math.floor(r() * 7);
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < 0.06) { out.push(x < 0.03 ? null : 'hack'); continue; }
    const type = types[Math.floor(r() * types.length)];
    const def = H.HACK_DEFINITIONS.find((d) => d.type === type);
    const dials = {};
    if (def) for (const d of def.dials) {
      const y = r();
      dials[d.key] = y < 0.1 ? 'x' : y < 0.15 ? NaN : y < 0.2 ? 1e9 : y < 0.25 ? -1e9 : d.min + (d.max - d.min) * r() + (y < 0.5 ? 0.37 : 0);
    }
    const ids = [`${type}-1`, `${type}-2`, '', '-bad', 'my room', 'a'.repeat(70), 5];
    out.push({ id: ids[Math.floor(r() * ids.length)], type, bypass: r() < 0.3 ? true : r() < 0.5 ? 'yes' : false, dials: r() < 0.1 ? 'none' : dials });
  }
  return out;
}

test('ASTRID\'s saved hacks load exactly as ASTRID\'s sanitizeHacks loads them (500 fuzzed saves)', () => {
  const r = rng(99);
  for (let k = 0; k < 500; k++) {
    const raw = garbage(r);
    const want = H.sanitizeHacks(structuredClone(raw));
    const { state } = migrateSlots(structuredClone(raw));
    assert.equal(state.v, SLOTS_VERSION);
    assert.deepEqual(state.chain, expected(want), JSON.stringify(raw));
  }
  assert.deepEqual(sanitizeSlots(undefined), { v: 2, chain: [] });
  assert.deepEqual(sanitizeSlots('x'), { v: 2, chain: [] });
});

test('round trip: ASTRID hacks -> nc-fx -> ASTRID hacks is lossless, for every type at random dials', () => {
  const r = rng(5);
  for (let k = 0; k < 300; k++) {
    const hacks = [];
    for (let j = 0; j < 3; j++) {
      const def = H.HACK_DEFINITIONS[Math.floor(r() * H.HACK_DEFINITIONS.length)];
      const h = H.createHack(def.type, hacks);
      for (const d of def.dials) h.dials[d.key] = d.options ? d.options[Math.floor(r() * d.options.length)][0] : Math.round(d.min + r() * (d.max - d.min));
      h.bypass = r() < 0.3;
      hacks.push(h);
    }
    const back = toAstridHacks(sanitizeSlots(hacks));
    assert.deepEqual(back.lossy, []);
    assert.deepEqual(back.hacks, z(H.sanitizeHacks(hacks)));
  }
});

test('ASTRID\'s worklet widgets and the schema-2 document load back to the same dials (each law inverted exactly)', () => {
  const r = rng(11);
  for (let k = 0; k < 300; k++) {
    const hacks = [];
    for (let j = 0; j < 3; j++) {
      const def = H.HACK_DEFINITIONS[Math.floor(r() * H.HACK_DEFINITIONS.length)];
      const h = H.createHack(def.type, hacks);
      for (const d of def.dials) h.dials[d.key] = d.options ? d.options[Math.floor(r() * d.options.length)][0] : Math.round(d.min + r() * (d.max - d.min));
      h.bypass = r() < 0.3;
      hacks.push(h);
    }
    const tempo = 60 + Math.round(r() * 140);
    const want = expected(H.sanitizeHacks(hacks));
    assert.deepEqual(migrateSlots(H.hackWidgets(hacks, tempo)).state.chain, want, 'widgets');
    const doc = H.hackChainDocument(hacks, tempo);
    const m = migrateSlots(doc);
    assert.deepEqual(m.state.chain, want, 'schema 2');
    assert.deepEqual(m.dropped, []);
    assert.deepEqual(toAstridDocument(m.state, tempo), z(doc), 'export = hackChainDocument');
  }
});

test('the site\'s first EQ voicing (no low_hz / high_hz / mid_q) is reported, not silently changed', () => {
  const m = migrateSlots({ schema: 2, chain: [{ id: 'eq-1', type: 'eq', version: 1, bypass: false, params: { low_db: 3, mid_db: 0, mid_hz: 1000, high_db: -2 } }] });
  assert.equal(m.state.chain[0].dials.low_db, 3);
  assert.match(m.notes[0], /first voicing/);
});

test('export reports what ASTRID can\'t hold: nc-fx\'s own dials away from their defaults, 1/32, a fourth hack', () => {
  const s = sanitizeSlots({ v: 2, chain: [
    { id: 'drive-1', type: 'drive', bypass: false, dials: { drive_db: 9.3, curve: 1 } },
    { id: 'delay-1', type: 'delay', bypass: false, dials: { delay_beats: 0.125, mix: 30 } },
    { id: 'eq-1', type: 'eq', bypass: false, dials: {} }, { id: 'width-1', type: 'width', bypass: false, dials: {} }] }, 4);
  const out = toAstridHacks(s);
  assert.deepEqual(out.lossy, ['drive-1.curve', 'delay-1.delay_beats', 'width-1: ASTRID keeps three hacks']);
  assert.deepEqual(out.hacks[1].dials, { delay_beats: 0.125, feedback: 35, wet: 30 });
});

test('over the cap: the first `max` load, the rest are reported (ASTRID keeps its first three)', () => {
  const hacks = ['eq', 'drive', 'delay', 'phaser', 'chorus'].map((t) => H.createHack(t));
  const m = migrateSlots(hacks);
  assert.deepEqual(m.state.chain.map((s) => s.type), ['eq', 'drive', 'delay']);
  assert.deepEqual(m.dropped, ['phaser-1', 'chorus-1']);
  assert.equal(migrateSlots(hacks, 5).state.chain.length, 5);
});

test('helpers: newSlot (ASTRID\'s createHack ids), slotName ("Drive 2"), moveSlot (moveHack)', () => {
  const a = newSlot('drive'), b = newSlot('drive', [a]);
  assert.deepEqual([a.id, b.id, slotName(a), slotName(b)], ['drive-1', 'drive-2', 'Drive', 'Drive 2']);
  assert.deepEqual(a.dials, { ...H.createHack('drive').dials, curve: 0, tone: 100, mod_drive: 0, mod_tone: 0 });
  assert.equal(newSlot('reverb').type, 'plate');
  assert.equal(newSlot('nope'), null);
  const c = [1, 2, 3];
  assert.deepEqual(moveSlot(c, 0, 2), H.moveHack(c, 0, 2));
  assert.equal(moveSlot(c, 1, 1), c);
});

test('v1 (the fixed chain) loads as three slots that sound exactly like createFxDsp (Acid, Send, filters, accent CV)', () => {
  const v1 = defaultState();
  Object.assign(v1.chain[0], { bypass: false }); Object.assign(v1.chain[0].dials, { curve: 1, drive_db: 10.2, tone: 40, mod_drive: 50 });
  Object.assign(v1.chain[1], { bypass: false }); Object.assign(v1.chain[1].dials, { mode: 1, mix: 70, feedback: 55, tone: 60, low_cut: 120, mod_send: 40, beats_free: 0.3 });
  Object.assign(v1.chain[2], { bypass: true }); Object.assign(v1.chain[2].dials, { mix: 40, size: 70 });
  const s = sanitizeSlots(v1);
  assert.deepEqual(s.chain.map((x) => [x.id, x.type, x.bypass]), [['drive-1', 'drive', false], ['delay-1', 'delay', false], ['plate-1', 'plate', true]]);
  for (const x of s.chain) assert.deepEqual(x.dials, sanitize(v1).chain.find((c) => c.type === x.type).dials);
  const [inL, inR] = noiseBursts(48000 * 2, 3);
  const cv = new Float32Array(inL.length).map((_, i) => (i % 6000 < 1500 ? Math.exp(-(i % 6000) / 500) : 0));
  for (const opts of [{ limiter: 'lookahead', preGain: 0.8 }, { limiter: 'soft', bypassMode: 'hold' }]) {
    const fixed = createFxDsp(48000, opts); fixed.setTempo(126, 0, true); fixed.load(compile(v1), 0, true);
    const slots = createFxChainDsp(48000, opts); slots.setTempo(126, 0, true);
    s.chain.forEach((x, i) => { slots.add(i + 1, x.type, 0); for (const [k, v] of slotProgram(x)) slots.set(i + 1, k, v, 0, true); });
    slots.order([1, 2, 3], 0, true);
    const n = inL.length, a = [new Float32Array(n), new Float32Array(n)], b = [new Float32Array(n), new Float32Array(n)];
    for (let o = 0; o < n; o += 128) {
      fixed.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), a[0].subarray(o, o + 128), a[1].subarray(o, o + 128), 128, o, cv.subarray(o, o + 128));
      slots.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), b[0].subarray(o, o + 128), b[1].subarray(o, o + 128), 128, o, cv.subarray(o, o + 128));
    }
    assert.ok(identical(a[0], b[0]) && identical(a[1], b[1]), JSON.stringify(opts));
  }
});

test('every catalog type has a slot program covering all of its engine params', () => {
  for (const e of CATALOG) {
    const p = slotProgram(newSlot(e.type));
    assert.deepEqual(p.map((x) => x[0]).sort((a, b) => a - b), Array.from({ length: e.dials.length + 1 }, (_, i) => i));
  }
});

test('an odd saved Timing in an ASTRID save plays ASTRID\'s note (its notes have no 1/32)', async () => {
  const { migrate } = await import('../src/params.js');
  for (const [raw, want] of [[0.15, 0.25], [0.1, 0.25], [-1e9, 0.25], [0.6, 0.5], [1.3, 1.5], [9, 2]]) {
    const saved = [{ id: 'delay-1', type: 'delay', bypass: false, dials: { delay_beats: raw } }];
    assert.equal(H.sanitizeHacks(saved)[0].dials.delay_beats, want);
    assert.equal(sanitizeSlots(saved).chain[0].dials.delay_beats, want, 'slots');
  }
  // The fixed chain's migrate() keeps its documented 0.1.0 behaviour (test/delay-send.test.mjs): below 3/16 is 1/32.
  assert.equal(migrate([{ type: 'delay', dials: { delay_beats: 0.15 } }]).state.chain[1].dials.delay_beats, 0.125);
  // nc-fx's own states keep 1/32.
  assert.equal(sanitizeSlots({ v: 2, chain: [{ id: 'delay-1', type: 'delay', dials: { delay_beats: 0.125 } }] }).chain[0].dials.delay_beats, 0.125);
});
