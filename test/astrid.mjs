// ASTRID's own code for the parity tests, from pinned copies (so CI needs no synth checkout):
//   fixtures/astrid-hacks-worklet-7292c57.js  the hack worklet ASTRID ships (lib/synth-audio/src/hacks-worklet-source.ts:
//                                             the site's dsp.js + hacks-astrid/mod.js + rt-patches.js, as built), and
//   fixtures/astrid-hacks-7292c57.ts          lib/synth-audio/src/hacks.ts (dials, laws, formats, sanitizeHacks),
// both psemmelhack/NetComposer-Synth 7292c57 (main, 2026-10-29). test/astrid-fixtures.test.mjs pins their sha256 and,
// when a synth checkout is present (NC_FX_ASTRID_REPO, or ../netcomposer-synth), checks they are still its files.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

export const WORKLET = fileURLToPath(new URL('./fixtures/astrid-hacks-worklet-7292c57.js', import.meta.url));
export const HACKS_TS = fileURLToPath(new URL('./fixtures/astrid-hacks-7292c57.ts', import.meta.url));
export const WORKLET_SHA = '47f4b78a4a41a464034b7fa9447065bc10972c1bfd7b4174e5bc08b2fa8312b7';
export const HACKS_TS_SHA = '4ab918a5e93960d5202f7fc35a042d33db46de5e1cf46f57ca448e351d135a39';

/** ASTRID's worklet functions (the shipped build; its step functions take samples through NC_IO). */
export function astridWorklet(sampleRate = 48000) {
  const src = readFileSync(WORKLET, 'utf8');
  return new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'currentTime',
    src + '\nreturn { ncChainCreate, ncChainSet, ncChainAdd, ncChainOrder, ncChainPatch, ncChainClear, ncRender, ncWidgetCreate, ncWidgetApply, NC_IO,' +
    ' ncWidgetStep: function (st, xL, xR, out) { NC_IO[0] = xL; NC_IO[1] = xR; ncWidgetStep(st, NC_IO, out); } };')(class {}, () => {}, sampleRate, 0);
}

let hacks = null;
/** ASTRID's hacks.ts (transpiled with this repo's TypeScript), as a module. */
export async function astridHacks() {
  if (hacks) return hacks;
  const out = ts.transpileModule(readFileSync(HACKS_TS, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  hacks = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'));
  return hacks;
}

/** A synth checkout to compare the fixtures with, or null. */
export function astridRepo() {
  const dir = process.env.NC_FX_ASTRID_REPO || fileURLToPath(new URL('../../netcomposer-synth', import.meta.url));
  return existsSync(join(dir, 'lib/synth-audio/src/hacks.ts')) ? dir : null;
}

/** Render ASTRID's chain in 128-frame blocks; hook(chain, offset) runs before each block (patches, adds, orders). */
export function renderAstrid(W, chain, inL, inR, hook) {
  const n = inL.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0; o < n; o += 128) {
    if (hook) hook(chain, o);
    W.ncRender(chain, inL.subarray(o, o + 128), inR.subarray(o, o + 128), oL.subarray(o, o + 128), oR.subarray(o, o + 128));
  }
  return [oL, oR];
}
