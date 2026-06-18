const SENDER_NAME = process.env.SENDER_NAME || 'Jennifer';

// Subject includes {firstName} so the rendered subject differs for every
// recipient — sidesteps the same-subject bulk-mail fingerprint at Gmail/
// Outlook. Avoids the word "paid" in the subject (a soft promotional
// trigger); the commercial nature is still made clear in the body.
const OUTREACH_SUBJECT = '{firstName} — collab idea from useinfluence.xyz';

const OUTREACH_BODY = `Hi {firstName},

I'm ${SENDER_NAME} from Influence (useinfluence.xyz). I came across your Instagram and loved your content - the way you connect with your audience really stood out.

We're putting together a paid campaign for {brandName} and would love to bring you on board as one of the featured creators.

If this sounds interesting, I'd be happy to share the campaign brief, deliverables, and rates. Could you let me know if you're open to it?

Best,
${SENDER_NAME}
useinfluence.xyz`;

const FOLLOWUP_SUBJECT = 'Re: {firstName} — collab idea from useinfluence.xyz';

const FOLLOWUP_BODY = `Hi {firstName},

Just bumping this up in case it got buried. We're still looking to lock in creators for the {brandName} campaign and you'd be a great fit.

Happy to send over the brief and rates whenever works for you - even a quick yes/no helps me plan.

Best,
${SENDER_NAME}
useinfluence.xyz`;

// Appended at render time when an unsubscribeUrl is supplied.
// {{grey}}...{{/grey}} is rendered as small grey text in HTML and stripped
// to plain text by richBody.js — keeps the visible email focused while
// still being CAN-SPAM/PECR-compliant.
const UNSUB_FOOTER =
  `\n\n{{grey}}You're getting this because we found your contact on your public Instagram. ` +
  `Not interested? [Unsubscribe]({unsubscribeUrl}) and I won't follow up.{{/grey}}`;

// Only substitute placeholders that the caller actually defined. Unknown
// {...} sequences (e.g. {{grey}} markers used by the rich-body renderer
// downstream) are left intact instead of being replaced with empty strings.
function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key)
      ? String(vars[key] == null ? '' : vars[key])
      : match,
  );
}

// `template` is an email_templates row (or null). Renders the outreach email,
// substituting variables. Falls back to hardcoded defaults if the template
// doesn't define them. When `unsubscribeUrl` is supplied in vars, an
// unsubscribe footer is appended to the body.
function renderOutreach(template, vars) {
  const tpl = template && template.outreach ? template.outreach : {};
  const body = (tpl.body || OUTREACH_BODY) + (vars.unsubscribeUrl ? UNSUB_FOOTER : '');
  return {
    subject: fill(tpl.subject || OUTREACH_SUBJECT, vars),
    body: fill(body, vars),
  };
}

function renderFollowup(template, vars, stepIndex = 0) {
  const list = template && Array.isArray(template.followups) ? template.followups : [];
  const tpl = list[stepIndex] || {};
  const body = (tpl.body || FOLLOWUP_BODY) + (vars.unsubscribeUrl ? UNSUB_FOOTER : '');
  return {
    subject: fill(tpl.subject || FOLLOWUP_SUBJECT, vars),
    body: fill(body, vars),
  };
}

function getHardcodedDefaults() {
  return {
    outreach: { subject: OUTREACH_SUBJECT, body: OUTREACH_BODY },
    followup: { subject: FOLLOWUP_SUBJECT, body: FOLLOWUP_BODY },
  };
}

module.exports = { renderOutreach, renderFollowup, getHardcodedDefaults };
