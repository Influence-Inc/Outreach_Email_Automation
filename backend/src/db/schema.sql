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

-- When the lead was ENROLLED into its Instantly campaign (the "Send outreach"
-- click). Instantly sends the actual Step 1 email later on its own schedule, so
-- enrollment is NOT the same as the email having gone out. The row sits in
-- status 'outreach_queued' from this moment until Instantly's email_sent webhook
-- confirms the send, at which point outreach_sent_at is stamped and the status
-- advances to 'outreach_sent'. Keeping the two timestamps distinct is what lets
-- the dashboard show "Outreach sent" only once the email has truly been sent.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS outreach_queued_at TIMESTAMPTZ;

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
-- Every rate the creator has quoted, as they gave them — creators frequently
-- send tiered / multi-option pricing in one reply (e.g. "$3.5k for 300k views
-- / $5k for 600k / $7.5k for 1M", or "$900 per reel or $2,500 for a package
-- of 3"). Kept as an ordered array of `{ amount, label }` objects so the
-- Status column can show every option. `quoted_rate` remains the single
-- primary number used for offer-pricing math.
ALTER TABLE creators  ADD COLUMN IF NOT EXISTS quoted_rate_options JSONB;
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
-- Who to greet in our replies. Usually the creator's first name, but when a
-- manager/agent replies on their behalf we detect and store that person's
-- first name here so later emails (e.g. the admin-approved offer, sent after
-- the inbound text has been consumed) still greet the right person.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS reply_salutation TEXT;
-- The connected Instantly mailbox that handled the conversation (the webhook's
-- email_account). Required as `eaccount` when sending a threaded reply via
-- POST /api/v2/emails/reply.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS instantly_email_account TEXT;
-- The exact subject of the creator's reply (the webhook's reply_subject). Echoed
-- verbatim when we reply so Gmail keeps the whole exchange in ONE thread — a
-- changed subject makes Gmail split off a new conversation even with In-Reply-To.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS instantly_reply_subject TEXT;
-- Everyone else on the creator's most recent inbound email — its To + Cc lists
-- minus our sending mailbox and the sender — as a comma-separated lowercase
-- list. Echoed as cc_address_email_list on our threaded replies so a
-- manager/agent (or the creator themselves, when an agent replied on their
-- behalf) is never dropped from the thread. '' means computed-and-empty
-- (nobody else on the thread); NULL means not captured yet (row predates cc
-- capture) — the sender then recovers the list from the Instantly email object.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS instantly_reply_cc TEXT;
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

