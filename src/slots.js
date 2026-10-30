// nc-fx slot chain state (v2): ASTRID's chain model, up to N effects (default 3) of any catalog type, in play order.
// Imports ASTRID's saves losslessly and exports them back.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// State: { v: 2, chain: [{ id, type, bypass, dials }] }, first to last (the limiter is fixed after the last and is
// not a slot). ids are ASTRID's ('delay-1', 'drive-2'); dials are in UI units (catalog dials). JSON-safe.
//
// Loads (never throws; anything unreadable is dropped and reported):
//   - nc-fx v2 (this), and v1 (the fixed chain: its drive, delay and plate become three slots, as they play);
//   - ASTRID's saved hacks (HackSlot[]: settings.hacks in presets, snapshots, autosaves and files), sanitised exactly
//     as hacks.ts sanitizeHacks does: the first `max` known hacks, ids kept when valid and unique, bypass only when
//     true, each dial through dialValue;
//   - ASTRID's worklet widgets (HackWidget[], params in DSP units) and the site's schema-2 document
//     ({ schema: 2, chain: [...widgets, limiter] }): each param back to its dial through the inverse of hacks.ts's law.
import { CATALOG_TYPES, catalogEntry, catalogType, dialDsp, lawValue, delaySeconds, ASTRID_NOTES } from './catalog.js';
import { clampDial, dialStep, astridBeats } from './params.js';

export var SLOTS_VERSION = 2;
/** ASTRID's MAX_HACKS: the default number of slots. */
export var DEFAULT_SLOTS = 3;
var ID = /^[A-Za-z0-9][A-Za-z0-9 _./:+-]{0,63}$/;

function isRecord(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** A new slot at the catalog's starting dials, with an id not yet in the chain (ASTRID's createHack). */
export function newSlot(type, chain) {
  var e = catalogEntry(type);
  if (!e) return null;
  var used = {};
  (chain || []).forEach(function (h) { if (h && h.id) used[h.id] = true; });
  var n = 1;
  while (used[e.type + '-' + n]) n++;
  var dials = {};
  e.dials.forEach(function (d) { dials[d.key] = d.default; });
  return { id: e.type + '-' + n, type: e.type, bypass: false, dials: dials };
}
/** "Drive", or "Drive 2" for a second one (ASTRID's nameOf). */
export function slotName(slot) {
  var e = catalogEntry(slot.type), m = /-(\d+)$/.exec(slot.id || '');
  return (e ? e.label : slot.type) + (m && +m[1] > 1 ? ' ' + m[1] : '');
}
/** The chain with one slot moved (indexes clamped); the same array if nothing moves (ASTRID's moveHack). */
export function moveSlot(chain, from, to) {
  var last = chain.length - 1, j = Math.max(0, Math.min(last, to));
  if (from < 0 || from > last || from === j) return chain;
  var next = chain.slice(), item = next.splice(from, 1)[0];
  next.splice(j, 0, item);
  return next;
}

