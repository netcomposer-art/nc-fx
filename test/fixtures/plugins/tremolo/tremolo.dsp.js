// Tremolo: the level goes up and down. A NetComposer insert plugin (nc-fx plugin contract 1).
// This file runs in the AudioWorklet: no imports, no DOM, no network. MIT License, Peter Semmelhack.
//
// The host (nc-fx) does On/Off, bypass, meters, saving and the card. This file only turns input into output.
registerNcFxPlugin({
  id: 'netcomposer.tremolo', // the same as plugin.json's id
  version: '1.0.0',          // the same as plugin.json's version
  params: ['rate', 'depth', 'shape'], // plugin.json's param ids, in the same order

  // Called once per insert, off the audio path: make every buffer here.
  create: function (sampleRate) {
    // State lives in a typed array, not in plain variables: a number stored in a variable that process() changes
    // makes the browser allocate on the audio thread (the checker's "alloc" test catches it).
    var RATE = 0, DEPTH = 1, SHAPE = 2, PHASE = 3, GAIN = 4, SMOOTH = 5;
    var s = new Float64Array(6);
    s[RATE] = 5;     // Hz
    s[DEPTH] = 0.5;  // 0..1 (the dial is 0-100 %)
    s[SHAPE] = 0;    // 0 sine, 1 triangle, 2 square
    s[PHASE] = 0;    // 0..1
    s[GAIN] = 1;     // the gain now, smoothed so the square wave doesn't click
    s[SMOOTH] = 1 - Math.exp(-1 / (0.002 * sampleRate)); // 2 ms
    var TWO_PI = 2 * Math.PI;

    return {
      // A dial moved (or a saved value loaded). Values are in the units plugin.json gives.
      set: function (key, value) {
        if (key === 'rate') s[RATE] = value;
        else if (key === 'depth') s[DEPTH] = value / 100;
        else if (key === 'shape') s[SHAPE] = value;
      },

      // 1 to 128 frames. Read inL/inR, write outL/outR. Allocate nothing here.
      process: function (inL, inR, outL, outR, frames) {
        var step = s[RATE] / sampleRate, depth = s[DEPTH], shape = s[SHAPE], k = s[SMOOTH];
        var phase = s[PHASE], gain = s[GAIN];
        for (var i = 0; i < frames; i++) {
          var lfo; // 0..1
          if (shape === 0) lfo = 0.5 - 0.5 * Math.cos(TWO_PI * phase);
          else if (shape === 1) lfo = phase < 0.5 ? 2 * phase : 2 - 2 * phase;
          else lfo = phase < 0.5 ? 1 : 0;
          var target = 1 - depth * lfo;
          gain += (target - gain) * k;
          // Land on the target once close: a value creeping toward 0 forever turns into slow "denormal" numbers.
          if (gain - target < 1e-9 && target - gain < 1e-9) gain = target;
          outL[i] = inL[i] * gain;
          outR[i] = inR[i] * gain;
          phase += step;
          if (phase >= 1) phase -= 1;
        }
        s[PHASE] = phase;
        s[GAIN] = gain;
      },

      // Start again from silence (the host's panic button, or a fresh insert).
      reset: function () {
        s[PHASE] = 0;
        s[GAIN] = 1;
      }
    };
  }
});
