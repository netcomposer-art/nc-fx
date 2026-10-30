
/** The shared NC hacks chain from netcomposer.art Create, after the synth master.
 * The DSP is the site's own code (src/hacks-vendor, see SOURCE.md); this file
 * holds the dials, the saved shape and the routing. An empty chain is a wire. */
export type HackType = 'lowpass' | 'highpass' | 'bandpass' | 'delay' | 'plate' | 'eq' | 'drive' | 'compressor' | 'width'
  | 'flanger' | 'chorus' | 'phaser';
/** A saved hack: dial positions as the site's sliders hold them. */
export interface HackSlot { id: string; type: HackType; bypass: boolean; dials: Record<string, number> }
export type HackParams = Record<string, number | string | null>;
/** The widget shape the site's worklet and Save use (schema 2 chain items). */
export interface HackWidget { id: string; type: HackType; version: 1; bypass: boolean; params: HackParams }
export interface HackDial {
  key: string; label: string; min: number; max: number; value: number;
  options?: readonly (readonly [number, string])[];
  format: (v: number, tempo: number) => string;
}
/** hidden: not offered in "Add a hack", but still loads, shows, plays and can be removed
 * (the three filters, kept for older presets, snapshots and autosaves). */
export interface HackDefinition { type: HackType; label: string; dials: readonly HackDial[]; note?: string; hidden?: true }

/** Three movable hacks; the limiter is fixed last and is not one of them.
 * (The site allows ten. Older ASTRID files and snapshots with more keep their first three.) */
export const MAX_HACKS = 3;
const ID = /^[A-Za-z0-9][A-Za-z0-9 _./:+-]{0,63}$/;

// Dial laws copied from the site's create/hacks/stack.js.
export const hackCutoffHz = (v: number) => v <= 0 ? null : Math.round(20000 * Math.pow(150 / 20000, v / 100));
const hpHz = (v: number) => v <= 0 ? null : Math.round(20 * Math.pow(100, v / 100));
const hpQ = (v: number) => +(0.7071 * Math.pow(8 / 0.7071, v / 100)).toFixed(3);
const bpHz = (v: number) => Math.round(100 * Math.pow(80, v / 100));
const bpQ = (v: number) => +(0.4 * Math.pow(20, v / 100)).toFixed(2);
const midHz = (v: number) => Math.round(200 * Math.pow(25, v / 100));
const eqQ = (v: number) => +(0.3 * Math.pow(20, v / 100)).toFixed(2);
const ratioOf = (v: number) => +Math.pow(20, v / 100).toFixed(2);
const delayS = (beats: number, tempo: number) => Math.min(4.9, beats * 60 / (tempo > 0 ? tempo : 120));
const fmtHz = (h: number | null) => h == null ? 'open' : h >= 1000 ? (h / 1000).toFixed(h >= 10000 ? 0 : 1) + ' kHz' : h + ' Hz';
const fmtDb = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + ' dB';
const pct = (v: number) => v + '%';
const wet = (v: number) => v + '% wet';
// Modulation rate: 0.05 Hz to 10 Hz, even in pitch.
export const hackRateHz = (v: number) => +(0.05 * Math.pow(200, v / 100)).toFixed(3);
const fmtRate = (v: number) => { const h = hackRateHz(v); return (h < 1 ? h.toFixed(2) : h < 10 ? h.toFixed(1) : h.toFixed(0)) + ' Hz'; };
const fbPct = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%';
const STAGES = [[4, '4'], [6, '6'], [8, '8']] as const;
const NOTES = [[0.25, '1/16'], [0.5, '1/8'], [0.75, '1/8 dotted'], [1, '1/4'], [1.5, '1/4 dotted'], [2, '1/2']] as const;
const dial = (key: string, label: string, min: number, max: number, value: number, format: HackDial['format']): HackDial =>
  ({ key, label, min, max, value, format });

