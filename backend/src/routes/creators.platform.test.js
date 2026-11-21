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

// DM queue: Instagram and TikTok creators without an email get a DM job
// carrying their platform; YouTube (no DMs) is refused.
function installDmStub(creator) {
  const writes = [];
  db.one = async (sql, params) => {
    if (/SELECT \* FROM creators WHERE id = \$1/.test(sql)) return creator;
    if (/FROM campaigns WHERE id = \$1/.test(sql)) return { id: 'c1', ig_dm_body: 'Hi {firstName}!', name: 'Camp', brand_name: 'Brand' };
    if (/^\s*UPDATE creators/i.test(sql)) return { ...creator, ig_dm_queued_at: 'now', ig_dm_body: params[1] };
    return null;
  };
  db.many = async () => [creator];
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  return writes;
}

test('DM queue builds a TikTok job for a TikTok creator without an email', async () => {
  const writes = installDmStub({
    id: 3, campaign_id: 'c1', platform: 'tiktok', instagram_url: 'https://www.tiktok.com/@jane',
    instagram_username: 'jane', first_name: 'Jane', status: 'no_email',
  });
  try {
    const res = await call('POST', '/3/queue-ig-dm');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      { platform: res.body.job.platform, url: res.body.job.instagramUrl, handle: res.body.job.instagramUsername, body: res.body.job.body },
      { platform: 'tiktok', url: 'https://www.tiktok.com/@jane', handle: 'jane', body: 'Hi Jane!' },
    );
    const ev = writes.find((w) => /'ig_dm_queued'/.test(w.sql));
    assert.strictEqual(ev.params[1].platform, 'tiktok');
  } finally {
    restore();
  }
});

test('DM queue still builds Instagram jobs', async () => {
  installDmStub({
    id: 5, campaign_id: 'c1', platform: 'instagram', instagram_url: 'https://www.instagram.com/sam/',
    instagram_username: 'sam', first_name: 'Sam', status: 'no_email',
  });
  try {
    const res = await call('POST', '/5/queue-ig-dm');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.job.platform, 'instagram');
  } finally {
    restore();
  }
});

test('DM queue refuses a YouTube channel that links no Instagram / TikTok', async () => {
  installDmStub({
    id: 6, campaign_id: 'c1', platform: 'youtube', instagram_url: 'https://www.youtube.com/@a',
    instagram_username: 'a', status: 'no_email', bio_links: ['https://example.com', 'https://www.instagram.com/p/abc/'],
  });
  try {
    const res = await call('POST', '/6/queue-ig-dm');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /doesn't link an Instagram or TikTok/);
  } finally {
    restore();
  }
});

test('DM queue sends a YouTube creator\'s DM to the Instagram account their channel links', async () => {
  const writes = installDmStub({
    id: 7, campaign_id: 'c1', platform: 'youtube', instagram_url: 'https://www.youtube.com/@mkbhd',
    instagram_username: 'mkbhd', first_name: 'Marques', status: 'no_email',
    bio_links: ['http://twitter.com/MKBHD', 'https://www.tiktok.com/@mkbhd', 'http://instagram.com/MKBHD'],
  });
  try {
    const res = await call('POST', '/7/queue-ig-dm');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      { platform: res.body.job.platform, via: res.body.job.via, url: res.body.job.instagramUrl, handle: res.body.job.instagramUsername },
      { platform: 'instagram', via: 'youtube', url: 'https://www.instagram.com/MKBHD/', handle: 'MKBHD' },
      'Instagram is preferred over TikTok when the channel links both',
    );
    const ev = writes.find((w) => /'ig_dm_queued'/.test(w.sql));
    assert.deepStrictEqual(ev.params[1], { username: 'MKBHD', platform: 'instagram', via: 'youtube' });
  } finally {
    restore();
  }
});

test('DM queue falls back to the linked TikTok account', async () => {
  installDmStub({
    id: 8, campaign_id: 'c1', platform: 'youtube', instagram_url: 'https://www.youtube.com/@tt',
    instagram_username: 'tt', status: 'no_email', bio_links: ['https://www.tiktok.com/@tt.real?lang=en'],
  });
  try {
    const res = await call('POST', '/8/queue-ig-dm');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.job.platform, 'tiktok');
    assert.strictEqual(res.body.job.instagramUrl, 'https://www.tiktok.com/@tt.real');
  } finally {
    restore();
  }
});

