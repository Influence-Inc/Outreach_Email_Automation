'use strict';

// A free, on-device look, tried before the paid one.
//
// services/nichePrescreen.js spends one small Gemini image call per creator to
// decide whether a profile is worth recording at all — cheap next to a video
// judgement, but still a network round-trip with real latency and a real bill.
// Android ships an on-device model (Gemini Nano, via ML Kit's GenAI Image
// Description API, running through AICore) that can describe a screenshot with
// no network call and no per-call cost, on phones whose silicon supports it.
//
// THE SAME ASYMMETRY RULE AS nichePrescreen: this may only ever SAVE a cloud
// call, never cause a wrong rejection on its own. A confident on-device match
// skips the cloud prescreen entirely — the cheapest possible outcome. Anything
// else (no match, an agent build that does not implement the op yet, no AICore
// support on this device) falls through to the existing cloud prescreen
// unchanged. It never rejects a creator by itself, and it is not a drop-in
// replacement for the prescreen: an on-device image captioner returns free
// text, not a structured on/off-niche verdict with a confidence score the way
// Gemini's JSON response does, so there is no trustworthy signal here to reject
// ON — only to corroborate a pass early and skip paying for the same answer
// twice.
//
// This is scaffolding: `driver.describeImage` does not exist on any shipped
// agent build yet, so `tryDeviceHint` returns null on every real call today —
// exactly as if the tier were absent. Wiring it in ahead of the Android
// implementation means the on-device gain lands the moment that op ships,
// with no further backend change.

// Cheap containment check: does the on-device caption plausibly mention the
// niche/keywords this campaign is looking for? Deliberately loose (substring,
// not semantic) — a false negative here just means "ask the cloud instead",
// which is exactly today's behaviour, so looseness costs nothing.
function mentionsNiche(description, config = {}) {
  const hay = String(description || '').toLowerCase();
  if (!hay) return false;
  const terms = [config.niche, ...(config.keywords || [])]
    .filter(Boolean)
    .map((t) => String(t).toLowerCase().trim())
    .filter(Boolean);
  return terms.some((t) => hay.includes(t));
}

/**
 * Try the phone's own on-device description of a screenshot it already has.
 *
 * @returns {Promise<null|{pass:true, source:'on-device', description:string}>}
 *   Non-null only when the on-device caption corroborates the niche confidently
 *   enough to skip the cloud prescreen call. Any other outcome — including a
 *   thrown error, because the op is not implemented by this phone's agent build
 *   or the device has no AICore support — must be read as "no opinion, ask the
 *   cloud as usual", never as a reason to drop the creator.
 */
async function tryDeviceHint({ driver, kind = 'reels_grid', config = {}, log = () => {} }) {
  if (!driver || typeof driver.describeImage !== 'function') return null;
  if (!(config.niche || (config.keywords || []).length)) return null;

  let result = null;
  try {
    result = await driver.describeImage({ kind });
  } catch (_) {
    return null;
  }
  if (!result || result.available === false || !result.description) return null;

  if (mentionsNiche(result.description, config)) {
    log('[sourcing] on-device description corroborates the niche — skipping the cloud prescreen call');
    return { pass: true, source: 'on-device', description: result.description };
  }
  return null; // inconclusive — let the cloud prescreen have its say
}

module.exports = { tryDeviceHint, mentionsNiche };
