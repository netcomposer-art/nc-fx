// Gets stuck in an infinite loop while playing once the rate is past 10 Hz (nothing in the loop changes the rate).
registerNcFxPlugin({ id: 'test.stuck', version: '1.0.0', params: ['rate', 'depth', 'shape'], create: function () {
  var s = new Float64Array(2); s[0] = 5;
  return { set: function (k, v) { if (k === 'rate') s[0] = v; },
    process: function (a, b, c, d, n) {
      while (s[0] > 10) { s[1] += 1; }
      for (var i = 0; i < n; i++) { c[i] = a[i] * 0.5; d[i] = b[i] * 0.5; }
    } };
} });
