// The ASTRID fixtures are ASTRID's files, unmodified (sha256 pinned), and still the synth repo's when one is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKLET, HACKS_TS, WORKLET_SHA, HACKS_TS_SHA, astridRepo } from './astrid.mjs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('fixtures: ASTRID\'s shipped hack worklet and hacks.ts at 7292c57 (sha256 pinned)', () => {
  assert.equal(sha(WORKLET), WORKLET_SHA);
  assert.equal(sha(HACKS_TS), HACKS_TS_SHA);
});

const repo = astridRepo();
test('fixtures match a synth checkout (NC_FX_ASTRID_REPO or ../netcomposer-synth)', { skip: repo ? false : 'no synth checkout here' }, () => {
  const src = join(repo, 'lib/synth-audio/src');
  assert.equal(readFileSync(join(src, 'hacks.ts'), 'utf8'), readFileSync(HACKS_TS, 'utf8'), 'hacks.ts changed in ASTRID: re-pin the fixture and re-run the parity tests');
  const ts = readFileSync(join(src, 'hacks-worklet-source.ts'), 'utf8');
  const shipped = JSON.parse(ts.match(/export const hacksWorkletSource = (".*");\s*$/s)[1]);
  assert.equal(shipped, readFileSync(WORKLET, 'utf8'), 'ASTRID\'s hack worklet changed: re-pin the fixture and re-run the parity tests');
  assert.equal(sha(join(src, 'hacks-vendor/dsp.js')), 'ae783eea575fc74d6f49b94ba1465717d070e8096b4ebf2907b62878e17985d2');
});
