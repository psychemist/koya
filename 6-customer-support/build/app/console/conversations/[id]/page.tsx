import Link from 'next/link';
import { notFound } from 'next/navigation';
import { conversationDetail, CHANNEL_LABEL } from '../../../../lib/console.ts';
import { StatusActions } from '../../../ui/status-actions.tsx';
import { usd, utc, words } from '../../../ui/format.ts';

const GATE: Record<string, string> = { G1: 'reply shape', G2: 'grounding', G3: 'required escalation', G4: 'promise', G5: 'sensitive data', G6: 'speakable' };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const d = await conversationDetail((await params).id);
  if (!d) notFound();
  const { conversation: c } = d;
  // Every chunk the conversation retrieved, so a citation can show what it points at.
  const chunk = new Map<string, { title: string; summary: string }>();
  for (const r of d.retrievals) r.chunk_ids.forEach((id: string, i: number) => chunk.set(id, { title: r.source_titles[i], summary: r.source_summaries[i] }));
  // One timeline: tool calls by the time they ran, each turn at the time it was answered.
  const timeline = [
    ...d.toolCalls.map((t: any) => ({ at: new Date(t.created_at).getTime(), kind: 'tool' as const, t })),
    ...d.turns.map((t: any) => ({ at: new Date(t.created_at).getTime(), kind: 'turn' as const, t })),
  ].sort((a, b) => a.at - b.at);

  return (
    <>
      <p className="rp-crumb"><Link href="/console">Conversations</Link></p>
      <h1>{CHANNEL_LABEL[c.channel] ?? c.channel} conversation</h1>
      <dl className="rp-facts">
        <div><dt>Started</dt><dd>{utc(c.started_at)}</dd></div>
        <div><dt>Ended</dt><dd>{c.ended_at ? `${utc(c.ended_at)} (${words(c.ended_reason)})` : 'Still open'}</dd></div>
        <div><dt>Outcome</dt><dd>{c.final_status ? words(c.final_status) : 'Not finalised'}</dd></div>
        <div><dt>Caller</dt><dd>{c.caller_identifier ?? ''}{c.verified_customer_id ? `, verified as ${c.verified_customer_id}` : ''}</dd></div>
        <div><dt>Turns and cost</dt><dd>{c.turn_count} turns, {usd(c.cost_usd)}{c.model ? `, ${c.model}` : ''}</dd></div>
        {c.summary && <div><dt>Summary</dt><dd>{c.summary}</dd></div>}
      </dl>

      <h2>Timeline</h2>
      {timeline.length === 0 ? <p className="rp-lede">Nothing was said on this conversation.</p> : (
        <ol className="rp-timeline">
          {timeline.map((e, i) => e.kind === 'tool' ? (
            <li key={i} className="rp-tl-tool" data-status={e.t.status}>
              <span className="rp-tl-when">{utc(e.t.created_at)}</span>
              <p><strong>{e.t.tool_name}</strong> {words(e.t.status)}{e.t.duration_ms != null ? `, ${e.t.duration_ms} ms` : ''}</p>
              {e.t.purpose && <p className="rp-mute">Purpose: {e.t.purpose}</p>}
              {e.t.error_code && <p className="rp-bad">{e.t.error_code}: {e.t.error_message}</p>}
            </li>
          ) : (
            <li key={i} className="rp-tl-turn" data-status={e.t.status}>
              <span className="rp-tl-when">{utc(e.t.created_at)}, turn {e.t.seq}</span>
              <p><span className="rp-who">Caller</span> {e.t.user_transcript}</p>
              <p><span className="rp-who">RelayPay</span> {e.t.assistant_response}</p>
              <p className="rp-mute">{words(e.t.answer_type)}, {words(e.t.status)}, {e.t.latency_ms ?? '?'} ms, {usd(e.t.cost_usd)}</p>
              {e.t.confidence_note && <p className="rp-mute">Why: {e.t.confidence_note}</p>}
              {e.t.citations?.length > 0 && <ul className="rp-cites">{e.t.citations.map((id: string) => (
                <li key={id}><strong>{chunk.get(id)?.title ?? id}</strong>{chunk.get(id) ? `: ${chunk.get(id)!.summary}` : ''}</li>))}</ul>}
              <p className="rp-mute">Checks: {e.t.gate_result?.attempts ?? 1} {e.t.gate_result?.attempts === 1 ? 'attempt' : 'attempts'}
                {e.t.gate_result?.violations?.length ? `; the last one failed ${e.t.gate_result.violations.map((v: any) => `${GATE[v.gate] ?? v.gate} (${v.detail})`).join('; ')}` : '; passed'}
                {e.t.gate_result?.retried_for?.length ? `. Retried because the first reply failed ${e.t.gate_result.retried_for.map((v: any) => `${GATE[v.gate] ?? v.gate} (${v.detail})`).join('; ')}` : ''}</p>
            </li>
          ))}
        </ol>
      )}

      <h2>Tickets</h2>
      {d.tickets.length === 0 ? <p className="rp-lede">No ticket was raised.</p> : d.tickets.map((t: any) => (
        <div key={t.id} className="rp-record">
          <p><strong>{t.ticket_ref}</strong> {t.category}, {t.priority} priority, {words(t.status)}{t.transaction_id ? `, ${t.transaction_id}` : ''}</p>
          <p>{t.summary}</p>
          <StatusActions kind="tickets" id={t.id} reference={t.ticket_ref} status={t.status} />
        </div>))}

      <h2>Escalation</h2>
      {!d.escalation ? <p className="rp-lede">Not escalated.</p> : (
        <div className="rp-record">
          <p><Link href={`/console/escalations/${d.escalation.id}`}><strong>{d.escalation.escalation_ref}</strong></Link> {d.escalation.category}, {words(d.escalation.status)}</p>
          <p>{d.escalation.reason}</p>
          <p className="rp-mute">Booking {words(d.escalation.booking_status)}{d.escalation.appointment_at ? ` for ${utc(d.escalation.appointment_at)}` : ''}; team {d.escalation.notify_status === 'failed' ? 'not notified' : words(d.escalation.notify_status)}</p>
        </div>)}

      <h2>Events</h2>
      {d.events.length === 0 ? <p className="rp-lede">No events.</p> : (
        <ul className="rp-events">{d.events.map((ev: any) => <li key={ev.id}><span className="rp-tl-when">{utc(ev.created_at)}</span> {words(ev.event_type)}: {ev.summary}</li>)}</ul>)}
    </>
  );
}
