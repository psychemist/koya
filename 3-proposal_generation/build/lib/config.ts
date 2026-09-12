/**
 * One place that reads process.env.
 *
 * Scattered `process.env.FOO` calls make two things impossible: telling a
 * reviewer which capabilities are actually configured, and distinguishing
 * "this feature is switched off" from "this feature is broken". Both matter
 * here, because delivery is genuinely optional and the app has to behave
 * correctly and say so when it is absent.
 *
 * Nothing in this module is exported to the client. There are no
 * NEXT_PUBLIC_ variables in this app at all — see .env.example.
 */

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : null;
}

function required(name: string): string {
  const v = optional(name);
  if (!v) {
    throw new Error(
      `${name} is not set. Copy build/.env.example to build/.env.local and fill it in.`,
    );
  }
  return v;
}

export const config = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  get anthropicApiKey(): string {
    return required("ANTHROPIC_API_KEY");
  },
  get sessionSecret(): string {
    return required("APP_SESSION_SECRET");
  },

  /** Delivery lane A. Absent means lane A is skipped, not that delivery fails. */
  get n8nWebhookUrl(): string | null {
    return optional("N8N_PROPOSAL_WEBHOOK_URL");
  },
  get n8nWebhookSecret(): string | null {
    return optional("N8N_WEBHOOK_SECRET");
  },

  /** Delivery lane B. */
  get resendApiKey(): string | null {
    return optional("RESEND_API_KEY");
  },
  get resendFrom(): string {
    return optional("RESEND_FROM") ?? "Koya Talent <onboarding@resend.dev>";
  },

  /**
   * Whether the sending address is one that can ever be verified.
   *
   * Resend, and every other provider, requires SPF and DKIM records in the
   * sending domain's DNS. A consumer mailbox domain cannot supply them: only
   * Google can publish records for gmail.com. So `RESEND_FROM` pointing at a
   * personal address is not a configuration that needs finishing, it is one
   * that can never work, and it fails at the moment of sending with the
   * provider's own wording rather than at the moment of setting it.
   *
   * Reported rather than enforced. The app cannot know which domains a
   * particular account has verified, so refusing to start over a heuristic
   * would be worse than saying so on the System page.
   */
  get resendFromIsUnverifiable(): string | null {
    const from = this.resendFrom;
    const match = /<([^>]+)>|(\S+@\S+)/.exec(from);
    const address = (match?.[1] ?? match?.[2] ?? "").trim().toLowerCase();
    const domain = address.split("@")[1] ?? "";
    if (!domain) return null;

    const CONSUMER = new Set([
      "gmail.com",
      "googlemail.com",
      "yahoo.com",
      "yahoo.co.uk",
      "hotmail.com",
      "outlook.com",
      "live.com",
      "icloud.com",
      "me.com",
      "aol.com",
      "proton.me",
      "protonmail.com",
      "gmx.com",
      "yandex.com",
    ]);
    return CONSUMER.has(domain) ? domain : null;
  },

  /**
   * The canonical origin, e.g. https://koya-proposal-studio.vercel.app.
   *
   * Set this in production. It is what client-facing links are built from, and
   * the reason it exists is that the alternative was building them out of the
   * request's own `Host` header — see `lib/url.ts`.
   */
  get appBaseUrl(): string | null {
    const raw = optional("APP_BASE_URL");
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return url.origin;
    } catch {
      return null;
    }
  },

  /**
   * Additional hostnames the deployment answers to, comma-separated. Only
   * needed when a single deployment is reached at more than one name and
   * APP_BASE_URL cannot describe all of them (preview deployments, say).
   */
  get allowedHosts(): string[] {
    const raw = optional("APP_ALLOWED_HOSTS");
    if (!raw) return [];
    return raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0);
  },

  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },

  /**
   * Which delivery lanes are usable right now.
   *
   * Lane A needs BOTH the URL and the shared secret: firing an unsigned
   * webhook at a configured endpoint would be worse than not firing one,
   * because the receiving workflow is written to reject it anyway and the
   * failure would look like an outage rather than a misconfiguration.
   */
  get deliveryLanes(): { n8n: boolean; resend: boolean } {
    return {
      n8n: Boolean(this.n8nWebhookUrl && this.n8nWebhookSecret),
      resend: Boolean(this.resendApiKey),
    };
  },
};

/**
 * A capability report for the health endpoint and the System page, safe to
 * render: it says whether each secret is present and never what it is.
 */
export function capabilityReport(): {
  name: string;
  configured: boolean;
  required: boolean;
  note: string;
}[] {
  const lanes = config.deliveryLanes;
  return [
    {
      name: "Database (Neon Postgres)",
      configured: Boolean(optional("DATABASE_URL")),
      required: true,
      note: "Proposals, audit trail, sessions.",
    },
    {
      name: "Claude API",
      configured: Boolean(optional("ANTHROPIC_API_KEY")),
      required: true,
      note: "Drafting, gap analysis, grounding checks.",
    },
    {
      name: "Session signing key",
      configured: Boolean(optional("APP_SESSION_SECRET")),
      required: true,
      note: "Rotating it ends every session.",
    },
    {
      name: "Public base URL",
      configured: Boolean(optional("APP_BASE_URL")),
      required: false,
      note: config.appBaseUrl
        ? `Client links are built from ${config.appBaseUrl}.`
        : "Not set. Client links fall back to the request host, which is validated but weaker. Set APP_BASE_URL in production.",
    },
    {
      name: "Delivery lane A (n8n)",
      configured: lanes.n8n,
      required: false,
      note: lanes.n8n
        ? "Preferred lane. Signed webhook to the Gmail + Discord workflow."
        : "Not configured. Delivery goes straight to lane B.",
    },
    {
      name: "Delivery lane B (Resend)",
      configured: lanes.resend,
      required: false,
      note: !lanes.resend
        ? "Not configured. Approved proposals are delivered as a downloadable .eml."
        : config.resendFromIsUnverifiable
          ? `RESEND_FROM sends as ${config.resendFromIsUnverifiable}, which nobody can verify: only that provider can publish SPF and DKIM records for it, so every send will be refused. Use a domain you control, or onboarding@resend.dev for testing.`
          : config.resendFrom.includes("onboarding@resend.dev")
            ? "Using Resend's shared sandbox sender, which delivers only to the address that owns the Resend account. Set RESEND_FROM to a verified domain before sending to a client."
            : "Fallback lane, and the lane used when n8n is unreachable.",
    },
  ];
}
