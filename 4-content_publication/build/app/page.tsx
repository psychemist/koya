import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { query } from '@/lib/db';
import NewRequest from './new-request';
import SignIn from './sign-in';
import { RequestStatus, BlockingCount } from './ui/status';

export const dynamic = 'force-dynamic';

type Row = {
  id: string; idea: string; audience: string; status: string;
  channels: string[]; cost_usd: string; requester: string; blocking: number;
  updated_at: string;
};

export default async function Home() {
  const user = await currentUser().catch(() => null);
  if (!user) return <SignIn />;

  /**
   * AN UNREACHABLE DATABASE IS NOT AN EMPTY LIST.
   *
   * This read used to end in `.catch(() => [])`, so a dropped connection, a
   * paused Supabase project and a wrong password all rendered the same calm
   * "No requests yet." as a genuinely empty desk. In an app whose entire
   * claim is that it never reports a success it did not achieve, the front
   * page quietly reported the most reassuring thing it could think of. The
   * two outcomes are separate states now, and the failing one says so.
   */
  let rows: Row[] | null = null;
  let loadError: string | null = null;
  try {
    rows = await query<Row>(
      `select r.id, r.idea, r.audience, r.status, r.channels, r.cost_usd, r.updated_at,
              u.name as requester,
              (select count(*)::int from public.flags f
                where f.request_id=r.id and f.severity='blocking' and f.status='open') as blocking
         from public.content_requests r
         join public.users u on u.id=r.requester_id
        order by r.updated_at desc limit 50`);
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'The database did not respond.';
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Content Requests</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            An idea goes in. A researched article, a LinkedIn post, an X post and a newsletter
            come out, and none of them reaches a channel until someone signs it off.
          </p>
        </div>
        <NewRequest />
      </div>

      {loadError && (
        <div className="sheet border-blocking/30 bg-blocking-bg p-4">
          <h2 className="text-sm font-semibold text-blocking">
            The request list could not be loaded
          </h2>
          <p className="mt-1 text-sm text-ink-70">
            This is not an empty desk. The database did not answer, so what is on it is
            unknown. Check that the deployment can reach Postgres, then reload.
          </p>
          <p className="ident mt-2">{loadError}</p>
        </div>
      )}

      {rows && rows.length === 0 && (
        <div className="sheet p-10 text-center">
          <p className="text-sm font-medium">Nothing on the desk yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Start with a raw idea or a source URL. The first stop is three angles to choose
            between, and nothing is written until you pick one.
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="sheet overflow-hidden">
          {/* A table, because these rows are compared down columns: which are
              blocking, which cost the most, which moved last. Cards would hide
              the exact comparison the page exists to support. */}
          <table className="w-full text-sm">
            <caption className="sr-only">
              Content requests, most recently updated first
            </caption>
            <thead>
              <tr className="border-b border-rule bg-sunk/50 text-left text-xs text-muted">
                <th scope="col" className="w-full px-4 py-2.5 font-medium">Idea</th>
                <th scope="col" className="hidden w-px whitespace-nowrap px-4 py-2.5 font-medium md:table-cell">Raised by</th>
                <th scope="col" className="w-px whitespace-nowrap px-4 py-2.5 font-medium">State</th>
                <th scope="col" className="w-px whitespace-nowrap px-4 py-2.5 text-right font-medium">Spent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-rule last:border-0 hover:bg-sunk/40">
                  <td className="max-w-0 px-4 py-3 align-top">
                    <Link href={`/requests/${r.id}`} className="block font-medium hover:underline">
                      <span className="block truncate">{r.idea}</span>
                    </Link>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {r.audience}
                      {(r.channels ?? []).length > 0 && (
                        <span className="text-faint">
                          {'  '}|{'  '}{(r.channels ?? []).join(', ')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="hidden w-px whitespace-nowrap px-4 py-3 align-top text-ink-70 md:table-cell">
                    {r.requester}
                  </td>
                  <td className="w-px px-4 py-3 align-top">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RequestStatus status={r.status} />
                      <BlockingCount n={r.blocking} />
                    </div>
                  </td>
                  <td className="w-px whitespace-nowrap px-4 py-3 text-right align-top tabular-nums text-ink-70">
                    ${Number(r.cost_usd ?? 0).toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
