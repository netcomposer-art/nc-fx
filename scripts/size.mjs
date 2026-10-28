// Gzipped sizes of what an app ships: the core (main thread), the worklet chunk (fetched lazily, or
// served as a file) and the panel (lazy). Raw = the source files as published; min = esbuild-minified.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const gz = (s) => gzipSync(Buffer.from(s), { level: 9 }).length;
const raw = (files) => files.map((f) => readFileSync(f, 'utf8')).join('\n');
function minified(entry, externals) {
  try {
    const args = ['--yes', 'esbuild@0.25.10', entry, '--bundle', '--minify', '--format=esm', '--log-level=error', ...externals.map((e) => `--external:${e}`)];
    return execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}
const groups = [
  ['core (index + params, main thread)', ['src/index.js', 'src/params.js'], 'src/index.js', ['../dist/worklet-source.js', './ui.js']],
  ['worklet (dist/worklet.js, lazy / served)', ['dist/worklet.js'], 'dist/worklet.js', []],
  ['ui (ui + css, lazy)', ['src/ui.js', 'src/ui-style.js'], 'src/ui.js', ['./params.js']],
];
const rows = groups.map(([name, files, entry, ext]) => {
  const m = minified(entry, ext);
  return { name, rawGz: gz(raw(files)), minGz: m === null ? null : gz(m) };
});
const kb = (n) => (n === null ? 'n/a' : (n / 1024).toFixed(1) + ' KiB'); // KiB = 1024 B; the exact bytes follow
for (const r of rows) console.log(`${r.name.padEnd(44)} gzip ${kb(r.rawGz).padStart(8)}   minified+gzip ${kb(r.minGz).padStart(9)} (${r.minGz === null ? 'n/a' : r.minGz} B)`);
