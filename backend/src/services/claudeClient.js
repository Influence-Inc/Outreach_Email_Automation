'use strict';

// Shared Claude client + JSON helpers. Extracted from negotiation.js so both the
// negotiation pipeline and the contracts engine can reuse the exact same
// call/parse pattern without a circular require between those two modules.
//
// Claude is an optional dependency: with no ANTHROPIC_API_KEY (or if the SDK is
// missing / a call fails) every helper degrades to null so callers can fall back
// to deterministic behavior. Set DRY_RUN=1 in the callers to avoid side effects.

// ── Claude client (lazy; optional dependency) ─────────────────────────────
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
    console.warn('[claude] @anthropic-ai/sdk unavailable, using templates only:', err.message);
    _client = null;
  }
  return _client;
}

// Test-only: inject a fake client (anything exposing .messages.create) so the
// reply-evaluation harness can replay labeled examples through Claude without
// hitting the network. Passing null restores lazy initialization.
function _setClient(client) {
  _client = client;
  _clientTried = client !== undefined;
}

const model = () => process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function callClaudeText(system, user, maxTokens = 1200) {
  return callClaudeMessages(system, [{ role: 'user', content: user }], maxTokens);
}

// Same as callClaudeText but takes the full messages array — used so the caller
// can prepend few-shot (user/assistant) example turns BEFORE the real user
// message.
async function callClaudeMessages(system, messages, maxTokens = 1200) {
  const client = getClient();
  if (!client) return null;
  try {
    const resp = await client.messages.create({
      model: model(),
      max_tokens: maxTokens,
      system,
      messages,
    });
    return (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    console.error('[claude] Claude call failed:', err.message);
    return null;
  }
}

function stripFences(s) {
  return String(s || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseJsonLoose(s) {
  if (!s) return null;
  const cleaned = stripFences(s);
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
  }
  return null;
}

module.exports = {
  getClient,
  _setClient,
  model,
  callClaudeText,
  callClaudeMessages,
  stripFences,
  parseJsonLoose,
};
