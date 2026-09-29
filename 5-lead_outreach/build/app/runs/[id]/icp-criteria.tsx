/**
 * The criteria every company on this page was judged against.
 *
 * It used to be the stored JSON in a monospace block, which is the shape the
 * agent wrote rather than the shape a reviewer reads. The criteria are the
 * argument for every verdict on the page, so the one person who has to agree
 * or disagree with them should not be parsing braces to find out what
 * "headcount_range" was set to.
 *
 * The JSON is still one click away, because the point of this desk is that
 * nothing about a verdict is hidden from the person signing off on it.
 */

type Shape = 'text' | 'tags' | 'list';

/**
 * Field order is the order a person asks the questions in: who are we looking
 * for, where, how big, who do we talk to, why, and then what rules out a
 * company. Hard filters and disqualifiers sit last because they are read as
 * exceptions to everything above them.
 */
const FIELDS: { key: string; label: string; shape: Shape; note?: string }[] = [
  { key: 'target_company_type', label: 'Target company', shape: 'text' },
  { key: 'industries', label: 'Industries', shape: 'tags' },
  { key: 'geography', label: 'Geography', shape: 'tags' },
  { key: 'headcount_range', label: 'Headcount', shape: 'text' },
  { key: 'buyer_persona', label: 'Who we would talk to', shape: 'text' },
  { key: 'business_problem', label: 'The problem being solved', shape: 'text' },
  { key: 'hard_filters', label: 'Hard filters', shape: 'list',
    note: 'A company failing any of these cannot qualify.' },
  { key: 'soft_preferences', label: 'Preferred, not required', shape: 'list' },
  { key: 'disqualifiers', label: 'Disqualifiers', shape: 'list',
    note: 'Any one of these rules a company out on its own.' },
];

const filled = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== '';

function Value({ value, shape }: { value: unknown; shape: Shape }) {
  const items = Array.isArray(value) ? value.map(String) : [String(value)];

  if (shape === 'tags') {
    return (
      <div className="tags">
        {items.map((v) => <span className="tag" key={v}>{v}</span>)}
      </div>
    );
  }
  if (shape === 'list') {
    return <ul className="tight" style={{ margin: 0 }}>
      {items.map((v) => <li key={v}>{v}</li>)}
    </ul>;
  }
  return <>{items.join(', ')}</>;
}

export function IcpCriteria({ icp }: { icp: Record<string, unknown> }) {
  const known = new Set(FIELDS.map((f) => f.key));
  // Anything the agent stored that this component does not know about. Shown
  // rather than dropped: a criterion a reviewer cannot see is one they cannot
  // argue with, and the schema will grow.
  const extra = Object.entries(icp).filter(([k, v]) => !known.has(k) && filled(v));
  const shown = FIELDS.filter((f) => filled(icp[f.key]));

  return (
    <>
      <dl className="criteria">
        {shown.map((f) => (
          <div className="criteria-row" key={f.key}>
            <dt>{f.label}</dt>
            <dd>
              <Value value={icp[f.key]} shape={f.shape} />
              {f.note && <p className="small muted" style={{ margin: '4px 0 0' }}>{f.note}</p>}
            </dd>
          </div>
        ))}
        {extra.map(([k, v]) => (
          <div className="criteria-row" key={k}>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd>
              <Value
                value={typeof v === 'object' ? JSON.stringify(v) : v}
                shape={Array.isArray(v) ? 'list' : 'text'}
              />
            </dd>
          </div>
        ))}
      </dl>

      <details style={{ marginTop: 14 }}>
        <summary className="small">Show what was stored, exactly</summary>
        <pre className="excerpt" style={{ marginTop: 8 }}>{JSON.stringify(icp, null, 2)}</pre>
      </details>
    </>
  );
}
