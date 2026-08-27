'use strict';

// Video draft / content-review hand-off (negotiation.sharesVideoDraftForReview
// + its use in processReply / handleAcceptedReply).
//
// Team policy: whenever a creator (or their manager) shares a video draft for
// review, asks us for feedback, or asks us to check the content, we ALWAYS flag
// the thread for manual review and never auto-reply. The detection is a
// deterministic guard (like askedForReferences) that runs before Claude is ever
// called, so the hand-off holds at any stage regardless of what the classifier
// would have done.
//
// The DB layer is a thin singleton (src/db); we stub db.one/db.query/db.many to
// observe the writes, and inject a fake Claude client via _setClient so a match
// can be proven to short-circuit BEFORE any classification.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const negotiation = require('./negotiation');

const { sharesVideoDraftForReview } = negotiation;

// ── 1. The detector itself ──────────────────────────────────────────────────

test('sharesVideoDraftForReview: empty / blank text never matches', () => {
  assert.strictEqual(sharesVideoDraftForReview(''), false);
  assert.strictEqual(sharesVideoDraftForReview(null), false);
  assert.strictEqual(sharesVideoDraftForReview(undefined), false);
  assert.strictEqual(sharesVideoDraftForReview('   '), false);
});

test('sharesVideoDraftForReview: draft / cut / edit of the content is detected', () => {
  const yes = [
    "Hi Jennifer, sharing the video draft for your review — let me know your thoughts!",
    "Here's the first cut of the reel, happy to make changes.",
    "Attached is the rough cut for feedback.",
    "The final edit of the video is ready for your review.",
    "I've put together a draft of the reel — can you take a look?",
    "Sending over the reel cut, does this look good?",
    "My manager here — sharing Vo's video draft, please review before we post.",
    "Can you review the video before it goes live?",
    "Would love your feedback on the reel.",
    "Please check the content and let me know if any changes are needed.",
    "Draft is ready for your approval.",
    "Here's the reel! Let me know what you think.",
    "Attaching the clip — any notes?",
    "What do you think of the video? Open to edits.",
    "Approving the reel is up to you — take a look and sign off when ready.",
  ];
  for (const t of yes) {
    assert.strictEqual(sharesVideoDraftForReview(t), true, `should flag: "${t}"`);
  }
});

test('sharesVideoDraftForReview: ordinary negotiation replies are NOT flagged', () => {
  const no = [
    'Sounds great, what did you have in mind?',
    'My rate is $2,500 per reel.',
    'Can you review the offer and get back to me?',
    "I'll review the contract and sign it today.",
    'Can you send over some examples of your past work?',
    'Yes, let’s do it — what are the next steps?',
    'Who covers the bank transfer fees on payment?',
    'Is this Instagram only, or TikTok too?',
    'Thanks for the details, let me think it over.',
    'Got it, thanks!',
  ];
  for (const t of no) {
    assert.strictEqual(sharesVideoDraftForReview(t), false, `should NOT flag: "${t}"`);
  }
});

// ── 2. processReply short-circuits to the Delegate window ────────────────────

const origOne = db.one;
const origQuery = db.query;
const origMany = db.many;

// If Claude were consulted the test would fail on a thrown error, proving the
// guard runs first: the fake client throws when its create() is called.
function throwingClient() {
  return {
    messages: {
      create: async () => {
        throw new Error('Claude should not be called for a video-draft-review reply');
      },
    },
  };
}

function install(creator) {
  const writes = [];
  db.one = async (sql) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [] };
  };
  db.many = async () => [];
  return writes;
}

function restore() {
  db.one = origOne;
  db.query = origQuery;
  db.many = origMany;
  negotiation._setClient(null);
}

const has = (writes, re) => writes.some((w) => re.test(w.sql));
const delegated = (writes) => has(writes, /needs_human\s*=\s*TRUE/i);
const answered = (writes) => has(writes, /'sent_negotiation'/i);
const consumed = (writes) => has(writes, /latest_inbound_text\s*=\s*NULL/i);

const baseCreator = {
  id: 7,
  first_name: 'Vo',
  brand_name: 'Reve',
  campaign_name: 'Spring',
  usage_rights_policy: 'no_rights',
  instantly_reply_uuid: 'uuid-1',
  instantly_email_account: 'jennifer@useinfluence.xyz',
  instantly_reply_subject: 'Paid Partnership with Reve',
  ig_scraped_data: { median: 51000 },
  max_cpm: 3,
};

test('processReply delegates a video-draft-review reply without calling Claude', async () => {
  const writes = install({
    ...baseCreator,
    negotiation_status: 'AWAITING_DECISION',
    latest_inbound_text: "Sharing the video draft for your review — let me know your thoughts!",
  });
  negotiation._setClient(throwingClient());
  try {
    const res = await negotiation.processReply(7);
    assert.strictEqual(res.action, 'delegated');
    assert.strictEqual(res.reason, 'video_draft_review');
    assert.ok(delegated(writes), 'creator is flagged needs_human');
    assert.ok(!answered(writes), 'no auto-reply is sent');
    assert.ok(consumed(writes), 'the inbound text is consumed exactly once');
  } finally {
    restore();
  }
});

test('processReply flags a feedback ask even on the very first reply (status NULL)', async () => {
  const writes = install({
    ...baseCreator,
    negotiation_status: null,
    latest_inbound_text: 'Here is the first cut of the reel — any feedback before I post?',
  });
  negotiation._setClient(throwingClient());
  try {
    const res = await negotiation.processReply(7);
    assert.strictEqual(res.reason, 'video_draft_review');
    assert.ok(delegated(writes), 'creator is flagged needs_human');
    assert.ok(consumed(writes), 'the inbound text is consumed');
  } finally {
    restore();
  }
});

// ── 3. handleAcceptedReply routes drafts to a human too ──────────────────────

test('handleAcceptedReply delegates a post-acceptance video draft for manual review', async () => {
  const writes = install({
    ...baseCreator,
    id: 42,
    negotiation_status: 'ACCEPTED',
    latest_inbound_text: "The reel is ready for your review — happy to tweak anything.",
  });
  negotiation._setClient(throwingClient());
  try {
    const res = await negotiation.handleAcceptedReply(42);
    assert.strictEqual(res.action, 'delegated');
    assert.strictEqual(res.reason, 'video_draft_review');
    assert.ok(delegated(writes), 'creator is flagged needs_human');
    assert.ok(!answered(writes), 'no auto-reply is sent');
    assert.ok(consumed(writes), 'the inbound text is consumed');
  } finally {
    restore();
  }
});
