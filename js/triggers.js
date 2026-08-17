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

    blocks.forEach(function (block) {
      block.text.split(/\n+/).forEach(function (line) {
        var res = classify(line, block.name || card.name, idx);
        if (!res) { return; }
        var dedupe = res.text.toLowerCase();
        if (seenText[dedupe]) { return; }
        seenText[dedupe] = true;
        res.id = card.name + '#' + (idx++);
        res.face = block.name !== card.name ? block.name : null;
        if (res.type === 'static') { statics.push(res); } else { triggers.push(res); }
      });
    });

    // Sagas tick in your precombat main phase — that is not in the oracle text.
    if (/\bSaga\b/.test(card.type_line || '')) {
      triggers.push({
        id: card.name + '#saga',
        type: 'phase',
        phase: 'main1',
        scope: 'you',
        zones: ['battlefield'],
        critical: false,
        text: 'Put a lore counter on this Saga, then run that chapter ability.'
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
      a.triggers.forEach(function (t) {
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

  /** Does this card fire on its own schedule? Those are the ones worth tracking. */
  function needsTracking(analysis) {
    return !!analysis && analysis.triggers.some(function (t) { return t.type === 'phase'; });
  }

  global.MTGTriggers = {
    analyzeCard: analyzeCard,
    analyzeDeck: analyzeDeck,
    triggersNow: triggersNow,
    watchList: watchList,
    deckQuestions: deckQuestions,
    needsTracking: needsTracking,
    stripReminders: stripReminders
  };
})(window);