export const HACK_DEFINITIONS: readonly HackDefinition[] = [
  { type: 'lowpass', label: 'Low-pass filter', hidden: true, dials: [dial('cutoff', 'Cutoff', 0, 100, 0, v => fmtHz(hackCutoffHz(v)))] },
  { type: 'highpass', label: 'High-pass filter', hidden: true, dials: [
    dial('cutoff', 'Cutoff', 0, 100, 0, v => { const h = hpHz(v); return h == null ? 'off' : fmtHz(h); }),
    dial('q', 'Resonance', 0, 100, 0, v => 'Q ' + hpQ(v).toFixed(1))] },
  { type: 'bandpass', label: 'Band-pass filter', hidden: true, dials: [
    dial('centre_hz', 'Centre', 0, 100, 53, v => fmtHz(bpHz(v))),
    dial('q', 'Q', 0, 100, 0, v => 'Q ' + bpQ(v).toFixed(1)),
    dial('mix', 'Mix', 0, 100, 100, wet)] },
  { type: 'delay', label: 'Delay', dials: [
    { key: 'delay_beats', label: 'Timing', min: 0.25, max: 2, value: 0.75, options: NOTES,
      format: (v, tempo) => Math.round(delayS(v, tempo) * 1000) + ' ms' },
    dial('feedback', 'Feedback', 0, 90, 35, pct),
    dial('wet', 'Wet/dry', 0, 100, 0, wet)] },
  { type: 'plate', label: 'Reverb', dials: [
    dial('predelay', 'Pre-delay', 0, 200, 0, v => v + ' ms'),
    dial('size', 'Size', 0, 100, 50, v => (0.5 + v / 100).toFixed(2) + '×'),
    dial('decay', 'Decay', 0, 100, 50, pct),
    dial('damping', 'Damping', 0, 100, 0, pct),
    dial('mix', 'Mix', 0, 100, 0, wet)] },
  // ASTRID's own (src/hacks-astrid/mod.js); the site has no modulation hacks yet.
  { type: 'flanger', label: 'Flanger', dials: [
    dial('rate', 'Rate', 0, 100, 26, fmtRate),
    dial('depth', 'Depth', 0, 100, 70, pct),
    dial('feedback', 'Feedback', -90, 90, 50, fbPct),
    dial('mix', 'Mix', 0, 100, 50, wet)] },
  { type: 'chorus', label: 'Chorus', dials: [
    dial('rate', 'Rate', 0, 100, 52, fmtRate),
    dial('depth', 'Depth', 0, 100, 50, pct),
    dial('spread', 'Spread', 0, 100, 70, pct),
    dial('mix', 'Mix', 0, 100, 40, wet)] },
  { type: 'phaser', label: 'Phaser', dials: [
    dial('rate', 'Rate', 0, 100, 39, fmtRate),
    dial('depth', 'Depth', 0, 100, 70, pct),
    { key: 'stages', label: 'Stages', min: 4, max: 8, value: 6, options: STAGES, format: v => v + ' stages' },
    dial('feedback', 'Feedback', 0, 90, 30, pct),
    dial('mix', 'Mix', 0, 100, 50, wet)] },
  { type: 'eq', label: 'EQ', note: 'Low shelf 150 Hz, high shelf 6 kHz.', dials: [
    dial('low_db', 'Low', -18, 18, 0, fmtDb),
    dial('mid_db', 'Mid', -18, 18, 0, fmtDb),
    dial('mid_hz', 'Mid at', 0, 100, 50, v => fmtHz(midHz(v))),
    dial('mid_q', 'Mid Q', 0, 100, 40, v => 'Q ' + eqQ(v).toFixed(1)),
    dial('high_db', 'High', -18, 18, 0, fmtDb)] },
  { type: 'drive', label: 'Drive', dials: [
    dial('drive_db', 'Drive', 0, 24, 0, v => v === 0 ? 'clean' : fmtDb(v)),
    dial('output_db', 'Output', -12, 12, 0, fmtDb),
    dial('mix', 'Mix', 0, 100, 100, wet)] },
  { type: 'compressor', label: 'Compressor', dials: [
    dial('threshold_db', 'Threshold', -60, 0, 0, fmtDb),
    dial('ratio', 'Ratio', 0, 100, 0, v => ratioOf(v).toFixed(1) + ':1'),
    dial('attack_ms', 'Attack', 1, 100, 10, v => v + ' ms'),
    dial('release_ms', 'Release', 10, 1000, 150, v => v + ' ms'),
    dial('makeup_db', 'Makeup', 0, 24, 0, fmtDb)] },
  { type: 'width', label: 'Width', note: 'A mono sound has no sides, so width leaves it as it is.', dials: [
    dial('width', 'Width', 0, 200, 100, pct),
    dial('balance', 'Balance', -100, 100, 0, v => v === 0 ? 'centre' : v < 0 ? 'L ' + (-v) : 'R ' + v)] },
];
/** Every type that loads (old files included). */
export const HACK_TYPES = HACK_DEFINITIONS.map(d => d.type);
/** What "Add a hack" offers: everything not hidden. */
export const HACK_MENU = HACK_DEFINITIONS.filter(d => !d.hidden);
export const hackDefinition = (type: HackType) => HACK_DEFINITIONS.find(d => d.type === type)!;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function dialValue(d: HackDial, raw: unknown) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return d.value;
  if (d.options) return d.options.reduce((best, [v]) => Math.abs(v - raw) < Math.abs(best - raw) ? v : best, d.options[0][0]);
  return Math.max(d.min, Math.min(d.max, Math.round(raw)));
}

