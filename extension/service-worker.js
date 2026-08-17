/* service-worker.js — the panel is the whole extension, so all this does is
   make the toolbar button open it. Nothing is kept in memory: the worker is
   torn down after ~30s idle, and the app's own state lives in localStorage. */

async function openPanelOnClick() {
  try {
    // Note the property name: openPanelOnActionClick. The "Icon" variant is a
    // silent TypeError that aborts the worker.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error('Trigger Tracker: could not set panel behaviour', err);
  }
}

chrome.runtime.onInstalled.addListener(openPanelOnClick);
chrome.runtime.onStartup.addListener(openPanelOnClick);

// Fallback for Chrome builds where setPanelBehavior is unavailable. When the
// behaviour above is active Chrome handles the click itself and this never runs.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (err) {
    console.error('Trigger Tracker: could not open the side panel', err);
  }
});
