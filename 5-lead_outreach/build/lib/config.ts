/**
 * Every environment value the app reads, resolved in one place.
 * Two rules: nothing here is NEXT_PUBLIC_*, and a missing optional key is a
 * capability that is off, not a crash.
 */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
const opt = (n: string) => process.env[n]?.trim() || undefined;
const num = (n: string, d: number) => {
  const v = Number(process.env[n] ?? d);
  return Number.isFinite(v) ? v : d;
};

/** `pg` accepts an https URL without complaint and then hangs for two minutes. Fail here instead. */
export function assertPostgresUrl(v: string, name = 'DATABASE_URL'): string {
  if (/^postgres(ql)?:\/\//.test(v)) return v;
  const scheme = v.includes('://') ? v.split('://')[0] + '://...' : '...';
  throw new Error(
    `${name} is not a Postgres connection string (got ${scheme}).\n` +
    'Supabase > Project Settings > Database > Connection string > URI (pooled).',
  );
}

/**
 * An unpinned actor id is how you accidentally start a rental actor and get
 * billed a flat monthly fee against a shared cohort account.
 */
export function assertPinnedActor(v: string | undefined): string {
  if (!v) throw new Error(
    'APIFY_ACTOR_ID is not pinned. Choose an actor, check its pricing model in the ' +
    'Apify Console, record the price and date in .env.example, then set it here. ' +
    'Never a rental actor.',
  );
  return v;
}

/** A base URL a path can be concatenated on to: no trailing slash, ever. */
export function baseUrl(v: string | undefined): string {
  return (v?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Comma separated list, empty entries dropped. An unset value is no recipients, not a crash. */
export function parseRecipients(v: string | undefined): { email: string; role: string }[] {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean)
    .map((email) => ({ email, role: 'operator' }));
}

export const config = {
  databaseUrl: () => assertPostgresUrl(req('DATABASE_URL')),
  anthropicKey: () => req('ANTHROPIC_API_KEY'),
  apifyToken: () => req('APIFY_TOKEN'),
  apifyExpectedAccount: opt('APIFY_EXPECTED_ACCOUNT'),
  pinnedActorId: () => assertPinnedActor(opt('APIFY_ACTOR_ID')),
  firecrawlKey: () => req('FIRECRAWL_API_KEY'),

  models: {
    agent: opt('AGENT_MODEL') || 'claude-sonnet-5',
    screen: opt('SCREEN_MODEL') || 'claude-haiku-4-5',
    /**
     * Reasoning depth. The SDK's own default is 'high'.
     *
     * Output is where this agent's money goes: the run of 2026-09-25 spent
     * 40% of its Claude cost on output tokens, 9,791 of them thinking, against
     * 58 tokens of uncached input. Effort is the one knob that moves that
     * number, which is why it is a setting rather than a constant.
     */
    effort: (opt('AGENT_EFFORT') || 'high') as
      'low' | 'medium' | 'high' | 'xhigh' | 'max',
  },

  limits: {
    candidateBudget: num('RUN_CANDIDATE_BUDGET', 40),
    scrapeBudget: num('RUN_SCRAPE_BUDGET', 30),
    /**
     * A ceiling that only catches a loop.
     *
     * The first value was 8, picked by eye. Measured yield is 1.6 charged rows
     * per search, so 8 would have reached about 13 of a 40-candidate budget
     * and starved discovery. The real control is the empty-streak below.
     */
    discoveryCalls: num('RUN_DISCOVERY_CALLS', 40),
    /** Consecutive searches returning nothing before the run stops paying
     *  start fees for a query strategy that is not working. */
    discoveryZeroStreak: num('RUN_DISCOVERY_ZERO_STREAK', 4),
    targetLeads: 10,
    runApifyCapUsd: num('RUN_APIFY_CAP_USD', 0.30),
    dailyApifyCapUsd: num('DAILY_APIFY_CAP_USD', 1.50),
    /** Claude is roughly 89% of a run's cost and was the only provider with no
     *  ceiling across runs: ten runs a day was $15 with nothing to stop it. */
    dailyClaudeCapUsd: num('DAILY_CLAUDE_CAP_USD', 2.50),
    apifyPricePerResultUsd: num('APIFY_ACTOR_PRICE_PER_RESULT_USD', 0.005),
    /** Charged once per actor run, whatever it returns. A run that finds
     *  nothing is not a free run, and the agent may search more than once. */
    apifyActorStartUsd: num('APIFY_ACTOR_START_USD', 0.001),
    /** How long a scraped page stays good enough to judge a company on. The
     *  cache is what stops a rerun paying twice; this is what stops it
     *  answering with a page that has since changed. */
    scrapeCacheMaxAgeDays: num('SCRAPE_CACHE_MAX_AGE_DAYS', 30),
    maxTurns: num('AGENT_MAX_TURNS', 60),
    maxBudgetUsd: num('AGENT_MAX_BUDGET_USD', 1.50),
  },

  /**
   * The worker holds the webhook URL and the signing secret. The Discord URLs
   * and the Resend credential live in n8n's credential store, so the worker
   * cannot leak what it never holds.
   */
  notify: {
    n8nUrl: () => opt('N8N_LEAD_NOTIFY_URL'),
    n8nSecret: () => opt('N8N_LEAD_NOTIFY_SECRET'),
    resendKey: () => opt('RESEND_API_KEY'),
    fromEmail: () => opt('NOTIFY_FROM_EMAIL') || 'Koya Lead Desk <onboarding@resend.dev>',
    recipients: () => parseRecipients(opt('NOTIFY_TO')),
  },

  /**
   * Trailing slashes stripped here, once, rather than at the one place that
   * builds a link from it. A dashboard field is exactly where a URL picks up a
   * trailing slash, and the notification lane concatenates a path straight on
   * to this, so `https://host/` produced `https://host//runs/<id>` in an email
   * that had already been sent by the time anyone noticed.
   */
  appBaseUrl: baseUrl(opt('APP_BASE_URL')),

  /** Signs the session cookie. Required by the web service, which is the only
   *  process that issues one. */
  sessionSecret: () => req('SESSION_SECRET'),

  /** Presence only. A health route that returns a value is a health route that leaks one. */
  configured: () => ({
    database: Boolean(opt('DATABASE_URL')),
    anthropic: Boolean(opt('ANTHROPIC_API_KEY')),
    apify: Boolean(opt('APIFY_TOKEN')) && Boolean(opt('APIFY_ACTOR_ID')),
    firecrawl: Boolean(opt('FIRECRAWL_API_KEY')),
    notifications: Boolean(opt('N8N_LEAD_NOTIFY_URL')) && Boolean(opt('N8N_LEAD_NOTIFY_SECRET')),
    sessions: Boolean(opt('SESSION_SECRET')),
  }),
} as const;
