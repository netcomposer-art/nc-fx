// Runs in headless Chrome: real AudioWorklet in an OfflineAudioContext, plus the panel in a real DOM.
import { createFxCore, createFx, defaultState } from '../../src/index.js';

const SR = 48000, N = SR; // 1 s
const results = [];
const check = (name, ok, info) => results.push({ name, ok: !!ok, info: info === undefined ? '' : String(info) });

function input() {
  let s = 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < N; i++) { const env = (i % 12000) < 3000 ? 1 : 0; L[i] = env * (0.5 * Math.sin(i * 0.03) + 0.3 * (rnd() * 2 - 1)); R[i] = env * (0.4 * Math.sin(i * 0.021) + 0.3 * (rnd() * 2 - 1)); }
  return [L, R];
}
const [inL, inR] = input();

async function render(edit, opts) {
  const ctx = new OfflineAudioContext(2, N, SR);
  const buf = ctx.createBuffer(2, N, SR);
  buf.copyToChannel(inL, 0); buf.copyToChannel(inR, 1);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const s = defaultState(); if (edit) edit(s);
  const fx = createFxCore(ctx, { limiter: 'off', preGain: 1, state: s, ...opts });
  await fx.ready;
  src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  return { L: out.getChannelData(0), R: out.getChannelData(1), status: fx.status };
}
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]) || (v === 0 && b[i] === 0));
const rms = (a, b) => Math.sqrt(a.reduce((acc, v, i) => acc + (v - b[i]) ** 2, 0) / a.length);
const ON = {
  drive: (s) => { s.chain[0].bypass = false; s.chain[0].dials.drive_db = 18; },
  delay: (s) => { s.chain[1].bypass = false; s.chain[1].dials.mix = 50; },
  plate: (s) => { s.chain[2].bypass = false; s.chain[2].dials.mix = 40; },
};

async function main() {
  // Blob-URL fallback (lazy chunk) and the served module URL both load the processor.
  const a = await render(null);
  check('worklet loads via lazy Blob URL', a.status === 'ready', a.status);
  check('all bypassed (limiter off, pre-gain 1) is bit-identical to the input', same(a.L, inL) && same(a.R, inR));
  const b = await render(null, { moduleUrl: new URL('../../dist/worklet.js', import.meta.url).href });
  check('worklet loads via moduleUrl (dist/worklet.js)', b.status === 'ready', b.status);
  for (const [type, on] of Object.entries(ON)) {
    for (const mode of ['hold', 'run']) {
      const w = await render(on, { bypassMode: mode });
      check(`${type} (${mode}) changes the signal`, rms(w.L, inL) > 1e-3, rms(w.L, inL).toFixed(4));
      const by = await render((s) => { on(s); s.chain.find((c) => c.type === type).bypass = true; }, { bypassMode: mode });
      check(`${type} (${mode}) bypassed is bit-identical`, same(by.L, inL) && same(by.R, inR));
    }
  }
  // Timed change on the audio clock: delay mix scheduled at 0.5 s.
  {
    const ctx = new OfflineAudioContext(2, N, SR);
    const imp = ctx.createBuffer(1, N, SR); const d = imp.getChannelData(0); d[0] = 1; d[SR / 2 + 100] = 1;
    const src = ctx.createBufferSource(); src.buffer = imp;
    const fx = createFxCore(ctx, { limiter: 'off', preGain: 1, state: (() => { const s = defaultState(); s.chain[1].bypass = false; s.chain[1].dials.mix = 0; s.chain[1].dials.feedback = 0; return s; })() });
    await fx.ready;
    src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
    // Port messages reach the render thread asynchronously, so (as in a live app with lookahead)
    // schedule ahead of the render position: pause the offline render at 0.1 s, post, resume.
    ctx.suspend(0.1).then(async () => { fx.setParam('delay', 'mix', 100, 0.5); await new Promise((r) => setTimeout(r, 50)); ctx.resume(); });
    const out = (await ctx.startRendering()).getChannelData(0);
    const echo1 = Math.abs(out[Math.round(0.375 * SR)]), echo2 = Math.abs(out[SR / 2 + 100 + Math.round(0.375 * SR)]);
    check('scheduled param lands on the audio clock (no echo before 0.5 s, echo after)', echo1 < 1e-6 && echo2 > 0.1, `${echo1} ${echo2}`);
  }
  // Panel in a real DOM.
  {
    const ctx = new OfflineAudioContext(2, 128, SR);
    const fx = createFx(ctx);
    await fx.ready;
    const panel = await fx.mount(document.getElementById('panel'));
    const slider = document.querySelector('[data-testid="nc-fx-plate-mix"]');
    check('panel renders 3 sections', document.querySelectorAll('.nc-fx-sec').length === 3);
    slider.value = '42'; slider.dispatchEvent(new Event('input'));
    check('moving a slider sets the param', fx.getParam('plate', 'mix') === 42);
    check('user-moved slider is not marked modulated', !slider.hasAttribute('data-modulated'));
    fx.setParam('plate', 'mix', 10);
    check('host-moved slider is marked data-modulated', slider.hasAttribute('data-modulated') && slider.value === '10');
    check('modulated slider has no transition', getComputedStyle(slider).transitionDuration.split(',').every((t) => parseFloat(t) === 0));
    const btn = document.querySelector('[data-testid="nc-fx-plate"] .nc-fx-on');
    btn.click();
    await new Promise((r) => setTimeout(r, 400)); // let the 150 ms colour feedback finish
    check('On/Off toggles bypass', fx.getParam('plate', 'bypass') === false && btn.getAttribute('aria-pressed') === 'true');
    check('accent comes from --nc-ui-accent', getComputedStyle(btn).color === 'rgb(18, 52, 86)', getComputedStyle(btn).color);
    const fb = getComputedStyle(btn).transitionDuration.split(',').map(parseFloat);
    check('one-off feedback motion is 100-250 ms', fb.every((t) => t >= 0.1 && t <= 0.25), fb);
    check('delay readout shows ms at the tempo', document.querySelector('[data-testid="nc-fx-delay"] output').textContent === '375 ms');
    fx.setTempo(90);
    check('readout follows the tempo', document.querySelector('[data-testid="nc-fx-delay"] output').textContent === '500 ms');
    panel.destroy();
    check('destroy removes the panel', !document.querySelector('.nc-fx'));
  }
}

main().catch((e) => check('no exception', false, e && e.stack || e)).finally(() => { window.__results = results; });
