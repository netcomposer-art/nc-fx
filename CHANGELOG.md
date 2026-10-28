# Changelog

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
- The drive's one-sample dip on enable stays as in ASTRID (Peter's call).

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
