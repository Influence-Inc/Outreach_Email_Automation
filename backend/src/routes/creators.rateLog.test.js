'use strict';

// Timeline label composition for the Rate column. rateLogEntry is pure (no DB),
// exposed on the router the same way routes/webhook.js exposes its helpers.

const test = require('node:test');
const assert = require('node:assert');

const { rateLogEntry, collapseSupersededSteps } = require('./creators');

// ── replies summarize what was said, never a bare "Creator replied" ─────────

test('replied quotes a super-short gist of the creator message', () => {
  const entry = rateLogEntry('replied', null, "Hi Jennifer, this sounds great! When can we start?");
  assert.strictEqual(entry.text, 'Replied: “this sounds great!”');
  assert.strictEqual(entry.tone, 'done');
});

test('replied prefers the Claude summary over the deterministic gist', () => {
  const entry = rateLogEntry(
    'replied',
    null,
    'The price is listed in my media kit: $1,600 per video. Unfortunately, my schedule is fully booked for July.',
    '$1,600 per video, available early August, 50% upfront with approval before publishing',
  );
  assert.strictEqual(
    entry.text,
    'Replied: “$1,600 per video, available early August, 50% upfront with approval before publishing”',
  );
});

test('sent replies prefer the Claude summary too', () => {
  assert.strictEqual(
    rateLogEntry('sent_manual_reply', {}, 'Hey! We can do $3,000 for two reels.', 'offered $3,000 for two reels').text,
    'Sent: “offered $3,000 for two reels”',
  );
});

test('replied falls back to the plain label only when no message is on file', () => {
  assert.strictEqual(rateLogEntry('replied', null, null).text, 'Creator replied');
  assert.strictEqual(rateLogEntry('replied', null, '   ').text, 'Creator replied');
});

test('a sent delegate / manual reply quotes what we sent', () => {
  assert.strictEqual(
    rateLogEntry('sent_delegate_reply', {}, 'Hey! We can do $3,000 for two reels.').text,
    'Sent: “We can do $3,000 for two reels.”',
  );
  assert.strictEqual(
    rateLogEntry('sent_manual_reply', {}, null).text,
    'Manual reply sent',
  );
});

// ── our own auto-replies (sent_negotiation) surface as "Sent: …" ────────────

test('a conversational auto-reply quotes what we sent', () => {
  assert.strictEqual(
    rateLogEntry('sent_negotiation', { kind: 'reply_qa' }, 'Absolutely — the video can go live the first week of August.').text,
    'Sent: “Absolutely — the video can go live the first week of August.”',
  );
  assert.strictEqual(
    rateLogEntry('sent_negotiation', { kind: 'reply1' }, 'Hi Sam! Thanks for the media kit — could you share your rate?').text,
    'Sent: “Thanks for the media kit — could you share your rate?”',
  );
});

test('a conversational auto-reply prefers the Claude summary', () => {
  assert.strictEqual(
    rateLogEntry(
      'sent_negotiation',
      { kind: 'reply_qa' },
      'Great question — we cross-post to Instagram, TikTok and YouTube Shorts, and yes you keep full creative control.',
      'confirmed cross-posting to IG/TikTok/Shorts and full creative control',
    ).text,
    'Sent: “confirmed cross-posting to IG/TikTok/Shorts and full creative control”',
  );
});

test('a conversational auto-reply falls back to a plain label with no message on file', () => {
  assert.strictEqual(rateLogEntry('sent_negotiation', { kind: 'reply' }, null).text, 'Reply sent');
  assert.strictEqual(rateLogEntry('sent_negotiation', { kind: 'reply_qa' }, '   ').text, 'Reply sent');
});

test('a sent_negotiation with no kind is still treated as a conversational reply', () => {
  assert.strictEqual(
    rateLogEntry('sent_negotiation', {}, 'Sounds good, sending the agreement over now.').text,
    'Sent: “Sounds good, sending the agreement over now.”',
  );
});

test('milestone sends are skipped so they never double their dedicated step', () => {
  // offer → rate_offer_sent, contract → contract_sent, decline → rate_declined,
  // request_counter_rate → rate_counter_requested, delegate_reply →
  // sent_delegate_reply/rate_offer_sent. Each already logs its own richer event.
  for (const kind of ['offer', 'contract', 'decline', 'request_counter_rate', 'delegate_reply']) {
    assert.strictEqual(
      rateLogEntry('sent_negotiation', { kind }, 'body text here'),
      null,
      `${kind} should be suppressed`,
    );
  }
});

