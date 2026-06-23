#!/usr/bin/env node
'use strict';

// Pull (creator_inbound, jennifer_reply) pairs from Jennifer's connected
// Gmail mailbox, label each with the negotiation action taxonomy, and write
// them to data/harvested_examples.json — the in-context-learning bank the
// negotiation prompt picks few-shot examples from.
//
// Prereqs (same env the backend uses):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
//   DATABASE_URL          (oauth tokens are stored here)
//   SENDER_EMAIL          (the mailbox to harvest)
//   ANTHROPIC_API_KEY     (used to label each pair)
//
// Usage:
//   node backend/scripts/harvest-inbox.js              # all threads, default cap
//   node backend/scripts/harvest-inbox.js --limit 50   # cap threads scanned
//   node backend/scripts/harvest-inbox.js --query 'newer_than:90d'
//   node backend/scripts/harvest-inbox.js --dry-run    # log labels, don't write
//
// The output file is git-ignored — it contains creator PII.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('../src/services/oauth');

const OUT_PATH = path.join(__dirname, '..', 'data', 'harvested_examples.json');
const DEFAULT_LIMIT = 200;
const SLEEP_MS_BETWEEN_LABELS = 250;

function parseArgs(argv) {
  const out = { limit: DEFAULT_LIMIT, query: 'in:anywhere', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i] || DEFAULT_LIMIT);
    else if (a === '--query') out.query = String(argv[++i] || out.query);
    else if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node backend/scripts/harvest-inbox.js [--limit N] [--query Q] [--dry-run]');
      process.exit(0);
    }
  }
  return out;
}

function b64UrlDecode(data) {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function findPart(payload, mime) {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body && payload.body.data) return payload.body.data;
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) {
      const r = findPart(p, mime);
      if (r) return r;
    }
  }
  return null;
}

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

function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function textOfMessage(msg) {
  const plain = findPart(msg.payload, 'text/plain');
  if (plain) return stripQuotedHistory(b64UrlDecode(plain));
  const html = findPart(msg.payload, 'text/html');
  if (html) return stripQuotedHistory(htmlToText(b64UrlDecode(html)));
  return stripQuotedHistory(msg.snippet || '');
}

// (inbound_msg, next_outbound_jennifer_msg) pairs in chronological order.
function pairUpThread(messages, senderEmailLower) {
  const sorted = [...messages].sort(
    (a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0),
  );
  const pairs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const aFrom = getHeader(a.payload && a.payload.headers, 'From').toLowerCase();
    if (aFrom.includes(senderEmailLower)) continue; // we sent it
    // Find the next message from Jennifer after this one.
    let b = null;
    for (let j = i + 1; j < sorted.length; j++) {
      const cand = sorted[j];
      const cFrom = getHeader(cand.payload && cand.payload.headers, 'From').toLowerCase();
      if (cFrom.includes(senderEmailLower)) {
        b = cand;
        break;
      }
    }
    if (!b) continue;
    const inbound = textOfMessage(a);
    const outbound = textOfMessage(b);
    if (!inbound || !outbound) continue;
    pairs.push({
      threadId: a.threadId,
      inboundMsgId: a.id,
      outboundMsgId: b.id,
      inboundFrom: getHeader(a.payload && a.payload.headers, 'From'),
      outboundDate: getHeader(b.payload && b.payload.headers, 'Date'),
      inbound,
      outbound,
      outboundSubject: getHeader(b.payload && b.payload.headers, 'Subject'),
    });
  }
  return pairs;
}

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

async function labelPair(client, pair) {
  const user = `INBOUND (from ${pair.inboundFrom}):\n${pair.inbound}\n\n---\nMANAGER REPLY (${pair.outboundDate}):\n${pair.outbound}`;
  const resp = await client.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
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
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required to label pairs.');
    process.exit(1);
  }
  const senderEmail = (process.env.SENDER_EMAIL || '').toLowerCase();
  if (!senderEmail) {
    console.error('SENDER_EMAIL is required so we know which messages are outbound.');
    process.exit(1);
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  console.log(`[harvest] listing threads (limit=${args.limit}, query="${args.query}")…`);
  const threads = [];
  let pageToken;
  while (threads.length < args.limit) {
    const resp = await gmail.users.threads.list({
      userId: 'me',
      q: args.query,
      maxResults: Math.min(100, args.limit - threads.length),
      pageToken,
    });
    threads.push(...(resp.data.threads || []));
    pageToken = resp.data.nextPageToken;
    if (!pageToken) break;
  }
  console.log(`[harvest] ${threads.length} threads to scan`);

  const allPairs = [];
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    try {
      const thread = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'full' });
      const pairs = pairUpThread(thread.data.messages || [], senderEmail);
      allPairs.push(...pairs);
      if ((i + 1) % 25 === 0) console.log(`[harvest] scanned ${i + 1}/${threads.length} threads (pairs so far: ${allPairs.length})`);
    } catch (err) {
      console.warn(`[harvest] thread ${t.id} failed: ${err.message}`);
    }
  }
  console.log(`[harvest] ${allPairs.length} (inbound → reply) pairs to label`);

  const examples = [];
  let skipped = 0;
  let labelFailed = 0;
  for (let i = 0; i < allPairs.length; i++) {
    const pair = allPairs[i];
    let label;
    try {
      label = await labelPair(anthropic, pair);
    } catch (err) {
      labelFailed += 1;
      console.warn(`[harvest] label failed on pair ${i}: ${err.message}`);
      await sleep(SLEEP_MS_BETWEEN_LABELS * 4);
      continue;
    }
    await sleep(SLEEP_MS_BETWEEN_LABELS);
    if (!label || !label.action) {
      labelFailed += 1;
      continue;
    }
    if (label.skip) {
      skipped += 1;
      continue;
    }
    examples.push({
      id: `harvest_${pair.threadId}_${pair.inboundMsgId}`,
      expected_action: label.action,
      expected_quoted_rate: label.quoted_rate == null ? null : Number(label.quoted_rate),
      stage: label.stage || null,
      inbound: pair.inbound,
      outbound_subject: pair.outboundSubject || null,
      outbound_body: pair.outbound,
      notes: label.notes || '',
      _source: {
        threadId: pair.threadId,
        inboundMsgId: pair.inboundMsgId,
        outboundMsgId: pair.outboundMsgId,
        inboundFrom: pair.inboundFrom,
      },
    });
    if ((i + 1) % 20 === 0) {
      console.log(
        `[harvest] labeled ${i + 1}/${allPairs.length} — kept ${examples.length}, skipped (offer email) ${skipped}, failed ${labelFailed}`,
      );
    }
  }

  console.log(`[harvest] done: kept ${examples.length}, skipped ${skipped}, failed ${labelFailed}`);

  if (args.dryRun) {
    console.log('[harvest] --dry-run: would write the following per-action counts:');
    const counts = {};
    for (const ex of examples) counts[ex.expected_action] = (counts[ex.expected_action] || 0) + 1;
    console.table(counts);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(examples, null, 2)}\n`);
  console.log(`[harvest] wrote ${examples.length} examples → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[harvest] fatal:', err);
  process.exit(1);
});
