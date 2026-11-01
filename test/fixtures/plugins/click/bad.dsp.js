// Jumps straight to a new gain when depth moves: a click.
registerNcFxPlugin({ id: 'test.click', version: '1.0.0', params: ['rate', 'depth', 'shape'], create: function () {
  var s = new Float64Array(1); s[0] = 0.5;
  return { set: function (k, v) { if (k === 'depth') s[0] = v / 100; },
    process: function (a, b, c, d, n) { var g = 1 - s[0]; for (var i = 0; i < n; i++) { c[i] = a[i] * g; d[i] = b[i] * g; } } };
} });
