'use strict';

// Continuous learning for the negotiation model.
//
// The model can't be fine-tuned, so "learning" = collecting labeled
// (creator inbound → manager reply) pairs into the reply_examples table and
// letting replyExamples.pickExamplesFor() replay the most relevant ones as
// few-shot demonstrations in every Claude prompt. This module owns the two
// feeds that keep that bank growing on its own:
//
//   1. learnFromHumanReply() — called the moment an admin sends a reply from
//      the Delegate window. Human answers to questions Claude escalated are
//      the highest-value examples: the next creator who asks the same thing
//      gets answered by the model instead of landing in the Delegate queue.
//
//   2. harvestInbox() — sweeps the connected mailbox (jennifer@useinfluence.xyz)
//      through the Instantly API, reconstructs every thread's
//      (inbound → next manager reply) pairs, labels each with Claude, and
//      stores the keepers. maybeRunScheduledHarvest() runs it on a cadence
//      from the scheduler, so ongoing negotiations are re-learned continuously
//      — including replies humans sent outside this app.
//
// Both feeds label pairs with the same action taxonomy the live prompt uses,
// and both drop replies that contain priced offers — offer numbers only ever
// come from the admin-approval flow, never from learned examples.
//
// Everything here is best-effort: no ANTHROPIC_API_KEY / DB / Instantly key
// means the feed silently no-ops. Learning must never break sending.

const crypto = require('crypto');
const db = require('../db');
const instantly = require('./instantly');
const replyExamples = require('./replyExamples');
const { getSetting, setSetting } = require('./settings');

const HARVEST_LAST_RUN_KEY = 'learn_last_harvest_at';
const SLEEP_MS_BETWEEN_LABELS = 250;
// Cap stored texts so one giant email can't bloat every future prompt.
const MAX_FIELD_CHARS = 4000;

// ── Claude client (lazy; optional) — same pattern as negotiation.js ────────
let _client;
let _clientTried = false;
function getClient() {
  if (_clientTried) return _client;
  _clientTried = true;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    _client = null;
    return null;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey });
  } catch (err) {
    console.warn('[replyLearning] @anthropic-ai/sdk unavailable, learning disabled:', err.message);
    _client = null;
  }
  return _client;
}

// Test-only: inject a fake client (anything exposing .messages.create).
// Passing null restores lazy initialization.
function _setClient(client) {
  _client = client;
  _clientTried = client !== undefined;
}

const model = () => process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// ── Persistence seam (test-injectable) ──────────────────────────────────────
const defaultStore = {
  insert: (ex) => replyExamples.insertExample(ex),
  // Which of these example ids already exist? Lets incremental harvests skip
  // the Claude labeling call for pairs learned on a previous sweep.
  existingIds: async (ids) => {
    if (!process.env.DATABASE_URL || !ids.length) return new Set();
    try {
      const rows = await db.many(`SELECT id FROM reply_examples WHERE id = ANY($1)`, [ids]);
      return new Set(rows.map((r) => r.id));
    } catch (err) {
      console.warn('[replyLearning] existingIds failed:', err.message);
      return new Set();
    }
  },
  // Timeline breadcrumb so the dashboard thread view shows what was learned.
  logEvent: async (creatorId, detail) => {
    if (!process.env.DATABASE_URL || !creatorId) return;
    try {
      await db.query(`INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'learned_example', $2)`, [
        creatorId,
        detail,
      ]);
    } catch (err) {
      console.warn('[replyLearning] logEvent failed:', err.message);
    }
  },
};
let store = defaultStore;
function _setStore(s) {
  store = s || defaultStore;
}

