'use strict';

// Copy for the campaign-update lane — every WhatsApp message a creator receives
// AFTER they sign, from the first "hi" through to "you're all done".
//
// Kept apart from replies.js (which is the offer-portal negotiation's voice:
// pitching, pricing, closing) because these are a different kind of message to a
// different person. The creator here has already said yes and signed; they are
// now a collaborator waiting on their brief and their approval, and the copy is
// service updates, not persuasion. Nothing in this file asks for a decision.
//
// House rules for everything below:
//   • One update per message. A creator glancing at a notification should be
//     able to act on it without scrolling.
//   • Only the FIRST message of a conversation greets ("Hi Sam, Jennifer here").
//     Every later update is a message in a thread that is already open, and
//     re-introducing ourselves on each one reads like a broken mail merge — the
//     same rule the offer-portal copy follows.
//   • Links are written out in full. These bodies double as the row stored in
//     creator_updates.body and as the fallback whenever the message can't go out
//     as a tappable button, so a link that only exists on a button would leave
//     the history — and the Twilio path — with no link at all.

// The one-time opener. Sent when a signed creator makes first contact — usually
// the "Hi" we asked for. It does two things and stops: says who we are, and sets
// the expectation that this thread is where their campaign updates will arrive,
// so the unprompted messages that follow over the coming weeks are ones they
// agreed to receive rather than ones that appear out of nowhere.
function introMessage({ firstName, brandName }) {
  const brand = brandName ? ` for the ${brandName} campaign` : '';
  return (
    `Hi ${firstName}, great to have you onboard${brand}!\n\n` +
    `This chat is where everything happens: your content brief, updates when your ` +
    `draft is reviewed, and anything the brand needs from you.`
  );
}

// The ask that opens the 24h window. Sent to a creator who has just signed but
// has never messaged us, over whichever route can reach them (an approved
// template on WhatsApp, or email). Its ONLY job is to get an inbound message
// back — that inbound is what makes every later free-form update legal to send —
// so it asks for one word and gives a reason to send it.
function hiRequestMessage({ firstName, brandName }) {
  const brand = brandName || 'your campaign';
  return (
    `Hi ${firstName}, congratulations on signing for ${brand}!\n\n` +
    `We'll be sending your brief and all your campaign updates over WhatsApp. ` +
    `Just reply "Hi" to this message so we can start sending them through.`
  );
}

// The email version of the same ask, for a creator we have no WhatsApp route to
// yet (no approved template, or the provider can't start conversations). Carries
// the wa.me deep link so replying is one tap rather than a copied number.
function hiRequestEmail({ firstName, brandName, whatsappLink, whatsappNumber }) {
  const brand = brandName || 'your campaign';
  const subject = `Quick one - campaign updates for ${brand} on WhatsApp`;
  const link = whatsappLink
    ? `\n\nTap here to open the chat: ${whatsappLink}`
    : whatsappNumber
      ? `\n\nSave our number and send us a "Hi": ${whatsappNumber}`
      : '';
  const body =
    `Hi ${firstName},\n\n` +
    `Congratulations on signing for ${brand} - we're really glad to have you.\n\n` +
    `From here we'll send your content brief and every campaign update (draft reviews, ` +
    `brand feedback, approvals) over WhatsApp so nothing gets lost in your inbox. ` +
    `Send us a "Hi" on WhatsApp and we'll start sending them through.${link}`;
  return { subject, body };
}

// --- The updates themselves ------------------------------------------------

// The creator's personalised content brief is live. The single most useful
// message on this lane — it's the one they're actually waiting for after
// signing — so it leads with the link and says nothing else.
function briefReady({ brandName, briefUrl }) {
  return `Your ${brandName} content brief is ready — everything you need for the shoot is in here: ${briefUrl}`;
}

// Their draft reached us. A receipt, not a request: it closes the loop on an
// upload the creator has no other confirmation of, and sets the expectation for
// the approval/feedback message that follows.
function reviewSubmitted({ brandName }) {
  return (
    `Got your draft for ${brandName} — it's with the brand for review now. ` +
    `We'll let you know here as soon as they come back on it.`
  );
}

// Approved. The creator's next action is to post and then submit the live link,
// so the message names that next step and carries the link to do it where we
// have one.
function reviewApproved({ brandName, submitPostsUrl }) {
  const next = submitPostsUrl
    ? `\n\nOnce it's live, drop the post link(s) here so we can track it: ${submitPostsUrl}`
    : `\n\nOnce it's live, send us the post link(s) so we can track it.`;
  return `Great news — your ${brandName} draft has been approved! You're clear to post.${next}`;
}