// ASTRID's dialValue for the delay's Timing: the nearest of ASTRID's notes (no 1/32), so an odd saved value plays the
// note ASTRID plays. Anything else is clampDial's job.
function snapBeats(raw) { return typeof raw === 'number' && isFinite(raw) ? astridBeats(raw) : raw; }
/** One saved slot's dials, clamped (dialValue), from raw dials (UI units). astrid: the save is ASTRID's. */
function cleanDials(e, raw, astrid) {
  var out = {};
  e.dials.forEach(function (d) {
    var v = raw[d.key];
    if (v === undefined && d.astridKey) v = raw[d.astridKey];
    if (astrid && e.type === 'delay' && d.key === 'delay_beats') v = snapBeats(v);
    out[d.key] = clampDial(d, v);
  });
  // A dial whose step depends on another (drive_db: 0.1 dB in Acid) is clamped again with the right step.
  e.dials.forEach(function (d) { if (d.stepWhen) out[d.key] = clampDial(d, typeof raw[d.key] === 'number' ? raw[d.key] : out[d.key], dialStep(d, out)); });
  return out;
}
/** An engine param (DSP units) back to its dial value: the inverse of hacks.ts's law, to the dial's whole steps. */
function fromParam(d, p) {
  if (typeof p !== 'number' || !isFinite(p)) return undefined;
  var s = d.dsp;
  if (!s) return p;
  if (s.div) return Math.round(p * s.div * 1e6) / 1e6; // e.g. 0.35 -> 35 (exactly, not 35.00000000000001)
  var best = d.min, err = Infinity;
  for (var v = d.min; v <= d.max; v++) {
    var x = lawValue(s.law, v), e = x === null ? Infinity : Math.abs(x - p);
    if (e < err) { err = e; best = v; }
  }
  return best;
}
// ASTRID's widget param names where they differ from the dial key.
var PARAM_OF = { rate: 'rate_hz' };
function widgetDials(e, params, notes, id) {
  var raw = {};
  e.dials.forEach(function (d) {
    if (d.more) return; // nc-fx's own dials: not in ASTRID's widgets (their defaults are ASTRID's sound)
    var name = d.astridKey || PARAM_OF[d.key] || d.key;
    raw[d.key] = fromParam(d, params[name]);
  });
  // The site's first EQ voicing (before 2026-10-21: 250 Hz / 4 kHz shelves, Q 0.9, +-12 dB) has no low_hz, high_hz
  // or mid_q. It loads as today's voicing, which sounds different: say so.
  if (e.type === 'eq' && params.low_hz == null && params.high_hz == null && params.mid_q == null) notes.push(id + ': EQ from before 2026-10-21 (first voicing) loads as the current one');
  return raw;
}

/**
 * Any saved chain to a clean v2 state of at most `max` slots. Never throws.
 * @returns {{ state: {v: 2, chain: object[]}, dropped: string[], notes: string[] }}
 */
export function migrateSlots(raw, max) {
  var cap = max > 0 ? Math.floor(max) : DEFAULT_SLOTS;
  var dropped = [], notes = [], list = [], fromFixed = false, astrid = false;
  if (Array.isArray(raw)) { list = raw; astrid = true; } // ASTRID's HackSlot[] or HackWidget[]
  else if (isRecord(raw) && Array.isArray(raw.chain)) { list = raw.chain; fromFixed = raw.v === 1; astrid = raw.schema === 2; }
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!isRecord(item)) continue;
    if (item.type === 'limiter' || item.fixed === true) continue; // schema 2's fixed limiter: not a slot
    var type = catalogType(item.type), e = type && catalogEntry(type);
    if (!e || (fromFixed && ['drive', 'delay', 'plate'].indexOf(type) < 0)) { if (typeof item.type === 'string') dropped.push(item.type); continue; }
    if (out.length >= cap) { dropped.push(item.id || type); continue; } // over the cap: keep the first (ASTRID)
    var dials;
    if (isRecord(item.params) && !isRecord(item.dials)) dials = cleanDials(e, widgetDials(e, item.params, notes, item.id || type), astrid);
    else dials = cleanDials(e, isRecord(item.dials) ? item.dials : {}, astrid);
    var fresh = newSlot(type, out);
    var id = typeof item.id === 'string' && ID.test(item.id) && !out.some(function (h) { return h.id === item.id; }) ? item.id : fresh.id;
    // v1 (nc-fx's fixed chain) is bypassed unless explicitly false; ASTRID's and v2's only when true.
    var bypass = fromFixed ? item.bypass !== false : item.bypass === true;
    out.push({ id: fromFixed ? fresh.id : id, type: type, bypass: bypass, dials: dials });
  }
  return { state: { v: SLOTS_VERSION, chain: out }, dropped: dropped, notes: notes };
}
/** migrateSlots() without the report. */
export function sanitizeSlots(raw, max) { return migrateSlots(raw, max).state; }

/** The engine params for one slot: [k, value] pairs (k 0 = on), DSP units. */
export function slotProgram(slot) {
  var e = catalogEntry(slot.type), out = [[0, slot.bypass ? 0 : 1]];
  e.dials.forEach(function (d) { out.push([d.k, dialDsp(d, slot.dials[d.key])]); });
  return out;
}

