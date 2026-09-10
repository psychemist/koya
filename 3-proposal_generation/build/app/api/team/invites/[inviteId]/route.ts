import { route } from "../../../../../lib/api";
import { revokeInvite } from "../../../../../lib/team";

/** Withdraw an authorisation before it is used. */
export const DELETE = route<{ inviteId: string }>(
  { action: "team.invite.revoke", roles: ["admin"] },
  async ({ params, user }) => {
    await revokeInvite({ actor: user, inviteId: params.inviteId });
    return { inviteId: params.inviteId };
  },
);
