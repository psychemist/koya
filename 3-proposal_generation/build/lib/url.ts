import { config } from "./config";

/**
 * Where the application lives, for building links that leave the building.
 *
 * The share link is the one URL in this system that is emailed to a client and
 * clicked by someone outside the firm. It was being assembled from the
 * request's own `Host` header, in four places:
 *
 *   const host = (await headers()).get("host") ?? "localhost:3000";
 *   const proposalLink = `https://${host}/p/${token}`;
 *
 * `Host` is supplied by whoever made the request. On a platform that pins it
 * that is survivable; as a property of the application it is not, because the
 * value is not merely rendered back to the sender — it is baked into a link,
 * attached to a live share token, and emailed to a real client by the
 * application itself. One request with a forged `Host` produces a genuine
 * proposal token pointing at somebody else's domain, sent from the firm's own
 * address, to a client expecting exactly that email. The recipient's only clue
 * would be the hostname.
 *
 * So the origin comes from configuration when configuration exists, and a
 * request header is only ever consulted as a fallback — and then only if it
 * matches something the deployment already knows it is called.
 *
 * Order:
 *   1. APP_BASE_URL. Set it in production; nothing else is consulted.
 *   2. The request host, IF it is on the allow-list or is plainly local.
 *   3. http://localhost:3000, so development needs no configuration at all.
 */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export type OriginResult = {
  origin: string;
  /** Which rule decided. Recorded on the send event so a wrong link is diagnosable. */
  source: "config" | "allowlisted_host" | "local" | "fallback";
  /** Set when a host header was presented and refused. */
  rejectedHost?: string;
};

export function resolveOrigin(host: string | null): OriginResult {
  const configured = config.appBaseUrl;
  if (configured) return { origin: configured, source: "config" };

  const candidate = host?.trim().toLowerCase() ?? "";

  if (candidate.length > 0 && candidate.length <= 253 && isSafeHost(candidate)) {
    if (LOCAL_HOST.test(candidate)) {
      return { origin: `http://${candidate}`, source: "local" };
    }
    if (config.allowedHosts.includes(candidate)) {
      return { origin: `https://${candidate}`, source: "allowlisted_host" };
    }
  }

  // Nothing trustworthy was offered. Falling back to localhost produces a link
  // that visibly does not work, which is the correct outcome: a broken link a
  // salesperson notices immediately beats a working link to an attacker's
  // domain that nobody notices at all.
  return {
    origin: "http://localhost:3000",
    source: "fallback",
    rejectedHost: candidate.length > 0 ? candidate.slice(0, 100) : undefined,
  };
}

/**
 * Rejects anything that is not plausibly a hostname[:port]. Guards against a
 * header carrying a path, a second URL, credentials, or CR/LF.
 */
function isSafeHost(host: string): boolean {
  return /^[a-z0-9.-]+(:\d{1,5})?$/.test(host) || LOCAL_HOST.test(host);
}

/** The full client-facing URL for a share token. */
export function shareUrl(origin: string, token: string): string {
  return `${origin}/p/${encodeURIComponent(token)}`;
}
