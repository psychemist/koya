/**
 * Every environment value the app reads, resolved in one place.
 *
 * Two rules this file enforces:
 *  1. Nothing here is NEXT_PUBLIC_*. No credential may reach the browser.
 *  2. A missing optional key is a CAPABILITY that is off, not a crash. The
 *     system degrades honestly: a channel with no credentials records
 *     `blocked`, never a fake `sent`.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
/**
 * A Supabase project hands you two URLs and conflating them is the classic
 * mistake: https://<ref>.supabase.co is the API URL, postgresql://… is the
 * connection string. `pg` accepts the https one without complaint, reads the
 * host as a Postgres server on 5432, and sits there until the TCP connect
 * times out — two minutes of silence for a one-word typo. Fail here instead,
 * immediately, naming the value that is actually wanted.
 */
export function assertPostgresUrl(v: string, name = 'DATABASE_URL'): string {
  if (/^postgres(ql)?:\/\//.test(v)) return v;
  const scheme = v.includes('://') ? v.split('://')[0] + '://…' : '…';
  throw new Error(
    `${name} is not a Postgres connection string (got ${scheme}).\n\n` +
    'Supabase → Project Settings → Database → Connection string → URI (pooled).\n' +
    'It starts with postgresql:// — the https://<ref>.supabase.co value is the\n' +
    'API URL and belongs in SUPABASE_URL, not here.',
  );
}

const opt = (name: string) => process.env[name]?.trim() || undefined;
const bool = (name: string, dflt = false) => {
  const v = process.env[name]?.trim().toLowerCase();
  return v === undefined || v === '' ? dflt : v === 'true' || v === '1';
};

export const config = {
  databaseUrl: () => assertPostgresUrl(req('DATABASE_URL')),
  anthropicKey: () => req('ANTHROPIC_API_KEY'),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  sessionSecret: () => req('SESSION_SECRET'),

  promptVersion: process.env.PROMPT_VERSION || '2026-09-16.1',
  /** Frozen. Bumping invalidates Claude's 24h grammar cache for every judge call. */
  evalSchemaVersion: Number(process.env.EVAL_SCHEMA_VERSION || '1'),

  firecrawlKey: opt('FIRECRAWL_API_KEY'),

  /**
   * Notifications are emitted to n8n, which fans out to email and the two
   * Discord channels. The Resend key and the Discord webhook URLs live in
   * n8n's credential store, NOT here — the app cannot leak what it never holds.
   */
  n8nNotifyUrl: opt('N8N_NOTIFY_WEBHOOK_URL'),
  n8nNotifySecret: () => opt('N8N_NOTIFY_SECRET'),
  /**
   * FALLBACK ONLY. Used when the n8n lane is unreachable or unconfigured.
   * Discord is lost in that case, but the person who has to act still gets
   * told — which is the half of the notification that actually blocks work.
   */
  resendKey: opt('RESEND_API_KEY'),
  notifyFrom: opt('NOTIFY_FROM_EMAIL') || 'Koya Content Desk <onboarding@resend.dev>',

  /**
   * PUBLISHING the newsletter, which is a different job from notifying a
   * colleague and therefore a different lane.
   *
   * Same order as notifications and for a sharper reason. Resend will not
   * deliver to arbitrary recipients without a verified domain: with the shared
   * onboarding sender it accepts the call, returns an id, and delivers to
   * nobody but the account owner. The queue would write `sent` with a provider
   * id against a newsletter that reached no subscriber, which is the exact
   * false success every other part of this system refuses to produce.
   *
   * So n8n, where a Gmail credential sends as a real mailbox with no domain to
   * own, is primary. Resend stays as the fallback and comes into its own the
   * day a domain is verified.
   */
  n8nPublishUrl: opt('N8N_PUBLISH_WEBHOOK_URL'),
  n8nPublishSecret: () => opt('N8N_PUBLISH_SECRET'),

  linkedinToken: opt('LINKEDIN_ACCESS_TOKEN'),
  linkedinUrn: opt('LINKEDIN_MEMBER_URN'),
  x: {
    apiKey: opt('X_API_KEY'),
    apiSecret: opt('X_API_SECRET'),
    accessToken: opt('X_ACCESS_TOKEN'),
    accessSecret: opt('X_ACCESS_SECRET'),
  },

  /** $0.20 per post containing a link. Opt in per request, never a default. */
  featureXPublish: bool('FEATURE_X_PUBLISH', false),
  /** Lets a requester approve their own work. Stamped on every approval it enables. */
  soloOperatorOverride: bool('SOLO_OPERATOR_OVERRIDE', false),

  /**
   * The demo role switcher.
   *
   * On, an account with role `admin` can move its session into the seeded
   * manager or editor account and back again. It is a convenience for showing
   * a two-person workflow single-handed, and it is deliberately NOT a way to
   * escape separation of duties: switching signs you in AS the other person,
   * so the approval route still sees two different user ids and still refuses
   * to let whoever raised a request decide on it.
   *
   * Every switch is written to the audit log with both ids, so a decision
   * taken after one can always be traced back to the person who took it.
   *
   * Defaults ON because an unattended reviewer opening this deployment has no
   * other way to experience both sides of the gate. Set false to remove it.
   */
  demoRoleSwitch: bool('DEMO_ROLE_SWITCH', true),
} as const;

/** What the UI shows on the health page, without ever revealing a value. */
export function capabilities() {
  return {
    research_firecrawl: Boolean(config.firecrawlKey),
    research_webfetch: true, // always available: no charge beyond tokens
    notifications_n8n: Boolean(config.n8nNotifyUrl && config.n8nNotifySecret()),
    notifications_email_fallback: Boolean(config.resendKey),
    publish_linkedin: Boolean(config.linkedinToken && config.linkedinUrn),
    publish_x: Boolean(config.featureXPublish && config.x.apiKey && config.x.accessToken),
  };
}
