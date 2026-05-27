const API = '';

const state = {
  campaigns: [],
  selectedCampaignId: null,
  sequences: [],
  templateDefaults: { outreach: { subject: '', body: '' }, followup: { subject: '', body: '' } },
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

function showView(name) {
  el('campaign-view').hidden = name !== 'campaign';
  el('sequences-view').hidden = name !== 'sequences';
}

async function selectCampaign(id) {
  showView('campaign');
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
  el('templates-card').hidden = false;
  renderTemplatesCard(c);
  await refreshCreators();
}

function makeEditable(td, { value, placeholder, onSave }) {
  td.classList.add('editable');
  td.title = 'Click to edit';
  td.addEventListener('click', () => {
    if (td.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.placeholder = placeholder || '';
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const restore = () => {
      if (finished) return;
      finished = true;
      refreshCreators();
    };
    const commit = async () => {
      if (finished) return;
      finished = true;
      const next = input.value.trim();
      if (next === (value || '')) {
        refreshCreators();
        return;
      }
      if (!next) {
        // empty input = treat as cancel; clearing requires deleting the row.
        refreshCreators();
        return;
      }
      try {
        await onSave(next);
      } catch (err) {
        alert(err.message);
      }
      refreshCreators();
      await refreshCampaigns();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        restore();
      }
    });
    input.addEventListener('blur', commit);
  });
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
    const cells = tr.querySelectorAll('td');
    const nameTd = cells[1];
    const emailTd = cells[2];
    const actions = cells[cells.length - 1];

    makeEditable(nameTd, {
      value: r.full_name || r.first_name || '',
      placeholder: 'Account name',
      onSave: (v) =>
        api(`/api/creators/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            full_name: v,
            first_name: v.split(/\s+/)[0],
          }),
        }),
    });
    makeEditable(emailTd, {
      value: r.email || '',
      placeholder: 'creator@email.com',
      onSave: (v) =>
        api(`/api/creators/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ email: v }),
        }),
    });

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
  const raw = el('ig-urls').value;
  const urls = Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => /instagram\.com/i.test(s)),
    ),
  );
  if (!urls.length) {
    alert('Paste at least one Instagram URL.');
    return;
  }
  const status = el('add-status');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  let added = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i++) {
    status.textContent = `Adding ${i + 1}/${urls.length}…`;
    try {
      await api('/api/creators', {
        method: 'POST',
        body: JSON.stringify({
          campaign_id: state.selectedCampaignId,
          instagram_url: urls[i],
        }),
      });
      added += 1;
    } catch (err) {
      failed += 1;
      console.warn(`Failed to add ${urls[i]}: ${err.message}`);
    }
  }
  status.textContent = `Added ${added} creator(s)${failed ? `, ${failed} failed` : ''}.`;
  if (!failed) el('ig-urls').value = '';
  submitBtn.disabled = false;
  await refreshCreators();
  await refreshCampaigns();
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

// --- Extension bridge ----------------------------------------------------
// The Chrome extension content script announces itself on load with a
// window.postMessage({type: 'OEA_EXTENSION_READY'}). Track that so we can
// tell the user when the extension isn't installed.
const extensionBridge = { ready: false };

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'OEA_EXTENSION_READY') {
    extensionBridge.ready = true;
    return;
  }
  if (msg.type === 'OEA_SCRAPE_PROGRESS') {
    handleScrapeProgress(msg);
  }
});

function showScrapeProgress(text) {
  el('scrape-progress').hidden = false;
  el('scrape-progress-text').textContent = text;
}

function hideScrapeProgress() {
  el('scrape-progress').hidden = true;
  el('scrape-progress-text').textContent = '';
}

let scrapeAffectedRowIds = new Set();

