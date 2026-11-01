// Throws while playing once the rate is past 10 Hz.
registerNcFxPlugin({ id: 'test.throws', version: '1.0.0', params: ['rate', 'depth', 'shape'], create: function () {
  var s = new Float64Array(1); s[0] = 5;
  return { set: function (k, v) { if (k === 'rate') s[0] = v; },
    process: function (a, b, c, d, n) { if (s[0] > 10) throw new Error('too fast'); for (var i = 0; i < n; i++) { c[i] = a[i] * 0.5; d[i] = b[i] * 0.5; } } };
} });
