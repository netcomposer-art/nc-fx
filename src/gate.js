// Gate's patterns (main thread): the shapes, the starting patterns, a saved pattern cleaned, and the pattern packed
// into the engine's six params (k 10-15, src/units.js unitGate).
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// A Gate slot (src/slots.js) carries `pattern: { levels: [16], shapes: [16] }` beside its dials: levels 0-100 (%),
// shapes 0-4 (GATE_SHAPES). Steps 8 uses the first eight; the other eight are kept, so 8 -> 16 -> 8 loses nothing.

/** The step shapes, by code. */
export var GATE_SHAPES = ['hard', 'pump', 'swell', 'blip', 'glide'];
/** Their names in the UI. */
export var GATE_SHAPE_LABELS = ['Hard', 'Pump', 'Swell', 'Blip', 'Glide'];
export var GATE_STEPS = 16;

function rep(a) { var out = []; for (var i = 0; i < GATE_STEPS; i++) out.push(a[i % a.length]); return out; }

/**
 * The starting patterns (Peter, 2026-11-06: our own names), in the picker's order. Each is the dials it sets and a
 * pattern. Ducker is where a new Gate starts.
 */
export var GATE_PATTERNS = [
  { name: 'Ducker', note: 'The four-on-the-floor duck: every beat dips and comes back.',
    dials: { rate: 4, steps: 8, swing: 0, depth: 90, mode: 0 }, levels: rep([100]), shapes: rep([1]) },
  { name: 'Tide', note: 'One slow breath a bar.',
    dials: { rate: 8, steps: 16, swing: 0, depth: 85, mode: 0 }, levels: rep([15, 35, 60, 85, 100, 85, 60, 35]), shapes: rep([4]) },
  { name: 'Stutter', note: 'A sixteenth gate with gaps.',
    dials: { rate: 16, steps: 16, swing: 0, depth: 100, mode: 0 }, levels: [100, 0, 100, 100, 0, 100, 0, 100, 100, 0, 100, 100, 0, 100, 100, 0], shapes: rep([0]) },
  { name: 'Lope', note: 'Swung eighths, short hits.',
    dials: { rate: 8, steps: 16, swing: 50, depth: 100, mode: 0 }, levels: rep([100, 55, 85, 40, 100, 55, 85, 70]), shapes: rep([3]) },
  { name: 'Embers', note: 'Each eighth swells and cuts; the bar fades.',
    dials: { rate: 8, steps: 8, swing: 0, depth: 100, mode: 0 }, levels: rep([100, 85, 70, 60, 50, 40, 30, 20]), shapes: rep([2]) },
  { name: 'Sieve', note: 'Filter mode: sixteenths open a low-pass, a climb at the end of the bar.',
    dials: { rate: 16, steps: 16, swing: 0, depth: 85, mode: 1, res: 35 }, levels: [100, 20, 55, 25, 95, 25, 60, 35, 100, 20, 55, 25, 70, 80, 90, 100], shapes: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0] }
];
/** Where a new Gate starts. */
export var GATE_DEFAULT = 'Ducker';

/** A starting pattern by name (case-insensitive), or null. Returns copies. */
export function gatePreset(name) {
  var n = String(name || '').toLowerCase();
  for (var i = 0; i < GATE_PATTERNS.length; i++) {
    var p = GATE_PATTERNS[i];
    if (p.name.toLowerCase() === n) return { name: p.name, dials: Object.assign({}, p.dials), pattern: { levels: p.levels.slice(), shapes: p.shapes.slice() } };
  }
  return null;
}

