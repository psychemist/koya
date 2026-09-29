/** Times in the console are UTC, the same zone support hours are set in. */
export const utc = (d: Date | string | null | undefined) =>
  d ? `${new Date(d).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
export const usd = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : `$${Number(v).toFixed(4)}`);
export const words = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ');
