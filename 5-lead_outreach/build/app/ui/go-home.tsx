'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sends a lost visitor back to the runs list, after telling them they were
 * lost.
 *
 * The wait is the point. A 404 that bounces instantly leaves somebody staring
 * at the home page wondering whether they clicked the wrong thing, and it
 * hides a stale link from the person best placed to report it. A few seconds
 * with the reason on screen costs nothing and answers both.
 *
 * `replace` rather than `push`, so the back button returns to wherever they
 * came from instead of to the page that was not there.
 */
export function GoHome({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    const tick = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    const go = setTimeout(() => router.replace('/'), seconds * 1000);
    return () => { clearInterval(tick); clearTimeout(go); };
  }, [router, seconds]);

  return (
    <p className="small">
      {/* Off, not polite: a screen reader counting down every second is worse
          than no countdown at all. The link is the real way out. */}
      <span className="muted" aria-live="off">
        Taking you to the runs list in {left} {left === 1 ? 'second' : 'seconds'}.
      </span>{' '}
      <a href="/">Go there now</a>
    </p>
  );
}
