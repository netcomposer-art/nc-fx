// Every ASTRID hack, and ASTRID's chain model, render ASTRID's samples: the same saved hacks (HackSlot[]) go into
// ASTRID's shipped worklet (through hacks.ts hackWidgets, as ASTRID plays them) and into nc-fx (through
// migrateSlots and the slot engine, as an app would load them). Bit-identical, including dial and tempo changes
// while playing and adding, removing and reordering hacks while playing. A bypass change is identical up to the
// change, then differs on purpose (nc-fx's smooth crossfade; README "Differs from ASTRID").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astridWorklet, astridHacks, renderAstrid } from './astrid.mjs';
import { createFxChainDsp } from '../src/chain.js';
import { migrateSlots, slotProgram } from '../src/slots.js';
import { CATALOG, catalogEntry } from '../src/catalog.js';
import { noiseBursts } from './helpers.mjs';

const SR = 48000;
const W = astridWorklet(SR);
const H = await astridHacks();
const ALL = CATALOG.map((e) => e.type);

/** nc-fx's slot engine loaded with a state, as createFxCore does it (adds, snapped params, an immediate order). */
function ncChain(state, tempo, slots = 3) {
  const fx = createFxChainDsp(SR, { limiter: 'lookahead', preGain: 0.8, slots });
  fx.setTempo(tempo, 0, true);
  const uids = new Map();
  let next = 1;
  for (const s of state.chain) {
    const uid = next++;
    uids.set(s.id, uid);
    fx.add(uid, s.type, 0);
    for (const [k, v] of slotProgram(s)) fx.set(uid, k, v, 0, true);
  }
  fx.order(state.chain.map((s) => uids.get(s.id)), 0, true);
  return { fx, uids, next: () => next++ };
}
function renderNc(fx, inL, inR, hook) {
  const n = inL.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0; o < n; o += 128) {
    if (hook) hook(o);
    fx.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), oL.subarray(o, o + 128), oR.subarray(o, o + 128), 128, o);
  }
  return [oL, oR];
}
function firstDiff(a, b) {
  for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) if (!Object.is(a[c][i], b[c][i])) return i;
  return -1;
}
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
/** A random ASTRID dial value (ASTRID's own dial defs: integers, or an option). */
function randomDial(d, r) { return d.options ? d.options[Math.floor(r() * d.options.length)][0] : Math.round(d.min + r() * (d.max - d.min)); }
function hackOf(type, id, dials, bypass = false) {
  const base = H.createHack(type);
  return { id: id ?? base.id, type, bypass, dials: { ...base.dials, ...dials } };
}
function load(hacks, tempo) {
  const chain = W.ncChainCreate(SR);
  W.ncChainSet(chain, H.hackWidgets(hacks, tempo), false);
  return chain;
}
function same(hacks, tempo, seed, label, len = SR) {
  const [inL, inR] = noiseBursts(len, seed);
  const a = renderAstrid(W, load(hacks, tempo), inL, inR);
  const { state } = migrateSlots(hacks);
  const b = renderNc(ncChain(state, tempo).fx, inL, inR);
  assert.equal(firstDiff(a, b), -1, `${label}: first difference at sample ${firstDiff(a, b)}`);
}

test('ASTRID\'s catalog: every hack type is in nc-fx (the three filters hidden, as in ASTRID)', () => {
  assert.deepEqual(ALL.slice().sort(), H.HACK_TYPES.slice().sort());
  assert.deepEqual(CATALOG.filter((e) => e.hidden).map((e) => e.type), H.HACK_DEFINITIONS.filter((d) => d.hidden).map((d) => d.type));
});

for (const type of ALL) {
  test(`parity: ${type} at its defaults, at each dial's ends, and at 12 random settings`, () => {
    const def = H.hackDefinition(type);
    same([hackOf(type)], 120, 1, `${type} defaults`);
    for (const d of def.dials) {
      const ends = d.options ? [d.options[0][0], d.options.at(-1)[0]] : [d.min, d.max];
      for (const v of ends) same([hackOf(type, undefined, { [d.key]: v })], 120, 2, `${type}.${d.key} = ${v}`, SR / 2);
    }
    const r = rng(type.length * 7919);
    for (let k = 0; k < 12; k++) {
      const dials = Object.fromEntries(def.dials.map((d) => [d.key, randomDial(d, r)]));
      same([hackOf(type, undefined, dials)], 80 + Math.round(r() * 100), 3 + k, `${type} random ${JSON.stringify(dials)}`, SR / 2);
    }
  });
}

