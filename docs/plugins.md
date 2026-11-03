# NetComposer insert plugins

An insert plugin is a new effect for the Studio's Mix (a channel's or the master's Inserts). It is two files in one
folder:

```
my-plugin/
  plugin.json      what it is: id, name, version, author, licence, its dials
  tremolo.dsp.js   what it does: one plain script that runs on the audio thread
```

The host draws everything else: the card, its On/Off, the level meter, fold, maximize, More, saving and Scenes.
You write no UI.

**Fastest start:** copy the template, [netcomposer-art/nc-plugin-template](https://github.com/netcomposer-art/nc-plugin-template)
("Use this template", or copy its `plugin/` folder). It holds a working tremolo and runs the checker in CI.

## 1. plugin.json

```json
{
  "$schema": "https://raw.githubusercontent.com/netcomposer-art/nc-fx/main/schema/plugin-manifest.schema.json",
  "ncPlugin": 1,
  "id": "yourname.tremolo",
  "name": "Tremolo",
  "version": "1.0.0",
  "author": "Your Name",
  "licence": "MIT",
  "description": "The level goes up and down. Rate, depth and shape.",
  "dsp": "tremolo.dsp.js",
  "params": [
    { "id": "rate", "label": "Rate", "type": "float", "minValue": 0.1, "maxValue": 20, "defaultValue": 5, "discreteStep": 0.1, "units": "Hz" },
    { "id": "depth", "label": "Depth", "type": "float", "minValue": 0, "maxValue": 100, "defaultValue": 50, "discreteStep": 1, "units": "%" },
    { "id": "shape", "label": "Shape", "type": "choice", "choices": ["Sine", "Triangle", "Square"], "defaultValue": 0 }
  ]
}
```

| Field | Rule |
|---|---|
| `ncPlugin` | `1` (the contract's version). |
| `id` | `yourname.effect`: lowercase letters and digits, dots or dashes between, up to 64. Sessions save it: never change it. |
| `name` | The card's title, up to 40 characters. |
| `version` | `x.y.z`. Bump it whenever the DSP changes. |
| `author`, `licence` | Who made it; an SPDX id (`MIT`, `GPL-3.0-only`, ...). |
| `description`, `website`, `keywords` | Optional. |
| `dsp` | The DSP file's name, in the same folder. No paths, no other host. |
| `params` | Up to 15 dials, in order. |

A param uses the field names of [Web Audio Modules 2.0](https://github.com/webaudiomodules/api)'s
`WamParameterConfiguration`:

| Field | Rule |
|---|---|
| `id` | Lowercase, starting with a letter: letters, digits, `_`. Not `bypass`. Your `set(key, value)` gets it. |
| `label` | The dial's name, up to 24 characters. |
| `type` | `float` (default), `int`, `boolean` (0 or 1) or `choice` (0 to `choices.length - 1`). |
| `minValue`, `maxValue` | Required for `float` and `int`. |
| `defaultValue` | Default: `minValue`. |
| `discreteStep` | The dial's step. A float without one gets about a hundredth of its range. |
| `units` | The readout: `Hz`, `ms`, `%`, `dB` ... (up to 8 characters). |
| `choices` | For `choice`: 2 to 16 names. |
| `more` | `true` puts the dial under the card's More. |
| `exponent` | WAM's skew. Kept for WAM hosts; the Studio's dials are linear. |

The full rules are [schema/plugin-manifest.schema.json](../schema/plugin-manifest.schema.json).

## 2. The DSP file

```js
registerNcFxPlugin({
  id: 'yourname.tremolo',            // plugin.json's id
  version: '1.0.0',                  // plugin.json's version
  params: ['rate', 'depth', 'shape'], // plugin.json's param ids, in the same order

  create: function (sampleRate) {    // once per insert: make every buffer here
    var s = new Float64Array(6);     // state: RATE, DEPTH, SHAPE, PHASE, GAIN, SMOOTH
    s[0] = 5; s[1] = 0.5; s[2] = 0; s[3] = 0; s[4] = 1;
    s[5] = 1 - Math.exp(-1 / (0.002 * sampleRate)); // a 2 ms smoother
    return {
      set: function (key, value) {   // a dial moved; value in plugin.json's units
        if (key === 'rate') s[0] = value;
        else if (key === 'depth') s[1] = value / 100;
        else if (key === 'shape') s[2] = value;
      },
      process: function (inL, inR, outL, outR, frames) { // 1 to 128 frames
        var phase = s[3], gain = s[4];
        for (var i = 0; i < frames; i++) {
          var lfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase); // (sine only, for short)
          var target = 1 - s[1] * lfo;
          gain += (target - gain) * s[5];
          if (gain - target < 1e-9 && target - gain < 1e-9) gain = target;
          outL[i] = inL[i] * gain;
          outR[i] = inR[i] * gain;
          phase += s[0] / sampleRate;
          if (phase >= 1) phase -= 1;
        }
        s[3] = phase; s[4] = gain;
      },
      reset: function () { s[3] = 0; s[4] = 1; } // drop tails and state
    };
  }
});
```

The rules (the checker tests each one):

1. **One plain script.** No `import` or `export`: it is loaded with `audioWorklet.addModule()`. Up to 256 KB.
2. **Audio thread only.** No `document`, `window`, `fetch`, storage or timers. It turns input into output.
3. **Match plugin.json.** The same `id`, `version` and param ids, in the same order.
4. **Allocate in `create()`, never in `process()` or `set()`.** No `[]`, `{}`, `new`, closures, `map`/`slice`/`push`,
   string building or `console` there. Keep changing numbers in a `Float64Array`, not in plain variables:
   a number stored in a variable that `process()` changes is allocated each time (V8 boxes it). Copy them into
   locals at the top of `process()` and back at the end, as above.
5. **`frames` is 1 to 128.** Loop to `frames`, never to `inL.length`. Buffers are `Float32Array`.
6. **Read `inL`/`inR`, write `outL`/`outR`.** Don't write the inputs. Mono input arrives as the same signal on both.
7. **No NaN, no infinity, no runaway.** Clamp feedback below 1; guard what you divide by.
8. **No denormals.** Snap values creeping toward 0 to 0 once below about 1e-30 (filters, envelopes, feedback,
   smoothers).
9. **No clicks.** Smooth a dial's change inside `process()` (a one-pole over 2 to 20 ms) instead of jumping to it.
10. **Fast.** The checker's budget is 200 µs per 128-frame block (the heaviest built-in, the reverb, is about
    70 µs).

Types for an editor: [src/plugin-worklet.d.ts](../src/plugin-worklet.d.ts).

### What the host does for you

- **On/Off** with a 20 ms equal-power crossfade. Bypassed, the output is the input, bit for bit. With
  `bypassMode: 'run'` (the Studio's) your `process()` keeps running while bypassed, so tails ring out.
- **Guard.** If `create()`, `set()`, `process()` or `reset()` throws, or `process()` writes NaN, infinity or a
  sample past ±64 (+36 dBFS), nc-fx stops calling the plugin, passes the slot's input through, and the card says so.
  The rest of the mix plays on. Adding it again gives it a fresh start.
- **Loop guard.** Every `while`, `do ... while` and `for` loop in your file gets a cheap check (nc-fx rewrites the
  loop's condition before the code runs; line numbers stay the same). A loop that is still going after 100 ms
  in one `process()`, `set()` or `reset()` call, or 1000 ms in `create()` or the file's top level, is stopped
  there: the card says "It got stuck in a loop, so it was stopped." and the slot passes its input (code 6). A
  block takes about 3 ms, so a fast plugin is nowhere near it. The guard can't see a stuck built-in call (a
  regular expression that backtracks forever, a huge `Array.fill`); hosts can catch that with `watchAudioStall`.
- **Ceiling.** Your output is held within ±4 (+12 dBFS, the checker's `level` limit). A plugin that passes the
  checker never reaches it; one that gets too loud is clipped there instead of blasting the mix.
- **Meters, saving, Scenes, missing plugins.** A session saves the plugin's id, URL, version and dials. If
  the plugin can't be loaded, its slot shows as missing: a wire, its dials kept for later.

## 3. Check it

```sh
npx -p github:netcomposer-art/nc-fx nc-fx-check ./my-plugin            # or a URL to plugin.json
npx -p github:netcomposer-art/nc-fx nc-fx-check ./my-plugin --json     # for agents
```

In the template, `npm run check`. In a clone of nc-fx, `node scripts/check-plugin.mjs <folder>`.

```
PASS manifest           Tremolo 1.0.0 (netcomposer.tremolo) by Peter Semmelhack, MIT, 3 param(s)
PASS dsp-file           tremolo.dsp.js, 2.7 KB, one plain script
PASS register           registers netcomposer.tremolo@1.0.0 with params [rate, depth, shape]
...
FAIL alloc              process() allocates: about 8810080 bytes per 2000 blocks (4405 per block)
                        fix: no new arrays or objects, closures, array methods (map, slice, push), string building or console in process(); make buffers in create()
RESULT FAIL: 1 of 17 checks failed. Fix them and run again.
```

Loop until every line is PASS (exit code 0). With `--json` the output is `{ ok, plugin, checks: [{ id, ok, level,
message, fix?, data? }] }`; `level` is `pass`, `fail`, `warn` or `skip`. Exit codes: 0 pass, 1 a check failed, 2 usage.

| Check | Fails when |
|---|---|
| `manifest` | plugin.json breaks a rule above (each problem is named). |
| `dsp-file` | the file is missing, over 256 KB, or has `import`/`export`. |
| `register` | `registerNcFxPlugin` isn't called exactly once, or id, version or params differ from plugin.json. |
| `create` | `create()` (44.1, 48, 96 kHz), `set()` at any min, max or default, or `reset()` throws. |
| `nan-inf` | any of 6 signals (silence, sine, noise, impulses, DC, full-scale square) at 15 settings (defaults, all min, all max, each param at min and max, 6 random) makes NaN or infinity. |
| `level` | a run goes past +12 dBFS. |
| `denormal-out` | the output holds subnormal numbers. |
| `input` | `process()` writes into `inL` or `inR`. |
| `runaway` | after loud noise stops, the tail grows instead of dying away. |
| `clicks` | a dial jumping min to max (or back) on a sine steps harder than the steady sound. |
| `block-size` | blocks of 37 frames make NaN (a warning if they only sound slightly different). |
| `cpu` | a 128-frame block costs more than the budget (`--budget-us`, default 200) at its worst setting. |
| `denormal-cpu` | CPU climbs more than 4x after 20 s of silence (denormals in the state). |
| `alloc` | `process()` allocates (a heap-delta gate in a child process), or `set()` allocates more than 32 bytes a call. |
| `engine` | nc-fx's real worklet engine stops the plugin. |
| `bypass` | bypassed, the output isn't the input bit for bit (that would be an nc-fx bug). |
| `browser` | in headless Chromium (when Playwright is installed, or `--browser`): nc-fx's own loader can't load it into a real AudioWorklet, it's silent, or bypassed isn't bit-exact. |

## 4. Try it in the Studio

1. Serve the folder on this machine with CORS. In the template: `npm run serve` (port 5990; it sends
   `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`). Any static server that sends
   those headers works.
2. Open https://netcomposer.art/studio/, press a channel's **Inserts**, and in **Add** pick
   **Load plugin from URL…**.
3. Paste `http://localhost:5990/plugin.json`. The Studio says "This runs code from localhost in your browser".
   Press **Load and run**. Chrome may ask to let the site reach your local network: allow it.

Plain http works only from `localhost`; anywhere else, use https. Edit, bump nothing, and reload the page to load
your change (one version of a plugin per page).

## 5. Get it listed

Listed plugins show in **Add › Plugins** for everyone, and their files are checked against a sha256 before their
code runs. To list one, open a pull request on
[netcomposer-art/netcomposer.art](https://github.com/netcomposer-art/netcomposer.art) that adds its folder under
`plugins/<name>/` and an entry to `plugins/registry.json`
([schema](../schema/plugin-registry.schema.json)), with the checker's output. It is reviewed by hand. Anyone can
still load any plugin from a URL; that shows a warning first.

## For hosts

```js
import { loadPlugin, loadPluginFiles, fetchRegistry, loadListedPlugin, createFxCore } from '@netcomposer/nc-fx';

const { registry, url } = await fetchRegistry('/plugins/registry.json');           // the listed ones
const { entry } = await loadListedPlugin(ctx, registry.plugins[0], url, { moduleUrl }); // sha256 checked
// or, after the user agreed to run its code:
const { entry: e2 } = await loadPlugin(ctx, 'https://example.com/fx/plugin.json', { moduleUrl });
// or from files on the user's computer (picked, or kept in the browser): no fetch, saved as 'local:<id>'
const { entry: e3 } = await loadPluginFiles(ctx, { manifest: jsonText, dsp: dspText, dspName: 'fx.dsp.js' }, { moduleUrl });

const fx = createFxCore(ctx, { slots: 8, moduleUrl });
fx.addEffect(entry.type);           // 'plugin:netcomposer.tremolo': a catalog entry like 'delay'
fx.getChain()[0].plugin;            // { id, version, url, name, status: 'ready' | 'missing' | 'failed', error? }
```

- A registered plugin is a catalog entry (`catalogEntry('plugin:<id>')`, `pluginEntries()`), in the same shape as
  the built-ins', so a host that renders the catalog shows its card with no plugin code. It is never in `CATALOG`
  or `CATALOG_MENU`.
- A slot state keeps `plugin: { id, version, url, name }`. `setState` with a plugin that isn't registered keeps the
  slot as saved and plays it as a wire (`status: 'missing'`); when the plugin registers (`registerPlugin` or
  `loadPlugin`), every chain plays it, click-free.
- **Load code only on a user's action.** A shared session can name any URL, so a host should auto-load only listed
  plugins (by registry match) and ask before anything else.
- **Local plugins.** `loadPluginFiles` takes the two files' text, checks plugin.json and the 256 KB limit, and runs
  the DSP from a Blob URL like `loadPlugin`. Its slots save `url: 'local:<id>'`, which slot states keep and nothing
  fetches: the host finds the files again (the Studio keeps a copy in IndexedDB).
- **One version per page.** Loading another version of a loaded id fails with `err.reload === true`; reload the
  page to switch. Loading the same id and version again with different code resolves with `stale: true`: the
  worklet keeps the first code until the page is reloaded, so tell the user.
- **Stuck plugins.** The loop guard stops a plugin stuck in a loop by itself (`status: 'failed'`, error
  `PLUGIN_ERRORS[6]`); the context keeps playing. For anything it can't see, `watchAudioStall(ctx, { onStall,
  onResume, stallMs: 1500 })` polls `ctx.currentTime` from the main thread and calls `onStall` once a running
  context's clock has not moved for `stallMs` (a late timer, as in a background tab, doesn't count). It never
  touches the context. A context stuck that way can't be closed or resumed (in Chrome, `close()` crashes the
  page and a reload of that tab can hang), but a new AudioContext or a new tab plays: what to do is the host's call.
- **CSP.** The DSP is run from a Blob URL of the bytes that were fetched (and checked), so `worker-src blob:` (or
  `script-src blob:`) must be allowed, and `connect-src` must allow the plugin's host. netcomposer.art sets no CSP.
- **Zero cost.** With no plugin in a chain, the worklet renders exactly what nc-fx rendered before plugins
  (`test/plugin-zero-cost.test.mjs` holds it to the previous build, sample for sample).

### How it runs, and why not one node per plugin

A plugin's DSP registers into the AudioWorklet scope that nc-fx's processor already runs in, and plays as one box of
nc-fx's slot chain, next to the built-in effects. One node per chain keeps the chain's click-free reorders, its
per-effect meters, the bypass crossfade and the guard in one place, and costs no extra node or thread hop per
plugin. A separate node per plugin (as WAM does) would not isolate a hang either: every AudioWorklet node on a
context shares one audio thread.

### Web Audio Modules 2.0

The manifest's params use WAM 2.0's field names, and `toWamDescriptor(manifest)` / `toWamParameterInfo(manifest)`
give WAM's `WamDescriptor` and `WamParameterInfo`. nc-fx does not host WAM modules: a WAM is a main-thread ES
module (with full page access) that brings its own AudioWorkletNode and usually its own GUI, which the Studio does
not run. Wrapping a NetComposer plugin as a WAM, or hosting WAMs in their own node, is possible later.
