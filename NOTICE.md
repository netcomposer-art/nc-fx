# Provenance

The DSP in `src/dsp.js` is ported from ASTRID (psemmelhack/NetComposer-Synth, commit 024f200),
`lib/synth-audio/src/hacks-vendor/dsp.js`. That file is a copy of netcomposer.art `create/hacks/dsp.js` @ 3fb61f5
(sha256 ae783eea…, see ASTRID's `hacks-vendor/SOURCE.md`). Both are by Peter Semmelhack and MIT licensed.
`test/fixtures/astrid-hacks-dsp.cjs` is an unmodified copy, used for the parity test.

The dials, ranges, laws and formats in `src/params.js` come from ASTRID's `lib/synth-audio/src/hacks.ts`. The plate
follows J. Dattorro, "Effect Design, Part 1", JAES 45(9), 1997.
