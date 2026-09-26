import { roleLabel } from '../../lib/auth.ts';
import { SignOut } from './sign-out';

/**
 * The one bar, on every signed-in page.
 *
 * It exists because there was no navigation at all on the run page, which is
 * the page a reviewer spends their whole session on: getting back to the list
 * meant a pair of links joined by a middle dot above the heading. Links are
 * rendered for every page the person is allowed to see, so what a reviewer can
 * reach is never a function of which page they happen to be standing on.
 */
export function Nav({ user, current }: {
  user: { name: string; role: string };
  current?: 'runs' | 'admin';
}) {
  return (
    <nav className="nav" aria-label="Main">
      <a className="nav-mark" href="/">Koya Talent Lead Desk</a>

      <div className="nav-links">
        <a href="/" aria-current={current === 'runs' ? 'page' : undefined}>
          Runs
        </a>
        {user.role === 'admin' && (
          <a href="/admin" aria-current={current === 'admin' ? 'page' : undefined}>
            Team and Spend
          </a>
        )}
      </div>

      <div className="nav-end">
        <span className="nav-who">{user.name}, {roleLabel(user.role)}</span>
        <SignOut />
      </div>
    </nav>
  );
}
