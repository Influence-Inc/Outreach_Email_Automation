'use strict';

// Warming the feed on a creator we just shortlisted: like their reel and share it.
//
// The account's reel feed only serves the creators we want once Instagram has
// learned what this account likes, and the clearest thing to teach it with is
// the creators we already chose. So every shortlisted creator is warmed, right
// after they are shortlisted, on the reel that surfaced them — the phone is
// still standing on it (services/sourcingNavigator.js records that reel before
// it yields the creator). When the phone is somewhere else (a creator found
// through the Accounts list, or opened from the feed by handle), their profile
// is opened and their newest reel is used instead.
//
//   like   the heart on the reel player, unless it is already liked.
//   share  the paper-plane button, then either:
//            - SOURCING_SHARE_TO set: send the reel in a DM to that handle — an
//              account the team owns, so nothing reaches a real person;
//            - unset: "Copy link" in the share sheet, which sends nothing at all.
//
// Caps per run (env, optional): SOURCING_WARM_MAX_LIKES (default 40) and
// SOURCING_WARM_MAX_SHARES (default 20). An "action blocked" screen stops all
// warming for the rest of the run. SOURCING_WARM=off turns warming off.
//
// The like button is the same one the feed's engagement already taps. The share
// sheet's controls are matched by their words ("Search", the recipient's handle,
// "Send", "Copy link"), which suits current Instagram builds but has not been
// confirmed on a device; any step that does not find its control backs out of
// the sheet and reports the share as not done — the like still stands.

const { readView, backTo } = require('./sourcingNavigator');
const { jitteredDelay, jitterTap } = require('./humanize');

