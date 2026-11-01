# AGENTS.md: nc-fx

For AI agents (and people) working in this repo. Short on purpose; the README has the detail.

## What this is

`@netcomposer/nc-fx`: NetComposer's one effects module. ASTRID's whole Hacks catalog (drive, delay, reverb, EQ,
compressor, width, flanger, chorus, phaser, filters) as a fixed chain or a slot chain, one AudioWorklet processor
(`nc-fx@1`), the catalog every host renders its FX cards from, and insert plugins. Used by the Studio's Mix, ASTRID,
Bass, Rhythm, LUCY and NYX (each vendors a copy). Plain ES modules with `.d.ts` types, no runtime dependencies. MIT.

## Commands

```sh
npm ci
npm run build          # regenerate dist/ after editing src/mod.js, units.js, dsp.js, plugin-host.js, chain.js, processor.js or ui-style.js
npm run check:build    # CI: dist/ is fresh
npm run typecheck
npm test               # node tests, about 7 minutes (parity, allocation gates, denormals, plugins, the checker)
npm run test:browser   # headless Chromium; PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs if this repo's has no browsers
node scripts/check-plugin.mjs test/fixtures/plugins/tremolo --browser   # the plugin checker (CI runs this)
```

`NC_FX_TEST_PORT` sets the browser test's port (default 5617).

## Rules

- **Never edit generated files.** `dist/` is built by `scripts/build.mjs` and committed (git dependencies need no
  build step). Edit `src/`, run `npm run build`, commit both.
- **Sound is sacred.** Built-in effects render ASTRID's samples bit for bit; the parity tests prove it. Don't change
  DSP arithmetic without a test that says what changed and why. With no plugin in a chain the worklet renders what
  the previous build rendered (`test/plugin-zero-cost.test.mjs`).
- **Nothing allocates on the audio path.** No `new`, `[]`, `{}`, closures or array methods in `process()`, `step()`,
  `set()` or `run()`; numbers cross through typed arrays. The heap-delta gates and static scans enforce it.
- **Styling:** `src/ui-style.js` uses nc-ui custom properties only: no colours, no px (the tests lint it). Accent
  colours come only from the instrument title colours (ASTRID #EB512E, PETRA #5AC4F7, OLIVE #9CA536, LUCY #9B30FF,
  NYX #FEAA02), through nc-ui tokens. Anything else: stop and ask.
- **Copy:** short plain sentences.
- **Vendoring:** apps copy this repo's `src/`, `dist/` and `package.json` into `vendor/nc-fx/` with a
  `VENDORED_FROM` line (repo, commit). Don't edit a vendored copy; change nc-fx and re-vendor.
- Commits and PRs need no attribution lines.
- Keep `README.md` and `CHANGELOG.md` (Unreleased) current with any API or sound change.

## Adding an insert plugin

You don't fork nc-fx for a new effect: write a plugin. [docs/plugins.md](docs/plugins.md) is the guide (manifest,
DSP contract, checker, loading it in the Studio). Start from
[netcomposer-art/nc-plugin-template](https://github.com/netcomposer-art/nc-plugin-template). Run
`nc-fx-check` until every line says PASS.

Changing the plugin system itself: `src/plugin.js` (main thread: manifest, catalog entry, loader, registry),
`src/plugin-host.js` (worklet: registry and the guard unit), `src/chain.js` (`renderPlug`), `schema/`,
`scripts/check-plugin.mjs`. Tests: `test/plugin*.test.mjs`, `test/checker/` (run after the main suite).

## Where to ask

Open an issue on [netcomposer-art/nc-fx](https://github.com/netcomposer-art/nc-fx/issues). Peter Semmelhack decides
sound, design and product questions.
