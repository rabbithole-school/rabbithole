"use client";

import { useEffect, useState } from "react";

/**
 * A coarse reactive clock — `Date.now()` that actually causes a re-render.
 *
 * Convex subscriptions react to WRITES, not to elapsed time. So a component
 * that derives a time-relative claim by reading `Date.now()` during render —
 * or worse, inside a `useMemo` keyed only on the query result — freezes that
 * reading. Nothing re-renders when the only thing that changed is the clock,
 * so the UI keeps asserting a liveness claim that has quietly stopped being
 * true: "3 working right now" long after everyone has stopped, a meeting that
 * never moves from upcoming to past, a "this week" count that never rolls.
 *
 * This is the house rule "match the clock to the claim"
 * (`.claude/rules/rabbithole-product-taste.md` T11) made available as a hook,
 * so a surface can state a live claim honestly without hand-rolling a timer.
 *
 * Use ONE per surface and thread the value down. A clock per row multiplies
 * timers for no gain and lets sibling rows disagree about what "now" is —
 * `ScholarPlate` already does this correctly via `PlateNowContext`.
 *
 * @param intervalMs How often to tick. Pick the COARSEST interval that still
 *   makes the claim honest: 30s for "right now" presence, 60s for "today" or
 *   "this week" boundaries. A finer interval buys nothing and re-renders the
 *   subtree more often.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, intervalMs);
    // A hidden tab's timers are throttled hard (and a sleeping laptop stops
    // them entirely), so a resumed tab can be arbitrarily stale — recompute on
    // the way back in rather than waiting out the next interval. Same shape as
    // `useInstitutionDay`.
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [intervalMs]);

  return now;
}
