import { query, one } from './db';

export type Subscriber = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  source: string | null;
  created_at: Date;
  unsubscribed_at: Date | null;
};

/**
 * Who a newsletter actually goes to.
 *
 * Read at SEND time rather than copied onto the request at approval time. If
 * the list were snapshotted per request, an unsubscribe between approval and
 * dispatch would be ignored, and "they asked to be removed and we sent it
 * anyway" is the one failure on this table with a legal consequence attached.
 */
export async function activeSubscriberEmails(): Promise<string[]> {
  const rows = await query<{ email: string }>(
    `select email from public.newsletter_subscribers
      where status = 'active' order by created_at asc`);
  return rows.map((r) => r.email);
}

export async function listSubscribers(limit = 200): Promise<Subscriber[]> {
  return query<Subscriber>(
    `select id, email, name, status, source, created_at, unsubscribed_at
       from public.newsletter_subscribers
      order by status asc, created_at desc
      limit $1`, [limit]);
}

export async function subscriberCounts(): Promise<{ active: number; unsubscribed: number }> {
  const row = await one<{ active: number; unsubscribed: number }>(
    `select count(*) filter (where status='active')::int as active,
            count(*) filter (where status='unsubscribed')::int as unsubscribed
       from public.newsletter_subscribers`);
  return { active: row?.active ?? 0, unsubscribed: row?.unsubscribed ?? 0 };
}

/**
 * Re-adding someone who has unsubscribed is refused rather than merged.
 *
 * `on conflict do update set status='active'` is the obvious one-liner here
 * and it is the wrong behaviour: it silently resurrects a person who asked to
 * be left alone, from a form whose label says "add". Their row is kept, so
 * the refusal can say why.
 */
export async function addSubscriber(opts: {
  email: string; name?: string | null; source?: string | null; addedBy: string;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const email = opts.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'That does not look like an email address.' };
  }

  const existing = await one<{ id: string; status: string }>(
    `select id, status from public.newsletter_subscribers where email=$1`, [email]);
  if (existing) {
    return {
      ok: false,
      reason: existing.status === 'unsubscribed'
        ? `${email} unsubscribed and has not asked to come back. Use the restore control, ` +
          `which records that the decision was yours.`
        : `${email} is already on the list.`,
    };
  }

  const row = await one<{ id: string }>(
    `insert into public.newsletter_subscribers (email, name, source, added_by)
     values ($1,$2,$3,$4) returning id`,
    [email, opts.name?.trim() || null, opts.source ?? 'added by hand', opts.addedBy]);
  return row ? { ok: true, id: row.id } : { ok: false, reason: 'The row was not written.' };
}

/** Never a delete. The record of the request to stop is the point of it. */
export async function setSubscriberStatus(id: string, status: 'active' | 'unsubscribed') {
  await query(
    `update public.newsletter_subscribers
        set status=$2,
            unsubscribed_at = case when $2='unsubscribed' then now() else null end
      where id=$1`, [id, status]);
}
