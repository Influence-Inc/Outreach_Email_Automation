const API = '';

const state = {
  campaigns: [],
  selectedCampaignId: null,
};

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function el(id) { return document.getElementById(id); }

function fmtDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleString();
}

async function refreshAuth() {
  try {
    const s = await api('/auth/status');
    const node = el('auth-status');
    if (s.authorized) {
      node.innerHTML = `Sending as <b>${s.senderEmail}</b> · <a href="/auth/google">re-auth</a>`;
    } else {
      node.innerHTML = `<a href="/auth/google" style="color:#fca5a5;">⚠ Connect Gmail (${s.senderEmail})</a>`;
    }
  } catch (err) {
    el('auth-status').textContent = `auth status error: ${err.message}`;
  }
}

async function refreshCampaigns() {
  state.campaigns = await api('/api/campaigns');
  const tree = el('brand-tree');
  tree.innerHTML = '';

  // Group by brand_name preserving the order returned by the API.
  const groups = new Map();
  for (const c of state.campaigns) {
    if (!groups.has(c.brand_name)) groups.set(c.brand_name, []);
    groups.get(c.brand_name).push(c);
  }

  if (!groups.size) {
    tree.innerHTML = '<p class="hint">No campaigns synced yet. Click Refresh.</p>';
    return;
  }

  for (const [brand, list] of groups) {
    const group = document.createElement('div');
    group.className = 'brand-group';
    const head = document.createElement('div');
    head.className = 'brand-name';
    head.textContent = brand;
    group.appendChild(head);
    for (const c of list) {
      const item = document.createElement('div');
      item.className = 'campaign-item';
      if (c.id === state.selectedCampaignId) item.classList.add('active');
      item.innerHTML = `<span>${c.name}</span><span class="meta">${c.creator_count}</span>`;
      item.onclick = () => selectCampaign(c.id);
      group.appendChild(item);
    }
    tree.appendChild(group);
  }

  if (state.campaigns.length) {
    const latest = state.campaigns
      .map((c) => c.synced_at)
      .filter(Boolean)
      .sort()
      .pop();
    if (latest) el('sync-status').textContent = `Synced ${fmtDate(latest)}`;
  }
}

async function selectCampaign(id) {
  state.selectedCampaignId = id;
  await refreshCampaigns();
  const c = state.campaigns.find((x) => x.id === id);
  if (!c) return;
  el('campaign-title').textContent = `${c.brand_name} · ${c.name}`;
  el('campaign-stats').innerHTML = `
    <span>Creators: <b>${c.creator_count}</b></span>
    <span>Pending: <b>${c.pending_extraction_count}</b></span>
    <span>Email found: <b>${c.email_found_count}</b></span>
    <span>Outreach: <b>${c.outreach_sent_count}</b></span>
    <span>Follow-up: <b>${c.followup_sent_count}</b></span>
    <span>Replied: <b>${c.replied_count}</b></span>
  `;
  el('creator-form').hidden = false;
  el('creator-table-wrap').hidden = false;
  await refreshCreators();
}

async function refreshCreators() {
  if (!state.selectedCampaignId) return;
  const rows = await api(`/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}`);
  const tbody = document.querySelector('#creator-table tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const lastActivity = r.replied_at || r.followup_sent_at || r.outreach_sent_at || r.updated_at;
    tr.innerHTML = `
      <td><a href="${r.instagram_url}" target="_blank" rel="noopener">@${r.instagram_username || r.instagram_url}</a></td>
      <td>${r.first_name || ''} ${r.full_name && r.full_name !== r.first_name ? `<br/><span class="meta">${r.full_name}</span>` : ''}</td>
      <td>${r.email || '<span class="meta">—</span>'}</td>
      <td><span class="tag ${r.status}">${r.status.replace(/_/g, ' ')}</span></td>
      <td>${r.open_count}${r.last_open_at ? `<br/><span class="meta">${fmtDate(r.last_open_at)}</span>` : ''}</td>
      <td><span class="meta">${fmtDate(lastActivity)}</span></td>
      <td></td>
    `;
    const actions = tr.querySelector('td:last-child');
    if (r.status === 'email_found') {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = 'Send outreach';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api(`/api/creators/${r.id}/send-outreach`, { method: 'POST' });
          await refreshCreators();
          await refreshCampaigns();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      };
      actions.appendChild(btn);
    }
    const del = document.createElement('button');
    del.className = 'small ghost';
    del.textContent = '✕';
    del.title = 'Remove from campaign';
    del.onclick = async () => {
      if (!confirm('Remove this creator?')) return;
      await api(`/api/creators/${r.id}`, { method: 'DELETE' });
      await refreshCreators();
      await refreshCampaigns();
    };
    actions.appendChild(del);
    tbody.appendChild(tr);
  }
}

el('sync-btn').addEventListener('click', async () => {
  const btn = el('sync-btn');
  const status = el('sync-status');
  btn.disabled = true;
  status.textContent = 'Syncing…';
  try {
    const r = await api('/api/campaigns/sync', { method: 'POST' });
    status.textContent = `Synced ${r.upserted} campaigns`;
    await refreshCampaigns();
  } catch (err) {
    status.textContent = `Sync failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

el('creator-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedCampaignId) return;
  const payload = {
    campaign_id: state.selectedCampaignId,
    instagram_url: el('ig-url').value.trim(),
  };
  try {
    await api('/api/creators', { method: 'POST', body: JSON.stringify(payload) });
    el('ig-url').value = '';
    await refreshCreators();
    await refreshCampaigns();
  } catch (err) {
    alert(err.message);
  }
});

el('refresh-btn').addEventListener('click', refreshCreators);

el('send-emails-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
  const pendingCount = c ? c.email_found_count : '?';
  if (!confirm(`Send outreach to ${pendingCount} pending creator(s)? This sends real emails.`)) return;
  const btn = el('send-emails-btn');
  const status = el('fetch-status');
  btn.disabled = true;
  status.hidden = false;
  status.textContent = 'Sending outreach emails…';
  try {
    const result = await api('/api/creators/bulk/send-outreach', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: state.selectedCampaignId }),
    });
    status.textContent = `Done. Sent ${result.sent}, failed ${result.failed} (of ${result.processed}).`;
    await refreshCreators();
    await refreshCampaigns();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

el('fetch-emails-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const btn = el('fetch-emails-btn');
  const status = el('fetch-status');
  btn.disabled = true;
  status.hidden = false;
  status.textContent = 'Fetching emails for all pending creators…';
  try {
    const result = await api('/api/creators/bulk/fetch-email', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: state.selectedCampaignId }),
    });
    const found = result.results.filter((r) => r.email).length;
    status.textContent = `Done. Processed ${result.processed}, found ${found} email(s).`;
    await refreshCreators();
    await refreshCampaigns();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

(async () => {
  await refreshAuth();
  await refreshCampaigns();
})();
