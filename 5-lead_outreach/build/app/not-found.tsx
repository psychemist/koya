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
      <h1>That page is not here.</h1>
      <p>
        The link may be stale, or the run it pointed at may have been deleted along with
        its evidence.
      </p>
      <GoHome />
    </main>
  );
}
