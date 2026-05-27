const SENDER_NAME = process.env.SENDER_NAME || 'Jennifer';

// Hardcoded safety-net copy, used only if no email_templates row exists
// at all (fresh deploy before seeding finished, or all templates deleted).
const OUTREACH_SUBJECT = 'Paid collaboration with {brandName}';

const OUTREACH_BODY = `Hi {firstName},

I'm ${SENDER_NAME} from Influence (useinfluence.xyz). I came across your Instagram and loved your content - the way you connect with your audience really stood out.

We're putting together a paid campaign for {brandName} and would love to bring you on board as one of the featured creators.

If this sounds interesting, I'd be happy to share the campaign brief, deliverables, and rates. Could you let me know if you're open to it?

Best,
${SENDER_NAME}
useinfluence.xyz`;

const FOLLOWUP_SUBJECT = 'Re: Paid collaboration with {brandName}';

const FOLLOWUP_BODY = `Hi {firstName},

Just bumping this up in case it got buried. We're still looking to lock in creators for the {brandName} campaign and you'd be a great fit.

Happy to send over the brief and rates whenever works for you - even a quick yes/no helps me plan.

Best,
${SENDER_NAME}
useinfluence.xyz`;

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

// `template` is an email_templates row (or null). Renders the outreach email,
// substituting variables. Falls back to hardcoded defaults if the template
// doesn't define them.
function renderOutreach(template, vars) {
  const tpl = template && template.outreach ? template.outreach : {};
  return {
    subject: fill(tpl.subject || OUTREACH_SUBJECT, vars),
    body: fill(tpl.body || OUTREACH_BODY, vars),
  };
}

function renderFollowup(template, vars, stepIndex = 0) {
  const list = template && Array.isArray(template.followups) ? template.followups : [];
  const tpl = list[stepIndex] || {};
  return {
    subject: fill(tpl.subject || FOLLOWUP_SUBJECT, vars),
    body: fill(tpl.body || FOLLOWUP_BODY, vars),
  };
}

function getHardcodedDefaults() {
  return {
    outreach: { subject: OUTREACH_SUBJECT, body: OUTREACH_BODY },
    followup: { subject: FOLLOWUP_SUBJECT, body: FOLLOWUP_BODY },
  };
}

module.exports = { renderOutreach, renderFollowup, getHardcodedDefaults };
