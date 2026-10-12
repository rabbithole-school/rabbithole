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
 *   - a class-focus end that is still ahead is preserved; an end that already
 *     passed is dropped. The released focus is then unspecified and follows
 *     the same-day fade rule instead of inventing a replacement duration.
 *
 * Generic over the id type so both the client (string-ish branded ids) and
 * tests can use it.
 */

export type PlannedEntryLike<ScholarId> = {
  mode: "classFocus" | "homework";
  endsAt: number | null;
  dueAt: number | null;
  scholarIds: ScholarId[] | null;
};

export type ReleaseArgs<ScholarId> = {
  mode: "classFocus" | "homework";
  endsAt?: number;
  dueAt?: number;
  scholarIds?: ScholarId[];
};

export function plannedReleaseArgs<ScholarId>(
  entry: PlannedEntryLike<ScholarId>,
  now: number,
): ReleaseArgs<ScholarId> {
  const endsAt =
    entry.mode === "classFocus" &&
    entry.endsAt != null &&
    entry.endsAt > now
      ? entry.endsAt
      : undefined;
  return {
    mode: entry.mode,
    endsAt,
    dueAt: entry.mode === "homework" ? (entry.dueAt ?? undefined) : undefined,
    scholarIds:
      entry.scholarIds && entry.scholarIds.length > 0
        ? entry.scholarIds
        : undefined,
  };
}