function handleScrapeProgress(msg) {
  if (msg.event === 'start') {
    showScrapeProgress(`Scraping 0/${msg.total}…`);
    scrapeAffectedRowIds = new Set();
  } else if (msg.event === 'creator-start') {
    showScrapeProgress(
      `Scraping ${msg.index}/${msg.total} — @${msg.username || msg.creatorId}…`,
    );
  } else if (msg.event === 'creator-done') {
    scrapeAffectedRowIds.add(msg.creatorId);
    let tail;
    if (msg.outcome === 'email_found') {
      tail = `got ${msg.email} for @${msg.username || msg.creatorId}`;
    } else if (msg.outcome === 'no_email') {
      tail = `no email for @${msg.username || msg.creatorId}`;
    } else {
      tail = `error on @${msg.username || msg.creatorId}: ${msg.error || 'unknown'}`;
    }
    showScrapeProgress(`Scraping ${msg.index}/${msg.total} — ${tail}`);
  } else if (msg.event === 'done') {
    const s = msg.summary || {};
    showScrapeProgress(
      `Done. ${s.processed || 0} processed · ${s.emailFound || 0} found · ${s.noEmail || 0} no email · ${s.errors || 0} errors. ` +
      `[hide]`,
    );
    el('scrape-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'aborted') {
    showScrapeProgress(`Aborted at ${msg.index}/${msg.total}.`);
    el('scrape-cancel-btn').textContent = 'Hide';
    refreshCreators();
    refreshCampaigns();
  } else if (msg.event === 'error') {
    showScrapeProgress(`Extension error: ${msg.error}`);
    el('scrape-cancel-btn').textContent = 'Hide';
  }
}

el('scrape-cancel-btn').addEventListener('click', () => {
  if (el('scrape-cancel-btn').textContent === 'Hide') {
    hideScrapeProgress();
    el('scrape-cancel-btn').textContent = 'Cancel';
    return;
  }
  window.postMessage({ type: 'OEA_ABORT_SCRAPE_QUEUE' }, window.location.origin);
  showScrapeProgress('Cancelling after current creator…');
});

el('run-extension-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const btn = el('run-extension-btn');
  btn.disabled = true;
  el('scrape-cancel-btn').textContent = 'Cancel';
  try {
    const rows = await api(
      `/api/creators?campaign_id=${encodeURIComponent(state.selectedCampaignId)}`,
    );
    if (!rows.length) {
      showScrapeProgress('No creators in this campaign.');
      el('scrape-cancel-btn').textContent = 'Hide';
      return;
    }
    const creators = rows.map((r) => ({
      id: r.id,
      instagramUrl: r.instagram_url,
      instagramUsername: r.instagram_username,
    }));
    showScrapeProgress(`Starting scrape for ${creators.length} creator(s)…`);
    window.postMessage(
      {
        type: 'OEA_RUN_SCRAPE_QUEUE',
        payload: {
          apiBase: window.location.origin,
          creators,
          pacingMs: 5000,
        },
      },
      window.location.origin,
    );
    // If the extension never responds within 2s, assume it isn't installed.
    setTimeout(() => {
      if (!extensionBridge.ready) {
        showScrapeProgress(
          'Extension not detected. Load the unpacked extension at chrome://extensions then reload this page.',
        );
        el('scrape-cancel-btn').textContent = 'Hide';
      }
    }, 2000);
  } catch (err) {
    showScrapeProgress(`Failed: ${err.message}`);
    el('scrape-cancel-btn').textContent = 'Hide';
  } finally {
    btn.disabled = false;
  }
});

// --- Follow-up sequences (sidebar) ---------------------------------------

function describeSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return 'no steps';
  return steps.map((s) => `${s.delayHours}h`).join(' → ');
}

async function refreshSequences() {
  state.sequences = await api('/api/sequences');
  renderSequencesList();
  // Also refresh the per-campaign editor's sequence dropdown if it's visible.
  const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
  if (c && !el('templates-card').hidden) renderTemplatesCard(c);
}

function renderSequencesList() {
  const root = el('sequences-list');
  root.innerHTML = '';
  if (!state.sequences.length) {
    root.innerHTML = '<p class="hint">No sequences yet. Click "+ New" to add one.</p>';
    return;
  }
  for (const seq of state.sequences) {
    const item = document.createElement('div');
    item.className = 'sequence-item';
    item.innerHTML = `
      <div class="sequence-summary">
        <b>${seq.name}</b>
        <span class="meta">${describeSteps(seq.steps)}</span>
      </div>
    `;
    const summary = item.querySelector('.sequence-summary');
    summary.style.cursor = 'pointer';
    summary.onclick = () => {
      const existing = item.querySelector('.sequence-editor');
      if (existing) { existing.remove(); return; }
      item.appendChild(buildSequenceEditor(seq));
    };
    root.appendChild(item);
  }
}