test('the idle negotiation nudges render as a plain "Follow-up sent" step', () => {
  assert.strictEqual(rateLogEntry('sent_negotiation', { kind: 'followup1' }, 'just checking in!').text, 'Follow-up sent');
  assert.strictEqual(rateLogEntry('sent_negotiation', { kind: 'followup2' }, 'still keen?').text, 'Follow-up sent');
  assert.strictEqual(rateLogEntry('sent_negotiation', { kind: 'followup1' }, null).tone, 'done');
});

// ── quoted rates spell out the deliverable ──────────────────────────────────

test('a single quoted rate names the deliverable it covers', () => {
  const msg = 'Thanks for reaching out! My rate is $3,500 for 300,000 combined views.';
  const entry = rateLogEntry('rate_quoted', { to: 3500, by: 'creator', options: null }, msg);
  assert.strictEqual(entry.text, 'Creator quoted $3,500 for 300,000 combined views');
});

test('a single quoted rate degrades to just the amount when no deliverable is stated', () => {
  const entry = rateLogEntry('rate_quoted', { to: 3500, by: 'creator', options: null }, 'My rate is $3,500.');
  assert.strictEqual(entry.text, 'Creator quoted $3,500');
});

test('multiple quoted rates stay collapsed with their per-option deliverables', () => {
  const detail = {
    to: 3500,
    by: 'creator',
    options: [
      { amount: 3500, label: '$3,500 for 300,000 combined views' },
      { amount: 5000, label: '$5,000 for 600,000 combined views' },
    ],
  };
  const entry = rateLogEntry('rate_quoted', detail, null);
  assert.strictEqual(entry.text, 'Creator quoted rates');
  assert.strictEqual(entry.options.length, 2);
  assert.strictEqual(entry.options[1].label, '$5,000 for 600,000 combined views');
});

// ── offer-sent step surfaces the views the CPM was priced against ──────────

test('rate_offer_sent shows the view base alongside fee and CPM', () => {
  const entry = rateLogEntry('rate_offer_sent', { fee: 4200, cpm: 6 });
  assert.strictEqual(entry.text, 'Offer sent — $4,200 · 700K views x $6 CPM');
  assert.strictEqual(entry.tone, 'active');
});

test('rate_offer_sent prefers a stored views value over the fee/CPM derivation', () => {
  const entry = rateLogEntry('rate_offer_sent', { fee: 3000, cpm: 10, views: 250000 });
  assert.strictEqual(entry.text, 'Offer sent — $3,000 · 250K views x $10 CPM');
});

test('rate_offer_sent falls back to the plain CPM tag when views cannot be derived', () => {
  assert.strictEqual(
    rateLogEntry('rate_offer_sent', { fee: 1500, cpm: 0 }).text,
    'Offer sent — $1,500 · CPM $0',
  );
});

test('rate_offer_sent from the delegate reply keeps the source tag', () => {
  const entry = rateLogEntry('rate_offer_sent', { fee: 4200, cpm: 6, source: 'delegate' });
  assert.strictEqual(entry.text, 'Offer sent — $4,200 · 700K views x $6 CPM (from delegate)');
});

test('rate_offer_sent with no fee or CPM degrades to the bare label', () => {
  assert.strictEqual(rateLogEntry('rate_offer_sent', {}).text, 'Offer sent');
});

test('rate_offer_sent on a per-video offer splits the total views across videos', () => {
  // A 3-video deal priced at $6 CPM against a 900K total view guarantee reads
  // as "3 videos x 300K views x $6 CPM", not "900K views x $6 CPM" — the
  // per-video framing is what the deal was actually priced on.
  const entry = rateLogEntry('rate_offer_sent', { fee: 5400, cpm: 6, videos: 3, views: 900000 });
  assert.strictEqual(entry.text, 'Offer sent — $5,400 · 3 videos x 300K views x $6 CPM');
});

