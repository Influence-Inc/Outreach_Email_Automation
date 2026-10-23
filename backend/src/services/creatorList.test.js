'use strict';

// services/creatorList.js against a fake creator-list partner API and a stubbed database: when it
// reads, when it queues (once per creator), what it caches, and what lands on the creators rows.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const creatorList = require('./creatorList');

const orig = { one: db.one, many: db.many, query: db.query };
const ENV = { url: process.env.CREATOR_LIST_API_URL, key: process.env.CREATOR_LIST_API_KEY };

const INDEXED = {
  handle: 'mia.skin',
  as_of: '2026-10-20T00:00:00+00:00',
  estimated_cpm: { mid: 6.81, low: 3.3, high: 11.55 },
  estimated_rate: { mid: 172, low: 83, high: 292 },
  typical_views: 25000,
  reels_analysed: 30,
  brands: ['cerave'],
  bio: 'never copied',
};

// The cache table in memory, and every UPDATE of creators rows.
function install() {
  const profiles = new Map();
  const applied = [];
  db.one = async (sql, params) => {
    if (/FROM creator_list_profiles/.test(sql)) return profiles.get(params[0]) || null;
    return null;
  };
  db.query = async (sql, params) => {
    if (/INSERT INTO creator_list_profiles/.test(sql)) {
      const [handle, status, data, request, error, queued] = params;
      const prev = profiles.get(handle) || {};
      profiles.set(handle, {
        handle,
        status,
        data: data ? JSON.parse(data) : prev.data || null,
        request: request ? JSON.parse(request) : prev.request || null,
        error,
        queued_at: queued ? new Date() : prev.queued_at || null,
        checked_at: new Date(),
      });
    }
    return { rows: [], rowCount: 1 };
  };
  db.many = async (sql, params) => {
    if (/UPDATE creators SET creator_list/.test(sql)) applied.push({ handle: params[0], copy: JSON.parse(params[1]) });
    return [];
  };
  return { profiles, applied };
}

// A fake partner API: answers from `script` (a function of method), records the calls.
function api(script) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, auth: opts.headers.Authorization });
    const { status = 200, body } = script(opts.method, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

function configure(on = true) {
  process.env.CREATOR_LIST_API_URL = on ? 'https://bench.example/' : '';
  process.env.CREATOR_LIST_API_KEY = on ? 'k3y' : '';
}

function restore() {
  Object.assign(db, orig);
  process.env.CREATOR_LIST_API_URL = ENV.url || '';
  process.env.CREATOR_LIST_API_KEY = ENV.key || '';
}

const age = (profiles, handle, ms) => {
  profiles.get(handle).checked_at = new Date(Date.now() - ms);
};

test('without the URL and key nothing is called and the panel is told why', async () => {
  install();
  configure(false);
  const { calls, fetchImpl } = api(() => ({ body: {} }));
  try {
    const st = await creatorList.sync('mia.skin', { queue: true, fetchImpl });
    assert.strictEqual(st.status, 'not_configured');
    assert.match(st.error, /CREATOR_LIST_API_URL/);
    assert.strictEqual(calls.length, 0);
  } finally {
    restore();
  }
});

test('an indexed creator is read, cached, copied onto their rows, and not asked again for 12 hours', async () => {
  const { profiles, applied } = install();
  configure();
  const { calls, fetchImpl } = api(() => ({ body: { status: 'indexed', creator: INDEXED } }));
  try {
    const st = await creatorList.sync('@Mia.Skin', { queue: true, fetchImpl });
    assert.strictEqual(st.status, 'indexed');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://bench.example/api/partner/creators/mia.skin');
    assert.strictEqual(calls[0].auth, 'Bearer k3y');
    assert.strictEqual(calls[0].method, 'POST', 'a creator never seen is looked up with queueing allowed');
    assert.strictEqual(applied.length, 1);
    assert.deepStrictEqual(applied[0].copy.estimated_cpm, { mid: 6.81, low: 3.3, high: 11.55 });
    assert.deepStrictEqual(applied[0].copy.estimated_rate, { mid: 172, low: 83, high: 292 });
    assert.ok(!('bio' in applied[0].copy));

    await creatorList.sync('mia.skin', { queue: true, fetchImpl });
    assert.strictEqual(calls.length, 1, 'fresh cache: no call');
    age(profiles, 'mia.skin', creatorList.FRESH_MS + 1000);
    await creatorList.sync('mia.skin', { queue: true, fetchImpl });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].method, 'GET', 'known creators are only read again');
  } finally {
    restore();
  }
});

test('a creator the index lacks is queued once, then only polled until indexed', async () => {
  const { profiles, applied } = install();
  configure();
  let indexed = false;
  const { calls, fetchImpl } = api((method) => {
    if (indexed) return { body: { status: 'indexed', creator: INDEXED } };
    return { status: method === 'POST' ? 202 : 200, body: { status: 'queued', request: { id: 'r1', status: 'queued' } } };
  });
  try {
    let st = await creatorList.sync('new.one', { queue: true, fetchImpl });
    assert.strictEqual(st.status, 'queued');
    assert.strictEqual(calls[0].method, 'POST');
    assert.ok(profiles.get('new.one').queued_at);

    await creatorList.sync('new.one', { queue: true, fetchImpl });
    assert.strictEqual(calls.length, 1, 'polled again only after POLL_MS');
    age(profiles, 'new.one', creatorList.POLL_MS + 1000);
    st = await creatorList.sync('new.one', { queue: true, fetchImpl });
    assert.strictEqual(calls[1].method, 'GET', 'never queued twice');

    indexed = true;
    age(profiles, 'new.one', creatorList.POLL_MS + 1000);
    st = await creatorList.sync('new.one', { queue: true, fetchImpl });
    assert.strictEqual(st.status, 'indexed');
    assert.strictEqual(applied.length, 1);
  } finally {
    restore();
  }
});

