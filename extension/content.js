/* content.js — read the board off edhplay.com and hand it to the side panel.
   Read-only: nothing is clicked, changed or sent anywhere except into this
   extension's own storage, which the panel reads back.

   Everything here was checked against a real multiplayer game rather than
   guessed. The page marks every card with:
     [data-zone]            hand | battlefield | graveyard | library | commandZone
     [data-card-id]         the game's own id for that copy
     [data-player-id]       whose card it is
     and an <img> whose Scryfall URL carries the card's Scryfall UUID.

   Seats are tooltip triggers labelled "Click to focus: <name>", carrying a
   "Turn" badge when it is their turn and a "You" badge on your own seat. They
   hold no player id, which is why whose-turn-it-is is worked out from the
   badges and from the pass-turn affordance rather than from ids. */

(function () {
  'use strict';

  // The script is both declared in the manifest and injected on demand, so it
  // can arrive twice on the same page. Only the first copy should observe.
  if (window.__mtgTriggerTrackerReader) { return; }
  window.__mtgTriggerTrackerReader = true;

  var STORAGE_KEY = 'edhplayBoard';
  var SCRYFALL_ID = /cards\.scryfall\.io\/.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  var SEAT_LABEL = /^click to focus:\s*(.+)$/i;
  var ROUND_LABEL = /\bround\s*(\d{1,3})\b/i;
  var PASS_TURN = /click to pass turn/i;
  var DEBOUNCE_MS = 400;

  /* ---------- cards ---------- */

  function scryfallIdFrom(el) {
    var img = el.querySelector('img[src*="cards.scryfall.io"]');
    var uri = (img && img.src) || el.getAttribute('data-front-image-uri') || '';
    var m = SCRYFALL_ID.exec(uri);
    return m ? m[1].toLowerCase() : null;
  }

  function readCards() {
    var out = [];
    document.querySelectorAll('[data-zone][data-card-id]').forEach(function (el) {
      var owner = el.getAttribute('data-player-id');
      if (!owner) {
        var host = el.closest('[data-zone-player-id]');
        owner = host ? host.getAttribute('data-zone-player-id') : null;
      }
      out.push({
        zone: el.getAttribute('data-zone'),
        player: owner,
        cardId: el.getAttribute('data-card-id'),
        scryfallId: scryfallIdFrom(el)
      });
    });
    return out;
  }

  /**
   * Only your own hand is rendered face up, so whoever owns identifiable hand
   * cards is you. Falls back to the sole board on screen.
   */
  function findSelf(cards) {
    var tally = {};
    cards.forEach(function (c) {
      if (c.zone === 'hand' && c.scryfallId && c.player) {
        tally[c.player] = (tally[c.player] || 0) + 1;
      }
    });
    var best = null;
    Object.keys(tally).forEach(function (p) {
      if (!best || tally[p] > tally[best]) { best = p; }
    });
    if (best) { return best; }

    var boards = document.querySelectorAll('[data-player-board-id]');
    return boards.length === 1 ? boards[0].getAttribute('data-player-board-id') : null;
  }

  /* ---------- seats and turn ---------- */

  function isVisible(el) {
    if (!el.offsetWidth && !el.offsetHeight && !el.getClientRects().length) { return false; }
    var style = window.getComputedStyle(el);
    if (!style) { return true; }
    return style.visibility !== 'hidden' &&
           style.display !== 'none' &&
           parseFloat(style.opacity || '1') > 0.05;
  }

  /**
   * Every seat, with the badges that are actually on screen. The inactive seat
   * still carries a "Turn" element in the markup, so visibility is what
   * separates the player whose turn it is from everyone else.
   */
  function readSeats() {
    var seats = [];
    document.querySelectorAll('[aria-label]').forEach(function (el) {
      var m = SEAT_LABEL.exec((el.getAttribute('aria-label') || '').trim());
      if (!m) { return; }

      var hasTurn = false;
      var isYou = false;
      el.querySelectorAll('span, p, div, small, b, strong').forEach(function (node) {
        if (node.children.length) { return; }
        var text = (node.textContent || '').trim();
        if (!/^(turn|you)$/i.test(text) || !isVisible(node)) { return; }
        if (/^turn$/i.test(text)) { hasTurn = true; } else { isYou = true; }
      });

      seats.push({ name: m[1].trim(), hasTurn: hasTurn, isYou: isYou });
    });
    return seats;
  }

  /** The round number, straight off the turn readout's own label. */
  function readTurn() {
    var labelled = document.querySelectorAll('[aria-label]');
    for (var i = 0; i < labelled.length; i++) {
      var m = ROUND_LABEL.exec(labelled[i].getAttribute('aria-label') || '');
      if (m) { return parseInt(m[1], 10); }
    }
    return null;
  }

  /**
   * Is it your turn?
   * The turn readout only offers "Click to pass turn" when the turn is yours,
   * which is the clearest signal the page gives. Seat badges are the fallback.
   * @returns {boolean|null} null when the page says neither way
   */
  function readMyTurn(seats) {
    var labelled = document.querySelectorAll('[aria-label]');
    for (var i = 0; i < labelled.length; i++) {
      var label = labelled[i].getAttribute('aria-label') || '';
      if (ROUND_LABEL.test(label)) { return PASS_TURN.test(label); }
    }

    var active = null;
    var mine = null;
    seats.forEach(function (s) {
      if (s.hasTurn) { active = s.name; }
      if (s.isYou) { mine = s.name; }
    });
    return (active && mine) ? active === mine : null;
  }

  /* ---------- snapshot ---------- */

  function snapshot() {
    var cards = readCards();
    var seats = readSeats();
    var zones = {};
    cards.forEach(function (c) { zones[c.zone] = (zones[c.zone] || 0) + 1; });

    var activeSeat = null;
    var mySeat = null;
    seats.forEach(function (s) {
      if (s.hasTurn) { activeSeat = s.name; }
      if (s.isYou) { mySeat = s.name; }
    });

    return {
      url: location.href,
      self: findSelf(cards),
      turn: readTurn(),
      myTurn: readMyTurn(seats),
      activeSeat: activeSeat,
      mySeat: mySeat,
      // Only cards we can actually identify are useful downstream.
      cards: cards.filter(function (c) { return c.scryfallId; }),
      zoneCounts: zones,
      totalCardEls: cards.length,
      diag: { seats: seats, phaseWords: phaseWords() }
    };
  }

  /** edhplay has no phases; this stays so a future change would be noticed. */
  function phaseWords() {
    var words = /\b(untap|upkeep|main phase|combat|end step|cleanup|priority)\b/i;
    var found = [];
    document.querySelectorAll('p, span, div, button').forEach(function (el) {
      if (el.children.length || found.length >= 5) { return; }
      var t = (el.textContent || '').trim();
      if (t && t.length < 60 && words.test(t)) { found.push(t); }
    });
    return found;
  }

  /* ---------- publishing ---------- */

  var lastSerialised = '';

  function publish() {
    var snap;
    try {
      snap = snapshot();
    } catch (err) {
      return;   // a mid-render DOM is not worth reporting
    }

    var serialised = JSON.stringify(snap.cards) + '|' + snap.self + '|' +
                     snap.myTurn + '|' + snap.turn;
    if (serialised === lastSerialised) { return; }
    lastSerialised = serialised;

    var payload = {};
    payload[STORAGE_KEY] = snap;
    try {
      chrome.storage.local.set(payload);
    } catch (err) {
      // Extension reloaded out from under the page; the next edit will retry.
      lastSerialised = '';
    }
  }

  var timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(publish, DEBOUNCE_MS);
  }

  var observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-zone', 'data-card-id', 'aria-label', 'class', 'src']
  });

  // The board is drawn well after load, so take a few early readings too.
  schedule();
  [1000, 3000, 6000].forEach(function (ms) { setTimeout(schedule, ms); });
})();
