// nc-fx panel: each effect as the nc-ui kit's FX card, so it looks the same in every app (ASTRID, Bass, Rhythm, the
// Studio Mix). Plain DOM, no framework; lazy-loaded by createFx().mount() or imported from '@netcomposer/nc-fx/ui'.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// The markup is the kit's own (nc-ui north-star, src/primitives/controls.js renderControl({ type: 'fx' }),
// switch.js createSwitch, the slider / select / note fields), with its class names and ARIA, so the live nc-ui
// stylesheet (/nc-ui/nc-ui.css) styles it; nc-fx never imports nc-ui. ./ui-style.js only lays out what the kit has no
// class for (the Add row, the move and remove buttons, the limiter line), with nc-ui custom properties only.
// With `slots` (ASTRID's chain model) the panel is ASTRID's Hacks panel: "Add a hack", and per card move up / down and
// remove; without, the fixed chain's three cards.
//
// Motion: a slider the host moves (automation, modulation, a loaded state) is marked data-modulated and never
// animates; the user's own touch clears the mark.
import { CATALOG_MENU, catalogEntry, formatDial } from './catalog.js';
import { FX_UI_CSS } from './ui-style.js';

var STYLE_ID = 'nc-fx-ui-style';
var uid = 0;
var SVG = 'http://www.w3.org/2000/svg';

function injectStyle(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  var s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = FX_UI_CSS;
  (doc.head || doc.documentElement).appendChild(s);
}
function probe(doc) {
  var i = doc.createElement('i');
  i.className = 'nc-token-probe';
  i.setAttribute('data-nc-probe', '');
  return i;
}
/** ASTRID's outline triangles (hacks-panel.tsx TRI_UP / TRI_DN), stroked in currentColor. */
function triangle(doc, up) {
  var svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 18');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  var p = doc.createElementNS(SVG, 'path');
  p.setAttribute('d', up ? 'M10 1.5 18.5 16.5H1.5Z' : 'M10 16.5 1.5 1.5h17Z');
  svg.appendChild(p);
  return svg;
}
/** The kit's switch (switch.js createSwitch): a button role=switch named by the card title, text On / Off. */
function kitSwitch(doc, labelledBy) {
  var el = doc.createElement('button');
  el.type = 'button';
  el.className = 'nc-ui-switch';
  el.setAttribute('role', 'switch');
  el.setAttribute('aria-labelledby', labelledBy);
  el.setAttribute('data-nc-fx-switch', '');
  var text = doc.createElement('span');
  text.className = 'nc-ui-switch-text';
  text.setAttribute('aria-hidden', 'true');
  var on = doc.createElement('span'), off = doc.createElement('span');
  on.setAttribute('data-nc-on', ''); on.textContent = 'On';
  off.setAttribute('data-nc-off', ''); off.textContent = 'Off';
  text.appendChild(on); text.appendChild(off);
  el.appendChild(text);
  return el;
}

/**
 * Render the panel into `el`.
 * @param {HTMLElement} el
 * @param {{fx: object, injectCss?: boolean, effects?: string[]}} opts
 * @returns {{update(): void, destroy(): void, root: HTMLElement}}
 */
