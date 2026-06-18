const crypto = require('crypto');

// Secret used to HMAC the per-recipient unsubscribe tokens. We require it
// explicitly rather than falling back to a default so that tokens can't be
// forged in production by anyone who reads the source.
function secret() {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (!s) throw new Error('UNSUBSCRIBE_SECRET is not set');
  return s;
}

function signToken(creatorId) {
  return crypto
    .createHmac('sha256', secret())
    .update(String(creatorId))
    .digest('hex')
    .slice(0, 32);
}

function verifyToken(creatorId, token) {
  if (!token) return false;
  const expected = signToken(creatorId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Both URL forms used by Gmail / Outlook. The HTTPS one is what Gmail's
// "Easy Unsubscribe" pip POSTs to (RFC 8058); the mailto is the fallback.
function unsubscribeUrl(baseUrl, creatorId) {
  const token = signToken(creatorId);
  return `${baseUrl.replace(/\/$/, '')}/unsubscribe/${creatorId}/${token}`;
}

function unsubscribeMailto(senderEmail, creatorId) {
  const token = signToken(creatorId);
  return `mailto:${senderEmail}?subject=unsubscribe-${creatorId}-${token}`;
}

module.exports = { signToken, verifyToken, unsubscribeUrl, unsubscribeMailto };
