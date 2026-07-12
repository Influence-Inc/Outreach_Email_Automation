'use strict';

// Creator negotiation, in-app. Claude is used ONLY to (a) understand the
// creator's plain-text reply and (b) write the email (adapting the canonical
// templates). Offer numbers are 100% formula (pricing.js). The admin approval
// gate is enforced: no offer email sends until an admin approves an offer.
//
// Everything degrades gracefully: with no ANTHROPIC_API_KEY (or on any Claude
// error) we fall back to deterministic heuristics + templates, so the flow is
// testable without the API. Set DRY_RUN=1 to log emails instead of sending.

const db = require('../db');
const pricing = require('./pricing');
const templates = require('./negotiationTemplates');
const instantly = require('./instantly');
const { getGuidelines, getAiRepliesEnabled } = require('./settings');
const replyExamples = require('./replyExamples');
const replyLearning = require('./replyLearning');
const contracts = require('./contracts');
const thread = require('./thread');

// ── Claude client (shared) ────────────────────────────────────────────────
// The lazy Anthropic client + JSON helpers live in ./claudeClient so the
// contracts engine can reuse the exact same call/parse pattern without a
// circular require through this module. `_setClient` is re-exported below so the
// existing test harness (require('./negotiation')._setClient) keeps working.
const {
  callClaudeText,
  callClaudeMessages,
  parseJsonLoose,
  _setClient,
} = require('./claudeClient');

const numOrNull = (x) => {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

const isDryRun = () => /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ''));

// ── Who is replying? ────────────────────────────────────────────────────────
// A reply may come from someone acting on the creator's behalf — a manager,
// agent, assistant, or agency rep. When it does, we greet THAT person by name
// while still doing the deal with the creator. Detect the sender's first name
// from an explicit self-introduction or a signature. Conservative by design:
// returns null unless it finds a clear, plausible first name, so we never
// invent or mis-address.
const ROLE_WORD = 'manager|agent|assistant|team|talent|mgmt|management|rep|representative|partnerships?|agency|mcn';
const NAME = "([A-Z][a-z]+(?:\\s[A-Z][a-z]+)?)"; // "Alex" or "Alex Chen"

function firstToken(name) {
  return String(name || '').trim().split(/\s+/)[0] || null;
}

// A real name, case-sensitively: each token starts with a capital. This is the
// guard against the case-insensitive trigger match capturing a common word
// (the `i` flag lets "thanks, sounds good" match "Thanks, <Name>", but the
// captured "sounds" keeps its lowercase and is rejected here).
function looksLikeName(s) {
  return /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)?$/.test(String(s || '').trim());
}
// Return the captured name's first token only if it's genuinely capitalized.
function nameOf(m) {
  return m && looksLikeName(m[1]) ? firstToken(m[1]) : null;
}

function detectSenderName(text) {
  if (!text) return null;
  const s = String(text).replace(/\r\n/g, '\n');

  // 1. Signature line: "- Alex", "– Alex Chen", "Best, Alex", "Thanks, Alex",
  //    "- Alex, Manager". Scan the last few non-empty lines.
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(-4)) {
    let m = line.match(new RegExp(`^[-–—]\\s*${NAME}(?:\\s*,\\s*(?:the\\s+)?(?:${ROLE_WORD})\\b)?`, 'i'));
    if (nameOf(m)) return nameOf(m);
    m = line.match(new RegExp(`^(?:best|thanks|thank you|regards|cheers|warmly|sincerely)[,!]?\\s+${NAME}$`, 'i'));
    if (nameOf(m)) return nameOf(m);
  }

  // 2. Self-introduction: "this is Alex", "I'm Alex", "I am Alex",
  //    "Alex here", "Alex from XYZ", "on behalf of ... , Alex".
  let m = s.match(new RegExp(`\\b(?:this is|i['’]?m|i am|it['’]?s)\\s+${NAME}`, 'i'));
  if (nameOf(m)) return nameOf(m);
  m = s.match(new RegExp(`\\b${NAME}\\s+here\\b`, 'i'));
  if (nameOf(m)) return nameOf(m);
  m = s.match(new RegExp(`\\b${NAME}[,]?\\s+(?:the\\s+)?(?:${ROLE_WORD})\\b`, 'i'));
  if (nameOf(m)) return nameOf(m);

  return null;
}

// The greeting name for our reply: the sender's name when someone clearly
// replied on the creator's behalf, otherwise the creator's own first name —
// used VERBATIM, exactly as stored in the first_name field (including any
// internal spaces, e.g. "Anvith K" greets "Hi Anvith K,"). Guards: the
// detected sender name must differ from the creator's, be a single plausible
// token, and not be a role/brand word.
//
// `firstToken()` is used ONLY to compare the detected sender against the
// creator's own name (a creator signing "- Anvith" should match a first_name
// of "Anvith K", not be mistaken for someone else) — the returned greeting
// name is always the full, untruncated first_name.
const NOT_A_PERSON = new Set([
  'the', 'team', 'hi', 'hello', 'hey', 'manager', 'agent', 'influence', 'thanks',
]);
function salutationFor(creatorFirstName, inboundText) {
  const fullCreatorName = String(creatorFirstName || '').trim() || null;
  const creatorToken = firstToken(creatorFirstName);
  const sender = detectSenderName(inboundText);
  if (!sender) return fullCreatorName || 'there';
  if (NOT_A_PERSON.has(sender.toLowerCase())) return fullCreatorName || 'there';
  if (creatorToken && sender.toLowerCase() === creatorToken.toLowerCase()) return fullCreatorName;
  return sender; // someone else is writing on the creator's behalf
}

