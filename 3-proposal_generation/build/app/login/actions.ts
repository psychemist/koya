"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { signIn, signOut } from "../../lib/auth";
import { newCorrelationId, toAppError } from "../../lib/errors";
import { recordEvent } from "../../lib/audit";
import { LIMITS, clientIp, enforce } from "../../lib/ratelimit";

export type LoginState = { error: string | null; correlationId: string | null };

/**
 * Sign-in, as a server action.
 *
 * The password never leaves the server: a server action posts the form body to
 * the server directly, so there is no client-side handler holding the value
 * and no JSON API surface to point a credential-stuffing script at.
 *
 * Every attempt — success or failure — writes an `events` row. Repeated
 * failures against one address are exactly the signal an operator wants, and
 * they are invisible unless recorded here.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const correlationId = newCorrelationId();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (email.trim().length === 0 || password.length === 0) {
    return { error: "Enter both an email address and a password.", correlationId: null };
  }

  const headerList = await headers();
  const ip = clientIp(headerList);

  try {
    // Throttled BEFORE the password is verified, because verification is the
    // expensive part: scrypt at 16 MB is what an attacker is really trying to
    // spend on our behalf, and checking afterwards would pay that cost on
    // every attempt the limiter was meant to refuse. Both counters are
    // consumed on every attempt, successful ones included — a limiter that
    // only counts failures is trivially reset by interleaving one good login.
    await enforce(
      LIMITS.loginByEmail,
      email.trim().toLowerCase(),
      "Too many sign-in attempts for this account.",
    );
    await enforce(LIMITS.loginByIp, ip, "Too many sign-in attempts from this network.");

    const user = await signIn(email, password, {
      userAgent: headerList.get("user-agent"),
      ip,
    });

    await recordEvent({
      correlationId,
      action: "auth.sign_in",
      outcome: "ok",
      actorId: user.id,
      detail: { role: user.role },
    });
  } catch (err) {
    const app = toAppError(err);
    await recordEvent({
      correlationId,
      action: "auth.sign_in",
      outcome: "denied",
      errorCode: app.code,
      // `detail` is redacted before it is written, so the password cannot
      // reach the log even though it is in scope here.
      detail: { ...app.detail, message: app.message },
    });
    return { error: app.userMessage, correlationId };
  }

  // Only local paths, so a crafted `next` cannot bounce a freshly
  // authenticated user to an external site.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logoutAction(): Promise<void> {
  const correlationId = newCorrelationId();
  await recordEvent({ correlationId, action: "auth.sign_out", outcome: "ok" });
  await signOut();
  redirect("/login");
}
