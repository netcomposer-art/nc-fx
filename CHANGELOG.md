# Changelog

## 0.1.0 (unreleased)

- First cut, extracted from ASTRID (NetComposer-Synth 024f200): drive, tempo-synced delay and plate reverb,
  followed by a lookahead or soft limiter.
- `createFxCore` (Web Audio nodes), `createFx` (the core plus a lazy panel), `createFxDsp` (an engine to embed in
  your own worklet), and the nc-clock tempo adapters.
- State `{v: 1, chain}`, with migration from ASTRID's saved hacks arrays.
