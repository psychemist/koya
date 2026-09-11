-- ============================================================
-- 010_email_opener
--
-- One generated sentence at the top of the client covering email.
--
-- The covering note is a template with three substitutions, and the three
-- middle paragraphs are byte-identical on every proposal the firm has ever
-- sent. That is right for most of it: the email is an envelope, the proposal
-- is the artefact, and spending Opus output tokens on five lines a template
-- gets right is spending the budget where nobody looks. Determinism is also
-- what lets the style gate run over the text at all, which is how two defects
-- in it were found.
--
-- What the template cannot do is know anything about the deal. The intake
-- holds the client's problem in their own words, and the email used none of
-- it, so a 48k ten-week build and a 4k discovery workshop arrived under the
-- same sentence.
--
-- So: one sentence is generated, and the rest stays templated and gate-checked.
--
--   email_opener       the sentence, or NULL when there is none
--   email_opener_hash  sha256 of the inputs it was generated from
--
-- The hash is what stops this costing money on every send. It is recomputed
-- before each generation and the call is skipped when it matches, so editing
-- the intake produces a new sentence and re-sending an unchanged proposal
-- produces no call at all. Same mechanism as `content_hash` on a draft.
--
-- Both columns are nullable and the application falls back to the templated
-- opener whenever `email_opener` is NULL. That is the path for every proposal
-- that predates this migration, and for every generation that fails: a model
-- call that cannot complete must not stop a client receiving an approved
-- proposal.
-- ============================================================

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS email_opener      text;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS email_opener_hash text;

-- The new call purpose, so its cost is counted separately on the System page
-- rather than hiding inside another bucket. Same reasoning as migration 005.
ALTER TABLE ai_calls DROP CONSTRAINT IF EXISTS ai_calls_purpose_check;

ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_purpose_check
  CHECK (purpose IN ('draft', 'section_regen', 'gap_analysis', 'grounding_judge',
                     'ocr', 'email_opener'));