/**
 * The chain as ASTRID saves it (HackSlot[], settings.hacks), and what ASTRID can't hold: nc-fx's own dials away
 * from their defaults (ASTRID would play them at the defaults), a 1/32 delay (ASTRID's shortest is 1/16), and slots
 * past ASTRID's three.
 * @returns {{ hacks: object[], lossy: string[] }}
 */
export function toAstridHacks(state) {
  var s = sanitizeSlots(state, 8), lossy = [];
  var hacks = s.chain.map(function (h, i) {
    var e = catalogEntry(h.type), dials = {};
    if (i >= DEFAULT_SLOTS) lossy.push(h.id + ': ASTRID keeps three hacks');
    e.dials.forEach(function (d) {
      var v = h.dials[d.key];
      if (d.more) { if (v !== d.default) lossy.push(h.id + '.' + d.key); return; }
      if (d.key === 'delay_beats' && ASTRID_NOTES.indexOf(v) < 0) lossy.push(h.id + '.delay_beats');
      dials[d.astridKey || d.key] = v;
    });
    return { id: h.id, type: h.type, bypass: h.bypass, dials: dials };
  });
  return { hacks: hacks, lossy: lossy };
}
/** ASTRID's widget params for one slot at a tempo (hacks.ts hackParams), in ASTRID's key order. */
export function astridParams(slot, tempo) {
  var e = catalogEntry(slot.type), v = function (k) { return slot.dials[k]; }, D = function (k) { return dialDsp(dialOf(e, k), v(k)); };
  switch (slot.type) {
    case 'lowpass': return { cutoff: v('cutoff'), cutoff_hz: lawValue(dialOf(e, 'cutoff').format.law, v('cutoff')), q: 0.7071067811865476 };
    case 'delay': {
      var beats = v('delay_beats'), note = dialOf(e, 'delay_beats').options.filter(function (o) { return o.value === beats; })[0];
      return { delay_beats: beats, delay_timing: note ? note.label : String(beats), delay_s: +delaySeconds(beats, tempo).toFixed(4), feedback: D('feedback'), wet: D('mix') };
    }
    case 'plate': return { predelay: D('predelay'), size: D('size'), decay: D('decay'), damping: D('damping'), mix: D('mix') };
    case 'eq': return { low_db: v('low_db'), mid_db: v('mid_db'), mid_hz: D('mid_hz'), high_db: v('high_db'), low_hz: 150, high_hz: 6000, mid_q: D('mid_q') };
    case 'highpass': return { cutoff: v('cutoff'), cutoff_hz: lawValue(dialOf(e, 'cutoff').format.law, v('cutoff')), q: D('q') };
    case 'bandpass': return { centre_hz: D('centre_hz'), q: D('q'), mix: D('mix') };
    case 'drive': return { drive_db: v('drive_db'), output_db: v('output_db'), mix: D('mix') };
    case 'compressor': return { threshold_db: v('threshold_db'), ratio: D('ratio'), attack_ms: v('attack_ms'), release_ms: v('release_ms'), makeup_db: v('makeup_db') };
    case 'width': return { width: D('width'), balance: D('balance') };
    case 'flanger': return { rate_hz: D('rate'), depth: D('depth'), feedback: D('feedback'), mix: D('mix') };
    case 'chorus': return { rate_hz: D('rate'), depth: D('depth'), spread: D('spread'), mix: D('mix') };
    case 'phaser': return { rate_hz: D('rate'), depth: D('depth'), stages: v('stages'), feedback: D('feedback'), mix: D('mix') };
  }
  return {};
}
function dialOf(e, key) { for (var i = 0; i < e.dials.length; i++) if (e.dials[i].key === key) return e.dials[i]; return null; }
/** The site's schema-2 document (hacks.ts hackChainDocument): the widgets, then the fixed limiter. */
export function toAstridDocument(state, tempo) {
  var s = sanitizeSlots(state, 8);
  return { schema: 2, chain: s.chain.map(function (h) { return { id: h.id, type: h.type, version: 1, bypass: h.bypass, params: astridParams(h, tempo) }; })
    .concat([{ id: 'limiter', type: 'limiter', version: 1, bypass: false, fixed: true, params: {} }]) };
}
void CATALOG_TYPES;
