const API = '';

const state = {
  brands: [],
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

async function refreshBrands() {
  state.brands = await api('/api/brands');
  const list = el('brand-list');
  list.innerHTML = '';
  for (const b of state.brands) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${b.name}</span><span class="meta">${b.campaign_count} camp.</span>`;
    list.appendChild(li);
  }
  const select = el('campaign-brand');
  select.innerHTML = '';
  for (const b of state.brands) {
    const opt = document.createElement('option');
    opt.value = b.id; opt.textContent = b.name;
    select.appendChild(opt);
  }
}

async function refreshCampaigns() {
  state.campaigns = await api('/api/campaigns');
  const list = el('campaign-list');
  list.innerHTML = '';
  for (const c of state.campaigns) {
    const li = document.createElement('li');
    if (c.id === state.selectedCampaignId) li.classList.add('active');
    li.innerHTML = `
      <span>${c.brand_name} · ${c.name}</span>
      <span class="meta">${c.creator_count}</span>`;
    li.onclick = () => selectCampaign(c.id);
    list.appendChild(li);
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
    <span>Outreach: <b>${c.outreach_sent_count}</b></span>
    <span>Follow-up: <b>${c.followup_sent_count}</b></span>
    <span>Replied: <b>${c.replied_count}</b></span>
  `;
  el('creator-form').hidden = false;
  el('creator-table-wrap').hidden = false;
  await refreshCreators();
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleString();
}

async function refreshCreators() {
  if (!state.selectedCampaignId) return;
  const rows = await api(`/api/creators?campaign_id=${state.selectedCampaignId}`);
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

el('brand-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el('brand-name').value.trim();
  if (!name) return;
  await api('/api/brands', { method: 'POST', body: JSON.stringify({ name }) });
  el('brand-name').value = '';
  await refreshBrands();
});

el('campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const brand_id = Number(el('campaign-brand').value);
  const name = el('campaign-name').value.trim();
  if (!brand_id || !name) return;
  await api('/api/campaigns', { method: 'POST', body: JSON.stringify({ brand_id, name }) });
  el('campaign-name').value = '';
  await refreshCampaigns();
});

el('creator-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedCampaignId) return;
  const payload = {
    campaign_id: state.selectedCampaignId,
    instagram_url: el('ig-url').value.trim(),
    email: el('ig-email').value.trim() || null,
    first_name: el('ig-first-name').value.trim() || null,
    full_name: el('ig-full-name').value.trim() || null,
  };
  await api('/api/creators', { method: 'POST', body: JSON.stringify(payload) });
  el('ig-url').value = '';
  el('ig-email').value = '';
  el('ig-first-name').value = '';
  el('ig-full-name').value = '';
  await refreshCreators();
  await refreshCampaigns();
});

el('refresh-btn').addEventListener('click', refreshCreators);

(async () => {
  await refreshAuth();
  await refreshBrands();
  await refreshCampaigns();
})();
