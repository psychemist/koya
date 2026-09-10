import { z } from "zod";
import { publicRoute, readJson } from "../../../lib/api";
import { registerFromInvite } from "../../../lib/team";
import { LIMITS, clientIp, enforce } from "../../../lib/ratelimit";

/**
 * Registration, open to anyone whose address an administrator has authorised.
 *
 * Public by necessity, and therefore rate limited by IP on the same bucket
 * as sign-in: without that, this endpoint is an oracle for enumerating which
 * addresses at a company have been added to the team. The error message is
 * identical for "no invite", "already registered" and "invite withdrawn" for
 * the same reason.
 */

const body = z.object({
  email: z.string().trim().min(3).max(254),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(200),
});

export const POST = publicRoute({ action: "auth.register" }, async ({ request }) => {
  await enforce(
    LIMITS.loginByIp,
    clientIp(request.headers),
    "Too many attempts from this network. Try again shortly.",
  );
  const input = body.parse(await readJson(request));
  const { userId } = await registerFromInvite(input);
  return { userId };
});
