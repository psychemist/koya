-- ============================================================
-- 007_audit_survives_erasure
--
-- Deleting a proposal must not delete the record that it was approved.
--
-- `events.proposal_id` was ON DELETE CASCADE, so erasing a proposal erased its
-- entire audit trail with it. That is a defensible reading of the right to
-- erasure and it is the wrong trade here, because the two things being deleted
-- are not the same kind of data:
--
--   The PROPOSAL is the client's information — their name, their contact
--   details, their pricing. Erasure should remove it, completely.
--
--   The AUDIT TRAIL is a record of what the firm's own staff did. That a named
--   approver signed something off at a given time is a fact about Koya, kept
--   under legitimate interest for accountability, and it is precisely the
--   evidence a client or an auditor asks for when they want to know whether
--   AI-generated commercial terms were reviewed by a human. Deleting it on
--   request means the firm can no longer answer that question about a deal it
--   genuinely did.
--
-- So the link is severed instead of the row: `proposal_id` becomes NULL, and
-- the `detail` payload — the only part of an event that can carry the client's
-- own data — is emptied by trigger at the same moment. What survives is
-- "someone approved something, at this time, with this correlation id", which
-- is accountability without personal data.
--
-- The correlation id is deliberately kept. It ties an orphaned event back to
-- its siblings in the same request, so a support question about a deleted
-- proposal can still be reconstructed as a sequence of actions.
-- ============================================================

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_proposal_id_fkey;

ALTER TABLE events
  ADD CONSTRAINT events_proposal_id_fkey
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL;

-- The FK action nulls the reference; this empties the payload behind it.
-- A trigger rather than application code on purpose: erasure has to hold for
-- every delete path, including a manual one run against the database during an
-- incident, which is exactly when nobody remembers to null a JSON column.
CREATE OR REPLACE FUNCTION scrub_events_on_proposal_delete() RETURNS trigger AS $$
BEGIN
  UPDATE events
     SET detail = jsonb_build_object('scrubbed', true, 'reason', 'proposal deleted')
   WHERE proposal_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_scrub_before_proposal_delete ON proposals;

CREATE TRIGGER events_scrub_before_proposal_delete
  BEFORE DELETE ON proposals
  FOR EACH ROW EXECUTE FUNCTION scrub_events_on_proposal_delete();
