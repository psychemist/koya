-- ============================================================
-- 003_rate_limits
--
-- A fixed-window counter, in the database rather than in memory.
--
-- The obvious implementation of a rate limiter is a Map in module scope. That
-- limiter does nothing here. Every route in this application runs on Vercel's
-- serverless runtime, where each concurrent request may land in a different
-- instance with its own fresh module scope — so an in-memory counter limits
-- one instance to N and the deployment as a whole to N times however many
-- instances the platform decided to start. The only counter that is shared by
-- everything that needs to agree is the one in Postgres.
--
-- Fixed window, not a token bucket or a sliding log. A fixed window is one
-- upsert and one comparison per request, and its known weakness — up to 2x the
-- nominal rate across a window boundary — is irrelevant for the two things
-- being protected here: the cost of Claude calls, and password guessing. Both
-- care about the order of magnitude, not the exact edge.
--
-- The row is the unit of contention, and the key is scoped narrowly (one user,
-- one action, one window) so two different users never touch the same row.
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limits (
  -- bucket = sha256(scope + subject + window start). Opaque on purpose: the
  -- subject can be an email address or an IP, and neither belongs in a table
  -- that exists only to count.
  bucket       text        PRIMARY KEY,
  scope        text        NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Expired buckets are swept opportunistically from the health endpoint. Without
-- this index that sweep degrades into a sequential scan of every bucket ever
-- created, which is exactly the sort of slow background query that eventually
-- takes a small database down.
CREATE INDEX IF NOT EXISTS rate_limits_expires_idx ON rate_limits (expires_at);
