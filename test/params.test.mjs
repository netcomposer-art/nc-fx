import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NPARAMS, EFFECTS, defaultState, sanitize, migrate, compile, clampDial, dialDef, dialToDsp, effectType, delaySeconds, PARAM_INDEX } from '../src/params.js';
import { FX_PARAM, FX_NPARAMS } from '../src/dsp.js';

test('three effects in the fixed order with ASTRID\'s dials and ranges', () => {
  assert.deepEqual(EFFECTS.map((e) => e.type), ['drive', 'delay', 'plate']);
  const want = {
    drive: [['drive_db', 0, 24, 0], ['output_db', -12, 12, 0], ['mix', 0, 100, 100],
      ['curve', 0, 1, 0], ['tone', 0, 100, 100], ['mod_drive', -100, 100, 0], ['mod_tone', -100, 100, 0]],
    delay: [['delay_beats', 0.125, 2, 0.75], ['feedback', 0, 90, 35], ['mix', 0, 100, 0],
      ['tone', 0, 100, 100], ['low_cut', 0, 1000, 0], ['mode', 0, 1, 0], ['send', 0, 100, 100], ['mod_send', -100, 100, 0], ['beats_free', 0, 2, 0]],
    plate: [['predelay', 0, 200, 0], ['size', 0, 100, 50], ['decay', 0, 100, 50], ['damping', 0, 100, 0], ['mix', 0, 100, 0]],
  };
  for (const e of EFFECTS) assert.deepEqual(e.dials.map((d) => [d.key, d.min, d.max, d.default]), want[e.type]);
  assert.deepEqual(dialDef('delay', 'delay_beats').options.map((o) => o.value), [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2]);
});

test('every dial clamps, rounds and snaps like ASTRID\'s dialValue', () => {
  for (const e of EFFECTS) for (const d of e.dials) {
    assert.equal(clampDial(d, NaN), d.default);
    assert.equal(clampDial(d, '5'), d.default);
    assert.equal(clampDial(d, Infinity), d.default);
    assert.equal(clampDial(d, -1e9), d.options ? d.options[0].value : d.min);
    assert.equal(clampDial(d, 1e9), d.options ? d.options.at(-1).value : d.max);
    for (let k = 0; k <= 20; k++) {
      const raw = d.min + (d.max - d.min) * k / 20 + 0.3;
      const v = clampDial(d, raw);
      assert.ok(v >= d.min && v <= d.max, `${e.type}.${d.key} ${raw} -> ${v}`);
      if (d.exact) assert.ok(v === 0 || (v >= d.minOn && v === Math.min(d.max, raw)), `${d.key} keeps ${raw} -> ${v}`);
      else if (!d.options) assert.equal(v, Math.round(v));
      else assert.ok(d.options.some((o) => o.value === v));
      assert.equal(typeof d.format(v, 120), 'string');
    }
  }
  assert.equal(clampDial(dialDef('delay', 'delay_beats'), 0.7), 0.75);
  assert.equal(clampDial(dialDef('delay', 'delay_beats'), 0.15), 0.125, '1/32');
  const bf = dialDef('delay', 'beats_free');
  assert.deepEqual([0, -1, 0.01, 0.124, 0.125, 0.3, 1.37, 0.6123456789, 2, 5].map((x) => clampDial(bf, x)), [0, 0, 0.125, 0.125, 0.125, 0.3, 1.37, 0.6123456789, 2, 2]);
});

test('laws: dials to DSP units (hacks.ts hackParams)', () => {
  assert.equal(dialToDsp('drive', 'drive_db', 12), 12);
  assert.equal(dialToDsp('drive', 'output_db', -3), -3);
  assert.equal(dialToDsp('drive', 'mix', 80), 0.8);
  assert.equal(dialToDsp('delay', 'delay_beats', 1.5), 1.5);
  assert.equal(dialToDsp('delay', 'feedback', 35), 0.35);
  assert.equal(dialToDsp('delay', 'mix', 40), 0.4);
  assert.equal(dialToDsp('plate', 'predelay', 20), 0.02);
  assert.equal(dialToDsp('plate', 'size', 60), 0.6);
  assert.equal(dialToDsp('plate', 'bypass', true), 0);
  assert.equal(dialToDsp('plate', 'bypass', false), 1);
  assert.equal(delaySeconds(0.75, 120), 0.375);
  assert.equal(delaySeconds(2, 20), 4.9);
});

