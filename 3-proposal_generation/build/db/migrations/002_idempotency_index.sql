-- ============================================================
-- 002_idempotency_index
--
-- Fixes a real bug found the first time two proposals were created.
--
-- 001 created the idempotency index as a PARTIAL index:
--
--   CREATE UNIQUE INDEX proposals_idempotency_key
--     ON proposals (idempotency_key) WHERE idempotency_key IS NOT NULL;
--
-- and `createProposal` relies on `ON CONFLICT (idempotency_key) DO NOTHING`
-- to make a double-submit idempotent. Postgres refuses that combination with
--
--   42P10: there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- because inferring a partial index requires the statement to repeat the
-- index's predicate. So the whole idempotency guarantee was failing closed —
-- loudly, which is the good version of this bug, but failing.
--
-- The predicate was never needed. A plain UNIQUE index in Postgres treats
-- NULLs as distinct, so any number of proposals with no idempotency key
-- coexist happily under it. Dropping the predicate makes `ON CONFLICT
-- (idempotency_key)` inferable and changes nothing else.
--
-- Written as a new migration rather than an edit to 001, because 001 has
-- already been applied and the runner's checksum comparison would — correctly —
-- refuse to continue against a database whose history no longer matches the
-- repository.
-- ============================================================

DROP INDEX IF EXISTS proposals_idempotency_key;

CREATE UNIQUE INDEX IF NOT EXISTS proposals_idempotency_key
  ON proposals (idempotency_key);
