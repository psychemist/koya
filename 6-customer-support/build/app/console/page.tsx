import Link from 'next/link';
import { listConversations, CHANNEL_LABEL } from '../../lib/console.ts';
import { usd, utc, words } from '../ui/format.ts';
import { Pill } from '../ui/pill.tsx';

const STATUSES = ['resolved', 'clarified', 'ticketed', 'escalated', 'declined', 'abandoned', 'failed', 'open'];

export default async function Conversations({ searchParams }: { searchParams: Promise<{ status?: string; channel?: string }> }) {
  const f = await searchParams;
  const rows = await listConversations({ status: f.status, channel: f.channel, limit: 200 });
  return (
    <>
      <div className="rp-page-head"><h1>Conversations</h1><p>{rows.length === 200 ? 'The 200 most recent' : `${rows.length} ${rows.length === 1 ? 'conversation' : 'conversations'}`}{f.status || f.channel ? ', filtered' : ''}</p></div>
      <form className="rp-filters" method="get">
        <label>Status <select name="status" defaultValue={f.status ?? ''}><option value="">Any</option>
          {STATUSES.map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></label>
        <label>Channel <select name="channel" defaultValue={f.channel ?? ''}><option value="">Any</option>
          {Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <button type="submit" className="rp-btn rp-btn-quiet">Filter</button>
        {(f.status || f.channel) && <a href="/console" className="rp-link-btn">Clear filters</a>}
      </form>
      {rows.length === 0 ? <p className="rp-lede">No conversations match. Clear the filters, or start one from the support page.</p> : (
        <div className="rp-table-wrap"><table className="rp-table">
          <thead><tr><th>Started</th><th>Channel</th><th>Caller</th><th>Outcome</th><th className="num">Turns</th><th className="num">Cost</th><th>Summary</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} data-attention={r.final_status === 'failed' || r.final_status === 'escalated' ? 'true' : undefined}>
              <td><Link href={`/console/conversations/${r.id}`}>{utc(r.started_at)}</Link></td>
              <td>{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
              <td>{r.caller_identifier ?? ''}</td>
              <td>{r.final_status ? <Pill value={r.final_status} /> : r.ended_at ? '' : <Pill value="open" />}</td>
              <td className="num">{r.turn_count}</td>
              <td className="num">{usd(r.cost_usd)}</td>
              <td className="rp-clip">{r.summary ?? ''}</td>
            </tr>))}
          </tbody></table></div>
      )}
    </>
  );
}
