import Link from 'next/link';
import { listTickets } from '../../../lib/console.ts';
import { StatusActions } from '../../ui/status-actions.tsx';
import { utc } from '../../ui/format.ts';
import { Pill } from '../../ui/pill.tsx';

export default async function Tickets() {
  const rows = await listTickets();
  return (
    <>
      <div className="rp-page-head"><h1>Tickets</h1><p>{rows.filter((t) => t.status !== 'closed').length} open of {rows.length}</p></div>
      {rows.length === 0 ? <p className="rp-lede">No tickets yet. The agent raises one when an issue needs support follow-up.</p> : (
        <div className="rp-table-wrap"><table className="rp-table">
          <thead><tr><th>Reference</th><th>Raised</th><th>Category</th><th>Priority</th><th>Summary</th><th>Status</th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.id} data-attention={t.priority === 'urgent' || t.priority === 'high' ? 'true' : undefined}>
              <td><Link href={`/console/conversations/${t.conversation_id}`}>{t.ticket_ref}</Link></td>
              <td>{utc(t.created_at)}</td><td>{t.category}</td><td><Pill value={t.priority} /></td><td className="rp-clip">{t.summary}</td>
              <td><StatusActions kind="tickets" id={t.id} reference={t.ticket_ref} status={t.status} /></td>
            </tr>))}
          </tbody></table></div>)}
    </>
  );
}
