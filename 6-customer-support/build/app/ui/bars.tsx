type Row = { label: string; value: number; extra?: string };

/**
 * One measure as bars, in one colour, so there is no key to decode. Each bar carries its value as text and a hover
 * title; the same rows are always available as a table. Horizontal for categories, vertical for days.
 */
export function Bars({ title, note, unit, rows, vertical = false }: { title: string; note?: string; unit: string; rows: Row[]; vertical?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const tip = (r: Row) => `${r.label}: ${r.value} ${unit}${r.extra ? `. ${r.extra}` : ''}`;
  return (
    <figure className="an-card">
      <figcaption><span className="an-title">{title}</span>{note && <span className="an-note">{note}</span>}</figcaption>
      {rows.length === 0 ? <p className="an-empty">Nothing yet in this period.</p> : vertical ? (
        <div className="an-cols" role="img" aria-label={`${title}: ${rows.map(tip).join('; ')}`}>
          {rows.map((r) => (
            <div key={r.label} className="an-col" title={tip(r)}>
              <span className="an-col-v">{r.value || ''}</span>
              <span className="an-col-bar" style={{ height: `${(r.value / max) * 100}%` }} />
              <span className="an-col-l">{r.label}</span>
            </div>
          ))}
        </div>
      ) : (
        <ul className="an-rows">
          {rows.map((r) => (
            <li key={r.label} title={tip(r)}>
              <span className="an-row-l">{r.label}</span>
              <span className="an-row-track"><span className="an-row-bar" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} /></span>
              <span className="an-row-v">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <details className="an-table">
          <summary>Show as table</summary>
          <table className="rp-table"><thead><tr><th>{vertical ? 'Day' : 'Item'}</th><th className="num">{unit}</th>{rows.some((r) => r.extra) && <th>Detail</th>}</tr></thead>
            <tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{r.value}</td>{rows.some((x) => x.extra) && <td>{r.extra ?? ''}</td>}</tr>)}</tbody></table>
        </details>
      )}
    </figure>
  );
}