function buildSequenceEditor(seq) {
  const wrap = document.createElement('div');
  wrap.className = 'sequence-editor';
  const steps = Array.isArray(seq.steps) ? seq.steps.map((s) => ({ ...s })) : [];

  function render() {
    wrap.innerHTML = `
      <label>Name <input type="text" class="seq-name" value="${seq.name || ''}" /></label>
      <div class="seq-steps"></div>
      <div class="row" style="gap: 8px; margin-top: 6px;">
        <button type="button" class="ghost small seq-add">+ Step</button>
        <button type="button" class="small seq-save">Save</button>
        ${seq.id ? '<button type="button" class="ghost small seq-delete">Delete</button>' : ''}
        <span class="hint seq-status"></span>
      </div>
    `;
    const stepsEl = wrap.querySelector('.seq-steps');
    steps.forEach((step, i) => {
      const row = document.createElement('div');
      row.className = 'row seq-step-row';
      row.innerHTML = `
        <span class="meta">#${i + 1}</span>
        <input type="number" min="0" step="1" value="${step.delayHours ?? ''}" placeholder="delay h" class="seq-step-delay" />
        <input type="text" value="${step.label || ''}" placeholder="label (optional)" class="seq-step-label" />
        <button type="button" class="ghost small seq-step-remove">✕</button>
      `;
      row.querySelector('.seq-step-delay').oninput = (e) => {
        steps[i].delayHours = Number(e.target.value);
      };
      row.querySelector('.seq-step-label').oninput = (e) => {
        steps[i].label = e.target.value;
      };
      row.querySelector('.seq-step-remove').onclick = () => {
        steps.splice(i, 1);
        render();
      };
      stepsEl.appendChild(row);
    });
    wrap.querySelector('.seq-add').onclick = () => {
      steps.push({ delayHours: 24 });
      render();
    };
    wrap.querySelector('.seq-save').onclick = async (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;
      const name = wrap.querySelector('.seq-name').value.trim();
      const status = wrap.querySelector('.seq-status');
      if (!name) { status.textContent = 'name required'; return; }
      const cleaned = steps
        .map((s) => ({
          delayHours: Number(s.delayHours),
          ...(s.label ? { label: s.label } : {}),
        }))
        .filter((s) => Number.isFinite(s.delayHours) && s.delayHours >= 0);
      if (!cleaned.length) { status.textContent = 'at least one step required'; return; }
      btn.disabled = true;
      try {
        if (seq.id) {
          await api(`/api/sequences/${seq.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name, steps: cleaned }),
          });
        } else {
          await api('/api/sequences', {
            method: 'POST',
            body: JSON.stringify({ name, steps: cleaned }),
          });
        }
        await refreshSequences();
      } catch (err) {
        status.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    };
    const delBtn = wrap.querySelector('.seq-delete');
    if (delBtn) {
      delBtn.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete sequence "${seq.name}"? Any campaign using it will lose its assignment.`)) return;
        try {
          await api(`/api/sequences/${seq.id}`, { method: 'DELETE' });
          await refreshSequences();
          await refreshCampaigns();
        } catch (err) {
          wrap.querySelector('.seq-status').textContent = err.message;
        }
      };
    }
    wrap.onclick = (ev) => ev.stopPropagation();
  }
  render();
  return wrap;
}

el('new-sequence-btn').addEventListener('click', () => {
  const root = el('sequences-list');
  if (root.querySelector('.sequence-editor[data-new]')) return;
  const item = document.createElement('div');
  item.className = 'sequence-item';
  const editor = buildSequenceEditor({ name: '', steps: [{ delayHours: 24 }] });
  editor.setAttribute('data-new', '1');
  item.appendChild(editor);
  root.prepend(item);
});

el('open-sequences-btn').addEventListener('click', () => {
  showView('sequences');
});

// --- Per-campaign template editor ----------------------------------------

