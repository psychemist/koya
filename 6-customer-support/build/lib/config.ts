/**
 * Every environment variable is read here and nowhere else.
 *
 * Getters, not values: a missing secret only fails when a service that needs
 * it reads it, and a budget changed in the environment is seen on the next
 * read. The web service never holds the Anthropic key, so it must be able to
 * load this file without one.
 */
export class ConfigError extends Error {}
const MODELS = ['claude-haiku-4-5', 'claude-sonnet-5'] as const;
export type AgentModel = (typeof MODELS)[number];

export function assertPostgresUrl(v: string, name = 'DATABASE_URL'): string {
  if (!/^postgres(ql)?:\/\//.test(v)) throw new ConfigError(`${name} must start with postgresql://, not the https API URL`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined>) {
  const req = (k: string) => { const v = env[k]; if (!v) throw new ConfigError(`${k} is not set`); return v; };
  const num = (k: string, d: number) => {
    const v = env[k]; const n = v === undefined || v === '' ? d : Number(v);
    if (!Number.isFinite(n)) throw new ConfigError(`${k} must be a number`);
    return n;
  };
  return {
    db: { get url() { return assertPostgresUrl(req('DATABASE_URL')); } },
    models: {
      get agent(): AgentModel {
        const m = env.AGENT_MODEL || 'claude-haiku-4-5';
        if (!(MODELS as readonly string[]).includes(m)) throw new ConfigError(`AGENT_MODEL must be one of ${MODELS.join(', ')}`);
        return m as AgentModel;
      },
      allowed: MODELS,
      get effort() { return (env.AGENT_EFFORT || 'low') as 'low' | 'medium' | 'high'; },
    },
    anthropic: { get key() { return req('ANTHROPIC_API_KEY'); } },
    agent: {
      get maxBudgetUsd() { return num('AGENT_MAX_BUDGET_USD', 0.25); },
      get maxTurns() { return num('AGENT_MAX_TURNS', 60); },
      get maxToolCallsPerTurn() { return num('AGENT_MAX_TOOL_CALLS_PER_TURN', 4); },
      get maxConcurrentCalls() { return num('MAX_CONCURRENT_CALLS', 3); },
      get dailyCapUsd() {
        const cap = num('DAILY_CLAUDE_CAP_USD', 5), per = num('AGENT_MAX_BUDGET_USD', 0.25);
        if (cap <= per) throw new ConfigError(`DAILY_CLAUDE_CAP_USD (${cap}) must exceed AGENT_MAX_BUDGET_USD (${per})`);
        return cap;
      },
      get internalToken() { return req('AGENT_INTERNAL_TOKEN'); },
      get mcpUrl() { return req('MCP_URL'); },
      get mcpToken() { return req('MCP_TOKEN'); },
      get allowFaults() { return env.ALLOW_FAULT_INJECTION === 'true'; },
    },
    vapi: {
      get customLlmKey() { return req('VAPI_CUSTOM_LLM_KEY'); },
      get webhookSecret() { return req('VAPI_WEBHOOK_SECRET'); },
    },
    mcp: {
      get token() { return req('MCP_TOKEN'); },
      get allowedOrigins() { return (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean); },
    },
    kb: {
      get voyageKey() { return req('VOYAGE_API_KEY'); },
      get voyageModel() { return env.VOYAGE_MODEL || 'voyage-3.5-lite'; },
      dims: 1024,
      get groundingThreshold() { return num('KB_GROUNDING_THRESHOLD', 0.5); },
      // 1.0 is a query term on the FAQ heading (weight A). A body-only single-word hit scores 0.1
      // and must not ground an answer, least of all in degraded mode (2026-09-29, kb-ground.test.ts).
      get ftsStrong() { return num('KB_FTS_STRONG', 1.0); },
    },
    get hours() {
      return {
        days: (env.SUPPORT_HOURS_DAYS || '1,2,3,4,5').split(',').map(Number),
        startHour: num('SUPPORT_HOURS_START_UTC', 8),
        endHour: num('SUPPORT_HOURS_END_UTC', 18),
        slotMinutes: num('SUPPORT_SLOT_MINUTES', 30),
      };
    },
    escalation: {
      get calApiKey() { return req('CAL_API_KEY'); },
      get calApiUrl() { return env.CAL_API_URL || 'https://api.cal.com'; },
      get calEventTypeId() { return Number(req('CAL_EVENT_TYPE_ID')); },
      // Optional: Discord is best effort, so an unset webhook skips it rather than failing the escalation.
      get discordWebhookUrl() { return env.DISCORD_WEBHOOK_URL || null; },
      // Per outbound call. Two Cal.com calls in turn, then Discord and email together: 15 s at worst, inside the tool's 20 s.
      get stepTimeoutMs() { return num('ESCALATION_STEP_TIMEOUT_MS', 5000); },
      get resendKey() { return req('RESEND_API_KEY'); },
      get resendUrl() { return env.RESEND_API_URL || 'https://api.resend.com/emails'; },
      get supportInbox() { return req('SUPPORT_INBOX'); },
      get fromEmail() { return env.NOTIFY_FROM_EMAIL || 'RelayPay Support Line <onboarding@resend.dev>'; },
    },
    web: {
      get sessionSecret() { return req('SESSION_SECRET'); },
      get baseUrl() { return (env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''); },
      get agentUrl() { return req('AGENT_URL').replace(/\/$/, ''); },
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig(process.env);
