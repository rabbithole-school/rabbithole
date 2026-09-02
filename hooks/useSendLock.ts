"use client";

import { useCallback, useRef } from "react";

export function useSendLock() {
  const lockedRef = useRef(false);

  return useCallback(async <T,>(send: () => Promise<T>) => {
    if (lockedRef.current) return undefined;
    lockedRef.current = true;
    try {
      return await send();
    } finally {
      lockedRef.current = false;
    }
  }, []);
}