test('parity: 40 random three-hack chains (any types, any order, some bypassed), at random tempos', () => {
  const r = rng(424242);
  for (let k = 0; k < 40; k++) {
    const hacks = [];
    for (let j = 0; j < 3; j++) {
      const type = ALL[Math.floor(r() * ALL.length)], def = H.hackDefinition(type);
      const h = H.createHack(type, hacks);
      for (const d of def.dials) h.dials[d.key] = randomDial(d, r);
      h.bypass = r() < 0.2;
      hacks.push(h);
    }
    same(hacks, 60 + Math.round(r() * 120), 100 + k, `chain ${k}: ${hacks.map((h) => h.id + (h.bypass ? ' (off)' : '')).join(' > ')}`, SR / 2);
  }
});

/**
 * Plays a chain while `events` change it, the way each app sends changes: ASTRID through HackOutput.sync (add for a
 * new id, order when the ids change, patch for a changed widget), nc-fx through the slot engine (add + snapped
 * params, order, set for each changed dial, tempo).
 */
function playing(start, events, tempo0 = 120, len = SR * 2) {
  const [inL, inR] = noiseBursts(len, 77);
  let hacks = structuredClone(start), tempo = tempo0;
  const chain = load(hacks, tempo);
  let sent = H.hackWidgets(hacks, tempo);
  const nc = ncChain(migrateSlots(hacks).state, tempo);
  const at = (o) => events.filter((e) => e.block * 128 === o);
  const a = renderAstrid(W, chain, inL, inR, (c, o) => {
    for (const e of at(o)) {
      hacks = e.apply(structuredClone(hacks));
      if (e.tempo) tempo = e.tempo;
      const want = H.hackWidgets(hacks, tempo), had = new Map(sent.map((w) => [w.id, w]));
      for (const w of want) if (!had.has(w.id) || had.get(w.id).type !== w.type) W.ncChainAdd(c, w);
      if (want.map((w) => w.id).join('\n') !== sent.map((w) => w.id).join('\n')) W.ncChainOrder(c, want.map((w) => w.id), false);
      for (const w of want) { const old = had.get(w.id); if (old && old.type === w.type && JSON.stringify(old) !== JSON.stringify(w)) W.ncChainPatch(c, w.id, w.params, w.bypass, false); }
      sent = want;
    }
  });
  let cur = migrateSlots(start).state;
  const b = renderNc(nc.fx, inL, inR, (o) => {
    for (const e of at(o)) {
      const next = migrateSlots(e.apply(structuredClone(hacks0(cur)))).state;
      if (e.tempo) nc.fx.setTempo(e.tempo);
      const old = new Map(cur.chain.map((s) => [s.id, s]));
      for (const s of next.chain) {
        const was = old.get(s.id);
        if (!was || was.type !== s.type) {
          const uid = nc.next(); nc.uids.set(s.id, uid);
          nc.fx.add(uid, s.type);
          for (const [k, v] of slotProgram(s)) nc.fx.set(uid, k, v, 0, true);
        } else {
          const p0 = new Map(slotProgram(was)), p1 = slotProgram(s);
          for (const [k, v] of p1) if (p0.get(k) !== v) nc.fx.set(nc.uids.get(s.id), k, v);
        }
      }
      if (next.chain.map((s) => s.id).join() !== cur.chain.map((s) => s.id).join()) nc.fx.order(next.chain.map((s) => nc.uids.get(s.id)));
      cur = next;
    }
  });
  return firstDiff(a, b);
}
// The test's events edit ASTRID's HackSlot[]; nc-fx's state back to that shape (mix -> wet for the delay).
function hacks0(state) {
  return state.chain.map((s) => {
    const dials = { ...s.dials };
    if (s.type === 'delay') { dials.wet = dials.mix; delete dials.mix; }
    return { id: s.id, type: s.type, bypass: s.bypass, dials };
  });
}
const dial = (id, key, v) => (h) => h.map((x) => (x.id === id ? { ...x, dials: { ...x.dials, [key]: v } } : x));