test('every engine index is driven by exactly one dial', () => {
  const seen = new Set();
  for (const t of Object.keys(PARAM_INDEX)) for (const i of Object.values(PARAM_INDEX[t])) { assert.ok(!seen.has(i)); seen.add(i); }
  assert.equal(seen.size, FX_NPARAMS);
  assert.equal(NPARAMS, FX_NPARAMS);
  const names = { drive: ['DRIVE_ON', 'DRIVE_DB', 'DRIVE_OUT_DB', 'DRIVE_MIX', 'DRIVE_CURVE', 'DRIVE_TONE', 'DRIVE_MOD', 'DRIVE_MOD_TONE'], delay: ['DELAY_ON', 'DELAY_BEATS', 'DELAY_FEEDBACK', 'DELAY_MIX', 'DELAY_TONE', 'DELAY_LOW_CUT', 'DELAY_MODE', 'DELAY_SEND', 'DELAY_MOD_SEND', 'DELAY_BEATS_FREE'], plate: ['PLATE_ON', 'PLATE_PREDELAY', 'PLATE_SIZE', 'PLATE_DECAY', 'PLATE_DAMPING', 'PLATE_MIX'] };
  for (const t of Object.keys(names)) assert.deepEqual(Object.values(PARAM_INDEX[t]), names[t].map((n) => FX_PARAM[n]));
  const p = compile(defaultState());
  assert.equal(p.length, FX_NPARAMS);
  assert.equal(p[FX_PARAM.DRIVE_ON], 0);
  assert.equal(p[FX_PARAM.DRIVE_MIX], 1);
  assert.equal(p[FX_PARAM.DELAY_BEATS], 0.75);
  assert.deepEqual([p[FX_PARAM.DRIVE_CURVE], p[FX_PARAM.DRIVE_TONE], p[FX_PARAM.DRIVE_MOD], p[FX_PARAM.DRIVE_MOD_TONE]], [0, 100 / 99, 0, 0]);
});

test('state is JSON and round-trips exactly', () => {
  const s = defaultState();
  s.chain[1].bypass = false; s.chain[1].dials.mix = 40; s.chain[2].dials.size = 77;
  const back = sanitize(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(back, s);
  assert.deepEqual(sanitize(back), back);
  assert.equal(JSON.stringify(sanitize(JSON.parse(JSON.stringify(back)))), JSON.stringify(s));
  // Random states survive too.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 200; k++) {
    const x = defaultState();
    for (const slot of x.chain) {
      slot.bypass = rnd() < 0.5;
      for (const d of EFFECTS.find((e) => e.type === slot.type).dials) slot.dials[d.key] = clampDial(d, d.min + rnd() * (d.max - d.min));
    }
    assert.deepEqual(sanitize(JSON.parse(JSON.stringify(x))), x);
  }
});

test('sanitize: garbage, any order, missing effects, the reverb alias', () => {
  assert.deepEqual(sanitize(undefined), defaultState());
  assert.deepEqual(sanitize('nope'), defaultState());
  assert.deepEqual(sanitize({ v: 1, chain: [null, 3, { type: 'eq' }] }), defaultState());
  const s = sanitize({ v: 1, chain: [{ type: 'reverb', bypass: false, dials: { mix: 33, size: 'x' } }, { type: 'drive', dials: { drive_db: 99 } }] });
  assert.deepEqual(s.chain.map((c) => c.type), ['drive', 'delay', 'plate']);
  assert.equal(s.chain[2].bypass, false);
  assert.equal(s.chain[2].dials.mix, 33);
  assert.equal(s.chain[2].dials.size, 50);
  assert.equal(s.chain[0].dials.drive_db, 24);
  assert.equal(s.chain[0].bypass, true); // v1: bypass unless explicitly false
  assert.equal(effectType('reverb'), 'plate');
  assert.equal(effectType('flanger'), null);
});

