// Runs in headless Chrome: real AudioWorklet in an OfflineAudioContext, plus the panel in a real DOM.
import { createFxCore, createFx, defaultState, compile } from '../../src/index.js';
import { createFxDsp } from '../../src/dsp.js';
import { createFxChainDsp } from '../../src/chain.js';
import { sanitizeSlots, slotProgram } from '../../src/slots.js';

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

async function render(edit, opts, hook) {
  const ctx = new OfflineAudioContext(2, N, SR);
  const buf = ctx.createBuffer(2, N, SR);
  buf.copyToChannel(inL, 0); buf.copyToChannel(inR, 1);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const s = defaultState(); if (edit) edit(s);
  const fx = createFxCore(ctx, { state: s, ...opts }); // default options
  await fx.ready;
  if (hook) hook(ctx, fx);
  src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  return { L: out.getChannelData(0), R: out.getChannelData(1), status: fx.status, fx };
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
  check('all bypassed with default options is bit-identical to the input (exact unity)', same(a.L, inL) && same(a.R, inR));
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
  // Mod input (PR A): fx.modInput feeds the worklet's second input; nothing is routed yet, so the sound is the same.
  {
    const allOn = (s) => { ON.drive(s); ON.delay(s); ON.plate(s); };
    const ref = await render(allOn);
    const idle = await render(allOn, { modInput: true });
    const mi = idle.fx.modInput;
    check('modInput: true gives a mono fx.modInput (explicit, discrete); default null', mi && mi.channelCount === 1 && mi.channelCountMode === 'explicit' && mi.channelInterpretation === 'discrete' && ref.fx.modInput === null);
    check('mod input present, nothing connected: bit-identical to no mod input', idle.status === 'ready' && same(idle.L, ref.L) && same(idle.R, ref.R));
    const cv = await render(allOn, { modInput: true }, (ctx, fx) => {
      const env = ctx.createBuffer(2, N, SR); // stereo into the mono input: channel 0 is kept ('discrete')
      for (let c = 0; c < 2; c++) { const d = env.getChannelData(c); for (let i = 0; i < N; i++) d[i] = (i % 2756) < 400 ? 0.9 - c * 0.4 : 0; }
      const s = ctx.createBufferSource(); s.buffer = env; s.connect(fx.modInput); s.start(0);
    });
    check('mod input present with an accent CV connected: bit-identical to no mod input', cv.status === 'ready' && same(cv.L, ref.L) && same(cv.R, ref.R));
  }
  // PR B: Acid + tone + both accent depths in the real worklet == the engine run here in 128-frame blocks.
  {
    const cvBuf = new Float32Array(N);
    for (let i = 0; i < N; i++) cvBuf[i] = (i % 6000) < 1500 ? Math.exp(-(i % 6000) / 500) : 0;
    const acid = (s) => { Object.assign(s.chain[0], { bypass: false }); Object.assign(s.chain[0].dials, { curve: 1, drive_db: 10.2, tone: 40, mod_drive: 50, mod_tone: 30 }); ON.delay(s); };
    const connectCv = (ctx, fx) => { const b = ctx.createBuffer(1, N, SR); b.copyToChannel(cvBuf, 0); const s = ctx.createBufferSource(); s.buffer = b; s.connect(fx.modInput); s.start(0); };
    const w = await render(acid, { modInput: true }, connectCv);
    const st = defaultState(); acid(st);
    const eng = createFxDsp(SR); eng.setTempo(120, 0, true); eng.load(compile(st), 0, true);
    const eL = new Float32Array(N), eR = new Float32Array(N);
    for (let o = 0; o < N; o += 128) eng.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), eL.subarray(o, o + 128), eR.subarray(o, o + 128), 128, o, cvBuf.subarray(o, o + 128));
    // Chrome's audio thread flushes float32 subnormals (FTZ) and this page doesn't: compare with those as 0.
    const TINY = 1.1754943508222875e-38, ftz = (v) => (Math.abs(v) < TINY ? 0 : v);
    const sameFtz = (x, y) => x.every((v, i) => ftz(v) === ftz(y[i]));
    const sub = eL.filter((v) => v !== 0 && Math.abs(v) < TINY).length;
    check('Acid + tone + accent: worklet output == engine output (bit-identical; float32 subnormals as 0)', w.status === 'ready' && sameFtz(w.L, eL) && sameFtz(w.R, eR), `${rms(w.L, eL)}, ${sub} subnormal samples here`);
    const noCv = await render(acid, { modInput: true });
    check('Acid accent depths move the sound only with a CV connected', rms(w.L, noCv.L) > 1e-3, rms(w.L, noCv.L).toFixed(4));
  }
  // PR C: Send delay + tone + low cut + free time + Accent -> send in the real worklet == the engine here.
  {
    const cvBuf = new Float32Array(N);
    for (let i = 0; i < N; i++) cvBuf[i] = (i % 6000) < 1500 ? Math.exp(-(i % 6000) / 500) : 0;
    const send = (s) => { s.chain[1].bypass = false; Object.assign(s.chain[1].dials, { mode: 1, mix: 100, feedback: 60, send: 30, mod_send: 70, tone: 50, low_cut: 120, beats_free: 0.3 }); };
    const connectCv = (ctx, fx) => { const b = ctx.createBuffer(1, N, SR); b.copyToChannel(cvBuf, 0); const s = ctx.createBufferSource(); s.buffer = b; s.connect(fx.modInput); s.start(0); };
    const w = await render(send, { modInput: true }, connectCv);
    const st = defaultState(); send(st);
    const eng = createFxDsp(SR); eng.setTempo(120, 0, true); eng.load(compile(st), 0, true);
    const eL = new Float32Array(N), eR = new Float32Array(N);
    for (let o = 0; o < N; o += 128) eng.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), eL.subarray(o, o + 128), eR.subarray(o, o + 128), 128, o, cvBuf.subarray(o, o + 128));
    const TINY = 1.1754943508222875e-38, ftz = (v) => (Math.abs(v) < TINY ? 0 : v);
    const sameFtz = (x, y) => x.every((v, i) => ftz(v) === ftz(y[i]));
    check('Send delay + tone + low cut + free time + send mod: worklet output == engine output (float32 subnormals as 0)', w.status === 'ready' && sameFtz(w.L, eL) && sameFtz(w.R, eR), String(rms(w.L, eL)));
    // Zeta P3 (PR A): a never-connected modInput feeds silence, which renders as no mod even with depths set.
    const idle = await render(send, { modInput: true }), none = await render(send);
    check('never-connected modInput with nonzero depths == no mod input (bit-identical)', idle.status === 'ready' && same(idle.L, none.L) && same(idle.R, none.R));
  }
  // Timed change on the audio clock: delay mix scheduled at 0.5 s.
  {
    const ctx = new OfflineAudioContext(2, N, SR);
    const imp = ctx.createBuffer(1, N, SR); const d = imp.getChannelData(0); d[0] = 1; d[SR / 2 + 100] = 1;
    const src = ctx.createBufferSource(); src.buffer = imp;
    const fx = createFxCore(ctx, { state: (() => { const s = defaultState(); s.chain[1].bypass = false; s.chain[1].dials.mix = 0; s.chain[1].dials.feedback = 0; return s; })() });
    await fx.ready;
    src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
    // Port messages reach the render thread asynchronously, so (as in a live app with lookahead)
    // schedule ahead of the render position: pause the offline render at 0.1 s, post, resume.
    ctx.suspend(0.1).then(async () => { fx.setParam('delay', 'mix', 100, 0.5); await new Promise((r) => setTimeout(r, 50)); ctx.resume(); });
    const out = (await ctx.startRendering()).getChannelData(0);
    const echo1 = Math.abs(out[Math.round(0.375 * SR)]), echo2 = Math.abs(out[SR / 2 + 100 + Math.round(0.375 * SR)]);
    check('scheduled param lands on the audio clock (no echo before 0.5 s, echo after)', echo1 < 1e-6 && echo2 > 0.1, `${echo1} ${echo2}`);
  }
  // Called before the worklet is ready: queued, then applied at its AudioContext time (not folded into the start).
  {
    const ctx = new OfflineAudioContext(2, N, SR);
    const imp = ctx.createBuffer(1, N, SR); const d = imp.getChannelData(0); d[0] = 1; d[SR / 2 + 100] = 1;
    const src = ctx.createBufferSource(); src.buffer = imp;
    const fx = createFxCore(ctx, { state: (() => { const s = defaultState(); s.chain[1].bypass = false; s.chain[1].dials.mix = 0; s.chain[1].dials.feedback = 0; return s; })() });
    fx.setParam('delay', 'mix', 100, 0.5); // fx.status is still 'loading'
    const early = fx.status;
    await fx.ready;
    src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
    const out = (await ctx.startRendering()).getChannelData(0);
    const echo1 = Math.abs(out[Math.round(0.375 * SR)]), echo2 = Math.abs(out[SR / 2 + 100 + Math.round(0.375 * SR)]);
    check('a timed call made before ready is applied at its time (no echo before 0.5 s, echo after)', early === 'loading' && out[0] === 1 && echo1 < 1e-6 && echo2 > 0.1, `${early} ${out[0]} ${echo1} ${echo2}`);
  }
  // Panel in a real DOM.
  {
    const ctx = new OfflineAudioContext(2, 128, SR);
    const fx = createFx(ctx);
    await fx.ready;
    const panel = await fx.mount(document.getElementById('panel'));
    const slider = document.querySelector('[data-testid="nc-fx-plate-mix"]');
    check('panel renders 3 kit FX cards', document.querySelectorAll('.nc-ui-fx').length === 3);
    const dsl = document.querySelector('[data-testid="nc-fx-drive-drive_db"]'), curveSel = document.querySelector('[data-testid="nc-fx-drive-curve"]');
    const step0 = dsl.step;
    curveSel.value = '1'; curveSel.dispatchEvent(new Event('change'));
    const step1 = dsl.step;
    fx.setParam('drive', 'drive_db', 7.3);
    const v1 = dsl.value;
    fx.setParam('drive', 'curve', 0);
    check('panel: Curve select; Drive slider steps 0.1 dB in Acid, whole dB in Smooth', curveSel.tagName === 'SELECT' && step0 === '1' && step1 === '0.1' && v1 === '7.3' && dsl.step === '1' && dsl.value === '7' && fx.getParam('drive', 'drive_db') === 7, [step0, step1, v1, dsl.step, dsl.value]);
    check('panel: tone readout says off at 100', document.querySelector('[data-testid="nc-fx-drive-tone"]').parentNode.querySelector('output').textContent === 'off');
    slider.value = '42'; slider.dispatchEvent(new Event('input'));
    check('moving a slider sets the param', fx.getParam('plate', 'mix') === 42);
    check('user-moved slider is not marked modulated', !slider.hasAttribute('data-modulated'));
    fx.setParam('plate', 'mix', 10);
    check('host-moved slider is marked data-modulated', slider.hasAttribute('data-modulated') && slider.value === '10');
    check('modulated slider has no transition', getComputedStyle(slider).transitionDuration.split(',').every((t) => parseFloat(t) === 0));
    // The kit's On / Off switch (role=switch, aria-checked); its colours and motion are the live nc-ui sheet's.
    const btn = document.querySelector('[data-testid="nc-fx-plate"] .nc-ui-switch');
    btn.click();
    check('On/Off toggles bypass', fx.getParam('plate', 'bypass') === false && btn.getAttribute('aria-checked') === 'true' && btn.getAttribute('role') === 'switch');
    check('delay readout shows ms at the tempo', document.querySelector('[data-testid="nc-fx-delay"] output').textContent === '375 ms');
    fx.setTempo(90);
    check('readout follows the tempo', document.querySelector('[data-testid="nc-fx-delay"] output').textContent === '500 ms');
    const freeSl = document.querySelector('[data-testid="nc-fx-delay-beats_free"]'), freeRow = freeSl.parentNode, timRow = document.querySelector('[data-testid="nc-fx-delay-delay_beats"]').parentNode;
    const off0 = freeRow.querySelector('output').textContent, ov0 = timRow.hasAttribute('data-overridden');
    freeSl.value = '0.3'; freeSl.dispatchEvent(new Event('input'));
    check('panel: Free time reads off, then "free 0.3 beats · 200 ms" (at 90 bpm), marked free; Timing marked overridden',
      off0 === 'off' && !ov0 && freeSl.step === '0.001' && fx.getParam('delay', 'beats_free') === 0.3 && freeRow.querySelector('output').textContent === 'free 0.3 beats \u00b7 200 ms'
      && freeRow.hasAttribute('data-free') && timRow.hasAttribute('data-overridden') && timRow.querySelector('output').textContent === 'free time',
      [off0, freeRow.querySelector('output').textContent, timRow.querySelector('output').textContent]);
    check('accent comes from --nc-ui-accent (Free time readout)', getComputedStyle(freeRow.querySelector('output')).color === 'rgb(18, 52, 86)', getComputedStyle(freeRow.querySelector('output')).color);
    fx.setParam('delay', 'beats_free', 0);
    check('panel: Free time off gives the Timing select back', !timRow.hasAttribute('data-overridden') && timRow.querySelector('output').textContent === '500 ms' && !freeRow.hasAttribute('data-free'));
    check('panel: delay Mode select and 1/32 option', document.querySelector('[data-testid="nc-fx-delay-mode"]').tagName === 'SELECT' && [...document.querySelector('[data-testid="nc-fx-delay-delay_beats"]').options].some((o) => o.textContent === '1/32'));
    panel.destroy();
    check('destroy removes the panel', !document.querySelector('.nc-fx'));
    // dispose() while mount() is still loading the panel: nothing is left in the page or listening.
    const fx2 = createFx(ctx);
    const pending = fx2.mount(document.getElementById('panel'));
    fx2.dispose();
    const late = await pending;
    check('dispose during mount leaves no panel', !document.querySelector('.nc-fx') && !!late && typeof late.destroy === 'function');
  }

  // Slot mode (ASTRID's chain model) in the real AudioWorklet: an ASTRID preset plays what the engine renders here.
  {
    const preset = [
      { id: 'phaser-1', type: 'phaser', bypass: false, dials: { rate: 55, depth: 80, stages: 8, feedback: 40, mix: 50 } },
      { id: 'eq-1', type: 'eq', bypass: false, dials: { low_db: 6, mid_db: -5, mid_hz: 30, mid_q: 50, high_db: 3 } },
      { id: 'delay-1', type: 'delay', bypass: false, dials: { delay_beats: 0.5, feedback: 50, wet: 35 } },
    ];
    const ctx = new OfflineAudioContext(2, N, SR);
    const buf = ctx.createBuffer(2, N, SR); buf.copyToChannel(inL, 0); buf.copyToChannel(inR, 1);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const fx = createFxCore(ctx, { slots: true, state: preset, limiter: 'lookahead', preGain: 0.8 });
    await fx.ready;
    src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
    const out = await ctx.startRendering();
    const eng = createFxChainDsp(SR, { limiter: 'lookahead', preGain: 0.8 }); eng.setTempo(120, 0, true);
    const st = sanitizeSlots(preset);
    st.chain.forEach((x, i) => { eng.add(i + 1, x.type, 0); for (const [k, v] of slotProgram(x)) eng.set(i + 1, k, v, 0, true); });
    eng.order([1, 2, 3], 0, true);
    const eL = new Float32Array(N), eR = new Float32Array(N);
    for (let o = 0; o < N; o += 128) eng.process(inL.subarray(o, o + 128), inR.subarray(o, o + 128), eL.subarray(o, o + 128), eR.subarray(o, o + 128), 128, o);
    const TINY = 1.1754943508222875e-38, ftz = (v) => (Math.abs(v) < TINY ? 0 : v);
    const sameFtz = (x, y) => x.every((v, i) => ftz(v) === ftz(y[i]));
    check('slots: an ASTRID preset in the real worklet == the slot engine (float32 subnormals as 0)', fx.status === 'ready' && sameFtz(out.getChannelData(0), eL) && sameFtz(out.getChannelData(1), eR), rms(out.getChannelData(0), eL));
  }
  // Slot panel: ASTRID's Hacks panel on the kit's FX cards.
  {
    const ctx = new OfflineAudioContext(2, 128, SR);
    const fx = createFx(ctx, { slots: 3, limiter: 'lookahead', state: [{ id: 'lowpass-1', type: 'lowpass', bypass: false, dials: { cutoff: 40 } }] });
    await fx.ready;
    const host = document.getElementById('panel');
    const panel = await fx.mount(host);
    const q = (sel) => host.querySelector(sel), qa = (sel) => [...host.querySelectorAll(sel)];
    const add = q('[data-testid="nc-fx-add"]');
    check('slots panel: "Add a hack" offers ASTRID\'s menu in ASTRID\'s order (no filters)', add.getAttribute('aria-label') === 'Add a hack'
      && [...add.options].map((o) => o.textContent).join() === 'Add a hack,Delay,Reverb,Flanger,Chorus,Phaser,EQ,Drive,Compressor,Width', [...add.options].map((o) => o.textContent).join());
    check('slots panel: a hidden filter from an old preset shows as a card and can be removed', qa('.nc-ui-fx').length === 1 && q('[data-testid="nc-fx-lowpass-1"] .nc-ui-fx-name').textContent === 'Low-pass filter');
    q('[data-testid="nc-fx-remove-lowpass-1"]').click();
    check('slots panel: remove', qa('.nc-ui-fx').length === 0 && fx.getChain().length === 0 && q('[data-testid="nc-fx-limiter"]').hidden);
    for (const t of ['drive', 'eq', 'flanger']) { add.value = t; add.dispatchEvent(new Event('change')); }
    const cards = qa('.nc-ui-fx');
    check('slots panel: add three; full at three (select disabled, "3 of 3")', cards.length === 3 && add.disabled && q('[data-testid="nc-fx-cap"]').textContent === '3 of 3'
      && fx.getChain().map((x) => x.id).join() === 'drive-1,eq-1,flanger-1');
    const card = cards[0], name = card.querySelector('.nc-ui-fx-name'), sw = card.querySelector('.nc-ui-switch');
    check('slots panel: kit card markup (depth by position as ASTRID, header name + switch named by it, On/Off text)',
      card.dataset.ncDepth === '2' && cards[2].dataset.ncDepth === '4' && card.querySelector('.nc-ui-fx-hd') && sw.getAttribute('role') === 'switch'
      && sw.getAttribute('aria-labelledby') === name.id && sw.getAttribute('aria-checked') === 'true' && sw.textContent === 'OnOff' && card.querySelector('.nc-token-probe'));
    sw.click();
    check('slots panel: the switch bypasses; the card dims by data-nc-dim', fx.getParam('drive-1', 'bypass') === true && sw.getAttribute('aria-checked') === 'false' && card.dataset.ncDim === 'true');
    const more = card.querySelector('details.nc-ui-more');
    check('slots panel: nc-fx\'s own dials sit under "More"', more && more.querySelector('summary').textContent === 'More'
      && [...more.querySelectorAll('.nc-field')].map((f) => f.querySelector('.nc-label').textContent).join() === 'Curve,Tone,Accent → drive,Accent → tone');
    const sl = card.querySelector('.nc-field[data-nc-slider] .nc-range');
    check('slots panel: slider fields are the kit\'s (label, range, readout, aria-valuetext)', sl && sl.closest('.nc-field').querySelector('.nc-label') && sl.getAttribute('aria-valuetext') === 'clean');
    check('slots panel: EQ shows ASTRID\'s note', q('[data-testid="nc-fx-eq-1"] .nc-note').textContent === 'Low shelf 150 Hz, high shelf 6 kHz.');
    q('[data-testid="nc-fx-down-drive-1"]').click();
    check('slots panel: move down (and the first card\'s up is disabled)', fx.getChain().map((x) => x.id).join() === 'eq-1,drive-1,flanger-1' && q('[data-testid="nc-fx-up-eq-1"]').disabled);
    q('[data-testid="nc-fx-up-flanger-1"]').click();
    check('slots panel: move up', fx.getChain().map((x) => x.id).join() === 'eq-1,flanger-1,drive-1');
    check('slots panel: the limiter line (lookahead)', q('[data-testid="nc-fx-limiter"]').textContent === 'Limiter −1 dB, fixed last');
    const rm = q('[data-testid="nc-fx-remove-eq-1"]');
    const fb = getComputedStyle(rm).transitionDuration.split(',').map(parseFloat);
    check('slots panel: one-off feedback motion is 100-250 ms', fb.every((t) => t >= 0.1 && t <= 0.25), fb);
    fx.setState([{ id: 'chorus-1', type: 'chorus', bypass: false, dials: { mix: 70 } }]);
    check('slots panel: a state loaded by the host rebuilds the cards', qa('.nc-ui-fx').length === 1 && q('[data-testid="nc-fx-chorus-1-mix"]').value === '70' && !add.disabled);
    fx.setParam('chorus-1', 'mix', 20);
    check('slots panel: a host-moved slider is marked data-modulated', q('[data-testid="nc-fx-chorus-1-mix"]').hasAttribute('data-modulated'));
    panel.destroy();
    check('slots panel: destroy', !host.querySelector('.nc-fx'));
  }

  // Module shading (nc-ui docs/design-rules.md), with the real nc-ui sheet: panel stack-1, cards stack-2, -3, -4 by
  // position. Computed backgrounds strictly darken top to bottom, and re-shade at once after a move, add or remove.
  {
    const lum = (el) => { const m = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g).map(Number); return m[0] + m[1] + m[2]; };
    const host = document.getElementById('panel');
    const ctx = new OfflineAudioContext(2, 128, SR);
    const fx = createFx(ctx, { slots: 3, state: [{ id: 'eq-1', type: 'eq' }, { id: 'drive-1', type: 'drive' }, { id: 'phaser-1', type: 'phaser' }] });
    await fx.ready;
    const panel = await fx.mount(host);
    const shades = () => [panel.root, ...host.querySelectorAll('.nc-ui-fx')].map(lum);
    const strictlyDarker = (a) => a.every((v, i) => i === 0 || v < a[i - 1]);
    const s0 = shades();
    check('shading: panel stack-1, cards stack-2, -3, -4; backgrounds strictly darken top to bottom', strictlyDarker(s0) && s0.length === 4
      && [...host.querySelectorAll('.nc-ui-fx')].map((c) => c.dataset.ncDepth).join() === '2,3,4', s0);
    const firstBg = getComputedStyle(host.querySelector('[data-testid="nc-fx-eq-1"]')).backgroundColor;
    host.querySelector('[data-testid="nc-fx-down-eq-1"]').click();
    const s1 = shades(), eq = host.querySelector('[data-testid="nc-fx-eq-1"]'), top = host.querySelector('.nc-ui-fx');
    check('shading: depth follows position: after a move the stack re-shades (still strictly darker), the moved card darker',
      strictlyDarker(s1) && eq.dataset.ncDepth === '3' && top.dataset.testid === 'nc-fx-drive-1' && top.dataset.ncDepth === '2'
      && getComputedStyle(top).backgroundColor === firstBg && getComputedStyle(eq).backgroundColor !== firstBg, s1);
    host.querySelector('[data-testid="nc-fx-remove-drive-1"]').click();
    check('shading: after a remove the new first card is stack-2', host.querySelector('.nc-ui-fx').dataset.ncDepth === '2' && strictlyDarker(shades()));
    check('shading: the slider track and text-sub follow each card\'s step (kit rules)', getComputedStyle(host.querySelector('.nc-ui-fx')).getPropertyValue('--nc-ui-text-sub').trim() !== getComputedStyle(panel.root).getPropertyValue('--nc-ui-text-sub').trim());
    panel.destroy();
    const fixed = createFx(ctx);
    await fixed.ready;
    const p2 = await fixed.mount(host);
    const f0 = [p2.root, ...host.querySelectorAll('.nc-ui-fx')].map(lum);
    check('shading: the fixed chain too (Drive, Delay, Reverb = 2, 3, 4)', strictlyDarker(f0) && [...host.querySelectorAll('.nc-ui-fx')].map((c) => c.dataset.ncDepth).join() === '2,3,4', f0);
    p2.destroy();
  }
}

main().catch((e) => check('no exception', false, e && e.stack || e)).finally(() => { window.__results = results; });
