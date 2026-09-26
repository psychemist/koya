import type { Metadata } from 'next';
import { GoHome } from './ui/go-home';

export const metadata: Metadata = { title: 'Not found' };

/**
 * Every 404 on the desk, including the deliberate ones.
 *
 * A run that exists but belongs to somebody else is answered with not found
 * rather than forbidden, because telling a person a run exists is itself a
 * disclosure. So this page cannot say why the page is missing, only that it
 * is, and it says nothing that would let somebody tell the two cases apart.
 */
export default function NotFound() {
  return (
    <main className="wrap narrow notfound">
      {/* Decorative. The heading below is what a screen reader should read,
          because "404" on its own says less than the sentence does. */}
      <div className="notfound-code" aria-hidden="true">404</div>
      <h1>That page is not here.</h1>
      <p>
        The link may be stale, or the run it pointed at may have been deleted along with
        its evidence.
      </p>
      <GoHome />
    </main>
  );
}
