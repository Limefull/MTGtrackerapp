/* bridge.js — receives board snapshots from the edhplay content script.
   A no-op everywhere except inside the Chrome extension, so the same files run
   unchanged as a web page, a PWA and an APK. */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'edhplayBoard';

  var available = false;
  try {
    available = typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;
  } catch (e) {
    available = false;
  }

  /**
   * @param {function(Object)} onSnapshot called with the latest board reading
   * @returns {boolean} false when not running as an extension
   */
  function subscribe(onSnapshot) {
    if (!available) { return false; }

    try {
      chrome.storage.local.get(STORAGE_KEY, function (result) {
        if (chrome.runtime.lastError) { return; }
        if (result && result[STORAGE_KEY]) { onSnapshot(result[STORAGE_KEY]); }
      });

      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[STORAGE_KEY]) { return; }
        var next = changes[STORAGE_KEY].newValue;
        if (next) { onSnapshot(next); }
      });
    } catch (e) {
      return false;
    }
    return true;
  }

  /**
   * Ask the service worker to inject the board reader into open edhplay tabs.
   * @param {function(Object|null)} done receives the injection report
   */
  function ensureInjected(done) {
    if (!available) { done(null); return; }
    try {
      chrome.runtime.sendMessage({ type: 'ENSURE_INJECTED' }, function (report) {
        if (chrome.runtime.lastError) { done(null); return; }
        done(report || null);
      });
    } catch (e) {
      done(null);
    }
  }

  global.MTGBridge = {
    available: available,
    subscribe: subscribe,
    ensureInjected: ensureInjected
  };
})(window);
