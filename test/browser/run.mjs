// Headless Chrome test: serves the repo on a local port (> 5600) and runs test/browser/render.js.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = +(process.env.NC_FX_TEST_PORT || 5617);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  if (p.startsWith('..')) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }).end(await readFile(join(root, p))); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const browser = await chromium.launch();
let failed = 1;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(`http://127.0.0.1:${port}/test/browser/index.html`);
  await page.waitForFunction(() => window.__results, null, { timeout: 120000 });
  const results = await page.evaluate(() => window.__results);
  for (const r of results) console.log(`${r.ok ? 'ok    ' : 'not ok'} ${r.name}${r.info ? ` (${r.info})` : ''}`);
  failed = results.filter((r) => !r.ok).length;
  console.log(`# browser tests ${results.length}, pass ${results.length - failed}, fail ${failed}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