test('a failed analysis is not re-queued on its own; Retry (force) queues it again', async () => {
  const { profiles } = install();
  configure();
  const { calls, fetchImpl } = api((method) => (method === 'POST'
    ? { status: 202, body: { status: 'queued', request: { id: 'r2', status: 'queued' } } }
    : { body: { status: 'failed', request: { id: 'r1', status: 'failed', note: 'failed: private account' } } }));
  try {
    profiles.set('gone', { handle: 'gone', status: 'queued', queued_at: new Date(), checked_at: new Date(0) });
    let st = await creatorList.sync('gone', { queue: true, fetchImpl });
    assert.strictEqual(st.status, 'failed');
    assert.strictEqual(st.request.note, 'failed: private account');
    age(profiles, 'gone', creatorList.POLL_MS + 1000);
    await creatorList.sync('gone', { queue: true, fetchImpl });
    assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'GET']);
    st = await creatorList.sync('gone', { queue: true, force: true, fetchImpl });
    assert.strictEqual(calls[2].method, 'POST');
    assert.strictEqual(st.status, 'queued');
  } finally {
    restore();
  }
});

test('creator-list unreachable: an indexed creator keeps their numbers; others show the reason', async () => {
  const { profiles } = install();
  configure();
  const { fetchImpl } = api(() => ({ status: 401, body: { error: 'wrong or missing API key' } }));
  try {
    profiles.set('mia.skin', { handle: 'mia.skin', status: 'indexed', data: INDEXED, checked_at: new Date(0) });
    let st = await creatorList.sync('mia.skin', { queue: true, fetchImpl });
    assert.strictEqual(st.status, 'indexed');
    assert.match(st.error, /refused the API key/);
    st = await creatorList.sync('someone', { queue: true, fetchImpl });
    assert.strictEqual(st.status, 'error');
    assert.match(st.error, /CREATOR_LIST_API_KEY/);
  } finally {
    restore();
  }
});

test('bad handles never reach creator-list', async () => {
  install();
  configure();
  const { calls, fetchImpl } = api(() => ({ body: {} }));
  try {
    assert.strictEqual((await creatorList.sync('not a handle', { fetchImpl })).status, 'invalid');
    assert.strictEqual(calls.length, 0);
  } finally {
    restore();
  }
});

// ── the admin's collection: "Curated by INFLUENCE Team" ─────────────────────

function withWebEnv(web, key, fn) {
  const before = { web: process.env.CREATOR_LIST_WEB_URL, url: process.env.CREATOR_LIST_API_URL, key: process.env.CREATOR_LIST_API_KEY };
  const set = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
  set('CREATOR_LIST_WEB_URL', web);
  set('CREATOR_LIST_API_KEY', key);
  set('CREATOR_LIST_API_URL', null); // no bench: nothing queued, no network
  return Promise.resolve(fn()).finally(() => {
    set('CREATOR_LIST_WEB_URL', before.web);
    set('CREATOR_LIST_API_URL', before.url);
    set('CREATOR_LIST_API_KEY', before.key);
  });
}

test('addToCurated posts the shortlisted creator with Jev labels to the site', () => withWebEnv('https://site.test/', 'k', async () => {
  let sent = null;
  const out = await creatorList.addToCurated('@Coach.Mia', {
    labels: { topic: { value: 'fitness' }, niche: { value: 'unclear' }, genre: { value: 'educational' }, format: { value: 'talking_head' } },
    summary: 'Fitness · Educational · Talking head',
    sourceTerm: 'gym workout',
    fetchImpl: async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, collection: 'curated-by-influence-team' }) };
    },
  });
  assert.strictEqual(sent.url, 'https://site.test/api/partner/curated');
  assert.strictEqual(sent.init.headers.Authorization, 'Bearer k');
  assert.strictEqual(sent.body.handle, 'coach.mia');
  assert.deepStrictEqual(sent.body.labels, { topic: 'fitness', niche: null, genre: 'educational', format: 'talking_head' });
  assert.strictEqual(sent.body.note, 'Scouted by Deal Studio · Fitness · Educational · Talking head · found searching "gym workout"');
  assert.deepStrictEqual(out, { status: 'added', collection: 'curated-by-influence-team', already: false });
}));

test('addToCurated never throws: not configured, refused, or down', () => withWebEnv(null, 'k', async () => {
  assert.strictEqual((await creatorList.addToCurated('coach')).status, 'not_configured');
  process.env.CREATOR_LIST_WEB_URL = 'https://site.test';
  const refused = await creatorList.addToCurated('coach', { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.deepStrictEqual(refused, { status: 'error', error: 'creator-list refused the API key (CREATOR_LIST_API_KEY)' });
  const down = await creatorList.addToCurated('coach', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepStrictEqual(down, { status: 'error', error: 'ECONNREFUSED' });
  assert.strictEqual((await creatorList.addToCurated('not a handle!')).status, 'invalid');
}));