test('rate_offer_sent on a single-video offer keeps the "1 video" singular', () => {
  const entry = rateLogEntry('rate_offer_sent', { fee: 1500, cpm: 15, videos: 1, views: 100000 });
  assert.strictEqual(entry.text, 'Offer sent — $1,500 · 1 video x 100K views x $15 CPM');
});

test('rate_offer_sent on a per-video + bonus offer appends the bonus unlock', () => {
  const entry = rateLogEntry('rate_offer_sent', {
    fee: 4000,
    cpm: 8,
    videos: 2,
    views: 400000,
    bonus_amount: 800,
    bonus_threshold_views: 600000,
  });
  assert.strictEqual(
    entry.text,
    'Offer sent — $4,000 · 2 videos x 200K views x $8 CPM · +$800 bonus at 600K views',
  );
});

test('rate_offer_sent omits the "at N views" clause when the unlock threshold is missing', () => {
  const entry = rateLogEntry('rate_offer_sent', {
    fee: 4000,
    cpm: 8,
    videos: 2,
    views: 400000,
    bonus_amount: 800,
  });
  assert.strictEqual(entry.text, 'Offer sent — $4,000 · 2 videos x 200K views x $8 CPM · +$800 bonus');
});

// ── "Outreach queued" collapses into "Outreach sent" once the send lands ─────

test('the queued step is dropped once outreach has been sent', () => {
  const log = [
    { type: 'outreach_queued', text: 'Outreach queued' },
    { type: 'sent_outreach', text: 'Outreach sent' },
  ];
  const collapsed = collapseSupersededSteps(log);
  assert.deepStrictEqual(collapsed.map((e) => e.type), ['sent_outreach']);
});

test('the queued step stays while outreach is still pending', () => {
  const log = [{ type: 'outreach_queued', text: 'Outreach queued' }];
  const collapsed = collapseSupersededSteps(log);
  assert.deepStrictEqual(collapsed.map((e) => e.type), ['outreach_queued']);
});

test('collapsing keeps every later step and returns a fresh array', () => {
  const log = [
    { type: 'outreach_queued', text: 'Outreach queued' },
    { type: 'sent_outreach', text: 'Outreach sent' },
    { type: 'sent_followup', text: 'Follow-up sent' },
    { type: 'replied', text: 'Replied: “sounds great”' },
  ];
  const collapsed = collapseSupersededSteps(log);
  assert.deepStrictEqual(collapsed.map((e) => e.type), ['sent_outreach', 'sent_followup', 'replied']);
  assert.notStrictEqual(collapsed, log);
});

// ── Instagram DM timeline entries ───────────────────────────────────────────

test('ig_dm_queued renders an active "Instagram DM queued" step', () => {
  const entry = rateLogEntry('ig_dm_queued', {});
  assert.strictEqual(entry.text, 'Instagram DM queued');
  assert.strictEqual(entry.tone, 'active');
});

test('ig_dm_sent labels the priority send explicitly', () => {
  const entry = rateLogEntry('ig_dm_sent', {});
  assert.strictEqual(entry.text, 'Instagram DM sent (priority)');
  assert.strictEqual(entry.tone, 'done');
});

test('ig_dm_failed surfaces the extension error when known', () => {
  const entry = rateLogEntry('ig_dm_failed', { error: 'Message button not found' });
  assert.strictEqual(entry.text, 'Instagram DM failed — Message button not found');
  assert.strictEqual(entry.tone, 'muted');
});

test('ig_dm_failed falls back to a plain label with no detail', () => {
  const entry = rateLogEntry('ig_dm_failed', null);
  assert.strictEqual(entry.text, 'Instagram DM failed');
});

test('the ig_dm_queued step is dropped once the DM has been sent', () => {
  const log = [
    { type: 'ig_dm_queued', text: 'Instagram DM queued' },
    { type: 'ig_dm_sent', text: 'Instagram DM sent (priority)' },
  ];
  const collapsed = collapseSupersededSteps(log);
  assert.deepStrictEqual(collapsed.map((e) => e.type), ['ig_dm_sent']);
});

test('the ig_dm_queued step stays while the extension is still driving', () => {
  const log = [{ type: 'ig_dm_queued', text: 'Instagram DM queued' }];
  const collapsed = collapseSupersededSteps(log);
  assert.deepStrictEqual(collapsed.map((e) => e.type), ['ig_dm_queued']);
});
