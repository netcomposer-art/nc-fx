// Its params are in another order than plugin.json's.
registerNcFxPlugin({ id: 'test.mismatch', version: '1.0.0', params: ['depth', 'rate', 'shape'], create: function () {
  return { process: function (a, b, c, d, n) { for (var i = 0; i < n; i++) { c[i] = a[i]; d[i] = b[i]; } } };
} });
