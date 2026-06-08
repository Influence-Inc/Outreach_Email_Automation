'use strict';

// Canonical negotiation email copy (verbatim from the old system), plus
// deterministic builders. Claude *adapts* these templates; the builders are
// also the no-API-key / DRY_RUN fallback so the feature works without Claude.

const REFERENCE_ACCOUNTS =
  '@danyel.design (300k+), @buttered_official (100k), @ty200641 (100k+), ' +
  '@thedesignely (200k+), @moonsol.design (400k+), @clovr.guy (4.8M+)';

function defaults() {
  return {
    managerName: process.env.MANAGER_NAME || process.env.SENDER_NAME || 'Jennifer',
    refs: REFERENCE_ACCOUNTS,
    cadence: process.env.CONTENT_CADENCE || process.env.CAMPAIGN_DEADLINE || '1-2 videos per week',
    brandName: process.env.BRAND_NAME || 'the brand',
  };
}

// Approximate "all videos posted by" date derived from the posting cadence and
// the number of videos. Uses the slower bound of the cadence (more time for the
// creator) plus a small buffer. This is the deterministic fallback; when Claude
// is available it computes the date itself from today's date.
function approxDeadline(numVideos, cadence) {
  const nums = (String(cadence || '').match(/\d+/g) || []).map(Number);
  const perWeek = nums.length ? Math.max(1, Math.min(...nums)) : 1;
  const videos = Math.max(1, Number(numVideos) || 2);
  const weeks = Math.max(1, Math.ceil(videos / perWeek));
  const d = new Date(Date.now() + (weeks * 7 + 3) * 24 * 3600 * 1000);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// Only replace placeholders the caller actually defined; leave unknown {x} intact.
function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] == null ? '' : vars[key]) : m,
  );
}

function withDefaults(vars) {
  return { ...defaults(), firstName: 'there', ...vars };
}

// ── Reply 1 — details + ask for rate ──────────────────────────────────────
const REPLY1_SUBJECT = 'Re: {brandName} x {firstName} Collaboration';
const REPLY1_BODY = `Hi {firstName},

So great to hear from you! Here are all the details:

Content Style
We'd love the content to be in your natural style, with {brandName} integrated effortlessly. Nothing overly promotional. Full creative freedom on your end.

Deliverables & Rates
- Depending on your rate, we'd love to do a 2 or more video package deal.
- We're keen on exploring a long-term retainer deal. These initial videos would act as a test run, and if things go well, this could turn into a guaranteed monthly brand deal!
- Additionally, through INFLUENCE, we aim to bring you consistent deal flow from other brands we work with.

Platforms
We'd like the content to be posted on Instagram primarily, and cross-posted on TikTok & YouTube Shorts.

Timelines
We're flexible, but we'd love a steady pace of around {cadence}, with all videos ideally posted by {deadline}.

Past content references
{refs}

If everything sounds good, please let me know your rates :)

- {managerName}`;

function reply1(vars) {
  const v = withDefaults(vars);
  // Reply 1 pitches a "2 or more video package"; estimate from 2 videos.
  v.deadline = approxDeadline(2, v.cadence);
  return { subject: fill(REPLY1_SUBJECT, v), body: fill(REPLY1_BODY, v) };
}

// ── Reply 2 — canonical two-option proposal (used as Claude context) ───────
const REPLY2_BODY = `Hi {firstName},

Thanks for sharing your rates!

We usually do performance-based deals with all our creators. We'd love to propose a slightly different view based offer:

Option 1: Flat Rate + Bonus (\${flat_rate})
- \${flat_rate} flat for {video_count} videos
- \${flat_bonus_amount} bonus if the combined views cross {flat_bonus_threshold_views} on Instagram

Option 2: View-Based Offer (\${flat_total})
- \${view_based_rate} for a minimum of {view_target} combined total views on Instagram.
- Views can come from a single video or multiple posts - combined total views will be counted. So if the first video ends up crossing {view_target_x2} views, you don't have to upload further videos!
- Views counted for 7 days from each post's publish date.
- Considering your recent performance, I'd anticipate you can easily cross the {view_target} view goal with {video_count} posts.
- Full creative freedom, so you can create engaging content around {brandName} without it feeling like an ad!
- You can commit to fewer views if you'd like, or higher views with payment adjusted accordingly.
- No ad rights or exclusivity required.

Payment details
We do direct bank transfers. Payment will be initiated within 7 working days of completing and posting all the agreed deliverables!

Would love to work together and land on something that works well for both sides! Let me know your thoughts :)

- {managerName}`;

