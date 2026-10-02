import Link from 'next/link';
import { listEscalations } from '../../../lib/console.ts';
import { StatusActions } from '../../ui/status-actions.tsx';
import { utc, words } from '../../ui/format.ts';

export default async function Escalations() {
  const rows = await listEscalations();
  return (
    <>
      <div className="rp-page-head"><h1>Escalations</h1><p>{rows.filter((e) => e.status !== 'closed').length} open of {rows.length}</p></div>
      {rows.length === 0 ? <p className="rp-lede">No escalations yet.</p> : (
        <div className="rp-table-wrap"><table className="rp-table">
          <thead><tr><th>Reference</th><th>Raised</th><th>Category</th><th>Customer</th><th>Callback</th><th>Team</th><th>Status</th></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id} data-attention={e.notify_status === 'failed' ? 'true' : undefined}>
              <td><Link href={`/console/escalations/${e.id}`}>{e.escalation_ref}</Link></td>
              <td>{utc(e.created_at)}</td><td>{e.category}</td><td>{e.user_name}<br /><span className="rp-mute">{e.user_email}</span></td>
              <td>{e.call_booked && e.appointment_at ? utc(e.appointment_at) : words(e.booking_status)}</td>
              <td>{e.notify_status === 'failed'
                ? <span className="rp-alert" title={e.last_error ?? ''}>Team not notified{e.last_error ? `: ${e.last_error}` : ''}</span>
                : words(e.notify_status)}</td>
              <td><StatusActions kind="escalations" id={e.id} reference={e.escalation_ref} status={e.status} /></td>
            </tr>))}
          </tbody></table></div>)}
    </>
  );
}