/** A new hack at the site's starting dials, with an id not yet in the chain. */
export function createHack(type: HackType, chain: readonly HackSlot[] = []): HackSlot {
  const used = new Set(chain.map(h => h.id));
  let n = 1;
  while (used.has(`${type}-${n}`)) n++;
  return { id: `${type}-${n}`, type, bypass: false, dials: Object.fromEntries(hackDefinition(type).dials.map(d => [d.key, d.value])) };
}

/** Saved chains are optional. Absent or unreadable is the empty chain, which plays dry.
 * strict (file loading) rejects a bad chain instead of dropping parts of it. */
export function sanitizeHacks(raw: unknown, strict = false): HackSlot[] {
  if (raw === undefined || raw === null) return [];
  const fail = (msg: string): HackSlot[] => { if (strict) throw new Error(`Invalid configuration: ${msg}`); return []; };
  if (!Array.isArray(raw)) return fail('hacks must be a list.');
  // Over the cap: keep the first three (in stack order) and drop the rest, never refuse the file.
  const items = strict ? (raw as unknown[]).slice(0, MAX_HACKS) : raw as unknown[];
  const out: HackSlot[] = [];
  for (const item of items) {
    if (out.length >= MAX_HACKS) break;
    if (!record(item) || !HACK_TYPES.includes(item.type as HackType)) { if (strict) return fail('unknown hack.'); continue; }
    const type = item.type as HackType;
    const fresh = createHack(type, out);
    const id = typeof item.id === 'string' && ID.test(item.id) && !out.some(h => h.id === item.id) ? item.id : fresh.id;
    const dials = record(item.dials) ? item.dials : {};
    out.push({ id, type, bypass: item.bypass === true,
      dials: Object.fromEntries(hackDefinition(type).dials.map(d => [d.key, dialValue(d, dials[d.key])])) });
  }
  return out;
}

/** True when a saved chain holds more hacks than the stack keeps. */
export const hacksOverCap = (raw: unknown) => Array.isArray(raw) && raw.length > MAX_HACKS;

/** The chain with one hack moved from one place to another (indexes are clamped). Same array if nothing moves. */
export function moveHack<T>(chain: readonly T[], from: number, to: number): T[] {
  const last = chain.length - 1;
  const j = Math.max(0, Math.min(last, to));
  if (from < 0 || from > last || from === j) return chain as T[];
  const next = [...chain];
  const [item] = next.splice(from, 1);
  next.splice(j, 0, item);
  return next;
}

/** Room for another hack? */
export const canAddHack = (chain: readonly unknown[]) => chain.length < MAX_HACKS;

/** Dial positions to the params the site's DSP reads (stack.js paramsOf). */
export function hackParams(slot: HackSlot, tempo: number): HackParams {
  const def = hackDefinition(slot.type);
  const v = (key: string) => dialValue(def.dials.find(d => d.key === key)!, slot.dials[key]);
  switch (slot.type) {
    case 'lowpass': return { cutoff: v('cutoff'), cutoff_hz: hackCutoffHz(v('cutoff')), q: 0.7071067811865476 };
    case 'delay': {
      const beats = v('delay_beats');
      return { delay_beats: beats, delay_timing: NOTES.find(([b]) => b === beats)![1],
        delay_s: +delayS(beats, tempo).toFixed(4), feedback: v('feedback') / 100, wet: v('wet') / 100 };
    }
    case 'plate': return { predelay: v('predelay') / 1000, size: v('size') / 100, decay: v('decay') / 100, damping: v('damping') / 100, mix: v('mix') / 100 };
    case 'eq': return { low_db: v('low_db'), mid_db: v('mid_db'), mid_hz: midHz(v('mid_hz')), high_db: v('high_db'), low_hz: 150, high_hz: 6000, mid_q: eqQ(v('mid_q')) };
    case 'highpass': return { cutoff: v('cutoff'), cutoff_hz: hpHz(v('cutoff')), q: hpQ(v('q')) };
    case 'bandpass': return { centre_hz: bpHz(v('centre_hz')), q: bpQ(v('q')), mix: v('mix') / 100 };
    case 'drive': return { drive_db: v('drive_db'), output_db: v('output_db'), mix: v('mix') / 100 };
    case 'compressor': return { threshold_db: v('threshold_db'), ratio: ratioOf(v('ratio')), attack_ms: v('attack_ms'), release_ms: v('release_ms'), makeup_db: v('makeup_db') };
    case 'width': return { width: v('width') / 100, balance: v('balance') / 100 };
    case 'flanger': return { rate_hz: hackRateHz(v('rate')), depth: v('depth') / 100, feedback: v('feedback') / 100, mix: v('mix') / 100 };
    case 'chorus': return { rate_hz: hackRateHz(v('rate')), depth: v('depth') / 100, spread: v('spread') / 100, mix: v('mix') / 100 };
    case 'phaser': return { rate_hz: hackRateHz(v('rate')), depth: v('depth') / 100, stages: v('stages'), feedback: v('feedback') / 100, mix: v('mix') / 100 };
  }
}

