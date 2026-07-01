'use strict';

// In-context learning bank for the negotiation reply model.
//
// We can't fine-tune the Claude models we use, so "training" here means
// feeding Claude a handful of labeled (creator_inbound → expected_JSON)
// pairs as user/assistant turns BEFORE the new inbound message. The model
// picks up the schema, the action taxonomy, and the team's tone from the
// demonstrations.
//
// Three data sources, merged at load time:
//   - data/seed_examples.json       — committed; small synthetic set so the
//                                     tests run anywhere and prod always has
//                                     at least a few examples to anchor on.
//   - data/harvested_examples.json  — git-ignored legacy file from the old
//                                     Gmail-based harvest; still read if
//                                     present so nothing already learned is
//                                     lost.
//   - reply_examples table          — the continuous-learning bank. Fed by
//                                     replyLearning.js: the scheduled
//                                     Instantly mailbox harvest ('harvest')
//                                     and live capture of human replies from
//                                     the Delegate window ('delegate').
//                                     Survives redeploys, unlike the file.
//
// Templated bodies: an outbound_body_template === "REPLY1" / "REPLY2" is
// expanded to the canonical template body at load time, so the demonstration
// matches the canonical copy the rest of the prompt is asking Claude to adapt.

const fs = require('fs');
const path = require('path');
const db = require('../db');
const templates = require('./negotiationTemplates');

const SEED_PATH = path.join(__dirname, '..', '..', 'data', 'seed_examples.json');
const HARVEST_PATH = path.join(__dirname, '..', '..', 'data', 'harvested_examples.json');

// Newest N DB examples kept in memory. Plenty for a Jaccard scan per reply;
// keeps an unbounded bank from bloating the process.
const MAX_DB_EXAMPLES = Number(process.env.LEARN_MAX_EXAMPLES || 500);

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

function normalize(ex, defaultSource = 'seed') {
  const body = expandBody(ex);
  return {
    id: ex.id || null,
    source: ex.source || defaultSource,
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

const isValid = (ex) => ex.inbound && ACTIONS.includes(ex.expected_action);

// ── DB source (reply_examples table) ───────────────────────────────────────
// Loaded into memory so pickExamplesFor stays synchronous (it runs inside the
// negotiation hot path). Refreshed on boot, by the scheduler, and after every
// insert. No DATABASE_URL (tests, file-only dev) → stays empty, silently.
let _dbCache = [];
let _dbLoadedAt = 0;

async function refreshFromDb() {
  if (!process.env.DATABASE_URL) return _dbCache;
  try {
    const rows = await db.many(
      `SELECT id, source, expected_action, expected_quoted_rate, stage, inbound,
              outbound_subject, outbound_body, notes
       FROM reply_examples
       WHERE enabled
       ORDER BY created_at DESC
       LIMIT $1`,
      [MAX_DB_EXAMPLES],
    );
    _dbCache = rows.map((r) => normalize(r, 'harvest')).filter(isValid);
    _dbLoadedAt = Date.now();
  } catch (err) {
    console.warn(`[replyExamples] refreshFromDb failed: ${err.message}`);
  }
  return _dbCache;
}

function dbCacheAgeMs() {
  return _dbLoadedAt ? Date.now() - _dbLoadedAt : Infinity;
}

// Persist one learned example and make it immediately pickable. Idempotent on
// id (re-learning the same pair is a no-op). Returns true when a new row was
// actually inserted.
async function insertExample(ex) {
  const norm = normalize(ex, ex.source || 'manual');
  if (!isValid(norm) || !norm.id) return false;
  if (!process.env.DATABASE_URL) return false;
  const row = await db.one(
    `INSERT INTO reply_examples
       (id, source, expected_action, expected_quoted_rate, stage, inbound,
        outbound_subject, outbound_body, notes, creator_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      norm.id,
      norm.source,
      norm.expected_action,
      norm.expected_quoted_rate,
      norm.stage,
      norm.inbound,
      norm.outbound_subject,
      norm.outbound_body,
      norm.notes,
      ex.creator_id || null,
    ],
  );
  if (row) {
    // Keep the in-memory bank hot without a full reload.
    _dbCache = [norm, ..._dbCache.filter((e) => e.id !== norm.id)].slice(0, MAX_DB_EXAMPLES);
  }
  return !!row;
}

let _cache = null;
function loadAll({ force = false } = {}) {
  if (!_cache || force) {
    _cache = [
      ...readJsonSafe(SEED_PATH).map((ex) => normalize(ex, 'seed')),
      ...readJsonSafe(HARVEST_PATH).map((ex) => normalize(ex, 'harvest')),
    ].filter(isValid);
  }
  if (!_dbCache.length) return _cache;
  // DB is the canonical store — on id collision (e.g. a legacy file later
  // imported into the table) the DB row wins.
  const dbIds = new Set(_dbCache.map((e) => e.id));
  return [..._cache.filter((e) => !dbIds.has(e.id)), ..._dbCache];
}

// Reset the in-memory caches. Used by tests that mutate the on-disk fixtures.
function _resetCache() {
  _cache = null;
  _dbCache = [];
  _dbLoadedAt = 0;
}

// Test-only: pretend these rows came from the reply_examples table.
function _setDbCache(rows) {
  _dbCache = (rows || []).map((r) => normalize(r, 'harvest')).filter(isValid);
  _dbLoadedAt = Date.now();
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
//   3. Lightly boost 'delegate' examples — a human wrote those replies, so
//      when a harvested (possibly AI-written) example and a human answer are
//      about equally relevant, the human one should win the slot. Also keeps
//      the bank from slowly reinforcing the model's own past outputs.
//   4. Greedy pick by score, but cap at maxPerAction per label.
//   5. Drop ties by id for deterministic ordering (tests stay stable).
function pickExamplesFor(inboundText, { k = 4, stage = null, maxPerAction = 2, pool = null } = {}) {
  const examples = pool || loadAll();
  if (!examples.length) return [];

  const scored = examples.map((ex) => {
    let score = similarity(inboundText, ex.inbound);
    if (stage && ex.stage === stage) score += 0.05;
    if (ex.source === 'delegate') score += 0.03;
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
  refreshFromDb,
  dbCacheAgeMs,
  insertExample,
  ACTIONS,
  SEED_PATH,
  HARVEST_PATH,
  _resetCache,
  _setDbCache,
};
