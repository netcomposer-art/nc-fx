// Keeps a changing number in a plain variable, and makes an array every block: both allocate on the audio thread.
registerNcFxPlugin({ id: 'test.alloc', version: '1.0.0', params: ['rate', 'depth', 'shape'], create: function (sr) {
  var phase = 0, rate = 5;
  return { set: function (k, v) { if (k === 'rate') rate = v; },
    process: function (a, b, c, d, n) { var tmp = []; for (var i = 0; i < n; i++) { var g = 0.75 + 0.25 * Math.sin(phase); phase += rate / sr; tmp.push(g); c[i] = a[i] * g; d[i] = b[i] * g; } } };
} });