export function hackWidgets(chain: readonly HackSlot[] | undefined, tempo: number): HackWidget[] {
  return sanitizeHacks(chain).map(slot => ({ id: slot.id, type: slot.type, version: 1, bypass: slot.bypass, params: hackParams(slot, tempo) }));
}

/** The chain as the site saves it (schema 2): the hacks, then the fixed limiter. */
export function hackChainDocument(chain: readonly HackSlot[] | undefined, tempo: number) {
  return { schema: 2 as const, chain: [...hackWidgets(chain, tempo),
    { id: 'limiter', type: 'limiter' as const, version: 1 as const, bypass: false, fixed: true, params: {} }] };
}

/** The worklet's code (about 50 KB) is a separate chunk, so pages don't load it before audio starts. */
let workletUrl: Promise<string> | null = null;
/** Fetch the worklet code ahead of time (e.g. once the page is idle). Safe to call any number of times. */
export function preloadHackWorklet(): Promise<string> {
  return workletUrl ??= import('./hacks-worklet-source.js').then(({ hacksWorkletSource }) =>
    URL.createObjectURL(new Blob([hacksWorkletSource], { type: 'application/javascript' })),
  (e) => { workletUrl = null; throw e; });
}
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
/** One AudioWorklet, built and attached the way the site's create/hacks/engine.js does it. */
export async function attachHackWorklet(context: BaseAudioContext, widgets: HackWidget[] = []): Promise<AudioWorkletNode> {
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('no worklet');
  let ready = loaded.get(context);
  if (!ready) { const url = preloadHackWorklet(); ready = url.then(u => context.audioWorklet.addModule(u)); loaded.set(context, ready); }
  await ready;
  // Inputs 0–7 are track hacks (unused here). Input 8 goes straight into the master chain.
  return new AudioWorkletNode(context, 'nc-hack-stack', {
    numberOfInputs: 9, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
    channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { widgets, immediate: false },
  });
}

export type HackStatus = 'dry' | 'loading' | 'on' | 'unavailable';
export const HACK_DRY_INPUT = 8;
type Attach = (context: BaseAudioContext, widgets: HackWidget[]) => Promise<AudioWorkletNode>;

/** master → (hacks → 0.8 → limiter) → output. With no hacks, or if the worklet
 * cannot start (older iOS), master connects straight to output: a wire, as before. */
