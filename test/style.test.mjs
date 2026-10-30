// Colour only from nc-ui tokens; nothing green; motion only through nc-ui roles, never on a modulated
// slider, and none under reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FX_UI_CSS } from '../src/ui-style.js';

const ui = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
/** Split on commas outside parentheses. */
function splitTop(v) { const out = []; let depth = 0, cur = ''; for (const ch of v) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; }
const NAMED = /\b(red|green|blue|lime|olive|teal|navy|aqua|yellow|orange|purple|white|black|gr[ae]y|silver|maroon|fuchsia|cyan|magenta|pink|brown)\b/i;

test('no hardcoded colours anywhere in the UI (only var(--nc-ui-*), currentColor, inherit, transparent)', () => {
  for (const [name, src] of [['css', FX_UI_CSS], ['ui.js', ui]]) {
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(src), `${name}: hex colour`);
    assert.ok(!/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(src), `${name}: colour function`);
    assert.ok(!NAMED.test(src.replace(/--nc-ui-[\w-]+/g, '')), `${name}: named colour`);
    assert.ok(!/green/i.test(src), `${name}: green`);
  }
  assert.match(FX_UI_CSS, /var\(--nc-ui-accent,currentColor\)/);
  // Fallbacks of colour properties are currentColor/inherit/transparent only.
  for (const m of FX_UI_CSS.matchAll(/(?:^|[;{])\s*(color|background|border(?:-color)?|outline|accent-color)\s*:\s*([^;}]+)/g)) {
    const v = m[2].replace(/var\(--nc-ui-[\w-]+,\s*(currentColor|inherit|transparent)\)/g, '').replace(/\b(currentColor|inherit|transparent|solid|\d+px|none)\b/g, '').trim();
    assert.equal(v, '', `${m[1]}: ${m[2]}`);
  }
});

test('motion: only through nc-ui roles, 100-250 ms fallbacks, off when modulated and under reduced motion', () => {
  const durations = [...FX_UI_CSS.matchAll(/transition\s*:\s*([^;}]+)/g)].map((m) => m[1]);
  assert.ok(durations.length > 0);
  for (const d of durations) {
    if (d.trim() === 'none') continue;
    for (const part of splitTop(d)) {
      const m = part.match(/var\(--nc-ui-(transition|motion)-[\w-]+,\s*([\d.]+)(m?s)\)/);
      assert.ok(m, `transition not through an nc-ui role: ${part}`);
      const ms = m[3] === 's' ? +m[2] * 1000 : +m[2];
      assert.ok(ms >= 100 && ms <= 250, `${part}: ${ms} ms`);
    }
  }
  assert.ok(!/animation\s*:\s*(?!none)/.test(FX_UI_CSS), 'no animations');
  assert.match(FX_UI_CSS, /\[data-modulated\]\{transition:none\}/);
  assert.match(FX_UI_CSS, /@media \(prefers-reduced-motion:reduce\)\{\.nc-fx,\.nc-fx \*\{transition:none;animation:none\}\}/);
  assert.ok(!/input\[type=range\][^{]*\{[^}]*transition/.test(FX_UI_CSS), 'sliders never animate');
});

test('panel CSS: nc-ui custom properties only (no px, no colours); the kit\'s markup; nc-ui is never imported', () => {
  assert.ok(!/\d+px\b/.test(FX_UI_CSS), 'raw px');
  assert.ok(!/\b\d*\.?\d+(rem|em|pt|vh|vw)\b/.test(FX_UI_CSS), 'raw lengths');
  for (const m of FX_UI_CSS.matchAll(/var\((--[\w-]+)/g)) assert.ok(m[1].startsWith('--nc-ui-'), m[1]);
  for (const cls of ['nc-ui-fx', 'nc-ui-fx-hd', 'nc-ui-fx-name', 'nc-ui-switch', 'nc-ui-switch-text', 'nc-ui-more', 'nc-field', 'nc-label', 'nc-readout', 'nc-range', 'nc-select', 'nc-note', 'nc-token-probe'])
    assert.ok(ui.includes(`'${cls}'`) || ui.includes(`'${cls} `) || ui.includes(` ${cls}'`), cls);
  for (const attr of ['data-nc-depth', 'data-nc-dim', 'data-nc-fx-switch', 'data-nc-slider', 'data-nc-row', 'data-nc-readout', 'data-nc-on', 'data-nc-off', "'role', 'switch'", "'aria-checked'"]) assert.ok(ui.includes(attr), attr);
  assert.ok(!/from ['"]@netcomposer\/nc-ui/.test(ui) && !/import\(['"]@netcomposer\/nc-ui/.test(ui), 'no nc-ui import');
});
