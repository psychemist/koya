-- ============================================================
-- 001_init — Koya Proposal Studio
--
-- Design notes that the table definitions themselves cannot express:
--
-- 1. A PROPOSAL IS NOT A BLOB. `proposal_sections` holds one row per section,
--    which is what makes "regenerate section 4 without losing the rest"
--    a one-row UPDATE rather than a careful merge. Every prior state of every
--    section lives in `section_versions`, append-only, so a regeneration is
--    always recoverable and the audit trail shows who wrote what.
--
-- 2. STATUS TRANSITIONS ARE GUARDED BY `version`. Every state change is
--    UPDATE ... WHERE id = $1 AND status = $2 AND version = $3, so a
--    double-clicked Approve button, a retried request, or two reviewers acting
--    at once produce one transition and one loser who is told why. This is the
--    "safe to run more than once" requirement, enforced by the database rather
--    than by hoping the UI disables a button.
--
-- 3. MONEY IS INTEGER MICRO-DOLLARS. A proposal's Claude spend is often a
--    fraction of a cent; cents would round it to zero and make the cost story
--    a lie. `cost_micro_usd` is millionths of a USD, summed exactly.
--
-- 4. SECRETS AND TOKENS ARE STORED HASHED. `sessions.id` and
--    `share_links.token_hash` hold SHA-256 of the value in the cookie or URL,
--    never the value itself, so a database dump does not hand over live
--    sessions or live client-facing proposal links.
--
-- 5. NATURAL UNIQUE KEYS DO THE DEDUPING. Uploading the same file twice, or
--    re-running gap detection, or retrying a send, all collide on a UNIQUE
--    constraint instead of quietly inserting a second row. Idempotency is a
--    schema property here, not application etiquette.
--
-- Enumerations are TEXT + CHECK rather than Postgres ENUM types: adding a
-- value to an ENUM inside a transaction that also uses it is awkward, and
-- these sets will grow.
-- ============================================================

-- gen_random_uuid() and digest() live here on Neon.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- People and sessions
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('salesperson', 'approver', 'admin')),
  -- scrypt, serialised as scrypt$N$r$p$<salt-b64>$<key-b64>. node:crypto only,
  -- so there is no native module to fail a serverless cold start.
  password_hash text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without the citext extension: sign-in lowercases
-- before lookup, and this index makes a differently-cased duplicate impossible.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  -- SHA-256 of the opaque token in the cookie. Stolen database, dead sessions.
  id           text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip           text
);

CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx  ON sessions (expires_at);

-- ------------------------------------------------------------
-- Proposals
-- ------------------------------------------------------------

-- A global sequence, not a per-year counter: two proposals created in the same
-- millisecond cannot collide, and the human-facing ref stays short.
CREATE SEQUENCE IF NOT EXISTS proposal_ref_seq START 1;

CREATE TABLE IF NOT EXISTS proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref          text NOT NULL UNIQUE,          -- KOY-2026-0042
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'generating', 'review',
                                   'pending_approval', 'changes_requested',
                                   'approved', 'sent', 'delivery_failed')),
  -- Bumped on every mutation. The optimistic-concurrency guard described above.
  version      integer NOT NULL DEFAULT 1,
  author_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approver_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  title        text,
  intake       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- sha256 of the canonicalised intake. Lets the app tell "nothing changed"
  -- from "changed" without diffing eleven fields by hand.
  intake_hash  text,
  -- sha256(intake + source texts + prompt version + model). A generation
  -- request whose hash already matches is served from the database for zero
  -- tokens; "Regenerate anyway" is the explicit override.
  content_hash text,
  currency     text NOT NULL DEFAULT 'USD',
  -- Cumulative Claude spend, millionths of a USD. See design note 3.
  cost_micro_usd bigint NOT NULL DEFAULT 0,
  -- Idempotency key from the intake form. A replayed submit returns the same
  -- proposal instead of creating a second one.
  idempotency_key text,
  submitted_at timestamptz,
  approved_at  timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS proposals_idempotency_key
  ON proposals (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposals_status_idx  ON proposals (status);
CREATE INDEX IF NOT EXISTS proposals_author_idx  ON proposals (author_id);
CREATE INDEX IF NOT EXISTS proposals_updated_idx ON proposals (updated_at DESC);

CREATE TABLE IF NOT EXISTS proposal_sections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id  uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  key          text NOT NULL,
  heading      text NOT NULL,
  body_md      text NOT NULL DEFAULT '',
  position     integer NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  -- Set once a human touches the text, so a later full regeneration can warn
  -- before it overwrites hand-written work.
  edited_by_human boolean NOT NULL DEFAULT false,
  generated_by_ai_call_id uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, key)
);

