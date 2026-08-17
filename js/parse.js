/* parse.js — decklist text -> normalised entries.
   Handles the formats the popular deckbuilders export. */
(function (global) {
  'use strict';

  // Section headers seen in Moxfield / Archidekt / MTGO / Arena exports.
  var SECTION_RE = /^(commander|companion|sideboard|maybeboard|deck|mainboard|main deck|creatures?|lands?|instants?|sorceries|artifacts?|enchantments?|planeswalkers?|battles?|other)\b[:\s]*(\(\d+\))?$/i;

  // 3x Lightning Bolt (2X2) 117 *F* #tag
  var LINE_RE = /^\s*(?:(\d+)\s*[xX]?\s+)?(.+?)\s*$/;

  function stripAnnotations(name) {
    return name
      // Moxfield / Archidekt flags: *CMDR* *F* *E* — removed first so the set
      // code below is genuinely at the end of the line.
      .replace(/\s\*[^*]*\*/g, '')
      // trailing #category tags
      .replace(/\s#\S+/g, '')
      // Archidekt "[Category{noDeck}]" style trailing brackets
      .replace(/\s\[[^\]]*\{[^\]]*\]\s*$/, '')
      // set code + collector number: (LTC) 285  /  [2X2] 117
      .replace(/\s[([][A-Za-z0-9_]{2,6}[)\]](\s+[A-Za-z0-9\-★]+)?\s*$/, '')
      .trim();
  }

  /** Split "Front // Back" and keep only the front face for lookup. */
  function frontFace(name) {
    var i = name.indexOf(' // ');
    return i === -1 ? name : name.slice(0, i).trim();
  }

  /**
   * @param {string} text raw pasted decklist
   * @returns {{entries: Array, errors: Array<string>}}
   *   entry = { qty, name, section, isCommander }
   */
  function parseDecklist(text) {
    var lines = String(text || '').split(/\r?\n/);
    var entries = [];
    var errors = [];
    var section = 'deck';
    var byName = {};

    lines.forEach(function (raw, idx) {
      var line = raw.trim();
      if (!line) { return; }
      if (line.charAt(0) === '#' || line.slice(0, 2) === '//') { return; }

      var header = line.replace(/[:\s]*\(\d+\)\s*$/, '').replace(/:$/, '').trim();
      if (SECTION_RE.test(header)) {
        var h = header.toLowerCase();
        if (h === 'commander' || h === 'companion') { section = 'commander'; }
        else if (h === 'sideboard' || h === 'maybeboard') { section = 'sideboard'; }
        else { section = 'deck'; }
        return;
      }

      var m = LINE_RE.exec(line);
      if (!m) { errors.push('Line ' + (idx + 1) + ': could not read "' + line + '"'); return; }

      var qty = m[1] ? parseInt(m[1], 10) : 1;
      var rest = m[2];
      var flaggedCommander = /\*CMDR\*/i.test(rest) || /\bcommander\b\s*$/i.test(rest);
      var name = frontFace(stripAnnotations(rest));

      if (!name || /^\d+$/.test(name)) {
        errors.push('Line ' + (idx + 1) + ': no card name in "' + line + '"');
        return;
      }

      var key = name.toLowerCase();
      if (byName[key]) {
        byName[key].qty += qty;
        if (flaggedCommander || section === 'commander') { byName[key].isCommander = true; }
        return;
      }

      var entry = {
        qty: qty,
        name: name,
        section: section === 'commander' ? 'deck' : section,
        isCommander: flaggedCommander || section === 'commander'
      };
      byName[key] = entry;
      entries.push(entry);
    });

    return { entries: entries, errors: errors };
  }

  global.MTGParse = { parseDecklist: parseDecklist, stripAnnotations: stripAnnotations };
})(window);
