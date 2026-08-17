/* triggers.js — turn a card's oracle text into structured reminders.
   Everything here is pure: card object in, analysis out. */
(function (global) {
  'use strict';

  var D = global.MTGData;

  /* ---------- text helpers ---------- */

  // "(Reminder text like this.)" adds noise to matching and to the UI.
  function stripReminders(text) {
    return text.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  }

  /** Replace every way the card refers to itself with "~". */
  function selfRef(text, name) {
    if (!name) { return text; }
    var out = text;
    var full = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(full, 'gi'), '~');
    // Legendary cards refer to themselves by the part before the comma.
    var comma = name.indexOf(',');
    if (comma > 2) {
      var short = name.slice(0, comma).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('\\b' + short + '\\b', 'gi'), '~');
    }
    return out;
  }

  function isTriggerLine(lower) {
    return /^(when|whenever|at the beginning|at end of)/.test(lower) ||
           /,\s*(when|whenever)\b/.test(lower);
  }

  function isCritical(lower) {
    return D.CRITICAL_RULES.some(function (re) { return re.test(lower); });
  }

  /* ---------- per-ability classification ---------- */

  function classify(line, cardName, idx) {
    var clean = stripReminders(line);
    if (!clean) { return null; }

    var lower = selfRef(clean, cardName).toLowerCase();
    var critical = isCritical(lower);
    var base = { id: idx, text: clean, critical: critical };
    var i, r;

    // "Whenever a creature attacks you" is a defensive event, not your attack step.
    if (/attacks? you\b/.test(lower)) {
      return assign(base, { type: 'event', event: 'attacked', scope: 'opp', zones: ['battlefield'] });
    }

    for (i = 0; i < D.PHASE_RULES.length; i++) {
      r = D.PHASE_RULES[i];
      if (r.re.test(lower)) {
        return assign(base, {
          type: 'phase',
          phase: r.phase,
          scope: r.scope,
          zones: zonesFor(lower)
        });
      }
    }

    for (i = 0; i < D.EVENT_RULES.length; i++) {
      r = D.EVENT_RULES[i];
      if (r.re.test(lower)) {
        return assign(base, {
          type: 'event',
          event: r.event,
          scope: 'each',
          zones: r.event === 'etb_self' ? ['hand', 'deck'] : zonesFor(lower)
        });
      }
    }

    if (isTriggerLine(lower)) {
      return assign(base, { type: 'event', event: 'other_evt', scope: 'each', zones: zonesFor(lower) });
    }

    for (i = 0; i < D.STATIC_RULES.length; i++) {
      r = D.STATIC_RULES[i];
      if (r.re.test(lower)) {
        return assign(base, { type: 'static', kind: r.kind, label: r.label, zones: ['battlefield'] });
      }
    }

    return null;
  }

  function zonesFor(lower) {
    if (/(in|from) your graveyard/.test(lower) && !/return .{0,40}from your graveyard/.test(lower)) {
      return ['graveyard', 'battlefield'];
    }
    return ['battlefield'];
  }

  function assign(base, extra) {
    for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { base[k] = extra[k]; } }
    return base;
  }

  /* ---------- sequences ----------
     Cards whose text changes as they accumulate counters: Sagas, Classes,
     level-up creatures, Sieges, Cases, and the countdown keywords. They all
     reduce to "a number of steps taken", stored as one integer per copy, so a
     single tracker and a single bit of UI cover every one of them. */

  var ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

  // "III — Draw a card."  /  "II, III — Draw a card."
  var CHAPTER_RE = /^([IVX]+(?:\s*,\s*[IVX]+)*)\s*[—–-]\s*([\s\S]+)$/;
  // "{1}{R}: Level 2"
  var CLASS_RE = /^((?:\{[^}]*\})+)\s*:\s*Level\s+(\d+)$/;
  // "LEVEL 2-6"  /  "LEVEL 7+"
  var BAND_RE = /^LEVEL\s+(\d+)(?:\s*-\s*\d+|\s*\+)?$/i;

  var WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
                   seven: 7, eight: 8, nine: 9, ten: 10 };

  function toNum(word) {
    var k = String(word).toLowerCase();
    if (WORD_NUM[k]) { return WORD_NUM[k]; }
    var n = parseInt(k, 10);
    return isNaN(n) ? 0 : n;
  }

  /** Chapters of a Saga. Kept as its own export because it is the trickiest. */
  function parseSaga(text) {
    if (!text) { return null; }
    var chapters = {};
    var max = 0;
    text.split(/\n+/).forEach(function (line) {
      var m = CHAPTER_RE.exec(stripReminders(line).trim());
      if (!m) { return; }
      var body = m[2].trim();
      m[1].split(',').forEach(function (num) {
        var n = ROMAN[num.trim().toUpperCase()];
        if (!n) { return; }
        chapters[n] = body;
        if (n > max) { max = n; }
      });
    });
    return max ? { chapters: chapters, max: max } : null;
  }

  /** Class levels: text before the first "{cost}: Level N" line is level 1. */
  function parseClass(text) {
    var stages = {};
    var costs = {};
    var cur = 1;
    var max = 1;
    (text || '').split(/\n+/).forEach(function (raw) {
      var line = stripReminders(raw).trim();
      if (!line) { return; }
      var m = CLASS_RE.exec(line);
      if (m) {
        cur = parseInt(m[2], 10);
        costs[cur] = m[1];
        if (cur > max) { max = cur; }
        return;
      }
      stages[cur] = (stages[cur] ? stages[cur] + '\n' : '') + line;
    });
    return max > 1 ? { stages: stages, costs: costs, max: max } : null;
  }

  /**
   * "LEVEL 2-6" bands on a level-up creature. Only the band's first level is
   * keyed; stageTextFor() walks back to it for every level inside the band.
   */
  function parseBands(text) {
    var stages = {};
    var max = 0;
    var cur = null;
    (text || '').split(/\n+/).forEach(function (raw) {
      var line = stripReminders(raw).trim();
      if (!line) { return; }
      var m = BAND_RE.exec(line);
      if (m) { cur = parseInt(m[1], 10); if (cur > max) { max = cur; } stages[cur] = ''; return; }
      if (cur !== null) { stages[cur] = (stages[cur] ? stages[cur] + '\n' : '') + line; }
    });
    return max ? { stages: stages, max: max } : null;
  }

  /** Stage text for `value`, falling back to the band it sits inside. */
  function stageTextFor(seq, value) {
    if (!seq || !seq.stages) { return null; }
    if (seq.stages[value]) { return seq.stages[value]; }
    if (!seq.banded) { return null; }
    var best = null;
    Object.keys(seq.stages).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (k) { if (k <= value) { best = k; } });
    return best === null ? null : seq.stages[best];
  }

  function article(word) {
    return /^[aeiou]/i.test(String(word)) ? 'an' : 'a';
  }

  function plural(n, word) {
    return n + ' ' + word + ' counter' + (n === 1 ? '' : 's');
  }

  /** "To solve — ..." / "Solved — ..." on a Case. */
  function parseCase(text) {
    var solve = null;
    var solved = null;
    (text || '').split(/\n+/).forEach(function (raw) {
      var line = stripReminders(raw).trim();
      var m = /^To solve\s*[—–-]\s*([\s\S]+)$/i.exec(line);
      if (m) { solve = m[1].trim(); return; }
      m = /^Solved\s*[—–-]\s*([\s\S]+)$/i.exec(line);
      if (m) { solved = m[1].trim(); }
    });
    return (solve || solved)
      ? { stages: { 1: solve || 'Meet the solve condition.', 2: solved || 'Solved.' }, max: 2 }
      : null;
  }

  /**
   * Work out which sequence, if any, a card runs.
   * @returns {Object|null} see the fields set below
   */
  function detectSequence(card, blocks) {
    var type = card.type_line || '';
    var text = blocks.map(function (b) { return b.text || ''; }).join('\n');
    var kw = card.keywords || [];
    var has = function (k) { return kw.indexOf(k) !== -1; };

    // --- Saga: one chapter per turn, automatically.
    if (/\bSaga\b/.test(type)) {
      var sb = null;
      blocks.forEach(function (b) { if (!sb && /\bSaga\b/.test(b.type || '')) { sb = b; } });
      var ch = parseSaga((sb || blocks[0] || {}).text);
      if (ch) {
        return {
          kind: 'saga', label: 'Chapter', counter: 'lore', dir: 'up', roman: true,
          base: 1, max: ch.max, stages: ch.chapters, auto: 'main1',
          skipRe: CHAPTER_RE,
          endText: 'Every chapter is done — sacrifice this Saga.', endCritical: true
        };
      }
    }

    // --- Class: you pay to gain the next level, so it never advances by itself.
    if (/\bClass\b/.test(type)) {
      var cl = parseClass(text);
      if (cl) {
        return {
          kind: 'class', label: 'Level', counter: 'level', dir: 'up',
          base: 1, max: cl.max, stages: cl.stages, costs: cl.costs, auto: null,
          skipRe: CLASS_RE, cumulative: true,
          endText: 'Fully levelled.'
        };
      }
    }

    // --- Level up creature: level counters, bands of abilities.
    if (has('Level Up')) {
      var bands = parseBands(text);
      if (bands) {
        var cost = /Level up\s+((?:\{[^}]*\})+)/i.exec(text);
        return {
          kind: 'levelup', label: 'Level', counter: 'level', dir: 'up',
          base: 0, max: bands.max, stages: bands.stages, auto: null,
          skipRe: BAND_RE, banded: true, openEnded: true,
          levelCost: cost ? cost[1] : '',
          endText: 'Maximum band reached.'
        };
      }
    }

    // --- Battle — Siege: defence counters come off as it is attacked.
    if (/\bBattle\b/.test(type)) {
      var def = parseInt(card.defense || (card.faces && card.faces[0] && card.faces[0].defense), 10);
      if (def > 0) {
        return {
          kind: 'siege', label: 'Defense', counter: 'defense', dir: 'down',
          base: 0, start: def, max: def, stages: {}, auto: null,
          endText: 'Defeated — exile it, then cast the back face.', endCritical: false
        };
      }
    }

    // --- Case: unsolved until you meet the condition, checked at your end step.
    if (/\bCase\b/.test(type)) {
      var cs = parseCase(text);
      if (cs) {
        return {
          kind: 'case', label: 'Case', counter: 'solved', dir: 'up',
          base: 1, max: 2, stages: cs.stages, auto: 'end',
          skipRe: /^(To solve|Solved)\s*[—–-]/i,
          stageNames: { 1: 'Unsolved', 2: 'Solved' },
          autoText: 'Check whether this Case is solved.',
          endText: 'Solved.'
        };
      }
    }

    // --- Countdown keywords: the last counter is the dangerous one.
    var vanish = /\bVanishing\s+(\d+)/i.exec(text);
    if (has('Vanishing') && vanish) {
      return countdown('vanishing', 'Time', 'time', toNum(vanish[1]),
                       'Sacrifice it — the last time counter is gone.');
    }
    var fade = /\bFading\s+(\d+)/i.exec(text);
    if (has('Fading') && fade) {
      return countdown('fading', 'Fade', 'fade', toNum(fade[1]),
                       'Sacrifice it — you cannot remove another fade counter.');
    }
    var susp = /\bSuspend\s+(\d+)/i.exec(text);
    if (has('Suspend') && susp) {
      var s = countdown('suspend', 'Time', 'time', toNum(susp[1]),
                        'Last counter removed — cast it free.');
      s.zones = ['exile'];
      s.endCritical = false;
      return s;
    }

    // --- Cumulative upkeep: age counters climb and the cost climbs with them.
    if (has('Cumulative upkeep')) {
      var cu = /Cumulative upkeep\s+((?:\{[^}]*\})+|[^(\n]+)/i.exec(text);
      return {
        kind: 'cumulative', label: 'Age', counter: 'age', dir: 'up',
        base: 0, max: 0, stages: {}, auto: 'upkeep', openEnded: true, countersOnly: true,
        upkeepCost: cu ? cu[1].trim() : '',
        autoText: 'Add an age counter, then pay the cumulative upkeep for each one or sacrifice it.',
        endCritical: true
      };
    }

    // --- Anything that just enters with counters on it (Thing in the Ice, etc).
    var enters = /enters (?:the battlefield )?with (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) ([\w+\-\/]+) counters?/i.exec(text);
    if (enters) {
      var n = toNum(enters[1]);
      if (n > 0) {
        return {
          kind: 'counters', label: enters[2], counter: enters[2].toLowerCase(),
          dir: 'down', base: 0, start: n, max: n, stages: {}, auto: null,
          endText: 'No ' + enters[2] + ' counters left.'
        };
      }
    }

    return null;
  }

  function countdown(kind, label, counter, start, endText) {
    return {
      kind: kind, label: label, counter: counter, dir: 'down',
      base: 0, start: start, max: start, stages: {}, auto: 'upkeep',
      autoText: 'Remove a ' + counter + ' counter.',
      endText: endText, endCritical: true
    };
  }

  /**
   * Where a sequence stands after `steps` advances.
   * `steps` is always counted up from 0, whichever way the counters run.
   */
  function sequenceState(seq, steps) {
    if (!seq) { return null; }
    steps = Math.max(0, steps || 0);

    if (seq.dir === 'down') {
      var left = Math.max(0, (seq.start || 0) - steps);
      return {
        value: left, steps: steps, counters: left, max: seq.max,
        done: left === 0,
        last: left === 1,
        label: seq.label,
        display: plural(left, seq.label.toLowerCase()) + ' left',
        text: left === 0
          ? seq.endText
          : (seq.autoText || ('Remove ' + article(seq.counter) + ' ' + seq.counter + ' counter.'))
      };
    }

    // Counting up: `base` is what the card shows before any counters go on it.
    var value = (seq.base || 0) + steps;
    var openEnded = seq.openEnded || !seq.max;
    var done = !openEnded && value > seq.max;
    var shown = done ? seq.max : value;

    var display;
    if (seq.stageNames && seq.stageNames[shown]) { display = seq.stageNames[shown]; }
    else if (seq.countersOnly) { display = plural(shown, seq.label.toLowerCase()); }
    else { display = seq.label + ' ' + shown + (openEnded ? '' : ' of ' + seq.max); }

    return {
      value: shown, steps: steps, counters: steps, max: seq.max,
      done: done,
      last: !openEnded && value === seq.max,
      label: seq.label,
      name: seq.stageNames ? seq.stageNames[shown] : null,
      display: display,
      text: done
        ? (seq.endText || 'Finished.')
        : stageTextFor(seq, shown) || seq.autoText ||
          ('Advance to ' + seq.label.toLowerCase() + ' ' + shown + '.')
    };
  }

  /* ---------- escalating triggers ----------
     "…surveil 2 if this is the first time this ability has resolved this turn.
      If it's the second time, … If it's the third time, …"
     A different effect per resolution, resetting every turn. */

  var ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  var FIRST_TIME_RE = /\bif this is the first time this ability has resolved this turn\b/i;
  // "If it's the second time," / "If this is the second time this ability has resolved this turn,"
  var NTH_TIME_RE = /^If (?:this is|it'?s) the (first|second|third|fourth|fifth) time[^,]*,\s*([\s\S]+?)\.?$/i;

  /**
   * Strip the "Whenever …," condition off the front of a sentence. The first
   * comma ends the condition; later ones belong to the effect itself
   * ("discard a card, then draw a card").
   */
  function effectOf(sentence) {
    var effect = sentence.replace(/\s*\.\s*$/, '').trim();
    var comma = effect.indexOf(', ');
    return comma === -1 ? effect : effect.slice(comma + 2);
  }

  /**
   * Escalating abilities: a different effect on each resolution within a turn.
   * @returns {{steps: Array<{n:number,text:string}>, repeating:boolean, max:number}|null}
   */
  function parseTiers(text) {
    if (!text) { return null; }

    var steps = [];
    var sawOrdinal = false;

    text.split(/(?<=\.)\s+/).forEach(function (raw, i) {
      var sentence = raw.trim();
      if (!sentence) { return; }

      var m = NTH_TIME_RE.exec(sentence);
      if (m) {
        sawOrdinal = true;
        steps.push({ n: ORDINAL[m[1].toLowerCase()], text: m[2].trim() });
        return;
      }

      if (FIRST_TIME_RE.test(sentence)) {
        sawOrdinal = true;
        steps.push({ n: 1, text: effectOf(sentence.replace(FIRST_TIME_RE, '')) || 'Resolve the first mode.' });
        return;
      }

      var o = /^Otherwise,\s*([\s\S]+?)\.?$/i.exec(sentence);
      if (o) { sawOrdinal = true; steps.push({ n: 2, text: o[1].trim(), repeating: true }); return; }

      // Cards like Elrond state the always-on effect first, then add to it on a
      // later resolution — keep that opening effect as step one.
      if (i === 0 && !steps.length) { steps.push({ n: 1, text: effectOf(sentence), base: true }); }
    });

    if (!sawOrdinal || steps.length < 2) { return null; }
    steps.sort(function (a, b) { return a.n - b.n; });

    return {
      steps: steps,
      repeating: steps[steps.length - 1].repeating === true,
      max: steps[steps.length - 1].n
    };
  }

  /**
   * Every way a card gates or changes itself by how often it has happened this
   * turn. Modes:
   *   tiers     — a different effect per resolution (Victor, Elrond)
   *   first     — "for the first time each turn"
   *   once      — "This ability triggers only once each turn."
   *   nth       — "whenever you cast your second spell each turn"
   *   once_turn — "Once during each of your turns, you may …"
   */
  function parsePerTurn(text) {
    if (!text) { return null; }

    var tiers = parseTiers(text);
    if (tiers) {
      return { mode: 'tiers', steps: tiers.steps, max: tiers.max, repeating: tiers.repeating };
    }

    if (/\bonce during each of your turns\b/i.test(text)) {
      return { mode: 'once_turn', n: 1, max: 1, label: 'once per turn' };
    }

    var nth = /\byour (second|third|fourth|fifth) ([a-z ]{0,24}?spells?) each turn\b/i.exec(text);
    if (nth) {
      var n = ORDINAL[nth[1].toLowerCase()];
      return { mode: 'nth', n: n, max: n, what: nth[2].trim(), label: 'on your ' + nth[1].toLowerCase() };
    }

    if (/\bfor the first time each turn\b/i.test(text)) {
      return { mode: 'first', n: 1, max: 1, label: 'first time only' };
    }

    // Deliberately narrow: "Activate only once each turn" is an activated
    // ability's restriction, not a triggered one.
    if (/\bthis ability triggers only once each turn\b/i.test(text)) {
      return { mode: 'once', n: 1, max: 1, label: 'once per turn' };
    }

    return null;
  }

  /** What this card does on its `times + 1`-th occurrence in the turn. */
  function perTurnState(pt, times) {
    if (!pt) { return null; }
    var time = Math.max(1, (times || 0) + 1);

    if (pt.mode === 'tiers') {
      var capped = Math.min(time, pt.max);
      var spent = !pt.repeating && time > pt.max;
      var step = null;
      pt.steps.forEach(function (s) { if (s.n === capped) { step = s; } });
      return {
        time: time, max: pt.max, capped: capped, spent: spent, active: !spent,
        last: time === pt.max,
        badge: spent ? 'spent' : 'resolution ' + capped + ' of ' + pt.max,
        text: spent
          ? 'Already resolved ' + pt.max + ' times this turn — no further effect.'
          : (step ? step.text : 'No further effect this turn.')
      };
    }

    var target = pt.n || 1;
    var active = time === target;
    var past = time > target;

    var badge, msg;
    if (pt.mode === 'nth') {
      badge = active ? 'triggers now' : (past ? 'done this turn' : time + ' of ' + target);
      msg = active
        ? 'This is the ' + (pt.what || 'one') + ' that triggers it.'
        : past
          ? 'Already triggered this turn — later ones do nothing.'
          : 'Not yet: it triggers on number ' + target + ' this turn.';
    } else if (pt.mode === 'once_turn') {
      badge = past ? 'used' : 'available';
      msg = past ? 'Already used this turn.' : 'Not used yet this turn.';
    } else {
      badge = past ? 'done this turn' : 'triggers now';
      msg = past ? 'Already happened this turn — this one does nothing.' : 'This one triggers.';
    }

    return {
      time: time, max: target, capped: Math.min(time, target),
      spent: past, active: active, last: active,
      badge: badge, text: msg
    };
  }

  /** Back-compat: the tiers-only view used by earlier tests. */
  function tierState(tiers, times) {
    return perTurnState({ mode: 'tiers', steps: tiers.steps, max: tiers.max,
                          repeating: tiers.repeating }, times);
  }

  /* ---------- per-turn tallies ----------
     Cards that read "for each … this turn" depend on a running count the app
     already keeps from the turn questions, so point the two at each other. */

  var TALLY_LINKS = [
    { event: 'draw_event', re: /(cards?|you) (drew|have drawn)[^.]{0,30}this turn/i },
    { event: 'landfall',   re: /lands?[^.]{0,40}(entered|you played)[^.]{0,20}this turn/i },
    { event: 'dies_other', re: /creatures?[^.]{0,30}died this turn/i },
    { event: 'cast',       re: /spells?[^.]{0,30}(you )?cast this turn/i },
    { event: 'lifegain',   re: /life[^.]{0,20}gained this turn/i },
    { event: 'token',      re: /tokens?[^.]{0,30}created this turn/i },
    { event: 'attacked',   re: /creatures? attacked this turn/i }
  ];

  function tallyLink(text) {
    if (!/\bthis turn\b/i.test(text)) { return null; }
    for (var i = 0; i < TALLY_LINKS.length; i++) {
      if (TALLY_LINKS[i].re.test(text)) { return TALLY_LINKS[i].event; }
    }
    return null;
  }

  /** Back-compat wrapper used by the Saga tests. */
  function sagaChapter(saga, loreDone) {
    if (!saga) { return null; }
    var st = sequenceState({ dir: 'up', base: 1, max: saga.max, stages: saga.chapters,
                             label: 'Chapter', endText: 'Final chapter is finished — sacrifice this Saga.' },
                           loreDone || 0);
    return { chapter: st.done ? null : st.value, done: st.done, max: saga.max,
             last: st.last, text: st.text };
  }

  /* ---------- whole-card analysis ---------- */

  /**
   * @param {Object} card trimmed Scryfall card
   * @returns {{triggers: Array, statics: Array, keywords: Array, hasAny: boolean}}
   */
  function analyzeCard(card) {
    var triggers = [];
    var statics = [];
    var seenText = {};
    var idx = 0;

    var blocks = [];
    if (card.faces && card.faces.length) {
      card.faces.forEach(function (f) {
        blocks.push({ text: f.oracle_text || '', name: f.name, type: f.type_line || '' });
      });
    }
    if (card.oracle_text) {
      blocks.push({ text: card.oracle_text, name: card.name, type: card.type_line || '' });
    }

    // Sequenced cards carry their stage text in structured lines. Those lines
    // are parsed into the sequence and must not be classified as ordinary
    // abilities, or an ability quoted inside a stage leaks out on its own.
    var sequence = detectSequence(card, blocks);
    var skipRe = sequence && sequence.skipRe;

    blocks.forEach(function (block) {
      var lastTrigger = null;

      block.text.split(/\n+/).forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed) { return; }

        if (skipRe && skipRe.test(stripReminders(trimmed))) { return; }

        // "• Scry 2." is a mode of the trigger above it, not its own ability.
        if (/^[•·]/.test(trimmed)) {
          if (lastTrigger) {
            lastTrigger.text += '\n' + stripReminders(trimmed);
            lastTrigger.modal = true;
          }
          return;
        }

        var res = classify(line, block.name || card.name, idx);
        if (!res) { return; }
        var dedupe = res.text.toLowerCase();
        if (seenText[dedupe]) { return; }
        seenText[dedupe] = true;
        res.id = card.name + '#' + (idx++);
        res.face = block.name !== card.name ? block.name : null;

        // A delayed trigger only exists if you used the ability that made it.
        if (/\bthe next (end step|upkeep|turn|combat)\b/.test(res.text.toLowerCase())) {
          res.conditional = true;
        }

        // Anything gated or escalated by how often it happened this turn.
        var perTurn = parsePerTurn(res.text);
        if (perTurn) { res.perTurn = perTurn; }

        // Dungeons live outside the deck, so just flag the prompt to venture.
        if (/venture into the dungeon/i.test(res.text)) { res.venture = true; }

        // "for each card you drew this turn" — the questions already count that.
        var tally = tallyLink(res.text);
        if (tally) { res.tally = tally; }

        if (res.type === 'static') { statics.push(res); lastTrigger = null; }
        else { triggers.push(res); lastTrigger = res; }
      });
    });

    // Sagas tick in your precombat main phase — that is not in the oracle text,
    // and the chapter changes every turn, so the app tracks the lore count and
    // fills the real chapter text in at render time.
    // A sequence that advances on a schedule gets its own trigger row; one you
    // drive by hand (Class, Siege, Case) lives on the card sheet only.
    if (sequence && sequence.auto) {
      triggers.push({
        id: card.name + '#seq',
        type: 'phase',
        phase: sequence.auto,
        scope: 'you',
        zones: sequence.zones || ['battlefield'],
        critical: !!sequence.endCritical,
        sequence: sequence,
        text: sequence.autoText || 'Advance this card.'
      });
    }

    // Keyword mechanics that live in the rules rather than the card text.
    var keywords = [];
    (card.keywords || []).forEach(function (kw) {
      var info = D.KEYWORD_INFO[kw];
      if (!info) { return; }
      keywords.push({ keyword: kw, note: info.note, when: info.when });

      if (D.PHASE_BY_ID[info.when]) {
        triggers.push({
          id: card.name + '#kw-' + kw,
          type: 'phase',
          phase: info.when,
          scope: 'you',
          zones: ['battlefield'],
          critical: /^(Cumulative upkeep|Echo|Vanishing|Fading)$/.test(kw),
          text: kw + ' — ' + info.note,
          keyword: kw
        });
      } else if (D.EVENT_BY_ID[info.when]) {
        triggers.push({
          id: card.name + '#kw-' + kw,
          type: 'event',
          event: info.when,
          scope: 'each',
          zones: info.when === 'graveyard' ? ['graveyard'] : ['battlefield'],
          critical: false,
          text: kw + ' — ' + info.note,
          keyword: kw
        });
      }
    });

    return {
      triggers: triggers,
      statics: statics,
      keywords: keywords,
      sequence: sequence,
      hasAny: triggers.length > 0 || statics.length > 0
    };
  }

  /** Analyse a whole deck once and memoise per card name. */
  function analyzeDeck(entries, cards) {
    var out = {};
    entries.forEach(function (e) {
      var card = cards[String(e.name).toLowerCase()];
      if (!card) { return; }
      out[e.name] = analyzeCard(card);
    });
    return out;
  }

  /**
   * Which triggers fire right now?
   * @param {Array} board  [{ name, zone, card, analysis }]
   * @param {string} phaseId
   * @param {boolean} myTurn
   */
  function triggersNow(board, phaseId, myTurn) {
    var hits = [];
    board.forEach(function (item) {
      if (!item.analysis) { return; }
      item.analysis.triggers.forEach(function (t) {
        if (t.type !== 'phase' || t.phase !== phaseId) { return; }
        if (t.zones.indexOf(item.zone) === -1) { return; }
        if (t.scope === 'you' && !myTurn) { return; }
        if (t.scope === 'opp' && myTurn) { return; }
        hits.push({ item: item, trigger: t });
      });
    });
    hits.sort(function (a, b) {
      return (b.trigger.critical ? 1 : 0) - (a.trigger.critical ? 1 : 0);
    });
    return hits;
  }

  /**
   * Event triggers across the whole deck, grouped into the questions asked each
   * turn. Deliberately ignores zones: these fire because the player did
   * something, and the player knows their own board — so asking costs one tap
   * and saves tapping every permanent into the app.
   * @param {string[]} names deck card names
   * @param {Object} analysisMap name -> analysis
   */
  function deckQuestions(names, analysisMap) {
    var groups = {};
    var seen = {};
    names.forEach(function (name) {
      var a = analysisMap[name];
      if (!a) { return; }
      a.triggers.concat(a.statics).forEach(function (t) {
        // Venture is an action you take, not an event, but it still needs a
        // prompt — the dungeon itself lives outside the deck.
        if (t.venture) {
          var vk = 'venture|' + name;
          if (!seen[vk]) {
            seen[vk] = true;
            (groups.venture = groups.venture || []).push({ name: name, trigger: t });
          }
        }
        if (t.type !== 'event') { return; }
        var ev = D.EVENT_BY_ID[t.event];
        if (!ev || !ev.ask) { return; }          // self-referential, not a question
        var k = t.event + '|' + name + '|' + t.text;
        if (seen[k]) { return; }
        seen[k] = true;
        (groups[t.event] = groups[t.event] || []).push({ name: name, trigger: t });
      });
    });
    return D.EVENTS
      .filter(function (e) { return groups[e.id]; })
      .map(function (e) { return { event: e, hits: groups[e.id] }; });
  }

  /** Event triggers that are live given the current board, grouped by event. */
  function watchList(board) {
    var groups = {};
    board.forEach(function (item) {
      if (!item.analysis) { return; }
      item.analysis.triggers.forEach(function (t) {
        if (t.type !== 'event') { return; }
        if (t.zones.indexOf(item.zone) === -1) { return; }
        if (!groups[t.event]) { groups[t.event] = []; }
        groups[t.event].push({ item: item, trigger: t });
      });
    });
    return D.EVENTS
      .filter(function (e) { return groups[e.id]; })
      .map(function (e) { return { event: e, hits: groups[e.id] }; });
  }

  /**
   * Does this card need the app to know it is in play? True when it fires on a
   * schedule, runs a sequence, or escalates within a turn — anything the player
   * cannot answer with a single yes/no question.
   */
  function needsTracking(analysis) {
    if (!analysis) { return false; }
    if (analysis.sequence) { return true; }
    var gated = function (t) { return t.type === 'phase' || !!t.perTurn; };
    return analysis.triggers.some(gated) || analysis.statics.some(function (t) { return !!t.perTurn; });
  }

  global.MTGTriggers = {
    analyzeCard: analyzeCard,
    analyzeDeck: analyzeDeck,
    triggersNow: triggersNow,
    watchList: watchList,
    deckQuestions: deckQuestions,
    needsTracking: needsTracking,
    parseSaga: parseSaga,
    sagaChapter: sagaChapter,
    detectSequence: detectSequence,
    sequenceState: sequenceState,
    parseTiers: parseTiers,
    tierState: tierState,
    parsePerTurn: parsePerTurn,
    perTurnState: perTurnState,
    stripReminders: stripReminders
  };
})(window);
