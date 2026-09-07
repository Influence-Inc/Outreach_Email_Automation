'use strict';

// Behavioural guard on deliverPending() — the single place the
// free-form-vs-template decision is made for a queued campaign update.
//
// Why this file exists: the 24h-window fix (stampInbound + the GREATEST
// fallback in loadCreator) changed what loadCreator returns for
// updates_last_inbound_at, and that value is the INPUT deliverPending branches
// on. deliverPending previously had no behavioural test at all, so nothing
// proved the decision itself still behaves identically. These tests pin that
// contract down:
//
//   window OPEN                        → free-form, never a template
//   window SHUT + template configured  → the existing template path, unchanged
//   window SHUT + no template          → stays pending, window_shut_no_template
//   opted out (STOP)                   → skipped, nothing sent, on either side
//                                        of the window
//
// The window field is supplied directly on the loaded creator row, which is
// exactly what loadCreator now produces — so "inbound during negotiation" and
// "inbound 30 days ago" are expressed here as the timestamps loadCreator would
// return for those creators.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const whatsapp = require('./offerPortal/whatsapp');
const imessage = require('./offerPortal/imessage');
const cu = require('./creatorUpdates');

const orig = {
  one: db.one,
  query: db.query,
  many: db.many,
  waText: whatsapp.sendWhatsAppText,
  waTemplate: whatsapp.sendWhatsAppTemplate,
  waAvailable: whatsapp.templatesAvailable,
  imText: imessage.sendIMessageText,
};

const HOUR = 3600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// One pending brief_ready row for a subscribed WhatsApp creator. `lastInbound`
// is what loadCreator resolves (column or offer_messages fallback — the caller
// can't tell the difference, which is the point).
function install({ lastInbound, optedOut = false, introSent = true, channel = 'whatsapp' }) {
  const calls = { freeform: 0, template: 0, imessage: 0, templateArgs: null };
  const writes = [];

  db.one = async (sql) => {
    if (/FROM creator_updates WHERE id/i.test(sql)) {
      return {
        id: 1, creator_id: 7, kind: 'brief_ready', status: 'pending',
        payload: { briefUrl: 'https://campaigns.influence.technology/brief/abc' },
        attempts: 0,
      };
    }
    if (/FROM creators c/i.test(sql)) {
      return {
        id: 7, first_name: 'Sam', full_name: 'Sam Rivera', email: 'sam@x.com',
        whatsapp: channel === 'whatsapp' ? '+15551230000' : null,
        imessage: channel === 'imessage' ? '+15551230000' : null,
        established_channel: channel,
        messaging_opted_out: optedOut,
        updates_subscribed_at: ago(30 * 24 * HOUR),
        updates_intro_sent_at: introSent ? ago(24 * HOUR) : null,
        updates_last_inbound_at: lastInbound,
        brand_name: 'Acme', campaign_name: 'Spring',
      };
    }
    // markAttempt's UPDATE ... RETURNING attempts
    if (/UPDATE creator_updates/i.test(sql)) return { attempts: 1 };
    return null;
  };
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return { rowCount: 1 };
  };
  db.many = async () => [];

  whatsapp.sendWhatsAppText = async () => { calls.freeform += 1; return { sent: true, id: 'wamid.free' }; };
  imessage.sendIMessageText = async () => { calls.imessage += 1; return { sent: true, id: 'im.1' }; };
  whatsapp.sendWhatsAppTemplate = async (args) => {
    calls.template += 1; calls.templateArgs = args;
    return { sent: true, id: 'wamid.tmpl', template: args.name };
  };
  whatsapp.templatesAvailable = () => true;

  return { calls, writes };
}

function restore() {
  db.one = orig.one; db.query = orig.query; db.many = orig.many;
  whatsapp.sendWhatsAppText = orig.waText;
  whatsapp.sendWhatsAppTemplate = orig.waTemplate;
  whatsapp.templatesAvailable = orig.waAvailable;
  imessage.sendIMessageText = orig.imText;
}

// Run with WHATSAPP_TEMPLATE_BRIEF_READY set (or explicitly cleared).
function withTemplateEnv(value, fn) {
  const KEY = 'WHATSAPP_TEMPLATE_BRIEF_READY';
  const saved = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });
}

// --- E. Window OPEN → free-form, never a template --------------------------

test('E: window open → deliverPending sends free-form and never a template', async () => {
  // 1h ago: exactly the "inbound during offer negotiation" case the fix makes
  // visible. Template env IS set, to prove the window — not availability —
  // decides.
  const { calls } = install({ lastInbound: ago(1 * HOUR) });
  try {
    await withTemplateEnv('influence_brief_ready', async () => {
      const r = await cu.deliverPending(1);
      assert.strictEqual(r.sent, true);
      assert.strictEqual(r.via, 'freeform', 'must take the free path when the window is open');
      assert.strictEqual(calls.freeform, 1);
      assert.strictEqual(calls.template, 0, 'must not spend a paid template inside an open window');
    });
  } finally {
    restore();
  }
});

