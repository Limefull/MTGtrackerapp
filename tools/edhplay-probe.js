/* edhplay-probe.js — paste into the browser console ON THE GAME PAGE.

   Read-only: it clicks nothing and changes nothing. It reports what the board
   reader would see, so a multiplayer seat list can be checked without needing
   an account. Copy the printed JSON back. */

(function () {
  'use strict';

  var SCRYFALL_ID = /cards\.scryfall\.io\/.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  function playerIdOf(el) {
    return el.getAttribute('data-player-id') ||
           el.getAttribute('data-player-board-id') ||
           el.getAttribute('data-zone-player-id') || null;
  }

  function scryfallIdFrom(el) {
    var img = el.querySelector('img[src*="cards.scryfall.io"]');
    var uri = (img && img.src) || el.getAttribute('data-front-image-uri') || '';
    var m = SCRYFALL_ID.exec(uri);
    return m ? m[1].toLowerCase() : null;
  }

  /* --- what the reader currently extracts --- */

  var cards = [];
  document.querySelectorAll('[data-zone][data-card-id]').forEach(function (el) {
    var owner = el.getAttribute('data-player-id');
    if (!owner) {
      var host = el.closest('[data-zone-player-id]');
      owner = host ? host.getAttribute('data-zone-player-id') : null;
    }
    cards.push({ zone: el.getAttribute('data-zone'), player: owner, id: scryfallIdFrom(el) });
  });

  var zoneCounts = {};
  var byPlayer = {};
  cards.forEach(function (c) {
    zoneCounts[c.zone] = (zoneCounts[c.zone] || 0) + 1;
    byPlayer[c.player] = (byPlayer[c.player] || 0) + 1;
  });

  /* --- how seats are marked --- */

  var seats = [];
  document.querySelectorAll('[data-player-board-id], [data-player-id], [data-zone-player-id]')
    .forEach(function (el) {
      var text = (el.textContent || '').trim();
      if (text.length > 200) { return; }           // whole-board wrappers
      if (!/\b(turn|you)\b/i.test(text)) { return; }
      seats.push({
        player: playerIdOf(el),
        textLength: text.length,
        text: text.slice(0, 70),
        saysTurn: /\bturn\b/i.test(text),
        saysYou: /\byou\b/i.test(text),
        state: el.getAttribute('data-state'),
        cls: String(el.className).slice(0, 60)
      });
    });

  /* --- turn number, three possible sources --- */

  var ariaTurn = null;
  document.querySelectorAll('button, [role="button"], [aria-label]').forEach(function (b) {
    var a = b.getAttribute('aria-label') || '';
    if (/round\s*\d+/i.test(a) || /pass turn/i.test(a)) { ariaTurn = a; }
  });

  var textTurn = null;
  var leaves = document.querySelectorAll('p, span, div');
  for (var i = 0; i < leaves.length; i++) {
    var el = leaves[i];
    if (el.children.length || !/^turn$/i.test((el.textContent || '').trim())) { continue; }
    textTurn = (el.parentElement && el.parentElement.textContent || '').trim().slice(0, 24);
    break;
  }

  /* --- anything that looks like a phase, which we believe does not exist --- */

  var phaseWords = /\b(untap|upkeep|draw step|main phase|precombat|postcombat|begin(ning)? of combat|declare (attackers|blockers)|combat damage|end of combat|end step|cleanup|priority)\b/i;
  var phaseHits = [];
  document.querySelectorAll('*').forEach(function (el) {
    if (el.children.length || phaseHits.length >= 5) { return; }
    var t = (el.textContent || '').trim();
    if (t && t.length < 60 && phaseWords.test(t)) { phaseHits.push(t); }
  });

  var report = {
    url: location.href,
    cardElements: cards.length,
    identified: cards.filter(function (c) { return c.id; }).length,
    zoneCounts: zoneCounts,
    cardsPerPlayer: byPlayer,
    seatMarkers: seats,
    turnFromAria: ariaTurn,
    turnFromText: textTurn,
    phaseWordsFound: phaseHits,
    distinctDataAttributes: [].concat.apply([], [].map.call(document.querySelectorAll('*'), function (e) {
      return [].map.call(e.attributes, function (a) { return a.name; });
    })).filter(function (n, i, arr) { return n.indexOf('data-') === 0 && arr.indexOf(n) === i; })
  };

  console.log(JSON.stringify(report, null, 2));
  return report;
})();
