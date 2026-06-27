-- Idempotent schema. Safe to run on every backend boot.
-- For a destructive reset, use `npm run reset-db`.

CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT PRIMARY KEY,           -- upstream id from campaigns.influence.technology
  name         TEXT NOT NULL,
  brand_name   TEXT NOT NULL,
  slug         TEXT,
  data         JSONB,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_brand_name ON campaigns(brand_name);

CREATE TABLE IF NOT EXISTS creators (
  id                 SERIAL PRIMARY KEY,
  campaign_id        TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  instagram_url      TEXT NOT NULL,
  instagram_username TEXT,
  first_name         TEXT,
  full_name          TEXT,
  email              TEXT,
  status             TEXT NOT NULL DEFAULT 'pending_extraction',
  outreach_message_id TEXT,
  outreach_thread_id  TEXT,
  outreach_sent_at    TIMESTAMPTZ,
  followup_message_id TEXT,
  followup_sent_at    TIMESTAMPTZ,
  last_open_at        TIMESTAMPTZ,
  open_count          INTEGER NOT NULL DEFAULT 0,
  replied_at          TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, instagram_url)
);
CREATE INDEX IF NOT EXISTS idx_creators_status ON creators(status);
CREATE INDEX IF NOT EXISTS idx_creators_outreach_sent_at ON creators(outreach_sent_at);

CREATE TABLE IF NOT EXISTS email_events (
  id           SERIAL PRIMARY KEY,
  creator_id   INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  message_id   TEXT,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_events_creator_id ON email_events(creator_id);

-- Named follow-up sequences (library). Each step has a delay-from-previous
-- in hours. The per-step subject/body lives on the campaign, not here, so the
-- same sequence can be reused across campaigns with different copy.
CREATE TABLE IF NOT EXISTS follow_up_sequences (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{delayHours: int, label?: string}, ...]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-campaign extensions. Added separately so the upstream sync upsert
-- (which only touches name/brand_name/slug/data) doesn't clobber them.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sequence_id INTEGER REFERENCES follow_up_sequences(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS templates JSONB NOT NULL DEFAULT '{}'::jsonb;
  -- shape: { outreach: {subject, body}, followups: [{subject, body}, ...] }

-- Track which follow-up step a creator is on. 0 = no follow-ups sent yet.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS followup_step INTEGER NOT NULL DEFAULT 0;

-- Seed the legacy single-bump cadence as a visible "Default" sequence so it
-- shows up in the sidebar / campaign picker. Idempotent.
INSERT INTO follow_up_sequences (name, steps)
VALUES ('Default (48h follow-up)', '[{"delayHours":48,"label":"First bump"}]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- New unified Email Templates model. Each template bundles the outreach
-- email + a list of follow-up steps; each step has its own delayHours,
-- subject, and body. Supersedes the older follow_up_sequences +
-- per-campaign templates JSONB design (those columns remain unused for
-- now and can be dropped in a later migration).
CREATE TABLE IF NOT EXISTS email_templates (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  outreach    JSONB NOT NULL DEFAULT '{"subject":"","body":""}'::jsonb,
  followups   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- [{delayHours: int, label?: string, subject?: string, body?: string}, ...]
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one template can be marked default at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_templates_one_default
  ON email_templates ((TRUE)) WHERE is_default;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL;

-- Creator Negotiation. Rebuilt inside this app (no separate worker). All
-- columns are added idempotently so this stays "safe to run on every boot".
-- Negotiation has its own `negotiation_status` lifecycle, independent of the
-- outreach `status` column.
--   AWAITING_RATE | AWAITING_APPROVAL | AWAITING_DECISION | ACCEPTED | DECLINED | CLOSED
--   (NULL = not in negotiation)
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS negotiation_status TEXT;
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS quoted_rate NUMERIC(10,2);
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS ig_scraped_data JSONB;
  -- {p10,p25,p50,p75,reel_count,min_views,views_raw:[...]}
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS suggested_offers JSONB;
  -- array of offer objects (shape in pricing.js)
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS selected_offer_id TEXT;
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS custom_offer JSONB;
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS offer_approved BOOLEAN DEFAULT FALSE;
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS negotiation_followup_count INTEGER DEFAULT 0;
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS last_negotiation_msg_id TEXT;
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS last_negotiation_email_at TIMESTAMPTZ;

-- Per-campaign CPM ceiling. Nullable; falls back to env TARGET_CPM.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_cpm NUMERIC(6,2);

CREATE INDEX IF NOT EXISTS idx_creators_negotiation_status ON creators(negotiation_status);

-- Per-template AI auto-reply switch. When FALSE, Claude never auto-replies for
-- creators on this template — every reply is routed to the Delegate queue for a
-- human. Defaults TRUE to preserve the existing auto-reply behavior.
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS ai_replies_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Global key/value settings. Holds the universal negotiation "Guidelines"
-- prompt (key = 'negotiation_guidelines') and any future app-wide settings.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Delegation queue: replies/situations a human must handle. Set when a
-- creator's template has AI replies off, or when Claude escalates a reply it
-- can't confidently handle. Cleared when an admin sends a reply or dismisses it.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS needs_human       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS delegate_reason   TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS delegate_question TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS delegated_at      TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_creators_needs_human ON creators(needs_human) WHERE needs_human;

-- Instantly.ai hybrid integration. reply_to_uuid is Instantly's thread handle,
-- used to send threaded negotiation replies via POST /api/v2/emails/reply.
-- latest_inbound_text holds the creator's most recent reply text, written by
-- the /webhook/instantly handler and consumed by negotiation.processReply().
ALTER TABLE creators ADD COLUMN IF NOT EXISTS instantly_reply_uuid TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS latest_inbound_text  TEXT;
-- The connected Instantly mailbox that handled the conversation (the webhook's
-- email_account). Required as `eaccount` when sending a threaded reply via
-- POST /api/v2/emails/reply.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS instantly_email_account TEXT;
-- The webhook resolves replies by case-insensitive email; index the expression.
CREATE INDEX IF NOT EXISTS idx_creators_lower_email ON creators(LOWER(email));

-- The Instantly.ai campaign each creator in this dashboard campaign is added to
-- for outreach + follow-up sending. Lets every brand/campaign use its own
-- Instantly campaign (its own subject/body/sequence). Falls back to the
-- INSTANTLY_CAMPAIGN_ID env var when NULL. Copy the UUID from the campaign URL
-- in the Instantly dashboard. Added here (not in the upstream-synced columns) so
-- the campaigns sync upsert never clobbers it.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS instantly_campaign_id TEXT;

-- Suppression list. Any address in here is skipped by sendOutreach / sendFollowup.
-- Populated by the /unsubscribe endpoint (RFC 8058 one-click + GET confirmation
-- page), by bounce handling, and by manual admin action.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email         TEXT PRIMARY KEY,
  reason        TEXT NOT NULL,                       -- 'unsubscribed' | 'bounced' | 'complained' | 'manual'
  creator_id    INTEGER REFERENCES creators(id) ON DELETE SET NULL,
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
