'use strict';

// Delivery-status plumbing for the offer-portal messaging channels. Providers
// report delivered/read/failed differently: Linq (iMessage) emits a
// message.<status> event, while AiSensy/Meta (WhatsApp) send an explicit
// `status` field. Both the send-response message id and the status callbacks are
// parsed defensively — like inbound replies, the exact schema isn't stable, so
// the raw payload is captured (see offer_messages.raw_payload) for verification.

// Linq message.<status> event → our canonical status.
const STATUS_BY_EVENT = {
  'message.sent': 'sent',
  'message.delivered': 'delivered',
  'message.read': 'read',
  'message.failed': 'failed',
  'message.undelivered': 'failed',
};

// Event names that mean "a new inbound message" (a reply), NOT a status update.
const NEW_MESSAGE_EVENTS = new Set(['message.created', 'message.received', 'message.inbound', 'message.new']);

const KNOWN_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

const getStr = (o, k) => (o && typeof o === 'object' && typeof o[k] === 'string' ? o[k] : null);

function eventOf(payload) {
  // Only event_type/event — never the bare `type` (AiSensy's message content
  // type, e.g. "text"), which is not an event kind.
  return getStr(payload, 'event_type') || getStr(payload, 'event') || null;
}

// The provider's id for a message we SENT, read from the send-response body so a
// later status callback can be correlated back to the outbound offer_messages row.
function extractProviderMessageId(data) {
  if (!data || typeof data !== 'object') return null;
  const d = data.data && typeof data.data === 'object' ? data.data : data;
  const msg = d.message && typeof d.message === 'object' ? d.message : null;
  return (
    getStr(d, 'id') ||
    getStr(d, 'message_id') ||
    getStr(d, 'messageId') ||
    (msg && (getStr(msg, 'id') || getStr(msg, 'message_id'))) ||
    getStr(data, 'id') ||
    getStr(data, 'message_id') ||
    null
  );
}

// A delivery-status callback → { providerMessageId, status }, or null when the
// payload is not a status event (e.g. it's an inbound reply, which the caller
// should route to parseInbound instead).
function parseStatusEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const evt = eventOf(payload);
  // A new inbound message is never a status update.
  if (evt && NEW_MESSAGE_EVENTS.has(evt.toLowerCase())) return null;

  const d = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  // Linq-style: a message.<status> event.
  let status = evt ? STATUS_BY_EVENT[evt.toLowerCase()] || null : null;

  // Meta/AiSensy-style: an explicit status field.
  if (!status) {
    const s = (getStr(d, 'status') || getStr(payload, 'status') || '').toLowerCase();
    if (KNOWN_STATUSES.has(s)) status = s;
  }
  if (!status) return null;

  const msg = d.message && typeof d.message === 'object' ? d.message : null;
  const providerMessageId =
    getStr(d, 'message_id') ||
    getStr(d, 'messageId') ||
    getStr(d, 'id') ||
    (msg && (getStr(msg, 'id') || getStr(msg, 'message_id'))) ||
    getStr(payload, 'message_id') ||
    getStr(payload, 'id') ||
    null;

  return { providerMessageId, status };
}

module.exports = {
  STATUS_BY_EVENT,
  NEW_MESSAGE_EVENTS,
  KNOWN_STATUSES,
  eventOf,
  extractProviderMessageId,
  parseStatusEvent,
};
