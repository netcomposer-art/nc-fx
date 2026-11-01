// Divides by (1 - depth): at depth 100 % that is a division by zero.
registerNcFxPlugin({ id: 'test.nan', version: '1.0.0', params: ['rate', 'depth', 'shape'], create: function () {
  var s = new Float64Array(1); s[0] = 0.5;
  return { set: function (k, v) { if (k === 'depth') s[0] = v / 100; },
    process: function (a, b, c, d, n) { var g = 0.5 / (1 - s[0]); if (s[0] === 1) g = 0 / 0; for (var i = 0; i < n; i++) { c[i] = a[i] * g * 0.5; d[i] = b[i] * g * 0.5; } } };
} });
