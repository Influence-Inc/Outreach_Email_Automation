'use strict';

// In-context learning bank for the negotiation reply model.
//
// We can't fine-tune the Claude models we use, so "training" here means
// feeding Claude a handful of labeled (creator_inbound → expected_JSON)
// pairs as user/assistant turns BEFORE the new inbound message. The model
// picks up the schema, the action taxonomy, and the team's tone from the
// demonstrations.
//
// Two data sources, merged at load time:
//   - data/seed_examples.json       — committed; small synthetic set so the
//                                     tests run anywhere and prod always has
//                                     at least a few examples to anchor on.
//   - data/harvested_examples.json  — git-ignored; populated by
//                                     scripts/harvest-inbox.js from real
//                                     threads in the connected mailbox.
//
// Templated bodies: an outbound_body_template === "REPLY1" / "REPLY2" is
// expanded to the canonical template body at load time, so the demonstration
// matches the canonical copy the rest of the prompt is asking Claude to adapt.

const fs = require('fs');
const path = require('path');
const templates = require('./negotiationTemplates');

const SEED_PATH = path.join(__dirname, '..', '..', 'data', 'seed_examples.json');
const HARVEST_PATH = path.join(__dirname, '..', '..', 'data', 'harvested_examples.json');

const ACTIONS = [
  'shared_rate',
  'asking_details',
  'answer_question',
  'request_counter_rate',
  'accepted',
  'declined',
  'counter',
  'escalate',
  'other',
];

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[replyExamples] could not read ${file}: ${err.message}`);
    return [];
  }
}

function expandBody(ex) {
  if (ex.outbound_body) return ex.outbound_body;
  if (ex.outbound_body_template === 'REPLY1') return templates.REPLY1_BODY;
  if (ex.outbound_body_template === 'REPLY2') return templates.REPLY2_BODY;
  return null;
}

function normalize(ex) {
  const body = expandBody(ex);
  return {
    id: ex.id || null,
    expected_action: ex.expected_action || 'other',
    expected_quoted_rate:
      ex.expected_quoted_rate == null ? null : Number(ex.expected_quoted_rate),
    stage: ex.stage || null,
    inbound: String(ex.inbound || '').trim(),
    outbound_subject: ex.outbound_subject || null,
    outbound_body: body,
    notes: ex.notes || '',
  };
}

let _cache = null;
function loadAll({ force = false } = {}) {
  if (_cache && !force) return _cache;
  const merged = [...readJsonSafe(SEED_PATH), ...readJsonSafe(HARVEST_PATH)]
    .map(normalize)
    .filter((ex) => ex.inbound && ACTIONS.includes(ex.expected_action));
  _cache = merged;
  return merged;
}

// Reset the in-memory cache. Used by tests that mutate the on-disk fixtures.
function _resetCache() {
  _cache = null;
}

// Cheap relevance score: Jaccard overlap of lowercased word tokens (≥3 chars).
// Plenty for picking 4–6 examples out of dozens; no embeddings dependency.
const TOK_RE = /[a-z0-9$]+/g;
function tokens(s) {
  const arr = String(s || '').toLowerCase().match(TOK_RE) || [];
  return new Set(arr.filter((t) => t.length >= 3));
}
function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// Build the JSON the assistant turn should emit for a given example. This is
// what the model sees as the "correct" output shape — keep it in sync with the
// JSON schema declared in handleCreatorReply.
function exampleToAssistantJson(ex) {
  const sendsEmail = !!(
    ex.outbound_body &&
    ['asking_details', 'answer_question', 'request_counter_rate', 'accepted', 'declined'].includes(
      ex.expected_action,
    )
  );
  return JSON.stringify({
    understanding: ex.notes || '',
    action: ex.expected_action,
    quoted_rate: ex.expected_quoted_rate,
    email: sendsEmail
      ? { subject: ex.outbound_subject || 'Re: collaboration', body: ex.outbound_body }
      : null,
    send_now: sendsEmail,
  });
}

// Pick K examples for the given inbound. Returns them ordered most-relevant
// first, but capped so we don't show K copies of the same action — that biases
// the model toward whichever label dominated the pick.
//
// Strategy:
//   1. Score every example by similarity to the inbound.
//   2. If stage is known, lightly boost examples that match it.
//   3. Greedy pick by score, but cap at maxPerAction per label.
//   4. Drop ties by id for deterministic ordering (tests stay stable).
function pickExamplesFor(inboundText, { k = 4, stage = null, maxPerAction = 2, pool = null } = {}) {
  const examples = pool || loadAll();
  if (!examples.length) return [];

  const scored = examples.map((ex) => {
    let score = similarity(inboundText, ex.inbound);
    if (stage && ex.stage === stage) score += 0.05;
    return { ex, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.ex.id || '').localeCompare(String(b.ex.id || ''));
  });

  const picked = [];
  const perAction = new Map();
  for (const { ex, score } of scored) {
    if (picked.length >= k) break;
    if (score <= 0 && picked.length >= Math.min(k, ACTIONS.length)) break;
    const n = perAction.get(ex.expected_action) || 0;
    if (n >= maxPerAction) continue;
    picked.push(ex);
    perAction.set(ex.expected_action, n + 1);
  }
  return picked;
}

// Format examples as Anthropic-style turn pairs to be placed BEFORE the real
// user message. Each example consumes two turns: a user turn with the
// creator's inbound text, an assistant turn with the JSON we'd want Claude to
// emit. The closing turn (the real inbound) is added by the caller.
function examplesAsMessages(examples) {
  const out = [];
  for (const ex of examples) {
    out.push({ role: 'user', content: ex.inbound });
    out.push({ role: 'assistant', content: exampleToAssistantJson(ex) });
  }
  return out;
}

module.exports = {
  loadAll,
  pickExamplesFor,
  examplesAsMessages,
  exampleToAssistantJson,
  similarity,
  ACTIONS,
  SEED_PATH,
  HARVEST_PATH,
  _resetCache,
};
