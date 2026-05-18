const crypto = require('crypto');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('./oauth');

function newTrackingId() {
  return crypto.randomBytes(12).toString('hex');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bodyToHtml(text, trackingPixelUrl) {
  const escaped = escapeHtml(text).replace(/\n/g, '<br/>');
  const pixel = trackingPixelUrl
    ? `<img src="${trackingPixelUrl}" width="1" height="1" alt="" style="display:block;border:0;outline:none;" />`
    : '';
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">${escaped}${pixel}</div>`;
}

function buildRawMime({ from, to, subject, htmlBody, textBody, inReplyTo, references }) {
  const boundary = `b_${crypto.randomBytes(8).toString('hex')}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const mime = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    textBody,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return Buffer.from(mime)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail({ to, subject, body, threadId, inReplyTo, references, trackingId }) {
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const senderName = process.env.SENDER_NAME || 'Jennifer';
  const senderEmail = process.env.SENDER_EMAIL;
  const from = `${senderName} <${senderEmail}>`;

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const pixelUrl = trackingId ? `${baseUrl}/track/open/${trackingId}.png` : null;
  const htmlBody = bodyToHtml(body, pixelUrl);

  const raw = buildRawMime({
    from,
    to,
    subject,
    htmlBody,
    textBody: body,
    inReplyTo,
    references,
  });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  });

  const message = await gmail.users.messages.get({
    userId: 'me',
    id: res.data.id,
    format: 'metadata',
    metadataHeaders: ['Message-Id', 'Subject'],
  });
  const headers = (message.data.payload && message.data.payload.headers) || [];
  const messageIdHeader = headers.find((h) => h.name.toLowerCase() === 'message-id');

  return {
    gmailMessageId: res.data.id,
    threadId: res.data.threadId,
    rfc822MessageId: messageIdHeader ? messageIdHeader.value : null,
  };
}

async function threadHasReply(threadId) {
  if (!threadId) return false;
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const senderEmail = (process.env.SENDER_EMAIL || '').toLowerCase();

  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From'],
  });

  const messages = thread.data.messages || [];
  for (const m of messages) {
    const headers = (m.payload && m.payload.headers) || [];
    const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from');
    if (!fromHeader) continue;
    const fromValue = fromHeader.value.toLowerCase();
    if (!fromValue.includes(senderEmail)) {
      return true;
    }
  }
  return false;
}

module.exports = { sendEmail, threadHasReply, newTrackingId };
