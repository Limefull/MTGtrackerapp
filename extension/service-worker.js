/* service-worker.js — opens the side panel, and makes sure the board reader is
   actually running on any edhplay tab.

   A declared content script only injects when a page loads, so a tab that was
   already open when the extension was installed or reloaded never gets one.
   Injecting on demand removes that whole class of "nothing happens" problem.
   Nothing is kept in memory: the worker is torn down after ~30s idle. */

var EDH_MATCHES = ['https://edhplay.com/*', 'https://*.edhplay.com/*'];

async function openPanelOnClick() {
  try {
    // Note the property name: openPanelOnActionClick. The "Icon" variant is a
    // silent TypeError that aborts the worker.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error('Trigger Tracker: could not set panel behaviour', err);
  }
}

/**
 * Inject the board reader into every open edhplay tab.
 * @returns {Promise<{tabs:number, urls:string[], injected:number, errors:string[]}>}
 */
async function ensureInjected() {
  var report = { tabs: 0, urls: [], injected: 0, errors: [] };

  var tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: EDH_MATCHES });
  } catch (err) {
    report.errors.push('tab query failed: ' + (err && err.message));
    return report;
  }

  report.tabs = tabs.length;

  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    report.urls.push(tab.url || '(no url)');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['content.js']
      });
      report.injected += 1;
    } catch (err) {
      report.errors.push((tab.url || tab.id) + ': ' + (err && err.message));
    }
  }

  return report;
}

chrome.runtime.onInstalled.addListener(async function () {
  await openPanelOnClick();
  await ensureInjected();
});

chrome.runtime.onStartup.addListener(openPanelOnClick);

// Catch tabs that finish loading while the panel is already open.
chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete') { return; }
  if (!tab.url || !/^https:\/\/([a-z0-9-]+\.)?edhplay\.com\//i.test(tab.url)) { return; }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
  } catch (err) {
    console.error('Trigger Tracker: injection failed', err);
  }
});

// Fallback for Chrome builds where setPanelBehavior is unavailable. When that
// behaviour is active Chrome handles the click itself and this never runs.
chrome.action.onClicked.addListener(async function (tab) {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (err) {
    console.error('Trigger Tracker: could not open the side panel', err);
  }
  await ensureInjected();
});

// The panel asks for this when it opens and when settings are shown, so an
// already-running game is picked up without reloading anything.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'ENSURE_INJECTED') { return; }
  (async function () {
    sendResponse(await ensureInjected());
  })();
  return true;   // keeps the channel open for the async reply
});
