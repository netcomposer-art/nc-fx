// The catalog is ASTRID's hacks.ts as data: every type, label, note, range, default, option, law and readout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astridHacks } from './astrid.mjs';
import { CATALOG, CATALOG_MENU, CATALOG_TYPES, catalogEntry, catalogDial, formatDial, dialDsp, lawValue, describeCatalog } from '../src/catalog.js';
import { EFFECTS } from '../src/params.js';
import { UNIT, UNIT_NPARAMS } from '../src/units.js';

const H = await astridHacks();
// nc-fx's names for ASTRID's dials where they differ.
const KEY = (type, key) => (type === 'delay' && key === 'wet' ? 'mix' : key);

test('types, order, labels, notes, hidden and the Add menu are ASTRID\'s', () => {
  assert.deepEqual(CATALOG_TYPES, H.HACK_TYPES);
  assert.deepEqual(CATALOG_MENU, H.HACK_MENU.map((d) => d.type));
  for (const def of H.HACK_DEFINITIONS) {
    const e = catalogEntry(def.type);
    assert.equal(e.label, def.label);
    assert.equal(e.note, def.note);
    assert.equal(!!e.hidden, !!def.hidden);
  }
});

test('every ASTRID dial: label, range, default, options; nc-fx\'s extra dials are under More and default to ASTRID\'s sound', () => {
  for (const def of H.HACK_DEFINITIONS) {
    const e = catalogEntry(def.type);
    assert.deepEqual(e.dials.filter((d) => !d.more).map((d) => d.key), def.dials.map((d) => KEY(def.type, d.key)), def.type);
    for (const ad of def.dials) {
      const d = catalogDial(def.type, KEY(def.type, ad.key));
      assert.equal(d.label, ad.label, `${def.type}.${ad.key}`);
      assert.equal(d.default, ad.value);
      assert.equal(d.max, ad.max);
      if (ad.options) {
        // The delay's Timing adds 1/32 (nc-fx); every other option is ASTRID's, with ASTRID's label.
        const mine = d.options.filter((o) => !(def.type === 'delay' && o.value === 0.125));
        assert.deepEqual(mine.map((o) => [o.value, o.label]), ad.options.map((o) => [o[0], o[1]]));
        assert.equal(d.step, null);
      } else { assert.equal(d.min, ad.min); assert.equal(d.step, 1); }
    }
  }
  assert.deepEqual(CATALOG.flatMap((e) => e.dials.filter((d) => d.more).map((d) => `${e.type}.${d.key}`)),
    ['delay.tone', 'delay.low_cut', 'delay.mode', 'delay.send', 'delay.mod_send', 'delay.beats_free', 'drive.curve', 'drive.tone', 'drive.mod_drive', 'drive.mod_tone']);
});

test('every readout, at every dial value and several tempos, is ASTRID\'s format() exactly', () => {
  let n = 0;
  for (const def of H.HACK_DEFINITIONS) for (const ad of def.dials) {
    const d = catalogDial(def.type, KEY(def.type, ad.key));
    const values = ad.options ? ad.options.map((o) => o[0]) : Array.from({ length: ad.max - ad.min + 1 }, (_, i) => ad.min + i);
    for (const v of values) for (const bpm of [20, 60, 97, 120, 133.33, 174, 400]) { assert.equal(formatDial(d, v, bpm), ad.format(v, bpm), `${def.type}.${ad.key}(${v}, ${bpm})`); n++; }
  }
  assert.ok(n > 15000);
});

test('every dial law is hacks.ts hackParams exactly (the engine values ASTRID sends), at every dial value', () => {
  for (const def of H.HACK_DEFINITIONS) for (const ad of def.dials) {
    const d = catalogDial(def.type, KEY(def.type, ad.key));
    const values = ad.options ? ad.options.map((o) => o[0]) : Array.from({ length: ad.max - ad.min + 1 }, (_, i) => ad.min + i);
    for (const v of values) {
      const slot = H.createHack(def.type); slot.dials[ad.key] = v;
      const p = H.hackParams(slot, 120);
      const name = def.type === 'delay' && ad.key === 'wet' ? 'wet' : ad.key === 'rate' ? 'rate_hz' : ad.key;
      if (def.type === 'lowpass' || (def.type === 'highpass' && ad.key === 'cutoff')) {
        // The filters take the cutoff dial itself; the unit applies hackCutoffHz / hpHz, as ASTRID's cutoff_hz.
        assert.equal(dialDsp(d, v), p.cutoff);
        assert.equal(lawValue(d.format.law, v), p.cutoff_hz, `${def.type} cutoff_hz(${v})`);
        continue;
      }
      if (def.type === 'delay' && ad.key === 'delay_beats') { assert.equal(dialDsp(d, v), p.delay_beats); continue; }
      assert.equal(dialDsp(d, v), p[name], `${def.type}.${ad.key}(${v})`);
    }
  }
});

test('the catalog is plain JSON, each dial has its own engine param, and EFFECTS (the fixed chain) comes from it', () => {
  const c = describeCatalog();
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
  assert.deepEqual(c, JSON.parse(JSON.stringify(CATALOG)));
  for (const e of CATALOG) {
    const ks = e.dials.map((d) => d.k);
    assert.deepEqual(ks.slice().sort((a, b) => a - b), Array.from({ length: ks.length }, (_, i) => i + 1), e.type);
    assert.equal(UNIT_NPARAMS[UNIT[e.type]], ks.length + 1, e.type);
  }
  assert.deepEqual(EFFECTS.map((e) => e.type), ['drive', 'delay', 'plate']);
  for (const e of EFFECTS) for (const d of e.dials) {
    const cd = catalogDial(e.type, d.key);
    assert.equal(d.format(d.default, 120), formatDial(cd, d.default, 120));
    assert.equal(d.label, cd.label);
  }
});
