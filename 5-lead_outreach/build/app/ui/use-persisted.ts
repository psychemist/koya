'use client';

import { useEffect, useRef, useState } from 'react';

const isShape = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What to believe out of storage.
 *
 * A stored copy is last week's shape, not this week's: it was written by
 * whatever version of the form the person last had open, and it outlives
 * every rename, addition and removal since. Trusting it wholesale is what
 * turned a controlled input into an uncontrolled one, because a copy written
 * before `target_leads` existed restored the form without that key and the
 * field's value became undefined.
 *
 * So the initial value is the shape, and storage may only fill it in. A field
 * the copy does not have, or has at the wrong type, keeps what it was given;
 * a field the form no longer has is dropped. Exported for its own tests, and
 * because the rule is worth reading on its own.
 */
export function restored<T>(initial: T, stored: unknown): T {
  if (isShape(initial)) {
    if (!isShape(stored)) return initial;
    const out: Record<string, unknown> = { ...initial };
    for (const key of Object.keys(out)) {
      const value = stored[key];
      // Same type or nothing. A number where the form holds a string is the
      // same bug one step later: the field changes type under React on the
      // first keystroke.
      if (value !== undefined && value !== null && typeof value === typeof out[key]) {
        out[key] = value;
      }
    }
    return out as T;
  }
  return typeof stored === typeof initial && stored !== null ? (stored as T) : initial;
}

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
  // The shape to restore into, held still so the effect does not depend on a
  // caller that hands us a fresh object literal every render.
  const shape = useRef(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(restored(shape.current, JSON.parse(raw)));
    } catch { /* storage unavailable, or the copy is not JSON; the form still works */ }
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