export function mountFxPanel(el, opts) {
  var fx = opts.fx;
  var doc = el.ownerDocument;
  if (opts.injectCss !== false) injectStyle(doc);
  var slots = typeof fx.slots === 'number';
  var only = opts.effects || null;
  var n = ++uid;
  var root = doc.createElement('div');
  // The kit's inset section (ASTRID's Hacks panel inside its module): it bleeds to the module's edges and pads itself
  // at every breakpoint; ui-style.js gives it stack-1 of the module shading.
  root.className = 'nc-fx nc-section';
  root.setAttribute('data-nc-inset', 'true');
  root.setAttribute('data-nc-fx', '');
  root.setAttribute('data-testid', 'nc-fx-panel');
  if (slots) root.setAttribute('data-nc-fx-slots', '');
  var addSel = null, cap = null, stack = doc.createElement('div'), limiter = null;
  stack.className = 'nc-fx-stack';
  var cards = [];    // {ref, type, card, sw, fields: [{dial, input, out, row}]}
  var touching = false;

  if (slots) {
    var addRow = doc.createElement('div');
    addRow.className = 'nc-fx-add';
    addSel = doc.createElement('select');
    addSel.className = 'nc-select';
    addSel.setAttribute('aria-label', 'Add a hack');
    addSel.setAttribute('data-testid', 'nc-fx-add');
    var first = doc.createElement('option');
    first.value = ''; first.textContent = 'Add a hack';
    addSel.appendChild(first);
    CATALOG_MENU.forEach(function (t) {
      var op = doc.createElement('option');
      op.value = t; op.textContent = catalogEntry(t).label;
      addSel.appendChild(op);
    });
    addSel.addEventListener('change', function () {
      var t = addSel.value;
      addSel.value = '';
      if (!t) return;
      touching = true;
      var id = fx.addEffect(t);
      touching = false;
      build();
      var c = cardOf(id);
      if (c) c.sw.focus();
    });
    cap = doc.createElement('span');
    cap.className = 'nc-readout';
    cap.setAttribute('data-testid', 'nc-fx-cap');
    addRow.appendChild(addSel);
    addRow.appendChild(cap);
    root.appendChild(addRow);
  }
  root.appendChild(stack);
  if (slots) {
    limiter = doc.createElement('p');
    limiter.className = 'nc-note nc-fx-limiter';
    limiter.setAttribute('data-testid', 'nc-fx-limiter');
    root.appendChild(limiter);
  }

  function chainNow() {
    if (slots) return fx.getChain();
    return fx.getState().chain.filter(function (s) { return !only || only.indexOf(s.type) >= 0; })
      .map(function (s) { return { id: s.type, type: s.type, name: catalogEntry(s.type).label }; });
  }
  function cardOf(ref) { for (var i = 0; i < cards.length; i++) if (cards[i].ref === ref) return cards[i]; return null; }

  function field(c, d) {
    var id = 'nc-fx-' + n + '-' + c.ref + '-' + d.key;
    var row = doc.createElement('div');
    row.className = 'nc-field';
    row.setAttribute('data-nc-row', '');
    row.setAttribute('data-nc-id', id);
    var label = doc.createElement('label');
    label.className = 'nc-label';
    label.htmlFor = id;
    label.textContent = d.label;
    var out = doc.createElement('output');
    out.className = 'nc-readout';
    out.setAttribute('data-nc-readout', '');
    out.htmlFor = id;
    var input;
    if (d.options) {
      input = doc.createElement('select');
      input.className = 'nc-select';
      d.options.forEach(function (op) {
        var o = doc.createElement('option');
        o.value = String(op.value);
        o.textContent = op.label;
        input.appendChild(o);
      });
      row.setAttribute('data-nc-fx-select', ''); // laid out as ASTRID's: label and value, then the select (ui-style.js)
      row.appendChild(label); row.appendChild(out); row.appendChild(input);
    } else {
      row.setAttribute('data-nc-slider', '');
      input = doc.createElement('input');
      input.type = 'range';
      input.className = 'nc-range';
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step || 1);
      input.title = 'Double-click to reset';
      input.addEventListener('dblclick', function () { touch(c, d, d.default); show(c, fieldOf(c, d.key), false); });
      row.appendChild(label); row.appendChild(input); row.appendChild(out);
    }
    input.id = id;
    input.setAttribute('data-nc-id', id);
    input.setAttribute('data-testid', 'nc-fx-' + c.ref + '-' + d.key);
    var onInput = function () {
      input.removeAttribute('data-modulated');
      touch(c, d, +input.value);
    };
    input.addEventListener('input', onInput);
    input.addEventListener('change', onInput);
    input.addEventListener('pointerdown', function () { input.removeAttribute('data-modulated'); });
    row.appendChild(probe(doc));
    return { dial: d, input: input, out: out, row: row };
  }
  function touch(c, d, v) {
    touching = true;
    fx.setParam(c.ref, d.key, v);
    touching = false;
  }
  function fieldOf(c, key) { for (var i = 0; i < c.fields.length; i++) if (c.fields[i].dial.key === key) return c.fields[i]; return null; }

  function makeCard(item, at, count) {
    var e = catalogEntry(item.type);
    var card = doc.createElement('div');
    var cid = 'nc-fx-' + n + '-' + item.id;
    card.className = 'nc-ui-fx';
    card.setAttribute('data-nc-id', cid);
    // Module shading (nc-ui docs/design-rules.md): the panel is stack-1, its cards stack-2, -3, then -4 for the third
    // and deeper, by position (not type), as ASTRID's VCO -> VCF -> VCA gradation but top to bottom. The kit's
    // .nc-ui-fx[data-nc-depth] rules set the background, text-sub, divider and slider track for each depth.
    card.setAttribute('data-nc-depth', String(Math.min(4, 2 + at)));
    card.setAttribute('data-testid', 'nc-fx-' + item.id);
    card.setAttribute('data-nc-fx-type', item.type);
    var c = { ref: item.id, type: item.type, card: card, sw: null, fields: [] };
    var head = doc.createElement('div');
    head.className = 'nc-ui-fx-hd';
    var name = doc.createElement('h3');
    name.className = 'nc-ui-fx-name';
    name.id = cid + '-name';
    name.textContent = item.name;
    if (slots) {
      var mv = doc.createElement('span');
      mv.className = 'nc-fx-move';
      [true, false].forEach(function (up) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'nc-fx-move-btn';
        b.setAttribute('aria-label', 'Move ' + item.name + (up ? ' up' : ' down'));
        b.setAttribute('data-testid', 'nc-fx-' + (up ? 'up' : 'down') + '-' + item.id);
        b.disabled = up ? at === 0 : at === count - 1;
        b.appendChild(triangle(doc, up));
        b.addEventListener('click', function () {
          touching = true;
          fx.moveEffect(item.id, at + (up ? -1 : 1));
          touching = false;
          build();
          var moved = cardOf(item.id);
          if (moved) { var again = moved.card.querySelector('[data-testid="nc-fx-' + (up ? 'up' : 'down') + '-' + item.id + '"]'); (again && !again.disabled ? again : moved.sw).focus(); }
        });
        mv.appendChild(b);
      });
      head.appendChild(mv);
    }
    head.appendChild(name);
    var sw = kitSwitch(doc, name.id);
    sw.setAttribute('data-testid', 'nc-fx-on-' + item.id);
    sw.addEventListener('click', function () {
      touching = true;
      fx.setParam(item.id, 'bypass', !fx.getParam(item.id, 'bypass'));
      touching = false;
      showHead(c);
    });
    c.sw = sw;
    head.appendChild(sw);
    if (slots) {
      var rm = doc.createElement('button');
      rm.type = 'button';
      rm.className = 'nc-fx-remove';
      rm.setAttribute('aria-label', 'Remove ' + item.name);
      rm.setAttribute('data-testid', 'nc-fx-remove-' + item.id);
      rm.textContent = '×';
      rm.addEventListener('click', function () {
        touching = true;
        fx.removeEffect(item.id);
        touching = false;
        build();
        var next = cards[Math.min(at, cards.length - 1)];
        (next ? next.sw : addSel).focus();
      });
      head.appendChild(rm);
    }
    card.appendChild(head);
    var more = null;
    e.dials.forEach(function (d) {
      var f = field(c, d);
      c.fields.push(f);
      if (d.more) {
        if (!more) {
          more = doc.createElement('details');
          more.className = 'nc-ui-more';
          var sm = doc.createElement('summary');
          sm.textContent = 'More';
          more.appendChild(sm);
        }
        more.appendChild(f.row);
      } else card.appendChild(f.row);
    });
    if (e.note) {
      var note = doc.createElement('p');
      note.className = 'nc-note';
      note.setAttribute('data-nc-row', '');
      note.textContent = e.note;
      note.appendChild(probe(doc));
      card.appendChild(note);
    }
    if (more) card.appendChild(more);
    card.appendChild(probe(doc));
    return c;
  }

  function build() {
    var open = {};
    cards.forEach(function (c) { var m = c.card.querySelector('details'); if (m && m.open) open[c.ref] = true; });
    while (stack.firstChild) stack.removeChild(stack.firstChild);
    cards = [];
    var list = chainNow();
    list.forEach(function (item, at) {
      var c = makeCard(item, at, list.length);
      if (open[c.ref]) c.card.querySelector('details').open = true;
      cards.push(c);
      stack.appendChild(c.card);
    });
    update(false);
  }

  function show(c, f, fromHost) {
    var d = f.dial, v = fx.getParam(c.ref, d.key), w = d.stepWhen;
    if (v === undefined) return;
    if (w) { // drive_db: 0.1 dB steps while curve is Acid
      var st = d.step;
      for (var j = 0; j < w.length; j++) if (fx.getParam(c.ref, w[j].key) === w[j].value) st = w[j].step;
      f.input.step = String(st);
    }
    if (fromHost && f.input.value !== String(v)) f.input.setAttribute('data-modulated', '');
    if (f.input.value !== String(v)) f.input.value = String(v);
    var bpm = fx.getTempo ? fx.getTempo() : 120;
    var text = formatDial(d, v, bpm);
    if (d.exact) { if (v > 0) f.row.setAttribute('data-free', ''); else f.row.removeAttribute('data-free'); } // Free time on
    if (d.overriddenBy) { // Timing while Free time is on: dimmed, readout says what plays instead
      if (fx.getParam(c.ref, d.overriddenBy) > 0) { f.row.setAttribute('data-overridden', ''); text = 'free time'; }
      else f.row.removeAttribute('data-overridden');
    }
    // An option dial whose readout is just its option's label (Curve, Mode) shows it once, in the select.
    f.out.textContent = d.format.fmt === 'option' ? '' : text;
    if (!d.options) f.input.setAttribute('aria-valuetext', text);
  }
  function showHead(c) {
    var on = !fx.getParam(c.ref, 'bypass');
    c.sw.setAttribute('aria-checked', on ? 'true' : 'false');
    if (on) c.card.removeAttribute('data-nc-dim'); else c.card.setAttribute('data-nc-dim', 'true');
  }
  function showChrome() {
    if (!slots) return;
    var count = fx.getChain().length, full = count >= fx.slots;
    addSel.disabled = full;
    if (full) addSel.title = fx.slots + ' hacks is the limit'; else addSel.removeAttribute('title');
    cap.textContent = full ? count + ' of ' + fx.slots : '';
    var lim = fx.limiter;
    limiter.textContent = count === 0 || lim === 'off' || !lim ? '' : lim === 'lookahead' ? 'Limiter −1 dB, fixed last' : 'Soft limiter, fixed last';
    limiter.hidden = limiter.textContent === '';
  }
  function update(fromHost) {
    cards.forEach(function (c) { c.fields.forEach(function (f) { show(c, f, fromHost); }); showHead(c); });
    showChrome();
  }
  var off = fx.onChange(function (ch) {
    var fromHost = !touching;
    if (!ch || ch.effect === null || ch.key === 'chain') {
      // A whole-state, tempo or chain change: rebuild when the chain changed under us, else refresh.
      var ids = chainNow().map(function (x) { return x.id + ':' + x.type; }).join();
      if (ids !== cards.map(function (c) { return c.ref + ':' + c.type; }).join()) { if (!touching) build(); }
      else update(fromHost);
      return;
    }
    var c = cardOf(ch.effect);
    if (!c) return;
    if (ch.key === 'bypass') { showHead(c); return; }
    c.fields.forEach(function (f) { if (f.dial.key === ch.key || f.dial.stepWhen || f.dial.overriddenBy === ch.key) show(c, f, fromHost); });
  });
  build();
  el.appendChild(root);

  return {
    root: root,
    update: function () { update(true); },
    destroy: function () { off(); if (root.parentNode) root.parentNode.removeChild(root); }
  };
}
