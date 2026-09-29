/**
 * One row per URL, because `scraped_pages` allows several.
 *
 * Nothing stops a page being fetched twice in a run, and a run reclaimed after
 * a worker dies re-reads what the first session had already read. Two rows for
 * one URL is still one page: rendering both showed a reviewer the same excerpt
 * twice and handed React two children with the same key, which it warns about
 * and is entitled to render however it likes.
 *
 * The screened row wins. An unscreened one has no excerpt to show, so keeping
 * it would turn a page a reviewer could read into one they cannot.
 */
export type StoredPage = { url: string; screened_summary: string | null };

export function oneRowPerUrl<T extends StoredPage>(pages: T[]): T[] {
  const byUrl = new Map<string, T>();
  for (const page of pages) {
    const kept = byUrl.get(page.url);
    if (!kept || (!kept.screened_summary && page.screened_summary)) byUrl.set(page.url, page);
  }
  return [...byUrl.values()];
}
