/* store.js — persistence. Decks, the in-progress game and settings all live in
   localStorage so the app survives a refresh mid-game and works offline. */
(function (global) {
  'use strict';

  var KEY = 'mtgtracker.state.v1';

  var DEFAULTS = {
    decks: [],
    activeDeckId: null,
    game: null,
    settings: {
      nagOnAdvance: true,
      haptics: true,
      skipEmptySteps: true,
      turnQuestions: true,
      endTurnSweep: true,
      autoTrack: true
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function load() {
    var state;
    try {
      state = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (e) {
      state = null;
    }
    if (!state) { return clone(DEFAULTS); }
    // Fill in anything added by a later version.
    var out = clone(DEFAULTS);
    Object.keys(state).forEach(function (k) { out[k] = state[k]; });
    out.settings = out.settings || {};
    Object.keys(DEFAULTS.settings).forEach(function (k) {
      if (typeof out.settings[k] === 'undefined') { out.settings[k] = DEFAULTS.settings[k]; }
    });
    return out;
  }

  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  function newId() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function exportState(state) {
    return JSON.stringify({ version: 1, exported: new Date().toISOString(), state: state }, null, 2);
  }

  function importState(json) {
    var parsed = JSON.parse(json);
    if (!parsed || !parsed.state || !Array.isArray(parsed.state.decks)) {
      throw new Error('That does not look like a MTG Trigger Tracker backup.');
    }
    return parsed.state;
  }

  global.MTGStore = {
    load: load,
    save: save,
    newId: newId,
    exportState: exportState,
    importState: importState,
    DEFAULTS: DEFAULTS
  };
})(window);