// Did the sender explicitly ask to see references / a portfolio / other
// creators we've worked with? We only share reference accounts on a clear ask.
//
// Conservative by design: several of the previous alternatives were bare
// words with no surrounding context — bare "reference" (matches "she
// referenced your work"), bare "other creators" (matches "I've worked with
// other creators before, this looks fun!"), bare "showcase" (matches "I love
// to showcase brands I use"), and "samples of X" for ANY X (matches "here's a
// sample of what I usually charge"). Those false-positive triggers leaked the
// reference list into replies that never asked for it. Every pattern here
// requires the noun to be tied to OUR past work/portfolio, not just present
// anywhere in the message — biasing toward a missed ask (references stay
// hidden, the safe default) over a false trigger.
function askedForReferences(text) {
  if (!text) return false;
  const s = String(text);
  const workNoun = '(?:past|previous|prior)?\\s*(?:work|content|collabs?|campaigns?)';
  const patterns = [
    /\bportfolio\b/i,
    /\bcase\s+stud(?:y|ies)\b/i,
    /\b(?:any|some|got)\s+references?\b/i,
    /\breferences?\s+(?:you\s+can\s+)?(?:share|send|provide)\b/i,
    new RegExp(`\\bexamples?\\s+of\\s+(?:your\\s+)?${workNoun}\\b`, 'i'),
    new RegExp(`\\bsamples?\\s+of\\s+(?:your\\s+)?${workNoun}\\b`, 'i'),
    new RegExp(`\\bshowcase\\s+of\\s+(?:your\\s+)?${workNoun}\\b`, 'i'),
    /\b(?:see|share|send)\s+(?:some\s+|any\s+)?(?:examples?|references?)\b/i,
    // "have you worked with" / "who have you worked with" / "you've worked
    // with" / "brands you've worked with" — the "you" requirement is what
    // excludes the creator describing THEIR OWN history ("I've worked with
    // other creators", "we've worked with brands before").
    /\b(?:have\s+you|you(?:'?ve|\s+have))\s+(?:worked|partnered|collaborated)\s+with\b/i,
  ];
  return patterns.some((re) => re.test(s));
}

// ── Context ───────────────────────────────────────────────────────────────
async function loadCreator(creatorId) {
  return db.one(
    `SELECT c.*, ca.brand_name, ca.name AS campaign_name, ca.max_cpm, ca.usage_rights_policy
     FROM creators c JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE c.id = $1`,
    [creatorId],
  );
}

function ctxFor(creator, extra = {}) {
  return {
    firstName: creator.first_name || 'there',
    brandName: creator.brand_name || process.env.BRAND_NAME || 'the brand',
    campaignName: creator.campaign_name || null,
    cadence: process.env.CONTENT_CADENCE || process.env.CAMPAIGN_DEADLINE || '1-2 videos per week',
    managerName: process.env.MANAGER_NAME || process.env.SENDER_NAME || 'Jennifer',
    refs: templates.REFERENCE_ACCOUNTS,
    maxCpm: creator.max_cpm != null ? Number(creator.max_cpm) : pricing.TARGET_CPM,
    stage: creator.negotiation_status || null,
    hasStats: creator.ig_scraped_data != null,
    approvedOffer: extra.approvedOffer || null,
    guidelines: extra.guidelines || '',
    // Governs the Usage Rights section in Reply 1 (see negotiationTemplates.js
    // reply1()) and paid-ad-rights inclusion in the generated contract (see
    // contracts.js). Defaults to 'no_rights' — the pre-existing behavior.
    usageRightsPolicy: creator.usage_rights_policy || 'no_rights',
    ...extra,
  };
}

// Reply 1 should only claim "no ad rights required" when that's actually true
// for the campaign — i.e. the "no_rights" policy. "free_only" and "required"
// both want ad rights (conditionally or always), so the section is dropped.
const includeUsageRightsFor = (ctx) => ctx.usageRightsPolicy === 'no_rights';

// Formatting instruction shared by every Claude email-writing prompt (reply +
// offer). The delivery layer (instantly.renderMarkdown) turns this markdown
// subset into HTML in the sent email, so it must be identical everywhere.
const FORMATTING_RULE =
  'Formatting — the delivery layer renders inline markdown as HTML in the sent email. ' +
  'Wrap EVERY section header / sub-topic label in **bold** (e.g. **Content Style**, **Deliverables & Rates**, **Platforms**, **Timelines**, **View-Based Offer**, **Flat Package**, **Payment details**, **Past content references**), and use [label](https://example.com) for any hyperlink (reference Instagram handles are already written as such links — keep them as links). Match the format spec in the team guidelines above when it prescribes what to bold or link; do not over-format. Everything else stays plain text with line breaks — no other markdown (no headings syntax, no italics, keep the existing "-" bullets as-is).';

// Renders the team's universal Guidelines as a prompt block (or '' when unset).
function guidelinesBlock(ctx) {
  const g = (ctx.guidelines || '').trim();
  if (!g) return '';
  return [
    '',
    'Team guidelines — follow these in every message, they override the templates on any conflict:',
    g,
    '',
  ].join('\n');
}

function templateVars(ctx) {
  return {
    firstName: ctx.firstName,
    // The greeting name — the sender when someone replied on the creator's
    // behalf, else the creator. Defaults to firstName when not resolved.
    salutation: ctx.salutation || ctx.firstName,
    brandName: ctx.brandName,
    cadence: ctx.cadence,
    refs: ctx.refs,
    managerName: ctx.managerName,
  };
}

function todayStr() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function describeStage(stage) {
  switch (stage) {
    case null:
    case undefined:
      return 'The creator just replied to our initial outreach. Negotiation is starting.';
    case 'AWAITING_RATE':
      return 'We sent the collaboration details and are waiting for the creator to share their rate.';
    case 'AWAITING_APPROVAL':
      return 'The creator shared a rate; an admin is reviewing offers internally.';
    case 'AWAITING_DECISION':
      return 'We sent an offer and are waiting for the creator to accept, decline, or counter.';
    default:
      return `Stage: ${stage}.`;
  }
}

// ── (a) Understand a reply — ONE Claude call, strict JSON ─────────────────
async function handleCreatorReply(creator, replyText, ctx) {
  const v = templateVars(ctx);
  const defaultSubject = templates.reply1(v).subject;

  const system = [
    `You are ${v.managerName}, a friendly brand-partnerships manager at INFLUENCE.`,
    `You're negotiating an Instagram collaboration with the creator ${v.firstName} for the brand "${v.brandName}"${
      ctx.campaignName ? ` (campaign: ${ctx.campaignName})` : ''
    }.`,
    `Today's date is ${todayStr()}. The desired posting cadence is "${v.cadence}". When you mention timelines, compute an APPROXIMATE "all videos posted by" calendar date from today's date, the cadence, and the number of videos in the deal — do NOT print the cadence text where a date belongs.`,
    v.salutation && v.salutation !== v.firstName
      ? `This reply appears to be from ${v.salutation}, writing on ${v.firstName}'s behalf (a manager/agent/assistant). Greet ${v.salutation} by name ("Hi ${v.salutation},") while still referring to the creator as ${v.firstName} when you talk about the collaboration.`
      : `Greet the creator by their first name ("Hi ${v.firstName},").`,
    ctx.includeRefs
      ? 'The sender asked to see examples of past work, so you MAY include the reference accounts.'
      : 'The sender did NOT ask for references — do NOT include the reference accounts or a "Past content references" section in this reply.',
    includeUsageRightsFor(ctx)
      ? 'This campaign does not need paid ad rights — when you adapt REPLY 1, keep the "Usage Rights" section stating none are required.'
      : 'This campaign DOES want paid ad rights (conditionally or always) — when you adapt REPLY 1, DROP the "Usage Rights" section entirely. Never tell the creator that no ad rights are required.',
    '',
    `Current stage: ${describeStage(ctx.stage)}`,
    ctx.hasStats
      ? "We already have this creator's Instagram view stats."
      : "We do not yet have this creator's Instagram view stats.",
    ctx.approvedOffer
      ? `An admin has approved this offer to send: ${JSON.stringify(ctx.approvedOffer)}.`
      : 'No offer has been approved yet.',
    guidelinesBlock(ctx),
    '',
    'Adapt the following canonical templates — keep their content and tone, do not free-write new structures:',
    '--- REPLY 1 (share details + ask for their rate) ---',
    templates.REPLY1_BODY,
    '--- REPLY 2 (performance / view-based offer style) ---',
    templates.REPLY2_BODY,
    '',
    'Read the creator\'s plain-text reply and respond with STRICT JSON ONLY (no prose, no markdown fences), exactly this shape:',
    '{"understanding": string, "action": "shared_rate"|"asking_details"|"answer_question"|"request_our_offer"|"request_counter_rate"|"accepted"|"declined"|"counter"|"escalate"|"other", "quoted_rate": number|null, "quoted_rate_options": [{"amount": number, "label": string}] | null, "email": {"subject": string, "body": string} | null, "send_now": boolean}',
    '',
    'Rules:',
    `- Judge the creator's intent from the MEANING and tone of the whole reply, NEVER from specific keywords. Any enthusiasm, curiosity, or request to hear more — e.g. "sounds great", "amazing", "interesting", "cool", "tell me more", "share the details", "what did you have in mind", "I'd love to know more", "I'm in", "sure", a simple "yes", or even just a positive emoji — all mean the creator wants to proceed. Treat those as interest. How to classify that interest depends on the stage: when REPLY 1 has NOT been sent yet, use "asking_details". Once we have already sent a PRICED OFFER (current stage AWAITING_DECISION) and the reply's overall meaning is that they AGREE to that offer or are ready to move ahead with it — "sounds good, let's do it", "perfect, what are the next steps?", "I'm in", "yes let's go", "happy with that", "great, how do we start?" — classify it as "accepted" (they are saying yes to the offer on the table), NOT "answer_question". At AWAITING_DECISION, reserve "answer_question" for replies that actually ASK a specific question instead of agreeing, and "request_counter_rate"/"counter" for replies that push back on the price. If a positive reply at AWAITING_DECISION is genuinely AMBIGUOUS about whether they accept (e.g. "sounds interesting, but I have a few questions first"), prefer "answer_question" — do NOT accept on a soft or conditional signal. At any stage other than AWAITING_DECISION, a generic positive with no question is "asking_details" (pre-REPLY 1) or "answer_question". A creator does NOT have to say the word "yes" or "interested" to be interested. Reserve "declined" strictly for replies whose overall meaning is that they do NOT want to proceed.`,
    '- "shared_rate": the creator stated a rate/budget/price. Put the primary numeric USD amount in quoted_rate (plain number, no symbols). email=null, send_now=false — an admin must approve an offer before we reply.',
    '- quoted_rate_options: whenever the creator lists MORE THAN ONE rate — a tiered / performance ladder ("$3,500 for 300k views, $5,000 for 600k views, $7,500 for 1M views"), a per-item + package pair ("$900 per reel, $2,500 for 3 reels"), or any menu of alternatives — return EVERY rate as an ordered array of {"amount": number, "label": string}. `label` is a short human-readable description of what THAT specific rate covers (e.g. "$3,500 for 300k views", "package of 3 reels — $2,500 total"), taken from the surrounding text — don\'t paraphrase, but drop bullet markers and trailing punctuation. Use quoted_rate for the primary/reference amount (usually the lowest tier or the per-item price). If the creator gave exactly ONE rate, set quoted_rate_options to null. Also set this on "counter" when the creator lists multiple counter-numbers.',
    `- "request_our_offer": the creator is interested but turns the rate question back on us — they ask US to name/quote/propose a rate, state a budget, or make the FIRST offer instead of giving their own number ("can you quote a fair rate first?", "what's your budget?", "what are you offering?", "make me an offer", "what do you usually pay for this?", "you tell me a number"). This is NOT a rate from them and NOT a complaint about an existing offer — it's a request for us to price it. email=null, send_now=false — an admin will set the price and send an offer from the dashboard. quoted_rate=null.`,
    '- "counter": the creator pushed back on a prior offer with a different number/terms. Put any numeric amount in quoted_rate. email=null, send_now=false.',
    `- "request_counter_rate": the creator pushed back on the offer we already sent ("this rate is too low", "can you do better?", "I usually charge more", "not quite what I had in mind") but did NOT name a specific number. Use this ONLY when an offer is already on the table (the current stage is AWAITING_DECISION) — otherwise prefer "asking_details" or "answer_question". Write a SHORT plain-text reply that (1) warmly acknowledges their hesitation without committing to anything specific, (2) asks them directly what rate would work for them, (3) signals openness to working it out together. Do NOT propose a number, do NOT promise to match, do NOT mention any offer specifics — those come from admin approval. Sign "- ${v.managerName}". send_now=true. quoted_rate=null.`,
    `- "asking_details": the creator is interested but has not yet seen the standard collab pitch. Use this for the FIRST substantive reply when we have not yet sent REPLY 1. Write the email by ADAPTING REPLY 1 (brand "${v.brandName}", sign "- ${v.managerName}"). In Timelines, propose the cadence "${v.cadence}" and an approximate posted-by date you compute from today's date for a 2-video package. Include the "Past content references" section ONLY if the sender explicitly asked to see examples of past work / a portfolio / other creators we've worked with — otherwise drop that whole section from your adaptation. send_now=true. quoted_rate=null.`,
    `- "answer_question": the creator asked a specific factual question about an already-discussed deal. Common topics that ARE safe to answer from the REPLY 1 / REPLY 2 templates and the campaign context above: posting platform (Instagram only, no TikTok/YouTube cross-posting in this deal), content format (Reels), posting cadence ("${v.cadence}"), approximate timeline / posted-by date, creative freedom (yes, no script approval required), exclusivity (none), what we need from them (their rate, then we share a tailored offer; once accepted, posting can begin), who Influence is (a brand-partnerships team — share reference accounts (${v.refs}) ONLY when the sender asked to see examples of past work / a portfolio / other creators we've worked with), payment timing (per the "Payment details" block in REPLY 2: after the post is up and verified). Write a SHORT reply that (1) directly answers their question in 1-3 sentences using ONLY facts from the templates / campaign context above or facts our team already stated in the example exchanges shown before this message, then (2) one short follow-up line keeping the negotiation moving — if they have not shared a rate yet, ask for it; if an offer is on the table awaiting their decision, gently nudge for it; otherwise leave the door open. Sign "- ${v.managerName}". send_now=true. quoted_rate=null. NEVER invent specifics that are not in the campaign context, templates, past example exchanges, or already-quoted offer — if you would have to guess a number, a date beyond what cadence-math gives you, or any term not covered by those sources, use "escalate" instead.`,
    `- "accepted": the creator agreed to the priced offer we already sent, or clearly signalled they are ready to proceed with it ("sounds good, let's do it", "perfect, next steps?", "I'm in", "let's go", "yes, happy with that"). ONLY valid once an offer is on the table (current stage AWAITING_DECISION) — never accept when no offer has been sent. Write a short warm acceptance email signed "- ${v.managerName}". send_now=true. quoted_rate=null.`,
    `- "declined": they are GENUINELY not interested or not available — explicit "no thanks", "passing on this one", "not the right fit", "too busy right now", "please stop reaching out". Do NOT use "declined" for "this rate is too low" or "can you do better" — those are "request_counter_rate" (if no number given) or "counter" (if a number is given). Write a brief gracious email signed "- ${v.managerName}". send_now=true. quoted_rate=null.`,
    `- "escalate": use this when (a) the creator asks about contractual terms outside what is already in the templates / approved offer (a different payment structure, a usage-rights ask, an NDA, a legal question, a dispute, a complaint); OR (b) the creator's question references specifics not present in the campaign context, templates, past example exchanges, or already-quoted offer (a different brand, a different campaign, a custom timeline, a special exception); OR (c) the message is unusual, emotionally heated, or otherwise needs a human decision. email=null, send_now=false; a human will take over. When in doubt about whether you have enough information to answer correctly, escalate — but prefer "answer_question" for benign factual questions the templates or past example exchanges DO cover, and prefer "request_our_offer" when the creator simply wants US to name/propose a first rate (that is handled by the admin pricing an offer, not a human reply).`,
    `- "other": only a trivial acknowledgement that needs no action (e.g. "got it, thanks"). email=null, send_now=false.`,
    '- NEVER invent specific offer numbers in any email — offer numbers only ever come from an admin-approved offer.',
    '- Some (user → assistant) turn pairs may precede the real message below: those are REAL exchanges from our past negotiations, showing the correct output for a similar inbound. Treat the facts, decisions, and phrasing in their replies as team-approved knowledge. When the new message closely matches an example where our team answered directly, answer the same way instead of escalating — but never copy a dollar amount from an example, and never reuse another creator\'s name or deal specifics.',
    `- Salutation name — the reply may not be from the creator themselves. It may be from a manager, agent, assistant, MCN, agency, or brand-partnerships rep writing on the creator's behalf. Detect the sender's first name from the reply's opening ("Hi, this is Alex, ${v.firstName}'s manager"), signature block ("- Alex", "Best, Alex Chen"), or self-introduction ("I'm Alex from XYZ Talent"). If the sender's name is clearly different from "${v.firstName}", address that person by THEIR first name in the salutation ("Hi Alex,"). Still refer to the creator as "${v.firstName}" when discussing the collaboration itself — the deal is with the creator, not the sender. If the sender's identity is ambiguous, address "${v.firstName}" or fall back to "Hi there,"; never guess a name.`,
    `- Reference accounts (${v.refs}) are a portfolio credential — DO NOT include them proactively. Only include them when the sender explicitly asked to see examples of past work, other creators we've worked with, our portfolio, or references. When adapting REPLY 1 without such an ask, drop the "Past content references" section from your email entirely.`,
    `- ${FORMATTING_RULE}`,
    `- The creator's first name is "${v.firstName}" (used when talking about the creator; may be overridden by the sender's actual first name for the salutation, per the rule above).`,
  ].join('\n');

  // Few-shot examples picked from past labeled threads (seed bank + harvested
  // mailbox if available). Empty array when nothing matches — call still works,
  // just zero-shot like before. Capped at 4 to keep the prompt compact.
  const shots = replyExamples.pickExamplesFor(replyText, { k: 4, stage: ctx.stage });
  const shotMessages = replyExamples.examplesAsMessages(shots);
  if (shots.length) {
    console.log(
      `[negotiation] creator reply: using ${shots.length} example shot(s) — ${shots
        .map((s) => `${s.id}/${s.expected_action}`)
        .join(', ')}`,
    );
  }

  const messages = [...shotMessages, { role: 'user', content: replyText }];
  const out = parseJsonLoose(await callClaudeMessages(system, messages, 1200));
  if (out && out.action) {
    const email =
      out.email && out.email.body
        ? { subject: out.email.subject || defaultSubject, body: out.email.body }
        : null;
    // Normalise quoted_rate_options: keep only well-formed entries; if empty
    // after filtering, fall back to running the deterministic extractor over
    // the raw reply so an older Claude JSON without the new field still
    // captures multi-rate structure.
    let options = Array.isArray(out.quoted_rate_options)
      ? out.quoted_rate_options
          .map((o) => ({
            amount: numOrNull(o && o.amount),
            label: typeof (o && o.label) === 'string' ? o.label.trim().slice(0, 120) : '',
          }))
          .filter((o) => o.amount != null && o.label)
      : [];
    if (!options.length && (out.action === 'shared_rate' || out.action === 'counter')) {
      const extracted = parseRateOptionsFromText(replyText);
      if (extracted.length > 1) options = extracted;
    }
    return {
      understanding: out.understanding || '',
      action: out.action,
      quoted_rate: numOrNull(out.quoted_rate),
      quoted_rate_options: options.length ? options : null,
      email,
      send_now: out.send_now !== false,
    };
  }
  return heuristicReply(replyText, ctx);
}

function parseRateFromText(text) {
  if (!text) return null;
  const s = String(text);
  let m;
  const dollar = /\$\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?/g;
  while ((m = dollar.exec(s))) {
    let val = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) val *= m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
    if (val >= 50) return Math.round(val);
  }
  const kg = /(?:^|\s)(\d+(?:\.\d+)?)\s*([kKmM])\b/g;
  while ((m = kg.exec(s))) {
    let val = parseFloat(m[1]);
    val *= m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
    if (val >= 50) return Math.round(val);
  }
  return null;
}

// Extract EVERY rate the creator quoted in one reply, with the surrounding
// context as a label. Creators frequently send tiered pricing like:
//   - $3,500 for 300,000 combined views
//   - $5,000 for 600,000 combined views
//   - $7,500 for 1,000,000 combined views
// or inline: "My rate is $900 per reel, but for a package of 3 this month I
// can work at $2,500 total." Returns an array of `{ amount: number, label:
// string }` (label is the containing line/clause, trimmed and stripped of
// list markers, capped at 120 chars). Returns [] if no plausible amounts.
// Dedupes by (amount + normalised label) so the same rate stated twice
// doesn't appear twice.
function parseRateOptionsFromText(text) {
  if (!text) return [];
  const s = String(text).replace(/\r/g, '');
  const results = [];
  const seen = new Set();

  // Walk each line (a creator's bulleted list is line-per-option) and, within
  // each line, split on semicolons / " or " so inline alternatives become
  // separate options.
  const lines = s.split(/\n+/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split inline alternatives without swallowing the whole sentence.
    const clauses = line.split(/;\s+|\s+\bor\b\s+(?=\$)|\s{2,}/);
    for (const rawClause of clauses) {
      const clause = rawClause.trim();
      if (!clause) continue;
      // Find every $-amount in this clause.
      const amountRe = /\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmM])?/g;
      let m;
      const amountsHere = [];
      while ((m = amountRe.exec(clause)) !== null) {
        let val = parseFloat(m[1].replace(/,/g, ''));
        if (m[2]) val *= m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
        if (Number.isFinite(val) && val >= 50) amountsHere.push(Math.round(val));
      }
      if (!amountsHere.length) continue;
      // The label is the clause with any leading bullet marker stripped, so
      // "- $3,500 for 300,000 combined views" reads as "$3,500 for 300,000
      // combined views". Cap length to keep the dropdown compact.
      const label = clause
        .replace(/^[-*•·]\s*/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 120)
        .trim();
      // One clause can technically hold two amounts ("between $500 and
      // $700"); we still record them as separate options so the reader sees
      // both endpoints — the label carries the surrounding context.
      for (const amount of amountsHere) {
        const key = `${amount}|${label.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ amount, label });
      }
    }
  }
  return results;
}

// Does the creator turn the rate question back on us — asking us to name/quote
// a price or make the first offer, rather than giving their own number? Used by
// the heuristic fallback (Claude covers this via the request_our_offer action).
function asksUsToQuoteFirst(text) {
  if (!text) return false;
  const s = String(text);
  return (
    /\b(quote|propose|suggest|offer|name|throw out|put together|make)\b[^.?!]{0,40}\b(a\s+)?(fair\s+|good\s+|reasonable\s+)?(rate|number|figure|price|offer|budget|amount)\b/i.test(s) &&
    /\b(you|your|yourself|your\s+(team|side|end)|first)\b/i.test(s)
  ) ||
    /\bwhat('?s| is| are| do)\b[^.?!]{0,30}\b(your|you)\b[^.?!]{0,20}\b(budget|rate|offer(?:ing)?|pay(?:ing)?|number|price)\b/i.test(s) ||
    /\bmake\s+me\s+an\s+offer\b/i.test(s) ||
    /\byou\s+tell\s+me\s+(a\s+)?(number|price|rate)\b/i.test(s);
}

function heuristicReply(text, ctx) {
  const v = templateVars(ctx);
  const rate = parseRateFromText(text);
  if (rate != null) {
    // Multi-rate replies are common enough that even the heuristic path should
    // capture them — otherwise a Claude-unavailable session drops all but the
    // first amount.
    const options = parseRateOptionsFromText(text);
    return {
      understanding: '(heuristic) creator shared a rate',
      action: 'shared_rate',
      quoted_rate: rate,
      quoted_rate_options: options.length > 1 ? options : null,
      email: null,
      send_now: false,
    };
  }
  // Creator asked US to price it first — route to the offer configurator.
  if (asksUsToQuoteFirst(text)) {
    return {
      understanding: '(heuristic) creator asked us to quote a rate first',
      action: 'request_our_offer',
      quoted_rate: null,
      email: null,
      send_now: false,
    };
  }
  // Fallback intent read (only used when Claude is unavailable). Decline solely
  // on a clear disinterest signal AND only when the reply shows no sign of
  // interest — so "unfortunately I was slow, but this sounds amazing" is read as
  // interested, not declined. Any enthusiasm/curiosity counts as interest.
  const interested =
    /\b(interested|sounds?\s+(great|good|amazing|interesting|cool)|amazing|awesome|great|cool|love\s+(it|this)|tell me more|more details?|share\s+(the\s+)?details?|learn more|keen|i'?m in|let'?s\s+(do|talk|chat|go)|sure|yes|yeah|yep|absolutely)\b/i.test(
      text,
    );
  const declined =
    /\b(not interested|no thanks?|no longer|we'?ll pass|i'?ll pass|too busy|not available|maybe later|another time|please stop|not the right fit|not a good fit)\b/i.test(
      text,
    );
  // Once a priced offer is on the table (AWAITING_DECISION), a clear affirmative
  // with no price pushback means the creator is saying YES to that offer — fire
  // the acceptance (which kicks off the contract at the already-agreed price via
  // agreedOfferFee). Deliberately narrow: only explicit agree / ready-to-proceed
  // phrasing, never when the reply questions or pushes back on the price. The
  // processReply guard also restricts "accepted" to AWAITING_DECISION.
  if (ctx.stage === 'AWAITING_DECISION' && !declined) {
    const pushback =
      /\b(too\s+low|too\s+little|do\s+better|not\s+enough|higher|more\s+than|can\s+you\s+(do|go|match)|lowball|counter)\b/i.test(
        text,
      );
    // "tell me more" / "a few questions first" mean they want info before
    // committing — NOT a clear acceptance. Excluded so we never fire a contract
    // on a request for details (these fall through to the delegate path).
    const wantsMoreInfo =
      /\b(tell me more|more (details?|info(?:rmation)?)|learn more|(?:know|hear) more|a few questions|some questions|before (i|we)\b)\b/i.test(
        text,
      );
    const accepts =
      /\b(let'?s\s+(do\s+it|go|proceed|start|make\s+it\s+happen)|i'?m\s+in|count\s+me\s+in|sign\s+me\s+up|i\s+accept|we\s+accept|happy\s+(with|to\s+(proceed|go))|works\s+for\s+me|sounds?\s+(good|perfect|great)|looks?\s+good|perfect|deal|next\s+steps?|how\s+do\s+we\s+(start|proceed)|ready\s+to\s+(go|start|proceed))\b/i.test(
        text,
      );
    if (accepts && !pushback && !wantsMoreInfo) {
      return {
        understanding: '(heuristic) creator accepted the offer',
        action: 'accepted',
        quoted_rate: null,
        quoted_rate_options: null,
        email: null,
        send_now: true,
      };
    }
  }
  if (declined && !interested) {
    return {
      understanding: '(heuristic) creator declined',
      action: 'declined',
      quoted_rate: null,
      email: templates.declineDelay(v),
      send_now: true,
    };
  }
  return {
    understanding: '(heuristic) creator interested, no rate yet',
    action: 'asking_details',
    quoted_rate: null,
    email: templates.reply1(v, { includeRefs: ctx.includeRefs, includeUsageRights: includeUsageRightsFor(ctx) }),
    send_now: true,
  };
}

// ── (b) Write the offer email — Claude adapts REPLY 2 ─────────────────────
async function draftOfferEmail(creator, offer, ctx, { combine = false } = {}) {
  const v = templateVars(ctx);
  const fallback = templates.offerEmail(offer, v, { combine });

  const isViewBased = offer.offer_type === 'view_based';
  const offerDesc = isViewBased
    ? `A view-based deal: $${offer.flat_fee} for a minimum of ${offer.view_guarantee} combined total views on Instagram (views counted for 7 days per post; combined across posts; full creative freedom; no exclusivity). This deal is priced by TOTAL GUARANTEED VIEWS, not by a fixed video count — the creator decides how many posts to publish to reach the view total.`
    : offer.offer_type === 'video_bonus'
    ? `A flat package with a performance bonus: ${offer.num_videos} video(s) for $${offer.base_fee != null ? offer.base_fee : offer.flat_fee} base, plus a $${offer.bonus_amount} bonus if combined views cross ${offer.bonus_threshold_views} on Instagram (full creative freedom; no exclusivity).`
    : `A flat package: ${offer.num_videos} video(s) for $${offer.flat_fee} total (full creative freedom; no exclusivity).`;

  const system = [
    `You are ${v.managerName}, a friendly brand-partnerships manager at INFLUENCE writing about a collaboration for "${v.brandName}". Greet ${v.salutation} by name ("Hi ${v.salutation},")${
      v.salutation !== v.firstName ? ` — they are writing on ${v.firstName}'s behalf, so refer to the creator as ${v.firstName} when discussing the deal` : ''
    }.`,
    'An admin has APPROVED exactly one offer. Use its numbers EXACTLY — do not invent or change amounts, and present only this one offer.',
    `Approved offer JSON: ${JSON.stringify(offer)}`,
    `In plain words: ${offerDesc}`,
    // View-based deals must not mention a specific video count anywhere in
    // the sent email — it makes the deal sound bounded to a fixed number of
    // posts when it isn't. Framing is per-view, not per-video.
    isViewBased
      ? 'HARD RULE: This is a VIEW-BASED offer — do NOT mention a number of videos or posts anywhere in the email. No "N-video package", no "the first video", no "further videos", no "N posts". Talk only about the guaranteed VIEW TOTAL and let the creator decide the post count.'
      : '',
    `Today's date is ${todayStr()}. Desired posting cadence: "${v.cadence}". If you mention timelines, give an approximate posted-by date computed from today for this ${
      isViewBased ? 'view-based' : `${offer.num_videos}-video`
    } deal at that cadence; never print the cadence text where a date belongs.`,
    '',
    guidelinesBlock(ctx),
    'Write ONE email by adapting this canonical offer template — keep its warm tone, the "**Payment details**" section, and the "- ' + v.managerName + '" sign-off:',
    '--- REPLY 2 ---',
    templates.REPLY2_BODY,
    combine
      ? [
          '',
          'This is the FIRST reply (the creator gave their rate immediately), so FIRST cover the collaboration details by adapting REPLY 1, THEN present the approved offer in the same email:',
          '--- REPLY 1 ---',
          templates.REPLY1_BODY,
          `Use brand "${v.brandName}" and the cadence "${v.cadence}" for timelines. Do NOT include the "Past content references" section — an offer email should not introduce references unprompted.`,
        ].join('\n')
      : '',
    '',
    `- ${FORMATTING_RULE}`,
    '',
    'Respond with STRICT JSON ONLY (no markdown fences): {"subject": string, "body": string}. The body carries the small markdown subset described above (bold headers, links); no other markdown.',
  ]
    .filter(Boolean)
    .join('\n');

  const out = parseJsonLoose(await callClaudeText(system, 'Write the offer email now.', 1500));
  if (out && out.body) return { subject: out.subject || fallback.subject, body: out.body };
  return fallback;
}

// ── Email sending (threaded; DRY_RUN logs instead) ────────────────────────
async function countSentNegotiation(creatorId) {
  const r = await db.one(
    `SELECT COUNT(*)::int AS n FROM email_events WHERE creator_id = $1 AND type = 'sent_negotiation'`,
    [creatorId],
  );
  return r ? r.n : 0;
}

// The subject for every negotiation email MUST equal the conversation's subject,
// or Gmail splits our message into a new thread even with In-Reply-To set. So we
// echo the exact subject of the creator's reply (captured by the webhook as
// instantly_reply_subject). Only when that's missing do we synthesize one from
// the brand as a last resort.
function threadSubject(creator) {
  if (creator.instantly_reply_subject) return creator.instantly_reply_subject;
  const brand = creator.brand_name || process.env.BRAND_NAME || 'INFLUENCE';
  return `Paid Partnership with ${brand}`;
}

async function sendNegotiationEmail(creator, email, kind) {
  const subject = threadSubject(creator);
  let detail = { kind, subject };
  if (isDryRun()) {
    console.log(`[negotiation][DRY_RUN] -> ${creator.email} (${kind}): ${subject}\n${email.body}\n`);
    detail.dryRun = true;
  } else {
    if (!creator.instantly_reply_uuid) {
      throw new Error(`No instantly_reply_uuid for creator ${creator.id} — cannot send threaded reply`);
    }
    // Instantly requires the sending mailbox (eaccount) on /emails/reply. It's
    // captured from the reply webhook's email_account; INSTANTLY_EACCOUNT is an
    // optional fallback for replies received before that field was stored.
    const eaccount = creator.instantly_email_account || process.env.INSTANTLY_EACCOUNT || null;
    if (!eaccount) {
      throw new Error(
        `No sending account (eaccount) for creator ${creator.id} — it is captured from the reply webhook; set INSTANTLY_EACCOUNT as a fallback`,
      );
    }
    await instantly.replyToEmail({
      replyToUuid: creator.instantly_reply_uuid,
      eaccount,
      subject,
      body: email.body,
    });
    detail = { ...detail, replyToUuid: creator.instantly_reply_uuid, eaccount };
  }
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'sent_negotiation', $2)`,
    [creator.id, detail],
  );
  // Persist this outbound message to the full conversation thread (used later
  // by the contract extractor to see what WE proposed — e.g. Reply 1's platform
  // offer). Best-effort: the email is already sent, so a logging failure here
  // must not surface as a send error.
  try {
    await thread.recordMessage(creator.id, { direction: 'outbound', kind, subject, body: email.body });
  } catch (e) {
    console.warn(`[negotiation] thread record (outbound ${kind}) failed for creator ${creator.id}: ${e.message}`);
  }
  await db.query(
    `UPDATE creators SET last_negotiation_email_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [creator.id],
  );
}

// ── Delegation (human handoff) ─────────────────────────────────────────────

// Is the AI allowed to auto-reply right now? Reads the global kill-switch
// from app_settings (the "Auto-reply with AI" checkbox on the Guidelines
// page). Defaults TRUE when the setting hasn't been written yet. The
// `creator` arg is kept for call-site compatibility but is unused — the
// switch is global since per-campaign template selection was removed.
async function aiRepliesEnabledForCreator(_creator) {
  return await getAiRepliesEnabled();
}

// Park a reply for a human: flag needs_human and stash the creator's message +
// the reason. Does NOT send anything.
async function delegate(creator, inbound, reason) {
  await db.query(
    `UPDATE creators
     SET needs_human = TRUE, delegate_reason = $2, delegate_question = $3,
         delegated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [creator.id, reason, inbound.text],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'delegated', $2)`,
    [creator.id, { reason }],
  );
}

// Scan a plain-text delegate reply for the largest dollar amount, so a manual
// offer typed by the admin ("We'd love to offer $10k for 1 video.") can be
// surfaced on the rate timeline as an "Offer sent — $X" entry, just like
// offers sent through the structured Approve & send flow. Returns an integer
// USD amount, or null if no plausible amount is present. Supports $X, $X.Y,
// $Xk / $X.Yk, and $X,XXX formatting.
function extractOfferAmount(text) {
  if (!text) return null;
  const s = String(text);
  const amounts = [];
  const kRe = /\$\s*(\d+(?:\.\d+)?)\s*[kK]\b/g;
  let m;
  while ((m = kRe.exec(s)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) amounts.push(Math.round(n * 1000));
  }
  // Bare amounts: $10,000 / $10000 / $10.50 — but skip anything immediately
  // followed by k/K (already captured above) or another digit (part of a longer
  // token like a phone number).
  const rawRe = /\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![kK\d])/g;
  while ((m = rawRe.exec(s)) !== null) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) amounts.push(Math.round(n));
  }
  if (!amounts.length) return null;
  return Math.max(...amounts);
}

// Admin's manual reply from the Delegate window. Sends a threaded email and
// clears the delegation flag. Reuses the same threading as auto-replies.
async function sendDelegateReply(creatorId, { subject, body }) {
  const creator = await loadCreator(creatorId);
  if (!creator) throw new Error('creator not found');
  if (!creator.email) throw new Error('creator has no email');
  const text = String(body || '').trim();
  if (!text) throw new Error('reply body is required');

  const subj = (subject && String(subject).trim()) || templates.reply1(templateVars(ctxFor(creator))).subject;
  await sendNegotiationEmail(creator, { subject: subj, body: text }, 'delegate_reply');

  // Surface the delegate reply on the rate timeline so the dashboard shows we
  // responded to the creator. If the admin typed a dollar amount, treat it as
  // an offer and log 'rate_offer_sent' (with the parsed fee) so it renders as
  // "Offer sent — $X", matching the structured Approve & send flow. Otherwise
  // log 'sent_delegate_reply' so the timeline still shows a "Reply sent" step.
  const fee = extractOfferAmount(text);
  if (fee != null) {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_offer_sent', $2)`,
      [creatorId, { fee, source: 'delegate' }],
    );
    // An offer from the delegate reply should also move the creator into
    // AWAITING_DECISION, matching sendApprovedOffer — but only from stages
    // where quoting a rate is appropriate, so we don't regress ACCEPTED /
    // DECLINED / CLOSED conversations.
    await db.query(
      `UPDATE creators
       SET negotiation_status = 'AWAITING_DECISION', updated_at = NOW()
       WHERE id = $1
         AND (negotiation_status IS NULL
              OR negotiation_status IN ('AWAITING_RATE', 'AWAITING_APPROVAL'))`,
      [creatorId],
    );
  } else {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'sent_delegate_reply', $2)`,
      [creatorId, {}],
    );
  }

  // Learn from the human's answer: label the (creator question → admin reply)
  // pair and add it to the example bank, so the next creator with the same
  // doubt is answered by the model instead of landing in the Delegate queue
  // again. Fire-and-forget — learning must never delay or fail the send.
  // delegate_question was stashed by delegate() before the flags are cleared.
  const delegateQuestion = creator.delegate_question;
  replyLearning
    .learnFromHumanReply({
      creator,
      inbound: delegateQuestion,
      outbound: { subject: subj, body: text },
      stage: creator.negotiation_status || null,
    })
    .catch((err) => console.warn('[negotiation] delegate-reply learning failed:', err.message));

  // Clear the hand-off flags AND consume any inbound that was pending when the
  // admin replied — the manual reply IS our response to it, so the scheduler's
  // negotiation poll must not re-process it and fire a second, automatic reply
  // afterwards. The CASE guard only clears the message we loaded, so a NEWER
  // reply that arrived while this reply was being sent is left for the next tick.
  await db.query(
    `UPDATE creators
     SET needs_human = FALSE, delegate_reason = NULL, delegate_question = NULL,
         latest_inbound_text = CASE
           WHEN latest_inbound_text IS NOT DISTINCT FROM $2 THEN NULL
           ELSE latest_inbound_text END,
         updated_at = NOW()
     WHERE id = $1`,
    [creatorId, creator.latest_inbound_text],
  );
  return { sent: true };
}

// ── Orchestration (called by the scheduler) ───────────────────────────────

// Read the newest inbound message and react to it. Idempotent: a message id
// equal to last_negotiation_msg_id is a no-op. Handles the first reply and all
// subsequent ones. Routes to the human Delegate queue when AI replies are off
// for the creator's template, or when Claude escalates a reply it can't handle.
async function processReply(creatorId) {
  const creator = await loadCreator(creatorId);
  if (!creator) return { skipped: 'no creator' };

  // Reply text is written by the /webhook/instantly handler when Instantly
  // fires a reply_received event. No Gmail polling needed.
  const inbound = creator.latest_inbound_text
    ? { text: creator.latest_inbound_text, messageId: creator.instantly_reply_uuid }
    : null;

  if (!inbound || !inbound.text) return { skipped: 'no inbound text' };

  // Resolve, from THIS inbound: who to greet (the sender may be replying on the
  // creator's behalf) and whether they asked to see references. Computed up
  // front so we can persist the salutation — a later offer email (sent at admin
  // approval, after the inbound text has been consumed) reads it back.
  const salutation = salutationFor(creator.first_name, inbound.text);
  const includeRefs = askedForReferences(inbound.text);

  // Dedup by consuming the text: clear latest_inbound_text once handled so a
  // re-run sees nothing. We deliberately do NOT gate on instantly_reply_uuid —
  // it's a thread handle, stable across replies, so a uuid match would wrongly
  // skip every follow-up reply (counter-offers, acceptances) in the same thread.
  // Persist the detected salutation on the same write so offer emails can greet
  // the right person even after the inbound text is gone.
  const markHandled = () =>
    db.query(
      `UPDATE creators
       SET latest_inbound_text = NULL, last_negotiation_msg_id = $2,
           reply_salutation = $4, updated_at = NOW()
       WHERE id = $1 AND latest_inbound_text IS NOT DISTINCT FROM $3`,
      [creator.id, inbound.messageId || null, inbound.text, salutation],
    );

  // AI off for this template -> always hand the reply to a human.
  if (!(await aiRepliesEnabledForCreator(creator))) {
    console.log(
      `[negotiation] creator ${creator.id}: AI replies disabled on active template, delegating`,
    );
    await delegate(creator, inbound, 'AI replies are turned off for this template');
    await markHandled();
    return { action: 'delegated', reason: 'ai_off' };
  }

  const guidelines = await getGuidelines();
  const ctx = ctxFor(creator, { guidelines, salutation, includeRefs });
  const result = await handleCreatorReply(creator, inbound.text, ctx);
  // Visibility: surface Claude's classification + a snippet of its understanding
  // so it's obvious from Railway logs whether the model is doing the work.
  console.log(
    `[negotiation] creator ${creator.id}: action=${result.action} understanding="${(result.understanding || '').slice(0, 140)}"`,
  );

  // Creator asked US to quote a rate first -> put it in front of the admin as an
  // offer to price & send (the configurator), not a plain reply to write.
  if (result.action === 'request_our_offer') {
    const routed = await routeCreatorToOffer(creator, inbound);
    await markHandled();
    return routed;
  }

  // Claude couldn't confidently handle it -> delegate instead of guessing.
  if (result.action === 'escalate' || result.action === 'other') {
    await delegate(
      creator,
      inbound,
      result.understanding || "Claude wasn't sure how to handle this reply",
    );
    await markHandled();
    return { action: 'delegated', reason: result.action };
  }

  // Never auto-re-send REPLY 1 once the negotiation has moved past its opening.
  // `asking_details` (→ REPLY 1: "here are the details, what's your rate?") is
  // only valid as the FIRST substantive reply, when no negotiation email has
  // gone out yet (negotiation_status IS NULL). If it comes back at any later
  // stage — most importantly AWAITING_DECISION, where an offer is already on the
  // table — it's a misread (Claude, or the heuristic fallback when Claude is
  // down). Re-sending REPLY 1 there duplicates it out of context, which is the
  // "another reply went out and it was the reply 1 email" bug the Delegate
  // offer-approval race produced. Hand it to a human instead of firing the
  // template again.
  if (result.action === 'asking_details' && creator.negotiation_status) {
    console.log(
      `[negotiation] creator ${creator.id}: asking_details returned at stage ${creator.negotiation_status} — delegating instead of re-sending REPLY 1`,
    );
    await delegate(
      creator,
      inbound,
      'A reply after the intro details were already sent looked like a fresh intro — a human should respond so we do not re-send the details email.',
    );
    await markHandled();
    return { action: 'delegated', reason: 'reply1_after_start' };
  }

  // Accepting an offer fires the contract workflow (generate + email the signing
  // link) and can't be quietly undone. It is only meaningful once a priced offer
  // is actually on the table — i.e. at AWAITING_DECISION. If "accepted" comes back
  // at any other stage it's a misread (there is nothing to accept yet, and
  // agreedOfferFee would resolve to null), so hand it to a human instead of
  // firing a contract with no agreed rate.
  if (result.action === 'accepted' && creator.negotiation_status !== 'AWAITING_DECISION') {
    console.log(
      `[negotiation] creator ${creator.id}: accepted returned at stage ${creator.negotiation_status || 'NULL'} — no offer on the table, delegating instead of firing a contract`,
    );
    await delegate(
      creator,
      inbound,
      'A reply looked like an acceptance, but no priced offer has been sent yet — a human should confirm what the creator is agreeing to before any contract goes out.',
    );
    await markHandled();
    return { action: 'delegated', reason: 'accepted_without_offer' };
  }

  await applyReply(creator, ctx, result);
  await markHandled();
  return { action: result.action };
}

// The creator asked us to name a price / make the first offer. Instead of a
// human-written reply, surface the offer configurator for this creator in the
// Delegate page: compute the suggested offers (if not already), move to
// AWAITING_APPROVAL so the offer is approvable/sendable, and clear any hand-off
// flag so no plain reply box is shown. If we have no view stats yet there's no
// basis to price an offer, so fall back to a normal human hand-off.
async function routeCreatorToOffer(creator, inbound) {
  if (!creator.ig_scraped_data) {
    await delegate(
      creator,
      inbound,
      'Creator asked us to make the first offer, but we have no view stats yet — scrape their reels to build an offer, then price & send it.',
    );
    return { action: 'delegated', reason: 'offer_requested_no_stats' };
  }

  let offers = Array.isArray(creator.suggested_offers) ? creator.suggested_offers : null;
  if (!offers || !offers.length) {
    const maxCpm =
      creator.max_cpm != null ? Number(creator.max_cpm) : Number(process.env.TARGET_CPM || 15);
    const quotedRate = creator.quoted_rate != null ? Number(creator.quoted_rate) : null;
    offers = pricing.computeOffers(creator.ig_scraped_data, maxCpm, quotedRate);
  }

  await db.query(
    `UPDATE creators
     SET suggested_offers = $2::jsonb,
         negotiation_status = 'AWAITING_APPROVAL',
         needs_human = FALSE, delegate_reason = NULL, delegate_question = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [creator.id, JSON.stringify(offers)],
  );
  await db.query(
    `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'offer_requested', $2)`,
    [creator.id, { note: 'creator asked us to quote a rate first' }],
  );
  return { action: 'offer_requested' };
}

