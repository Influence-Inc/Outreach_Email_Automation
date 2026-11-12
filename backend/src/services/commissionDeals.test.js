'use strict';

// Run with: npm test  (node --test)
//
// Commission (affiliate), fee + commission, and product-only deals end to end.
// The bug this guards against: a deal with no fee used to fall back to the
// creator's own asking rate (quoted_rate) at acceptance and on the contract,
// so an affiliate deal would be signed as "Compensation: $6,000".
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const instantly = require('./instantly');
const negotiation = require('./negotiation');
const contracts = require('./contracts');
const creatorDb = require('./creatorDb');
const dealTerms = require('./dealTerms');
const { contractSections } = require('./contractTerms');

const origOne = db.one;
const origQuery = db.query;
const origMany = db.many;
const origReply = instantly.replyToEmail;
function restore() {
  db.one = origOne;
  db.query = origQuery;
  db.many = origMany;
  instantly.replyToEmail = origReply;
  negotiation._setClient(null);
}

const COMMISSION = { model: 'commission', commission: { rate_pct: 15, attribution: 'code', promo_code: 'sam15' } };
const commissionTerms = dealTerms.normalizeTerms(COMMISSION);

const creator = {
  id: 11,
  first_name: 'Sam',
  brand_name: 'Reve',
  email: 'sam@example.com',
  negotiation_status: 'AWAITING_APPROVAL',
  quoted_rate: 6000, // the creator's asking rate — must never become the deal
  instantly_reply_uuid: 'uuid-11',
  instantly_email_account: 'jennifer@frominfluence.com',
  instantly_reply_subject: 'Re: Paid Partnership with Reve',
  instantly_reply_cc: '',
  latest_inbound_text: 'My rate is $6,000.',
  usage_rights_policy: 'no_rights',
};

test('a commission-only email is an offer: AWAITING_DECISION, terms booked, no fee', async () => {
  const prev = process.env.DRY_RUN;
  process.env.DRY_RUN = '1';
  const writes = [];
  db.one = async (sql, params) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator };
    if (/AWAITING_DECISION/.test(sql) && /RETURNING id/.test(sql)) { writes.push({ sql, params }); return { id: 11 }; }
    if (/INSERT INTO email_messages/.test(sql)) return { id: 1 };
    return null;
  };
  db.query = async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; };
  db.many = async () => [];
  try {
    const res = await negotiation.sendComposedEmail(11, { html: '<p>Would a 15% commission with code SAM15 work?</p>', terms: COMMISSION });
    assert.strictEqual(res.offer, true);
    assert.strictEqual(res.fee, null);
    const claim = writes.find((w) => /RETURNING id/.test(w.sql));
    const offer = JSON.parse(claim.params[2]);
    assert.strictEqual(offer.compensation_model, 'commission');
    assert.strictEqual(offer.flat_fee, null, 'no fee on the offer');
    assert.strictEqual(offer.label, '15% commission');
    const ev = writes.find((w) => /'rate_offer_sent'/.test(w.sql));
    assert.strictEqual(ev.params[1].fee, null);
    assert.strictEqual(ev.params[1].model, 'commission');
    assert.strictEqual(ev.params[1].terms.commission.promo_code, 'SAM15');
  } finally {
    process.env.DRY_RUN = prev;
    restore();
  }
});

test('bad terms are refused before anything is sent', async () => {
  const sent = [];
  instantly.replyToEmail = async (a) => { sent.push(a); };
  db.one = async (sql) => (/FROM creators c JOIN campaigns/i.test(sql) ? { ...creator } : null);
  db.query = async () => ({ rows: [] });
  try {
    await assert.rejects(
      negotiation.sendComposedEmail(11, { html: '<p>hi</p>', terms: { model: 'commission', commission: {} } }),
      (e) => e.status === 400 && /commission rate/.test(e.message),
    );
    assert.strictEqual(sent.length, 0);
  } finally {
    restore();
  }
});

test('the creator saying yes books the commission terms — never their asking rate', async () => {
  const writes = [];
  db.one = async (sql) => {
    if (/type = 'rate_offer_sent'/.test(sql)) return { detail: { fee: null, model: 'commission', terms: commissionTerms, label: '15% commission' } };
    return null;
  };
  db.query = async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; };
  db.many = async () => [];
  try {
    assert.deepStrictEqual(await negotiation.agreedOfferTerms({ id: 11 }), commissionTerms);
    assert.strictEqual(await negotiation.agreedOfferFee({ id: 11, quoted_rate: 6000 }), null);
  } finally {
    restore();
  }
});

test('agreedFeeFor on a commission deal is null, not quoted_rate', async () => {
  db.one = async (sql) => {
    if (/type IN \('rate_accepted', 'rate_offer_sent'\)/.test(sql)) {
      return { type: 'rate_accepted', detail: { fee: null, model: 'commission', terms: commissionTerms } };
    }
    return null;
  };
  try {
    assert.strictEqual(await contracts.agreedFeeFor({ id: 11, quoted_rate: 6000 }), null);
    assert.deepStrictEqual(await contracts.agreedTermsFor({ id: 11 }), commissionTerms);
  } finally {
    restore();
  }
});

test('a later flat acceptance (accept creator rate) supersedes earlier commission terms', async () => {
  db.one = async (sql) => {
    if (/type IN \('rate_accepted', 'rate_offer_sent'\)/.test(sql)) {
      return { type: 'rate_accepted', detail: { fee: 6000, by: 'admin', source: 'creator_rate' } };
    }
    if (/type = 'rate_accepted'/.test(sql)) return { detail: { fee: 6000, by: 'admin', source: 'creator_rate' } };
    return null;
  };
  try {
    assert.strictEqual(await contracts.agreedTermsFor({ id: 11 }), null);
    assert.strictEqual(await contracts.agreedFeeFor({ id: 11, quoted_rate: 6000 }), 6000);
  } finally {
    restore();
  }
});