test('migrate: ASTRID\'s saved hacks array (wet -> mix, absent = bypassed, others reported)', () => {
  const astrid = [
    { id: 'flanger-1', type: 'flanger', bypass: false, dials: { rate: 30 } },
    { id: 'delay-1', type: 'delay', bypass: false, dials: { delay_beats: 1.5, feedback: 50, wet: 40 } },
    { id: 'drive-1', type: 'drive', bypass: true, dials: { drive_db: 6 } },
  ];
  const { state, dropped } = migrate(astrid);
  assert.deepEqual(dropped, ['flanger']);
  assert.deepEqual(state.chain[1], { id: 'delay', type: 'delay', bypass: false, dials: { delay_beats: 1.5, feedback: 50, mix: 40, tone: 100, low_cut: 0, mode: 0, send: 100, mod_send: 0, beats_free: 0 } });
  assert.equal(state.chain[0].bypass, true);
  assert.equal(state.chain[0].dials.drive_db, 6);
  assert.equal(state.chain[2].bypass, true); // no plate in the ASTRID chain: not playing
  assert.equal(state.chain[2].dials.mix, 0);
});

test('describeParams() is plain JSON for every control; FORMATS gives the readouts by effect.key', async () => {
  const { describeParams, FORMATS } = await import('../src/params.js');
  const d = describeParams();
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d); // no functions, nothing lost
  assert.equal(d.length, FX_NPARAMS);
  assert.deepEqual(d.map((x) => x.index).sort((a, b) => a - b), [...Array(FX_NPARAMS).keys()]);
  const beats = d.find((x) => x.effect === 'delay' && x.key === 'delay_beats');
  assert.deepEqual([beats.control, beats.unit, beats.tempoSynced, beats.options.length], ['select', 'beats', true, 7]);
  const by = d.find((x) => x.effect === 'plate' && x.key === 'bypass');
  assert.deepEqual([by.control, by.default, by.index], ['toggle', true, FX_PARAM.PLATE_ON]);
  const fb = d.find((x) => x.effect === 'delay' && x.key === 'feedback');
  assert.deepEqual([fb.unit, fb.min, fb.max, fb.step, fb.default, fb.control, fb.curve], ['%', 0, 90, 1, 35, 'knob', 'linear']);
  for (const x of d) assert.ok(x.key === 'bypass' || typeof FORMATS[x.effect + '.' + x.key] === 'function', x.key);
  assert.equal(FORMATS['delay.delay_beats'](0.75, 120), '375 ms');
  assert.equal(FORMATS['drive.drive_db'](0), 'clean');
  const lc = d.find((x) => x.effect === 'delay' && x.key === 'low_cut'), bf = d.find((x) => x.effect === 'delay' && x.key === 'beats_free');
  assert.deepEqual([lc.index, lc.unit, lc.curve], [19, 'Hz', 'log']);
  assert.deepEqual([bf.index, bf.unit, bf.step, bf.offValue, bf.minOn, bf.tempoSynced], [23, 'beats', 0.001, 0, 0.125, true]);
  assert.equal(beats.overriddenBy, 'beats_free');
  assert.equal(FORMATS['delay.beats_free'](0, 120), 'off');
  assert.equal(FORMATS['delay.beats_free'](0.3, 125), 'free 0.3 beats \u00b7 144 ms');
  assert.equal(FORMATS['delay.tone'](0), '800 Hz');
  assert.equal(FORMATS['delay.tone'](99), '12800 Hz');
  assert.equal(FORMATS['delay.low_cut'](0), 'off');
});