// The fee of the offer the creator is accepting: the most recent priced offer
// we logged as sent, falling back to the currently approved offer. Used to set
// the agreed rate on acceptance.
async function agreedOfferFee(creator) {
  const ev = await db.one(
    `SELECT detail FROM email_events
     WHERE creator_id = $1 AND type = 'rate_offer_sent'
     ORDER BY created_at DESC LIMIT 1`,
    [creator.id],
  );
  if (ev && ev.detail && ev.detail.fee != null) {
    const n = Number(ev.detail.fee);
    if (Number.isFinite(n)) return Math.round(n);
  }
  const offer = resolveApprovedOffer(creator);
  if (offer && offer.flat_fee != null) {
    const n = Number(offer.flat_fee);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

// Generate the creator's contract and email its signing link. Resilient by
// design: any failure here is logged but never thrown out of applyReply — the
// acceptance is already recorded, and the scheduler's contract backfill
// (pollNegotiations) retries any ACCEPTED creator that has no contract yet.
async function sendContractOnAcceptance(creator, ctx, result) {
  try {
    const { url } = await contracts.createContractForCreator(creator.id);
    const v = templateVars(ctx);
    const email = templates.contractEmail({ ...v, url });
    if (result.send_now !== false) {
      await sendNegotiationEmail(creator, email, 'contract');
    }
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'contract_sent', $2)`,
      [creator.id, { url }],
    );
  } catch (err) {
    console.error(`[contracts] failed to send contract for creator ${creator.id}:`, err.message);
  }
}

// Backfill entry point for the scheduler: generate + email the contract for an
// ACCEPTED creator that doesn't have one yet (e.g. the inline path errored).
// Idempotent — contracts.createContractForCreator reuses any existing contract.
async function ensureContractSent(creatorId) {
  const creator = await loadCreator(creatorId);
  if (!creator) return { skipped: 'no creator' };
  await sendContractOnAcceptance(creator, ctxFor(creator), { send_now: true });
  return { ok: true };
}

// Post-acceptance reply handler (scheduler-callable). A creator who already
// ACCEPTED — the offer is agreed, the contract has been sent, and may already
// be signed — can still reply: a payment question, a scheduling detail, a
// usage-rights objection, a change of heart. The main negotiation loop
// (processReply) only runs for NULL / AWAITING_* stages, so without this those
// replies would sit in latest_inbound_text forever, neither answered nor
// delegated. The contract is done, but the creator is still owed a response.
//
// The rule here is simple and safe: NEVER drop a post-acceptance reply.
//   1. free_only-policy usage-rights dispute  -> amend the unsigned contract +
//      hand to a human (the pre-existing special case).
//   2. a benign factual question we can answer from the templates / campaign
//      context  -> answer it (Claude's conservative "answer_question" path).
//   3. anything else — a payment-structure or contractual question, a dispute,
//      an escalation, an ambiguous message, or AI auto-reply being off — goes
//      to a human via the Delegate queue.
//   4. a trivial acknowledgement that needs no reply ("got it, thanks") is
//      consumed silently.
// Crucially we do NOT run applyReply here: post-acceptance we never re-quote,
// re-send REPLY 1, or regress the negotiation stage — we only answer or delegate.
async function handleAcceptedReply(creatorId) {
  const creator = await loadCreator(creatorId);
  if (!creator) return { skipped: 'no creator' };
  const inbound = creator.latest_inbound_text;
  if (!inbound) return { skipped: 'no inbound text' };

  // Consume the inbound exactly once, whichever branch handles it, so a later
  // scheduler tick never re-processes the same message. Mirrors processReply's
  // markHandled guard: only clears if the text is still the one we read.
  const markHandled = () =>
    db.query(
      `UPDATE creators SET latest_inbound_text = NULL, updated_at = NOW()
       WHERE id = $1 AND latest_inbound_text IS NOT DISTINCT FROM $2`,
      [creator.id, inbound],
    );

  // 1. Usage-rights dispute on a free_only campaign — drop ad rights from the
  //    (unsigned) contract and hand to a human. Usage-rights conversations
  //    always go through a person (same posture as the "escalate" rule during
  //    negotiation), so this is a delegate, never an auto-reply.
  if (
    creator.usage_rights_policy === 'free_only' &&
    (await contracts.disputesUsageRights(inbound))
  ) {
    const updated = await contracts.removeUsageRightsFromContract(creator.id);
    await delegate(
      creator,
      { text: inbound },
      'Creator disputed usage rights after accepting — ad rights have been removed from their (unsigned) contract; a human should confirm with them.',
    );
    await markHandled();
    return { disputed: true, contractUpdated: !!updated };
  }

  // 1b. A material term change after accepting (more videos, a platform added
  //     or dropped, a new deadline, a different rate). Re-sync the contract from
  //     the now-updated thread so the contract link AND the dashboard Deals
  //     column stay truthful, then hand to a human to confirm and re-send. A
  //     SIGNED contract is executed — never auto-changed; we delegate only.
  if (await contracts.changesContractTerms(inbound)) {
    const res = await contracts.updateContractTermsFromThread(creator.id);
    await delegate(
      creator,
      { text: inbound },
      res.updated
        ? 'Creator changed deal terms after accepting — their (unsigned) contract has been re-synced from the thread; a human should confirm the new terms and re-send the contract link.'
        : res.signed
          ? 'Creator changed deal terms after accepting, but their contract is already SIGNED — it was NOT auto-changed; a human must handle this amendment.'
          : 'Creator changed deal terms after accepting — a human should review (no contract on file yet to update).',
    );
    await markHandled();
    return { termsChanged: true, contractUpdated: res.updated, signed: res.signed };
  }

  // AI auto-reply off -> hand every post-acceptance reply to a human.
  if (!(await aiRepliesEnabledForCreator(creator))) {
    await delegate(creator, { text: inbound }, 'AI replies are turned off for this template');
    await markHandled();
    return { action: 'delegated', reason: 'ai_off' };
  }

  // 2/3. Classify the reply. Answer only the benign factual questions Claude is
  //      confident it can answer from the templates / campaign context; send
  //      everything else — payment-structure and contractual questions, disputes,
  //      escalations, ambiguity — to a human so no creator question is dropped.
  const guidelines = await getGuidelines();
  const ctx = ctxFor(creator, {
    guidelines,
    salutation: salutationFor(creator.first_name, inbound),
    includeRefs: askedForReferences(inbound),
  });
  const result = await handleCreatorReply(creator, inbound, ctx);
  console.log(
    `[negotiation] ACCEPTED creator ${creator.id}: post-accept reply action=${result.action}`,
  );

  if (result.action === 'answer_question' && result.email && result.send_now !== false) {
    await sendNegotiationEmail(creator, result.email, 'reply_qa');
    await db.query(`UPDATE creators SET updated_at = NOW() WHERE id = $1`, [creator.id]);
    await markHandled();
    return { action: 'answer_question' };
  }

  // 4. Trivial acknowledgement that needs no reply — consume it, don't bother a human.
  if (result.action === 'other') {
    await markHandled();
    return { action: 'other' };
  }

  await delegate(
    creator,
    { text: inbound },
    result.understanding || 'Creator replied after accepting — needs a human response.',
  );
  await markHandled();
  return { action: 'delegated', reason: result.action };
}

// A creator whose offer is awaiting the admin's approval (AWAITING_APPROVAL)
// replies again. The main negotiation loop (processReply) only runs for
// NULL / AWAITING_RATE / AWAITING_DECISION, so without this the message would
// sit unseen in latest_inbound_text until the admin sent the offer (which
// consumes it) — the reply would never reach the admin. We deliberately do NOT
// auto-reply at this stage (a human is in the loop, shaping the offer); instead
// we SURFACE the message in the Delegate window by flagging it as a hand-off,
// right next to the offer configurator. The admin can then answer it (a delegate
// reply) or just send the offer. Idempotent per message: we consume the inbound
// we surfaced, so a later tick doesn't re-flag the same one — each new reply is
// surfaced exactly once, and the newest one is what the admin sees.
async function surfaceApprovalReply(creatorId) {
  const creator = await loadCreator(creatorId);
  if (!creator) return { skipped: 'no creator' };
  if (creator.negotiation_status !== 'AWAITING_APPROVAL') return { skipped: 'stage' };
  const inbound = creator.latest_inbound_text;
  if (!inbound) return { skipped: 'no inbound text' };

  await delegate(
    creator,
    { text: inbound },
    'Creator replied while their offer was awaiting your approval — read their message, then answer it or send the offer.',
  );
  // Consume the message we just surfaced (guard on the exact text so a newer
  // reply that arrived mid-run is left for the next tick to surface).
  await db.query(
    `UPDATE creators SET latest_inbound_text = NULL, updated_at = NOW()
     WHERE id = $1 AND latest_inbound_text IS NOT DISTINCT FROM $2`,
    [creatorId, inbound],
  );
  return { action: 'surfaced' };
}

async function applyReply(creator, ctx, result) {
  const v = templateVars(ctx);
  switch (result.action) {
    case 'shared_rate':
    case 'counter': {
      const rate = result.quoted_rate;
      let offers = null;
      const stats = creator.ig_scraped_data;
      if (rate != null && stats) {
        offers = pricing.computeOffers(stats, ctx.maxCpm, Number(rate));
      }
      // Every rate the creator quoted in THIS reply. When they only stated one,
      // we still store a single-option array so the dashboard has a uniform
      // shape; overwriting on each new reply means the latest set wins (a
      // counter with fresh numbers replaces stale tiered pricing).
      let rateOptions = Array.isArray(result.quoted_rate_options) ? result.quoted_rate_options : null;
      if (!rateOptions && rate != null) {
        rateOptions = [{ amount: Number(rate), label: `$${Number(rate).toLocaleString('en-US')}` }];
      }
      await db.query(
        `UPDATE creators
         SET quoted_rate = COALESCE($2, quoted_rate),
             quoted_rate_options = COALESCE($3::jsonb, quoted_rate_options),
             suggested_offers = COALESCE($4::jsonb, suggested_offers),
             negotiation_status = 'AWAITING_APPROVAL',
             updated_at = NOW()
         WHERE id = $1`,
        [
          creator.id,
          rate != null ? rate : null,
          rateOptions ? JSON.stringify(rateOptions) : null,
          offers ? JSON.stringify(offers) : null,
        ],
      );
      // Timeline entry: the creator named/changed a rate (NUMERIC -> string in pg).
      if (rate != null) {
        const prevRate = creator.quoted_rate != null ? Number(creator.quoted_rate) : null;
        await db.query(
          `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_quoted', $2)`,
          [creator.id, { from: prevRate, to: Number(rate), by: 'creator', options: rateOptions || null }],
        );
      }
      return;
    }
    case 'accepted': {
      // The agreed rate is now the offer the creator accepted, not their earlier
      // quote — overwrite quoted_rate so the dashboard's Rate column reflects the
      // final agreed amount. COALESCE guards the rare case with no priced offer.
      const agreedFee = await agreedOfferFee(creator);
      await db.query(
        `UPDATE creators
         SET negotiation_status = 'ACCEPTED',
             quoted_rate = COALESCE($2, quoted_rate),
             updated_at = NOW()
         WHERE id = $1`,
        [creator.id, agreedFee],
      );
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_accepted', $2)`,
        [creator.id, { fee: agreedFee }],
      );
      // Acceptance kicks off the contract workflow: generate the unique contract
      // and email its signing link. This replaces the plain acceptance email —
      // the contract email IS the warm acceptance + link.
      await sendContractOnAcceptance(creator, ctx, result);
      return;
    }
    case 'declined': {
      if (result.send_now) await sendNegotiationEmail(creator, result.email || templates.declineDelay(v), 'decline');
      await db.query(
        `UPDATE creators SET negotiation_status = 'DECLINED', updated_at = NOW() WHERE id = $1`,
        [creator.id],
      );
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_declined', $2)`,
        [creator.id, {}],
      );
      return;
    }
    case 'request_counter_rate': {
      // Creator pushed back on the offer without naming a number. Send our
      // "what rate would work for you?" reply, move to AWAITING_RATE so the
      // dashboard shows we're waiting on their counter, and log the request
      // on the rate timeline so the admin sees the negotiation re-opened.
      const email = result.email || templates.reply1(v, { includeRefs: ctx.includeRefs, includeUsageRights: includeUsageRightsFor(ctx) });
      if (result.send_now !== false) {
        await sendNegotiationEmail(creator, email, 'request_counter_rate');
      }
      await db.query(
        `UPDATE creators SET negotiation_status = 'AWAITING_RATE', updated_at = NOW() WHERE id = $1`,
        [creator.id],
      );
      await db.query(
        `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_counter_requested', $2)`,
        [creator.id, {}],
      );
      return;
    }
    case 'answer_question': {
      // Direct factual answer about an already-discussed deal. Send the reply
      // Claude wrote, and PRESERVE the existing negotiation stage — asking a
      // clarifying question shouldn't regress AWAITING_DECISION back to
      // AWAITING_RATE. Only set AWAITING_RATE if there's no stage yet.
      const email = result.email || templates.reply1(v, { includeRefs: ctx.includeRefs, includeUsageRights: includeUsageRightsFor(ctx) });
      if (result.send_now !== false) {
        await sendNegotiationEmail(creator, email, 'reply_qa');
      }
      if (!creator.negotiation_status) {
        await db.query(
          `UPDATE creators SET negotiation_status = 'AWAITING_RATE', updated_at = NOW() WHERE id = $1`,
          [creator.id],
        );
      } else {
        await db.query(
          `UPDATE creators SET updated_at = NOW() WHERE id = $1`,
          [creator.id],
        );
      }
      return;
    }
    default: {
      // asking_details / other
      const email = result.email || templates.reply1(v, { includeRefs: ctx.includeRefs, includeUsageRights: includeUsageRightsFor(ctx) });
      if (result.send_now !== false) {
        await sendNegotiationEmail(creator, email, result.action === 'other' ? 'reply' : 'reply1');
      }
      // 'other' keeps the existing stage if there is one; otherwise wait for a rate.
      const nextStatus =
        result.action === 'other' && creator.negotiation_status ? creator.negotiation_status : 'AWAITING_RATE';
      await db.query(
        `UPDATE creators SET negotiation_status = $2, updated_at = NOW() WHERE id = $1`,
        [creator.id, nextStatus],
      );
    }
  }
}

