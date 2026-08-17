/* mana.js — render Scryfall's {W}{2/U}{T} notation using the bundled symbol art
   in img/mana/. Anything without a matching file falls back to the raw text. */
(function (global) {
  'use strict';

  var BASE = 'img/mana/';

  // Filenames present in img/mana (regenerate if you add art there).
  var FILES = [
    '+0', '+1', '+2', '+3', '+4', '+5', '+6', '+7', '+8', '+9', '-1', '-2', '-3', '-4', '-5',
    '-6', '-7', '-8', '-9', '0', '1', '10', '11', '12', '13', '14', '15', '16', '17', '18',
    '19', '2', '20', '2b', '2g', '2purple', '2r', '2u', '2w', '3', '4', '5', '6', '7', '8',
    '9', 'a', 'alchemy', 'artistbrush', 'b', 'bg', 'bgp', 'bp', 'br', 'brp', 'c', 'cb', 'cg',
    'chaos', 'cr', 'cu', 'cw', 'e', 'g', 'gp', 'gu', 'gup', 'gw', 'gwp', 'half', 'inf',
    'oldtap', 'originaltap', 'p', 'planeswalker', 'purple', 'purpleb', 'purpleg', 'purplep',
    'purpler', 'purpleu', 'purplew', 'r', 'rg', 'rgp', 'rp', 'rw', 'rwp', 's', 'snow', 'star',
    't', 'tk', 'u', 'ub', 'ubp', 'untap', 'up', 'ur', 'urp', 'w', 'wb', 'wbp', 'wp', 'wu',
    'wup', 'x', 'y', 'z'
  ];

  var HAS = {};
  FILES.forEach(function (f) { HAS[f] = true; });

  // Tokens whose filename is not just the lowercased, slash-stripped token.
  var ALIAS = {
    'q': 'untap',          // untap symbol
    'pw': 'planeswalker',
    'chaos': 'chaos',
    '∞': 'inf',
    '½': 'half',
    'hw': 'half',
    'hr': 'half',
    'tk': 'tk',
    'e': 'e',
    'a': 'a'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** "{2/W}" -> "2w", "{W/P}" -> "wp", "{Q}" -> "untap" */
  function fileFor(token) {
    var raw = String(token).trim();
    var key = raw.toLowerCase().replace(/[\/\s]/g, '');
    if (ALIAS[key] && HAS[ALIAS[key]]) { return ALIAS[key]; }
    if (HAS[key]) { return key; }
    // Hybrid halves can arrive in either order: {U/W} is the same as {W/U}.
    if (key.length === 2) {
      var flipped = key.charAt(1) + key.charAt(0);
      if (HAS[flipped]) { return flipped; }
    }
    return null;
  }

  function symbolHtml(token) {
    var file = fileFor(token);
    if (!file) { return null; }
    var label = '{' + token + '}';
    return '<img class="ms" src="' + BASE + encodeURIComponent(file) + '.svg" ' +
           'alt="' + esc(label) + '" title="' + esc(label) + '" loading="lazy" decoding="async">';
  }

  /**
   * Escape `text` and swap every recognised {symbol} for its art.
   * Returns trusted HTML — callers must not escape it again.
   */
  function render(text) {
    if (text == null || text === '') { return ''; }
    var str = String(text);
    var re = /\{([^}]{1,10})\}/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(str)) !== null) {
      out += esc(str.slice(last, m.index));
      out += symbolHtml(m[1]) || esc(m[0]);
      last = m.index + m[0].length;
    }
    return out + esc(str.slice(last));
  }

  /** True when the text contains at least one symbol we can draw. */
  function hasSymbols(text) {
    var re = /\{([^}]{1,10})\}/g;
    var m;
    while ((m = re.exec(String(text || ''))) !== null) {
      if (fileFor(m[1])) { return true; }
    }
    return false;
  }

  global.MTGMana = { render: render, hasSymbols: hasSymbols, fileFor: fileFor, BASE: BASE };
})(window);
