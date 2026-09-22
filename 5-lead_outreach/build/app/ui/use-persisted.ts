'use client';

import { useEffect, useState } from 'react';

/**
 * Keeps a carefully typed objective through a refresh.
 *
 * Restored in an effect rather than during render, because reading storage
 * during render gives the server and the client different first paints. Every
 * access is wrapped: a private window throws on the first read, and losing a
 * draft objective to an exception is worse than losing the convenience.
 */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void, () => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch { /* storage unavailable; the form still works */ }
  }, [key]);

  const update = (next: T) => {
    setValue(next);
    try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const clear = () => {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  };

  return [value, update, clear];
}
