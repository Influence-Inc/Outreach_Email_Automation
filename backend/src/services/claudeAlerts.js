'use strict';

// Slack alert when the Claude API (Anthropic Console) is out of credits or
// rejects the key.
//
// Every Claude client in this backend is wrapped with watch(): when a call
// fails with an error that means calls will keep failing until someone acts
// (no credit balance, a usage limit reached, the key rejected), it posts to
// the alerts channel's incoming webhook, ALERTS_SLACK_WEBHOOK_URL, once and
// then again every 3 hours while it lasts. Passing errors (rate limits,
// overload, a dropped connection) say nothing. The error still reaches the
// caller unchanged, so every existing fallback keeps working. Without the
// variable nothing is sent, and sending never throws.
//
// The creator-list worker and Influence Bot use the same variable and
// channel, so all Claude, OpenRouter, Groq and Monid alerts land in one place.

const WEBHOOK_ENV = 'ALERTS_SLACK_WEBHOOK_URL';
const EVERY_MS = 3 * 3600 * 1000;
const SERVICE = 'Claude API (Anthropic Console) for the outreach backend';
// How Anthropic says the account can't pay: "Your credit balance is too low
// to access the Anthropic API", "You have reached your specified API usage
// limits".
const CREDITS = /credit balance|purchase credits|usage limit|spend limit|billing|quota|insufficient/i;

const lastSent = new Map(); // alert key -> time it was last sent

function problem(status, message) {
  if (status === 402 || CREDITS.test(message || '')) return 'out of credits';
  if (status === 401 || status === 403) return 'key refused';
  return null;
}

async function notify(key, text, everyMs = EVERY_MS, now = Date.now()) {
  const url = (process.env[WEBHOOK_ENV] || '').trim();
  if (!url) return false;
  if (lastSent.has(key) && now - lastSent.get(key) < everyMs) return false;
  lastSent.set(key, now);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 3000) }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch (err) {
    console.warn('[claude-alerts] Slack alert not sent:', err.message);
    return false;
  }
}

// Alert when a Claude call's error means it's out of credits or the key is
// refused. Resolves true if it was that.
async function report(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  const message = String((err && err.message) || err || '').replace(/\s+/g, ' ').slice(0, 300);
  const found = problem(status, message);
  if (!found) return false;
  const detail = status ? `HTTP ${status} (${message})` : message;
  await notify(
    `claude:${found}`,
    `:rotating_light: *${SERVICE}: ${found}*: ${detail}. Replies, negotiation and contract ` +
      'drafts fall back to templates until it is topped up (console.anthropic.com → ' +
      'Plans & Billing) or the key is fixed.',
  );
  return true;
}

// The same client, with messages.create reporting its errors before
// rethrowing them.
function watch(client) {
  if (!client || !client.messages || typeof client.messages.create !== 'function') return client;
  const create = client.messages.create.bind(client.messages);
  client.messages.create = async (...args) => {
    try {
      return await create(...args);
    } catch (err) {
      report(err).catch(() => {});
      throw err;
    }
  };
  return client;
}

function _reset() {
  lastSent.clear();
}

module.exports = { watch, report, notify, problem, WEBHOOK_ENV, _reset };
