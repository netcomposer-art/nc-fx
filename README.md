# nc-fx

nc-fx was created by [Peter Semmelhack](https://psem.me/).

**NetComposer's shared effects chain for instruments: drive → tempo-synced delay → plate reverb → limiter.**
These are ASTRID's Hacks, moved into a package so that Rhythm, Bass and ASTRID all use the same code.

- **Framework-free.** Plain ES modules, types included, and no runtime dependencies. nc-clock and nc-ui are
  optional and never imported.
- **Sounds the same as ASTRID.** The DSP is a port of ASTRID's `hacks-vendor/dsp.js` and renders identical samples
  for the same settings, with ASTRID's master options (`limiter: 'lookahead', preGain: 0.8`), including dial and
  tempo changes while playing. A test checks this against ASTRID's own file. The few deliberate differences are
  listed in [Differs from ASTRID](#differs-from-astrid).
- **Real-time safe.** Nothing allocates on the audio thread: no allocation in `process()` and none for a parameter,
  tempo, bypass or clear event. A heap-delta gate (fixed young generation, one process per scenario) holds this at
  0 B, and a 60 s silence test checks that denormals can't creep in. All timing runs on the audio clock and is
  sample-accurate.
- **Transparent by default.** With every effect bypassed and default options, the output is the input, bit for bit.
  The limiter and pre-gain are opt-in (see [Defaults and each app's choice](#defaults-and-each-apps-choice)).
- **Small API.** The state is JSON-serialisable. The API is approved (Zeta's review, 2026-10-27).
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
import { followClock } from '@netcomposer/nc-fx/tempo';
import workletUrl from '@netcomposer/nc-fx/worklet?url';      // Vite: served as a file (see Worklet below)
// clock: nc-clock's NcClock; mapper = new AudioClockMapper(ctx), started (nc-clock)

const fx = createFx(ctx, { moduleUrl: workletUrl, bpm: 120, limiter: 'soft', state: saved?.fx });
voiceBus.connect(fx.input);
fx.output.connect(ctx.destination);
fx.setParam('delay', 'bypass', false);                         // dials use UI units, as on the panel
fx.setParam('reverb', 'mix', 25, ctx.currentTime + 0.05);      // optional AudioContext time
followClock(fx, clock, { mapper });                             // nc-clock: tempo on the audio clock (below)
settingsButton.onclick = () => fx.mount(panelEl);               // loads the panel on first use
save({ fx: fx.getState() });                                    // JSON
```

`followClock` comes from `@netcomposer/nc-fx/tempo`; `mapper` is nc-clock's `AudioClockMapper` for `ctx`. nc-clock's
times on a `'shared'` timebase are epoch seconds, not AudioContext time, so convert them. By hand that is:

```js
clock.onChange((c) => c.kind === 'tempo' && fx.setTempo(c.bpm, mapper.toContextTime(clock.transport.timeAt(c.atBeat))));
```

A time more than 600 s ahead of `ctx.currentTime` is refused with one console warning (it is almost always a time
on the wrong clock), so an unconverted epoch time can't silently queue forever.

## Defaults and each app's choice

The defaults change nothing you didn't ask for:

| Option | Default | What it means |
|---|---|---|
| `limiter` | `'off'` | No limiter, no latency. Opt in with `'soft'` (zero latency: exactly linear up to a −6 dBFS knee, then a smooth curve toward −1 dBFS) or `'lookahead'` (−1 dB ceiling, 1.5 ms latency, exactly unity below it). |
| `preGain` | `1` | Unity gain before the limiter stage. |
| `bypassMode` | `'run'` | A bypassed effect keeps running, so delay and reverb tails ring out when you bypass it and are still there when you turn it back on, as in ASTRID. `'hold'` opts in to zero CPU while bypassed, at the cost of dropping the tail. |
| `maxDelaySeconds` | `4.9` | The longest delay (ASTRID's). The delay line is sized from it (about 0.4 MB per second at 48 kHz); up to 60. |

**CPU: use `'hold'` if you don't need tails across bypass.** With `'run'` a fully bypassed chain still costs nearly
everything: in Petra's bench, 78 of 89 µs per 128-frame block. `'run'` is the default only because it is ASTRID's
behaviour.

With all three at their defaults and every effect bypassed, the chain is exactly unity gain. The node, engine and
real-AudioWorklet tests check this bit-for-bit using the defaults.

Each app opts in to what it needs:

| App | Options | Why |
|---|---|---|
| **Rhythm** | `limiter: 'soft'` (likely) | Catches overs on the drum sum with zero latency, so the 1–3 ms tab sync is unaffected. Pre-gain stays 1. |
| **ASTRID** | `limiter: 'lookahead', preGain: 0.8` | Matches today's master (`ncLimiter*` and the 0.8 from `ncRender`). Bypass is already `'run'`, ASTRID's behaviour. |
| **Bass** | `limiter: 'lookahead', preGain: 0.8` | From Bass's design. That design also asked for `bypassMode: 'hold'`; add it to opt in. |

```js
// Rhythm, as a node:
const fx = createFx(ctx, { moduleUrl: workletUrl, limiter: 'soft' });
// Rhythm, embedded in its own worklet:
const core = createFxDsp(sampleRate, { limiter: 'soft' });
// ASTRID (sounds like today):
const fx = createFx(ctx, { moduleUrl: workletUrl, limiter: 'lookahead', preGain: 0.8 });
// Bass:
const fx = createFx(ctx, { moduleUrl: workletUrl, limiter: 'lookahead', preGain: 0.8, bypassMode: 'hold' });
```

**Meters.** Main-thread meters (peak and limiter gain reduction posted from the worklet) come with the next batch
of effects. Today the engine keeps per-block peaks and `takeGainReduction()` for code that embeds `createFxDsp`.

## Effects

Effects run in a fixed order. Each one has On/Off (bypass) and a mix:

| Effect | Dials (UI units) | From ASTRID |
|---|---|---|
| **Drive** (`drive`) | Drive 0–24 dB (0 = clean), Output −12…+12 dB, Mix 0–100 % | `ncDrive*`: tanh with first-order ADAA, level-compensated |
| **Delay** (`delay`) | Timing 1/16, 1/8, 1/8 dotted, 1/4, 1/4 dotted, 1/2 (tempo-synced, max 4.9 s); Feedback 0–90 %; Wet/dry (`mix`) 0–100 % | `ncDelay*`: a stereo tap with linear interpolation and an 80 ms glide on time changes |
| **Reverb** (`plate`, alias `reverb`) | Pre-delay 0–200 ms, Size 0–100 (0.5×–1.5×), Decay, Damping, Mix 0–100 % | `ncPlate*`: Dattorro plate (JAES 1997) |
| Limiter (fixed, last) | `limiter: 'off'` (default) · `'soft'` (zero latency, linear to −6 dBFS, then a soft knee toward −1 dBFS) · `'lookahead'` (−1 dB ceiling, 1.5 ms latency); `preGain` 1 (default; ASTRID 0.8) | `ncLimiter*` and the 0.8 pre-gain from `ncRender` |

### Limiter gain

Steady 997 Hz sine at 48 kHz, effects bypassed, `preGain` 1. The gain is RMS out over RMS in; "exact" means every
output sample equals the input (delayed by the lookahead).

| Input | `'soft'` before (tanh) | `'soft'` now (knee) | `'lookahead'` |
|---|---|---|---|
| −24 dBFS | −0.03 dB | 0 dB, exact | 0 dB, exact |
| −12 dBFS | −0.19 dB (peak −0.24) | 0 dB, exact | 0 dB, exact |
| −6 dBFS | −0.66 dB (peak −0.87) | 0 dB, exact | 0 dB, exact |
| −3 dBFS | −1.22 dB | −0.10 dB | 0 dB, exact |
| 0 dBFS | −2.18 dB (peak out −2.86 dBFS) | −0.89 dB (peak out −1.56 dBFS) | −1.00 dB (peak out −1.00 dBFS) |

`'soft'` above the knee (k = −6 dBFS, ceiling c = −1 dBFS): `k + (c − k)·tanh((|x| − k) / (c − k))`, which leaves the
knee with slope 1 (no corner) and never reaches the ceiling. It is stateless, with no antialiasing filter: the old
tanh's first-order antialiasing averaged neighbouring samples, which coloured quiet signals too. `'lookahead'`
already passes everything below its ceiling untouched (after a limited peak, once its 50 ms release has settled),
so it has no knee: one would colour the signal below the ceiling.

### Differs from ASTRID

Deliberate differences (Peter's calls on nc-fx #1, 2026-10-28, and the reviews). Everything else renders ASTRID's
samples exactly.

- **Bypass crossfade.** Turning an effect on or off still takes ASTRID's ~140 ms (a 20 ms one-pole), but the
  equal-power gains follow a smoothstep of it, so they land on fully wet or fully dry with zero slope. ASTRID jumps
  the last 0.16 % of the swing in one sample when the fade passes 0.999 or 0.001 (about −56 dB). At rest, bypassed or
  not, the output is bit-identical to ASTRID's; during a bypass change it is not, and neither are delay or reverb
  tails fed from that change.
- **`'soft'` limiter.** Not in ASTRID (ASTRID uses the lookahead). It is now the knee above, not a full-range tanh.
  The lookahead limiter is unchanged and bit-identical.
- **Instant `clear()` leaves the limiter alone.** ASTRID's `ncChainClear` also rebuilds the limiter
  (`chain.lim = ncLimiterCreate(...)`), which zeroes the lookahead's 1.5 ms (72 samples at 48 kHz) of dry signal and
  resets its gain. nc-fx clears the effect tails (and the drive's one-sample state) only, so the dry signal carries on.
  `clear({fadeMs})` is new.
- **Denormal snap.** Smoothers land on their target once within 1e-30, so silence can't decay into subnormal
  numbers. The output can differ only below 1e-30, far below any audible or Float32-normal level, and every parity
  test is still identical.
- **Options and defaults.** `bypassMode: 'hold'` and `maxDelaySeconds` beyond 4.9 s are opt-in extras. The defaults
  `limiter: 'off'` and `preGain: 1` are not ASTRID's master (`'lookahead'` and 0.8): pass those to match it.
- **Kept as in ASTRID (Peter's call):** the drive's one-sample dip when `drive_db` moves off 0 while the drive is
  on. At 0 dB the drive is a clean wire and its antialiasing state is held at zero, so the first driven sample is
  averaged against that zero (DC 0.5 in gives one sample of 0.25). Switching the drive on is not affected: the
  bypass crossfade starts from fully dry.

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
  limiter?: 'lookahead' | 'soft' | 'off'; // 'off' (default): opt in to 'soft' or 'lookahead'
  bypassMode?: 'hold' | 'run';// run (default): a bypassed effect keeps running, so tails ring out (ASTRID)
                              // hold: it costs no CPU and drops its tail
  preGain?: number;           // 1 (default); ASTRID's master is 0.8
  crossfade?: number;         // 0.012 s, from the dry wire to the chain once the worklet is up
}): FxCore
```

| Member | |
|---|---|
| `input`, `output` | GainNodes to connect to. The chain is a dry wire until the worklet is up, then crossfades in on the audio clock. |
| `ready`, `status` | `ready` resolves when the chain is in the signal path (`'ready'`) or has given up (`'unavailable'`: no AudioWorklet, so it stays dry). It never rejects. |
| `setParam(effect, key, value, at?)` | Sets a dial in UI units, or `key: 'bypass'` with a boolean. `at` is an AudioContext time (at most 600 s ahead). It returns the stored value (clamped or snapped), or `undefined` for an unknown effect or dial or a refused time. |
| `getParam(effect, key)` | |
| `getState()` / `setState(state, {at?})` | `{v: 1, chain: [{id, type, bypass, dials}]}` in the fixed order. Old or partial states and ASTRID arrays are migrated. |
| `setTempo(bpm, at?)` / `getTempo()` | The delay follows the tempo, gliding over 80 ms like tape. |
| `clear(at?)` / `clear({at?, fadeMs?})` | Panic: drops the delay and reverb tails. Instant by default, which also resets the drive's one-sample state. `fadeMs` (up to 1000) ramps the wet down first, zeroes the lines a chunk per block and ramps back in, with no click and no big fill on one block. Neither resets the limiter, so the dry signal through the lookahead carries on. |
| `onChange(cb)` | `cb({effect, key, value})` runs after every change. It returns an unsubscribe function. |
| `latencySamples` | 0 by default; 72 at 48 kHz with `limiter: 'lookahead'`. |
| `dispose()` | |

#### Calls made before the worklet is ready

The chain is usable at once, before `ready` resolves. `setParam`, `setState`, `setTempo` and `clear` made while
the worklet loads are queued in call order and handed to the processor when it starts, before it renders anything:

- a **future** `at` is applied exactly at that AudioContext time, sample-accurately;
- a **past** `at` (the context ran on while the module loaded), or no `at`, is clamped to now and applied at the
  first sample;
- order is preserved, including calls for the same time;
- nothing is folded into the starting state, which is `opts.state` and `opts.bpm` as given at construction.

`getParam` and `getState` reflect the calls at once. If AudioWorklet is unavailable, or you `dispose()` first, the
queue is dropped. The queue holds 256 calls; past that it folds into one load of the current state plus the tempo,
applied when the worklet starts (so timing is lost, but nothing grows without bound). The engine itself keeps up to
256 future events; if more arrive, the earliest are applied early rather than dropped.

### `createFx(ctx, opts?)`: the core plus a panel

`createFx` returns the same object with `mount(el, {injectCss?, effects?}) → Promise<{update, destroy, root}>`. The
panel module (`./ui.js`) is only imported on the first `mount`. If you `dispose()` while it loads, the panel comes
back already destroyed. You can also import `mountFxPanel` from
`@netcomposer/nc-fx/ui`.

### Inside your own AudioWorklet: `@netcomposer/nc-fx/dsp`

If an app already has its own processor (Rhythm's master chain), it can run the engine inside that processor
instead of adding a node:

```js
import { createFxDsp } from '@netcomposer/nc-fx/dsp';        // bundle into your worklet
import { compile } from '@netcomposer/nc-fx/params';        // main thread: state -> Float64Array program
const fx = createFxDsp(sampleRate, { limiter: 'soft' });    // allocates everything here; same defaults as the node
fx.load(program, 0, true); fx.setTempo(bpm, frame);         // frame = absolute sample frame
fx.process(inL, inR, outL, outR, 128, currentFrame);        // allocation-free
```

`set`, `setTempo` and `clear(frame?, fadeMs?)` are allocation-free too and return `false` for a frame more than
600 s ahead. Pass `startFrame: currentFrame` in the options if the engine is created mid-stream. `load()` skips
values equal to the ones already scheduled (unless `snap`).

### Also exported

- `migrate(raw) → {state, dropped}`, `sanitize`, `defaultState`, `EFFECTS` (dial metadata with formatters),
  `EFFECT_ORDER`, `loadFxWorklet(ctx, url?)` and `PROCESSOR_NAME` (`'nc-fx@1'`).
- `compile(state) → Float64Array` and `dialToDsp(type, key, value)`, for hosts that run the engine themselves.
- `describeParams()`: every control as plain JSON, `{effect, key, label, index, unit, min, max, step, default,
  curve, control: 'knob'|'select'|'toggle', tempoSynced, options?}`, for host UIs and automation. Readouts are kept
  apart, as functions, in `FORMATS['delay.delay_beats'](value, bpm)`.
- From `@netcomposer/nc-fx/tempo`, all duck-typed so nc-clock isn't a dependency:
  `followClock(fx, clock, {mapper? | toAudioTime?, now?})`, `applyTempoMap(fx, map, {fromBeat, toBeat, toAudioTime})`
  and `bpmOf`. `followClock` gives a late joiner the tempo playing now (`beatAt(now)` with a mapper or `now`,
  otherwise the transport's current tempo) and schedules later changes at their times. On a `'shared'` clock
  without a mapper or `toAudioTime`, it applies changes at once and warns once.

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
