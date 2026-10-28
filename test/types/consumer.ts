// Type-level test: how Rhythm/Bass would use the package. `npm run typecheck` compiles it.
import { createFx, createFxCore, migrate, EFFECTS, type FxState } from '../../src/index.js';
import { createFxDsp, FX_PARAM } from '../../src/dsp.js';
import { applyTempoMap, followClock } from '../../src/tempo.js';
import { compile } from '../../src/params.js';

declare const ctx: AudioContext;
const fx = createFx(ctx, { bpm: 128, limiter: 'soft' });
fx.setParam('reverb', 'mix', 30);
fx.setParam('delay', 'bypass', false, ctx.currentTime + 0.1);
const s: FxState = fx.getState();
fx.setState(JSON.parse(JSON.stringify(s)));
fx.setTempo(140, ctx.currentTime);
const off: () => void = fx.onChange((c) => { if (c.effect === 'drive') void c.value; });
off();
void fx.mount(document.body).then((p) => p.destroy());
const core = createFxCore(ctx);
core.output.connect(ctx.destination);
const dsp = createFxDsp(48000, { bypassMode: 'run' });
dsp.load(compile(migrate([{ type: 'plate', bypass: false, dials: { mix: 40 } }]).state), 0, true);
dsp.set(FX_PARAM.DELAY_MIX, 0.3);
applyTempoMap(fx, { points: [{ beat: 0, bpm: 120 }], timeAt: (b) => b / 2 }, { toBeat: 16 });
followClock(fx, { onChange: () => () => {}, transport: { tempo: { bpmAt: () => 120 }, timeAt: (b) => b, beatAt: (t) => t } });
void EFFECTS.map((e) => e.dials.map((d) => d.format(d.default, 120)));
