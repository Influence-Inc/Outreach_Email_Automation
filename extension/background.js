// Minimal service worker. Email sending is now done by the backend via Gmail API,
// so this only logs lifecycle for debugging.
chrome.runtime.onInstalled.addListener(() => {
  console.log('Influence Creator Extractor installed.');
});