const DEFAULTS = {
  maxLikes: 40,
  maxShares: 20,
  // Watch for a beat before reacting: a like the instant a reel appears is not a person.
  dwellMs: 2000,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const norm = (s) => String(s || '').trim().toLowerCase();
const clean = (h) => norm(h).replace(/^@/, '');

function num(v, fallback) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The warm-up policy for a run, from env. */
function loadPolicy(env = process.env) {
  return {
    enabled: norm(env.SOURCING_WARM) !== 'off',
    maxLikes: num(env.SOURCING_WARM_MAX_LIKES, DEFAULTS.maxLikes),
    maxShares: num(env.SOURCING_WARM_MAX_SHARES, DEFAULTS.maxShares),
    shareTo: clean(env.SOURCING_SHARE_TO) || null,
    dwellMs: num(env.SOURCING_WARM_DWELL_MS, DEFAULTS.dwellMs),
  };
}

function newCounters() {
  return { likes: 0, shares: 0, blocked: false };
}

function center(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  return { x: Math.round(b.x + (b.w || 0) / 2), y: Math.round(b.y + (b.h || 0) / 2) };
}

const labelOf = (e) => norm(e && (e.desc || e.text));
const wordsOf = (e) => `${norm(e && e.text)} ${norm(e && e.desc)}`.trim();

async function tapAt(driver, point, jitterPx, pacingMs) {
  const p = jitterTap(point, jitterPx || 0);
  await driver.tap(p.x, p.y);
  await sleep(jitteredDelay(pacingMs));
}

/** The first element `match` accepts that has a tappable centre, as a point. */
function find(elements, match) {
  for (const e of elements || []) {
    if (!match(e)) continue;
    const p = center(e.bounds);
    if (p) return p;
  }
  return null;
}

async function elementsOf(driver) {
  try {
    const els = await driver.dumpUi();
    return Array.isArray(els) ? els : [];
  } catch (_) {
    return [];
  }
}

const isThisCreatorsReel = (view, handle) => view && view.screen === 'reels_feed'
  && view.author && clean(view.author) === handle;

/**
 * Get onto one of this creator's reels: where we are, or their profile's newest
 * reel. Returns the reel player's reading, or null with a reason.
 */
async function reachReel({ driver, read, handle, pacingMs, jitterPx }) {
  let view = await read(driver);
  if (isThisCreatorsReel(view, handle)) return { view };

  const onTheirProfile = ['profile', 'reels_tab'].includes(view.screen)
    && (!view.username || clean(view.username) === handle);
  if (!onTheirProfile) {
    if (!driver.openProfile) return { view: null, reason: 'not on their reel, and this phone cannot open a profile' };
    try {
      await driver.openProfile(handle);
      await sleep(jitteredDelay(pacingMs));
    } catch (err) {
      return { view: null, reason: `could not open their profile (${(err && err.message) || err})` };
    }
    view = await read(driver);
    if (!['profile', 'reels_tab'].includes(view.screen)) return { view: null, reason: `their profile did not open (${view.screen})` };
  }

  // The Reels tab carries the reel thumbnails; the Posts grid does not.
  if (!(Array.isArray(view.reels) && view.reels.length) && view.targets && view.targets.reelsTab) {
    await tapAt(driver, view.targets.reelsTab, jitterPx, pacingMs);
    view = await read(driver);
  }
  const first = Array.isArray(view.reels) ? view.reels.find((r) => r && r.point) : null;
  if (!first) return { view: null, reason: 'no reel on their profile to open' };
  await tapAt(driver, first.point, jitterPx, pacingMs);
  view = await read(driver);
  if (!isThisCreatorsReel(view, handle)) return { view: null, reason: `their reel did not open (${view.screen})` };
  return { view };
}

/**
 * Share the reel on screen. Returns { shared, how?, reason? } and always leaves
 * the share sheet closed.
 */
async function shareReel({ driver, read, view, shareTo, pacingMs, jitterPx }) {
  const button = view.targets && view.targets.share;
  if (!button) return { shared: false, reason: 'no share button on the reel' };
  await tapAt(driver, button, jitterPx, pacingMs);

  const close = async () => {
    const now = await read(driver);
    if (now.screen !== 'reels_feed' && driver.back) {
      await driver.back();
      await sleep(jitteredDelay(pacingMs));
    }
  };

  let els = await elementsOf(driver);

  if (!shareTo) {
    const copy = find(els, (e) => labelOf(e) === 'copy link');
    if (!copy) {
      await close();
      return { shared: false, reason: 'no "Copy link" in the share sheet' };
    }
    await tapAt(driver, copy, jitterPx, pacingMs);
    await close();
    return { shared: true, how: 'copy link' };
  }

  const search = find(els, (e) => norm(e.cls).includes('edittext') || (/search/.test(wordsOf(e)) && /search/.test(norm(e.rid))));
  if (!search) {
    await close();
    return { shared: false, reason: 'no search box in the share sheet' };
  }
  await tapAt(driver, search, jitterPx, pacingMs);
  await driver.typeText(shareTo);
  await sleep(jitteredDelay(pacingMs));

  els = await elementsOf(driver);
  // The recipient row: their handle exactly, never a partial match — the sheet
  // also lists suggestions, and those are real people.
  const recipient = find(els, (e) => !norm(e.cls).includes('edittext')
    && (clean(e.text) === shareTo || clean(e.desc) === shareTo));
  if (!recipient) {
    await close();
    return { shared: false, reason: `@${shareTo} not found in the share sheet` };
  }
  await tapAt(driver, recipient, jitterPx, pacingMs);

  els = await elementsOf(driver);
  const send = find(els, (e) => labelOf(e) === 'send');
  if (!send) {
    await close();
    return { shared: false, reason: 'no Send button after choosing the recipient' };
  }
  await tapAt(driver, send, jitterPx, pacingMs);
  await close();
  return { shared: true, how: `sent to @${shareTo}` };
}

/**
 * Like and share one shortlisted creator's reel. Never throws.
 *
 * Returns { liked, shared, how?, reason?, blocked? }. `counters` is the run's,
 * shared across calls so the caps hold for the whole run.
 */
async function warmCreator({
  driver, read = readView, handle, policy = loadPolicy(), counters = newCounters(),
  pacingMs = 1500, jitterPx = 0, log = () => {},
}) {
  const who = clean(handle);
  const out = { liked: false, shared: false };
  if (!who) return { ...out, reason: 'no handle' };
  if (!policy.enabled) return { ...out, reason: 'warming is off' };
  if (counters.blocked) return { ...out, reason: 'Instagram blocked an action earlier this run' };
  const canLike = counters.likes < policy.maxLikes;
  const canShare = counters.shares < policy.maxShares;
  if (!canLike && !canShare) return { ...out, reason: 'this run reached its like and share caps' };

  try {
    const reached = await reachReel({ driver, read, handle: who, pacingMs, jitterPx });
    if (!reached.view) {
      log(`[warm] @${who}: ${reached.reason} — not warmed`);
      return { ...out, reason: reached.reason };
    }
    let { view } = reached;
    await sleep(jitteredDelay(policy.dwellMs));

    if (canLike) {
      if (view.alreadyLiked) {
        out.liked = true;
        out.alreadyLiked = true;
      } else if (view.targets && view.targets.like) {
        await tapAt(driver, view.targets.like, jitterPx, pacingMs);
        counters.likes += 1;
        out.liked = true;
      }
      view = await read(driver);
      if (view.screen === 'action_blocked') {
        counters.blocked = true;
        log('[warm] Instagram blocked an action — no more warming this run');
        return { ...out, blocked: true, reason: 'action blocked' };
      }
    }

    if (canShare && isThisCreatorsReel(view, who)) {
      const s = await shareReel({ driver, read, view, shareTo: policy.shareTo, pacingMs, jitterPx });
      if (s.shared) {
        counters.shares += 1;
        out.shared = true;
        out.how = s.how;
      } else {
        out.reason = s.reason;
      }
      const after = await read(driver);
      if (after.screen === 'action_blocked') {
        counters.blocked = true;
        log('[warm] Instagram blocked an action — no more warming this run');
        return { ...out, blocked: true, reason: 'action blocked' };
      }
      // Back on the reel player whatever the sheet did, so the scout carries on
      // from where it expects to be.
      if (after.screen !== 'reels_feed') await backTo({ driver, read, pacingMs, jitterPx, wanted: ['reels_feed'], maxHops: 2 });
    }

    log(`[warm] @${who}: ${out.liked ? 'liked' : 'not liked'}, ${out.shared ? `shared (${out.how})` : `not shared${out.reason ? ` — ${out.reason}` : ''}`}`);
    return out;
  } catch (err) {
    const reason = (err && err.message) || String(err);
    log(`[warm] @${who}: failed — ${reason}`);
    return { ...out, reason };
  }
}

module.exports = {
  warmCreator, shareReel, reachReel, loadPolicy, newCounters, DEFAULTS,
};
