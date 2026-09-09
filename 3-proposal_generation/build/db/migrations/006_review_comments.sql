-- ============================================================
-- 006_review_comments
--
-- Somewhere to talk about a proposal without deciding it.
--
-- Before this table the only way to say anything was `approvals.note`, a
-- single text field attached to a DECISION. So a reviewer with a question —
-- "is this timeline right?", "where did the 40k come from?" — had exactly two
-- options: approve it anyway and hope, or reject the whole proposal to ask.
-- Both are bad, and the second is worse than it looks: a rejection resets the
-- proposal to changes_requested and reads to the author as a verdict, when all
-- that happened was somebody wanted a number checked.
--
-- The result is a familiar organisational failure. When the only feedback
-- mechanism is a rejection, people stop giving feedback, and the approval step
-- degrades into a rubber stamp — the exact outcome the whole approval design
-- exists to prevent.
--
-- Comments are therefore deliberately NOT part of the state machine. Posting
-- one changes no status and blocks nothing. An unresolved comment is a
-- question, not a gate; gaps are the gate, and conflating the two would give
-- every reader a veto.
--
-- section_key is nullable: a comment is either about one section or about the
-- proposal as a whole, and both are ordinary.
-- ============================================================

CREATE TABLE IF NOT EXISTS comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  -- Not a foreign key to proposal_sections: a section key is stable, a
  -- section ROW is rewritten on every regeneration. Anchoring a comment to the
  -- row would orphan it the moment the text it referred to was revised, which
  -- is precisely when the comment is most worth keeping.
  section_key text,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body        text NOT NULL CHECK (length(btrim(body)) > 0),
  -- Who closed it and when. A comment resolved by its own author reads
  -- differently from one resolved by the person who raised it, and the UI
  -- shows the difference.
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The workspace loads every comment for one proposal on every render, and the
-- approve page counts the unresolved ones. Both are this index.
CREATE INDEX IF NOT EXISTS comments_proposal_idx
  ON comments (proposal_id, created_at DESC);
