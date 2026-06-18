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

// Open-tracking pixel and unsubscribe endpoints live on a dedicated host so
// they look like an aligned part of the sending domain rather than a
// cross-domain remote fetch (a spam signal). Production should set
// TRACKING_BASE_URL=https://track.useinfluence.xyz. Falls back to
// PUBLIC_BASE_URL so dev/localhost keeps working.
function trackingBaseUrl() {
  const base = process.env.TRACKING_BASE_URL || process.env.PUBLIC_BASE_URL || '';
  return base.replace(/\/$/, '');
}

// Email Subject headers must be ASCII. "Smart" punctuation that templates or
// Claude emit — em/en dashes, curly quotes, ellipsis — otherwise lands as raw
// UTF-8 bytes in the header (which declares no charset) and renders as mojibake
// like "Ã¢Â€Â“" in many mail clients. Normalize that punctuation to plain ASCII,
// then RFC 2047-encode anything still non-ASCII (e.g. an accented name) so a
// subject can never garble.
function encodeSubject(subject) {
  const ascii = String(subject == null ? '' : subject)
    .replace(/[‐-―]/g, '-') // hyphen / figure / en / em / horizontal dashes
    .replace(/[‘’‚‛]/g, "'") // curly single quotes
    .replace(/[“”„‟]/g, '"') // curly double quotes
    .replace(/…/g, '...') // ellipsis
    .replace(/[  ]/g, ' '); // non-breaking spaces
  if (/[^\x00-\x7F]/.test(ascii)) {
    return `=?UTF-8?B?${Buffer.from(ascii, 'utf8').toString('base64')}?=`;
  }
  return ascii;
}

function buildRawMime({
  from,
  replyTo,
  to,
  subject,
  htmlBody,
  textBody,
  inReplyTo,
  references,
  listUnsubscribeUrl,
  listUnsubscribeMailto,
}) {
  const boundary = `b_${crypto.randomBytes(8).toString('hex')}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  // List-Unsubscribe + one-click POST (RFC 8058). Gmail + Yahoo show the
  // "Easy Unsubscribe" pip only when both headers are present and the URL
  // accepts POST without a body.
  if (listUnsubscribeUrl || listUnsubscribeMailto) {
    const parts = [];
    if (listUnsubscribeMailto) parts.push(`<${listUnsubscribeMailto}>`);
    if (listUnsubscribeUrl) parts.push(`<${listUnsubscribeUrl}>`);
    headers.push(`List-Unsubscribe: ${parts.join(', ')}`);
    if (listUnsubscribeUrl) {
      headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    }
  }

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

// Normalize a subject into a reply subject: strip any leading Re:/Fwd: and
// prefix a single "Re: ". Gmail groups a thread by its normalized subject, so
// replies must carry the thread's subject for the conversation to stay intact.
function asReply(subject) {
  const base = String(subject == null ? '' : subject)
    .replace(/^\s*(?:(?:re|fwd|fw)\s*:\s*)+/i, '')
    .trim();
  return base ? `Re: ${base}` : '';
}

// The subject of an existing Gmail thread (its oldest message = the outreach),
// used so replies into the thread reuse it. Best-effort: returns null on error.
async function getThreadSubject(gmail, threadId) {
  try {
    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['Subject'],
    });
    const messages = thread.data.messages || [];
    if (!messages.length) return null;
    const headers = (messages[0].payload && messages[0].payload.headers) || [];
    const h = headers.find((x) => x.name.toLowerCase() === 'subject');
    return h ? h.value : null;
  } catch (err) {
    console.warn(`[gmail] could not read thread subject for ${threadId}: ${err.message}`);
    return null;
  }
}

async function sendEmail({
  to,
  subject,
  body,
  threadId,
  inReplyTo,
  references,
  trackingId,
  listUnsubscribeUrl,
  listUnsubscribeMailto,
}) {
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const senderName = process.env.SENDER_NAME || 'Jennifer';
  const senderEmail = process.env.SENDER_EMAIL;
  const from = `${senderName} <${senderEmail}>`;

  const baseUrl = trackingBaseUrl();
  // Unbranded pixel path so naive "/track/" filters don't flag it. Served
  // by routes/tracking.js under the new mount.
  const pixelUrl = trackingId && baseUrl ? `${baseUrl}/o/${trackingId}.gif` : null;
  const rendered = renderRichBody(body);

  // Keep negotiation / follow-up emails inside the outreach conversation: when
  // sending into an existing thread, reuse that thread's subject (as "Re: …").
  // Gmail (and the recipient's client) only keep a message in a thread when the
  // subject matches — a different subject starts a separate conversation, which
  // is why offers/replies were landing in their own threads.
  let finalSubject = subject;
  if (threadId) {
    const base = await getThreadSubject(gmail, threadId);
    if (base) finalSubject = asReply(base);
  }

  const raw = buildRawMime({
    from,
    replyTo: senderEmail,
    to,
    subject: finalSubject,
    htmlBody: wrapHtml(rendered.html, pixelUrl),
    textBody: rendered.text,
    inReplyTo,
    references,
    listUnsubscribeUrl,
    listUnsubscribeMailto,
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

module.exports = { sendEmail, threadHasReply, getLatestInboundText, getThreadMessages, newTrackingId, encodeSubject, asReply };
