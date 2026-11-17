'use strict';

// TikTok / YouTube creators: POST /api/creators canonicalises the profile URL,
// records the platform, scopes the duplicate check to it; the Instagram-only
// paths (server-side scrape, IG DM) refuse non-Instagram rows. The real router
// runs on a throwaway Express app; only the database is stubbed.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const db = require('../db');
const router = require('./creators');

const orig = { one: db.one, many: db.many, query: db.query };
function restore() {
  Object.assign(db, orig);
}

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/creators', router);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const resp = await fetch(`http://127.0.0.1:${port}/api/creators${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: resp.status, body: await resp.json() };
  } finally {
    server.close();
  }
}

function installInsertStub() {
  const calls = [];
  db.one = async (sql, params) => {
    calls.push({ sql, params });
    if (/INSERT INTO creators/i.test(sql)) {
      return {
        id: 1, campaign_id: params[0], instagram_url: params[1], instagram_username: params[2],
        status: params[6], platform: params[8],
      };
    }
    return null; // no duplicate
  };
  db.query = async () => ({ rows: [], rowCount: 1 });
  return calls;
}

test('POST /api/creators adds a TikTok creator under its canonical profile URL', async () => {
  const calls = installInsertStub();
  try {
    const res = await call('POST', '/', {
      campaign_id: 'c1',
      profile_url: 'https://www.tiktok.com/@Some.Creator/video/7312345678901234567?lang=en',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.platform, 'tiktok');
    assert.strictEqual(res.body.instagram_url, 'https://www.tiktok.com/@Some.Creator');
    assert.strictEqual(res.body.instagram_username, 'Some.Creator');
    assert.strictEqual(res.body.status, 'pending_extraction');
    const dupCheck = calls.find((c) => /status <> 'duplicate'/.test(c.sql));
    assert.strictEqual(dupCheck.params[4], 'tiktok', 'duplicate check is scoped to TikTok handles');
  } finally {
    restore();
  }
});

test('POST /api/creators adds a YouTube channel (legacy instagram_url field still accepted)', async () => {
  installInsertStub();
  try {
    const res = await call('POST', '/', {
      campaign_id: 'c1',
      instagram_url: 'https://youtube.com/@ChannelName/shorts',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.platform, 'youtube');
    assert.strictEqual(res.body.instagram_url, 'https://www.youtube.com/@ChannelName');
    assert.strictEqual(res.body.instagram_username, 'ChannelName');
  } finally {
    restore();
  }
});

test('POST /api/creators keeps Instagram behaviour unchanged', async () => {
  installInsertStub();
  try {
    const res = await call('POST', '/', { campaign_id: 'c1', instagram_url: 'https://instagram.com/foo/reels/' });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.platform, 'instagram');
    assert.strictEqual(res.body.instagram_url, 'https://www.instagram.com/foo/');
  } finally {
    restore();
  }
});

test('POST /api/creators rejects a platform URL that is not a profile', async () => {
  installInsertStub();
  try {
    const res = await call('POST', '/', { campaign_id: 'c1', profile_url: 'https://www.youtube.com/watch?v=abc' });
    assert.strictEqual(res.status, 400);
  } finally {
    restore();
  }
});

test('IG DM queue refuses a TikTok creator', async () => {
  db.one = async (sql) => {
    if (/SELECT \* FROM creators WHERE id = \$1/.test(sql)) {
      return { id: 3, campaign_id: 'c1', platform: 'tiktok', instagram_url: 'https://www.tiktok.com/@a', instagram_username: 'a', status: 'no_email' };
    }
    return { id: 'c1', ig_dm_body: 'Hi {firstName}', name: 'Camp', brand_name: 'Brand' };
  };
  db.many = async () => [];
  db.query = async () => ({ rows: [], rowCount: 1 });
  try {
    const res = await call('POST', '/3/queue-ig-dm');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Instagram handle/);
  } finally {
    restore();
  }
});

test('server-side fetch-email refuses a YouTube creator (the extension scrapes it)', async () => {
  db.one = async () => ({ id: 4, campaign_id: 'c1', platform: 'youtube', instagram_url: 'https://www.youtube.com/@a', status: 'pending_extraction' });
  try {
    const res = await call('POST', '/4/fetch-email');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /extension/);
  } finally {
    restore();
  }
});
