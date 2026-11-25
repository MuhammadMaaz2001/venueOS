'use client';

import { useEffect, useState } from 'react';

/** `value`, but only after it stayed the same for `delayMs` (a search box, a duplicate check while typing). */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
