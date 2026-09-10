import { z } from "zod";
import { readJson, route } from "../../../../lib/api";
import { ROLES, invite, listInvites } from "../../../../lib/team";

/**
 * The approver list, as an API.
 *
 * Admin only, enforced here as well as in middleware: a route reached
 * directly with a valid salesperson cookie has to refuse on its own.
 */

export const GET = route({ action: "team.invites.list", roles: ["admin"] }, async () => ({
  invites: await listInvites(),
}));

const body = z.object({
  email: z.string().trim().min(3).max(254),
  role: z.enum(ROLES as [string, ...string[]]),
  note: z.string().trim().max(300).optional(),
});

export const POST = route({ action: "team.invite", roles: ["admin"] }, async ({ request, user }) => {
  const input = body.parse(await readJson(request));
  return {
    invite: await invite({
      actor: user,
      email: input.email,
      role: input.role as (typeof ROLES)[number],
      note: input.note ?? null,
    }),
  };
});