CREATE INDEX IF NOT EXISTS proposal_sections_order_idx
  ON proposal_sections (proposal_id, position);

CREATE TABLE IF NOT EXISTS section_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  uuid NOT NULL REFERENCES proposal_sections(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  heading     text NOT NULL,
  body_md     text NOT NULL,
  origin      text NOT NULL CHECK (origin IN ('ai_draft', 'ai_regeneration',
                                              'human_edit', 'revert')),
  -- The salesperson's own words when they asked for a rewrite. Worth keeping:
  -- it is the record of what was asked for, not just what came back.
  instruction text,
  ai_call_id  uuid,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (section_id, version)
);

CREATE INDEX IF NOT EXISTS section_versions_proposal_idx
  ON section_versions (proposal_id, created_at DESC);

-- ------------------------------------------------------------
-- Supporting material
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id    uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  mime           text NOT NULL,
  byte_size      integer NOT NULL,
  sha256         text NOT NULL,
  page_count     integer,
  extracted_text text NOT NULL DEFAULT '',
  -- 'empty' is its own outcome and not an error: a scanned PDF with no text
  -- layer extracts cleanly to nothing, and the user needs to be told that
  -- rather than watching it silently contribute nothing to the proposal.
  extract_status text NOT NULL DEFAULT 'pending'
                   CHECK (extract_status IN ('pending', 'ok', 'empty',
                                             'unsupported', 'failed')),
  extract_error  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The same file uploaded twice is one source. Content-addressed, so a
  -- renamed copy dedupes too.
  UNIQUE (proposal_id, sha256)
);

CREATE INDEX IF NOT EXISTS sources_proposal_idx ON sources (proposal_id);

CREATE TABLE IF NOT EXISTS citations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES proposal_sections(id) ON DELETE CASCADE,
  source_id  uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  quote      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS citations_section_idx ON citations (section_id);

-- ------------------------------------------------------------
-- Gaps — the missing-information mechanism
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gaps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id  uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  section_key  text,
  field        text,
  -- 'blocking' gaps make the approve endpoint refuse, server-side. That is the
  -- teeth behind "do not make unsupported assumptions": the system would
  -- rather visibly stop than quietly invent a number.
  severity     text NOT NULL CHECK (severity IN ('blocking', 'advisory')),
  message      text NOT NULL,
  detected_by  text NOT NULL CHECK (detected_by IN ('validator', 'model', 'grounding')),
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'resolved', 'waived')),
  -- A waiver is a decision, so it is recorded like one: who, when, and why in
  -- their own words. An unexplained waiver is not accepted.
  waiver_reason text,
  resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  timestamptz,
  -- Stable hash of (section_key, field, message). Re-running detection
  -- refreshes existing gaps instead of stacking duplicates on every pass.
  fingerprint  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, fingerprint),
  CONSTRAINT gaps_waiver_needs_reason
    CHECK (status <> 'waived' OR (waiver_reason IS NOT NULL AND length(btrim(waiver_reason)) >= 10))
);

CREATE INDEX IF NOT EXISTS gaps_proposal_status_idx ON gaps (proposal_id, status);

-- ------------------------------------------------------------
-- Approval
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision    text NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approvals_proposal_idx ON approvals (proposal_id, created_at DESC);

-- ------------------------------------------------------------
-- Delivery
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id   uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  -- Which lane actually delivered. Lane A is the n8n workflow, lane B is a
  -- direct Resend call, and manual_eml is the honest fallback when neither is
  -- configured: the app hands over a .eml rather than pretending it sent.
  channel       text NOT NULL CHECK (channel IN ('n8n', 'resend', 'manual_eml')),
  recipient     text NOT NULL,
  subject       text NOT NULL,
  body_text     text NOT NULL,
  -- Shared by BOTH lanes, which is what makes failover safe: if lane A partly
  -- succeeded before timing out, lane B collides here instead of sending a
  -- second copy to the client.
  idempotency_key text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sent', 'failed', 'blocked')),
  provider_message_id text,
  error_code    text,
  error_detail  text,
  attempts      integer NOT NULL DEFAULT 0,
  -- One entry per lane tried, with its outcome and latency. This is what the
  -- System page reads to explain a failure without a log dive.
  lane_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

