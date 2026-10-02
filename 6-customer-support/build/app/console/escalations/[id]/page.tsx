import Link from 'next/link';
import { notFound } from 'next/navigation';
import { escalationDetail } from '../../../../lib/console.ts';
import { StatusActions } from '../../../ui/status-actions.tsx';
import { BackLink } from '../../../ui/back-link.tsx';
import { utc, words } from '../../../ui/format.ts';

/** The page the Discord alert and the support email link to. */
export default async function EscalationPage({ params }: { params: Promise<{ id: string }> }) {
  const d = await escalationDetail((await params).id);
  if (!d) notFound();
  const e = d.escalation;
  return (
    <>
      <BackLink href="/console/escalations" label="Back to escalations" />
      <div className="rp-page-head"><h1>{e.escalation_ref}</h1><StatusActions kind="escalations" id={e.id} reference={e.escalation_ref} status={e.status} /></div>
      <dl className="rp-facts">
        <div><dt>Category</dt><dd>{e.category}</dd></div>
        <div><dt>Reason</dt><dd>{e.reason}</dd></div>
        <div><dt>Customer</dt><dd>{e.user_name}, {e.user_email}{e.customer_id ? `, ${e.customer_id}` : ''}</dd></div>
        <div><dt>Asked for</dt><dd>{e.preferred_time_text ?? 'No time given'}{e.caller_timezone ? ` (${e.caller_timezone})` : ''}</dd></div>
        <div><dt>Callback</dt><dd>{e.call_booked && e.appointment_at ? `Booked for ${utc(e.appointment_at)}` : `Not booked (${words(e.booking_status)})`}</dd></div>
        <div><dt>Team</dt><dd>{e.notify_status === 'failed' ? <span className="rp-alert">Team not notified</span> : words(e.notify_status)}</dd></div>
        {d.ticket && <div><dt>Ticket</dt><dd>{d.ticket.ticket_ref}: {d.ticket.summary}</dd></div>}
        <div><dt>Conversation</dt><dd><Link href={`/console/conversations/${e.conversation_id}`}>Open the conversation</Link></dd></div>
      </dl>
      <h2>Notifications</h2>
      {d.notifications.length === 0 ? <p className="rp-lede">None were queued.</p> : (
        <ul className="rp-events">{d.notifications.map((n: any) => (
          <li key={n.id}><span className="rp-tl-when">{utc(n.created_at)}</span> {n.slot_key === 'none' ? 'Alert' : `Booking for ${utc(n.slot_key)}`}: {words(n.status)}, {n.attempts} {n.attempts === 1 ? 'attempt' : 'attempts'}{n.last_error ? `. Last error: ${n.last_error}` : ''}</li>))}</ul>)}
    </>
  );
}
