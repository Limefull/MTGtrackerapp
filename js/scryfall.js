/* scryfall.js — card lookup against the public Scryfall API, with a local cache.
   Oracle text is stable, so anything we have seen once is served from
   localStorage and the app keeps working with no connection at all. */
(function (global) {
  'use strict';

  var API = 'https://api.scryfall.com/cards/collection';
  var BATCH = 75;          // Scryfall's documented maximum per request
  var GAP_MS = 120;        // stay under the 10 req/s rate limit
  var CACHE_KEY = 'mtgtracker.cards.v3';

  var cache = null;

  function loadCache() {
    if (cache) { return cache; }
    try {
      cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    } catch (e) {
      cache = {};
    }
    return cache;
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      // Quota blown: drop the cache rather than wedging the app.
      try { localStorage.removeItem(CACHE_KEY); } catch (e2) { /* ignore */ }
      cache = {};
    }
  }

  function key(name) {
    return String(name).toLowerCase().trim();
  }

  /** Keep only what the app needs — full Scryfall objects blow the storage quota.
      Two image sizes: "small" for the picker grid, "normal" for the detail view. */
  function trim(card) {
    var faces = (card.card_faces || []).map(function (f) {
      return {
        name: f.name,
        type_line: f.type_line || '',
        oracle_text: f.oracle_text || '',
        mana_cost: f.mana_cost || '',
        defense: f.defense || '',
        thumb: (f.image_uris && f.image_uris.small) || '',
        image: (f.image_uris && (f.image_uris.normal || f.image_uris.small)) || ''
      };
    });
    return {
      name: card.name,
      type_line: card.type_line || '',
      oracle_text: card.oracle_text || '',
      mana_cost: card.mana_cost || '',
      cmc: card.cmc || 0,
      colors: card.color_identity || [],
      keywords: card.keywords || [],
      layout: card.layout || 'normal',
      defense: card.defense || '',
      faces: faces,
      thumb: (card.image_uris && card.image_uris.small) || (faces[0] && faces[0].thumb) || '',
      image: (card.image_uris && (card.image_uris.normal || card.image_uris.small)) ||
             (faces[0] && faces[0].image) || '',
      scryfall_uri: card.scryfall_uri || ''
    };
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * Resolve a list of card names to trimmed card objects.
   * @param {string[]} names
   * @param {function(number, number)} [onProgress] (done, total)
   * @returns {Promise<{cards: Object, missing: string[], offline: boolean}>}
   */
  function fetchCards(names, onProgress) {
    loadCache();

    var unique = [];
    var seen = {};
    names.forEach(function (n) {
      var k = key(n);
      if (!seen[k]) { seen[k] = true; unique.push(n); }
    });

    var needed = unique.filter(function (n) { return !cache[key(n)]; });
    var missing = [];
    var offline = false;
    var done = unique.length - needed.length;

    if (onProgress) { onProgress(done, unique.length); }

    var batches = [];
    for (var i = 0; i < needed.length; i += BATCH) {
      batches.push(needed.slice(i, i + BATCH));
    }

    var chain = Promise.resolve();
    batches.forEach(function (batch, bi) {
      chain = chain.then(function () {
        if (offline) { return null; }
        if (bi > 0) { return sleep(GAP_MS).then(function () { return postBatch(batch); }); }
        return postBatch(batch);
      }).then(function (data) {
        if (!data) { return; }
        (data.data || []).forEach(function (card) {
          var t = trim(card);
          cache[key(card.name)] = t;
          // Also index the front-face name so "Front // Back" lookups hit.
          if (t.faces.length) { cache[key(t.faces[0].name)] = t; }
        });
        (data.not_found || []).forEach(function (id) {
          missing.push(id.name || JSON.stringify(id));
        });
        done += batch.length;
        if (onProgress) { onProgress(Math.min(done, unique.length), unique.length); }
      }).catch(function () {
        offline = true;
        batch.forEach(function (n) { missing.push(n); });
      });
    });

    return chain.then(function () {
      saveCache();
      var out = {};
      unique.forEach(function (n) {
        var c = cache[key(n)];
        if (c) { out[key(n)] = c; }
      });
      return { cards: out, missing: missing, offline: offline };
    });
  }

  function postBatch(batch) {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        identifiers: batch.map(function (n) { return { name: n }; })
      })
    }).then(function (res) {
      if (!res.ok) { throw new Error('Scryfall responded ' + res.status); }
      return res.json();
    });
  }

  /* ---------- lookup by Scryfall id ----------
     edhplay identifies cards by their Scryfall UUID, so the extension needs
     id -> name. Ids never change, so the map is cached forever. */

  var ID_KEY = 'mtgtracker.ids.v1';
  var idMap = null;

  function loadIdMap() {
    if (idMap) { return idMap; }
    try {
      idMap = JSON.parse(localStorage.getItem(ID_KEY) || '{}');
    } catch (e) {
      idMap = {};
    }
    return idMap;
  }

  function saveIdMap() {
    try {
      localStorage.setItem(ID_KEY, JSON.stringify(idMap));
    } catch (e) {
      idMap = {};
    }
  }

  /**
   * @param {string[]} ids Scryfall UUIDs
   * @returns {Promise<Object>} id -> card name, for everything resolvable
   */
  function namesForIds(ids) {
    loadIdMap();

    var unique = [];
    var seen = {};
    ids.forEach(function (id) {
      var k = String(id).toLowerCase();
      if (k && !seen[k]) { seen[k] = true; unique.push(k); }
    });

    var needed = unique.filter(function (id) { return !idMap[id]; });
    var batches = [];
    for (var i = 0; i < needed.length; i += BATCH) { batches.push(needed.slice(i, i + BATCH)); }

    var chain = Promise.resolve();
    batches.forEach(function (batch, bi) {
      chain = chain.then(function () {
        return bi > 0 ? sleep(GAP_MS) : null;
      }).then(function () {
        return fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            identifiers: batch.map(function (id) { return { id: id }; })
          })
        }).then(function (res) {
          if (!res.ok) { throw new Error('Scryfall responded ' + res.status); }
          return res.json();
        }).then(function (data) {
          (data.data || []).forEach(function (card) {
            idMap[String(card.id).toLowerCase()] = card.name;
            // Bank the full card too, so a deck built this way needs no second trip.
            cache[key(card.name)] = trim(card);
          });
        });
      }).catch(function () { /* offline: resolve what we already know */ });
    });

    return chain.then(function () {
      saveIdMap();
      saveCache();
      var out = {};
      unique.forEach(function (id) { if (idMap[id]) { out[id] = idMap[id]; } });
      return out;
    });
  }

  function getCached(name) {
    loadCache();
    return cache[key(name)] || null;
  }

  function cacheSize() {
    loadCache();
    return Object.keys(cache).length;
  }

  function clearCache() {
    cache = {};
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
  }

  global.MTGScryfall = {
    fetchCards: fetchCards,
    getCached: getCached,
    cacheSize: cacheSize,
    clearCache: clearCache,
    key: key
  };
})(window);
