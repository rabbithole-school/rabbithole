// Pure helpers for `pushes` — "this, to these scholars, right now".
//
// Everything here is deliberately free of `ctx`: the rules that decide
// whether a push is live, who it covers, and how the plate orders it are
// the part most likely to be subtly wrong, so they are unit-testable in
// isolation. Anything needing a database read (resolving a group's
// membership, loading a target's title) lives in the calling mutation.
//
// See review/class-focus-rethink.html for why this table replaced
// `assignments.activitySchedule`.

import type { Doc, Id } from "../_generated/dataModel";

/** The default window a focus stays open. Teachers may override. */
export const DEFAULT_FOCUS_MS = 60 * 60 * 1000;

/** Quick-pick durations offered in the UI and to the Slack agent. */
export const FOCUS_DURATION_CHOICES_MIN = [10, 20, 30, 60, 90] as const;

export type PushDoc = Doc<"pushes">;
export type PushTarget = PushDoc["target"];
export type PushAudience = PushDoc["audience"];
export type PushTiming = PushDoc["timing"];

/**
 * The scholar-side facts needed to decide whether a push covers someone.
 * Resolved once per read, then reused across every candidate push.
 */
export type ScholarAudienceContext = {
  scholarId: Id<"users">;
  institutionId: Id<"institutions"> | undefined;
  groupIds: ReadonlyArray<Id<"scholarGroups">>;
  /**
   * Of the assignments referenced by the pushes being considered, the ones
   * whose roster currently contains this scholar.
   *
   * Deliberately NOT "every assignment this scholar is on": `scholarIds` is
   * an array, so Convex cannot index into it, and assignments accumulate as
   * historical execution records. Scanning them all on every scholar's live
   * subscription would grow with the school's whole history. Resolving only
   * the handful referenced by open pushes is bounded by what is live now.
   */
  assignmentIds: ReadonlyArray<Id<"assignments">>;
};

// ───────────────────────────── timing ─────────────────────────────

/**
 * When a push stops being live on its own.
 *
 * A focus closes at `endsAt`. Nothing else expires on a clock:
 *   - `untilCleared` is the focus lane without a window — it ends when the
 *     scholar completes the work or a teacher wraps it up.
 *   - homework is a deadline to meet, not a window that shuts, so an
 *     overdue assignment stays on the plate (that is the point of overdue).
 */
export function pushExpiresAt(timing: PushTiming): number | null {
  return timing.kind === "focus" ? timing.endsAt : null;
}

/**
 * Focus ⇒ the "finish this first" lane. Homework ⇒ the due list.
 *
 * `untilCleared` is a focus that never closes, so it shares the focus lane.
 * Only the CLOCK differs between them, never the placement.
 */
export function pushLane(timing: PushTiming): "classFocus" | "homework" {
  return timing.kind === "homework" ? "homework" : "classFocus";
}

// ───────────────────────────── liveness ─────────────────────────────

/**
 * Is this push still on the scholar's screen?
 *
 * Two gates:
 *   1. `setAt` stamped     — a planned push is agenda-only, never shown
 *   2. `clearedAt` absent  — not wrapped up by a teacher or by the clear job
 *
 * Deliberately NOT gated on `endsAt`. A focus whose window has closed but
 * that nobody has wrapped is still the thing the class is on — that is
 * exactly what the teacher's own surface means by "running long", and it
 * offers Extend / Wrap rather than pretending the focus vanished. When the
 * scholar's surfaces disagreed with that, one half of the screen said the
 * day was empty while the other half was still printing "Class focus".
 *
 * The safety this used to buy now lives in `isPushBlocking`: an overrun
 * focus keeps its LABEL but loses its WALL, so a slipped clear job leaves a
 * stale line on a screen instead of a scholar locked out of their own app.
 */
export function isPushShowing(push: PushDoc): boolean {
  if (push.setAt === undefined) return false;
  if (push.clearedAt !== undefined) return false;
  return true;
}

