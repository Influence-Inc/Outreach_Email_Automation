'use strict';

// POST /api/creators/:id/cpm — the extension panel's editable CPM / rate / topic / country —
// and the estimate GET /api/creators/panel returns. The real router is mounted on a throwaway
// Express app and driven over HTTP; only the database is stubbed.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const db = require('../db');
const router = require('./creators');

const orig = { one: db.one, many: db.many, query: db.query };

const CREATOR = {
  id: 7,
  campaign_id: 'c1',
  instagram_username: 'sam',
  ig_biography: '📍 Mumbai | skincare & makeup',
  ig_category: null,
  ig_scraped_data: { p10: 9000, p25: 20000, p50: 40000, p75: 60000, min_views: 8000, reel_count: 12, views_raw: [] },
  quoted_rate: null,
  deal_cpm: null,
  cpm_topic_override: null,
  cpm_country_override: null,
  suggested_offers: null,
  max_cpm: null,
};

// Records every UPDATE so a test can see what was written; the row the UPDATE returns
// reflects the SET assignments it carried.
function install(row = CREATOR) {
  const writes = [];
  const state = { ...row };
  db.one = async (sql, params) => {
    if (/^\s*UPDATE creators SET/i.test(sql)) {
      writes.push({ sql, params });
      const cols = [...sql.matchAll(/(\w+) = \$(\d+)/g)];
      for (const [, col, n] of cols) {
        const v = params[Number(n) - 1];
        state[col] = col === 'suggested_offers' ? JSON.parse(v) : v;
      }
      return { ...state };
    }
    if (/FROM creators c LEFT JOIN campaigns/i.test(sql)) return { ...state };
    if (/SELECT max_cpm FROM campaigns/i.test(sql)) return { max_cpm: state.max_cpm };
    return null;
  };
  db.many = async () => [];
  db.query = async () => ({ rows: [], rowCount: 1 });
  return { writes, state };
}

function restore() {
  Object.assign(db, orig);
}

async function post(body, id = 7) {
  const app = express();
  app.use(express.json());
  app.use('/api/creators', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/creators/${id}/cpm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('setting a CPM stores it and re-prices the suggested offers at it', async () => {
  const { writes } = install();
  try {
    const r = await post({ deal_cpm: 12.5 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cpm_estimate.deal.cpm, 12.5);
    assert.strictEqual(r.body.cpm_estimate.deal.source, 'admin');
    assert.strictEqual(r.body.cpm_estimate.deal.rate, 500); // 40,000 views x $12.50 / 1000
    assert.ok(Array.isArray(r.body.suggested_offers) && r.body.suggested_offers.length);
    // computeOffers applies its risk buffer to the CPM it is given: 12.5 x 0.8.
    assert.strictEqual(r.body.suggested_offers[0].cpm_applied, 10);
    assert.match(writes[0].sql, /deal_cpm = \$2/);
    assert.strictEqual(writes[0].params[1], 12.5);
  } finally {
    restore();
  }
});

test('setting a rate stores the CPM it implies at the expected views', async () => {
  const { writes } = install();
  try {
    const r = await post({ deal_rate: 600 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(writes[0].params[1], 15); // 600 x 1000 / 40,000
    assert.strictEqual(r.body.cpm_estimate.deal.rate, 600);
  } finally {
    restore();
  }
});

test('clearing the CPM goes back to the automated estimate', async () => {
  install({ ...CREATOR, deal_cpm: '20.00' });
  try {
    const r = await post({ deal_cpm: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cpm_estimate.deal.source, 'estimate');
    assert.strictEqual(r.body.cpm_estimate.deal.cpm, 6.19); // skincare x India
  } finally {
    restore();
  }
});

test('topic and country overrides re-estimate the CPM', async () => {
  install();
  try {
    const r = await post({ topic: 'tech', country: 'us' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cpm_estimate.cpm.value, 47.5);
    assert.deepStrictEqual(r.body.cpm_estimate.overrides, { deal_cpm: null, topic: 'tech', country: 'US' });
  } finally {
    restore();
  }
});

test('the estimate is not cut to the campaign max CPM, only flagged above it', async () => {
  install({ ...CREATOR, max_cpm: '30.00' });
  try {
    const r = await post({ topic: 'tech', country: 'US' });
    assert.strictEqual(r.body.cpm_estimate.deal.source, 'estimate');
    assert.strictEqual(r.body.cpm_estimate.deal.cpm, 47.5);
    assert.strictEqual(r.body.cpm_estimate.deal.above_campaign_max, true);
  } finally {
    restore();
  }
});

test('bad input is rejected without writing anything', async () => {
  const { writes } = install();
  try {
    assert.strictEqual((await post({ deal_cpm: -3 })).status, 400);
    assert.strictEqual((await post({ deal_cpm: 'abc' })).status, 400);
    assert.strictEqual((await post({ topic: 'not_a_topic' })).status, 400);
    assert.strictEqual((await post({ country: 'ZZ' })).status, 400);
    assert.strictEqual((await post({ deal_cpm: 5, deal_rate: 100 })).status, 400);
    assert.strictEqual((await post({})).status, 400);
    assert.strictEqual(writes.length, 0);
  } finally {
    restore();
  }
});

test('a rate cannot be set before the creator has view stats', async () => {
  install({ ...CREATOR, ig_scraped_data: null });
  try {
    const r = await post({ deal_rate: 500 });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /scrape/);
  } finally {
    restore();
  }
});

test('unknown creator is a 404', async () => {
  install();
  db.one = async () => null;
  try {
    assert.strictEqual((await post({ deal_cpm: 10 }, 999)).status, 404);
  } finally {
    restore();
  }
});