function renderTemplatesCard(campaign) {
  const select = el('templates-sequence');
  select.innerHTML = '<option value="">(no follow-ups)</option>';
  for (const seq of state.sequences) {
    const opt = document.createElement('option');
    opt.value = String(seq.id);
    opt.textContent = `${seq.name} (${describeSteps(seq.steps)})`;
    if (campaign.sequence_id === seq.id) opt.selected = true;
    select.appendChild(opt);
  }
  el('templates-sequence-summary').textContent = '';

  const templates = (campaign.templates && typeof campaign.templates === 'object')
    ? campaign.templates : {};

  const renderEditors = () => {
    const editors = el('templates-editors');
    editors.innerHTML = '';
    editors.appendChild(buildTemplateEditor(
      'outreach',
      'Outreach email (initial)',
      templates.outreach || {},
      state.templateDefaults.outreach,
    ));

    const selectedId = Number(select.value) || null;
    const seq = state.sequences.find((s) => s.id === selectedId);
    const stepCount = seq ? seq.steps.length : 0;
    const followups = Array.isArray(templates.followups) ? templates.followups : [];

    for (let i = 0; i < stepCount; i++) {
      const step = seq.steps[i];
      const label = step.label ? `Follow-up #${i + 1} — ${step.label} (after ${step.delayHours}h)`
                              : `Follow-up #${i + 1} (after ${step.delayHours}h)`;
      editors.appendChild(buildTemplateEditor(
        `followup-${i}`,
        label,
        followups[i] || {},
        state.templateDefaults.followup,
      ));
    }

    if (!seq) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'Pick a sequence above to edit per-step follow-up emails.';
      editors.appendChild(note);
    }
  };

  select.onchange = renderEditors;
  renderEditors();
  el('templates-save-status').hidden = true;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Pre-fills with the campaign's override if present, otherwise the global
// default so the user can see and tweak the real copy that's being sent.
// Clearing the field and saving falls back to the global default.
function buildTemplateEditor(key, label, tpl, defaults) {
  const card = document.createElement('details');
  card.className = 'template-block';
  card.dataset.key = key;
  const hasOverride = (tpl.subject && tpl.subject !== '') || (tpl.body && tpl.body !== '');
  const subject = tpl.subject != null && tpl.subject !== ''
    ? tpl.subject : (defaults && defaults.subject) || '';
  const body = tpl.body != null && tpl.body !== ''
    ? tpl.body : (defaults && defaults.body) || '';
  card.innerHTML = `
    <summary>
      <span class="template-block-title">${escapeHtml(label)}</span>
      <span class="template-block-badge">${hasOverride ? 'customized' : 'using default'}</span>
    </summary>
    <div class="template-block-body">
      <label>Subject
        <input type="text" class="tpl-subject" value="${escapeHtml(subject)}" />
      </label>
      <label>Body
        <textarea class="tpl-body" rows="10">${escapeHtml(body)}</textarea>
      </label>
      <p class="hint" style="margin: 4px 0 0;">Clear and save to revert to the global default.</p>
    </div>
  `;
  return card;
}

el('templates-save-btn').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const btn = el('templates-save-btn');
  const status = el('templates-save-status');
  status.hidden = false;
  status.textContent = 'Saving…';
  btn.disabled = true;
  try {
    const select = el('templates-sequence');
    const sequence_id = select.value ? Number(select.value) : null;

    const templates = { outreach: null, followups: [] };
    const editors = el('templates-editors').querySelectorAll('.template-block');
    for (const block of editors) {
      const subject = block.querySelector('.tpl-subject').value.trim();
      const body = block.querySelector('.tpl-body').value;
      const entry = (subject || body) ? { subject, body } : null;
      if (block.dataset.key === 'outreach') {
        templates.outreach = entry;
      } else if (block.dataset.key.startsWith('followup-')) {
        const idx = Number(block.dataset.key.split('-')[1]);
        templates.followups[idx] = entry;
      }
    }
    // Drop trailing empty followups for tidiness.
    while (templates.followups.length && !templates.followups[templates.followups.length - 1]) {
      templates.followups.pop();
    }
    if (!templates.outreach) delete templates.outreach;
    if (!templates.followups.length) delete templates.followups;

    const updated = await api(`/api/campaigns/${encodeURIComponent(state.selectedCampaignId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sequence_id, templates }),
    });
    status.textContent = 'Saved.';
    await refreshCampaigns();
    const c = state.campaigns.find((x) => x.id === state.selectedCampaignId);
    if (c) {
      // Merge any fields the list query doesn't surface (e.g. fresh templates).
      if (updated) { c.templates = updated.templates; c.sequence_id = updated.sequence_id; }
      renderTemplatesCard(c);
    }
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

async function refreshTemplateDefaults() {
  try {
    state.templateDefaults = await api('/api/templates/defaults');
  } catch (err) {
    console.error('failed to load template defaults:', err);
  }
}

(async () => {
  await refreshAuth();
  await refreshTemplateDefaults();
  await refreshSequences();
  await refreshCampaigns();
})();
