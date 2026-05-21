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

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  access_token  TEXT,
  refresh_token TEXT,
  expiry_date   BIGINT,
  scope         TEXT,
  token_type    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
