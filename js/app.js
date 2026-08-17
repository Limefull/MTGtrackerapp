/* app.js — screens, game loop and rendering. */
(function (global) {
  'use strict';

  var D = global.MTGData;
  var Parse = global.MTGParse;
  var Scry = global.MTGScryfall;
  var Trig = global.MTGTriggers;
  var Store = global.MTGStore;

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
  var addFilter = 'tracked';
  var typeFilter = 'all';
  var detailKey = null;
  var pendingAdvance = false;

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

  /** First copy of a card still in the library, or null when all are out. */
  function freeInstance(entry) {
    for (var i = 0; i < entry.qty; i++) {
      var k = instKey(entry.name, i);
      if (zoneOf(k) === 'deck') { return k; }
    }
    return null;
  }

  /* ---------------- resolved bookkeeping ---------------- */

  function resolvedKey(hit) {
    var g = state.game;
    return g.turn + '|' + (g.myTurn ? 'y' : 'o') + '|' + phaseId() + '|' + hit.item.key + '|' + hit.trigger.id;
  }

  function isResolved(hit) { return !!state.game.resolved[resolvedKey(hit)]; }

  function toggleResolved(hit) {
    var k = resolvedKey(hit);
    if (state.game.resolved[k]) { delete state.game.resolved[k]; }
    else { state.game.resolved[k] = 1; }
    persist();
  }

  function pruneResolved() {
    var g = state.game;
    var keep = {};
    Object.keys(g.resolved).forEach(function (k) {
      if (k.indexOf(g.turn + '|') === 0) { keep[k] = 1; }
    });
    g.resolved = keep;
    g.answers = {};
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
    return Trig.triggersNow(board(), pid, state.game.myTurn);
  }

  function unresolvedCount(pid) {
    var saved = null;
    if (pid !== phaseId()) { saved = state.game.phaseIndex; state.game.phaseIndex = D.PHASE_BY_ID[pid].index; }
    var n = hitsFor(pid).filter(function (h) { return !isResolved(h); }).length;
    if (saved !== null) { state.game.phaseIndex = saved; }
    return n;
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

  function renderDecks() {
    var host = $('#deck-list');
    if (!state.decks.length) {
      host.innerHTML = '<div class="empty">No decks yet. Paste a list below to get started.</div>';
      return;
    }
    host.innerHTML = state.decks.map(function (d) {
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
                     zones: {}, resolved: {}, answers: {} };
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
    if (index < 0) {
      g.turn = Math.max(1, g.turn - 1);
      index = D.PHASES.length - 1;
      pruneResolved();
    }
    if (index >= D.PHASES.length) {
      g.turn += 1;
      index = 0;
      pruneResolved();
      if (!silent) { toast('Turn ' + g.turn); }
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

    // Walking off the end of Cleanup is the same as passing the turn.
    if (g.phaseIndex >= D.PHASES.length - 1) { endTurn(); return; }

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

    host.innerHTML = hits.map(function (h) {
      var done = isResolved(h);
      return '<button class="trigger' + (done ? ' done' : '') + (h.trigger.critical ? ' critical' : '') + '"' +
        ' data-hit="' + esc(h.item.key + '||' + h.trigger.id) + '">' +
        '<span class="tick">' + (done ? '&#10003;' : '') + '</span>' +
        '<span class="tbody">' +
          '<span class="tname">' + esc(h.item.name) +
            (h.trigger.critical ? '<span class="tag danger">must not miss</span>' : '') +
            (h.trigger.scope === 'each' ? '<span class="tag">every turn</span>' : '') +
            (h.item.zone !== 'battlefield' ? '<span class="tag dim">' + esc(h.item.zone) + '</span>' : '') +
          '</span>' +
          '<span class="ttext">' + esc(h.trigger.text) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  function renderWatch() {
    var host = $('#watch-list');
    var block = host.parentNode;

    if (!state.settings.turnQuestions) {
      block.classList.add('hidden');
      return;
    }
    block.classList.remove('hidden');

    var groups = questions();
    $('#watch-count').textContent = groups.length;

    if (!groups.length) {
      host.innerHTML = '<div class="empty small">Nothing in this deck triggers off events.</div>';
      return;
    }
    host.innerHTML = groups.map(function (q) { return questionRow(q, false); }).join('');
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
    var items = board();
    $('#board-count').textContent = items.length;
    var host = $('#board-list');
    if (!items.length) {
      host.innerHTML = '<div class="empty small">Tap <b>+ Card</b> only for permanents that fire ' +
        'on their own schedule — upkeep, end step, combat. Everything else is covered by the ' +
        'questions above.</div>';
      return;
    }
    host.innerHTML = items.map(function (it) {
      var n = phaseTriggerCount(it.name);
      return '<button class="board-chip zone-' + esc(it.zone) + '" data-inst="' + esc(it.key) + '">' +
        esc(it.name) +
        (n ? '<span class="pill dim">' + n + '</span>' : '') +
      '</button>';
    }).join('');
  }

  /* ---------------- add-card modal ---------------- */

  function openAdd() {
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

  /** Copies of this entry still sitting in the library. */
  function countAvailable(entry) {
    var free = 0;
    for (var i = 0; i < entry.qty; i++) {
      if (zoneOf(instKey(entry.name, i)) === 'deck') { free++; }
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
          (card.mana_cost ? '<span class="muted"> ' + esc(card.mana_cost) + '</span>' : '') + '</div>' +
      '</div>';
    }

    if (a && a.triggers.length) {
      html += '<h3>Triggers</h3>' + a.triggers.map(function (t) {
        var when = t.type === 'phase'
          ? (D.PHASE_BY_ID[t.phase] ? D.PHASE_BY_ID[t.phase].name : t.phase)
          : (D.EVENT_BY_ID[t.event] ? D.EVENT_BY_ID[t.event].name : t.event);
        return '<div class="detail-trigger' + (t.critical ? ' critical' : '') + '">' +
          '<div class="dt-when">' + esc(when) +
            (t.scope === 'each' ? ' <span class="tag">every turn</span>' : '') +
            (t.scope === 'opp' ? ' <span class="tag">opponents only</span>' : '') + '</div>' +
          '<div class="dt-text">' + esc(t.text) + '</div>' +
        '</div>';
      }).join('');
    }

    if (a && a.statics.length) {
      html += '<h3>Keep in mind</h3>' + a.statics.map(function (s) {
        return '<div class="detail-trigger static">' +
          '<div class="dt-when">' + esc(s.label) + '</div>' +
          '<div class="dt-text">' + esc(s.text) + '</div>' +
        '</div>';
      }).join('');
    }

    if (card && (card.oracle_text || (card.faces && card.faces.length))) {
      var full = card.faces && card.faces.length
        ? card.faces.map(function (f) { return f.name + '\n' + f.oracle_text; }).join('\n\n')
        : card.oracle_text;
      html += '<h3>Full text</h3><pre class="oracle">' + esc(full) + '</pre>';
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
          '<span class="muted">' + esc(r.t.text) + '</span>' +
        '</div>';
      }).join('') +
    '</section>';
  }

  /* ---------------- settings ---------------- */

  function renderSettings() {
    $('#set-nag').checked = !!state.settings.nagOnAdvance;
    $('#set-haptics').checked = !!state.settings.haptics;
    $('#set-skip').checked = !!state.settings.skipEmptySteps;
    $('#set-opp').checked = !!state.settings.showOpponentTurns;
    $('#set-questions').checked = !!state.settings.turnQuestions;
    $('#set-sweep').checked = !!state.settings.endTurnSweep;
    $('#cache-info').textContent = Scry.cacheSize() + ' cards cached.';
    $('#version-line').textContent = 'Version ' + VERSION;
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

    $$('.modal').forEach(function (m) {
      m.addEventListener('click', function (ev) {
        if (ev.target === m) { m.classList.add('hidden'); }
      });
    });

    // --- settings
    bindToggle('#set-nag', 'nagOnAdvance');
    bindToggle('#set-haptics', 'haptics');
    bindToggle('#set-skip', 'skipEmptySteps');
    bindToggle('#set-opp', 'showOpponentTurns');
    bindToggle('#set-questions', 'turnQuestions');
    bindToggle('#set-sweep', 'endTurnSweep');

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
      else if (ev.key.toLowerCase() === 'a') { ev.preventDefault(); openAdd(); }
      else if (ev.key.toLowerCase() === 't') { endTurn(); }
    });
  }

  function bindQuestions(sel) {
    $(sel).addEventListener('click', function (ev) {
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

  /* ---------------- boot ---------------- */

  function init() {
    bind();
    renderDecks();

    if (state.game && deckById(state.game.deckId)) {
      hydrate(deckById(state.game.deckId));
      showScreen('screen-play');
      renderPlay();
    } else {
      showScreen('screen-decks');
    }

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline mode unavailable */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