test('parity while playing: every dial of every hack moved mid-stream (smoothing, coefficient updates)', () => {
  for (const type of ALL) {
    const def = H.hackDefinition(type), id = `${type}-1`;
    const r = rng(type.length * 31);
    const events = [];
    let block = 20;
    for (const d of def.dials) for (let j = 0; j < 2; j++) { events.push({ block, apply: dial(id, d.key, randomDial(d, r)) }); block += 9 + Math.floor(r() * 12); }
    const start = [hackOf(type, id, Object.fromEntries(def.dials.map((d) => [d.key, randomDial(d, r)]))), hackOf('plate', 'room', { mix: 30 })];
    assert.equal(playing(start, events, 120, Math.max(SR, (block + 60) * 128)), -1, type);
  }
});

test('parity while playing: tempo changes glide the delay as in ASTRID', () => {
  const start = [hackOf('delay', 'delay-1', { delay_beats: 0.75, feedback: 60, wet: 50 }), hackOf('chorus')];
  assert.equal(playing(start, [{ block: 80, tempo: 97, apply: (h) => h }, { block: 200, tempo: 174, apply: (h) => h }, { block: 260, apply: dial('delay-1', 'delay_beats', 1.5) }]), -1);
});

test('parity while playing: add, remove, reorder and replace hacks (ASTRID\'s 4 ms chain fade, ncKeep), any types', () => {
  const add = (type) => (h) => [...h, H.createHack(type, h)];
  const drop = (id) => (h) => h.filter((x) => x.id !== id);
  const move = (from, to) => (h) => H.moveHack(h, from, to);
  const start = [hackOf('eq', 'eq-1', { low_db: 6, mid_db: -4, high_db: 3 }), hackOf('delay', 'delay-1', { wet: 40, feedback: 55 })];
  const events = [
    { block: 40, apply: add('flanger') },
    { block: 90, apply: move(2, 0) },
    { block: 140, apply: drop('eq-1') },
    { block: 190, apply: add('compressor') },
    { block: 240, apply: move(0, 2) },
    { block: 241, apply: move(1, 0) },      // a reorder during the first one's fade (ASTRID restarts the fade out)
    { block: 300, apply: (h) => [...drop('delay-1')(h), H.createHack('delay', drop('delay-1')(h))] }, // a fresh delay, same id
    { block: 360, apply: (h) => [] },        // everything out (the chain fades to its empty order)
    { block: 420, apply: add('phaser') },
    { block: 421, apply: add('width') },
    { block: 470, apply: add('drive') },
  ];
  assert.equal(playing(start, events, 120, SR * 2), -1);
});

test('parity while playing: a bypass change is identical up to it, then differs (nc-fx\'s smooth crossfade, on purpose)', () => {
  const start = [hackOf('phaser', 'phaser-1'), hackOf('eq', 'eq-1', { mid_db: 9 })];
  const d = playing(start, [{ block: 150, apply: (h) => h.map((x) => (x.id === 'eq-1' ? { ...x, bypass: true } : x)) }]);
  assert.ok(d > 150 * 128, `differs at ${d}`);
});

test('two of a kind and up to 8 slots: the engine holds them, each with its own state', () => {
  const hacks = [hackOf('delay', 'delay-1', { wet: 30 }), hackOf('delay', 'delay-2', { delay_beats: 1.5, wet: 30 }), hackOf('chorus', 'chorus-1')];
  same(hacks, 133, 9, 'two delays');
  const { state } = migrateSlots([...hacks, hackOf('phaser'), hackOf('eq', undefined, { low_db: 5 })], 8);
  assert.equal(state.chain.length, 5);
  const fx = ncChain(state, 120, 8).fx;
  assert.deepEqual(fx.playing().length, 5);
  assert.equal(catalogEntry('delay').dials.length, 9);
});
