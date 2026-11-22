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
import { isFocusShowing } from "../../shared/focusShowing";
import { dayStartForDayKey, shiftDayKey } from "../../shared/institutionDay";
import { openUntilClosesAt } from "../../shared/openUntil";

/** The default window a focus stays open. Teachers may override. */
export const DEFAULT_FOCUS_MS = 60 * 60 * 1000;

/** Quick-pick durations offered in the UI and to the Slack agent. */
export const FOCUS_DURATION_CHOICES_MIN = [10, 20, 30, 60, 90] as const;

export type PushDoc = Doc<"pushes">;
export type PushTarget = PushDoc["target"];
export type PushAudience = PushDoc["audience"];
export type PushTiming = PushDoc["timing"];
export type FocusClock = {
  nowMs: number;
  todayDayKey: string;
  timeZone: string;
};

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
 * The push fields its end and lane are read from: the top-level `endsAt` +
 * `afterEnd`, and `timing.kind` only as the explicit-versus-untimed focus
 * discriminator; it holds nothing else (TRA-580 step 5).
 *
 * A `Pick` keeps `endsAt` optional, as it is in the schema (undated homework
 * and an unactivated untimed plan have no end).
 */
export type PushEndInput = Pick<PushDoc, "endsAt" | "afterEnd"> & {
  timing: Pick<PushTiming, "kind">;
};

/**
 * The end of a focus whose window was set EXPLICITLY; null for anything else.
 *
 * `timing.kind` survives here only as the explicit-versus-untimed
 * discriminator. An `untilCleared` focus is stored with the end of its school
 * day as `endsAt` (fade), which is indistinguishable from an explicit focus
 * ending at that same millisecond. Readers treat the two differently — an
 * untimed focus has no expiry, no auto-clear, no "until" copy and no tutor
 * deadline — so its synthetic end must never leak out as a real one.
 */
export function explicitFocusEnd(push: PushEndInput): number | null {
  if (!isTimedFocusKind(push.timing.kind)) return null;
  return push.endsAt ?? null;
}

/**
 * A focus with an explicit window: `focus`, or `openUntil` (TRA-726), which is
 * a focus whose window closes at the end of a later school day. Every reader
 * treats the two alike except where it asks whether the give is open-until
 * (shared/openUntil.ts `isOpenUntil`, fed by `isOpenUntilKind`).
 */
export function isTimedFocusKind(kind: PushTiming["kind"]): boolean {
  return kind === "focus" || kind === "openUntil";
}

/** Is this row stored with the `openUntil` timing kind (TRA-726)? */
export function isOpenUntilKind(push: { timing: Pick<PushTiming, "kind"> }): boolean {
  return push.timing.kind === "openUntil";
}

/**
 * When an "Open until a date" give's window closes, or null for any other
 * push (shared/openUntil.ts `isOpenUntil`: the stored `openUntil` kind, else
 * the date guess). The scholar's Now tab files such a give under "Open from
 * class" with the unit activities given the same way, never under the class
 * section.
 */
export function pushOpenUntil(
  push: PushEndInput & Pick<PushDoc, "setAt" | "startsAt">,
  timeZone: string,
): number | null {
  return openUntilClosesAt(
    {
      mode: pushLane(push),
      setAt: push.setAt,
      startsAt: push.startsAt,
      endsAt: explicitFocusEnd(push),
      openUntilKind: isOpenUntilKind(push),
    },
    timeZone,
  );
}

/** A homework push's due date; null for focus or undated homework. */
export function homeworkDueAt(push: PushEndInput): number | null {
  return push.afterEnd === "late" ? (push.endsAt ?? null) : null;
}

/**
 * When a push stops being live on its own.
 *
 * A focus closes its blocking window at its explicit end. Nothing else expires
 * on a timestamp:
 *   - `untilCleared` is the focus lane without a window — it stops showing
 *     after its institution day unless a teacher wraps it sooner.
 *   - homework is a deadline to meet, not a window that shuts, so an
 *     overdue assignment stays on the plate (that is the point of overdue).
 */
export function pushExpiresAt(push: PushEndInput): number | null {
  return explicitFocusEnd(push);
}