// ── Labeling (one Claude call per pair, strict JSON) ────────────────────────
const LABEL_SYSTEM = `You are labeling reply pairs for the INFLUENCE outreach team's negotiation model.

Given (a) a creator's inbound message and (b) the manager's actual reply, classify what the inbound was asking for, using one of these labels:
- "shared_rate": creator stated a specific rate/budget. quoted_rate = the USD amount (plain number, no symbols).
- "asking_details": creator is interested but has not seen the standard collab pitch yet.
- "answer_question": creator asked a factual question about an already-discussed deal (platform, format, payment timing, exclusivity, timeline).
- "request_counter_rate": creator pushed back on the offer without naming a new number.
- "counter": creator pushed back on the offer with a specific number. quoted_rate = the USD amount.
- "accepted": creator accepted the offer.
- "declined": creator is genuinely not interested.
- "escalate": anything that requires a human (usage rights, legal/IP, custom terms, special timeline, atypical format).
- "other": trivial acknowledgement that needed no action.

If the manager's reply contains an offer with specific dollar amounts (e.g. "$1,500 for 2 videos" or "view-based offer of $X for Y views"), set "skip": true — those replies are produced by the admin-approval flow, not by the model.
Also set "skip": true when the pair is not a real creator↔manager exchange (automated notifications, out-of-office bounces, internal mail).

Respond with STRICT JSON ONLY:
{"action": "...", "quoted_rate": number|null, "stage": "AWAITING_RATE"|"AWAITING_DECISION"|"AWAITING_APPROVAL"|null, "skip": boolean, "notes": "..."}`;

