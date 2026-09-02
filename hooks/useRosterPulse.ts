"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { ScholarPulse } from "@/convex/lib/rosterPulse";

export type { ScholarPulse } from "@/convex/lib/rosterPulse";

// The "Lately" half of the Scholars roster: per-scholar observer aggregates
// (engagement sparkline, trend, recurring concerns, attention score) keyed by
// scholarId so the board can merge them onto the live "Now" roster from
// `users.listScholars`. Scoped to the same institution lens as that roster.
//
// Gated on an institution scope so the subscription only runs on the Scholars
// tab (mirrors how the layout gates listScholars). When the scope is undefined
// (still resolving) we skip and report loading.
export function useRosterPulse(
  institutionScope: string | undefined,
  /** A minute-rounded client clock (from the surface's `useNow(60_000)`),
   *  threaded to the query as an intentional reactive dependency so the live
   *  subscription re-runs across institution-local midnight (T11) — the
   *  practiced-today dot flips without waiting on an unrelated write. Floored to
   *  the minute here so the subscription argument changes at most once a minute.
   *  Omitted → the server falls back to its own `Date.now()`. */
  nowMs?: number,
): {
  isLoading: boolean;
  windowDays: number | null;
  byScholar: Map<string, ScholarPulse>;
  /** Scholars who practised today (spec §3.2) — one field on the batched read,
   *  rendered as a single presence dot. Empty while loading. */
  practicedToday: Set<string>;
} {
  const minuteNow =
    nowMs === undefined ? undefined : Math.floor(nowMs / 60_000) * 60_000;
  const result = useQuery(
    api.scholars.rosterPulse,
    institutionScope === undefined
      ? "skip"
      : { institutionScope, ...(minuteNow === undefined ? {} : { now: minuteNow }) },
  );

  return useMemo(() => {
    if (result === undefined) {
      return {
        isLoading: institutionScope !== undefined,
        windowDays: null,
        byScholar: new Map<string, ScholarPulse>(),
        practicedToday: new Set<string>(),
      };
    }
    const byScholar = new Map<string, ScholarPulse>();
    for (const p of result.scholars) byScholar.set(p.scholarId, p);
    return {
      isLoading: false,
      windowDays: result.windowDays,
      byScholar,
      practicedToday: new Set(result.practicedToday ?? []),
    };
  }, [result, institutionScope]);
}
