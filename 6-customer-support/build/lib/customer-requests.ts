import { query } from './db.ts';

export type CustomerRequest = {
  kind: 'ticket' | 'escalation'; ref: string; status: 'open' | 'in_progress' | 'closed'; category: string;
  summary: string; created_at: string; callback_at: string | null; booking_status: string | null; priority: string | null;
};

/**
 * A signed-in customer's tickets and escalations, newest first. A row belongs to them when it carries their
 * customer ID, or when the conversation it came from was verified as them. Eval runs are never shown: they
 * use the seed customers, and their bookings are dry runs.
 */
export async function requestsFor(customerId: string): Promise<CustomerRequest[]> {
  const rows = await query<CustomerRequest & { created_at: Date; callback_at: Date | null }>(
    `select 'ticket' as kind, t.ticket_ref as ref, t.status, t.category, t.summary, t.created_at,
            null::timestamptz as callback_at, null as booking_status, t.priority
       from public.support_tickets t join public.conversations c on c.id = t.conversation_id
      where c.channel <> 'eval' and (t.customer_id = $1 or c.verified_customer_id = $1)
     union all
     select 'escalation', e.escalation_ref, e.status, e.category, e.reason, e.created_at,
            case when e.call_booked and e.booking_status = 'booked' then e.appointment_at end, e.booking_status, null
       from public.escalations e join public.conversations c on c.id = e.conversation_id
      where c.channel <> 'eval' and (e.customer_id = $1 or c.verified_customer_id = $1)
     order by created_at desc limit 50`, [customerId]);
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString(),
    callback_at: r.callback_at ? new Date(r.callback_at).toISOString() : null }));
}

export const isActive = (r: CustomerRequest) => r.status !== 'closed';
