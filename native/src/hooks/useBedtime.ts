import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  bedtimeStateAt,
  SCHOOL_BEDTIME,
  type BedtimeState,
  type BedtimeWindow,
} from "../../vendor/shared/bedtime";

/**
 * Native twin of hooks/useBedtime.ts: the bedtime phase for a zone, flipping
 * on time. One timer armed at the next phase change, recomputed when the app
 * returns to the foreground (timers don't run while iOS suspends it).
 * `null` zone → bedtime doesn't apply. `nightly` is the child's nightly
 * window (the school's unless a parent set a stricter one).
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
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") recompute();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [timeZone, startMinutes, endMinutes]);

  return timeZone ? state : null;
}
