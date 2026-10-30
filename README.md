# nc-fx

nc-fx was created by [Peter Semmelhack](https://psem.me/).

**NetComposer's one effects module: ASTRID's whole Hacks catalog, for every instrument and the Studio's Mix.**
Drive, tempo-synced delay, plate reverb, EQ, compressor, width, flanger, chorus, phaser and (hidden, for old presets)
low-, high- and band-pass filters, moved out of ASTRID into a package so that ASTRID, Bass, Rhythm and the Studio all
use the same code. Two ways to chain them, both ending in the pre-gain and a limiter fixed last:

- **The fixed chain** (the default): drive → delay → reverb, each on or off. Unchanged since 0.1.0.
- **ASTRID's chain model** (`slots`): up to N effects (3 by default, as ASTRID) of any type, in any order the player
  picks, added, removed and reordered without a click. See [Chain model](#chain-model-slots).

- **Framework-free.** Plain ES modules, types included, and no runtime dependencies. nc-clock and nc-ui are
  optional and never imported.
- **Sounds the same as ASTRID.** Every effect is a port of ASTRID's code (the site's `hacks-vendor/dsp.js` and
  ASTRID's own `hacks-astrid/mod.js`) and renders identical samples for the same settings, with ASTRID's master
  options (`limiter: 'lookahead', preGain: 0.8`), including dial and tempo changes while playing and adding,
  removing and reordering effects while playing. The tests check this against ASTRID's own shipped worklet. The few
  deliberate differences are listed in [Differs from ASTRID](#differs-from-astrid).
- **Loads ASTRID's saves.** ASTRID's presets, snapshots, autosaves and files (its saved hacks) load exactly as
  ASTRID loads them, and export back unchanged ([State](#state-v1-and-v2-and-astrids-saves)).
- **One catalog.** Every effect's dials (labels, ranges, defaults, options, laws, readouts) are plain data, checked
  against ASTRID's `hacks.ts` ([Catalog](#catalog)). The panel and any host UI are generated from it.
- **Real-time safe.** Nothing allocates on the audio thread: no allocation in `process()` and none for a parameter,
  tempo, bypass or clear event. A heap-delta gate (fixed young generation, one process per scenario) holds this at
  0 B, and a 60 s silence test checks that denormals can't creep in. All timing runs on the audio clock and is
  sample-accurate.
- **Transparent by default.** With every effect bypassed and default options, the output is the input, bit for bit.
  The limiter and pre-gain are opt-in (see [Defaults and each app's choice](#defaults-and-each-apps-choice)).
- **Small API.** The state is JSON-serialisable. The API is approved (Zeta's review, 2026-10-27).
- **Optional panel.** Each effect is the nc-ui kit's FX card, so it looks the same in every app; with `slots` it is
  ASTRID's Hacks panel ("Add a hack", move up / down, remove). Lazy-loaded; nc-ui is never imported.

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
| `modInput` | `false` | `true` adds `fx.modInput`: a mono input for a control signal (CV, e.g. Bass's accent), channel 0 of whatever you connect (it is `'discrete'`, so a stereo source keeps only its channel 0; see [Mod input wiring](#mod-input-wiring)). The drive's Accent → drive / tone and the delay's Accent → send dials set how much it moves; at 0 (the default) the sound is the same, and so is a connected-but-silent (or never-connected) input. |

**CPU per effect** (`node test/bench/effects-cpu.mjs`: one effect on in the slot engine, 128-frame stereo blocks at
48 kHz, Node 22 on the CI-class machine this was written on, medians; the empty chain is 2.9 µs):

| Effect | µs / block | Effect | µs / block | Effect | µs / block |
|---|---|---|---|---|---|
| Reverb | 70.2 | Chorus | 29.7 | Low-pass | 14.5 |
| Phaser | 40.6 | Compressor | 14.2 | Flanger | 13.5 |
| Drive (12 dB) | 34.3 | Delay | 10.7 | Band-pass | 9.6 |
| EQ | 8.5 | Width | 5.8 | High-pass | 5.5 |

A block is 2667 µs at 48 kHz, so three of the heaviest (reverb, phaser, drive) use about 5 % of the audio thread.

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

Every effect has On/Off (bypass). In the fixed chain the order is drive → delay → reverb; with `slots` any order.

| Effect (`type`) | Dials (UI units) | From ASTRID |
|---|---|---|
| **Drive** (`drive`) | Drive 0–24 dB (0 = clean; 0.1 dB steps in Acid), Output −12…+12 dB, Mix 0–100 %, Curve Smooth / Acid, Tone 0–100 (100 = off), Accent → drive and Accent → tone −100…+100 % | Smooth is `ncDrive*`: tanh with first-order ADAA, level-compensated. Acid is ASTRID-Bass's drive, bit-exact (below) |
| **Delay** (`delay`) | Timing 1/32, 1/16, 1/8, 1/8 dotted, 1/4, 1/4 dotted, 1/2 (tempo-synced, max 4.9 s); Feedback 0–90 %; Wet/dry (`mix`) 0–100 %; Tone 0–100 (100 = off); Low cut 0–1000 Hz (0 = off); Mode Insert / Send; Send 0–100 %; Accent → send −100…+100 %; Free time 0–2 beats (0 = off) | `ncDelay*`: a stereo tap with linear interpolation and an 80 ms glide on time changes. Send mode is ASTRID-Bass's delay, bit-exact (below) |
| **Reverb** (`plate`, alias `reverb`) | Pre-delay 0–200 ms, Size 0–100 (0.5×–1.5×), Decay, Damping, Mix 0–100 % | `ncPlate*`: Dattorro plate (JAES 1997) |
| **EQ** (`eq`) | Low, Mid, High −18…+18 dB; Mid at 0–100 (200 Hz–5 kHz); Mid Q 0–100 (0.3–6) | `ncEq*`: RBJ low shelf 150 Hz, bell, high shelf 6 kHz; flat is a wire |
| **Compressor** (`compressor`) | Threshold −60…0 dB, Ratio 0–100 (1:1–20:1), Attack 1–100 ms, Release 10–1000 ms, Makeup 0–24 dB | `ncComp*`: feed-forward, stereo-linked, 6 dB soft knee |
| **Width** (`width`) | Width 0–200 %, Balance L100…R100 | `ncWidth*`: mid/side |
| **Flanger** (`flanger`) | Rate 0–100 (0.05–10 Hz), Depth, Feedback −90…+90 %, Mix | ASTRID's `hacks-astrid/mod.js` |
| **Chorus** (`chorus`) | Rate, Depth, Spread, Mix | ASTRID's `hacks-astrid/mod.js`: three voices |
| **Phaser** (`phaser`) | Rate, Depth, Stages 4 / 6 / 8, Feedback 0–90 %, Mix | ASTRID's `hacks-astrid/mod.js` |
| Low-pass, High-pass, Band-pass filter (`lowpass`, `highpass`, `bandpass`) | Cutoff (and Resonance) / Centre, Q, Mix | `ncLowpass*`, `ncPass*`. Hidden as in ASTRID: not offered in "Add", but old presets load, play, show and can be removed |
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
- **The new effects follow the same rules.** EQ, compressor, width, flanger, chorus, phaser and the filters use the
  smooth bypass crossfade and the denormal snap above (their rate, depth, feedback, filter-open and on/off
  smoothers, which ASTRID never snaps), and `bypassMode: 'hold'` (switching one back on after a full sleep starts it
  from cleared state). At rest and through every dial change they are bit-identical to ASTRID.
- **Slot chain edges** (`slots`). An effect whose type changes under the same id comes in as a new effect through
  the 4 ms chain fade; ASTRID swaps it in place at once (a click). Up to 8 slots (ASTRID 3, the site 10). The site's
  piece-position "filter arrows" (`ncApplyGlide`) are not ported: ASTRID never sends them. An empty chain still runs
  the pre-gain and limiter; ASTRID routes around its worklet when it has no hacks (an app choice, see below).
- **Matched, but worth knowing (ASTRID's own behaviour, kept for parity):** a second reorder during the 4 ms fade-in
  of the first restarts the fade-out from full level (a step of up to the fade's depth); an instant clear during a
  reorder drops the reorder, so the old order keeps playing (ASTRID's UI then shows the new one).
- **Kept as in ASTRID (Peter's call):** the drive's one-sample dip when `drive_db` moves off 0 while the drive is
  on. At 0 dB the drive is a clean wire and its antialiasing state is held at zero, so the first driven sample is
  averaged against that zero (DC 0.5 in gives one sample of 0.25). Switching the drive on is not affected: the
  bypass crossfade starts from fully dry.

### Drive curves, tone and accent

- **Curve.** `curve` 0 (Smooth, the default) is ASTRID's drive. `curve` 1 (Acid) is ASTRID-Bass's (3608858
  `apps/bass/src/modules/fx/fx-dsp.ts`): `tanh(x·k) / tanh(k) · 0.9` with k = 10^(Drive/20), normalised to full scale
  and not level-compensated, so it is louder than Smooth; no antialiasing. In Acid, Drive takes 0.1 dB steps (Bass's
  0–1 amount is (k − 1)/9, and the 0.1 dB grid round-trips it within 0.0065); Smooth keeps whole dB, and switching
  back to Smooth rounds Drive to whole dB.
- **Tone** (both curves) is Bass's one-pole low-pass after the shaper, 500 Hz·2^(5·tone/99): 0 is 500 Hz, 99 is
  16 kHz, 100 is off (no filter, the default). Smooth at 0 dB with no accent depth is the clean path and ignores tone.
- **Accent → drive / tone** are the depths of mod routes 0 and 1 from `modInput` (or `process()`'s 7th argument).
  Drive: Acid adds depth × CV to Bass's 0–1 amount per sample; Smooth adds depth × CV × 24 dB per sample (clamped to
  0.01–24 dB). Tone: depth × CV is added to tone/99 at block rate, on absolute frames that are multiples of 128 (as
  Bass reads `mod[0]` once per 128-frame block), so the output doesn't depend on the host's block size. Tone off with
  a tone depth set filters from 16 kHz down.
- **Bass parity.** With the converter's dials (INTEGRATION notes) and Bass's chain input (its voice × 0.8, as
  float32), Acid's output equals Bass's drive output sample for sample (`test/bass-parity.test.mjs`: 240 settings
  of amount, tone, mix and both accent depths, max abs diff 0; any block size). For that, the Acid path rounds its
  output to float32 as Bass's buffers do (`Math.fround`, Acid only). Bass applies its 0.8 before the drive; nc-fx's
  `preGain` is after the effects.
- **Smooth choices (Zeta, 2026-10-28):** accent → drive is ±24 dB at full depth, and tone has no effect in Smooth at
  0 dB with no accent depth (the clean path).
- **Unchanged at the defaults.** Curve Smooth, tone off and both depths 0 run exactly the old code: the ASTRID parity
  tests are bit-identical.

Delay (indexes 18–23, all off / ASTRID at their defaults):

- **Tone and Low cut** filter the tap inside the feedback loop, so each repeat is darker / thinner (Bass's laws:
  low-pass 800 Hz·2^(4·tone/99), 99 = 12.8 kHz; high-pass at the cut in Hz). They update at block rate on the
  absolute 128-frame grid, as Bass smooths per block. Low cut off fades its state out instead of stepping.
- **Mode.** Insert (default) is ASTRID's equal-power wet/dry. Send is Bass's: dry + mix × wet, so mix 100 is Bass's
  full return. Switching crossfades over 20 ms.
- **Send** (default 100) is how much dry goes into the line; **Accent → send** adds depth × CV per sample (mod route
  2), clamped to 0–100 %.
- **Free time** (`beats_free`): 0 is off and the Timing select plays. Any other value (0.125–2 beats, kept exactly as
  given) overrides the select, through the same 80 ms glide, and without ASTRID's 0.1 ms rounding of the delay time.
  The panel shows it as a free value ("free 0.3 beats · 144 ms") and dims Timing ("free time"). Tempo changes glide
  as before.
- **Bass parity (delay).** In Send mode, with the converter's dials, the output equals Bass's delay output sample for
  sample (`test/bass-delay-parity.test.mjs`: tone × low cut, send × accent depth × feedback × division, free
  divisions including 0.75 at 120/125/150 bpm, any block size, and Acid → delay as a chain; max abs diff 0). For
  that, Send reads the line as Bass does (`rp = w − d`, `a + (b − a)·frac`), keeps it float32 and rounds its output
  to float32. Once the write position wraps, the read adds the line length before taking the fraction, so only equal line
  lengths guarantee exactness past 4 s (`maxDelaySeconds: 191991.5 / 48000` matches Bass's 4 s line at 48 kHz). The
  6 s probe is exact with that and also with the default 4.9 s line; the test allows < 1e-6 for the default.

## Chain model (`slots`)

```js
const fx = createFx(ctx, { slots: true, limiter: 'lookahead', preGain: 0.8, state: settings.hacks }); // ASTRID's
const id = fx.addEffect('chorus');          // 'chorus-1' (undefined when the chain is full)
fx.setParam(id, 'mix', 30);                 // or fx.setParam('chorus', ...): the first chorus
fx.moveEffect(id, 0);                       // first in the chain
fx.removeEffect('eq-1');
fx.getChain();                              // [{ id, type, name: 'Chorus', bypass }]
save({ hacks: fx.toAstrid().hacks });       // ASTRID's own shape, or fx.getState() (v2)
```

`slots: true` gives ASTRID's three; a number gives 1–8. Each effect has an id (`delay-1`, `drive-2`, named "Drive 2"
on screen, as in ASTRID). The engine is ASTRID's chain, step for step:

- **Add, remove, reorder** go out as ASTRID's `HackOutput.sync` sends them: an add (the new effect's dials snapped),
  then the order, then a param for each changed dial. A new order is ASTRID's `ncChainOrder` / `ncFade` / `ncKeep`: the
  chain's output fades down over 4 ms (raised cosine), the new order takes over, and fades back up. No click, and
  no change in sound at rest: `test/astrid-catalog-parity.test.mjs` and `test/slot-core.test.mjs` hold a sequence of
  adds, moves, removes, dial and preset changes bit-identical to ASTRID's chain fed the same edits.
- **`setState`** (any saved chain) is the same diff, so loading a preset while playing is click-free.
- **Timed.** Every call takes `at` (AudioContext time), and calls made before the worklet is ready queue and replay
  as in the fixed chain.
- **Memory.** Effects live in a pool of 2N + 2 boxes (the order playing, the next order and adds in flight). The
  first time a box holds a type it allocates that effect's memory (on the message, not in `process()`); after that,
  adding, removing and reordering reuse it. A delay is 1.9 MB at 48 kHz, a reverb 0.3 MB, the others a few KB.
- **Inside your own worklet:** `createFxChainDsp(sampleRate, { slots })` from `@netcomposer/nc-fx/chain`, with
  `add(uid, type, frame)`, `set(uid, k, value, frame, snap)` (k from the catalog), `order(uids, frame, immediate)`,
  `setTempo`, `clear`, `process`, as `createFxDsp`.

### State: v1 and v2, and ASTRID's saves

- **v1** `{ v: 1, chain: [drive, delay, plate] }`: the fixed chain, unchanged.
- **v2** `{ v: 2, chain: [{ id, type, bypass, dials }] }`: the slot chain, first to last.

`migrateSlots(raw, max)` (and `setState`, and `opts.state` with `slots`) takes v2, v1 (its three effects become
three slots, as they play), and ASTRID's saves:

- **ASTRID's saved hacks** (`HackSlot[]`, `settings.hacks` in presets, snapshots, autosaves and files), sanitised
  exactly as ASTRID's `sanitizeHacks` does (500 fuzzed saves agree): the first three known hacks, ids kept when valid
  and unique, bypass only when `true`, each dial through `dialValue`. An odd saved Timing plays ASTRID's note.
- **ASTRID's widgets** (`HackWidget[]`, params in DSP units) and the site's **schema-2 document**: each param back
  to its dial through the inverse of `hacks.ts`'s law (exact for every dial value). The site's first EQ voicing
  (saves from before 2026-10-21, no `low_hz`) is reported in `notes`.

It returns `{ state, dropped, notes }`. Export: `toAstridHacks(state)` gives ASTRID's `HackSlot[]` (round trip
lossless for every ASTRID setting) and `lossy`, what ASTRID can't hold (nc-fx's own dials away from their
defaults, a 1/32 delay, a fourth slot); `toAstridDocument(state, tempo)` gives the schema-2 document, equal to
`hacks.ts` `hackChainDocument`.

## Catalog

`CATALOG` (from `@netcomposer/nc-fx` or `/catalog`, and `describeCatalog()` for a copy) is every effect as plain
JSON, in ASTRID's order: `{ type, label, hidden?, note?, tempoSynced?, dials }`, each dial
`{ key, label, min, max, default, step, unit, k, options?, more?, dsp?, format, astridKey?, stepWhen?, ... }`.

- `format` is the readout as data (`{ fmt: 'hz', law, astrid: true }`, `{ fmt: 'tempoMs' }`, ...), rendered by
  `formatDial(dial, value, bpm)`; every readout at every dial value and several tempos equals ASTRID's `format()`.
- `dsp` is the law from the dial to the engine (`{ div: 100 }`, `{ law: { pow: [0.05, 200], div: 100, fixed: 3 } }`,
  ...), equal to `hacks.ts` `hackParams` at every dial value. `k` is the engine param.
- `more: true` marks nc-fx's own dials (drive Curve, Tone, accent depths; delay Tone, Low cut, Mode, Send, accent,
  Free time): the panel puts them under "More"; their defaults are ASTRID's sound.
- `CATALOG_MENU` is "Add a hack": Delay, Reverb, Flanger, Chorus, Phaser, EQ, Drive, Compressor, Width.
- `EFFECTS` (the fixed chain's three, with `format(value, bpm)` functions) is derived from it, unchanged.

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

An optional 7th argument passes the block's control signal, the same as the node's `modInput`:
`fx.process(inL, inR, outL, outR, 128, currentFrame, modChannel)`. It needs at least `frames` samples; null or a
shorter buffer is read as a silent CV (all zeros), so it sounds exactly like a connected but silent input. A NaN or
infinite CV sample counts as 0. The depths are the drive's `mod_drive` / `mod_tone` dials (indexes 16, 17) and the
delay's `mod_send` (22).

#### Mod input wiring

`fx.modInput` is mono and `'discrete'`: it takes channel 0 of what you connect and drops the rest. To use another
channel of a stereo (or multichannel) source, split it and connect that output:

```js
const split = ctx.createChannelSplitter(2);
cvSource.connect(split);
split.connect(fx.modInput, 1); // channel 1 of cvSource -> the mod signal
```

A never-connected `fx.modInput` feeds silence, which sounds the same as no mod at any depth.

`set`, `setTempo` and `clear(frame?, fadeMs?)` are allocation-free too and return `false` for a frame more than
600 s ahead. Pass `startFrame: currentFrame` in the options if the engine is created mid-stream. `load()` skips
values equal to the ones already scheduled (unless `snap`).

### Also exported

- With `slots`: `addEffect`, `removeEffect`, `moveEffect`, `getChain`, `toAstrid`, and `slots` (see
  [Chain model](#chain-model-slots)); `CATALOG`, `CATALOG_MENU`, `catalogEntry`, `catalogDial`, `formatDial`,
  `describeCatalog`; `migrateSlots`, `sanitizeSlots`, `newSlot`, `slotName`, `moveSlot`, `toAstridHacks`,
  `toAstridDocument`, `SLOTS_VERSION`. Every core has `limiter` ('off', 'soft' or 'lookahead').
- `migrate(raw) → {state, dropped}`, `sanitize`, `defaultState`, `EFFECTS` (dial metadata with formatters),
  `EFFECT_ORDER`, `loadFxWorklet(ctx, url?)` and `PROCESSOR_NAME` (`'nc-fx@1'`).
- `compile(state) → Float64Array` and `dialToDsp(type, key, value)`, for hosts that run the engine themselves.
- `describeParams()`: every control as plain JSON, `{effect, key, label, index, unit, min, max, step, default,
  curve, control: 'knob'|'select'|'toggle', tempoSynced, options?, stepWhen?}`, for host UIs and automation (`stepWhen`: drive_db is 0.1 dB while curve is 1). Readouts are kept
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

- **The kit's FX cards.** Each effect is the markup of nc-ui's `renderControl({ type: 'fx' })` (north-star): a
  `.nc-ui-fx` card with `data-nc-depth` (by position, as ASTRID shades its hack cards: stack-2 down), a header with
  the name and a `role="switch"` On / Off named by it (`aria-checked`; the card dims by `data-nc-dim` when off), the
  kit's slider, select and note fields (solid thumbs), and "More" (`details.nc-ui-more`) for nc-fx's own dials. The
  live nc-ui stylesheet (`/nc-ui/nc-ui.css`) styles it, so it looks the same in every app; nc-fx never imports nc-ui.
  Mount it inside a kit module (the cards bleed to the module's padding, as ASTRID's).
- **ASTRID's Hacks panel** with `slots`: "Add a hack" (ASTRID's menu and order; the hidden filters are not offered,
  but an old preset's filter shows and can be removed; "3 of 3" and disabled when full), ▲ ▼ and × on each card,
  and "Limiter −1 dB, fixed last" under the cards. Option `depth` (1–4) sets the first card's shade (default 2).
- **Colour and length.** `src/ui-style.js` only lays out what the kit has no class for (the Add row, the move and
  remove buttons, select rows as label + value over the select, the limiter line), with nc-ui custom properties
  only: no colours, no px (the tests lint it). Screenshots: 1440 and 390 px against the live sheet in the PR.
- **Motion.** Sliders that the host moves (automation, modulation, a loaded state) are marked `data-modulated` and
  never animate. One-off feedback uses nc-ui's motion roles (150 ms) and turns off under
  `prefers-reduced-motion`. The tests lint both rules.

## Development

```sh
npm ci
npm run build          # regenerate dist/ after editing src/dsp.js, src/processor.js or src/ui-style.js
npm test               # node tests (params, catalog, state, DSP, ASTRID and Bass parity, allocation, denormals, host, style)
npm run test:browser   # headless Chrome: a real AudioWorklet in an OfflineAudioContext, plus the panel
                       # (PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs for a Playwright that has its browsers)
node test/bench/effects-cpu.mjs   # µs per 128-frame block, per effect
npm run typecheck
npm run size
```
