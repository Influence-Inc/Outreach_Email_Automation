'use strict';

// The one client for classification calls, as in creator-list (enrichment/ai/router.py):
// OpenRouter's TypeSafe-compatible decisions endpoint serving Jev. The key is read from
// TYPESAFE_API_KEY and never logged.

const MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13';
const ENDPOINT = process.env.JEV_ENDPOINT || 'https://openrouter.ai/api/v1/systemone';
const KEY_ENV = 'TYPESAFE_API_KEY';

const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class JevClient {
  constructor({ retries = 3, fetchImpl = fetch, key = process.env[KEY_ENV], sleepImpl = sleep } = {}) {
    this.retries = retries;
    this.fetch = fetchImpl;
    this.key = key;
    this.sleep = sleepImpl;
  }

  // { model, answers: {qid: {choice, confidence, probabilities}}, cost_usd, ... }. Throws an
  // Error (never a partial answer) when the call fails or an answer is not one of the choices.
  async decide(state, questions) {
    if (!this.key) throw new Error(`${KEY_ENV} is not set`);
    const body = JSON.stringify({ model: MODEL, state, questions });
    const started = Date.now();
    let raw;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(90000),
        });
      } catch {
        if (attempt < this.retries) { await this.sleep(1000 * 2 ** attempt); continue; }
        throw new Error('Jev via OpenRouter: connection failed');
      }
      if (res.ok) { raw = await res.json(); break; }
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < this.retries) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Jev via OpenRouter: HTTP ${res.status}`);
    }
    const answers = {};
    for (const [qid, q] of Object.entries(questions)) {
      const a = (raw.answers || {})[qid] || {};
      if (!Object.prototype.hasOwnProperty.call(q.criteria, a.choice)) throw new Error(`Jev returned no valid answer for ${qid}`);
      const probabilities = {};
      for (const [k, v] of Object.entries(a.probabilities || {})) probabilities[k] = Number(v);
      answers[qid] = { choice: a.choice, confidence: Number(a.confidence || 0), probabilities };
    }
    const usage = raw.usage || {};
    return {
      model: raw.model || MODEL,
      answers,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      cost_usd: usage.cost ?? null,
      elapsed_ms: Date.now() - started,
    };
  }
}

module.exports = { JevClient, choice, MODEL, ENDPOINT, KEY_ENV };
