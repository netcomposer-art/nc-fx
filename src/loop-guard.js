// nc-fx plugins, main thread: the loop guard. Before a plugin's DSP file runs, every `while (...)`, `do ... while
// (...)` and `for (...; ...; ...)` in it gets one check on each turn: `while (__ncFxLoop() && (cond))`. In the worklet
// (src/plugin-host.js) that check counts turns and, every 4096, looks at the clock: a plugin call (create, process,
// set, reset) that keeps looping past its time budget throws there, and the plugin's unit stops calling it (error
// PERR_HANG), so a plugin stuck in an infinite loop is bypassed and the rest of the audio plays on. Without it, an
// infinite loop on the audio thread freezes the whole AudioContext, and the page can't even close it.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
//
// A small JavaScript scanner, not a parser: it skips comments, strings, template literals (with ${} nesting) and
// regular expression literals, finds the keywords `while` and `for` (not after a `.`), and wraps the loop's condition.
// It only inserts text, on the same lines, so line and column numbers in errors stay close. `for (... in ...)` and
// `for (... of ...)` are left alone: they end with their object or array (a generator's own loops are checked).
// What it can't see: a hang that isn't a loop (a regular expression that backtracks forever, a huge built-in call).
// The host's watchdog (watchAudioStall, src/watchdog.js) is the net for those.

/** The global the guarded code calls once per loop turn (defined in the worklet by src/plugin-host.js). */
export var LOOP_GUARD = '__ncFxLoop';

var REGEX_AFTER = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
var ID_START = /[A-Za-z_$\u0080-\uffff]/;
var ID_PART = /[A-Za-z0-9_$\u0080-\uffff]/;

/** The source's tokens that matter here: { t: 'name'|'num'|'str'|'tpl'|'re'|'p', v, s, e } (start, end offsets). */
function scan(src) {
  var toks = [], i = 0, n = src.length, braces = [], c, s;
  function prevAllowsRegex() {
    var p = toks.length ? toks[toks.length - 1] : null;
    if (!p) return true;
    if (p.t === 'name') return REGEX_AFTER.test(p.v);
    if (p.t === 'num' || p.t === 'str' || p.t === 'tpl' || p.t === 're') return false;
    return p.v !== ')' && p.v !== ']';
  }
  // A template's text from i (just after ` or a ${...}'s closing }), to its end or its next ${.
  function template() {
    var start = i - 1;
    while (i < n) {
      c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; toks.push({ t: 'tpl', v: '', s: start, e: i }); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; braces.push('tpl'); toks.push({ t: 'tpl', v: '', s: start, e: i }); return; }
      i++;
    }
    toks.push({ t: 'tpl', v: '', s: start, e: n });
  }
  while (i < n) {
    c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff' || c === '\u2028' || c === '\u2029') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { var end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    s = i;
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      toks.push({ t: 'str', v: '', s: s, e: i });
      continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/' && prevAllowsRegex()) {
      i++;
      var cls = false;
      while (i < n) {
        c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') break;
        if (cls) { if (c === ']') cls = false; }
        else if (c === '[') cls = true;
        else if (c === '/') { i++; break; }
        i++;
      }
      while (i < n && ID_PART.test(src[i])) i++;
      toks.push({ t: 're', v: '', s: s, e: i });
      continue;
    }
    if (ID_START.test(c) || c === '\\') {
      i++;
      while (i < n && (ID_PART.test(src[i]) || src[i] === '\\')) i++;
      toks.push({ t: 'name', v: src.slice(s, i), s: s, e: i });
      continue;
    }
    if (c === '#' && i + 1 < n && ID_START.test(src[i + 1])) {
      i += 2;
      while (i < n && ID_PART.test(src[i])) i++;
      toks.push({ t: 'name', v: src.slice(s, i), s: s, e: i });
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      i++;
      while (i < n && /[0-9A-Za-z_.]/.test(src[i])) {
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-') && !/^0[xX]/.test(src.slice(s, i))) i++;
        i++;
      }
      toks.push({ t: 'num', v: '', s: s, e: i });
      continue;
    }
    if (c === '{') { braces.push('{'); }
    else if (c === '}') {
      var top = braces.pop();
      if (top === 'tpl') { i++; template(); continue; }
    }
    // Punctuation: '?.' and '...' kept whole (a `.` before a name means a property, not a keyword).
    if (c === '?' && src[i + 1] === '.' && !(src[i + 2] >= '0' && src[i + 2] <= '9')) { i += 2; toks.push({ t: 'p', v: '?.', s: s, e: i }); continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { i += 3; toks.push({ t: 'p', v: '...', s: s, e: i }); continue; }
    i++;
    toks.push({ t: 'p', v: c, s: s, e: i });
  }
  return toks;
}

/** The index of the ')' closing the '(' at token k, or -1. */
function closing(toks, k) {
  var depth = 0;
  for (var j = k; j < toks.length; j++) {
    var v = toks[j].t === 'p' ? toks[j].v : '';
    if (v === '(' || v === '[' || v === '{') depth++;
    else if (v === ')' || v === ']' || v === '}') { depth--; if (depth === 0) return v === ')' ? j : -1; }
  }
  return -1;
}

/**
 * The source with a loop guard on every while, do-while and for(;;) loop's condition. Only inserts text; never
 * throws (source it can't follow comes back with the loops it could find guarded).
 * @param {string} src
 * @returns {string}
 */
export function guardLoops(src) {
  var text = String(src), toks = scan(text), ins = [], call = LOOP_GUARD + '()';
  for (var k = 0; k < toks.length; k++) {
    var tk = toks[k];
    if (tk.t !== 'name' || (tk.v !== 'while' && tk.v !== 'for')) continue;
    var before = k > 0 ? toks[k - 1] : null;
    if (before && before.t === 'p' && (before.v === '.' || before.v === '?.')) continue;
    var open = k + 1;
    if (tk.v === 'for' && toks[open] && toks[open].t === 'name' && toks[open].v === 'await') continue;
    if (!toks[open] || toks[open].t !== 'p' || toks[open].v !== '(') continue;
    var close = closing(toks, open);
    if (close < 0) continue;
    if (tk.v === 'while') {
      if (close === open + 1) continue; // while () is a syntax error: leave it to say so
      ins.push([toks[open].e, call + ' && ('], [toks[close].s, ')']);
      continue;
    }
    // for: the condition is between the header's two top-level semicolons.
    var semis = [], depth = 0;
    for (var j = open + 1; j < close; j++) {
      var v = toks[j].t === 'p' ? toks[j].v : '';
      if (v === '(' || v === '[' || v === '{') depth++;
      else if (v === ')' || v === ']' || v === '}') depth--;
      else if (v === ';' && depth === 0) semis.push(j);
    }
    if (semis.length !== 2) continue; // for-in / for-of
    if (semis[1] === semis[0] + 1) ins.push([toks[semis[0]].e, ' ' + call]);
    else ins.push([toks[semis[0]].e, ' ' + call + ' && ('], [toks[semis[1]].s, ')']);
  }
  if (!ins.length) return text;
  ins.sort(function (a, b) { return a[0] - b[0]; });
  var out = '', at = 0;
  for (var q = 0; q < ins.length; q++) { out += text.slice(at, ins[q][0]) + ins[q][1]; at = ins[q][0]; }
  return out + text.slice(at);
}