/**
 * Focus ⇒ the "finish this first" lane. Homework (a give that goes late
 * rather than fading) ⇒ the due list.
 *
 * `untilCleared` is a focus without an explicit future lifetime, so it shares
 * the focus lane and remains visible only on the institution day it was set.
 */
export function pushLane(push: PushEndInput): "classFocus" | "homework" {
  return push.afterEnd === "late" ? "homework" : "classFocus";
}

// ───────────────────────────── liveness ─────────────────────────────

/**
 * Is this push still on the scholar's screen?
 *
 * Three gates:
 *   1. `setAt` stamped     — a planned push is agenda-only, never shown
 *   2. `clearedAt` absent  — not wrapped up by a teacher or by the clear job
 *   3. focus timing         — set today, or explicitly extended into the future
 *
 * An app target additionally needs a finite, fading focus end
 * (`hasFiniteFadingEnd`); without one it never shows (TRA-336).
 *
 * Homework never expires here. An `untilCleared` focus has no future clock, so
 * it is a same-day instruction unless a teacher clears it sooner.
 */
export function isPushShowing(push: PushDoc, clock: FocusClock): boolean {
  if (push.setAt === undefined) return false;
  if (push.clearedAt !== undefined) return false;
  // An app give unlocks the launcher tile, the launch gates, credential
  // autofill and the device's MDM allowlist, so one without a finite end is a
  // standing grant in disguise (TRA-336). Refused here, not in one reader, so
  // a legacy or hand-inserted row grants nothing on any surface.
  if (push.target.kind === "app" && !hasFiniteFadingEnd(push)) return false;
  if (pushLane(push) === "homework") return true;
  return isFocusShowing(
    {
      setAt: push.setAt,
      endsAt: explicitFocusEnd(push) ?? undefined,
    },
    clock.nowMs,
    clock.todayDayKey,
    clock.timeZone,
  );
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
 * An `untilCleared` push has no window by construction, so it blocks while its
 * same-day focus is showing.
 */
export function isPushBlocking(push: PushDoc, clock: FocusClock): boolean {
  if (!isPushShowing(push, clock)) return false;
  if (push.blocking !== true) return false;
  const expiresAt = pushExpiresAt(push);
  if (expiresAt !== null && expiresAt <= clock.nowMs) return false;
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
  const expiresAt = pushExpiresAt(push);
  return expiresAt !== null && expiresAt <= now;
}

/**
 * When a push that `isPushShowing` shows at `clock` is EXPECTED to stop
 * showing. An expectation, not a guarantee:
 *
 *   - Inside its window: the window's end, because that is when the clear
 *     scheduled for it (`pushes.autoClearPush`) stamps `clearedAt`. If that
 *     clear is late, a push set today keeps showing past its window, as an
 *     overrun, until the institution-local midnight.
 *   - Past its window with nothing cleared (an overrun, which a clear normally
 *     ends within minutes): the midnight after today, the latest
 *     `isPushShowing` shows it on its own, clear or no clear.
 *   - A homework push never expires on its own: null.
 *
 * A schedule placement's `endsAt` is already the block's end plus
 * `APP_PLACEMENT_GRACE_MS` (masterSchedule.ts), so the grace needs no term
 * here. Only meaningful for a push that is showing now. Two readers share it:
 * the staff "who can use this app" read (`appAudiences.aideGetAppAccess`) and
 * the per-scholar `until` of `lib/deviceAppProjection.scholarAppAccess`.
 */
export function liveUntil(push: PushDoc, clock: FocusClock): number | null {
  if (pushLane(push) === "homework") return null;
  const endsAt = pushExpiresAt(push);
  if (endsAt !== null && endsAt > clock.nowMs) return endsAt;
  return dayStartForDayKey(shiftDayKey(clock.todayDayKey, 1), clock.timeZone);
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
  clock: FocusClock,
): PushDoc[] {
  return pushes
    .filter((p) => isPushShowing(p, clock) && pushCoversScholar(p, scholar))
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
  const laneA = pushLane(a);
  const laneB = pushLane(b);
  if (laneA !== laneB) return laneA === "classFocus" ? -1 : 1;

  if (laneA === "classFocus") {
    const diff = (b.setAt ?? 0) - (a.setAt ?? 0);
    if (diff !== 0) return diff;
  } else {
    const diff =
      (homeworkDueAt(a) ?? Number.POSITIVE_INFINITY) -
      (homeworkDueAt(b) ?? Number.POSITIVE_INFINITY);
    // Two undated rows subtract to NaN, which would make the comparator
    // non-transitive; fall through to the id tiebreak instead.
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
  }

  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

// ───────────────────── assignment schedule entries ─────────────────────
//
// An assignment's schedule is stored as `pushes` rows (lib/scheduleStore).
// Readers and writers work in this entry shape, one entry per
// (activity, mode); the rows are the only storage (Linear TRA-13).

/** One activity on an assignment's schedule, as readers and writers see it. */
export type ScheduleEntry = {
  activityId: Id<"activities">;
  mode: "classFocus" | "homework";
  /** When it went live to scholars. Absent = planned, agenda-only. */
  setAt?: number;
  /** Planned time; drives agenda position, never auto-pushes on edit. */
  startsAt?: number;
  /** Pending activation or auto-clear job, so reschedule/clear can cancel it. */
  scheduledFnId?: Id<"_scheduled_functions">;
  /** Class focus: when it leaves screens. Homework: when staff ended it. */
  endsAt?: number;
  /** Homework: late after this. */
  dueAt?: number;
  /** Absent = everyone on the assignment; present = only these scholars. */
  scholarIds?: Id<"users">[];
  /** Homework only: the class it was given for, named by the teacher or the
   *  aide's class pick (TRA-581), stamped as the row's `classId` after the
   *  class checks (lib/classLink.ts `homeworkClassFields`) instead of finding a
   *  meeting at its start. Write-side only: readers get it as `classId`. */
  homeworkClassId?: Id<"classes">;
  /** A timed class focus only: the teacher's finish. `true` = "Open until"
   *  a later day, stored as the `openUntil` timing kind; `false` = "In that
   *  class", stored as `focus` (TRA-726). Read back from the stored kind, so
   *  a copy of an entry keeps the teacher's answer through a move, an
   *  activation or more time. Absent = a writer that didn't say (a seed, a
   *  dev tool, an older client's raw mode/endsAt): the schedule store then
   *  decides by the dates and logs it (scheduleStore.ts `storedKind`). */
  openUntilKind?: boolean;
};

/**
 * Is this push one of an assignment's schedule rows, as opposed to a
 * teacher's ad hoc push of an app, link or activity? The schedule store marks
 * every row it writes with `scheduleMirror: true`, and that flag is the test.
 *
 * Not the row's shape: before TRA-575 `makeFocus` stored any `assignmentId` it
 * was given, so an old ad hoc activity push can be filed under an assignment
 * without being part of its schedule. The flag also keeps #4506's rollback
 * valid: the reverted code's rebuild reads only flagged rows. Retiring the
 * flag is a later step, after that rollback window closes.
 */
export function isScheduleRow(push: PushDoc): boolean {
  return push.scheduleMirror === true;
}

/**
 * What `pushFieldsFromScheduleEntry` returns. `endsAt` is present (possibly
 * undefined, for undated homework) exactly when the entry's end is known
 * without a time zone: a timed focus's end or a homework's due date. An
 * untimed focus omits the key.
 */
export type ScheduleEntryPushFields =
  Pick<PushDoc, "target" | "audience" | "blocking"> & {
    timing: { kind: PushTiming["kind"] };
    endsAt?: number;
    afterEnd: NonNullable<PushDoc["afterEnd"]>;
  };

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
 *              and let auto-clear delete work in progress. Stored as the
 *              kind alone; the end itself goes to `endsAt` + `afterEnd`.
 *   audience — absent `scholarIds` means cohort-wide, which every reader
 *              resolves against the assignment's CURRENT roster. That is
 *              `assignment`, not a frozen `scholars` list.
 *   blocking — the focus wall is imposed by any live classFocus (see
 *              shared/classFocus.ts `pickLiveFocus`), so the lane IS the
 *              intent. The `soloStartableByMe` refinement stays a read-time
 *              decision and is deliberately not baked in here.
 */
export function pushFieldsFromScheduleEntry(
  a: Doc<"assignments">,
  entry: ScheduleEntry,
): ScheduleEntryPushFields {
  const targeted = entry.scholarIds;
  return {
    target: { kind: "activity", activityId: entry.activityId },
    // An explicit list — even an EMPTY one — is kept as written. An entry
    // distinguishes absent from [] (programScheduleOverview counts [] as 0
    // recipients), so the row must too. For a schedule row an empty
    // `scholars` audience therefore means "the entry stored []", which every
    // entry-shaped reader treats as cohort-wide; genuine-push readers never
    // see schedule rows (pushes.ts filters them out).
    audience:
      targeted !== undefined
        ? { kind: "scholars", scholarIds: targeted }
        : { kind: "assignment", assignmentId: a._id },
    ...(entry.mode === "homework"
      // On homework the entry's `endsAt` is its WITHDRAWAL time, never its end.
      ? { timing: { kind: "homework" as const }, endsAt: entry.dueAt, afterEnd: "late" as const }
      : entry.endsAt !== undefined
        ? {
            // The teacher's finish (TRA-726). An entry that doesn't say is
            // written as `focus` here; the store may still store it as
            // `openUntil` by its dates (scheduleStore.ts `storedKind`).
            timing: { kind: entry.openUntilKind === true ? "openUntil" as const : "focus" as const },
            endsAt: entry.endsAt,
            afterEnd: "fade" as const,
          }
        // No `endsAt` key: an untimed focus's stored end is the close of its
        // school day, which needs the school's time zone (the writer adds it).
        : { timing: { kind: "untilCleared" as const }, afterEnd: "fade" as const }),
    blocking: entry.mode === "classFocus",
  };
}

/**
 * Was this homework entry WITHDRAWN by staff?
 *
 * On homework `endsAt` means "ended" (`endProgramActivity`, a deleted program
 * group), never a window. The push shape has nowhere for that in its homework
 * timing, so the mirror records it as a CLOSED push: `clearedAt` holds the
 * entry's `endsAt` and `scheduleWithdrawn` marks it as still part of the
 * schedule. Readers see the entry exactly as the field had it — history
 * included (the Home origin rule, the scan auto-filer and the offline session
 * view all read ended homework).
 */
export function isWithdrawnHomeworkEntry(entry: ScheduleEntry): boolean {
  return entry.mode === "homework" && entry.endsAt !== undefined;
}

/** The (activity, mode) key a mirror is matched on. */
export function scheduleEntryKey(
  activityId: Id<"activities">,
  mode: "classFocus" | "homework",
): string {
  return `${activityId}:${mode}`;
}

/**
 * The `activitySchedule` entry a schedule-mirror push stands for: the exact
 * inverse of `pushFieldsFromScheduleEntry` plus the lifecycle stamps.
 *
 * This is what lets every reader of the schedule move onto `pushes` without
 * changing a single rule it applies (Linear TRA-13): the readers and writers
 * keep their entry-shaped logic and only the store moved. `scheduledFnId`
 * (the pending activation or auto-clear job) round-trips, so write paths can
 * cancel it.
 *
 * Returns null for anything a schedule entry cannot express (a non-activity
 * target).
 */
export function scheduleEntryFromPush(push: PushDoc): ScheduleEntry | null {
  if (push.target.kind !== "activity") return null;
  // The compatibility boundary for step 4 (TRA-580): every schedule reader
  // downstream keeps today's entry semantics, so the new one-end fields are
  // projected back into them rather than exposed raw. In particular an
  // untimed focus stays end-less (its stored end-of-day is not a window), and
  // homework's `endsAt` stays its WITHDRAWAL time, never its due date.
  const mode = pushLane(push);
  const entry: ScheduleEntry = { activityId: push.target.activityId, mode };
  if (push.setAt !== undefined) entry.setAt = push.setAt;
  if (push.startsAt !== undefined) entry.startsAt = push.startsAt;
  if (push.scheduledFnId !== undefined) entry.scheduledFnId = push.scheduledFnId;
  const focusEnd = explicitFocusEnd(push);
  if (focusEnd !== null) entry.endsAt = focusEnd;
  // The teacher's finish for a timed focus, from its stored kind (TRA-726).
  if (focusEnd !== null) entry.openUntilKind = isOpenUntilKind(push);
  // Withdrawn homework: the withdrawal time is the push's close.
  if (
    mode === "homework" &&
    push.scheduleWithdrawn === true &&
    push.clearedAt !== undefined
  ) {
    entry.endsAt = push.clearedAt;
  }
  const dueAt = homeworkDueAt(push);
  if (dueAt !== null) entry.dueAt = dueAt;
  if (push.audience.kind === "scholars") {
    entry.scholarIds = push.audience.scholarIds;
  }
  return entry;
}

// ───────────────────────────── write boundary ─────────────────────────────

/**
 * Does this give end on its own: an explicit focus window that fades at a
 * finite `endsAt`? Homework (`afterEnd: "late"`, a deadline that never shuts)
 * and `untilCleared` (no explicit window) do not.
 *
 * The rule every app give must satisfy (TRA-336): the end time is what takes
 * the app back off the iPad, so an app give without one never ends.
 */
export function hasFiniteFadingEnd(push: PushEndInput): boolean {
  const end = explicitFocusEnd(push);
  return end !== null && Number.isFinite(end) && push.afterEnd === "fade";
}

/**
 * Why a stored row breaks the app-give invariant, or null if it does not.
 * Only app targets can break it. Reported reasons, most specific first:
 *   - `homework` / `untilCleared`: the stored timing kind is not a focus
 *   - `lateFocus`: a focus that goes late (`afterEnd: "late"`), which the plate
 *     lanes as homework and so never expires
 *   - `noEnd`: a focus with no finite `endsAt`
 */
export type EndlessAppPushReason =
  | "homework"
  | "untilCleared"
  | "lateFocus"
  | "noEnd";

export function endlessAppPushReason(
  push: Pick<PushDoc, "target" | "endsAt" | "afterEnd"> & {
    timing: Pick<PushTiming, "kind">;
  },
): EndlessAppPushReason | null {
  if (push.target.kind !== "app") return null;
  if (push.timing.kind === "homework") return "homework";
  if (push.timing.kind === "untilCleared") return "untilCleared";
  if (push.afterEnd === "late") return "lateFocus";
  if (!hasFiniteFadingEnd(push)) return "noEnd";
  return null;
}

/** The fields a push writer is about to store, as `assertPushAllowed` reads them. */
export type PushWriteInput = {
  target: PushTarget;
  timing: { kind: PushTiming["kind"] };
  blocking: boolean;
  /** The stored end. Required for an app target; ignored otherwise. */
  endsAt?: number;
};

/**
 * The one write-boundary check for a push row. Every writer that inserts or
 * re-shapes a push calls it before the write:
 *
 *   - Only an activity may block (`canTargetBlock`).
 *   - An app give must be a focus with a finite end. Homework or until-cleared
 *     timing would unlock the app with no end, a standing grant in disguise,
 *     and no server-side expiry can claw back an iPad that went offline while
 *     authorized (TRA-336). The give form offers apps only fading finishes,
 *     so nothing legitimate reaches this refusal.
 *
 * `isPushShowing` enforces the app half again at read time, for rows written
 * before this check existed.
 */
export function assertPushAllowed(push: PushWriteInput): void {
  if (push.blocking && !canTargetBlock(push.target)) {
    throw new Error(
      `A ${push.target.kind} push cannot block: only an activity has a ` +
        `per-scholar completion stamp to release the lock.`,
    );
  }
  if (push.target.kind === "app") {
    if (!isTimedFocusKind(push.timing.kind)) {
      throw new Error(
        `An app can't be given as ${push.timing.kind === "homework" ? "homework" : "open until cleared"}: ` +
          `an app give needs an end time, or the app stays unlocked indefinitely.`,
      );
    }
    if (push.endsAt === undefined || !Number.isFinite(push.endsAt)) {
      throw new Error(
        "An app give needs an end time, or the app stays unlocked indefinitely.",
      );
    }
  }
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
