const { google } = require('googleapis');
const db = require('../db');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid',
  'email',
];

function buildClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

function generateAuthUrl() {
  const client = buildClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    login_hint: process.env.SENDER_EMAIL,
  });
}

async function exchangeCode(code) {
  const client = buildClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const me = await oauth2.userinfo.get();
  const email = me.data.email;

  await db.query(
    `INSERT INTO oauth_tokens (email, access_token, refresh_token, expiry_date, scope, token_type, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (email) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
       expiry_date = EXCLUDED.expiry_date,
       scope = EXCLUDED.scope,
       token_type = EXCLUDED.token_type,
       updated_at = NOW()`,
    [
      email,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expiry_date,
      tokens.scope,
      tokens.token_type,
    ],
  );

  return email;
}

async function getAuthorizedClient() {
  const senderEmail = process.env.SENDER_EMAIL;
  const row = await db.one('SELECT * FROM oauth_tokens WHERE email = $1', [senderEmail]);
  if (!row) {
    throw new Error(
      `No OAuth tokens stored for ${senderEmail}. Visit /auth/google to authorize.`,
    );
  }
  const client = buildClient();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date ? Number(row.expiry_date) : undefined,
    scope: row.scope,
    token_type: row.token_type,
  });

  // Persist refreshed tokens back to the DB.
  client.on('tokens', async (tokens) => {
    try {
      await db.query(
        `UPDATE oauth_tokens
         SET access_token = COALESCE($2, access_token),
             refresh_token = COALESCE($3, refresh_token),
             expiry_date = COALESCE($4, expiry_date),
             updated_at = NOW()
         WHERE email = $1`,
        [
          senderEmail,
          tokens.access_token || null,
          tokens.refresh_token || null,
          tokens.expiry_date || null,
        ],
      );
    } catch (err) {
      console.error('Failed to persist refreshed tokens:', err);
    }
  });

  return client;
}

module.exports = { generateAuthUrl, exchangeCode, getAuthorizedClient, SCOPES };
