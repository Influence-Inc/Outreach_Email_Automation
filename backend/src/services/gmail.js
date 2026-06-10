const crypto = require('crypto');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('./oauth');
const { renderRichBody } = require('./richBody');

function newTrackingId() {
  return crypto.randomBytes(12).toString('hex');
}

function wrapHtml(innerHtml, trackingPixelUrl) {
  const pixel = trackingPixelUrl
    ? `<img src="${trackingPixelUrl}" width="1" height="1" alt="" style="display:block;border:0;outline:none;" />`
    : '';
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">${innerHtml}${pixel}</div>`;
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
  const rendered = renderRichBody(body);

  const raw = buildRawMime({
    from,
    to,
    subject,
    htmlBody: wrapHtml(rendered.html, pixelUrl),
    textBody: rendered.text,
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

function decodeB64Url(data) {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Depth-first search for the first body part of a given MIME type.
function findPartData(payload, mime) {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body && payload.body.data) return payload.body.data;
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) {
      const r = findPartData(p, mime);
      if (r) return r;
    }
  }
  return null;
}

function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// Strip quoted reply history and signatures so Claude sees only the new text.
function stripQuotedHistory(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    // Gmail/Apple/Outlook "On <date>, <person> wrote:" boundary.
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && out.length) break;
    if (/^\s*>/.test(line)) continue; // quoted line
    out.push(line);
  }
  let result = out.join('\n').trim();
  // Drop a trailing "-- " signature block if present.
  result = result.replace(/\n-- \n[\s\S]*$/, '').trim();
  return result;
}

// Newest inbound (non-sender) message in a thread, as plain text with quoted
// history stripped. Returns { messageId, rfc822MessageId, text } or null.
async function getLatestInboundText(threadId) {
  if (!threadId) return null;
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const senderEmail = (process.env.SENDER_EMAIL || '').toLowerCase();

  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const messages = thread.data.messages || [];

  let latest = null;
  for (const m of messages) {
    const headers = (m.payload && m.payload.headers) || [];
    const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from');
    const fromValue = fromHeader ? fromHeader.value.toLowerCase() : '';
    if (senderEmail && fromValue.includes(senderEmail)) continue; // our own message
    latest = m; // messages are chronological; keep overwriting to land on the newest inbound
  }
  if (!latest) return null;

  const headers = (latest.payload && latest.payload.headers) || [];
  const msgIdHeader = headers.find((h) => h.name.toLowerCase() === 'message-id');

  let raw = null;
  const plain = findPartData(latest.payload, 'text/plain');
  if (plain) {
    raw = decodeB64Url(plain);
  } else {
    const html = findPartData(latest.payload, 'text/html');
    if (html) raw = htmlToText(decodeB64Url(html));
  }
  if (raw == null) raw = latest.snippet || '';

  return {
    messageId: latest.id,
    rfc822MessageId: msgIdHeader ? msgIdHeader.value : null,
    text: stripQuotedHistory(raw),
  };
}

// All messages in a thread, chronological, decoded to plain text. Used by the
// dashboard's per-creator thread dropdown. Returns
// [{ id, fromName, from, date, subject, direction, text }].
async function getThreadMessages(threadId) {
  if (!threadId) return [];
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const senderEmail = (process.env.SENDER_EMAIL || '').toLowerCase();

  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const messages = thread.data.messages || [];

  return messages.map((m) => {
    const headers = (m.payload && m.payload.headers) || [];
    const get = (name) => {
      const h = headers.find((x) => x.name.toLowerCase() === name);
      return h ? h.value : '';
    };
    const fromRaw = get('from');
    const fromValue = fromRaw.toLowerCase();
    const direction = senderEmail && fromValue.includes(senderEmail) ? 'outbound' : 'inbound';
    // "Jennifer <j@x.com>" -> "Jennifer"; bare address -> the address.
    const nameMatch = fromRaw.match(/^\s*"?([^"<]*?)"?\s*<.+>\s*$/);
    const fromName = (nameMatch ? nameMatch[1].trim() : fromRaw.trim()) || fromRaw.trim();

    let raw = null;
    const plain = findPartData(m.payload, 'text/plain');
    if (plain) {
      raw = decodeB64Url(plain);
    } else {
      const html = findPartData(m.payload, 'text/html');
      if (html) raw = htmlToText(decodeB64Url(html));
    }
    if (raw == null) raw = m.snippet || '';

    return {
      id: m.id,
      fromName,
      from: fromRaw,
      date: get('date') || null,
      subject: get('subject') || '',
      direction,
      text: stripQuotedHistory(raw),
    };
  });
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

module.exports = { sendEmail, threadHasReply, getLatestInboundText, getThreadMessages, newTrackingId };