test('contract data for a hybrid deal: upfront fee + commission, extraction cannot override the money', () => {
  const t = dealTerms.normalizeTerms({ model: 'hybrid', fee: 500, commission: { rate_pct: 15 } });
  const fields = contracts.termsContractFields(t);
  assert.strictEqual(fields.compensationModel, 'hybrid');
  assert.strictEqual(fields.compensation, 500);
  assert.strictEqual(fields.totalPayment, 500);
  assert.strictEqual(fields.commission.ratePct, 15);
  assert.match(fields.commission.summary, /15% commission on net sales/);
  assert.strictEqual(contracts.termsContractFields(null).compensationModel, 'flat');
});

test('commission-only contract renders no dollar compensation and its own pay rows', () => {
  const d = { currency: 'USD', paymentTermsDays: 7, ...contracts.termsContractFields(commissionTerms) };
  const pay = contractSections(d, {}).find((s) => s.title === 'Compensation & Payment');
  const labels = pay.rows.map((r) => r.label);
  assert.deepStrictEqual(labels, ['Compensation', 'Commission', 'Tracking', 'Reporting', 'Returns', 'Currency', 'Payment terms']);
  assert.strictEqual(pay.rows[0].value, 'Commission only — no upfront fee');
  assert.match(pay.rows[2].value, /promo code SAM15/);
  assert.match(pay.rows[6].value, /monthly, within 30 days/);
  assert.doesNotMatch(JSON.stringify(pay), /\$6,000|\$0/);
});

test('product-only contract', () => {
  const t = dealTerms.normalizeTerms({ model: 'product', product: 'Full skincare set' });
  const d = { currency: 'USD', ...contracts.termsContractFields(t) };
  const pay = contractSections(d, {}).find((s) => s.title === 'Compensation & Payment');
  assert.strictEqual(pay.rows[0].value, 'Product only — no cash payment');
  assert.strictEqual(pay.rows[1].value, 'Full skincare set');
});

test('Creator-DB sync: cash part as compensation, terms as the first additional term', () => {
  const d = { currency: 'USD', ...contracts.termsContractFields(commissionTerms), additionalTerms: ['30-day exclusivity'] };
  const payload = creatorDb.buildPayload({ data: d, token: 'tok' }, { email: 'sam@example.com' });
  assert.strictEqual(payload.compensation, 0);
  assert.match(payload.additionalTerms[0], /^Commission only: 15% commission/);
  assert.strictEqual(payload.additionalTerms[1], '30-day exclusivity');
});

test('recordAgreedTerms books terms as ACCEPTED without emailing, and refuses once a contract exists', async () => {
  const writes = [];
  const sent = [];
  instantly.replyToEmail = async (a) => { sent.push(a); };
  let hasContract = false;
  db.one = async (sql) => {
    if (/FROM creators c JOIN campaigns/i.test(sql)) return { ...creator, negotiation_status: 'AWAITING_DECISION' };
    if (/FROM contracts/.test(sql)) return hasContract ? { id: 1 } : null;
    return null;
  };
  db.query = async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; };
  try {
    const res = await negotiation.recordAgreedTerms(11, { model: 'hybrid', fee: 500, commission: { rate_pct: 10 } });
    assert.strictEqual(res.recorded, true);
    assert.strictEqual(sent.length, 0, 'nothing is emailed');
    const upd = writes.find((w) => /negotiation_status = 'ACCEPTED'/.test(w.sql));
    assert.ok(upd);
    assert.strictEqual(upd.params[3], null, 'quoted_rate is not overwritten for a non-flat deal');
    const acc = writes.find((w) => /'rate_accepted'/.test(w.sql));
    assert.strictEqual(acc.params[1].source, 'recorded');
    assert.strictEqual(acc.params[1].label, '$500 + 10% commission');
    assert.ok(writes.some((w) => /'contract_approval_requested'/.test(w.sql)), 'parks for brand approval');

    hasContract = true;
    await assert.rejects(negotiation.recordAgreedTerms(11, COMMISSION), (e) => e.status === 409);
    await assert.rejects(negotiation.recordAgreedTerms(11, { model: 'none' }), (e) => e.status === 400);
  } finally {
    restore();
  }
});

test('the classifier is told the offer is commission-based and to hand off push-back', async () => {
  let system = '';
  negotiation._setClient({
    messages: {
      create: async (req) => {
        system = typeof req.system === 'string' ? req.system : JSON.stringify(req.system);
        return { content: [{ type: 'text', text: '{"understanding":"yes","action":"accepted","quoted_rate":null,"email":{"subject":"s","body":"b"},"send_now":true}' }] };
      },
    },
  });
  try {
    const ctx = negotiation.ctxFor(
      { ...creator, negotiation_status: 'AWAITING_DECISION' },
      { approvedOffer: { offer_type: 'composed', terms: commissionTerms, label: '15% commission' } },
    );
    await negotiation.handleCreatorReply({ id: 11 }, 'Sounds good!', ctx);
    assert.match(system, /The offer on the table is NOT a flat fee/);
    assert.match(system, /Commission only \(no upfront fee\): 15% commission/);
    assert.match(system, /use "escalate"/);
  } finally {
    restore();
  }
});