CREATE INDEX IF NOT EXISTS deliveries_proposal_idx ON deliveries (proposal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_status_idx   ON deliveries (status);

CREATE TABLE IF NOT EXISTS share_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id    uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  -- SHA-256 of the token in the URL. See design note 4.
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  view_count     integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_links_proposal_idx ON share_links (proposal_id);

-- ------------------------------------------------------------
-- Observability — the two tables that make failures debuggable
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  id             bigserial PRIMARY KEY,
  -- Echoed to the browser as X-Correlation-Id and shown in error toasts, so a
  -- user can quote the id that finds this exact row.
  correlation_id text NOT NULL,
  actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  proposal_id    uuid REFERENCES proposals(id) ON DELETE CASCADE,
  action         text NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('ok', 'error', 'denied', 'skipped')),
  latency_ms     integer,
  error_code     text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_correlation_idx ON events (correlation_id);
CREATE INDEX IF NOT EXISTS events_proposal_idx    ON events (proposal_id, at DESC);
CREATE INDEX IF NOT EXISTS events_at_idx          ON events (at DESC);
-- Partial index: the System page's first question is always "what broke".
CREATE INDEX IF NOT EXISTS events_failures_idx    ON events (at DESC)
  WHERE outcome IN ('error', 'denied');

CREATE TABLE IF NOT EXISTS ai_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id    uuid REFERENCES proposals(id) ON DELETE CASCADE,
  correlation_id text,
  purpose        text NOT NULL CHECK (purpose IN ('draft', 'section_regen',
                                                  'gap_analysis', 'grounding_judge')),
  model          text NOT NULL,
  effort         text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cache_creation_tokens integer NOT NULL DEFAULT 0,
  -- Asserted non-zero by the test suite on the second call of a pair. A silent
  -- cache invalidator triples the bill without changing a single output, and
  -- this column is the only place that shows up.
  cache_read_tokens     integer NOT NULL DEFAULT 0,
  cost_micro_usd bigint NOT NULL DEFAULT 0,
  latency_ms     integer,
  stop_reason    text,
  attempts       integer NOT NULL DEFAULT 1,
  prompt_version text NOT NULL,
  -- True when the request never left the building: the content hash already
  -- matched, so the stored result was reused. Zero tokens, zero dollars.
  cache_hit      boolean NOT NULL DEFAULT false,
  error_code     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_calls_proposal_idx ON ai_calls (proposal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_calls_created_idx  ON ai_calls (created_at DESC);

-- ------------------------------------------------------------
-- Views for the System page
-- ------------------------------------------------------------

-- Per-proposal spend and token totals, cache hits excluded from the call count
-- so "3 calls, $0.04" means three requests that actually cost money.
CREATE OR REPLACE VIEW proposal_ai_spend AS
SELECT
  p.id                                        AS proposal_id,
  p.ref,
  count(a.id) FILTER (WHERE NOT a.cache_hit)  AS billed_calls,
  count(a.id) FILTER (WHERE a.cache_hit)      AS cache_hits,
  coalesce(sum(a.input_tokens), 0)            AS input_tokens,
  coalesce(sum(a.output_tokens), 0)           AS output_tokens,
  coalesce(sum(a.cache_read_tokens), 0)       AS cache_read_tokens,
  coalesce(sum(a.cost_micro_usd), 0)          AS cost_micro_usd
FROM proposals p
LEFT JOIN ai_calls a ON a.proposal_id = p.id
GROUP BY p.id, p.ref;

-- The last 200 things that went wrong, newest first.
CREATE OR REPLACE VIEW recent_failures AS
SELECT e.id, e.at, e.correlation_id, e.action, e.outcome, e.error_code,
       e.latency_ms, e.detail, p.ref AS proposal_ref, u.email AS actor_email
FROM events e
LEFT JOIN proposals p ON p.id = e.proposal_id
LEFT JOIN users u     ON u.id = e.actor_id
WHERE e.outcome IN ('error', 'denied')
ORDER BY e.at DESC
LIMIT 200;
