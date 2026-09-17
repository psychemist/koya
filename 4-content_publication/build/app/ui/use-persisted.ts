'use client';
import { useEffect, useState } from 'react';

/**
 * State that survives a refresh.
 *
 * Two screens in this app have a step that takes real minutes of a person's
 * attention: describing the idea and its audience at intake, and writing the
 * note that tells an author why their draft is going back. Both lived in
 * component state, so a refresh, a stray Cmd-R, a crashed tab, or following a
 * link and coming back threw them away with no warning and no recovery. The
 * user is never told, because by then there is nothing left to tell them
 * about.
 *
 * Deliberately localStorage, and deliberately only for this kind of value:
 *
 *  - It is per browser and per person, and never leaves the machine. An
 *    unsent note about a colleague's draft is not something to put on a
 *    server.
 *  - It is scoped by a key the caller passes, so one request's note cannot
 *    surface on another request's review screen.
 *  - Every read and write is wrapped. Private windows, cleared site data and
 *    browsers set to block storage all throw on access, and a form that will
 *    not render because a draft could not be read is a worse bug than the one
 *    this fixes.
 *
 * The first render deliberately returns `initial`, not the stored value.
 * Reading storage during render would give the server and the client
 * different HTML and React would throw the whole tree away on hydration; the
 * stored value is adopted in an effect immediately afterwards.
 */
export function usePersisted<T>(key: string, initial: T) {
  const storageKey = `koya:${key}`;
  const [value, setValue] = useState<T>(initial);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // Storage unavailable, or the stored value is no longer parseable after
      // a shape change. Either way the in-memory default is the right answer.
    }
    setRestored(true);
  }, [storageKey]);

  useEffect(() => {
    if (!restored) return;   // never write the default back over a saved draft
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Out of quota, or storage blocked. The form still works, it just will
      // not survive the next refresh, which is where it started.
    }
  }, [storageKey, value, restored]);

  const clear = () => {
    try { window.localStorage.removeItem(storageKey); } catch { /* see above */ }
    setValue(initial);
  };

  return { value, setValue, clear, restored } as const;
}
