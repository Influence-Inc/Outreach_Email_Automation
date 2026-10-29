'use strict';

const test = require('node:test');
const assert = require('node:assert');
const monid = require('./monid');

// A 402 pauses calls for a few minutes (walletState); no test may inherit that.
test.afterEach(() => monid._resetWallet());

const json = (status, body) => ({ status, json: async () => body });
const noWait = async () => {};

test('a synchronous run returns its output and cost', async () => {
  let sent = null;
  const out = await monid.run(monid.REELS, { username: 'mia' }, {
    apiKey: 'k',
    wait: noWait,
    fetchImpl: async (url, init) => { sent = [url, JSON.parse(init.body)]; return json(200, { status: 'COMPLETED', output: { data: { items: [] } }, billing: { actualCost: 0.002 } }); },
  });
  assert.deepStrictEqual(sent, ['https://api.monid.ai/v1/run', { provider: 'tikhub', endpoint: monid.REELS, input: { queryParams: { username: 'mia' } } }]);
  assert.deepStrictEqual(out, { output: { data: { items: [] } }, costUsd: 0.002 });
});

test('a queued run is polled until it completes', async () => {
  const calls = [];
  const replies = [json(202, { runId: 'r1', status: 'QUEUED' }), json(200, { runId: 'r1', status: 'RUNNING' }), json(200, { status: 'COMPLETED', output: { ok: 1 } })];
  const out = await monid.run(monid.CARD, { username: 'mia' }, {
    apiKey: 'k', wait: noWait, fetchImpl: async (url) => { calls.push(url); return replies.shift(); },
  });
  assert.deepStrictEqual(out.output, { ok: 1 });
  assert.strictEqual(out.costUsd, 0.002, 'the listed price when no billing came back');
  assert.deepStrictEqual(calls.slice(1), ['https://api.monid.ai/v1/runs/r1', 'https://api.monid.ai/v1/runs/r1']);
});

test('an empty wallet and a provider error are reported', async () => {
  await assert.rejects(monid.run(monid.REELS, {}, { apiKey: 'k', wait: noWait, fetchImpl: async () => json(402, {}) }), /wallet is empty/);
  monid._resetWallet(); // the 402 paused calls; the next case is a separate wallet
  await assert.rejects(
    monid.run(monid.REELS, {}, { apiKey: 'k', wait: noWait, fetchImpl: async () => json(200, { status: 'COMPLETED', providerResponse: { httpStatus: 404 } }) }),
    /provider HTTP 404/,
  );
  await assert.rejects(monid.run(monid.REELS, {}, { apiKey: '' }), /MONID_API_KEY is not set/);
});

test('the creator\'s pinned Reels and trial Reels are left out, a co-author\'s pin is kept', async () => {
  const item = (code, extra = {}) => ({ code, user: { id: '7' }, caption: { text: `reel ${code} #gym`, hashtags: ['#gym'] }, video_url: `https://scontent.cdninstagram.com/${code}.mp4`, video_duration: 20, ...extra });
  const output = {
    data: {
      items: [
        item('a', { is_pinned: true, clips_tab_pinned_user_ids: ['7'] }),
        item('b', { is_pinned: true, clips_tab_pinned_user_ids: ['99'] }),
        item('c', { clips_trial: {} }),
        item('d', { clips_metadata: { audio_type: 'original_sounds' }, image_versions2: { candidates: [{ url: 'big', width: 1080 }, { url: 'small', width: 360 }] } }),
      ],
    },
  };
  const { reels } = await monid.fetchReels('mia', {
    apiKey: 'k', wait: noWait, fetchImpl: async () => json(200, { status: 'COMPLETED', output }),
  });
  assert.deepStrictEqual(reels.map((r) => r.code), ['b', 'd']);
  assert.strictEqual(reels[1].originalAudio, true);
  assert.strictEqual(reels[1].thumbUrl, 'small');
  assert.deepStrictEqual(reels[0].hashtags, ['gym']);
});

test('the card gives the country, and a hidden one is unknown', async () => {
  const card = (country) => json(200, { status: 'COMPLETED', output: { data: { username: 'mia', id: '7', biography: 'hi', follower_count: 5000, about: { country } } } });
  const shown = await monid.fetchCard('mia', { apiKey: 'k', wait: noWait, fetchImpl: async () => card('United States') });
  assert.deepStrictEqual({ ...shown, costUsd: undefined }, { userId: '7', bio: 'hi', followers: 5000, country: 'United States', costUsd: undefined });
  const hidden = await monid.fetchCard('mia', { apiKey: 'k', wait: noWait, fetchImpl: async () => card('Not shared') });
  assert.strictEqual(hidden.country, null);
});

// ── an empty wallet ─────────────────────────────────────────────────────────

test('after an empty-wallet refusal, calls pause instead of being refused one by one', async () => {
  monid._resetWallet();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 402, json: async () => ({}) }; };
  await assert.rejects(monid.run(monid.REELS, { username: 'a' }, { fetchImpl, apiKey: 'k', retries: 0 }), /wallet is empty/);
  assert.strictEqual(monid.walletState().empty, true);
  await assert.rejects(monid.run(monid.REELS, { username: 'b' }, { fetchImpl, apiKey: 'k', retries: 0 }), /wallet is empty/);
  assert.strictEqual(calls, 1, 'the second creator did not call Monid');
  // A while later it tries again, so a top-up is picked up on its own.
  assert.strictEqual(monid.walletState(Date.now() + monid.EMPTY_PAUSE_MS + 1).empty, false);
  monid._resetWallet();
});