const PAYMENT_AND_CLOSE = `Payment details
We do direct bank transfers. Payment will be initiated within 7 working days of completing and posting all the agreed deliverables!

Would love to work together and land on something that works well for both sides! Let me know your thoughts :)

- {managerName}`;

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const fmtMoney = (n) => fmtNum(Math.round(Number(n || 0)));

// The headline lines describing a single admin-approved offer.
function describeOffer(offer, brandName) {
  if (!offer) return '';
  if (offer.offer_type === 'view_based') {
    const views = Number(offer.view_guarantee || 0);
    return (
      `We usually do performance-based deals with all our creators. We'd love to propose a view-based offer:\n\n` +
      `$${fmtMoney(offer.flat_fee)} for a minimum of ${fmtNum(views)} combined total views on Instagram.\n` +
      `- Views can come from a single video or multiple posts — combined total views will be counted. ` +
      `So if the first video ends up crossing ${fmtNum(views * 2)} views, you don't have to upload further videos!\n` +
      `- Views counted for 7 days from each post's publish date.\n` +
      `- Full creative freedom, so you can create engaging content around ${brandName} without it feeling like an ad!\n` +
      `- You can commit to fewer views if you'd like, or higher views with payment adjusted accordingly.\n` +
      `- No ad rights or exclusivity required.`
    );
  }
  // video_based / flat
  const n = Number(offer.num_videos || 1);
  const per = offer.flat_per_video != null ? offer.flat_per_video : Math.round(Number(offer.flat_fee) / n);
  return (
    `We usually do performance-based deals with all our creators. We'd love to propose a flat package:\n\n` +
    `${n} video package ($${fmtMoney(offer.flat_fee)}) — $${fmtMoney(per)} per video.\n` +
    `- Full creative freedom, so you can create engaging content around ${brandName} without it feeling like an ad!\n` +
    `- We're keen to turn this into a longer-term retainer if the first videos go well.\n` +
    `- No ad rights or exclusivity required.`
  );
}

// Deterministic single-offer email built from the approved offer. When
// `combine` is true (rate arrived in the creator's first reply), prepend the
// Reply 1 details so the one email covers both.
function offerEmail(offer, vars, { combine = false } = {}) {
  const v = withDefaults(vars);
  const videos = offer && offer.offer_type !== 'view_based' ? Number(offer.num_videos || 2) : 2;
  v.deadline = approxDeadline(videos, v.cadence);
  const lead = combine
    ? fill(REPLY1_BODY, v).replace(/\n\nIf everything sounds good[\s\S]*$/, '\n')
    : `Hi ${v.firstName},\n\nThanks for sharing your rates!\n`;
  const body = `${lead}\n${describeOffer(offer, v.brandName)}\n\n${fill(PAYMENT_AND_CLOSE, v)}`;
  const subject = fill(REPLY1_SUBJECT, v);
  return { subject, body };
}

// ── Short fixed emails ────────────────────────────────────────────────────
function followup1(vars) {
  const v = withDefaults(vars);
  return {
    subject: fill(REPLY1_SUBJECT, v),
    body: `Hi ${v.firstName}, Did you get a chance to check my last email? Please let me know your rate! Would love to collaborate. :) - ${v.managerName}`,
  };
}

function followup2(vars) {
  const v = withDefaults(vars);
  return {
    subject: fill(REPLY1_SUBJECT, v),
    body: `Hi ${v.firstName}, Did you get a chance to check my last email? Looking fwd to hearing your thoughts! We'd love to collab with you. :) - ${v.managerName}`,
  };
}

function acceptance(vars) {
  const v = withDefaults(vars);
  return {
    subject: fill(REPLY1_SUBJECT, v),
    body: `Hi ${v.firstName}, That's wonderful news — we're excited to work with you! I'll be in touch shortly with the next steps. - ${v.managerName}`,
  };
}

function declineDelay(vars) {
  const v = withDefaults(vars);
  return {
    subject: fill(REPLY1_SUBJECT, v),
    body: `Hi ${v.firstName}, Thanks for getting back to me. We're making a few strategic changes to our upcoming campaigns, so I'll reach out again soon! :) - ${v.managerName}`,
  };
}

module.exports = {
  defaults,
  fill,
  reply1,
  offerEmail,
  describeOffer,
  followup1,
  followup2,
  acceptance,
  declineDelay,
  // Raw template strings (canonical content fed to Claude).
  REPLY1_SUBJECT,
  REPLY1_BODY,
  REPLY2_BODY,
  REFERENCE_ACCOUNTS,
};
