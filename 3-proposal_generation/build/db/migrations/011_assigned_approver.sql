-- ============================================================
-- 011_assigned_approver
--
-- Who a proposal is meant to go to for approval.
--
-- `approver_id` already exists and records who DID approve it. That is an
-- audit fact, written at the moment of the decision, and it must not be
-- overloaded to mean "who we hope will decide" - a column that means one
-- thing before an event and another thing afterwards is a column you cannot
-- query honestly. "Which proposals did Tunde approve" and "which are waiting
-- on Tunde" are different questions and need different answers.
--
-- So: a second, nullable column for the intention.
--
--   assigned_approver_id  who the salesperson is asking, set before submission
--   approver_id           who actually signed it off, set at approval
--
-- Nullable because assigning is optional. A firm small enough that everybody
-- knows who reviews what should not be forced to fill in a field, and an
-- unassigned proposal is visible to every approver exactly as it is today.
--
-- ON DELETE SET NULL rather than RESTRICT: somebody leaving must not make a
-- proposal unopenable, and losing the intention is not losing a record of
-- anything that happened.
--
-- Nothing here grants permission. `assertCanApprove` is unchanged, so an
-- assigned approver still cannot approve their own work, and an approver who
-- was not assigned can still step in - which matters when the assigned one is
-- on leave and a client is waiting.
-- ============================================================

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS assigned_approver_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- The queue question: what is waiting on me.
CREATE INDEX IF NOT EXISTS proposals_assigned_approver_idx
  ON proposals (assigned_approver_id, status)
  WHERE assigned_approver_id IS NOT NULL;