function int(v, lo, hi, d) {
  if (typeof v !== 'number' || !isFinite(v)) return d;
  v = Math.round(v);
  return v < lo ? lo : v > hi ? hi : v;
}
/** Any saved pattern to a clean one (16 levels 0-100, 16 shapes 0-4); missing or bad values are the default's. */
export function cleanPattern(raw) {
  var d = GATE_PATTERNS[0], r = raw && typeof raw === 'object' ? raw : {};
  var lv = Array.isArray(r.levels) ? r.levels : [], sh = Array.isArray(r.shapes) ? r.shapes : [];
  var out = { levels: [], shapes: [] };
  for (var i = 0; i < GATE_STEPS; i++) {
    out.levels.push(int(lv[i], 0, 100, d.levels[i]) + 0);
    out.shapes.push(int(sh[i], 0, GATE_SHAPES.length - 1, d.shapes[i]) + 0);
  }
  return out;
}
/** The pattern as the engine's params: [[10, levels 1-4], ... [13, levels 13-16], [14, shapes 1-8], [15, shapes 9-16]]. */
export function packPattern(pattern) {
  var p = cleanPattern(pattern), out = [], g, i, v;
  for (g = 0; g < 4; g++) { v = 0; for (i = 3; i >= 0; i--) v = v * 101 + p.levels[g * 4 + i]; out.push([10 + g, v]); }
  for (g = 0; g < 2; g++) { v = 0; for (i = 7; i >= 0; i--) v = v * 5 + p.shapes[g * 8 + i]; out.push([14 + g, v]); }
  return out;
}
/**
 * The starting pattern a Gate slot is on (its dials and its pattern match one, over the steps it plays), or
 * 'Custom'. The picker shows it.
 */
export function gatePatternName(slot) {
  if (!slot || !slot.dials) return 'Custom';
  var p = cleanPattern(slot.pattern);
  for (var i = 0; i < GATE_PATTERNS.length; i++) {
    var g = GATE_PATTERNS[i], same = true, k;
    for (k in g.dials) if (slot.dials[k] !== g.dials[k]) same = false;
    var n = g.dials.steps;
    for (k = 0; same && k < n; k++) if (p.levels[k] !== g.levels[k] || p.shapes[k] !== g.shapes[k]) same = false;
    if (same) return g.name;
  }
  return 'Custom';
}
/** How many steps play each pass: 12 at most for 1/8T (it restarts every bar of 4 beats), else Steps. */
export function gateStepsPlayed(dials) {
  var n = dials && dials.steps === 8 ? 8 : 16;
  return dials && dials.rate === 12 && n > 12 ? 12 : n;
}
/**
 * The step playing at `beat` (transport beats from bar 1) for a Gate's dials, as the engine counts it (swing and
 * 1/8T's bar restart included). For the host's playhead. beatsPerBar defaults to 4.
 */
export function gateStepAt(dials, beat, beatsPerBar) {
  var rate = dials && (dials.rate === 4 || dials.rate === 8 || dials.rate === 12) ? dials.rate : 16;
  var n = dials && dials.steps === 8 ? 8 : 16, per = 4 / rate, b = +beat || 0;
  if (rate === 12) { var bar = beatsPerBar > 0 ? beatsPerBar : 4; b -= Math.floor(b / bar) * bar; }
  var sw = 0.5 + 0.25 * (dials && typeof dials.swing === 'number' ? dials.swing : 0) / 100;
  var q = b / per * 0.5, fp = Math.floor(q), f = q - fp, pair = ((fp % 16) + 16) % 16;
  var idx = f < sw ? pair * 2 : pair * 2 + 1;
  return idx & (n - 1);
}
/**
 * The gain target (0..1) across step i, as n + 1 samples: the shape the engine plays over that step at its level
 * (Glide leans into the next step that plays). Depth and Mix are not in it: it draws the pattern. For a host's strip.
 */
export function gateCurve(dials, pattern, i, n) {
  var p = cleanPattern(pattern), steps = dials && dials.steps === 8 ? 8 : 16, played = gateStepsPlayed(dials);
  var s = ((i % steps) + steps) % steps, next = s + 1 >= played ? 0 : s + 1;
  var L = p.levels[s] / 100, Ln = p.levels[next] / 100, shape = p.shapes[s], out = [], m = n > 0 ? n : 24;
  for (var k = 0; k <= m; k++) {
    var t = k / m, g, c;
    switch (shape) {
      case 1: c = t * 1.6667; if (c > 1) c = 1; g = L * c * (2 - c); break;
      case 2: g = L * t * t; break;
      case 3: g = t < 0.12 ? L : L * Math.exp((0.12 - t) * 18); break;
      case 4: c = t * t * (3 - 2 * t); g = L + (Ln - L) * c; break;
      default: g = L;
    }
    out.push(g);
  }
  return out;
}