-- Continuous-learning bank for the negotiation model. Each row is one labeled
-- (creator inbound → manager outbound) pair that replyExamples.js serves as a
-- few-shot demonstration to Claude. Replaces the ephemeral
-- data/harvested_examples.json file (which vanished on every redeploy).
-- Sources:
--   'harvest'  — periodic sweep of the connected mailbox via the Instantly API
--   'delegate' — a human's reply from the Delegate window (the highest-value
--                signal: it teaches the model answers to the exact questions
--                it previously escalated)
--   'manual'   — inserted by hand (SQL / future admin UI)
CREATE TABLE IF NOT EXISTS reply_examples (
  id                   TEXT PRIMARY KEY,
  source               TEXT NOT NULL DEFAULT 'harvest',
  expected_action      TEXT NOT NULL,
  expected_quoted_rate NUMERIC(12,2),
  stage                TEXT,
  inbound              TEXT NOT NULL,
  outbound_subject     TEXT,
  outbound_body        TEXT,
  notes                TEXT,
  creator_id           INTEGER REFERENCES creators(id) ON DELETE SET NULL,
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reply_examples_enabled ON reply_examples(enabled) WHERE enabled;

-- Creator Contracts. One row per generated contract. The public signing page is
-- reached ONLY by `token` (a securely-random, unguessable id) — the SERIAL `id`
-- is never exposed. `data` holds the Claude-extracted, campaign-specific contract
-- fields; `submission` holds what the creator submitted when signing. Lifecycle:
--   pending  — generated + emailed, awaiting the creator's signature
--   signed   — creator submitted the signed contract
--   completed— signed + synced into the Creator Database
-- The audit trail lives in email_events (contract_created / contract_sent /
-- contract_signed / contract_synced), so the dashboard timeline shows each step.
CREATE TABLE IF NOT EXISTS contracts (
  id                   SERIAL PRIMARY KEY,
  token                TEXT NOT NULL UNIQUE,
  creator_id           INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  campaign_id          TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending',   -- pending | signed | completed
  data                 JSONB NOT NULL,                    -- extracted contract fields (structured JSON)
  submission           JSONB,                             -- captured signing payload
  signer_name          TEXT,
  signer_email         TEXT,
  signer_ip            TEXT,
  signed_at            TIMESTAMPTZ,
  synced_to_creator_db BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contracts_creator_id ON contracts(creator_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

-- Brand-POC approval gate on contracts. An accepted deal no longer fires the
-- contract email directly: it parks in the Delegate window until the team has
-- the brand POC's go-ahead and approves it there (POST /:id/approve-contract).
-- Only then is the contract generated + emailed. FALSE = approval pending.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS contract_approved BOOLEAN NOT NULL DEFAULT FALSE;
-- Deals accepted before this gate existed already had their contract generated
-- and sent on acceptance — mark them approved so they don't resurface in the
-- Delegate window as pending approvals. Idempotent (a no-op after it first runs).
UPDATE creators SET contract_approved = TRUE
 WHERE NOT contract_approved
   AND EXISTS (SELECT 1 FROM contracts ct WHERE ct.creator_id = creators.id);

-- Per-campaign usage-rights policy, replacing the old per-campaign Max CPM
-- dashboard control. Governs whether the generated contract includes paid ad
-- rights, and whether Reply 1 tells the creator no ad rights are needed.
-- Validated at the application layer (routes/campaigns.js), not here, to keep
-- the enum easy to extend without a migration.
--   no_rights  — ad rights never requested; Reply 1 states none are required
--                (this is the pre-existing default behavior for every campaign)
--   free_only  — ad rights included in the contract unless the creator asks
--                for separate payment for them (see contracts.js); dropped
--                automatically if the creator disputes usage rights after the
--                contract is sent (see negotiation.js)
--   required   — ad rights are always included in the contract
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS usage_rights_policy TEXT NOT NULL DEFAULT 'no_rights';

-- Full email conversation, one row per message, persisted as each email is sent
-- or received. Purpose: give the contract extractor (contracts.js) the WHOLE
-- back-and-forth — where the creator states which platforms they'll post on,
-- the deliverables they agreed to, timelines, etc. — instead of only the single
-- most recent inbound reply (creators.latest_inbound_text). Written best-effort
-- by the reply webhook (inbound) and sendNegotiationEmail (outbound); a failure
-- here never blocks sending/receiving. `kind` mirrors the sendNegotiationEmail
-- kind for outbound rows (reply1 / offer / contract / …), NULL for inbound.
CREATE TABLE IF NOT EXISTS email_messages (
  id          SERIAL PRIMARY KEY,
  creator_id  INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL,                 -- 'inbound' (creator) | 'outbound' (us)
  kind        TEXT,                          -- outbound send kind; NULL for inbound
  subject     TEXT,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_messages_creator ON email_messages(creator_id, created_at, id);

-- A one-line, Claude-generated recap of this message, shown in the dashboard's
-- Rate-column timeline instead of a bare "Replied" or the raw opening sentence.
-- Generated lazily and cached here (see routes/creators.js attachRateLog) so the
-- LLM runs at most once per message, never on every dashboard read. NULL until
-- generated; the timeline falls back to the deterministic gist meanwhile.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS summary TEXT;
