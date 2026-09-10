-- Team membership: an allow-list of email addresses, each with the role that
-- address will hold when it registers.
--
-- WHY AN ALLOW-LIST RATHER THAN ADMIN-CREATED PASSWORDS. The obvious way to
-- add a colleague is for an administrator to create the account and hand over
-- a temporary password. That password then travels through Slack or email in
-- plaintext, is reused because nothing forces a change, and is known to two
-- people for the life of the account. An allow-list inverts it: the
-- administrator authorises an ADDRESS and a ROLE, and the person sets their
-- own password at registration. No secret is ever transmitted, and the thing
-- an administrator grants is the thing they actually mean to grant.
--
-- The role lives on the invite, not on the registration form. A form that
-- asked "which role would you like?" would let anyone holding an invite for a
-- salesperson account register as an approver, which is the entire access
-- control model handed to the applicant.

CREATE TABLE IF NOT EXISTS team_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('salesperson', 'approver', 'admin')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

-- One live invite per address. Case-insensitive, matching how users.email is
-- already indexed, so "Priya@" and "priya@" cannot both be authorised.
-- Accepted and revoked rows are kept as history and excluded from the
-- constraint, so an address can be re-invited after being revoked.
CREATE UNIQUE INDEX IF NOT EXISTS team_invites_live_email_key
  ON team_invites (lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS team_invites_email_idx ON team_invites (lower(email));
