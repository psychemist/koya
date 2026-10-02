import { analytics } from '../../../lib/analytics.ts';
import { canSeeEvaluations } from '../../../lib/auth.ts';
import { requireConsoleUser } from '../../../lib/console-session.ts';
import { CHANNEL_LABEL } from '../../../lib/console.ts';
import { Bars } from '../../ui/bars.tsx';
import { words } from '../../ui/format.ts';

const secs = (ms: number | null) => (ms == null ? 'none yet' : `${(ms / 1000).toFixed(1)} s`);
const pct = (n: number | null) => (n == null ? 'none yet' : `${n}%`);

/** How the support line is doing, for admins: volume, outcomes, speed, spend, tools and callbacks, from stored rows. */
export default async function Analytics() {
  const user = await requireConsoleUser('/console/analytics');
  if (!canSeeEvaluations(user)) return (
    <>
      <h1>Analytics</h1>
      <p className="rp-lede">Analytics are for admins. Ask an admin if you need a figure.</p>
    </>
  );
  const a = await analytics(30);
  const t = a.totals;
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <>
      <div className="rp-page-head"><h1>Analytics</h1><p>Last 30 days of calls and chats, eval runs left out</p></div>

      <dl className="an-tiles">
        <div><dt>Conversations</dt><dd>{t.conversations}</dd></div>
        <div><dt>Answered without a person</dt><dd>{pct(t.answered_pct)}</dd><span>resolved or clarified</span></div>
        <div><dt>Sent to a specialist</dt><dd>{pct(t.escalated_pct)}</dd><span>{t.callbacks_booked} callbacks booked</span></div>
        <div><dt>Reply time</dt><dd>{secs(t.p50_ms)}</dd><span>median; 95% within {secs(t.p95_ms)}</span></div>
        <div><dt>Model spend</dt><dd>${t.spend_usd.toFixed(2)}</dd><span>Claude, all conversations</span></div>
        <div><dt>Helped, by feedback</dt><dd>{pct(t.helped_pct)}</dd><span>{t.feedback} {t.feedback === 1 ? 'answer' : 'answers'}</span></div>
      </dl>

      <section className="an-grid">
        <Bars title="Conversations per day" note="Last 14 days, UTC" unit="conversations"
          rows={a.perDay.map((d) => ({ label: day(d.day), value: d.conversations }))} vertical />
        <Bars title="How conversations ended" unit="conversations"
          rows={a.outcomes.map((o) => ({ label: words(o.outcome), value: o.conversations }))} />
        <Bars title="Tool calls" note="Through the MCP server; failures in the table" unit="calls"
          rows={a.tools.map((x) => ({ label: words(x.tool), value: x.ok, extra: `${x.failed} failed, ${x.avg_ms ?? 0} ms average` }))} />
        <Bars title="By channel" unit="conversations"
          rows={a.channels.map((c) => ({ label: CHANNEL_LABEL[c.channel] ?? c.channel, value: c.conversations,
            extra: `median reply ${secs(c.p50_ms)}, 95% within ${secs(c.p95_ms)}, $${c.cost_usd.toFixed(2)}` }))} />
      </section>

      <h2>Callbacks</h2>
      <dl className="an-tiles an-tiles-small">
        <div><dt>Booked</dt><dd>{a.bookings.booked}</dd></div>
        <div><dt>Could not book</dt><dd>{a.bookings.failed}</dd><span>the team arranged a time by email</span></div>
        <div><dt>Moved</dt><dd>{a.bookings.moved}</dd><span>the earlier booking cancelled</span></div>
      </dl>
    </>
  );
}
