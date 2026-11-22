"use client";

import { useEffect, useState } from "react";
import {
  bedtimeStateAt,
  SCHOOL_BEDTIME,
  type BedtimeState,
  type BedtimeWindow,
} from "@/shared/bedtime";

/**
 * The bedtime phase for a zone, flipping on time. One timer armed at the next
 * phase change (no ticking clock), recomputed when a sleeping or backgrounded
 * tab resumes, since timers stall there. `null` zone → bedtime doesn't apply.
 * `nightly` is the child's nightly window (the school's unless a parent set a
 * stricter one).
 */
export function useBedtime(
  timeZone: string | null,
  nightly: BedtimeWindow = SCHOOL_BEDTIME,
): BedtimeState | null {
  const { startMinutes, endMinutes } = nightly;
  const [state, setState] = useState<BedtimeState | null>(null);

  useEffect(() => {
    // No zone: the return below already yields null.
    if (!timeZone) return;
    let timer: ReturnType<typeof setTimeout>;
    const recompute = () => {
      clearTimeout(timer);
      const next = bedtimeStateAt(Date.now(), timeZone, {
        startMinutes,
        endMinutes,
      });
      setState(next);
      timer = setTimeout(
        recompute,
        Math.max(1_000, next.changesAt - Date.now() + 250),
      );
    };
    recompute();
    document.addEventListener("visibilitychange", recompute);
    window.addEventListener("focus", recompute);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", recompute);
      window.removeEventListener("focus", recompute);
    };
  }, [timeZone, startMinutes, endMinutes]);

  return timeZone ? state : null;
}
