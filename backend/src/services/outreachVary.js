'use strict';

// Lightly paraphrases the outreach subject + body per recipient so Gmail's
// content classifier doesn't latch onto an identical message across every send
// (a major spam signal on cold outreach). Falls back to the static template on
// any failure — no API key, network error, malformed model output. Cost is
// roughly $0.001/email on Haiku.

let _client;
let _tried = false;
function getClient() {
  if (_tried) return _client;
  _tried = true;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    _client = null;
    return null;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey });
  } catch (err) {
    console.warn('[outreachVary] @anthropic-ai/sdk unavailable; using static template:', err.message);
    _client = null;
  }
  return _client;
}

const model = () => process.env.CLAUDE_MODEL || 'claude-haiku-4-5';

function parseLoose(text) {
  if (!text) return null;
  const cleaned = String(text)
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

async function varyOutreach({ subject, body }) {
  const client = getClient();
  if (!client) return { subject, body };

  const system = [
    'You rewrite short cold outreach emails to add natural per-recipient variety.',
    '',
    'Rules:',
    '- Keep the same meaning, structure, and any concrete facts (names, links, brand mentions, references).',
    '- Vary sentence openers, word choice, and rhythm so the rewrite does not read as a near-duplicate of the original.',
    '- Match the original length within plus or minus 15 percent. Do not add new paragraphs.',
    '- Preserve plain-text formatting: line breaks where the original has them, no markdown, no emojis.',
    '- Keep the greeting line and the sign-off line ("- Name") exactly as written.',
    '- Return STRICT JSON ONLY (no markdown fences, no prose), shape: {"subject": string, "body": string}.',
  ].join('\n');

  try {
    const resp = await client.messages.create({
      model: model(),
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: JSON.stringify({ subject, body }) }],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const parsed = parseLoose(text);
    if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) {
      return {
        subject:
          typeof parsed.subject === 'string' && parsed.subject.trim()
            ? parsed.subject.trim()
            : subject,
        body: parsed.body,
      };
    }
  } catch (err) {
    console.warn('[outreachVary] paraphrase failed, using static template:', err.message);
  }
  return { subject, body };
}

module.exports = { varyOutreach };