export class HackOutput {
  private node: AudioWorkletNode | null = null;
  private loading: Promise<void> | null = null;
  private failed = false;
  private wet = false;
  private key = '';
  private wanted: HackWidget[] = [];
  private sent: HackWidget[] = [];
  constructor(private context: BaseAudioContext, private input: AudioNode, private output: AudioNode, private attach: Attach = attachHackWorklet) {
    input.connect(output);
  }
  get status(): HackStatus {
    if (!this.wanted.length) return 'dry';
    if (this.failed) return 'unavailable';
    return this.wet ? 'on' : 'loading';
  }
  /** Cheap when nothing changed, so callers may pass every settings update. */
  set(chain: readonly HackSlot[] | undefined, tempo: number) {
    const wanted = hackWidgets(chain, tempo);
    const key = JSON.stringify(wanted);
    if (key === this.key) return;
    this.key = key;
    this.wanted = wanted;
    if (!wanted.length) {
      this.route(false);
      // Empty the worklet's chain only after the dry crossfade has finished: changing it mid-fade would step the
      // wet signal that is still fading out.
      if (this.node && this.sent.length) {
        const clear = () => { if (!this.wanted.length && !this.sent.length) this.post({ op: 'chain', widgets: [], hold: false }); };
        if (this.fadeTimer && typeof setTimeout === 'function') setTimeout(clear, 80); else clear();
      }
      this.sent = [];
      return;
    }
    if (this.failed) return;
    if (this.node) { this.sync(); this.route(true); return; }
    if (this.loading) return;
    this.loading = this.attach(this.context, wanted).then(node => {
      this.node = node;
      this.sent = wanted;
      this.sync();
      this.route(this.wanted.length > 0);
    }, err => {
      console.warn('[NetComposer] Hacks worklet failed to load; hacks bypassed, playing dry.', err);
      this.failed = true; this.route(false);
    }).finally(() => { this.loading = null; });
  }
  /** After panic replaced the analyser. */
  setOutput(output: AudioNode) {
    this.output = output;
    this.route(this.wet, true);
  }
  /** Panic: drop reverb and delay tails. */
  clear() { if (this.node && this.sent.length) this.post({ op: 'clear' }); }
  private post(msg: Record<string, unknown>) { this.node?.port.postMessage(msg); }
  private sync() {
    const want = this.wanted, had = new Map(this.sent.map(w => [w.id, w]));
    if (!this.sent.length) { this.post({ op: 'chain', widgets: want, hold: false }); this.sent = want; return; }
    for (const w of want) if (!had.has(w.id) || had.get(w.id)!.type !== w.type) this.post({ op: 'add', widget: w });
    if (want.map(w => w.id).join('\n') !== this.sent.map(w => w.id).join('\n')) this.post({ op: 'order', ids: want.map(w => w.id) });
    for (const w of want) {
      const old = had.get(w.id);
      if (old && old.type === w.type && JSON.stringify(old) !== JSON.stringify(w)) this.post({ op: 'patch', id: w.id, params: w.params, bypass: w.bypass });
    }
    this.sent = want;
  }
  private route(wet: boolean, force = false) {
    wet = wet && !!this.node;
    if (wet === this.wet && !force) return;
    const was = this.wet;
    this.wet = wet;
    if (!force && this.crossfade(wet, was)) return;
    try { this.input.disconnect(); } catch { /* already disconnected */ }
    try { this.node?.disconnect(); } catch { /* already disconnected */ }
    if (wet && this.node) { this.input.connect(this.node, 0, HACK_DRY_INPUT); this.node.connect(this.output); }
    else this.input.connect(this.output);
  }
  /** Switching dry <-> wet by re-wiring mid-signal is a hard cut (the chain also changes the level): a click.
   * Fade the old path out and the new one in over ~10 ms instead, then leave the plain graph behind.
   * Returns false where the context cannot build gains (tests' fakes), which keeps the instant switch. */
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private crossfade(wet: boolean, was: boolean): boolean {
    const c = this.context as BaseAudioContext & { createGain?: () => GainNode };
    if (typeof c.createGain !== 'function' || !this.node || typeof c.currentTime !== 'number') return false;
    if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
    const t = c.currentTime + 256 / (c.sampleRate || 48000), fade = 0.012;
    const out = c.createGain(), into = c.createGain();
    into.gain.value = 0;                       // a fresh gain is 1 until its first event: keep the new path shut
    out.gain.setValueAtTime(1, t); out.gain.linearRampToValueAtTime(0, t + fade);
    into.gain.setValueAtTime(0, t); into.gain.linearRampToValueAtTime(1, t + fade);
    try { this.input.disconnect(); } catch { /* already disconnected */ }
    try { this.node.disconnect(); } catch { /* already disconnected */ }
    // Old path through `out`, new path through `into`, both summed at the output during the fade.
    const path = (toWet: boolean, g: GainNode) => {
      if (toWet) { this.input.connect(this.node!, 0, HACK_DRY_INPUT); this.node!.connect(g); }
      else this.input.connect(g);
      g.connect(this.output);
    };
    path(was, out); path(wet, into);
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      if (this.wet !== wet) return;            // a newer switch owns the graph now
      this.route(wet, true);                   // plain wiring again (no extra gains left in the path)
      try { out.disconnect(); into.disconnect(); } catch { /* gone */ }
    }, (fade + 0.03) * 1000 + Math.max(0, t - c.currentTime) * 1000);
    return true;
  }
}
