import { z } from "zod";
import { readJson, route } from "../../../../../lib/api";
import { ROLES, setActive, setRole } from "../../../../../lib/team";

/**
 * Change what a colleague may do.
 *
 * Both operations refuse to act on the caller's own account and refuse to
 * leave the organisation with no active administrator. Those two rules live
 * in lib/team.ts, next to the queries that would otherwise break them.
 */

const body = z
  .object({
    role: z.enum(ROLES as [string, ...string[]]).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.active !== undefined, {
    message: "Nothing to change.",
  });

export const PATCH = route<{ userId: string }>(
  { action: "team.member.update", roles: ["admin"] },
  async ({ params, request, user }) => {
    const input = body.parse(await readJson(request));

    let member =
      input.role !== undefined
        ? await setRole({
            actor: user,
            userId: params.userId,
            role: input.role as (typeof ROLES)[number],
          })
        : null;

    if (input.active !== undefined) {
      member = await setActive({ actor: user, userId: params.userId, active: input.active });
    }

    return { member };
  },
);