// Feedback from the brand or the INFLUENCE team, relayed out of the review chat
// space. The feedback text itself is quoted verbatim rather than summarised —
// a paraphrase of a change request is how a re-shoot gets shot wrong — and the
// chat link is included so the creator can reply in the thread the reviewer is
// actually watching.
function reviewFeedback({ brandName, senderName, feedback, chatUrl }) {
  const who = senderName ? `${senderName}` : `the ${brandName} team`;
  const quoted = String(feedback || '').trim();
  const parts = [`New feedback on your ${brandName} draft from ${who}:`];
  if (quoted) parts.push(`\n"${quoted}"`);
  parts.push(
    chatUrl
      ? `\nYou can reply to them directly here: ${chatUrl}`
      : `\nReply here and I'll pass it straight back to them.`,
  );
  return parts.join('\n');
}

// A live post link landed. Same receipt logic as reviewSubmitted: the creator
// submitted something into a form and otherwise hears nothing back.
function postSubmitted({ brandName, postUrl }) {
  const link = postUrl ? `\n\n${postUrl}` : '';
  return (
    `Post link received for ${brandName} - thanks! ` +
    `We're tracking its views and engagement from here, so there's nothing else you need to do on it.${link}`
  );
}

// All deliverables met. The end of the campaign, and — deliberately — not the
// end of the conversation: the closing line is what makes the creator's
// continued subscription something they were told about rather than something
// that just happens to them (see creatorUpdates.onDeliverablesComplete).
function deliverablesComplete({ brandName }) {
  return (
    `🎉 That's a wrap on ${brandName}! All your deliverables are marked complete.\n\n` +
    `Payment will be processed per your contract - nothing more needed from you.\n\n` +
    `This chat stays open: you'll hear from INFLUENCE here whenever a new campaign fits ` +
    `your profile. Thanks for the great work! 👋`
  );
}

// The re-engagement message for a graduated creator when a new campaign comes
// up. The point of keeping the subscription alive: the next campaign opens in a
// thread they already know, instead of a cold email to an address they may not
// read.
function nextCampaignOutreach({ firstName, brandName, blurb }) {
  const pitch = String(blurb || '').trim();
  const opener = `Hi ${firstName}, a new ${brandName} campaign just opened up - and you're a match for it.`;
  return pitch ? `${opener}\n\n${pitch}` : opener;
}

// A creator writes in mid-campaign with something the bot can't action. We don't
// guess at an answer about someone's brief, deadline or payment — the reply
// says a human has it, and the message is flagged for review in the dashboard.
function ackMessage({ firstName }) {
  return (
    `Thanks ${firstName} — got your message. Someone from the team will come back to you ` +
    `here shortly.`
  );
}

// Pre-deadline reminder. The WhatsApp equivalent of the same reminder
// influence-stats sends by email — softer copy that suits chat, and shorter
// so it reads at a glance. `reminderType` is either "3_days" or "1_day"
// (matches influence_bot's chase_ladder tiers); `daysLeft` is the raw
// number for a fallback line when the tier is unknown.
function deadlineReminder({ firstName, brandName, reminderType, daysLeft, deadline }) {
  const brand = brandName ? ` for ${brandName}` : '';
  const dl = deadline ? ` (${deadline})` : '';
  if (reminderType === '1_day') {
    return (
      `Hi ${firstName} — a quick heads-up: your posting deadline${brand} is TOMORROW${dl}. ` +
      `Let us know if there's anything holding you up on the post going live.`
    );
  }
  if (reminderType === '3_days') {
    return (
      `Hi ${firstName} — just a friendly nudge: you have 3 days left to post${brand}${dl}. ` +
      `Reply here if you need anything to get the post over the line.`
    );
  }
  // Generic fallback for any tier we don't have a specialised body for.
  const left = Number.isFinite(Number(daysLeft)) ? Number(daysLeft) : null;
  const window = left != null ? `${left} day${left === 1 ? '' : 's'} left` : 'coming up';
  return (
    `Hi ${firstName} — a nudge on your posting deadline${brand}${dl}: ${window}. ` +
    `Let us know if you need anything to get the post live in time.`
  );
}

// Post-deadline chase. The deadline has already passed — copy stays friendly
// but names the miss. `daysOverdue` lets the copy escalate; the actual rung
// selection (when to send, how far apart) lives on influence_bot's chase
// ladder, not here — we only render what we're told to send.
function deadlineOverdue({ firstName, brandName, daysOverdue }) {
  const brand = brandName ? ` for ${brandName}` : '';
  const n = Number(daysOverdue);
  const overdue = Number.isFinite(n) && n > 0 ? ` (${n} day${n === 1 ? '' : 's'} past)` : '';
  return (
    `Hi ${firstName} — your posting deadline${brand} passed${overdue}. ` +
    `Reply here if anything's blocking you and we'll sort it out together.`
  );
}

module.exports = {
  introMessage,
  hiRequestMessage,
  hiRequestEmail,
  briefReady,
  reviewSubmitted,
  reviewApproved,
  reviewFeedback,
  postSubmitted,
  deliverablesComplete,
  nextCampaignOutreach,
  ackMessage,
  deadlineReminder,
  deadlineOverdue,
};