function resolveApprovedOffer(creator) {
  if (creator.custom_offer && typeof creator.custom_offer === 'object') return creator.custom_offer;
  const offers = Array.isArray(creator.suggested_offers) ? creator.suggested_offers : [];
  if (creator.selected_offer_id) {
    const f = offers.find((o) => o.offer_id === creator.selected_offer_id);
    if (f) return f;
  }
  return offers[0] || null;
}

// Send the admin-approved offer email -> AWAITING_DECISION. This runs ONLY in
// response to an admin approving an offer in the dashboard (the /offer route);
// nothing sends offers automatically. The atomic claim guards against a
// double-send if the admin double-clicks. `fromStages` limits which negotiation
// stages can send: AWAITING_APPROVAL (the canonical case) plus AWAITING_RATE
// (so the admin can proactively send an offer to an engaged creator who hasn't
// named a rate yet). An outreach thread is required so the offer goes out as a
// threaded reply, never a cold email before the intro outreach.
async function sendApprovedOffer(creatorId, { fromStages = ['AWAITING_APPROVAL'] } = {}) {
  const stagePlaceholders = fromStages.map((_, i) => `$${i + 2}`).join(', ');
  const claim = await db.one(
    `UPDATE creators SET negotiation_status = 'AWAITING_DECISION', updated_at = NOW()
     WHERE id = $1 AND offer_approved = TRUE
       AND instantly_reply_uuid IS NOT NULL
       AND negotiation_status IN (${stagePlaceholders})
     RETURNING id`,
    [creatorId, ...fromStages],
  );
  if (!claim) {
    const c = await db.one(
      `SELECT instantly_reply_uuid, negotiation_status FROM creators WHERE id = $1`,
      [creatorId],
    );
    if (!c) return { skipped: 'creator not found' };
    if (!c.instantly_reply_uuid) {
      return { skipped: 'no reply received yet — wait for the creator to reply before sending an offer' };
    }
    return {
      skipped: `creator is not awaiting an offer (stage: ${
        c.negotiation_status ? c.negotiation_status.replace(/_/g, ' ').toLowerCase() : 'no reply yet'
      })`,
    };
  }

  const creator = await loadCreator(creatorId);
  const offer = resolveApprovedOffer(creator);
  if (!offer) {
    await db.query(
      `UPDATE creators SET negotiation_status = 'AWAITING_APPROVAL', updated_at = NOW() WHERE id = $1`,
      [creatorId],
    );
    return { error: 'no offer to send' };
  }

  const guidelines = await getGuidelines();
  // Greet whoever's been corresponding (a manager may have shared the rate on
  // the creator's behalf). The reply salutation was persisted when the rate
  // came in; fall back to re-parsing any still-present inbound, then the name.
  const salutation =
    creator.reply_salutation || salutationFor(creator.first_name, creator.latest_inbound_text);
  const ctx = ctxFor(creator, { approvedOffer: offer, guidelines, salutation });
  const combine = (await countSentNegotiation(creatorId)) === 0;

  // Draft is fully reversible — a Claude failure here left NO email in-flight,
  // so we can safely roll the atomic-claim back to AWAITING_APPROVAL and let
  // the admin retry.
  let email;
  try {
    email = await draftOfferEmail(creator, offer, ctx, { combine });
  } catch (err) {
    await db.query(
      `UPDATE creators SET negotiation_status = 'AWAITING_APPROVAL', updated_at = NOW() WHERE id = $1`,
      [creatorId],
    );
    console.error(`[negotiation] draftOfferEmail failed for creator ${creatorId}:`, err.message);
    throw err;
  }

  // ⚠ Past this point we DO NOT roll the stage back on failure. The moment
  // sendNegotiationEmail starts, the email is either in-flight to Instantly
  // or already delivered — even if we hit a network timeout / DB write error
  // afterwards. Rolling back to AWAITING_APPROVAL would let the admin's next
  // click re-fire the send and put a DUPLICATE offer email in the creator's
  // inbox. Instead we leave the stage at AWAITING_DECISION (send was
  // attempted) and surface the error so the admin sees "check the mailbox
  // and only re-send if the creator did NOT receive the offer".
  await sendNegotiationEmail(creator, email, 'offer');
  // Sending the offer resolves this creator's turn in the Delegate window:
  //   - Clear any hand-off flags (needs_human / delegate_*) — a reply the creator
  //     sent while the offer was awaiting approval is surfaced there as a hand-off
  //     (see surfaceApprovalReply); sending the offer is the admin acting on it,
  //     so the creator should drop out of the window cleanly.
  //   - Consume any still-pending inbound (guarded on the value we loaded) so the
  //     scheduler's poll — which now sees this creator at AWAITING_DECISION —
  //     doesn't re-process it and fire an automatic reply (e.g. a duplicate
  //     REPLY 1) on top of the offer. A NEWER reply that arrived while the offer
  //     was being drafted/sent is left in place to be handled as a real
  //     post-offer reply.
  // Best-effort: the offer is already sent, so a failure here must not surface as
  // a send error.
  try {
    await db.query(
      `UPDATE creators
       SET needs_human = FALSE, delegate_reason = NULL, delegate_question = NULL,
           latest_inbound_text = CASE
             WHEN latest_inbound_text IS NOT DISTINCT FROM $2 THEN NULL
             ELSE latest_inbound_text END,
           updated_at = NOW()
       WHERE id = $1`,
      [creatorId, creator.latest_inbound_text],
    );
  } catch (clrErr) {
    console.error(
      `[negotiation] post-offer cleanup (flags/inbound) failed for creator ${creatorId} (offer already sent):`,
      clrErr.message,
    );
  }
  // Timeline entry for the Rate column: the priced offer we sent. Kept
  // separate from the 'sent_negotiation' email event (which the thread view
  // uses) so the rate timeline can show the fee/CPM without the email body.
  // Best-effort — if the log INSERT fails we already sent the email, so DO
  // NOT roll the stage back; just record the error and keep AWAITING_DECISION.
  try {
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'rate_offer_sent', $2)`,
      [creatorId, { fee: offer.flat_fee, cpm: offer.cpm_applied, label: offer.label }],
    );
  } catch (logErr) {
    console.error(
      `[negotiation] rate_offer_sent log failed for creator ${creatorId} (email already sent):`,
      logErr.message,
    );
  }
  return { sent: true };
}

// Idle follow-up: bump once, up to NEGOTIATION_MAX_FOLLOWUPS, then CLOSED.
async function runNegotiationFollowup(creatorId) {
  const creator = await loadCreator(creatorId);
  if (!creator) return { skipped: 'gone' };
  if (!['AWAITING_RATE', 'AWAITING_DECISION'].includes(creator.negotiation_status)) {
    return { skipped: 'stage' };
  }
  // A follow-up is a nudge for a SILENT creator — "did you get a chance to check
  // my last email?". It must NEVER go out to a creator who has already replied.
  // Two ways that can be true:
  //   1. A reply is sitting unprocessed in latest_inbound_text (the scheduler
  //      hasn't classified it yet), or
  //   2. The creator's most recent reply is newer than our last outbound
  //      negotiation email — i.e. the ball is in OUR court, not theirs.
  // Either way, bail WITHOUT sending or bumping the counter (which would also
  // eventually close the conversation out on a creator who is actually engaged).
  // This is the exact mistake we're guarding against: a nudge firing — and
  // re-firing — after the rate had already been agreed in a prior reply.
  if (creator.latest_inbound_text) return { skipped: 'pending_reply' };
  const repliedAt = creator.replied_at ? new Date(creator.replied_at).getTime() : null;
  const lastEmailAt = creator.last_negotiation_email_at
    ? new Date(creator.last_negotiation_email_at).getTime()
    : null;
  if (repliedAt != null && (lastEmailAt == null || repliedAt > lastEmailAt)) {
    return { skipped: 'creator_replied' };
  }
  const max = Number(process.env.NEGOTIATION_MAX_FOLLOWUPS || 2);
  const count = creator.negotiation_followup_count || 0;
  if (count >= max) {
    await db.query(
      `UPDATE creators SET negotiation_status = 'CLOSED', updated_at = NOW() WHERE id = $1`,
      [creatorId],
    );
    await db.query(
      `INSERT INTO email_events (creator_id, type, detail) VALUES ($1, 'negotiation_closed', $2)`,
      [creatorId, { reason: 'max_followups' }],
    );
    return { closed: true };
  }
  const ctx = ctxFor(creator);
  const v = templateVars(ctx);
  const awaitingRate = creator.negotiation_status === 'AWAITING_RATE';
  const email = awaitingRate ? templates.followup1(v) : templates.followup2(v);
  await sendNegotiationEmail(creator, email, awaitingRate ? 'followup1' : 'followup2');
  await db.query(
    `UPDATE creators SET negotiation_followup_count = COALESCE(negotiation_followup_count, 0) + 1, updated_at = NOW() WHERE id = $1`,
    [creatorId],
  );
  return { sent: true, step: count + 1 };
}

module.exports = {
  handleCreatorReply,
  draftOfferEmail,
  processReply,
  sendApprovedOffer,
  sendDelegateReply,
  ensureContractSent,
  handleAcceptedReply,
  surfaceApprovalReply,
  runNegotiationFollowup,
  resolveApprovedOffer,
  aiRepliesEnabledForCreator,
  loadCreator,
  ctxFor,
  salutationFor,
  detectSenderName,
  askedForReferences,
  extractOfferAmount,
  parseRateOptionsFromText,
  asksUsToQuoteFirst,
  // Test-only.
  _setClient,
};
