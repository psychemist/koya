-- ============================================================
-- 004_scanner_gap_source
--
-- Adds 'scanner' to the set of things that can raise a gap.
--
-- Uploaded documents are now scanned for hidden characters and for text that
-- addresses the model rather than describing the client (see lib/sanitise.ts),
-- and a flagged file becomes an advisory gap so a reviewer sees it.
--
-- It needs a detector value of its own, and the reason is `syncGaps`. That
-- function reconciles: after upserting the candidates it is given, it closes
-- every OTHER open gap from the same `detected_by`. That is correct behaviour
-- — it is what makes a gap disappear once the underlying condition is fixed —
-- and it means a detector's candidate list must always be the COMPLETE set for
-- that detector.
--
-- Raising upload findings as 'validator' would therefore have silently
-- auto-resolved every open intake-validation gap on the proposal, because a
-- single-file candidate list is not the validator's complete set. The blocking
-- gaps that stop approval would have quietly closed themselves the moment
-- somebody attached a file.
--
-- A separate detector keeps each reconciliation scoped to its own findings.
-- ============================================================

ALTER TABLE gaps DROP CONSTRAINT IF EXISTS gaps_detected_by_check;

ALTER TABLE gaps ADD CONSTRAINT gaps_detected_by_check
  CHECK (detected_by IN ('validator', 'model', 'grounding', 'scanner'));
