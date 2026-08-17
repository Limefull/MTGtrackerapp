/* app.js — screens, game loop and rendering. */
(function (global) {
  'use strict';

  var D = global.MTGData;
  var Parse = global.MTGParse;
  var Scry = global.MTGScryfall;
  var Trig = global.MTGTriggers;
  var Store = global.MTGStore;
  var Mana = global.MTGMana;

  var VERSION = '1.0.0';
  var ZONES = [
    { id: 'battlefield', label: 'Battlefield' },
    { id: 'command',     label: 'Command' },
    { id: 'hand',        label: 'Hand' },
    { id: 'graveyard',   label: 'Graveyard' },
    { id: 'exile',       label: 'Exile' },
    { id: 'deck',        label: 'Library' }
  ];
  // Steps the app is allowed to fast-forward through when they are empty.
  var SKIPPABLE = { untap: 1, upkeep: 1, draw: 1, combat: 1, block: 1, damage: 1, endcombat: 1, cleanup: 1 };

  // Card-type buckets for the picker, in display order. The first match wins,
  // so an artifact creature files under Creatures rather than Artifacts.
  var TYPE_GROUPS = [
    { id: 'creature',     label: 'Creatures',     re: /\bCreature\b/ },
    { id: 'planeswalker', label: 'Planeswalkers', re: /\bPlaneswalker\b/ },
    { id: 'instant',      label: 'Instants',      re: /\bInstant\b/ },
    { id: 'sorcery',      label: 'Sorceries',     re: /\bSorcery\b/ },
    { id: 'artifact',     label: 'Artifacts',     re: /\bArtifact\b/ },
    { id: 'enchantment',  label: 'Enchantments',  re: /\bEnchantment\b/ },
    { id: 'battle',       label: 'Battles',       re: /\bBattle\b/ },
    { id: 'land',         label: 'Lands',         re: /\bLand\b/ },
    { id: 'other',        label: 'Other',         re: /./ }
  ];

  var state = Store.load();
  var analysis = {};        // card name -> analysis
  var cardsByName = {};     // lowercased name -> trimmed Scryfall card
  var addFilter = 'triggers';
  var typeFilter = 'all';
  var detailKey = null;
  var pendingAdvance = false;
  var showDormant = false;   // questions whose cards are not on the battlefield

  /** Front-face type line — "Sorcery // Land" groups as a sorcery. */
  function typeGroupOf(name) {
    var card = cardsByName[String(name).toLowerCase()];
    var line = card ? (card.type_line || '') : '';
    line = line.split('//')[0];
    for (var i = 0; i < TYPE_GROUPS.length; i++) {
      if (TYPE_GROUPS[i].re.test(line)) { return TYPE_GROUPS[i]; }
    }
    return TYPE_GROUPS[TYPE_GROUPS.length - 1];
  }

  /* ---------------- utilities ---------------- */

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function persist() { Store.save(state); }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2600);
  }

  function buzz(pattern) {
    if (!state.settings.haptics) { return; }
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { /* ignore */ } }
  }

  function showScreen(id) {
    $$('.screen').forEach(function (s) { s.classList.toggle('hidden', s.id !== id); });
    var sc = $('#' + id + ' .scroll');
    if (sc) { sc.scrollTop = 0; }
  }

  /* ---------------- deck + analysis ---------------- */

  function deckById(id) {
    for (var i = 0; i < state.decks.length; i++) {
      if (state.decks[i].id === id) { return state.decks[i]; }
    }
    return null;
  }

  function activeDeck() { return state.game ? deckById(state.game.deckId) : null; }

  /** Rebuild the card + analysis lookups for a deck from the local cache. */
  function hydrate(deck) {
    cardsByName = {};
    analysis = {};
    if (!deck) { return; }
    deck.entries.forEach(function (e) {
      var card = Scry.getCached(e.name);
      if (!card) { return; }
      cardsByName[e.name.toLowerCase()] = card;
      analysis[e.name] = Trig.analyzeCard(card);
    });
  }

  function triggerCount(name) {
    var a = analysis[name];
    if (!a) { return 0; }
    return a.triggers.length + a.statics.length;
  }

  /** Fires on its own schedule, so the app has to be told it is in play. */
  function needsTracking(name) {
    return Trig.needsTracking(analysis[name]);
  }

  function phaseTriggerCount(name) {
    var a = analysis[name];
    if (!a) { return 0; }
    return a.triggers.filter(function (t) { return t.type === 'phase'; }).length;
  }

  /* ---------------- instances and zones ---------------- */

  function instKey(name, copy) { return name + '§' + copy; }

  function zoneOf(key) {
    var z = state.game && state.game.zones[key];
    return z || 'deck';
  }

  function setZone(key, zone) {
    if (!state.game) { return; }
    if (zone === 'deck') { delete state.game.zones[key]; }
    else { state.game.zones[key] = zone; }
    persist();
  }

  /** Every instance currently outside the library, with its analysis attached. */
  function board() {
    var deck = activeDeck();
    if (!deck || !state.game) { return []; }
    var out = [];
    Object.keys(state.game.zones).forEach(function (key) {
      var name = key.split('§')[0];
      out.push({
        key: key,
        name: name,
        zone: state.game.zones[key],
        card: cardsByName[name.toLowerCase()] || null,
        analysis: analysis[name] || null
      });
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  }

  // Zones a card is no longer tracked from — it has left the board, but it can
  // come back (reanimation, flashback, blink), so those copies stay reusable.
  var GONE_ZONES = { graveyard: 1, exile: 1 };

  /**
   * A copy of this card that could be put into play: an untouched one from the
   * library first, otherwise one that already died or got exiled.
   */
  function freeInstance(entry) {
    var recycled = null;
    for (var i = 0; i < entry.qty; i++) {
      var k = instKey(entry.name, i);
      var z = zoneOf(k);
      if (z === 'deck') { return k; }
      if (!recycled && GONE_ZONES[z]) { recycled = k; }
    }
    return recycled;
  }

  /** Instances still being tracked — on the board, in hand or in the command zone. */
  function activeBoard() {
    return board().filter(function (it) { return !GONE_ZONES[it.zone]; });
  }

  /** Instances that have left play but could return. */
  function goneBoard() {
    return board().filter(function (it) { return GONE_ZONES[it.zone]; });
  }

  /* ---------------- resolved bookkeeping ---------------- */

  function resolvedKey(hit) {
    var g = state.game;
    return g.turn + '|' + (g.myTurn ? 'y' : 'o') + '|' + (hit.phase || phaseId()) +
           '|' + hit.item.key + '|' + hit.trigger.id;
  }

  function isResolved(hit) { return !!state.game.resolved[resolvedKey(hit)]; }

  function toggleResolved(hit) {
    var k = resolvedKey(hit);
    var nowResolved;
    if (state.game.resolved[k]) { delete state.game.resolved[k]; nowResolved = false; }
    else { state.game.resolved[k] = 1; nowResolved = true; }

    // Ticking off a sequenced trigger is what advances its counter. Clamp so
    // re-ticking the finished row cannot run past the end.
    var seq = hit.trigger.sequence;
    if (seq) {
      var cap = (seq.dir === 'down' ? seq.start : seq.max) || 0;
      var next = stepsOf(hit.item.key) + (nowResolved ? 1 : -1);
      setSteps(hit.item.key, seq.openEnded ? Math.max(0, next) : Math.max(0, Math.min(next, cap)));
    }
    persist();
  }

  /* ---------------- sequence counters ----------------
     One integer per copy: how many steps that card has taken. Sagas count lore,
     Sieges count defence removed, Classes count levels gained. */

  function stepsOf(key) {
    var c = state.game && state.game.counters;
    return (c && c[key]) || 0;
  }

  function setSteps(key, n) {
    if (!state.game) { return; }
    state.game.counters = state.game.counters || {};
    if (n <= 0) { delete state.game.counters[key]; }
    else { state.game.counters[key] = n; }
    persist();
  }

  /**
   * Where a sequenced trigger stands. Once the row is ticked the counter has
   * already advanced, so step back one to keep the row showing what was run.
   */
  function stateFor(trigger, key, alreadyDone) {
    if (!trigger.sequence) { return null; }
    return Trig.sequenceState(trigger.sequence, Math.max(0, stepsOf(key) - (alreadyDone ? 1 : 0)));
  }

  function sequenceOf(name) {
    var a = analysis[name];
    return a && a.sequence ? a.sequence : null;
  }

  /* ---------------- escalating triggers ----------------
     Abilities that do something different on each resolution within a turn.
     Counted per copy per turn, so the tally resets when the turn does. */

  function tierKey(key, triggerId) { return key + '@' + triggerId; }

  function tierCount(key, triggerId) {
    var t = state.game && state.game.tiers;
    return (t && t[tierKey(key, triggerId)]) || 0;
  }

  function bumpTier(key, triggerId, delta) {
    if (!state.game) { return; }
    state.game.tiers = state.game.tiers || {};
    var k = tierKey(key, triggerId);
    var n = Math.max(0, tierCount(key, triggerId) + delta);
    if (n === 0) { delete state.game.tiers[k]; } else { state.game.tiers[k] = n; }
    persist();
  }

  /** Every per-turn gated ability on a card currently being tracked. */
  function escalating() {
    var out = [];
    activeBoard().forEach(function (it) {
      if (!it.analysis) { return; }
      it.analysis.triggers.concat(it.analysis.statics).forEach(function (t) {
        if (t.perTurn) { out.push({ item: it, trigger: t }); }
      });
    });
    return out;
  }

  function pruneResolved() {
    var g = state.game;
    var keep = {};
    Object.keys(g.resolved).forEach(function (k) {
      if (k.indexOf(g.turn + '|') === 0) { keep[k] = 1; }
    });
    g.resolved = keep;
    var keptAnswers = {};
    Object.keys(g.answers || {}).forEach(function (k) {
      if (isPersistentQuestion(k)) { keptAnswers[k] = g.answers[k]; }
    });
    g.answers = keptAnswers;
    g.tiers = {};
  }

  /* ---------------- turn questions ---------------- */

  function questions() {
    var deck = activeDeck();
    if (!deck) { return []; }
    return Trig.deckQuestions(deck.entries.map(function (e) { return e.name; }), analysis);
  }

  function answerCount(eventId) {
    return (state.game.answers && state.game.answers[eventId]) || 0;
  }

  function answerQuestion(eventId) {
    var g = state.game;
    g.answers = g.answers || {};
    g.answers[eventId] = answerCount(eventId) + 1;
    persist();
    buzz(14);

    var group = null;
    questions().forEach(function (q) { if (q.event.id === eventId) { group = q; } });
    if (group) {
      var live = group.hits.filter(function (h) { return isOnBoard(h.name); });
      var names = (live.length ? live : group.hits).map(function (h) { return h.name; });
      toast(names.slice(0, 4).join(', ') + (names.length > 4 ? ' +' + (names.length - 4) + ' more' : ''), 3200);
    }
    renderPlay();
    if (!$('#modal-sweep').classList.contains('hidden')) { renderSweep(); }
  }

  // Ventures accumulate across the whole game — the dungeon does not reset.
  function isPersistentQuestion(eventId) { return eventId === 'venture'; }

  function clearAnswer(eventId) {
    if (!state.game.answers) { return; }
    delete state.game.answers[eventId];
    persist();
    renderPlay();
  }

  function isOnBoard(name) {
    var g = state.game;
    if (!g) { return false; }
    return Object.keys(g.zones).some(function (k) {
      return k.split('§')[0] === name && g.zones[k] === 'battlefield';
    });
  }

  /* ---------------- phase helpers ---------------- */

  function phaseId() { return D.PHASES[state.game.phaseIndex].id; }

  function hitsFor(pid) {
    var hits = Trig.triggersNow(board(), pid, state.game.myTurn);
    hits.forEach(function (h) { h.phase = pid; });
    return hits;
  }

  function unresolvedCount(pid) {
    return hitsFor(pid).filter(function (h) { return !isResolved(h); }).length;
  }

  /* ---------------- import ---------------- */

  function importDeck(name, text) {
    var parsed = Parse.parseDecklist(text);
    if (!parsed.entries.length) {
      setStatus('No cards found in that list.', 'error');
      return;
    }

    var status = $('#import-status');
    status.classList.remove('hidden', 'error', 'ok');
    setStatus('Looking up ' + parsed.entries.length + ' cards on Scryfall...', '');

    var names = parsed.entries.map(function (e) { return e.name; });
    Scry.fetchCards(names, function (done, total) {
      setStatus('Looking up cards... ' + done + ' / ' + total, '');
    }).then(function (res) {
      if (res.offline && !Object.keys(res.cards).length) {
        setStatus('Could not reach Scryfall and nothing is cached. Connect once, then this deck works offline.', 'error');
        return;
      }

      var deck = {
        id: Store.newId(),
        name: (name || '').trim() || guessName(parsed.entries) || 'Untitled deck',
        created: new Date().toISOString(),
        entries: parsed.entries
      };
      state.decks.push(deck);
      persist();

      var msgs = [];
      if (res.missing.length) {
        msgs.push(res.missing.length + ' card' + (res.missing.length === 1 ? '' : 's') +
                  ' not found: ' + res.missing.slice(0, 5).join(', ') +
                  (res.missing.length > 5 ? '...' : ''));
      }
      if (parsed.errors.length) { msgs.push(parsed.errors.length + ' line(s) skipped.'); }

      setStatus('Imported "' + deck.name + '".' + (msgs.length ? ' ' + msgs.join(' ') : ''),
                msgs.length ? '' : 'ok');
      $('#deck-text').value = '';
      $('#deck-name').value = '';
      renderDecks();
    });
  }

  function guessName(entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isCommander) { return entries[i].name; }
    }
    return null;
  }

  function setStatus(msg, kind) {
    var el = $('#import-status');
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  /* ---------------- rendering: decks ---------------- */

  /** True when the panel is telling the player their board is on its way. */
  function waitingShown() {
    var note = $('#waiting-note');
    return !!note && !note.classList.contains('hidden');
  }

  function renderDecks() {
    // In the extension the board arrives on its own, so do not lead with a
    // decklist form the player is not supposed to need.
    var waiting = $('#waiting-note');
    if (waiting) {
      var extension = !!(global.MTGBridge && global.MTGBridge.available);
      waiting.classList.toggle('hidden', !extension || !!liveSnapshot);
    }

    var host = $('#deck-list');
    // The live board is rebuilt from edhplay every few seconds; listing it
    // beside real decks invites deleting or "playing" something transient.
    var listed = state.decks.filter(function (d) { return d.id !== LIVE_DECK_ID; });
    if (!listed.length) {
      host.innerHTML = waitingShown()
        ? ''
        : '<div class="empty">No decks yet. Paste a list below to get started.</div>';
      return;
    }
    host.innerHTML = listed.map(function (d) {
      var count = d.entries.reduce(function (s, e) { return s + e.qty; }, 0);
      var cmdr = d.entries.filter(function (e) { return e.isCommander; })
        .map(function (e) { return e.name; }).join(' & ');
      return '<div class="deck-row" data-deck="' + esc(d.id) + '">' +
        '<div class="deck-main">' +
          '<div class="deck-name">' + esc(d.name) + '</div>' +
          '<div class="muted">' + count + ' cards' + (cmdr ? ' &middot; ' + esc(cmdr) : '') + '</div>' +
        '</div>' +
        '<button class="btn primary small" data-play="' + esc(d.id) + '">Play</button>' +
        '<button class="btn ghost icon" data-del="' + esc(d.id) + '" aria-label="Delete deck">&#10005;</button>' +
      '</div>';
    }).join('');
  }

  /* ---------------- game lifecycle ---------------- */

  function startGame(deckId) {
    var deck = deckById(deckId);
    if (!deck) { return; }

    var missing = deck.entries.filter(function (e) { return !Scry.getCached(e.name); });
    if (missing.length) {
      toast('Fetching ' + missing.length + ' missing card(s)...');
      Scry.fetchCards(missing.map(function (e) { return e.name; })).then(function () {
        openGame(deck);
      });
      return;
    }
    openGame(deck);
  }

  function openGame(deck) {
    hydrate(deck);
    if (!state.game || state.game.deckId !== deck.id) {
      state.game = { deckId: deck.id, turn: 1, phaseIndex: 1, myTurn: true,
                     zones: {}, resolved: {}, answers: {}, counters: {}, tiers: {} };
      // Commanders start where you can see them.
      deck.entries.forEach(function (e) {
        if (e.isCommander) { state.game.zones[instKey(e.name, 0)] = 'command'; }
      });
    }
    state.activeDeckId = deck.id;
    persist();
    showScreen('screen-play');
    renderPlay();
  }

  function newGame() {
    var deck = activeDeck();
    if (!deck) { return; }
    state.game = null;
    openGame(deck);
    toast('New game started.');
  }

  function setPhase(index, silent) {
    var g = state.game;
    // Stepping off either end of the turn changes the turn — except in live
    // mode, where edhplay owns the turn number and the steps simply wrap.
    if (index < 0) {
      index = D.PHASES.length - 1;
      if (!isLive()) { g.turn = Math.max(1, g.turn - 1); pruneResolved(); }
    }
    if (index >= D.PHASES.length) {
      index = 0;
      if (!isLive()) {
        g.turn += 1;
        pruneResolved();
        if (!silent) { toast('Turn ' + g.turn); }
      }
    }
    g.phaseIndex = index;
    pendingAdvance = false;
    persist();
    renderPlay();

    var n = hitsFor(phaseId()).length;
    if (n && !silent) { buzz([28, 40, 28]); }
  }

  function nextPhase() {
    var g = state.game;
    var pending = hitsFor(phaseId()).filter(function (h) { return !isResolved(h); });
    var critical = pending.some(function (h) { return h.trigger.critical; });

    if (state.settings.nagOnAdvance && pending.length && !pendingAdvance) {
      pendingAdvance = true;
      buzz(critical ? [60, 60, 60] : [40]);
      toast(pending.length + ' trigger' + (pending.length === 1 ? '' : 's') +
            ' still unchecked' + (critical ? ' (one can lose you the game)' : '') +
            ' — tap again to move on.', 3600);
      $('#btn-next-phase').classList.add('warn');
      return;
    }

    $('#btn-next-phase').classList.remove('warn');

    // Walking off the end of Cleanup passes the turn. setPhase applies the
    // live-mode exception.
    if (g.phaseIndex >= D.PHASES.length - 1 && !isLive()) { endTurn(); return; }

    var next = g.phaseIndex + 1;
    if (state.settings.skipEmptySteps) {
      while (next < D.PHASES.length && SKIPPABLE[D.PHASES[next].id]) {
        g.phaseIndex = next;
        if (hitsFor(D.PHASES[next].id).length) { break; }
        next++;
      }
    }
    setPhase(next);
  }

  function endTurn(skipSweep) {
    // The table decides when the turn ends; the panel just follows.
    if (isLive()) { toast('edhplay controls the turn — pass it in the game.'); return; }
    // The sweep is the last chance to catch an event trigger that slipped past.
    if (!skipSweep && state.settings.endTurnSweep && questions().length) {
      openSweep();
      return;
    }
    $('#modal-sweep').classList.add('hidden');
    var g = state.game;
    g.turn += 1;
    g.phaseIndex = 0;
    pruneResolved();
    persist();
    renderPlay();
    toast('Turn ' + g.turn);
  }

  /* ---------------- rendering: play ---------------- */

  function renderPlay() {
    var deck = activeDeck();
    if (!deck || !state.game) { showScreen('screen-decks'); return; }

    $('#play-deck-name').textContent = deck.name;
    $('#play-sub').textContent = 'Turn ' + state.game.turn + ' · ' + D.PHASES[state.game.phaseIndex].name;
    $('#seg-you').classList.toggle('active', state.game.myTurn);
    $('#seg-opp').classList.toggle('active', !state.game.myTurn);
    $('#btn-next-phase').classList.remove('warn');

    renderLiveBar();
    // In live mode edhplay owns the turn and the board, so every control that
    // would set them by hand is hidden rather than left to silently revert.
    $('#btn-add-card').classList.toggle('hidden', isLive());
    $('.turn-toggle').classList.toggle('hidden', isLive());
    // No phases to walk on edhplay, so the rail and step buttons go away.
    $('#phase-rail').classList.toggle('hidden', isLive());
    $('.dock').classList.toggle('hidden', isLive());
    renderAlerts();
    renderRail();
    renderNow();
    renderWatch();
    renderBoard();
  }

  function renderRail() {
    $('#phase-rail').innerHTML = D.PHASES.map(function (p) {
      var n = unresolvedCount(p.id);
      var cls = 'phase-chip' + (p.index === state.game.phaseIndex ? ' current' : '') +
                (n ? ' has' : '');
      return '<button class="' + cls + '" data-phase="' + p.index + '" title="' + esc(p.name) + '">' +
        '<span class="pc-short">' + esc(p.short) + '</span>' +
        (n ? '<span class="pc-dot">' + n + '</span>' : '') +
      '</button>';
    }).join('');

    var cur = $('#phase-rail .current');
    if (cur && cur.scrollIntoView) {
      cur.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  }

  function renderNow() {
    if (isLive()) { renderTurnBoard(); return; }
    var pid = phaseId();
    var hits = hitsFor(pid);
    var open = hits.filter(function (h) { return !isResolved(h); }).length;

    $('#now-phase').textContent = D.PHASES[state.game.phaseIndex].name;
    $('#now-count').textContent = hits.length
      ? open + ' of ' + hits.length + ' left'
      : 'nothing here';
    $('#now-count').classList.toggle('ok', hits.length > 0 && open === 0);

    var host = $('#now-list');
    if (!hits.length) {
      host.innerHTML = '<div class="empty small">No triggers in this step' +
        (board().length ? '.' : ' — add your permanents with <b>+ Card</b>.') + '</div>';
      return;
    }

    host.innerHTML = hits.map(triggerRow).join('');
  }

  function triggerRow(h) {
    {
      var done = isResolved(h);
      var st = stateFor(h.trigger, h.item.key, done);
      var text = st ? st.text : h.trigger.text;
      var critical = h.trigger.critical || (st && st.done && h.trigger.sequence.endCritical);

      var tags = '';
      if (st) {
        tags += '<span class="tag chapter">' + esc(st.display) + '</span>';
        if (st.done) { tags += '<span class="tag danger">' + (h.trigger.sequence.endCritical ? 'act now' : 'finished') + '</span>'; }
        else if (st.last) { tags += '<span class="tag warn">last one</span>'; }
      }
      if (critical && !st) { tags += '<span class="tag danger">must not miss</span>'; }
      if (h.trigger.conditional) { tags += '<span class="tag dim">only if you used it</span>'; }
      if (h.trigger.venture) { tags += '<span class="tag warn">venture into the dungeon</span>'; }
      if (h.trigger.scope === 'each') { tags += '<span class="tag">every turn</span>'; }
      if (h.item.zone !== 'battlefield') { tags += '<span class="tag dim">' + esc(h.item.zone) + '</span>'; }

      return '<button class="trigger' + (done ? ' done' : '') + (critical ? ' critical' : '') + '"' +
        ' data-hit="' + esc(h.item.key + '||' + h.trigger.id) + '">' +
        '<span class="tick">' + (done ? '&#10003;' : '') + '</span>' +
        '<span class="tbody">' +
          '<span class="tname">' + esc(h.item.name) + tags + '</span>' +
          '<span class="ttext">' + Mana.render(text) + '</span>' +
        '</span>' +
      '</button>';
    }
  }

  /**
   * edhplay has no phases — only rounds and turn order — so walking twelve
   * steps there is busywork. In live mode every trigger for the whole turn is
   * shown at once, grouped by when it happens.
   */
  function renderTurnBoard() {
    var groups = [];
    var total = 0;
    var open = 0;

    D.PHASES.forEach(function (p) {
      var hits = hitsFor(p.id);
      if (!hits.length) { return; }
      total += hits.length;
      open += hits.filter(function (h) { return !isResolved(h); }).length;
      groups.push({ phase: p, hits: hits });
    });

    $('#now-phase').textContent = state.game.myTurn ? 'Your turn' : "Opponent's turn";
    $('#now-count').textContent = total ? open + ' of ' + total + ' left' : 'nothing this turn';
    $('#now-count').classList.toggle('ok', total > 0 && open === 0);

    var host = $('#now-list');
    if (!groups.length) {
      host.innerHTML = '<div class="empty small">Nothing on your board triggers ' +
        (state.game.myTurn ? 'on your turn.' : "on an opponent's turn.") + '</div>';
      return;
    }

    host.innerHTML = groups.map(function (g) {
      return '<section class="step-group">' +
        '<h3 class="step-head">' + esc(g.phase.name) +
          '<span class="pill dim">' + g.hits.length + '</span></h3>' +
        g.hits.map(triggerRow).join('') +
      '</section>';
    }).join('');
  }

  var PT_TITLE = {
    tiers: 'Escalating this turn', first: 'First time each turn',
    once: 'Once each turn', nth: 'Counts up each turn', once_turn: 'Once per turn'
  };

  var SEQ_TITLE = {
    saga: 'Saga progress', class: 'Class levels', levelup: 'Level', siege: 'Siege defence',
    'case': 'Case', vanishing: 'Vanishing', fading: 'Fading', suspend: 'Suspended',
    cumulative: 'Cumulative upkeep', counters: 'Counters'
  };

  var ROMAN_OUT = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  function roman(n) { return ROMAN_OUT[n] || String(n); }

  function renderWatch() {
    var host = $('#watch-list');
    var block = host.parentNode;

    if (!state.settings.turnQuestions) {
      block.classList.add('hidden');
      return;
    }
    block.classList.remove('hidden');

    var groups = questions();
    var esc2 = escalating();

    // A question can only matter if one of its sources is actually on the
    // battlefield. The rest are kept behind a toggle rather than dropped, so a
    // deck still works with nothing tracked at all.
    var live = groups.filter(function (q) {
      return q.hits.some(function (h) { return isOnBoard(h.name); });
    });
    var dormant = groups.filter(function (q) {
      return !q.hits.some(function (h) { return isOnBoard(h.name); });
    });

    $('#watch-count').textContent = live.length + esc2.length;

    if (!groups.length && !esc2.length) {
      host.innerHTML = '<div class="empty small">Nothing in this deck triggers off events.</div>';
      return;
    }

    var html = esc2.map(escalatingRow).join('') +
               live.map(function (q) { return questionRow(q, false); }).join('');

    if (!live.length && !esc2.length) {
      html += '<div class="empty small">Nothing you control triggers off events yet.' +
        (isLive() ? '' : ' Track a card with <b>+ Card</b> and its questions appear here.') + '</div>';
    }

    if (dormant.length) {
      html += '<button class="q-more-toggle" id="toggle-dormant">' +
        (showDormant ? 'Hide' : 'Show') + ' ' + dormant.length +
        ' question' + (dormant.length === 1 ? '' : 's') + ' for cards not in play' +
        '<span class="chev">' + (showDormant ? '&#9662;' : '&#9656;') + '</span></button>';
      if (showDormant) {
        html += '<div class="dormant-list">' +
          dormant.map(function (q) { return questionRow(q, false); }).join('') + '</div>';
      }
    }

    host.innerHTML = html;
  }

  /**
   * An ability that does something different each time it resolves in a turn.
   * Tapping it counts one resolution and shows what that resolution does.
   */
  function escalatingRow(e) {
    var times = tierCount(e.item.key, e.trigger.id);
    var ts = Trig.perTurnState(e.trigger.perTurn, times);

    return '<div class="question escalating' + (times ? ' answered' : '') +
      (ts.spent ? ' spent' : '') + '">' +
      '<button class="q-main" data-esc="' + esc(e.item.key + '||' + e.trigger.id) + '">' +
        '<span class="q-ask">' + esc(e.item.name) +
          '<span class="tag ' + (ts.spent ? 'dim' : 'chapter') + '">' + esc(ts.badge) + '</span>' +
          (e.trigger.venture ? '<span class="tag warn">venture</span>' : '') +
        '</span>' +
        '<span class="q-tier">' + Mana.render(ts.text) + '</span>' +
      '</button>' +
      (times
        ? '<button class="q-count" data-escclear="' + esc(e.item.key + '||' + e.trigger.id) +
          '" title="Tap to reset">&times;' + times + '</button>'
        : '<span class="q-hint">tap</span>') +
    '</div>';
  }

  /** One tappable question. Tapping it counts an occurrence and names the cards. */
  function questionRow(q, wide) {
    var n = answerCount(q.event.id);
    var live = q.hits.filter(function (h) { return isOnBoard(h.name); });
    var names = q.hits.slice().sort(function (a, b) {
      return (isOnBoard(b.name) ? 1 : 0) - (isOnBoard(a.name) ? 1 : 0) || a.name.localeCompare(b.name);
    });

    // On the play screen the chips stay on one line — the full list is in the
    // sweep and in the toast you get when you tap.
    var shown = wide ? names : names.slice(0, 3);
    var hidden = names.length - shown.length;

    return '<div class="question' + (n ? ' answered' : '') + (wide ? ' wide' : '') + '">' +
      '<button class="q-main" data-ask="' + esc(q.event.id) + '">' +
        '<span class="q-ask">' + esc(q.event.ask) + '</span>' +
        '<span class="q-cards">' + shown.map(function (h) {
          return '<span class="q-card' + (isOnBoard(h.name) ? ' live' : '') + '" title="' +
            esc(h.trigger.text) + '">' + esc(h.name) + '</span>';
        }).join('') +
        (hidden > 0 ? '<span class="q-more">+' + hidden + '</span>' : '') + '</span>' +
        (live.length ? '<span class="q-live">' + live.length + ' in play</span>' : '') +
      '</button>' +
      (n
        ? '<button class="q-count" data-clear="' + esc(q.event.id) + '" title="Tap to reset">&times;' + n + '</button>'
        : '<span class="q-hint">tap</span>') +
    '</div>';
  }

  function renderSweep() {
    var groups = questions();
    var unanswered = groups.filter(function (q) { return !answerCount(q.event.id); });
    $('#sweep-hint').textContent = unanswered.length
      ? 'These have not come up yet this turn. Tap any that did happen.'
      : 'Everything has been accounted for this turn.';
    $('#sweep-body').innerHTML = groups.length
      ? groups.map(function (q) { return questionRow(q, true); }).join('')
      : '<div class="empty small">This deck has no event triggers to check.</div>';
  }

  function openSweep() {
    renderSweep();
    $('#modal-sweep').classList.remove('hidden');
  }

  function renderBoard() {
    var head = $('#toggle-board');
    if (head) {
      head.querySelector('span').firstChild.nodeValue =
        isLive() ? 'On your board ' : 'Tracked cards ';
    }
    var active = activeBoard();
    var gone = goneBoard();
    $('#board-count').textContent = active.length;

    var host = $('#board-list');
    if (!active.length && !gone.length) {
      host.innerHTML = isLive()
        ? '<div class="empty small">Waiting for cards to hit your battlefield on edhplay.</div>'
        : '<div class="empty small">Tap <b>+ Card</b> only for permanents that fire ' +
          'on their own schedule — upkeep, end step, combat. Everything else is covered by the ' +
          'questions above.</div>';
      return;
    }

    var html = active.map(function (it) {
      var n = phaseTriggerCount(it.name);
      var seq = sequenceOf(it.name);
      var badge;
      if (seq) {
        var st = Trig.sequenceState(seq, stepsOf(it.key));
        badge = '<span class="pill chapter-pill">' +
          (st.done ? 'done' : (seq.roman ? roman(st.value) : st.value)) + '</span>';
      } else {
        badge = n ? '<span class="pill dim">' + n + '</span>' : '';
      }
      return '<span class="board-item">' +
        '<button class="board-chip zone-' + esc(it.zone) + '" data-inst="' + esc(it.key) + '">' +
          esc(it.name) + badge +
        '</button>' +
        '<button class="board-bury" data-bury="' + esc(it.key) + '" ' +
          'aria-label="Send ' + esc(it.name) + ' to the graveyard" title="To graveyard">&#9013;</button>' +
      '</span>';
    }).join('');

    if (!active.length) {
      html = '<div class="empty small">Nothing is being tracked right now.</div>';
    }

    if (gone.length) {
      html += '<div class="gone-row">' +
        '<span class="gone-label">Left play</span>' +
        gone.map(function (it) {
          return '<span class="board-item">' +
            '<button class="board-chip gone zone-' + esc(it.zone) + '" data-inst="' + esc(it.key) + '">' +
              esc(it.name) +
            '</button>' +
            '<button class="board-bury revive" data-revive="' + esc(it.key) + '" ' +
              'aria-label="Return ' + esc(it.name) + ' to the battlefield" title="Back to play">&#8617;</button>' +
          '</span>';
        }).join('') +
      '</div>';
    }

    host.innerHTML = html;
  }

  /* ---------------- add-card modal ---------------- */

  function openAdd() {
    if (isLive()) { return; }   // the board is mirrored, nothing to add
    $('#modal-add').classList.remove('hidden');
    $('#add-search').value = '';
    renderAdd();
    setTimeout(function () { $('#add-search').focus(); }, 40);
  }

  function renderAdd() {
    var deck = activeDeck();
    if (!deck) { return; }
    var q = $('#add-search').value.trim().toLowerCase();

    var rows = deck.entries.filter(function (e) {
      if (addFilter === 'tracked' && !needsTracking(e.name)) { return false; }
      if (addFilter === 'triggers' && !triggerCount(e.name)) { return false; }
      if (q && e.name.toLowerCase().indexOf(q) === -1) {
        var card = cardsByName[e.name.toLowerCase()];
        if (!card || (card.oracle_text || '').toLowerCase().indexOf(q) === -1) { return false; }
      }
      return true;
    });

    // Bucket by type before applying the type filter, so the chips always show
    // what is actually reachable from here.
    var buckets = {};
    rows.forEach(function (e) {
      var g = typeGroupOf(e.name);
      (buckets[g.id] = buckets[g.id] || []).push(e);
    });

    var present = TYPE_GROUPS.filter(function (g) { return buckets[g.id]; });
    if (typeFilter !== 'all' && !buckets[typeFilter]) { typeFilter = 'all'; }

    $('#add-types').innerHTML = present.length < 2 ? '' :
      ['<button class="chip' + (typeFilter === 'all' ? ' active' : '') + '" data-type="all">All ' +
        '<span class="pill dim">' + rows.length + '</span></button>']
      .concat(present.map(function (g) {
        return '<button class="chip' + (typeFilter === g.id ? ' active' : '') + '" data-type="' + g.id + '">' +
          esc(g.label) + ' <span class="pill dim">' + buckets[g.id].length + '</span></button>';
      })).join('');

    var host = $('#add-results');
    if (!rows.length) {
      host.innerHTML = '<div class="empty small">Nothing matches.</div>';
      return;
    }

    var shown = present.filter(function (g) { return typeFilter === 'all' || g.id === typeFilter; });

    host.innerHTML = shown.map(function (g) {
      var list = buckets[g.id].slice().sort(function (a, b) {
        return triggerCount(b.name) - triggerCount(a.name) || a.name.localeCompare(b.name);
      });
      return '<section class="type-section">' +
        '<h4 class="type-head">' + esc(g.label) + '<span class="pill dim">' + list.length + '</span></h4>' +
        '<div class="card-grid">' + list.map(cardTile).join('') + '</div>' +
      '</section>';
    }).join('');
  }

  function cardTile(entry) {
    var free = freeInstance(entry);
    // In the tracking view the phase-trigger count is the number that matters.
    var n = addFilter === 'tracked' ? phaseTriggerCount(entry.name) : triggerCount(entry.name);
    var card = cardsByName[entry.name.toLowerCase()];
    var src = card && (card.thumb || card.image);
    var left = countAvailable(entry);

    return '<button class="card-tile' + (free ? '' : ' out') + '" data-add="' + esc(entry.name) + '"' +
      (free ? '' : ' disabled') + ' title="' + esc(entry.name) + '">' +
      '<span class="ct-img">' +
        (src
          ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">'
          : '<span class="ct-fallback">' + esc(entry.name) + '</span>') +
      '</span>' +
      (n ? '<span class="ct-badge" title="' + n + ' reminders">' + n + '</span>' : '') +
      (entry.qty > 1 && left > 0 ? '<span class="ct-qty">&times;' + left + '</span>' : '') +
      (free ? '' : '<span class="ct-out">all in play</span>') +
      '<span class="ct-name">' + esc(entry.name) + '</span>' +
    '</button>';
  }

  /** Copies of this entry that could be put into play right now. */
  function countAvailable(entry) {
    var free = 0;
    for (var i = 0; i < entry.qty; i++) {
      var z = zoneOf(instKey(entry.name, i));
      if (z === 'deck' || GONE_ZONES[z]) { free++; }
    }
    return free;
  }

  function addToBattlefield(name) {
    var deck = activeDeck();
    var entry = null;
    deck.entries.forEach(function (e) { if (e.name === name) { entry = e; } });
    if (!entry) { return; }
    var key = freeInstance(entry);
    if (!key) { toast('All copies are already out.'); return; }
    setZone(key, 'battlefield');
    buzz(18);
    renderPlay();

    // Re-rendering the grid would throw away the user's place in it.
    var results = $('#add-results');
    var top = results.scrollTop;
    renderAdd();
    results.scrollTop = top;

    toast(name + ' → battlefield');
  }

  /* ---------------- card detail modal ---------------- */

  function openCardByName(name) {
    var deck = activeDeck();
    var entry = null;
    deck.entries.forEach(function (e) { if (e.name === name) { entry = e; } });
    if (!entry) { return; }
    var key = null;
    for (var i = 0; i < entry.qty; i++) {
      var k = instKey(name, i);
      if (zoneOf(k) !== 'deck') { key = k; break; }
    }
    openInstance(key || instKey(name, 0));
  }

  function openInstance(key) {
    detailKey = key;
    var name = key.split('§')[0];
    var card = cardsByName[name.toLowerCase()];
    var a = analysis[name];

    $('#detail-name').textContent = name;
    $('#detail-zones').innerHTML = ZONES.map(function (z) {
      return '<button class="chip' + (zoneOf(key) === z.id ? ' active' : '') +
        '" data-zone="' + z.id + '">' + esc(z.label) + '</button>';
    }).join('');

    var html = '';
    if (card) {
      var art = card.image || card.thumb;
      html += '<div class="detail-top">' +
        (art ? '<img class="detail-art" src="' + esc(art) + '" alt="" loading="lazy" decoding="async">' : '') +
        '<div class="detail-type">' + esc(card.type_line || '') +
          (card.mana_cost ? '<span class="cost"> ' + Mana.render(card.mana_cost) + '</span>' : '') + '</div>' +
      '</div>';
    }

    // Anything sequenced gets a counter you can also correct by hand.
    var seq = sequenceOf(name);
    if (seq) {
      var steps = stepsOf(key);
      var cur = Trig.sequenceState(seq, steps);
      var keys = Object.keys(seq.stages || {}).map(Number)
        .sort(function (x, y) { return x - y; });

      html += '<h3>' + esc(SEQ_TITLE[seq.kind] || 'Progress') + '</h3>' +
        '<div class="saga-box">' +
          '<div class="saga-head">' +
            '<button class="btn ghost small" data-lore="-1" aria-label="Step back">&minus;</button>' +
            '<span class="saga-state">' + esc(cur.display) +
              (cur.done ? '' : '<span class="muted"> · next</span>') +
            '</span>' +
            '<button class="btn ghost small" data-lore="1" aria-label="Step forward">+</button>' +
          '</div>' +
          (keys.length
            ? keys.map(function (n) {
                var pos = seq.dir === 'down' ? null
                  : cur.done ? ' done'
                  : (n < cur.value ? ' done' : (n === cur.value ? ' next' : ''));
                var label = seq.roman ? roman(n)
                  : (seq.stageNames && seq.stageNames[n]) ? seq.stageNames[n] : String(n);
                var cost = seq.costs && seq.costs[n]
                  ? '<span class="sc-cost">' + Mana.render(seq.costs[n]) + '</span>' : '';
                return '<div class="saga-chapter' + (pos || '') + '">' +
                  '<span class="sc-num">' + esc(label) + '</span>' +
                  '<span class="sc-text">' + Mana.render(seq.stages[n]) + cost + '</span>' +
                '</div>';
              }).join('')
            : '<div class="saga-chapter next"><span class="sc-num">&bull;</span>' +
              '<span class="sc-text">' + Mana.render(cur.text) + '</span></div>') +
          (seq.levelCost ? '<div class="muted" style="margin-top:6px">Level up ' +
            Mana.render(seq.levelCost) + '</div>' : '') +
          (seq.upkeepCost ? '<div class="muted" style="margin-top:6px">Cumulative upkeep ' +
            Mana.render(seq.upkeepCost) + ' per age counter</div>' : '') +
        '</div>';
    }

    // Escalating abilities: how many times it has resolved this turn.
    if (a) {
      a.triggers.concat(a.statics).filter(function (t) { return t.perTurn; }).forEach(function (t) {
        var pt = t.perTurn;
        var ts = Trig.perTurnState(pt, tierCount(key, t.id));
        var steps = pt.steps || [{ n: pt.n || 1, text: t.text }];
        html += '<h3>' + esc(PT_TITLE[pt.mode] || 'This turn') + '</h3>' +
          '<div class="saga-box">' +
            '<div class="saga-head">' +
              '<button class="btn ghost small" data-tier="-1" data-tid="' + esc(t.id) + '">&minus;</button>' +
              '<span class="saga-state">' + esc(ts.badge) +
                '<span class="muted"> · ' + ts.time + ' so far</span></span>' +
              '<button class="btn ghost small" data-tier="1" data-tid="' + esc(t.id) + '">+</button>' +
            '</div>' +
            steps.map(function (st) {
              var pos = st.n < ts.time ? ' done' : (st.n === ts.capped && !ts.spent ? ' next' : '');
              return '<div class="saga-chapter' + pos + '">' +
                '<span class="sc-num">' + st.n + '</span>' +
                '<span class="sc-text">' + Mana.render(st.text) + '</span>' +
              '</div>';
            }).join('') +
          '</div>';
      });
    }

    if (a && a.triggers.length) {
      html += '<h3>Triggers</h3>' + a.triggers.map(function (t) {
        var when = t.type === 'phase'
          ? (D.PHASE_BY_ID[t.phase] ? D.PHASE_BY_ID[t.phase].name : t.phase)
          : (D.EVENT_BY_ID[t.event] ? D.EVENT_BY_ID[t.event].name : t.event);
        if (t.sequence) { return ''; }   // shown by the progress block above
        return '<div class="detail-trigger' + (t.critical ? ' critical' : '') + '">' +
          '<div class="dt-when">' + esc(when) +
            (t.scope === 'each' ? ' <span class="tag">every turn</span>' : '') +
            (t.scope === 'opp' ? ' <span class="tag">opponents only</span>' : '') +
            (t.conditional ? ' <span class="tag dim">only if you used it</span>' : '') +
            (t.venture ? ' <span class="tag warn">venture</span>' : '') + '</div>' +
          '<div class="dt-text">' + Mana.render(t.text) + '</div>' +
        '</div>';
      }).join('');
    }

    if (a && a.statics.length) {
      html += '<h3>Keep in mind</h3>' + a.statics.map(function (s) {
        return '<div class="detail-trigger static">' +
          '<div class="dt-when">' + esc(s.label) + '</div>' +
          '<div class="dt-text">' + Mana.render(s.text) + '</div>' +
        '</div>';
      }).join('');
    }

    if (card && (card.oracle_text || (card.faces && card.faces.length))) {
      var full = card.faces && card.faces.length
        ? card.faces.map(function (f) { return f.name + '\n' + f.oracle_text; }).join('\n\n')
        : card.oracle_text;
      html += '<h3>Full text</h3><pre class="oracle">' + Mana.render(full) + '</pre>';
    }

    if (!a || !a.hasAny) {
      html += '<div class="empty small">No triggers or reminders detected on this card.</div>';
    }

    if (card && card.scryfall_uri) {
      html += '<p><a class="btn ghost small" href="' + esc(card.scryfall_uri) +
              '" target="_blank" rel="noopener">Open on Scryfall</a></p>';
    }

    $('#detail-body').innerHTML = html;
    $('#modal-card').classList.remove('hidden');
  }

  /* ---------------- trigger sheet ---------------- */

  function renderSheet() {
    var deck = activeDeck();
    if (!deck) { return; }
    $('#sheet-sub').textContent = deck.name;
    var q = $('#sheet-search').value.trim().toLowerCase();

    var phaseBuckets = {};
    var eventBuckets = {};
    var statics = [];

    deck.entries.forEach(function (e) {
      var a = analysis[e.name];
      if (!a) { return; }
      if (q && e.name.toLowerCase().indexOf(q) === -1) {
        var any = a.triggers.concat(a.statics).some(function (t) {
          return t.text.toLowerCase().indexOf(q) !== -1;
        });
        if (!any) { return; }
      }
      a.triggers.forEach(function (t) {
        if (t.type === 'phase') {
          (phaseBuckets[t.phase] = phaseBuckets[t.phase] || []).push({ name: e.name, t: t });
        } else {
          (eventBuckets[t.event] = eventBuckets[t.event] || []).push({ name: e.name, t: t });
        }
      });
      a.statics.forEach(function (s) { statics.push({ name: e.name, t: s }); });
    });

    var html = '';

    D.PHASES.forEach(function (p) {
      var rows = phaseBuckets[p.id];
      if (!rows || !rows.length) { return; }
      html += section(p.name, rows.length, rows);
    });

    D.EVENTS.forEach(function (ev) {
      var rows = eventBuckets[ev.id];
      if (!rows || !rows.length) { return; }
      html += section(ev.name, rows.length, rows);
    });

    if (statics.length) { html += section('Keep in mind', statics.length, statics); }

    $('#sheet-body').innerHTML = html || '<div class="empty">Nothing matches that filter.</div>';
  }

  function section(title, count, rows) {
    rows.sort(function (a, b) {
      return (b.t.critical ? 1 : 0) - (a.t.critical ? 1 : 0) || a.name.localeCompare(b.name);
    });
    return '<section class="sheet-section">' +
      '<h3>' + esc(title) + ' <span class="pill dim">' + count + '</span></h3>' +
      rows.map(function (r) {
        return '<div class="sheet-row' + (r.t.critical ? ' critical' : '') + '" data-card="' + esc(r.name) + '">' +
          '<b>' + esc(r.name) + '</b>' +
          (r.t.scope === 'each' ? '<span class="tag">every turn</span>' : '') +
          (r.t.critical ? '<span class="tag danger">must not miss</span>' : '') +
          '<span class="muted">' + Mana.render(r.t.text) + '</span>' +
        '</div>';
      }).join('') +
    '</section>';
  }

  /* ---------------- settings ---------------- */

  function renderSettings() {
    $('#set-nag').checked = !!state.settings.nagOnAdvance;
    $('#set-haptics').checked = !!state.settings.haptics;
    $('#set-skip').checked = !!state.settings.skipEmptySteps;
    $('#set-questions').checked = !!state.settings.turnQuestions;
    $('#set-sweep').checked = !!state.settings.endTurnSweep;
    $('#set-autotrack').checked = !!state.settings.autoTrack;
    var row = $('#row-autotrack');
    if (row) { row.classList.toggle('hidden', !(global.MTGBridge && global.MTGBridge.available)); }
    $('#cache-info').textContent = Scry.cacheSize() + ' cards cached.';

    var live = $('#live-info');
    if (live) {
      if (!(global.MTGBridge && global.MTGBridge.available)) {
        live.textContent = 'Board reading is only available in the Chrome extension.';
      } else if (!liveSnapshot) {
        live.textContent = 'No board seen yet — checking open tabs...';
        global.MTGBridge.ensureInjected(function (report) {
          if (!report) { live.textContent = 'No board seen yet, and the reader could not be started.'; return; }
          if (!report.tabs) {
            live.textContent = 'No edhplay tab is open in this window set. Open your game, then reopen this panel.';
          } else {
            live.textContent = 'Found ' + report.tabs + ' edhplay tab(s), started the reader on ' +
              report.injected + '. If the board still does not appear, the page markup has changed.' +
              (report.errors.length ? ' Errors: ' + report.errors.join('; ') : '');
          }
        });
      } else {
        live.textContent = 'Last board: ' + (liveSnapshot.cards || []).length + ' identified card(s), ' +
          snapshotPlayers(liveSnapshot).length + ' player(s), zones seen: ' +
          Object.keys(liveSnapshot.zoneCounts || {}).join(', ') + '.';
      }
    }
    var build = VERSION;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        build = chrome.runtime.getManifest().version + ' (extension)';
      }
    } catch (e) { /* not an extension */ }
    $('#version-line').textContent = 'Version ' + build;
  }

  /* ---------------- event wiring ---------------- */

  function bind() {
    // --- decks screen
    $('#btn-import').addEventListener('click', function () {
      importDeck($('#deck-name').value, $('#deck-text').value);
    });
    $('#btn-sample').addEventListener('click', function () {
      $('#deck-name').value = global.MTGSample.name;
      $('#deck-text').value = global.MTGSample.text;
      toast('Sample list loaded — hit Import.');
    });
    $('#deck-list').addEventListener('click', function (ev) {
      var play = ev.target.closest('[data-play]');
      if (play) { startGame(play.getAttribute('data-play')); return; }
      var del = ev.target.closest('[data-del]');
      if (del) {
        var id = del.getAttribute('data-del');
        var d = deckById(id);
        if (d && confirm('Delete "' + d.name + '"?')) {
          state.decks = state.decks.filter(function (x) { return x.id !== id; });
          if (state.game && state.game.deckId === id) { state.game = null; }
          persist();
          renderDecks();
        }
        return;
      }
      var row = ev.target.closest('[data-deck]');
      if (row) { startGame(row.getAttribute('data-deck')); }
    });

    // --- navigation
    $('#btn-settings').addEventListener('click', function () { renderSettings(); showScreen('screen-settings'); });
    $('#btn-back-settings').addEventListener('click', function () {
      showScreen(state.game ? 'screen-play' : 'screen-decks');
    });
    $('#btn-back-decks').addEventListener('click', function () { renderDecks(); showScreen('screen-decks'); });
    $('#btn-open-sheet').addEventListener('click', function () { renderSheet(); showScreen('screen-sheet'); });
    $('#btn-back-play').addEventListener('click', function () { showScreen('screen-play'); });
    $('#sheet-search').addEventListener('input', renderSheet);
    $('#sheet-body').addEventListener('click', function (ev) {
      var row = ev.target.closest('[data-card]');
      if (row) { openCardByName(row.getAttribute('data-card')); }
    });

    // --- play controls
    $('#seg-you').addEventListener('click', function () {
      state.game.myTurn = true; persist(); renderPlay();
    });
    $('#seg-opp').addEventListener('click', function () {
      state.game.myTurn = false; persist(); renderPlay();
    });
    // Wrapped: passing endTurn directly hands it the click event as `skipSweep`.
    $('#btn-next-turn').addEventListener('click', function () { endTurn(); });
    $('#btn-next-phase').addEventListener('click', nextPhase);
    $('#btn-prev-phase').addEventListener('click', function () { setPhase(state.game.phaseIndex - 1); });
    $('#btn-add-card').addEventListener('click', openAdd);

    $('#live-bar').addEventListener('click', function (ev) {
      var pick = ev.target.closest('[data-player]');
      if (pick) {
        state.settings.edhPlayer = pick.getAttribute('data-player');
        persist();
        lastSnapshotKey = '';
        if (liveSnapshot) { applySnapshot(liveSnapshot); }
        renderLiveBar();
        return;
      }
      if (ev.target.closest('#btn-change-player')) {
        state.settings.edhPlayer = null;
        // Ignore the page's own guess so the choice is genuinely re-asked.
        if (liveSnapshot) { liveSnapshot.self = null; }
        persist();
        renderLiveBar();
      }
    });

    $('#phase-rail').addEventListener('click', function (ev) {
      var chip = ev.target.closest('[data-phase]');
      if (chip) { setPhase(parseInt(chip.getAttribute('data-phase'), 10), true); }
    });

    $('#now-list').addEventListener('click', function (ev) {
      var el = ev.target.closest('[data-hit]');
      if (!el) { return; }
      var parts = el.getAttribute('data-hit').split('||');
      var hits = hitsFor(phaseId());
      for (var i = 0; i < hits.length; i++) {
        if (hits[i].item.key === parts[0] && hits[i].trigger.id === parts[1]) {
          toggleResolved(hits[i]);
          buzz(12);
          renderPlay();
          return;
        }
      }
    });

    $('#board-list').addEventListener('click', function (ev) {
      var bury = ev.target.closest('[data-bury]');
      if (bury) {
        var bk = bury.getAttribute('data-bury');
        setZone(bk, 'graveyard');
        buzz(16);
        renderPlay();
        toast(bk.split('§')[0] + ' → graveyard. It can be played again from + Card.');
        return;
      }
      var revive = ev.target.closest('[data-revive]');
      if (revive) {
        var rk = revive.getAttribute('data-revive');
        setZone(rk, 'battlefield');
        buzz(16);
        renderPlay();
        toast(rk.split('§')[0] + ' → battlefield');
        return;
      }
      var chip = ev.target.closest('[data-inst]');
      if (chip) { openInstance(chip.getAttribute('data-inst')); }
    });
    bindQuestions('#watch-list');
    bindQuestions('#sweep-body');

    $('#btn-close-sweep').addEventListener('click', function () {
      $('#modal-sweep').classList.add('hidden');
    });
    $('#btn-sweep-done').addEventListener('click', function () { endTurn(true); });

    collapsible('#toggle-watch', '#watch-list');
    collapsible('#toggle-board', '#board-list');

    // --- add modal
    $('#btn-close-add').addEventListener('click', function () { $('#modal-add').classList.add('hidden'); });
    $('#add-search').addEventListener('input', renderAdd);
    $('#add-filters').addEventListener('click', function (ev) {
      var chip = ev.target.closest('[data-filter]');
      if (!chip) { return; }
      addFilter = chip.getAttribute('data-filter');
      $$('#add-filters .chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
      renderAdd();
    });
    $('#add-types').addEventListener('click', function (ev) {
      var chip = ev.target.closest('[data-type]');
      if (!chip) { return; }
      typeFilter = chip.getAttribute('data-type');
      renderAdd();
      $('#add-results').scrollTop = 0;
    });
    $('#add-results').addEventListener('click', function (ev) {
      var row = ev.target.closest('[data-add]');
      if (row && !row.disabled) { addToBattlefield(row.getAttribute('data-add')); }
    });

    // --- card modal
    $('#btn-close-card').addEventListener('click', function () { $('#modal-card').classList.add('hidden'); });
    $('#detail-zones').addEventListener('click', function (ev) {
      var chip = ev.target.closest('[data-zone]');
      if (!chip || !detailKey) { return; }
      setZone(detailKey, chip.getAttribute('data-zone'));
      openInstance(detailKey);
      renderPlay();
    });
    $('#detail-body').addEventListener('click', function (ev) {
      if (!detailKey) { return; }
      var tier = ev.target.closest('[data-tier]');
      if (tier) {
        bumpTier(detailKey, tier.getAttribute('data-tid'), parseInt(tier.getAttribute('data-tier'), 10));
        openInstance(detailKey);
        renderPlay();
        return;
      }
      var step = ev.target.closest('[data-lore]');
      if (!step) { return; }
      var seq = sequenceOf(detailKey.split('§')[0]);
      var cap = seq ? ((seq.dir === 'down' ? seq.start : seq.max) || 0) : 0;
      var next = stepsOf(detailKey) + parseInt(step.getAttribute('data-lore'), 10);
      setSteps(detailKey, (!seq || seq.openEnded) ? Math.max(0, next) : Math.max(0, Math.min(next, cap)));
      openInstance(detailKey);
      renderPlay();
    });

    $$('.modal').forEach(function (m) {
      m.addEventListener('click', function (ev) {
        if (ev.target === m) { m.classList.add('hidden'); }
      });
    });

    // --- settings
    bindToggle('#set-nag', 'nagOnAdvance');
    bindToggle('#set-haptics', 'haptics');
    bindToggle('#set-skip', 'skipEmptySteps');
    bindToggle('#set-questions', 'turnQuestions');
    bindToggle('#set-sweep', 'endTurnSweep');
    bindToggle('#set-autotrack', 'autoTrack');

    $('#btn-copy-diag').addEventListener('click', function () {
      var report = {
        version: (function () {
          try { return chrome.runtime.getManifest().version; } catch (e) { return VERSION; }
        })(),
        extension: !!(global.MTGBridge && global.MTGBridge.available),
        snapshot: liveSnapshot || null
      };
      var text = JSON.stringify(report, null, 2);

      // Always show it as well: a side panel can lose clipboard permission and
      // then the button would look like it did nothing.
      var box = $('#diag-dump');
      box.value = text;
      box.classList.remove('hidden');
      box.focus();
      box.select();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          toast('Diagnostics copied — paste them to me.');
        }, function () {
          toast('Could not copy automatically — the text below is selected.');
        });
      } else {
        toast('Select the text below and copy it.');
      }
    });

    $('#btn-clear-cache').addEventListener('click', function () {
      if (!confirm('Clear cached card text? You will need a connection to reload it.')) { return; }
      Scry.clearCache();
      renderSettings();
      toast('Card cache cleared.');
    });
    $('#btn-export').addEventListener('click', function () {
      var blob = new Blob([Store.exportState(state)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'trigger-tracker-backup.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    $('#btn-import-file').addEventListener('click', function () { $('#file-input').click(); });
    $('#file-input').addEventListener('change', function (ev) {
      var file = ev.target.files[0];
      if (!file) { return; }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          state = Store.importState(reader.result);
          persist();
          renderDecks();
          renderSettings();
          toast('Backup restored.');
        } catch (e) {
          toast(e.message);
        }
      };
      reader.readAsText(file);
      ev.target.value = '';
    });

    // --- keyboard shortcuts for laptop play
    document.addEventListener('keydown', function (ev) {
      if (/^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) { return; }
      if ($('#screen-play').classList.contains('hidden')) { return; }
      if (ev.key === 'ArrowRight' || ev.key === ' ') { ev.preventDefault(); nextPhase(); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); setPhase(state.game.phaseIndex - 1); }
      else if (ev.key === 'Escape') { $$('.modal').forEach(function (m) { m.classList.add('hidden'); }); }
      else if (ev.key.toLowerCase() === 'a' && !isLive()) { ev.preventDefault(); openAdd(); }
      else if (ev.key.toLowerCase() === 't' && !isLive()) { endTurn(); }
    });
  }

  function bindQuestions(sel) {
    $(sel).addEventListener('click', function (ev) {
      var escStep = ev.target.closest('[data-esc]');
      if (escStep) {
        var p = escStep.getAttribute('data-esc').split('||');
        bumpTier(p[0], p[1], 1);
        buzz(14);
        renderPlay();
        return;
      }
      var escClear = ev.target.closest('[data-escclear]');
      if (escClear) {
        var q = escClear.getAttribute('data-escclear').split('||');
        bumpTier(q[0], q[1], -tierCount(q[0], q[1]));
        renderPlay();
        return;
      }
      if (ev.target.closest('#toggle-dormant')) {
        showDormant = !showDormant;
        renderWatch();
        return;
      }
      var clear = ev.target.closest('[data-clear]');
      if (clear) { clearAnswer(clear.getAttribute('data-clear')); return; }
      var card = ev.target.closest('.q-card');
      if (card) { openCardByName(card.textContent); return; }
      var ask = ev.target.closest('[data-ask]');
      if (ask) { answerQuestion(ask.getAttribute('data-ask')); }
    });
  }

  function collapsible(btnSel, bodySel) {
    $(btnSel).addEventListener('click', function () {
      var body = $(bodySel);
      var open = body.classList.toggle('collapsed');
      $(btnSel).setAttribute('aria-expanded', String(!open));
      $(btnSel).querySelector('.chev').innerHTML = open ? '&#9656;' : '&#9662;';
    });
  }

  function bindToggle(sel, key) {
    $(sel).addEventListener('change', function (ev) {
      state.settings[key] = ev.target.checked;
      persist();
      // Several settings change what the play screen shows, so redraw it now
      // rather than waiting for the next interaction.
      if (state.game && activeDeck()) { renderPlay(); }
    });
  }

  /* ---------------- live board from edhplay ---------------- */

  // Zones the page reports, mapped onto the app's own names.
  // Deliberately no "hand": cards you are holding are not on the board and
  // should not be tracked as though they were.
  // Names taken from a live game rather than guessed: the command zone comes
  // through as "commandZone".
  var EDH_ZONES = {
    battlefield: 'battlefield',
    graveyard: 'graveyard',
    exile: 'exile',
    commandZone: 'command',
    command_zone: 'command',
    command: 'command',
    commander: 'command'
  };

  var LIVE_DECK_ID = 'live-edhplay';
  var lastSnapshotKey = '';
  var liveSnapshot = null;

  function startBoardBridge() {
    if (!global.MTGBridge || !global.MTGBridge.available) { return; }
    global.MTGBridge.subscribe(function (snap) {
      liveSnapshot = snap;
      if (!state.settings.autoTrack) { return; }
      applySnapshot(snap);
    });
  }

  function isLive() { return !!(state.game && state.game.deckId === LIVE_DECK_ID); }

  /** Players the page can see, so you can say which one is you. */
  function snapshotPlayers(snap) {
    var seen = {};
    (snap.cards || []).forEach(function (c) { if (c.player) { seen[c.player] = 1; } });
    return Object.keys(seen);
  }

  function chosenPlayer(snap) {
    var picked = state.settings.edhPlayer;
    var players = snapshotPlayers(snap);
    if (picked && players.indexOf(picked) !== -1) { return picked; }
    if (snap.selfLabel) { return snap.selfLabel; }
    if (snap.self) { return snap.self; }
    return players.length === 1 ? players[0] : null;
  }

  /**
   * The board is the source of truth: build the tracked deck out of whatever is
   * on it. Nothing needs importing and no card ever has to be added by hand.
   */
  function applySnapshot(snap) {
    if (!snap || !snap.cards || !snap.cards.length) { return; }

    var me = chosenPlayer(snap);
    if (!me) { renderLiveBar(); return; }   // ambiguous: let the player choose

    var mine = snap.cards.filter(function (c) {
      return c.player === me && EDH_ZONES[c.zone];
    });

    var fingerprint = me + '#' + snap.turn + '#' + snap.activePlayer + '#' +
      mine.map(function (c) { return c.cardId + ':' + c.zone; }).sort().join('|');
    if (fingerprint === lastSnapshotKey) { return; }
    lastSnapshotKey = fingerprint;

    Scry.namesForIds(mine.map(function (c) { return c.scryfallId; })).then(function (names) {
      var zonesByName = {};
      mine.forEach(function (c) {
        var name = names[String(c.scryfallId).toLowerCase()];
        if (!name) { return; }
        (zonesByName[name] = zonesByName[name] || []).push(EDH_ZONES[c.zone]);
      });

      var deckNames = Object.keys(zonesByName).sort();
      var deck = deckById(LIVE_DECK_ID);
      if (!deck) {
        deck = { id: LIVE_DECK_ID, name: 'edhplay board', created: new Date().toISOString(),
                 live: true, entries: [] };
        state.decks.push(deck);
      }
      deck.entries = deckNames.map(function (name) {
        return { qty: zonesByName[name].length, name: name, section: 'deck', isCommander: false };
      });

      // Switch the game over to the live board the first time one shows up.
      if (!state.game || state.game.deckId !== LIVE_DECK_ID) {
        state.game = { deckId: LIVE_DECK_ID, turn: 1, phaseIndex: 1, myTurn: true,
                       zones: {}, resolved: {}, answers: {}, counters: {}, tiers: {} };
        state.activeDeckId = LIVE_DECK_ID;
      }

      hydrate(deck);

      var zones = {};
      deckNames.forEach(function (name) {
        zonesByName[name].forEach(function (zone, i) { zones[instKey(name, i)] = zone; });
      });
      state.game.zones = zones;

      followGameTurn(snap, me);
      reactToChanges(mine, names);

      persist();
      if ($('#screen-decks').classList.contains('hidden') === false) { showScreen('screen-play'); }
      renderPlay();
    });
  }

  /* ---------------- watching the board change ----------------
     Two readings of the board are enough to know what just happened, so the
     player never has to tell the app that a land entered or a creature died. */

  var prevZones = null;      // cardId -> { zone, name }
  var alerts = [];           // most recent first
  var ALERT_LIFE_MS = 45000;
  var ALERT_MAX = 5;

  function typeOf(name) {
    var card = cardsByName[String(name).toLowerCase()];
    return card ? (card.type_line || '').split('//')[0] : '';
  }

  function reactToChanges(mine, names) {
    var now = {};
    mine.forEach(function (c) {
      var name = names[String(c.scryfallId).toLowerCase()];
      if (name) { now[c.cardId] = { zone: EDH_ZONES[c.zone], name: name }; }
    });

    // The first reading is the starting position, not a set of events.
    if (!prevZones) { prevZones = now; return; }

    var entered = [];
    var died = [];

    Object.keys(now).forEach(function (id) {
      var before = prevZones[id];
      var after = now[id];
      if (!before) {
        if (after.zone === 'battlefield') { entered.push(after.name); }
      } else if (before.zone !== after.zone) {
        if (after.zone === 'battlefield') { entered.push(after.name); }
        else if (before.zone === 'battlefield' && after.zone === 'graveyard') { died.push(after.name); }
      }
    });
    Object.keys(prevZones).forEach(function (id) {
      if (!now[id] && prevZones[id].zone === 'battlefield') { died.push(prevZones[id].name); }
    });

    prevZones = now;
    if (!entered.length && !died.length) { return; }

    var fired = [];
    entered.forEach(function (name) {
      fired.push({ headline: name + ' entered the battlefield',
                   own: ownTriggers(name, 'etb_self'),
                   others: othersTriggers('etb_other', name) });
      if (/\bToken\b/.test(typeOf(name))) { countEvent('token'); }
      if (/\bLand\b/.test(typeOf(name))) {
        countEvent('landfall');
        fired.push({ headline: 'Landfall — ' + name,
                     own: [], others: othersTriggers('landfall', name) });
      }
      countEvent('etb_other');
    });
    died.forEach(function (name) {
      fired.push({ headline: name + ' died',
                   own: ownTriggers(name, 'dies_self'),
                   others: othersTriggers('dies_other', name) });
      if (/\bCreature\b/.test(typeOf(name))) { countEvent('dies_other'); }
    });

    // Only worth interrupting for if something actually triggers.
    var useful = fired.filter(function (f) { return f.own.length || f.others.length; });
    if (!useful.length) { return; }

    var stamp = Date.now();
    useful.forEach(function (f) { f.at = stamp; alerts.unshift(f); });
    alerts = alerts.slice(0, ALERT_MAX);
    buzz([30, 40, 30]);
  }

  /** Triggers on the card itself for a given event. */
  function ownTriggers(name, event) {
    var a = analysis[name];
    if (!a) { return []; }
    return a.triggers.filter(function (t) { return t.event === event; })
      .map(function (t) { return { name: name, text: t.text }; });
  }

  var SUBJECT_TYPES = ['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'battle'];

  /**
   * Does a trigger that watches for something entering or dying actually care
   * about *this* card? Only the condition is examined — Aura Shards destroys an
   * artifact or enchantment, but it triggers on creatures.
   */
  function triggerAppliesTo(triggerText, typeLine) {
    var clause = String(triggerText).split(',')[0].toLowerCase();
    var wanted = SUBJECT_TYPES.filter(function (t) {
      return new RegExp('\\b' + t + 's?\\b').test(clause);
    });
    if (!wanted.length) { return true; }        // "permanent", or unspecified
    var types = String(typeLine).toLowerCase();
    return wanted.some(function (t) { return types.indexOf(t) !== -1; });
  }

  /** Triggers on everything else you control that watch for this event. */
  function othersTriggers(event, subjectName) {
    var typeLine = typeOf(subjectName);
    var out = [];
    activeBoard().forEach(function (it) {
      if (it.name === subjectName || it.zone !== 'battlefield' || !it.analysis) { return; }
      it.analysis.triggers.forEach(function (t) {
        if (t.type !== 'event' || t.event !== event) { return; }
        if (!triggerAppliesTo(t.text, typeLine)) { return; }
        out.push({ name: it.name, text: t.text });
      });
    });
    return out;
  }

  /** Roll the matching turn question forward, since we saw it happen. */
  function countEvent(eventId) {
    var g = state.game;
    if (!g) { return; }
    g.answers = g.answers || {};
    g.answers[eventId] = (g.answers[eventId] || 0) + 1;
  }

  function liveAlerts() {
    var cutoff = Date.now() - ALERT_LIFE_MS;
    alerts = alerts.filter(function (a) { return a.at > cutoff; });
    return alerts;
  }

  function renderAlerts() {
    var host = $('#alert-strip');
    if (!host) { return; }
    var list = liveAlerts();
    if (!list.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }

    host.classList.remove('hidden');
    host.innerHTML = list.map(function (a) {
      var rows = a.own.concat(a.others);
      return '<div class="alert">' +
        '<div class="alert-head">' + esc(a.headline) + '</div>' +
        rows.map(function (r) {
          return '<div class="alert-row"><b>' + esc(r.name) + '</b> ' + Mana.render(r.text) + '</div>';
        }).join('') +
      '</div>';
    }).join('');
  }

  /**
   * Mirror the game's own turn state: whose turn it is, and which turn number.
   * Passing the turn on edhplay flips the panel over on its own.
   */
  function followGameTurn(snap, me) {
    var g = state.game;

    // The page answers this directly now: the turn readout only offers "pass
    // turn" on your own turn. activePlayer is the older id-based fallback.
    var mine = null;
    if (typeof snap.myTurn === 'boolean') { mine = snap.myTurn; }
    else if (snap.activePlayer) { mine = snap.activePlayer === me; }

    if (mine !== null && g.myTurn !== mine) {
      g.myTurn = mine;
      // A new player's turn starts at the top of the turn.
      g.phaseIndex = 0;
    }

    if (typeof snap.turn === 'number' && snap.turn > 0 && snap.turn !== g.turn) {
      g.turn = snap.turn;
      g.phaseIndex = 0;
      pruneResolved();
    }
  }

  /** Banner shown while the panel is mirroring a live board. */
  function renderLiveBar() {
    var bar = $('#live-bar');
    if (!bar) { return; }

    // Driven by whether a board has actually been seen, not by how it arrived.
    if (!liveSnapshot || !liveSnapshot.cards || !liveSnapshot.cards.length) {
      bar.classList.add('hidden');
      return;
    }

    var players = snapshotPlayers(liveSnapshot);
    var me = chosenPlayer(liveSnapshot);
    bar.classList.remove('hidden');

    if (!me) {
      bar.innerHTML = '<span class="live-dot warn"></span>' +
        '<span class="live-text">Which player are you?</span>' +
        '<span class="live-players">' + players.map(function (p, i) {
          return '<button class="chip" data-player="' + esc(p) + '">Player ' + (i + 1) + '</button>';
        }).join('') + '</span>';
      return;
    }

    var tracked = activeBoard().length;
    var whose = '';
    if (typeof liveSnapshot.myTurn === 'boolean') {
      whose = liveSnapshot.myTurn
        ? ' · your turn'
        : ' · ' + (liveSnapshot.activeSeat ? esc(liveSnapshot.activeSeat) + "'s turn" : "opponent's turn");
    } else if (liveSnapshot.activePlayer) {
      whose = liveSnapshot.activePlayer === me ? ' · your turn' : " · opponent's turn";
    }
    bar.innerHTML = '<span class="live-dot"></span>' +
      '<span class="live-text">edhplay · ' + tracked + ' card' +
      (tracked === 1 ? '' : 's') + whose + '</span>' +
      (players.length > 1
        ? '<button class="btn ghost small" id="btn-change-player">Not me</button>'
        : '');
  }

  // Exposed so a board reading can be inspected or replayed by hand when the
  // page markup changes and the mirror stops working.
  global.MTGLive = {
    apply: function (snap) { liveSnapshot = snap; lastSnapshotKey = ''; applySnapshot(snap); },
    last: function () { return liveSnapshot; },
    isLive: isLive
  };

  var alertTimer = null;
  function keepAlertsFresh() {
    clearInterval(alertTimer);
    alertTimer = setInterval(function () {
      if (!alerts.length) { return; }
      var before = alerts.length;
      if (liveAlerts().length !== before) { renderAlerts(); }
    }, 5000);
  }

  /* ---------------- boot ---------------- */

  function init() {
    bind();
    renderDecks();
    startBoardBridge();
    keepAlertsFresh();
    if (global.MTGBridge && global.MTGBridge.available) {
      global.MTGBridge.ensureInjected(function () { /* report shown in settings */ });
    }

    if (state.game && deckById(state.game.deckId)) {
      hydrate(deckById(state.game.deckId));
      showScreen('screen-play');
      renderPlay();
    } else {
      showScreen('screen-decks');
    }

    // Inside the Android APK every file is already local, so the service
    // worker would only add a staler second cache.
    var packaged = location.hostname === 'appassets.androidplatform.net';
    if ('serviceWorker' in navigator && !packaged && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline mode unavailable */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
