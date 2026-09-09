import { query } from "../../../lib/db";
import { capabilityReport, config } from "../../../lib/config";
import { pingClaude } from "../../../lib/claude/client";
import { probeResend } from "../../../lib/delivery/send";
import { newCorrelationId } from "../../../lib/errors";
import { pruneExpiredSessions } from "../../../lib/auth";
import { pruneExpiredLimits } from "../../../lib/ratelimit";
import { pruneDeadShareLinks } from "../../../lib/proposal/share";

/**
 * The health endpoint.
 *
 * Deliberately public and unauthenticated, because the thing it most needs to
 * answer is "is the app up?", and requiring a working database to check
 * whether the database works is a poor design. It returns no client data, no
 * proposal content and no secret — only whether each dependency responds.
 *
 * Each dependency is probed INDEPENDENTLY and reported separately. A single
 * boolean would collapse "Claude is rate-limiting us" and "Postgres is down"
 * into the same signal, which are completely different incidents with
 * completely different responses.
 *
 * `?deep=1` additionally spends one token on Claude and one API call on Resend.
 * The default is cheap so an uptime monitor can poll it every minute without
 * running up a bill — which is itself the cost-awareness rule applied to
 * monitoring.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Check = {
  name: string;
  status: "ok" | "degraded" | "down" | "not_configured" | "skipped";
  latencyMs?: number;
  detail?: string;
};

export async function GET(request: Request): Promise<Response> {
  const correlationId = newCorrelationId();
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";
  const started = Date.now();

  const checks: Check[] = [];

  // ---- Postgres ----------------------------------------------------------
  {
    const t = Date.now();
    try {
      const rows = await query<{ migrations: number; proposals: number }>(
        `SELECT (SELECT count(*)::int FROM schema_migrations) AS migrations,
                (SELECT count(*)::int FROM proposals) AS proposals`,
      );
      const row = rows[0];
      checks.push({
        name: "database",
        status: "ok",
        latencyMs: Date.now() - t,
        detail: `${row?.migrations ?? 0} migrations applied, ${row?.proposals ?? 0} proposals`,
      });
    } catch (err) {
      checks.push({
        name: "database",
        status: "down",
        latencyMs: Date.now() - t,
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  // ---- Claude ------------------------------------------------------------
  if (!process.env.ANTHROPIC_API_KEY) {
    checks.push({
      name: "claude",
      status: "not_configured",
      detail: "ANTHROPIC_API_KEY is not set. Drafting will fail with a clear message.",
    });
  } else if (!deep) {
    checks.push({ name: "claude", status: "skipped", detail: "Add ?deep=1 to probe." });
  } else {
    const ping = await pingClaude();
    checks.push({
      name: "claude",
      status: ping.ok ? "ok" : "down",
      latencyMs: ping.latencyMs,
      detail: ping.error?.slice(0, 200),
    });
  }

  // ---- Delivery lanes ----------------------------------------------------
  const lanes = config.deliveryLanes;
  checks.push({
    name: "delivery.n8n",
    status: lanes.n8n ? "ok" : "not_configured",
    detail: lanes.n8n
      ? "Webhook URL and signing secret both present."
      : "Lane A unavailable; delivery falls through to Resend.",
  });

  if (!lanes.resend) {
    checks.push({
      name: "delivery.resend",
      status: "not_configured",
      detail: "Lane B unavailable. Approved proposals are delivered as a downloadable .eml.",
    });
  } else if (!deep) {
    checks.push({ name: "delivery.resend", status: "skipped", detail: "Add ?deep=1 to probe." });
  } else {
    const probe = await probeResend();
    checks.push({
      name: "delivery.resend",
      status: probe.ok ? "ok" : "down",
      detail: probe.error?.slice(0, 200),
    });
  }

  // ---- Housekeeping ------------------------------------------------------
  /**
   * Expired sessions and spent rate-limit buckets are swept here.
   *
   * `pruneExpiredSessions` existed before this call did, and nothing invoked
   * it — so every session ever opened stayed in the table, and the sweep that
   * was written to prevent unbounded growth was itself the dead code causing
   * it. An uptime monitor already polls this endpoint on a schedule, which
   * makes it the cron this deployment does not otherwise have.
   *
   * It cannot affect the verdict. Housekeeping that can report the system
   * unhealthy is a way to turn a full table into a false outage, so a failure
   * here is reported as its own degraded check and nothing more.
   */
  {
    const t = Date.now();
    try {
      const [sessions, buckets, links] = await Promise.all([
        pruneExpiredSessions(),
        pruneExpiredLimits(),
        pruneDeadShareLinks(),
      ]);
      checks.push({
        name: "housekeeping",
        status: "ok",
        latencyMs: Date.now() - t,
        detail: `removed ${sessions} expired session${sessions === 1 ? "" : "s"}, ${buckets} spent rate-limit bucket${buckets === 1 ? "" : "s"}, ${links} dead share link${links === 1 ? "" : "s"}`,
      });
    } catch (err) {
      checks.push({
        name: "housekeeping",
        status: "degraded",
        latencyMs: Date.now() - t,
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  /**
   * Overall status.
   *
   * `not_configured` is NOT a failure. Delivery is genuinely optional and the
   * app behaves correctly without it, so reporting an unconfigured lane as
   * unhealthy would train whoever reads this to ignore it.
   */
  const down = checks.filter((c) => c.status === "down");
  const overall = down.length === 0 ? "ok" : down.some((c) => c.name === "database") ? "down" : "degraded";

  return Response.json(
    {
      status: overall,
      correlationId,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      deep,
      checks,
      capabilities: capabilityReport().map((c) => ({
        name: c.name,
        configured: c.configured,
        required: c.required,
        note: c.note,
      })),
    },
    {
      // 503 when the database is unreachable, so an uptime monitor sees a
      // failure without having to parse the body.
      status: overall === "down" ? 503 : 200,
      headers: { "Cache-Control": "no-store", "X-Correlation-Id": correlationId },
    },
  );
}
