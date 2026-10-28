// nc-fx mod bus: control signals (CV) that move engine params, sample by sample. MIT License, Peter Semmelhack.
//
// One source today: 'accent' (source 0), the audio-rate signal on the node's second input (`modInput: true`,
// fx.modInput) or the 7th argument of createFxDsp().process(). A route sends one source to one engine target
// with a depth. The table has MOD_MAX_ROUTES slots:
//   routes 0-2  fixed: drive amount, drive tone, delay send. Their depths will mirror per-target dials at fixed
//               param indexes (design-addendum-bass-gaps.md, PR B/C).
//   routes 3-7  free: for a later `mods: [{src, to, depth}]` list from the state (design.md §2b). Filling them
//               adds no params and moves no index.
// No route has a depth yet, so the bus never switches on: with the mod signal absent, present at zero depth, or
// present with nothing routed, the engine runs exactly the code it ran before the mod input existed.
//
// Pure ES2019, no imports, all state in typed arrays allocated here: scripts/build.mjs inlines this file into
// dist/worklet.js ahead of src/dsp.js.

export var MOD_SOURCES = ['accent'];
export var MOD_MAX_ROUTES = 8;
export var MOD_FIXED_ROUTES = 3;

/** A route table: RS source, RT target (-1 = unused), RD depth; M[0] is 1 while the bus is on this block. */
export function createModBus() {
  var bus = { RS: new Int32Array(MOD_MAX_ROUTES), RT: new Int32Array(MOD_MAX_ROUTES), RD: new Float64Array(MOD_MAX_ROUTES), M: new Float64Array(1) };
  for (var r = 0; r < MOD_MAX_ROUTES; r++) bus.RT[r] = -1;
  return bus;
}

/** Sets one route (control thread, not per sample). depth 0 or target -1 leaves the route idle. */
export function modRoute(bus, r, src, target, depth) {
  if (!(r >= 0 && r < MOD_MAX_ROUTES)) return;
  bus.RS[r] = src | 0;
  bus.RT[r] = target | 0;
  bus.RD[r] = isFinite(depth) ? +depth : 0;
}

/** Once per block: is the bus on? Needs a mod buffer covering the block and at least one live route. */
export function modBlock(bus, mod, frames) {
  var on = 0;
  if (mod !== null && mod !== undefined && mod.length >= frames) {
    for (var r = 0; r < MOD_MAX_ROUTES; r++) if (bus.RT[r] >= 0 && bus.RD[r] !== 0) { on = 1; break; }
  }
  bus.M[0] = on;
  return on;
}