/**
 * May this push hold the scholar inside its unit?
 *
 * The wall, unlike the label, is gated on `endsAt` at READ time, and that
 * check is what makes the lock independent of the scheduler. The `runAfter`
 * job that stamps `clearedAt` is a latency optimization: if it is delayed,
 * dropped, or has not fired yet, the wall still comes down on time. Never
 * remove this check on the grounds that the job "should have" run — the old
 * code relied on that and left focuses walling scholars in past their window
 * whenever the job slipped.
 *
 * An `untilCleared` push has no window by construction, so it blocks until a
 * human ends it. That is a teacher deliberately holding the room, not a job
 * failing to fire.
 */
export function isPushBlocking(push: PushDoc, now: number): boolean {
  if (!isPushShowing(push)) return false;
  if (push.blocking !== true) return false;
  const expiresAt = pushExpiresAt(push.timing);
  if (expiresAt !== null && expiresAt <= now) return false;
  return true;
}

/**
 * A push that has run past its window but whose clear job has not landed
 * yet. Callers that can write (a mutation on the read path) may use this
 * to stamp `clearedAt` opportunistically; read-only callers just filter.
 */
export function isPushDueForClear(push: PushDoc, now: number): boolean {
  if (push.clearedAt !== undefined) return false;
  if (push.setAt === undefined) return false;
  const expiresAt = pushExpiresAt(push.timing);
  return expiresAt !== null && expiresAt <= now;
}

// ───────────────────────────── audience ─────────────────────────────

/**
 * Does this push cover this scholar?
 *
 * Resolved live against current membership rather than a stored roster —
 * a scholar who joins Geckos mid-period sees the open focus, one who
 * leaves stops seeing it. See the schema comment on `pushes.audience`.
 */
export function pushCoversScholar(
  push: PushDoc,
  scholar: ScholarAudienceContext,
): boolean {
  // An institution boundary is never crossed, whatever the audience says.
  if (scholar.institutionId !== push.institutionId) return false;

  const audience = push.audience;
  switch (audience.kind) {
    case "institution":
      return true;
    case "group":
      return scholar.groupIds.includes(audience.groupId);
    case "scholars":
      return audience.scholarIds.includes(scholar.scholarId);
    case "assignment":
      return scholar.assignmentIds.includes(audience.assignmentId);
  }
}

/** Every push covering this scholar that is still showing, newest first. */
export function livePushesForScholar(
  pushes: ReadonlyArray<PushDoc>,
  scholar: ScholarAudienceContext,
): PushDoc[] {
  return pushes
    .filter((p) => isPushShowing(p) && pushCoversScholar(p, scholar))
    .sort(comparePushesForPlate);
}

// ───────────────────────────── ordering ─────────────────────────────

/**
 * Plate order. Focus above homework (it is the interrupt), then:
 *   - focus lane: most recently pushed first — the newest instruction wins
 *   - homework:   soonest due first, undated last
 *
 * The focus lane sorts on `setAt` alone, so a windowed `focus` and an
 * untimed `untilCleared` interleave by recency rather than the timed one
 * always winning. A dispatch handed to a scholar five minutes ago IS the
 * newer instruction, whether or not it carries a clock.
 *
 * Undated homework sinks to the bottom of its lane: open-ended work is the
 * least urgent thing there, and it must never displace something actually
 * due today.
 *
 * Ties break on `_id` so the order is total and therefore stable across
 * reads; without that, two pushes stamped in the same millisecond could
 * swap places between renders.
 */