test('E2: window open at 23h is still free-form', async () => {
  const { calls } = install({ lastInbound: ago(23 * HOUR) });
  try {
    await withTemplateEnv('influence_brief_ready', async () => {
      const r = await cu.deliverPending(1);
      assert.strictEqual(r.via, 'freeform');
      assert.strictEqual(calls.template, 0);
    });
  } finally {
    restore();
  }
});

// --- F. Window SHUT + template → existing template path, unchanged ---------

test('F: window shut with a configured template → the existing template path', async () => {
  const { calls } = install({ lastInbound: ago(25 * HOUR) });
  try {
    await withTemplateEnv('influence_brief_ready', async () => {
      const r = await cu.deliverPending(1);
      assert.strictEqual(r.sent, true);
      assert.strictEqual(r.via, 'template');
      assert.strictEqual(calls.freeform, 0, 'free-form is illegal outside the window');
      assert.strictEqual(calls.template, 1);
      // The payload contract is unchanged: configured name, the two positional
      // body params, and the URL-button SUFFIX (never the whole URL).
      assert.strictEqual(calls.templateArgs.name, 'influence_brief_ready');
      assert.deepStrictEqual(calls.templateArgs.bodyParams, ['Sam', 'Acme']);
      assert.strictEqual(calls.templateArgs.buttonUrlSuffix, 'brief/abc');
    });
  } finally {
    restore();
  }
});

// --- G. Window SHUT + no template → stays pending --------------------------

test('G: window shut with no template → stays pending with window_shut_no_template', async () => {
  const { calls } = install({ lastInbound: ago(25 * HOUR) });
  try {
    await withTemplateEnv(undefined, async () => {
      const r = await cu.deliverPending(1);
      assert.strictEqual(r.sent, false);
      assert.strictEqual(r.pending, true, 'the update must be retried, never dropped');
      assert.strictEqual(r.reason, 'window_shut_no_template');
      assert.strictEqual(calls.freeform, 0);
      assert.strictEqual(calls.template, 0);
    });
  } finally {
    restore();
  }
});

test('G2: a 30-day-old inbound behaves the same as any shut window', async () => {
  // The customer is still fully stored and still subscribed — only the window
  // is shut. Nothing here deletes or unsubscribes them.
  const { calls } = install({ lastInbound: ago(30 * 24 * HOUR) });
  try {
    await withTemplateEnv(undefined, async () => {
      const r = await cu.deliverPending(1);
      assert.strictEqual(r.pending, true);
      assert.strictEqual(r.reason, 'window_shut_no_template');
      assert.strictEqual(calls.freeform + calls.template, 0);
    });
  } finally {
    restore();
  }
});

// --- H. STOP still overrides everything ------------------------------------

test('H: an opted-out creator is skipped inside an open window', async () => {
  const { calls, writes } = install({ lastInbound: ago(1 * HOUR), optedOut: true });
  try {
    await withTemplateEnv('influence_brief_ready', async () => {
      const r = await cu.deliverPending(1);
      assert.strictEqual(r.sent, false);
      assert.strictEqual(r.reason, 'opted_out');
      assert.ok(!r.pending, 'opted out is terminal, not a retry');
      assert.strictEqual(calls.freeform + calls.template + calls.imessage, 0, 'STOP means nothing is sent');
      assert.ok(
        writes.some((w) => /status = 'skipped'/i.test(w.sql)),
        'the row is marked skipped',
      );
    });
  } finally {
    restore();
  }
});

test('H2: an opted-out creator is skipped outside the window too', async () => {
  const { calls } = install({ lastInbound: ago(25 * HOUR), optedOut: true });
  try {
    await withTemplateEnv('influence_brief_ready', async () => {
      const r = await cu.deliverPending(1);
      assert.strictEqual(r.reason, 'opted_out');
      assert.strictEqual(calls.template, 0, 'STOP outranks an available template');
    });
  } finally {
    restore();
  }
});

// --- iMessage keeps its existing behaviour ---------------------------------

test('an iMessage creator outside the window still reports the channel reason', async () => {
  // Unchanged by the window fix: templates are WhatsApp-only, so a shut window
  // on iMessage queues with its own distinct reason.
  const { calls } = install({ lastInbound: ago(25 * HOUR), channel: 'imessage' });
  try {
    await withTemplateEnv('influence_brief_ready', async () => {
      const r = await cu.deliverPending(1);
      assert.strictEqual(r.pending, true);
      assert.strictEqual(r.reason, 'window_shut_no_template_channel');
      assert.strictEqual(calls.imessage, 0);
    });
  } finally {
    restore();
  }
});
