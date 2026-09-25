import { query, one } from '../db.ts';
import type { ScreenResult } from './injection.ts';

/**
 * The injection screen, cached by the bytes it read.
 *
 * `scrape()` already stops a rerun paying Firecrawl for a page it has, but the
 * screen ran on every call including a cache hit, so a cached page still cost
 * a model call. That is the one per-page cost left on work already done.
 *
 * The key is the content hash, not the URL: the screen is a function of the
 * text, two URLs serving identical bytes are one job, and a page that changed
 * gets a new hash and is screened again, which is exactly what should happen.
 */
export type CachedScreen = Omit<ScreenResult, 'costUsd'>;

export async function readScreenCache(contentHash: string): Promise<CachedScreen | null> {
  const row = await one<{
    summary: string; injection_flagged: boolean; injection_reason: string | null;
    usable: boolean;
  }>(
    `select summary, injection_flagged, injection_reason, usable
       from public.screen_cache where content_hash = $1`,
    [contentHash],
  );
  if (!row) return null;
  return {
    summary: row.summary,
    flagged: row.injection_flagged,
    reason: row.injection_reason ?? undefined,
    usable: row.usable,
  };
}

/**
 * Only a screen that produced something is worth keeping. Caching a malformed
 * result would make one bad model response permanent for that page, and the
 * quarantine would then hand the agent nothing for ever.
 */
export async function writeScreenCache(
  contentHash: string, result: CachedScreen,
): Promise<void> {
  if (!result.usable) return;
  await query(
    `insert into public.screen_cache
       (content_hash, summary, injection_flagged, injection_reason, usable)
     values ($1,$2,$3,$4,$5)
     on conflict (content_hash) do update
       set summary = excluded.summary,
           injection_flagged = excluded.injection_flagged,
           injection_reason = excluded.injection_reason,
           usable = excluded.usable,
           screened_at = now()`,
    [contentHash, result.summary, result.flagged, result.reason ?? null, result.usable],
  ).catch(() => undefined);
}
