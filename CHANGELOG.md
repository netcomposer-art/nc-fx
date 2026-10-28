# Changelog

## Unreleased

- Docs: "Differs from ASTRID" now lists that the instant `clear()` leaves the limiter alone (ASTRID's
  `ncChainClear` rebuilds it), and the drive dip is described correctly: it happens when `drive_db` moves off 0
  with the drive on, not when the drive is switched on (Zeta).

## 0.1.0 (unreleased)

API approved by Zeta's review, 2026-10-27. Changes from that review:

- **Transparent defaults.** `limiter` defaults to `'off'` (was `'lookahead'`) and `preGain` to `1` (was `0.8`), so
  both are opt-in. With everything bypassed and default options, the chain is bit-identical to its input, and
  `latencySamples` is 0. The README lists each app's choice (Rhythm `limiter: 'soft'`; ASTRID and Bass
  `limiter: 'lookahead', preGain: 0.8`).
- **`bypassMode: 'run'` is the default** (was `'hold'`): bypassed effects keep running, so tails ring out as in
  ASTRID. `'hold'` is opt-in.
- **Calls before ready are queued.** `setParam`, `setState`, `setTempo` and `clear` made before the worklet is
  ready are replayed in call order when it starts: future times exactly, past or untimed ones clamped to now.
  They are no longer folded into the starting state (or dropped).
- Naming is unchanged: `createFxCore(ctx)` is the node, `createFxDsp(sampleRate)` is the engine.
- Main-thread meters are planned with the next batch of effects.

Changes from Zeta's second review and Petra's performance review (2026-10-28):

- **Allocation-free events.** `set`, `setTempo`, bypass and `clear` no longer allocate on the audio thread (they
  did: about 77, 189 and 37 B per call). The API only stages into typed arrays; the queue work runs in code that
  `process()` keeps optimised. A heap-delta gate holds 0 B per window; the GC-count test stays.
- **Denormals.** Smoothers snap onto their target within 1e-30 once per block, so silence can't decay into
  subnormal doubles (µs/block used to climb 1.7× in `'run'` and 3.3× in `'hold'` after ~15 s of silence).
