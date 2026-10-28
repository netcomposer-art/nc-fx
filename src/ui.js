// nc-fx panel: one section per effect (On/Off, then a slider or select per dial with a readout).
// Plain DOM, no framework; lazy-loaded by createFx().mount() or imported from '@netcomposer/nc-fx/ui'.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// Looks: nc-ui tokens only (see ./ui-style.js). Motion: a slider the host moves (automation, modulation,
// a loaded state) is marked data-modulated and never animates; the user's own touch clears the mark.
import { EFFECTS } from './params.js';
import { FX_UI_CSS } from './ui-style.js';

var STYLE_ID = 'nc-fx-ui-style';
var uid = 0;

function injectStyle(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  var s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = FX_UI_CSS;
  (doc.head || doc.documentElement).appendChild(s);
}

/**
 * Render the panel into `el`.
 * @param {HTMLElement} el
 * @param {{fx: import('./index').FxCore, injectCss?: boolean, effects?: string[]}} opts
 * @returns {{update(): void, destroy(): void, root: HTMLElement}}
 */
export function mountFxPanel(el, opts) {
  var fx = opts.fx;
  var doc = el.ownerDocument;
  if (opts.injectCss !== false) injectStyle(doc);
  var only = opts.effects || null;
  var root = doc.createElement('div');
  root.className = 'nc-fx';
  root.setAttribute('data-testid', 'nc-fx-panel');
  var controls = []; // {type, key, input, out, sec, def}
  var heads = {};    // type -> {sec, btn}
  var touching = false;
  var n = ++uid;

  EFFECTS.forEach(function (e) {
    if (only && only.indexOf(e.type) < 0) return;
    var sec = doc.createElement('section');
    sec.className = 'nc-fx-sec';
    sec.setAttribute('data-testid', 'nc-fx-' + e.type);
    var head = doc.createElement('div');
    head.className = 'nc-fx-head';
    var h = doc.createElement('h3');
    h.className = 'nc-fx-title';
    h.textContent = e.label;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'nc-fx-on';
    btn.setAttribute('aria-label', e.label + ' on');
    btn.addEventListener('click', function () {
      touching = true;
      fx.setParam(e.type, 'bypass', !fx.getParam(e.type, 'bypass'));
      touching = false;
    });
    head.appendChild(h);
    head.appendChild(btn);
    sec.appendChild(head);
    heads[e.type] = { sec: sec, btn: btn };
    e.dials.forEach(function (d) {
      var row = doc.createElement('div');
      row.className = 'nc-fx-row';
      var id = 'nc-fx-' + n + '-' + e.type + '-' + d.key;
      var label = doc.createElement('label');
      label.htmlFor = id;
      label.textContent = d.label;
      var input;
      if (d.options) {
        input = doc.createElement('select');
        d.options.forEach(function (op) {
          var o = doc.createElement('option');
          o.value = String(op.value);
          o.textContent = op.label;
          input.appendChild(o);
        });
      } else {
        input = doc.createElement('input');
        input.type = 'range';
        input.min = String(d.min);
        input.max = String(d.max);
        input.step = String(d.step || 1);
      }
      input.id = id;
      input.setAttribute('data-testid', 'nc-fx-' + e.type + '-' + d.key);
      var out = doc.createElement('output');
      out.htmlFor = id;
      var onInput = function () {
        input.removeAttribute('data-modulated');
        touching = true;
        fx.setParam(e.type, d.key, +input.value);
        touching = false;
      };
      input.addEventListener('input', onInput);
      input.addEventListener('change', onInput);
      input.addEventListener('pointerdown', function () { input.removeAttribute('data-modulated'); });
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(out);
      sec.appendChild(row);
      controls.push({ type: e.type, key: d.key, input: input, out: out, def: d });
    });
    root.appendChild(sec);
  });

  function show(c, fromHost) {
    var v = fx.getParam(c.type, c.key), w = c.def.stepWhen;
    if (w) { // drive_db: 0.1 dB steps while curve is Acid
      var st = c.def.step;
      for (var j = 0; j < w.length; j++) if (fx.getParam(c.type, w[j].key) === w[j].value) st = w[j].step;
      c.input.step = String(st);
    }
    if (fromHost && c.input.value !== String(v)) c.input.setAttribute('data-modulated', '');
    if (c.input.value !== String(v)) c.input.value = String(v);
    c.out.textContent = c.def.format(v, fx.getTempo ? fx.getTempo() : 120);
  }
  function showHead(type) {
    var hd = heads[type];
    if (!hd) return;
    var on = !fx.getParam(type, 'bypass');
    hd.btn.textContent = on ? 'On' : 'Off';
    hd.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) hd.sec.removeAttribute('data-bypass'); else hd.sec.setAttribute('data-bypass', '');
  }
  function update(fromHost) {
    controls.forEach(function (c) { show(c, fromHost); });
    Object.keys(heads).forEach(showHead);
  }
  var off = fx.onChange(function (ch) {
    var fromHost = !touching;
    if (!ch || ch.effect === null) { update(fromHost); return; }
    if (ch.key === 'bypass') { showHead(ch.effect); return; }
    controls.forEach(function (c) { if (c.type === ch.effect && (c.key === ch.key || c.def.stepWhen)) show(c, fromHost); });
  });
  update(false);
  el.appendChild(root);

  return {
    root: root,
    update: function () { update(true); },
    destroy: function () { off(); if (root.parentNode) root.parentNode.removeChild(root); }
  };
}
