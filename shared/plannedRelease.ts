/**
 * Releasing a PLANNED schedule entry — "Start now".
 *
 * A planned entry (`setAt == null`) is on the teacher's schedule and not yet
 * startable by scholars. Releasing it goes through the one existing go-live path,
 * `api.assignments.pushActivity`; this builds the arguments so that release
 * carries the plan forward instead of quietly rewriting it:
 *
 *   - the due date the teacher already chose is preserved (homework);
 *   - per-scholar targeting is preserved — `pushActivity` treats an absent
 *     `scholarIds` as "the whole roster", so dropping it would WIDEN the
 *     audience as a side effect of pressing a button labelled "start";
 *   - an "in that class" end is NOT carried over: the class it now shows up
 *     in may be a different one (planned for tomorrow's block, started
 *     today). The server re-reads the bell block at the release time and ends
 *     it there, or at the end of that school day (TRA-571);
 *   - an "open until <day>" end IS carried over while that day is still
 *     ahead: the teacher chose a day, not a class, so starting early must not
 *     shrink it to today's bell (TRA-638). Which of the two it is comes from
 *     the one helper, shared/openUntil.ts, read in the school's time zone.
 *
 * Generic over the id type so both the client (string-ish branded ids) and
 * tests can use it.
 */

import { isOpenUntil } from "./openUntil";

export type PlannedEntryLike<ScholarId> = {
  mode: "classFocus" | "homework";
  startsAt?: number | null;
  endsAt: number | null;
  dueAt: number | null;
  scholarIds: ScholarId[] | null;
  /** Stored as the `openUntil` timing kind (TRA-726), when the caller knows. */
  openUntilKind?: boolean | null;
};

export type ReleaseArgs<ScholarId> = {
  mode: "classFocus" | "homework";
  endsAt?: number;
  /** Open-until work released with its closing day says so, so it is stored
   *  as open until even on its last day (TRA-726). */
  openUntilKind?: boolean;
  dueAt?: number;
  scholarIds?: ScholarId[];
};

export function plannedReleaseArgs<ScholarId>(
  entry: PlannedEntryLike<ScholarId>,
  now: number,
  timeZone: string,
): ReleaseArgs<ScholarId> {
  const keepsEnd =
    entry.endsAt != null &&
    entry.endsAt > now &&
    isOpenUntil(
      {
        mode: entry.mode,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        openUntilKind: entry.openUntilKind,
      },
      timeZone,
    );
  return {
    mode: entry.mode,
    endsAt: keepsEnd ? entry.endsAt! : undefined,
    ...(keepsEnd ? { openUntilKind: true } : {}),
    dueAt: entry.mode === "homework" ? (entry.dueAt ?? undefined) : undefined,
    scholarIds:
      entry.scholarIds && entry.scholarIds.length > 0
        ? entry.scholarIds
        : undefined,
  };
}
