const els = {
  backendUrl: document.getElementById('backend-url'),
  apiKey: document.getElementById('api-key'),
  save: document.getElementById('save-btn'),
  extract: document.getElementById('extract-btn'),
  auto: document.getElementById('auto-btn'),
  status: document.getElementById('status'),
  pending: document.getElementById('pending-list'),
};

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind || '';
}

async function loadSettings() {
  const { backendUrl, apiKey } = await chrome.storage.local.get(['backendUrl', 'apiKey']);
  els.backendUrl.value = backendUrl || 'http://localhost:3000';
  els.apiKey.value = apiKey || '';
}

async function getSettings() {
  const { backendUrl, apiKey } = await chrome.storage.local.get(['backendUrl', 'apiKey']);
  return {
    backendUrl: (backendUrl || 'http://localhost:3000').replace(/\/$/, ''),
    apiKey: apiKey || '',
  };
}

async function api(path, options = {}) {
  const { backendUrl, apiKey } = await getSettings();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Extension-Key'] = apiKey;
  const res = await fetch(backendUrl + path, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function refreshPending() {
  try {
    const items = await api('/api/extension/pending');
    els.pending.innerHTML = '';
    if (!items.length) {
      els.pending.innerHTML = '<div class="item meta">No pending creators.</div>';
      return [];
    }
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `<div class="url">@${it.instagram_username || ''}</div>
        <div class="meta">${it.brand_name} · ${it.campaign_name}</div>`;
      els.pending.appendChild(div);
    }
    return items;
  } catch (err) {
    setStatus(`Pending fetch failed: ${err.message}`, 'error');
    return [];
  }
}

async function extractFromTab(tabId) {
  // Ensure content script is present; reinject if needed.
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { action: 'extractInstagramData' });
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['instagram-content.js'] });
    resp = await chrome.tabs.sendMessage(tabId, { action: 'extractInstagramData' });
  }
  return resp;
}

async function extractCurrentProfile() {
  setStatus('Extracting…');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith('https://www.instagram.com/')) {
    setStatus('Open an Instagram profile tab first.', 'error');
    return;
  }
  const data = await extractFromTab(tab.id);
  if (!data) {
    setStatus('No data extracted.', 'error');
    return;
  }
  // Match against a pending creator by username.
  const pending = await api('/api/extension/pending');
  const match = pending.find((p) => (p.instagram_username || '').toLowerCase() === (data.username || '').toLowerCase());
  if (!match) {
    setStatus(`Extracted (${data.email || 'no email'}) but no pending creator with username @${data.username}.`, 'error');
    return;
  }
  await api(`/api/extension/extracted/${match.id}`, {
    method: 'POST',
    body: JSON.stringify({
      email: data.email,
      first_name: data.firstName,
      full_name: data.fullName,
      instagram_username: data.username,
    }),
  });
  setStatus(`Saved: @${data.username} → ${data.email || 'no email'}`, 'success');
  await refreshPending();
}

async function processQueue() {
  setStatus('Processing queue…');
  const items = await refreshPending();
  if (!items.length) return;
  for (const it of items) {
    try {
      setStatus(`Opening @${it.instagram_username}…`);
      const tab = await chrome.tabs.create({ url: it.instagram_url, active: false });
      // Wait for page to settle.
      await new Promise((r) => setTimeout(r, 5500));
      let data;
      try {
        data = await extractFromTab(tab.id);
      } catch (e) {
        data = null;
      }
      await api(`/api/extension/extracted/${it.id}`, {
        method: 'POST',
        body: JSON.stringify({
          email: data && data.email,
          first_name: data && data.firstName,
          full_name: data && data.fullName,
          instagram_username: data && data.username,
        }),
      });
      await chrome.tabs.remove(tab.id);
    } catch (err) {
      console.error('queue item failed', it, err);
    }
  }
  setStatus('Queue processed.', 'success');
  await refreshPending();
}

els.save.addEventListener('click', async () => {
  await chrome.storage.local.set({
    backendUrl: els.backendUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
  });
  setStatus('Settings saved.', 'success');
  refreshPending();
});

els.extract.addEventListener('click', () => extractCurrentProfile().catch((e) => setStatus(e.message, 'error')));
els.auto.addEventListener('click', () => processQueue().catch((e) => setStatus(e.message, 'error')));

loadSettings().then(refreshPending);
