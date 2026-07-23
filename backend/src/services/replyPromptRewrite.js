'use strict';

// Applies a team member's plain-English instruction to a master prompt for a
// specific reply type, using Claude, and returns the rewritten master prompt.
// Used by the Guidelines UI "Save → preview → Confirm" flow: on Save the UI
// calls this to render the actual revised prompt (with the instruction applied
// literally to the template text, not just appended as an addendum), lets the
// team review it, and only persists it on Confirm.
//
// The rewrite is deliberately conservative: preserve every placeholder
// ({firstName}, {managerName}, {brandName}, ${flat_rate}, …), preserve section
// structure, and never invent new deal terms or numbers. Return-only-the-text
// contract keeps the output pastable straight back into the storage layer.

const { callClaudeText } = require('./claudeClient');

const REWRITE_SYSTEM_PROMPT = [
  'You revise MASTER PROMPTS that another AI (Claude) follows when writing a specific type of brand-partnerships email.',
  '',
  'You will be given:',
  '  (a) the CURRENT master prompt (the exact text Claude currently follows for this reply type), and',
  '  (b) the team\'s INSTRUCTION for how to change it.',
  '',
  'Your job is to apply the instruction to produce the REVISED master prompt.',
  '',
  'Rules:',
  '  1. If the instruction is a literal substitution — "change X to Y", "replace X with Y", or otherwise identifies a specific passage to rewrite — perform the substitution VERBATIM wherever the target text appears in the current prompt. Do not paraphrase the replacement; use it exactly as given. Do not touch any other text.',
  '  2. If the instruction is additive — "always mention Z", "never say W", "keep it under 3 lines", "prefer Y phrasing" — integrate it into the natural section of the prompt where it belongs. Do not append an addendum block; edit the prompt in place so a reader can\'t tell where the base ended and the note began.',
  '  3. PRESERVE every placeholder EXACTLY: {firstName}, {salutation}, {managerName}, {brandName}, {cadence}, {refs}, {deadline}, {video_count}, {view_target}, {view_target_x2}, {flat_bonus_amount}, {flat_bonus_threshold_views}, ${flat_rate}, ${flat_total}, ${view_based_rate}, and every other {…} or ${…} token. Never rename, drop, or invent placeholders.',
  '  4. PRESERVE structural markers: section headers wrapped in **bold**, bullet lines starting with "-", the "--- REPLY 1 ---" / "--- REPLY 2 ---" separators, "Directive to Claude:" / "Triggered when:" labels, "Canonical template:" markers, and the delimiter lines around them.',
  '  5. Never invent deal numbers, rates, discounts, or contractual terms. Never remove the guardrails that block Claude from inventing them.',
  '  6. If the instruction is unclear, ambiguous, or would break the prompt (e.g. remove a required placeholder), return the CURRENT prompt UNCHANGED — do not guess.',
  '',
  'OUTPUT CONTRACT: return ONLY the revised master prompt text. No explanation, no preface, no "here is the revised prompt", no markdown code fences.',
].join('\n');

// Rewrite the given current master prompt by applying the instruction. Returns
// null when Claude is unavailable (no API key / SDK missing / call failed) so
// the caller can surface a friendly error to the admin. Trims leading/trailing
// whitespace but is otherwise verbatim from the model.
async function rewriteMasterPrompt({ currentPrompt, instruction }) {
  const cur = String(currentPrompt || '');
  const ins = String(instruction || '').trim();
  if (!cur || !ins) return cur;
  const user = [
    'CURRENT MASTER PROMPT:',
    '"""',
    cur,
    '"""',
    '',
    'TEAM INSTRUCTION:',
    '"""',
    ins,
    '"""',
    '',
    'Return the REVISED master prompt text now.',
  ].join('\n');
  const out = await callClaudeText(REWRITE_SYSTEM_PROMPT, user, 4000);
  if (out == null) return null;
  return String(out).replace(/^\s+|\s+$/g, '');
}

module.exports = {
  rewriteMasterPrompt,
  REWRITE_SYSTEM_PROMPT,
};
