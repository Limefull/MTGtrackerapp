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

  global.MTGBridge = { available: available, subscribe: subscribe };
})(window);