- **Clock time.** `followClock` takes `{mapper}` (nc-clock's `AudioClockMapper`) or `{toAudioTime}`, gives a late
  joiner the tempo playing now, and on a `'shared'` clock without a mapping applies changes at once with a warning.
  Times more than 600 s ahead are refused everywhere (one warning), and a full engine queue applies its earliest
  events early instead of dropping any. The README example converts with `toContextTime`.
- `clear({at, fadeMs})` fades the wet out and back in; the instant `clear()` no longer resets the limiter, so the
  lookahead keeps its dry signal (it zeroed 72 samples).
- `maxDelaySeconds` option; `describeParams()` and `FORMATS`; `compile` and `dialToDsp` from the main entry;
  `load()` skips unchanged values; the pre-ready queue is capped at 256 (then folds); `mount()` can't leak a
  panel when `dispose()` runs first; `NOTICE.md` is published.

Peter's answers and Zeta's re-review (2026-10-28):

- **`'soft'` limiter has a knee.** Exactly linear (bit-transparent) up to −6 dBFS, then a C1 curve toward −1 dBFS;
  it was a full-range tanh (−0.19 dB at −12 dBFS, −0.66 dB at −6, RMS). The lookahead limiter was checked: it is
  already unity below its ceiling, so it is unchanged.
- **Smooth bypass crossfade.** The fade lands on its endpoint with zero slope (smoothstep) instead of stepping at
  0.999/0.001. Differs from ASTRID only while a bypass change is fading (see the README's "Differs from ASTRID").
- **Full queue.** An event due before the head of a full queue (or now) is applied by itself instead of pushing the
  head out early, which could undo a later change (mix 0.8 at frame 10000, then 0.2 now, used to end at 0.2).
- The drive's one-sample dip when `drive_db` moves off 0 (drive on) stays as in ASTRID (Peter's call).

First cut:

- First cut, extracted from ASTRID (NetComposer-Synth 024f200): drive, tempo-synced delay and plate reverb,
  followed by a lookahead or soft limiter.
- `createFxCore` (Web Audio nodes), `createFx` (the core plus a lazy panel), `createFxDsp` (an engine to embed in
  your own worklet), and the nc-clock tempo adapters.
- State `{v: 1, chain}`, with migration from ASTRID's saved hacks arrays.

After the first merge (main 3242a05), toward what Bass still needs (design approved by Zeta, 2026-10-28):

- **Mod input (plumbing only).** `createFxCore(ctx, { modInput: true })` adds `fx.modInput`, a mono GainNode
  into the worklet's second input, for a control signal such as Bass's accent CV. Engines embedded in your own
  worklet take it as an optional 7th `process()` argument. Nothing is routed from it yet: the output is
  bit-identical with it absent, present and silent, or present and moving, and the default is unchanged (no
  `modInput`, one input). The depth dials come in the next PRs.
- **Acid drive, drive tone, accent depths.** Four new drive dials (engine indexes 14–17; describeParams now lists
  18): `curve` Smooth (ASTRID's, the default) or Acid (ASTRID-Bass's drive, bit-exact against Bass 3608858's
  `fx-dsp.ts`, with float32 rounding at its output for that, Acid only); `tone` 0–100, Bass's one-pole low-pass
  after the shaper, 100 = off (default); `mod_drive` and `mod_tone` −100…+100 %, the depths of mod routes 0 and 1
  (accent → drive per sample, accent → tone at block rate on an absolute 128-frame grid). In Acid, `drive_db` takes
  0.1 dB steps (`stepWhen` in describeParams) so Bass's amounts round-trip within 0.0065; Smooth keeps whole dB, and
  `setParam('drive', 'curve', 0)` re-rounds it (posted and notified). At the defaults the engine runs the old code:
  ASTRID parity is bit-identical and old states load unchanged.
  After Zeta's review of PR B: with depths set, no CV (or one shorter than the block) is read as a silent CV, so it
  sounds exactly like a connected but silent `modInput` (the depths were zeroed instead, which skipped the mod paths);
  a NaN or infinite CV sample counts as 0, like the audio input (one could stick in the tone low-pass and everything
  after it until `clear()`); `load()` of a shorter program fills the remaining indexes with their defaults.
- **Delay: tone, low cut, Send mode, send + accent, 1/32, Free time.** Six new delay dials (engine indexes 18–23;
  describeParams now lists 24): `tone` 0–100 (a one-pole low-pass at 800 Hz·2^(4·tone/99), 100 = off, default) and
  `low_cut` 0–1000 Hz (one-pole high-pass, 0 = off, default), both on the tap inside the feedback loop; `mode` Insert
  (ASTRID's equal-power wet/dry, default) or Send (dry + mix × wet, Bass's); `send` 0–100 % (default 100) and
  `mod_send` −100…+100 % (mod route 2, per sample); `beats_free` 0–2 beats (0 = off, default; otherwise 0.125–2,
  kept exactly, overriding the Timing select through the same 80 ms glide, without ASTRID's 0.1 ms rounding).
  Timing gains 1/32 (so a saved value under 3/16 now lands on 1/32). Send renders ASTRID-Bass 3608858's delay
  bit-exact (its read and interpolation order, float32 line and output). The panel shows Free time as a free value
  and dims Timing while it overrides. At the defaults the engine runs the old code: ASTRID parity is bit-identical.
- **Mod input notes (Zeta's PR A review).** A never-connected `fx.modInput` feeds silence, not `null`, which renders
  bit-identical to no mod at any depth (tested in Node and Chrome); `'discrete'` keeps channel 0 of a stereo source
  (the README shows the splitter wiring). `npm run size` labels KiB and prints exact bytes.
