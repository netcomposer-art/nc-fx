# nc-fx

nc-fx was created by [Peter Semmelhack](https://psem.me/).

**NetComposer's shared effects chain for instruments: drive → tempo-synced delay → plate reverb → limiter.**
These are ASTRID's Hacks, moved into a package so that Rhythm, Bass and ASTRID all use the same code.

- **Framework-free.** Plain ES modules, types included, and no runtime dependencies. nc-clock and nc-ui are
  optional and never imported.
- **Sounds the same as ASTRID.** The DSP is a port of ASTRID's `hacks-vendor/dsp.js` and renders identical samples
  for the same settings. A test checks this against ASTRID's own file.
- **Real-time safe.** Nothing allocates on the audio thread: no allocation in `process()` and none for a parameter,
  tempo or bypass change. A test enforces this with a GC observer. All timing runs on the audio clock and is
  sample-accurate.
- **Small API.** The state is JSON-serialisable.
- **Optional panel.** The UI is ultra-minimal, built on nc-ui tokens, and lazy-loaded.

MIT licensed. The package name is `@netcomposer/nc-fx`. It isn't published to npm; install it from git.

## Install

Pin a commit:

```jsonc
// package.json
"dependencies": {
  "@netcomposer/nc-fx": "github:netcomposer-art/nc-fx#<commit-sha>"
}
```

The generated files (`dist/`) are committed, so you don't need a build step.

## Example: Rhythm or Bass

```js
import { createFx } from '@netcomposer/nc-fx';
import workletUrl from '@netcomposer/nc-fx/worklet?url';      // Vite: served as a file (see Worklet below)

const fx = createFx(ctx, { moduleUrl: workletUrl, bpm: 120, limiter: 'soft', state: saved?.fx });
voiceBus.connect(fx.input);
fx.output.connect(ctx.destination);
fx.setParam('delay', 'bypass', false);                         // dials use UI units, as on the panel
fx.setParam('reverb', 'mix', 25, ctx.currentTime + 0.05);      // optional AudioContext time
clock.onChange((c) => c.kind === 'tempo' && fx.setTempo(c.bpm, clock.transport.timeAt(c.atBeat)));
settingsButton.onclick = () => fx.mount(panelEl);               // loads the panel on first use
save({ fx: fx.getState() });                                    // JSON
```

You can use `followClock(fx, clock)` from `@netcomposer/nc-fx/tempo` instead of the `onChange` line.

## Effects

Effects run in a fixed order. Each one has On/Off (bypass) and a mix:

| Effect | Dials (UI units) | From ASTRID |
|---|---|---|
| **Drive** (`drive`) | Drive 0–24 dB (0 = clean), Output −12…+12 dB, Mix 0–100 % | `ncDrive*`: tanh with first-order ADAA, level-compensated |
| **Delay** (`delay`) | Timing 1/16, 1/8, 1/8 dotted, 1/4, 1/4 dotted, 1/2 (tempo-synced, max 4.9 s); Feedback 0–90 %; Wet/dry (`mix`) 0–100 % | `ncDelay*`: a stereo tap with linear interpolation and an 80 ms glide on time changes |
| **Reverb** (`plate`, alias `reverb`) | Pre-delay 0–200 ms, Size 0–100 (0.5×–1.5×), Decay, Damping, Mix 0–100 % | `ncPlate*`: Dattorro plate (JAES 1997) |
| Limiter (fixed, last) | `limiter: 'lookahead'` (default: −1 dB ceiling, 1.5 ms latency) · `'soft'` (zero-latency tanh clip) · `'off'` | `ncLimiter*` and the 0.8 pre-gain from `ncRender` |

**Coming next** (a later PR, from the rest of ASTRID's chain): low-, high- and band-pass filters, a 3-band EQ,
compressor, width, flanger, chorus and phaser. Also planned: user-reorderable slots, an accent modulation bus,
a delay send, drive tone, and a wet low-cut.

## API

### `createFxCore(ctx, opts?)`: audio only

```ts
createFxCore(ctx: BaseAudioContext, opts?: {
  state?: unknown;            // nc-fx state or ASTRID's saved hacks array; default: all bypassed
  bpm?: number;               // 120
  moduleUrl?: string | URL;   // where dist/worklet.js is served; omitted: a lazy Blob URL
  limiter?: 'lookahead' | 'soft' | 'off';
  bypassMode?: 'hold' | 'run';// hold (default): a bypassed effect costs no CPU and drops its tail
                              // run: it keeps running (ASTRID's behaviour)
  preGain?: number;           // 0.8 (ASTRID's master)
  crossfade?: number;         // 0.012 s, from the dry wire to the chain once the worklet is up
}): FxCore
```

| Member | |
|---|---|
| `input`, `output` | GainNodes to connect to. The chain is a dry wire until the worklet is up, then crossfades in on the audio clock. |
| `ready`, `status` | `ready` resolves when the chain is in the signal path (`'ready'`) or has given up (`'unavailable'`: no AudioWorklet, so it stays dry). It never rejects. |
| `setParam(effect, key, value, at?)` | Sets a dial in UI units, or `key: 'bypass'` with a boolean. `at` is an AudioContext time. It returns the stored value (clamped or snapped), or `undefined` for an unknown effect or dial. |
| `getParam(effect, key)` | |
| `getState()` / `setState(state, {at?})` | `{v: 1, chain: [{id, type, bypass, dials}]}` in the fixed order. Old or partial states and ASTRID arrays are migrated. |
| `setTempo(bpm, at?)` / `getTempo()` | The delay follows the tempo, gliding over 80 ms like tape. |
| `clear(at?)` | Panic: drops all tails. |
| `onChange(cb)` | `cb({effect, key, value})` runs after every change. It returns an unsubscribe function. |
| `latencySamples` | 72 at 48 kHz with the lookahead limiter, otherwise 0. |
| `dispose()` | |

### `createFx(ctx, opts?)`: the core plus a panel

`createFx` returns the same object with `mount(el, {injectCss?, effects?}) → Promise<{update, destroy, root}>`. The
panel module (`./ui.js`) is only imported on the first `mount`. You can also import `mountFxPanel` from
`@netcomposer/nc-fx/ui`.

### Inside your own AudioWorklet: `@netcomposer/nc-fx/dsp`

If an app already has its own processor (Rhythm's master chain), it can run the engine inside that processor
instead of adding a node:

```js
import { createFxDsp } from '@netcomposer/nc-fx/dsp';        // bundle into your worklet
import { compile } from '@netcomposer/nc-fx/params';        // main thread: state -> Float64Array program
const fx = createFxDsp(sampleRate, { limiter: 'soft' });    // allocates everything here
fx.load(program, 0, true); fx.setTempo(bpm, frame);         // frame = absolute sample frame
fx.process(inL, inR, outL, outR, 128, currentFrame);        // allocation-free
```

### Also exported

- `migrate(raw) → {state, dropped}`, `sanitize`, `defaultState`, `EFFECTS` (dial metadata with formatters),
  `EFFECT_ORDER`, `loadFxWorklet(ctx, url?)` and `PROCESSOR_NAME` (`'nc-fx@1'`).
- From `@netcomposer/nc-fx/tempo`, all duck-typed so nc-clock isn't a dependency: `followClock`,
  `applyTempoMap(fx, map, {fromBeat, toBeat, toAudioTime})` and `bpmOf`.

## Worklet: loading the processor in a Vite app

The processor is a single self-contained file, `dist/worklet.js`, with no imports. There are two ways to load it:

1. **Served file (recommended).** `import workletUrl from '@netcomposer/nc-fx/worklet?url'` makes Vite emit the
   file as a hashed asset. Pass the URL as `moduleUrl`. This is CSP-friendly and cached.
2. **No configuration.** Leave out `moduleUrl`. nc-fx then lazy-imports `dist/worklet-source.js` (the same code as a
   string), turns it into a Blob URL and loads that. Your bundler splits it into its own chunk. A Content Security
   Policy has to allow `blob:` in `script-src` / `worker-src` for this to work.

The processor is registered once per context, as `nc-fx@1`, so several instances share it.

## Panel looks and motion

- **Colour.** Colour comes only from nc-ui tokens: `--nc-ui-accent` (On, slider fill), `--nc-ui-text`,
  `--nc-ui-text-sub`, `--nc-ui-module-bg-stack-2` and `--nc-ui-focus-ring`. The only fallback is `currentColor`, and
  there are no hardcoded colours. Load nc-ui's tokens and the panel follows the theme.
- **Motion.** Sliders that the host moves (automation, modulation, a loaded state) are marked `data-modulated` and
  never animate. One-off feedback uses nc-ui's motion roles (150 ms) and turns off under
  `prefers-reduced-motion`. The tests lint both rules.

## Development

```sh
npm ci
npm run build          # regenerate dist/ after editing src/dsp.js, src/processor.js or src/ui-style.js
npm test               # node tests (params, state round-trip, DSP, ASTRID parity, allocation, host, style)
npm run test:browser   # headless Chrome: a real AudioWorklet in an OfflineAudioContext, plus the panel
npm run typecheck
npm run size
```
