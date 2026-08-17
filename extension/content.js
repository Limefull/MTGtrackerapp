/* content.js — read the board off edhplay.com and hand it to the side panel.
   Read-only: nothing is clicked, changed or sent anywhere except into this
   extension's own storage, which the panel reads back.

   The page marks every card with the attributes we need:
     [data-zone]            hand | battlefield | graveyard | library | exile ...
     [data-card-id]         the game's own id for that copy
     [data-player-id]       whose card it is
     and an <img> whose Scryfall URL carries the card's Scryfall UUID. */

(function () {
  'use strict';

  var STORAGE_KEY = 'edhplayBoard';
  var SCRYFALL_ID = /cards\.scryfall\.io\/.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  var DEBOUNCE_MS = 400;

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

  function snapshot() {
    var cards = readCards();
    var self = findSelf(cards);
    var zones = {};
    cards.forEach(function (c) { zones[c.zone] = (zones[c.zone] || 0) + 1; });

    return {
      url: location.href,
      self: self,
      // Only cards we can actually identify are useful downstream.
      cards: cards.filter(function (c) { return c.scryfallId; }),
      // Kept for diagnostics: if the page ever renames a zone this shows it.
      zoneCounts: zones,
      totalCardEls: cards.length
    };
  }

  var lastSerialised = '';

  function publish() {
    var snap;
    try {
      snap = snapshot();
    } catch (err) {
      return;   // a mid-render DOM is not worth reporting
    }

    var serialised = JSON.stringify(snap.cards) + '|' + snap.self;
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
    attributeFilter: ['data-zone', 'data-card-id', 'src']
  });

  // The board is drawn well after load, so take a few early readings too.
  schedule();
  [1000, 3000, 6000].forEach(function (ms) { setTimeout(schedule, ms); });
})();
