chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs[0]?.url || '';
  const status = document.getElementById('status');
  const hint = document.getElementById('hint');
  if (url.includes('instagram.com')) {
    status.textContent = 'On Instagram — offer panel ready.';
    hint.textContent =
      'Use the “Deal ▸” tab on the right edge to open the offer panel, or click “Decide offer” on the dashboard.';
  } else {
    status.textContent = 'Extension active.';
    hint.textContent =
      'Open the Outreach dashboard and click “Scrape Via Extension” to scrape profiles, or “Decide offer” to open the offer panel.';
  }
});

// Dashboard URL setting — the Instagram side panel uses this to reach the API
// when opened standalone (the dashboard also auto-fills it on load).
const input = document.getElementById('dashboard-url');
const saved = document.getElementById('saved');

chrome.storage.local.get(['infDashboardApiBase'], (v) => {
  if (v && v.infDashboardApiBase) input.value = v.infDashboardApiBase;
});

document.getElementById('save-url').addEventListener('click', () => {
  let val = input.value.trim().replace(/\/+$/, '');
  if (val && !/^https?:\/\//i.test(val)) val = 'https://' + val;
  chrome.storage.local.set({ infDashboardApiBase: val }, () => {
    input.value = val;
    saved.textContent = val ? 'Saved ✓' : 'Cleared.';
    setTimeout(() => { saved.textContent = ''; }, 1600);
  });
});

// Dashboard API token — the backend's DASHBOARD_API_TOKEN. The dashboard
// authenticates humans with a same-origin Slack session cookie, which
// extension-origin requests can't use, so the offer panel and the scrape/DM
// queues send this machine token as an `x-site-password` header instead (the
// backend also accepts `x-api-token`). Blank means the backend has no gate.
const pwInput = document.getElementById('site-password');
const pwSaved = document.getElementById('password-saved');

chrome.storage.local.get(['infSitePassword'], (v) => {
  if (v && v.infSitePassword) pwInput.value = v.infSitePassword;
});

document.getElementById('save-password').addEventListener('click', () => {
  const val = pwInput.value.trim();
  chrome.storage.local.set({ infSitePassword: val }, () => {
    pwSaved.textContent = val ? 'Saved ✓' : 'Cleared.';
    setTimeout(() => { pwSaved.textContent = ''; }, 1600);
  });
});
