// A test plugin (test/checker/plugin-check.test.mjs; nc-studio has the same one): it passes its input for 1000
// blocks (about 2.7 s at 48 kHz), then runs a regular expression that backtracks for longer than anyone waits. No
// loop of its own, so the loop guard can't see it: only nc-fx-check's per-check time limit stops it.
registerNcFxPlugin({
  id: "test.stuck-regex",
  version: "1.0.0",
  params: ["amount"],
  create() {
    const s = new Float64Array(1);
    const re = new RegExp("^(a+)+$");
    const text = `${"a".repeat(40)}!`;
    return {
      set() {},
      process(inL, inR, outL, outR, frames) {
        s[0]++;
        if (s[0] > 1000) re.test(text);
        for (let i = 0; i < frames; i++) {
          outL[i] = inL[i];
          outR[i] = inR[i];
        }
      },
    };
  },
});