function parseJsonLoose(s) {
  const cleaned = String(s || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

// Label one (inbound → manager reply) pair. Returns the parsed label object
// or null (no client / call failed / unparseable).
async function labelPair({ inbound, outbound, inboundFrom = 'creator', outboundDate = '' }) {
  const client = getClient();
  if (!client) return null;
  const user = `INBOUND (from ${inboundFrom}):\n${inbound}\n\n---\nMANAGER REPLY (${outboundDate}):\n${outbound}`;
  try {
    const resp = await client.messages.create({
      model: model(),
      max_tokens: 400,
      system: LABEL_SYSTEM,
      messages: [{ role: 'user', content: user }],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return parseJsonLoose(text);
  } catch (err) {
    console.warn('[replyLearning] label call failed:', err.message);
    return null;
  }
}

const clip = (s) => String(s || '').trim().slice(0, MAX_FIELD_CHARS);

// ── Feed 1: learn from a human Delegate-window reply ────────────────────────
// Fire-and-forget from negotiation.sendDelegateReply(). Labels the
// (creator question → admin answer) pair and stores it as a 'delegate'
// example. Never throws; returns what happened for logs/tests.
async function learnFromHumanReply({ creator, inbound, outbound, stage = null }) {
  try {
    if (/^(0|false|no)$/i.test(String(process.env.LEARN_FROM_DELEGATE || ''))) {
      return { skipped: 'disabled' };
    }
    const inboundText = clip(inbound);
    const body = clip(outbound && outbound.body);
    if (!inboundText || !body) return { skipped: 'missing text' };

    const label = await labelPair({
      inbound: inboundText,
      outbound: body,
      inboundFrom: (creator && creator.email) || 'creator',
      outboundDate: new Date().toUTCString(),
    });
    if (!label || !label.action) return { skipped: 'label failed' };
    if (label.skip) return { skipped: 'offer or non-exchange' };
    if (!replyExamples.ACTIONS.includes(label.action)) return { skipped: `unknown action ${label.action}` };

    const hash = crypto.createHash('sha1').update(`${inboundText}\n${body}`).digest('hex').slice(0, 12);
    const example = {
      id: `delegate_${(creator && creator.id) || 'x'}_${hash}`,
      source: 'delegate',
      expected_action: label.action,
      expected_quoted_rate: label.quoted_rate == null ? null : Number(label.quoted_rate),
      stage: stage || label.stage || null,
      inbound: inboundText,
      outbound_subject: (outbound && outbound.subject) || null,
      outbound_body: body,
      notes: label.notes || 'Human reply from the Delegate window.',
      creator_id: (creator && creator.id) || null,
    };
    const inserted = await store.insert(example);
    if (inserted) {
      await store.logEvent(creator && creator.id, {
        source: 'delegate',
        action: label.action,
        example_id: example.id,
      });
      console.log(
        `[replyLearning] learned delegate reply for creator ${creator && creator.id}: ${example.id} (${label.action})`,
      );
    }
    return { learned: !!inserted, id: example.id, action: label.action };
  } catch (err) {
    console.warn('[replyLearning] learnFromHumanReply failed:', err.message);
    return { skipped: err.message };
  }
}

// ── Feed 2: harvest the mailbox via the Instantly API ───────────────────────

function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripQuotedHistory(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && out.length) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  let result = out.join('\n').trim();
  result = result.replace(/\n-- \n[\s\S]*$/, '').trim();
  return result;
}

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w+/;
function bareAddress(v) {
  const m = String(v || '').match(EMAIL_RE);
  return m ? m[0].toLowerCase() : '';
}

// Instantly's email object field names vary by API version — extract
// defensively from the known aliases (same philosophy as the reply webhook).
function normalizeInstantlyEmail(raw) {
  const body = raw.body || {};
  const rawText =
    typeof body === 'string'
      ? body
      : body.text || (body.html ? htmlToText(body.html) : '') || raw.content_preview || '';
  return {
    id: raw.id || raw.message_id || raw.uuid || null,
    threadId: raw.thread_id || raw.threadId || raw.id || null,
    from: bareAddress(raw.from_address_email || raw.from_email || raw.from),
    subject: raw.subject || null,
    ts: Number(new Date(raw.timestamp_email || raw.timestamp_created || raw.created_at || 0)) || 0,
    text: stripQuotedHistory(rawText).trim(),
    eaccount: bareAddress(raw.eaccount || raw.email_account),
  };
}

function senderEmailSet() {
  const set = new Set();
  for (const v of [process.env.SENDER_EMAIL, process.env.INSTANTLY_EACCOUNT]) {
    const a = bareAddress(v);
    if (a) set.add(a);
  }
  return set;
}

// Ours vs theirs: a message is outbound when its From is the connected mailbox
// (per-email eaccount) or one of the configured sender addresses.
function isOutbound(email, senders) {
  if (!email.from) return false;
  if (email.eaccount && email.from === email.eaccount) return true;
  return senders.has(email.from);
}

// (inbound → next outbound manager reply) pairs within one thread,
// chronological. Pure — unit-tested directly.
function pairEmailsInThread(emails, senders) {
  const sorted = [...emails].sort((a, b) => a.ts - b.ts);
  const pairs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    if (isOutbound(a, senders)) continue; // we sent it
    let b = null;
    for (let j = i + 1; j < sorted.length; j++) {
      if (isOutbound(sorted[j], senders)) {
        b = sorted[j];
        break;
      }
    }
    if (!b) continue;
    if (!a.text || !b.text) continue;
    pairs.push({
      threadId: a.threadId,
      inboundId: a.id,
      outboundId: b.id,
      inboundFrom: a.from,
      inbound: a.text,
      outbound: b.text,
      outboundSubject: b.subject,
      outboundTs: b.ts,
    });
  }
  return pairs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sweep the mailbox: list emails (newest first), rebuild threads, label every
// not-yet-learned pair, store the keepers. `since` (ms epoch) skips pairs whose
// reply predates the last sweep; already-stored ids are skipped without a
// Claude call, so re-runs are cheap and idempotent.
async function harvestInbox({ maxEmails, dryRun = false, since = 0, eaccount = null, log = console.log } = {}) {
  if (!process.env.INSTANTLY_API_KEY) return { skipped: 'INSTANTLY_API_KEY not set' };
  if (!getClient()) return { skipped: 'ANTHROPIC_API_KEY not set (labeler unavailable)' };

  const cap = Number(maxEmails || process.env.LEARN_HARVEST_MAX_EMAILS || 500);
  const senders = senderEmailSet();

  // 1. Page through the unibox. Dedupe by id and stop on a page with no new
  //    mail — protects against a cursor the server ignores (which would
  //    otherwise re-serve the same page until the cap).
  const emails = [];
  const seenIds = new Set();
  let startingAfter = null;
  while (emails.length < cap) {
    const page = await instantly.listEmails({
      limit: Math.min(100, cap - emails.length),
      startingAfter,
      eaccount,
    });
    const items = page.items || page.data || page.emails || [];
    if (!items.length) break;
    let added = 0;
    let lastId = null;
    for (const it of items) {
      const e = normalizeInstantlyEmail(it);
      if (!e.id) continue;
      lastId = e.id;
      if (seenIds.has(e.id)) continue;
      seenIds.add(e.id);
      emails.push(e);
      added += 1;
    }
    if (!added) break;
    startingAfter = page.next_starting_after || lastId;
    if (!startingAfter) break;
  }
  log(`[replyLearning] harvest: scanned ${emails.length} emails (cap ${cap})`);

  // 2. Threads → pairs.
  const byThread = new Map();
  for (const e of emails) {
    const key = e.threadId || e.id;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(e);
  }
  let pairs = [];
  for (const thread of byThread.values()) pairs.push(...pairEmailsInThread(thread, senders));
  if (since) pairs = pairs.filter((p) => !p.outboundTs || p.outboundTs >= since);
  log(`[replyLearning] harvest: ${byThread.size} threads → ${pairs.length} candidate pairs`);

  // 3. Skip pairs already learned (no Claude spend on re-runs).
  const idFor = (p) => `harvest_${p.threadId}_${p.inboundId}`;
  const known = await store.existingIds(pairs.map(idFor));
  pairs = pairs.filter((p) => !known.has(idFor(p)));

  // 4. Label + store.
  let kept = 0;
  let skippedOffer = 0;
  let failed = 0;
  const perAction = {};
  for (const pair of pairs) {
    const label = await labelPair({
      inbound: clip(pair.inbound),
      outbound: clip(pair.outbound),
      inboundFrom: pair.inboundFrom,
      outboundDate: pair.outboundTs ? new Date(pair.outboundTs).toUTCString() : '',
    });
    await sleep(SLEEP_MS_BETWEEN_LABELS);
    if (!label || !label.action || !replyExamples.ACTIONS.includes(label.action)) {
      failed += 1;
      continue;
    }
    if (label.skip) {
      skippedOffer += 1;
      continue;
    }
    perAction[label.action] = (perAction[label.action] || 0) + 1;
    if (dryRun) {
      kept += 1;
      continue;
    }
    const inserted = await store.insert({
      id: idFor(pair),
      source: 'harvest',
      expected_action: label.action,
      expected_quoted_rate: label.quoted_rate == null ? null : Number(label.quoted_rate),
      stage: label.stage || null,
      inbound: clip(pair.inbound),
      outbound_subject: pair.outboundSubject || null,
      outbound_body: clip(pair.outbound),
      notes: label.notes || '',
    });
    if (inserted) kept += 1;
  }

  const summary = {
    scanned: emails.length,
    threads: byThread.size,
    candidates: pairs.length,
    alreadyKnown: known.size,
    kept,
    skippedOffer,
    failed,
    perAction,
    dryRun,
  };
  log(
    `[replyLearning] harvest done: kept ${kept}, already known ${known.size}, skipped (offer/non-exchange) ${skippedOffer}, failed ${failed}${dryRun ? ' [dry-run]' : ''}`,
  );
  return summary;
}

// Scheduler entry point: run a harvest when the last one is older than
// LEARN_HARVEST_HOURS (default 24; 0 disables). Non-overlapping; persists the
// run timestamp in app_settings so the cadence survives restarts.
let _harvestRunning = false;
async function maybeRunScheduledHarvest() {
  const raw = process.env.LEARN_HARVEST_HOURS;
  const hours = raw == null || raw === '' ? 24 : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return { skipped: 'disabled' };
  if (!process.env.INSTANTLY_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    return { skipped: 'not configured' };
  }
  if (_harvestRunning) return { skipped: 'already running' };

  let lastTs = 0;
  try {
    const last = await getSetting(HARVEST_LAST_RUN_KEY);
    lastTs = last ? Date.parse(last) || 0 : 0;
  } catch (err) {
    console.warn('[replyLearning] could not read last harvest time:', err.message);
  }
  if (lastTs && Date.now() - lastTs < hours * 3600_000) return { skipped: 'not due' };

  _harvestRunning = true;
  try {
    const startedAt = new Date().toISOString();
    // One-hour overlap so a reply that landed while the previous sweep ran is
    // never missed; the existing-id check makes the overlap free.
    const res = await harvestInbox({ since: lastTs ? lastTs - 3600_000 : 0 });
    if (!res.skipped) await setSetting(HARVEST_LAST_RUN_KEY, startedAt);
    return res;
  } catch (err) {
    console.error('[replyLearning] scheduled harvest failed:', err.message);
    return { error: err.message };
  } finally {
    _harvestRunning = false;
  }
}

module.exports = {
  learnFromHumanReply,
  harvestInbox,
  maybeRunScheduledHarvest,
  labelPair,
  pairEmailsInThread,
  normalizeInstantlyEmail,
  stripQuotedHistory,
  HARVEST_LAST_RUN_KEY,
  // Test-only.
  _setClient,
  _setStore,
};
