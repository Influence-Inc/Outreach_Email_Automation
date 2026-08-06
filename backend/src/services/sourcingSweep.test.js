'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sweep = require('./sourcingSweep');
const { buildConfig } = require('./sourcingConfig');

// In-memory stand-in for backend/src/db exposing just the surface the sweep uses.
function memDb({ runs = [], hosts = [], campaigns = [] } = {}) {
  const queries = [];
  return {
    runs, hosts, campaigns, queries,
    async many(sql, params) {
      queries.push({ sql, params });
      if (/FROM sourcing_runs WHERE status = 'running'/.test(sql)) {
        const cutoff = new Date(params[0]);
        return runs.filter((r) => r.status === 'running' && new Date(r.updated_at) < cutoff).map((r) => ({ id: r.id }));
      }
      if (/FROM sourcing_hosts/.test(sql)) {
        const cutoff = new Date(params[0]);
        return hosts
          .filter((h) => h.status === 'active' && h.last_seen_at && new Date(h.last_seen_at) < cutoff)
          .map((h) => ({ id: h.id }));
      }
      if (/FROM campaigns c/.test(sql)) {
        // Return campaigns whose sourcing_defaults enabled=true and no live run.
        const liveByCampaign = new Set(runs.filter((r) => ['running', 'queued', 'paused'].includes(r.status)).map((r) => r.campaign_id));
        return campaigns
          .filter((c) => c.sourcing_defaults && String(c.sourcing_defaults.enabled) === 'true' && !liveByCampaign.has(c.id))
          .map((c) => ({ id: c.id, sourcing_defaults: c.sourcing_defaults }));
      }
      return [];
    },
    async one(sql, params) {
      queries.push({ sql, params });
      if (/INSERT INTO sourcing_runs/.test(sql)) {
        const row = { id: runs.length + 1, campaign_id: params[0], status: 'queued', target_count: params[2], updated_at: new Date().toISOString() };
        runs.push(row);
        return { id: row.id };
      }
      return null;
    },
    async query(sql, params) {
      queries.push({ sql, params });
      if (/UPDATE sourcing_runs\s+SET status = 'error'/.test(sql)) {
        const r = runs.find((x) => x.id === params[0]);
        if (r && r.status === 'running') { r.status = 'error'; r.error = params[1]; }
      } else if (/UPDATE sourcing_hosts SET status = 'stale'/.test(sql)) {
        const h = hosts.find((x) => x.id === params[0]);
        if (h && h.status === 'active') h.status = 'stale';
      }
    },
  };
}

test('reapStaleRuns flips a run whose updated_at is older than the threshold', async () => {
  const oldTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const freshTs = new Date().toISOString();
  const db = memDb({
    runs: [
      { id: 1, campaign_id: 'c1', status: 'running', updated_at: oldTs },
      { id: 2, campaign_id: 'c2', status: 'running', updated_at: freshTs },
      { id: 3, campaign_id: 'c3', status: 'done', updated_at: oldTs }, // ignored
    ],
  });
  const r = await sweep.reapStaleRuns({ db, staleMinutes: 15 });
  assert.strictEqual(r.reaped, 1);
  assert.strictEqual(db.runs[0].status, 'error');
  assert.match(db.runs[0].error, /heartbeat lost/);
  assert.strictEqual(db.runs[1].status, 'running');
  assert.strictEqual(db.runs[2].status, 'done');
});

test('reapStaleHosts flips an active host that has not been seen in 24h', async () => {
  const oldTs = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
  const freshTs = new Date().toISOString();
  const db = memDb({
    hosts: [
      { id: 1, status: 'active', last_seen_at: oldTs },
      { id: 2, status: 'active', last_seen_at: freshTs },
      { id: 3, status: 'revoked', last_seen_at: oldTs }, // ignored
      { id: 4, status: 'active', last_seen_at: null },   // ignored (never seen)
    ],
  });
  const r = await sweep.reapStaleHosts({ db, staleHours: 24 });
  assert.strictEqual(r.reaped, 1);
  assert.strictEqual(db.hosts[0].status, 'stale');
  assert.strictEqual(db.hosts[1].status, 'active');
  assert.strictEqual(db.hosts[2].status, 'revoked');
});

test('autoEnqueueRuns creates a queued run for an enabled campaign with no live run', async () => {
  const defaults = { enabled: true, niche: 'fitness', keywords: 'gym', targetCount: 5 };
  const db = memDb({
    campaigns: [
      { id: 'c1', sourcing_defaults: defaults },
      { id: 'c2', sourcing_defaults: { ...defaults, enabled: false } },       // disabled
      { id: 'c3', sourcing_defaults: { ...defaults, targetCount: 0 } },        // no target
      { id: 'c4', sourcing_defaults: { enabled: true } },                      // no niche/keywords
    ],
    runs: [
      { id: 99, campaign_id: 'c5', status: 'running', updated_at: new Date().toISOString() },
    ],
  });
  const r = await sweep.autoEnqueueRuns({ db, buildConfig });
  assert.strictEqual(r.enqueued, 1);
  assert.deepStrictEqual(r.runs.map((x) => x.campaignId), ['c1']);
  const inserted = db.runs.find((x) => x.campaign_id === 'c1');
  assert.strictEqual(inserted.status, 'queued');
});

test('autoEnqueueRuns skips a campaign that already has a live run', async () => {
  const defaults = { enabled: true, niche: 'fitness', targetCount: 5 };
  const db = memDb({
    campaigns: [{ id: 'c1', sourcing_defaults: defaults }],
    runs: [{ id: 1, campaign_id: 'c1', status: 'queued', updated_at: new Date().toISOString() }],
  });
  const r = await sweep.autoEnqueueRuns({ db, buildConfig });
  assert.strictEqual(r.enqueued, 0);
});

test('runSweep runs all three passes and returns their counts', async () => {
  const oldTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const db = memDb({
    runs: [{ id: 1, campaign_id: 'c1', status: 'running', updated_at: oldTs }],
    hosts: [{ id: 1, status: 'active', last_seen_at: new Date(Date.now() - 30 * 60 * 60_000).toISOString() }],
    campaigns: [{ id: 'c2', sourcing_defaults: { enabled: true, niche: 'x', targetCount: 3 } }],
  });
  const r = await sweep.runSweep({ db, buildConfig });
  assert.strictEqual(r.reapedRuns, 1);
  assert.strictEqual(r.reapedHosts, 1);
  assert.strictEqual(r.enqueued, 1);
});