export function comparePushesForPlate(a: PushDoc, b: PushDoc): number {
  const laneA = pushLane(a.timing);
  const laneB = pushLane(b.timing);
  if (laneA !== laneB) return laneA === "classFocus" ? -1 : 1;

  if (laneA === "classFocus") {
    const diff = (b.setAt ?? 0) - (a.setAt ?? 0);
    if (diff !== 0) return diff;
  } else if (a.timing.kind === "homework" && b.timing.kind === "homework") {
    const diff =
      (a.timing.dueAt ?? Number.POSITIVE_INFINITY) -
      (b.timing.dueAt ?? Number.POSITIVE_INFINITY);
    // Two undated rows subtract to NaN, which would make the comparator
    // non-transitive; fall through to the id tiebreak instead.
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
  }

  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

// ───────────────────── activitySchedule mirror (migration) ─────────────────
//
// Scaffolding for TODO.html#pushes-migrate-activity-schedule. Deleted along
// with `assignments.activitySchedule` once reads have switched.

export type ScheduleEntry = NonNullable<
  Doc<"assignments">["activitySchedule"]
>[number];

/**
 * The push fields equivalent to one `activitySchedule` entry.
 *
 * Pure on purpose: this derivation is the whole risk of the migration, and
 * the comparison test that must pass before any read switches over needs to
 * run it without a database. Everything it returns is decided by the entry
 * plus the assignment it hangs off.
 *
 * The three mappings that are not one-to-one:
 *
 *   timing   — `classFocus` splits. WITH endsAt it is a window that closes;
 *              WITHOUT one it is a dispatch released by finishing it, which
 *              is `untilCleared`. Collapsing them would invent a deadline
 *              and let auto-clear delete work in progress.
 *   audience — absent `scholarIds` means cohort-wide, which every reader
 *              resolves against the assignment's CURRENT roster. That is
 *              `assignment`, not a frozen `scholars` list.
 *   blocking — the focus wall is imposed by any live classFocus (see
 *              shared/focusLock.ts `pickLockingFocus`), so the lane IS the
 *              intent. The `soloStartableByMe` refinement stays a read-time
 *              decision and is deliberately not baked in here.
 */
export function pushFieldsFromScheduleEntry(
  a: Doc<"assignments">,
  entry: ScheduleEntry,
): Pick<PushDoc, "target" | "audience" | "timing" | "blocking"> {
  const targeted = entry.scholarIds;
  return {
    target: { kind: "activity", activityId: entry.activityId },
    audience:
      targeted && targeted.length > 0
        ? { kind: "scholars", scholarIds: targeted }
        : { kind: "assignment", assignmentId: a._id },
    timing:
      entry.mode === "homework"
        ? { kind: "homework", dueAt: entry.dueAt }
        : entry.endsAt !== undefined
          ? { kind: "focus", endsAt: entry.endsAt }
          : { kind: "untilCleared" },
    blocking: entry.mode === "classFocus",
  };
}

// ───────────────────────────── blocking ─────────────────────────────

/**
 * Only an activity may block in v1.
 *
 * Blocking is teacher INTENT and is independent of the target; what
 * differs is the RELEASE mechanism. An activity already has a per-scholar
 * clear stamp (`activityCompletions`, which also supports being marked
 * done by hand for offline work). An app or a link has nowhere to record
 * "this scholar is finished", so a blocking one could only be escaped by
 * waiting out the clock — which traps whoever finishes early.
 *
 * This is a scoped implementation limit, NOT a claim that apps are
 * inherently non-blocking. Lifting it means adding a per-scholar clear
 * record keyed on (pushId, scholarId).
 */
export function canTargetBlock(target: PushTarget): boolean {
  return target.kind === "activity";
}

export function assertBlockingAllowed(
  target: PushTarget,
  blocking: boolean,
): void {
  if (blocking && !canTargetBlock(target)) {
    throw new Error(
      `A ${target.kind} push cannot block: only an activity has a ` +
        `per-scholar completion stamp to release the lock.`,
    );
  }
}

// ───────────────────────────── construction ─────────────────────────────

/** Resolve a focus window from an optional duration, clamped to sanity. */
export function focusEndsAt(now: number, durationMin?: number): number {
  const ms =
    durationMin === undefined
      ? DEFAULT_FOCUS_MS
      : Math.round(durationMin * 60 * 1000);
  const clamped = Math.min(Math.max(ms, 60 * 1000), 8 * 60 * 60 * 1000);
  return now + clamped;
}
