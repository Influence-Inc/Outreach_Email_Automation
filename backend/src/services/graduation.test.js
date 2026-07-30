'use strict';

// Guards the graduation flow: the personalized-vs-fallback congrats line, the
// dashboard→local creator matching, the once-per-person send guard, and the
// sweep's allComplete filter + prerequisite gating. DB, the email sender, Claude,
// and the campaigns API are all stubbed — no network, no Postgres.

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const claude = require('./claudeClient');
const email = require('./offerPortal/email');
const campaignsApi = require('./campaignsApi');
const graduation = require('./graduation');

const origOne = db.one;
const origMany = db.many;
const origQuery = db.query;
const origSend = email.sendGraduationEmail;
const origFetch = campaignsApi.fetchUpstreamCampaigns;

// Env needed for businessConnectNumbers() to report a usable channel, plus the
// sweep prerequisites. Snapshot + restore so tests don't leak.
const ENV_KEYS = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM',
  'IMESSAGE_API_KEY', 'IMESSAGE_FROM_NUMBER',
  'RESEND_API_KEY', 'CAMPAIGNS_API_TOKEN',
];
async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const CONFIGURED = {
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'twilio-tok',
  TWILIO_WHATSAPP_FROM: '+12053706046',
  IMESSAGE_API_KEY: 'im-key',
  IMESSAGE_FROM_NUMBER: '+12053706046',
  RESEND_API_KEY: 're-key',
  CAMPAIGNS_API_TOKEN: 'bot-token',
};

const fakeClaude = (text) => ({ messages: { create: async () => ({ content: [{ type: 'text', text }] }) } });

function restore() {
  db.one = origOne;
  db.many = origMany;
  db.query = origQuery;
  email.sendGraduationEmail = origSend;
  campaignsApi.fetchUpstreamCampaigns = origFetch;
  claude._setClient(null);
}

// --- personalizedCongrats --------------------------------------------------

test('personalizedCongrats uses Claude when available', async () => {
  claude._setClient(fakeClaude('You crushed it, Sam — loved working together!'));
  try {
    const r = await graduation.personalizedCongrats('Sam', 'Acme');
    assert.strictEqual(r.personalized, true);
    assert.match(r.line, /crushed it, Sam/);
  } finally {
    restore();
  }
});

test('personalizedCongrats falls back to the static line without Claude', async () => {
  claude._setClient(null); // no client → callClaudeText returns null
  try {
    const r = await graduation.personalizedCongrats('Sam', 'Acme');
    assert.strictEqual(r.personalized, false);
    assert.strictEqual(r.line, graduation.fallbackCongrats('Acme'));
    assert.match(r.line, /Acme/);
  } finally {
    restore();
  }
});

// --- matchLocalCreators ----------------------------------------------------

test('matchLocalCreators returns [] with no email or handle (no query)', async () => {
  let queried = false;
  db.many = async () => {
    queried = true;
    return [];
  };
  try {
    const rows = await graduation.matchLocalCreators({ email: '', username: '' });
    assert.deepStrictEqual(rows, []);
    assert.strictEqual(queried, false);
  } finally {
    restore();
  }
});

test('matchLocalCreators queries by lowercased email + IG handle', async () => {
  let params;
  db.many = async (_sql, p) => {
    params = p;
    return [{ id: 7 }];
  };
  try {
    const rows = await graduation.matchLocalCreators({ email: 'SAM@X.com', username: '@Sam_Rivera' });
    assert.deepStrictEqual(rows, [{ id: 7 }]);
    assert.deepStrictEqual(params, ['sam@x.com', 'sam_rivera']);
  } finally {
    restore();
  }
});

// --- sendGraduationEmailForCreator ----------------------------------------

function installSend({ creator, prior = null, sendResult = { sent: true } }) {
  const writes = [];
  const sends = [];
  db.one = async (sql, p) => {
    if (/FROM creators WHERE id = \$1/i.test(sql)) return creator ? { ...creator } : null;
    if (/graduation_email_at IS NOT NULL/i.test(sql)) return prior;
    return null;
  };
  db.query = async (sql, p) => {
    writes.push({ sql, params: p });
    return { rows: [] };
  };
  email.sendGraduationEmail = async (args) => {
    sends.push(args);
    return sendResult;
  };
  claude._setClient(null); // deterministic fallback congrats
  return { writes, sends };
}
const stamped = (w) => w.some((x) => /graduation_email_at\s*=\s*NOW\(\)/i.test(x.sql));
const logged = (w) => w.some((x) => /'graduation_email_sent'/i.test(x.sql));