test('DM queue won\'t DM a linked account that is already its own row in the campaign', async () => {
  installDmStub({
    id: 9, campaign_id: 'c1', platform: 'youtube', instagram_url: 'https://www.youtube.com/@dupe',
    instagram_username: 'dupe', status: 'no_email', bio_links: ['https://www.instagram.com/dupe.ig/'],
  });
  const one = db.one;
  db.one = async (sql, params) => {
    if (/AND LOWER\(instagram_username\) = LOWER\(\$4\)/.test(sql)) return { id: 42, instagram_username: 'dupe.ig' };
    return one(sql, params);
  };
  try {
    const res = await call('POST', '/9/queue-ig-dm');
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /already in this campaign/);
  } finally {
    restore();
  }
});

test('timeline says when a DM went to a YouTube creator\'s linked account', () => {
  assert.strictEqual(
    router.rateLogEntry('ig_dm_sent', { platform: 'instagram', via: 'youtube', username: 'MKBHD' }).text,
    'Instagram DM sent (priority) to @MKBHD (linked from YouTube)',
  );
  assert.strictEqual(
    router.rateLogEntry('ig_dm_failed', { platform: 'tiktok', via: 'youtube', username: 'tt', error: 'not signed in to TikTok' }).text,
    'TikTok DM failed — not signed in to TikTok',
  );
});

test('bulk DM queue covers Instagram + TikTok + YouTube (via linked accounts)', async () => {
  let selectSql = null;
  let selectParams = null;
  installDmStub({
    id: 3, campaign_id: 'c1', platform: 'tiktok', instagram_url: 'https://www.tiktok.com/@jane',
    instagram_username: 'jane', first_name: 'Jane', status: 'no_email',
  });
  const many = db.many;
  db.many = async (sql, params) => {
    selectSql = sql;
    selectParams = params;
    return many(sql, params);
  };
  try {
    const res = await call('POST', '/bulk/queue-ig-dm', { campaign_id: 'c1' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.queued, 1);
    assert.strictEqual(res.body.jobs[0].platform, 'tiktok');
    assert.match(selectSql, /platform = ANY\(\$3::text\[\]\)/);
    assert.deepStrictEqual(selectParams[2], ['instagram', 'tiktok', 'youtube']);
  } finally {
    restore();
  }
});

test('timeline names the DM platform', () => {
  assert.strictEqual(router.rateLogEntry('ig_dm_sent', { platform: 'tiktok' }).text, 'TikTok DM sent');
  assert.strictEqual(router.rateLogEntry('ig_dm_queued', { platform: 'tiktok' }).text, 'TikTok DM queued');
  assert.strictEqual(
    router.rateLogEntry('ig_dm_failed', { platform: 'tiktok', error: 'not signed in to TikTok' }).text,
    'TikTok DM failed — not signed in to TikTok',
  );
  // Older events carry no platform: Instagram.
  assert.strictEqual(router.rateLogEntry('ig_dm_sent', {}).text, 'Instagram DM sent (priority)');
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

test('bulk DM queue scoped to one platform: Send TikTok DMs takes TikTok + YouTube→TikTok only', async () => {
  const rows = [
    { id: 1, campaign_id: 'c1', platform: 'tiktok', instagram_url: 'https://www.tiktok.com/@t1', instagram_username: 't1', status: 'no_email' },
    { id: 2, campaign_id: 'c1', platform: 'youtube', instagram_url: 'https://www.youtube.com/@y1', instagram_username: 'y1', status: 'no_email', bio_links: ['https://www.tiktok.com/@y1tt'] },
    { id: 3, campaign_id: 'c1', platform: 'youtube', instagram_url: 'https://www.youtube.com/@y2', instagram_username: 'y2', status: 'no_email', bio_links: ['https://www.tiktok.com/@y2tt', 'https://instagram.com/y2ig'] },
  ];
  installDmStub(rows[0]);
  let selectParams = null;
  db.many = async (sql, params) => {
    selectParams = params;
    return rows;
  };
  try {
    const res = await call('POST', '/bulk/queue-ig-dm', { campaign_id: 'c1', dm_platform: 'tiktok' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(selectParams[2], ['tiktok', 'youtube']);
    // y2 links an Instagram too, so it belongs to the Instagram button.
    assert.deepStrictEqual(res.body.jobs.map((j) => [j.id, j.platform, j.via]), [[1, 'tiktok', null], [2, 'tiktok', 'youtube']]);
    assert.strictEqual(res.body.skipped, 0);
  } finally {
    restore();
  }
});

test('bulk DM queue rejects an unknown dm_platform', async () => {
  installDmStub({ id: 1, campaign_id: 'c1', platform: 'tiktok', status: 'no_email' });
  try {
    const res = await call('POST', '/bulk/queue-ig-dm', { campaign_id: 'c1', dm_platform: 'youtube' });
    assert.strictEqual(res.status, 400);
  } finally {
    restore();
  }
});
