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

First cut:

- First cut, extracted from ASTRID (NetComposer-Synth 024f200): drive, tempo-synced delay and plate reverb,
  followed by a lookahead or soft limiter.
- `createFxCore` (Web Audio nodes), `createFx` (the core plus a lazy panel), `createFxDsp` (an engine to embed in
  your own worklet), and the nc-clock tempo adapters.
- State `{v: 1, chain}`, with migration from ASTRID's saved hacks arrays.