const baseCreator = { id: 5, email: 'sam@x.com', first_name: 'Sam', full_name: 'Sam Rivera', graduation_email_at: null };

test('sendGraduationEmailForCreator sends once, stamps, and logs', async () => {
  await withEnv(CONFIGURED, async () => {
    const { writes, sends } = installSend({ creator: { ...baseCreator } });
    try {
      const r = await graduation.sendGraduationEmailForCreator(5, { brandName: 'Acme' });
      assert.deepStrictEqual(r, { sent: true });
      assert.strictEqual(sends.length, 1);
      assert.strictEqual(sends[0].brandName, 'Acme');
      assert.strictEqual(sends[0].whatsappNumber, '+12053706046');
      assert.ok(stamped(writes) && logged(writes));
    } finally {
      restore();
    }
  });
});

test('sendGraduationEmailForCreator skips a creator already graduated on this row', async () => {
  await withEnv(CONFIGURED, async () => {
    const { writes, sends } = installSend({ creator: { ...baseCreator, graduation_email_at: new Date().toISOString() } });
    try {
      const r = await graduation.sendGraduationEmailForCreator(5, { brandName: 'Acme' });
      assert.deepStrictEqual(r, { sent: false, reason: 'already_sent' });
      assert.strictEqual(sends.length, 0);
      assert.ok(!stamped(writes));
    } finally {
      restore();
    }
  });
});

test('sendGraduationEmailForCreator dedupes by person (already graduated elsewhere) and stamps', async () => {
  await withEnv(CONFIGURED, async () => {
    const { writes, sends } = installSend({ creator: { ...baseCreator }, prior: { '?column?': 1 } });
    try {
      const r = await graduation.sendGraduationEmailForCreator(5, { brandName: 'Acme' });
      assert.deepStrictEqual(r, { sent: false, reason: 'already_graduated' });
      assert.strictEqual(sends.length, 0, 'no second congrats to the same person');
      assert.ok(stamped(writes), 'stamped so we stop reconsidering this row');
      assert.ok(!logged(writes));
    } finally {
      restore();
    }
  });
});

test('sendGraduationEmailForCreator skips a creator with no email', async () => {
  await withEnv(CONFIGURED, async () => {
    const { sends } = installSend({ creator: { ...baseCreator, email: null } });
    try {
      const r = await graduation.sendGraduationEmailForCreator(5, { brandName: 'Acme' });
      assert.deepStrictEqual(r, { sent: false, reason: 'no_email' });
      assert.strictEqual(sends.length, 0);
    } finally {
      restore();
    }
  });
});

// --- runGraduationSweep ----------------------------------------------------

test('runGraduationSweep skips when prerequisites are not configured', async () => {
  await withEnv({}, async () => {
    const r = await graduation.runGraduationSweep();
    assert.strictEqual(r.skipped, 'email_not_configured');
  });
});

test('runGraduationSweep only emails creators whose deliverables.allComplete is true', async () => {
  await withEnv(CONFIGURED, async () => {
    campaignsApi.fetchUpstreamCampaigns = async () => [
      {
        brandName: 'Acme',
        creators: [
          { username: 'done_creator', email: 'done@x.com', deliverables: { allComplete: true } },
          { username: 'wip_creator', email: 'wip@x.com', deliverables: { allComplete: false } },
          { username: 'no_reqs', email: 'nr@x.com', deliverables: { allComplete: null } },
        ],
      },
    ];
    const sends = [];
    db.many = async (_sql, p) => (p[0] === 'done@x.com' || p[1] === 'done_creator' ? [{ id: 99 }] : []);
    db.one = async (sql) => {
      if (/FROM creators WHERE id = \$1/i.test(sql)) return { id: 99, email: 'done@x.com', first_name: 'Dee', full_name: 'Dee', graduation_email_at: null };
      return null; // no prior graduation
    };
    db.query = async () => ({ rows: [] });
    email.sendGraduationEmail = async (args) => {
      sends.push(args);
      return { sent: true };
    };
    claude._setClient(null);
    try {
      const r = await graduation.runGraduationSweep();
      assert.strictEqual(r.sent, 1, 'exactly one email — only the allComplete creator');
      assert.strictEqual(sends[0].to, 'done@x.com');
    } finally {
      restore();
    }
  });
});
