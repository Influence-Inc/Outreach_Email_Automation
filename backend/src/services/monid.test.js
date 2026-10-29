'use strict';

const test = require('node:test');
const assert = require('node:assert');
const monid = require('./monid');

// A 402 pauses calls for a few minutes (walletState); no test may inherit that.
test.afterEach(() => { monid._resetWallet(); monid._resetLedger(); delete process.env.MONID_USD_PER_DAY; });

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
    /TikHub could not fetch it from Instagram \(HTTP 404\)/,
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

// ── Deal Studio's own daily budget ──────────────────────────────────────────

const completed = (cost) => async () => json(200, { status: 'COMPLETED', output: { data: { username: 'a' } }, cost: { value: cost } });

test('each call is counted against today, and the daily cap refuses the next one before it is made', async () => {
  process.env.MONID_USD_PER_DAY = '0.004';
  let calls = 0;
  const fetchImpl = async (...a) => { calls += 1; return completed(0.002)(...a); };
  await monid.run(monid.CARD, { username: 'a' }, { apiKey: 'k', wait: noWait, fetchImpl });
  await monid.run(monid.REELS, { username: 'a' }, { apiKey: 'k', wait: noWait, fetchImpl });
  assert.deepStrictEqual({ ...monid.spentToday(), date: undefined }, { date: undefined, usd: 0.004, calls: 2, cap: 0.004, capped: true });
  await assert.rejects(monid.run(monid.CARD, { username: 'b' }, { apiKey: 'k', wait: noWait, fetchImpl }), /daily Monid budget is spent \(\$0\.00 of MONID_USD_PER_DAY \$0\.00\)|daily Monid budget is spent/);
  assert.strictEqual(calls, 2, 'the third call never reached Monid');
});

test('the cap defaults to $1 a day, and "none" lifts it', () => {
  assert.strictEqual(monid.dailyCap({}), 1);
  assert.strictEqual(monid.dailyCap({ MONID_USD_PER_DAY: '2.5' }), 2.5);
  assert.strictEqual(monid.dailyCap({ MONID_USD_PER_DAY: 'none' }), Infinity);
  assert.strictEqual(monid.dailyCap({ MONID_USD_PER_DAY: 'abc' }), 1);
});

test('a refused or failed call costs nothing and is not counted', async () => {
  await assert.rejects(monid.run(monid.REELS, {}, { apiKey: 'k', wait: noWait, fetchImpl: async () => json(200, { status: 'COMPLETED', providerResponse: { httpStatus: 400 } }) }));
  assert.strictEqual(monid.spentToday().calls, 0);
});

// ── TikHub's "Request failed. Please retry" ─────────────────────────────────

const tikhub400 = () => json(200, {
  status: 'COMPLETED',
  providerResponse: { httpStatus: 400, error: { detail: { message: 'Request failed. Please retry. Check the docs below' } } },
  cost: { value: 0 },
});

test('a TikHub "please retry" 400 is retried, free, and the next try is used', async () => {
  const answers = [tikhub400(), json(200, { status: 'COMPLETED', output: { data: { username: 'klairs.us' } }, cost: { value: 0.002 } })];
  let calls = 0;
  const waits = [];
  const out = await monid.run(monid.CARD, { username: 'klairs.us' }, {
    apiKey: 'k', wait: async (ms) => { waits.push(ms); }, fetchImpl: async () => { calls += 1; return answers.shift(); },
  });
  assert.strictEqual(out.output.data.username, 'klairs.us');
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(waits, [3000]);
  assert.strictEqual(monid.spentToday().usd, 0.002, 'only the call that worked is counted');
});

test('three failed tries say it was TikHub, and that failures are not charged', async () => {
  let calls = 0;
  await assert.rejects(
    monid.run(monid.REELS, { username: 'x' }, { apiKey: 'k', wait: noWait, fetchImpl: async () => { calls += 1; return tikhub400(); } }),
    /TikHub could not fetch it from Instagram \(HTTP 400: "Request failed"\) after 3 tries — TikHub's side; failed calls are not charged/,
  );
  assert.strictEqual(calls, 3);
});
