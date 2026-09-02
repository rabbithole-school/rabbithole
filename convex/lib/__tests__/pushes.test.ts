import { describe, expect, test } from "vitest";
import {
  DEFAULT_FOCUS_MS,
  assertBlockingAllowed,
  canTargetBlock,
  comparePushesForPlate,
  focusEndsAt,
  isPushDueForClear,
  isPushBlocking,
  isPushShowing,
  livePushesForScholar,
  pushCoversScholar,
  pushExpiresAt,
  pushFieldsFromScheduleEntry,
  pushLane,
  type PushDoc,
  type ScholarAudienceContext,
} from "../pushes";
import type { Doc, Id } from "../../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────
// `pushes` replaces assignments.activitySchedule — see
// review/class-focus-rethink.html. The rules worth pinning are the ones the
// old shape got wrong or could not express:
//
//   - the label and the wall are separate: an overrun focus keeps showing
//     (it is "running long", not gone) but stops holding the scholar in,
//     so a delayed clear job costs a stale line, never a lockout
//   - a cleared row still EXISTS (the old autoClearActivity deleted it,
//     making a throwaway activity the only trace a focus ever happened)
//   - audience resolves against CURRENT membership, not a snapshot
//   - blocking is teacher intent, gated only by whether the target has a
//     per-scholar release stamp
// ─────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const INST = "inst1" as Id<"institutions">;
const OTHER_INST = "inst2" as Id<"institutions">;
const GECKOS = "grp_geckos" as Id<"scholarGroups">;
const SEALS = "grp_seals" as Id<"scholarGroups">;
const KID = "kid1" as Id<"users">;
const OTHER_KID = "kid2" as Id<"users">;
const COHORT = "asg_cohort" as Id<"assignments">;
const OTHER_COHORT = "asg_other" as Id<"assignments">;

const ACTIVITY_TARGET = {
  kind: "activity" as const,
  activityId: "act1" as Id<"activities">,
};
const APP_TARGET = {
  kind: "app" as const,
  externalAppId: "app1" as Id<"externalApps">,
};
const LINK_TARGET = {
  kind: "link" as const,
  url: "https://example.com/v",
  title: "A video",
  media: "video" as const,
};

let seq = 0;
function push(overrides: Partial<PushDoc> = {}): PushDoc {
  seq += 1;
  return {
    _id: `push${String(seq).padStart(4, "0")}` as Id<"pushes">,
    _creationTime: NOW,
    institutionId: INST,
    target: ACTIVITY_TARGET,
    audience: { kind: "institution" },
    timing: { kind: "focus", endsAt: NOW + 20 * MIN },
    blocking: false,
    setAt: NOW - MIN,
    pushedBy: "teacher1" as Id<"users">,
    ...overrides,
  } as PushDoc;
}

const scholar: ScholarAudienceContext = {
  scholarId: KID,
  institutionId: INST,
  groupIds: [GECKOS],
  assignmentIds: [COHORT],
};

describe("timing union", () => {
  test("a focus closes; homework does not expire", () => {
    expect(pushExpiresAt({ kind: "focus", endsAt: 123 })).toBe(123);
    // Overdue homework must STAY on the plate — being overdue is the signal.
    expect(pushExpiresAt({ kind: "homework", dueAt: 123 })).toBeNull();
  });

  test("an untilCleared push has no clock at all", () => {
    // A dispatch is released by finishing it, not by a timer. Giving it an
    // expiry would delete a scholar's in-progress work out from under them.
    expect(pushExpiresAt({ kind: "untilCleared" })).toBeNull();
  });

  test("lane is derived from timing, not a stored mode", () => {
    expect(pushLane({ kind: "focus", endsAt: 1 })).toBe("classFocus");
    expect(pushLane({ kind: "homework", dueAt: 1 })).toBe("homework");
    // Everything that isn't homework shares the focus lane, so a new timing
    // kind can never silently land in the homework list.
    expect(pushLane({ kind: "untilCleared" })).toBe("classFocus");
  });
});

describe("showing vs. blocking", () => {
  // The split: a focus that has run past its window keeps its LABEL and
  // loses its WALL. Before it, the scholar's two surfaces disagreed — the
  // Now ladder dropped an overrun focus (and declared the day empty) while
  // the plate below it was still printing "Class focus" for the same work.
  // The teacher's own surface has always called this "running long" and
  // offered Extend / Wrap, so the focus is not over until a human says so.

  test("a planned push (no setAt) is agenda-only, never shown", () => {
    expect(isPushShowing(push({ setAt: undefined }))).toBe(false);
    expect(isPushBlocking(push({ setAt: undefined, blocking: true }), NOW)).toBe(
      false,
    );
  });

  test("an open, unexpired focus is shown", () => {
    expect(isPushShowing(push())).toBe(true);
  });

  test("an overrun focus is still shown — it is running long, not gone", () => {
    const stale = push({ timing: { kind: "focus", endsAt: NOW - MIN } });
    expect(stale.clearedAt).toBeUndefined();
    expect(isPushShowing(stale)).toBe(true);
    // Still worth retiring, just not urgent enough to lie about.
    expect(isPushDueForClear(stale, NOW)).toBe(true);
  });

  test("an overrun focus stops walling the scholar in", () => {
    // The safety property. If the clear job slips, the cost is a stale line
    // on a screen — never a scholar locked out of their own app with no
    // teacher around to release them.
    const stale = push({
      blocking: true,
      timing: { kind: "focus", endsAt: NOW - MIN },
    });
    expect(isPushBlocking(stale, NOW)).toBe(false);
    expect(isPushBlocking(stale, NOW - 2 * MIN)).toBe(true);
  });

  test("endsAt is exclusive at the wall's boundary", () => {
    const p = push({ blocking: true, timing: { kind: "focus", endsAt: NOW } });
    expect(isPushBlocking(p, NOW)).toBe(false);
    expect(isPushBlocking(p, NOW - 1)).toBe(true);
  });

  test("a non-blocking push never walls anyone in, inside its window or not", () => {
    expect(isPushBlocking(push({ blocking: false }), NOW)).toBe(false);
  });

  test("a cleared push stops showing but still exists as a record", () => {
    const cleared = push({
      blocking: true,
      clearedAt: NOW - MIN,
      clearedReason: "teacher",
    });
    expect(isPushShowing(cleared)).toBe(false);
    expect(isPushBlocking(cleared, NOW)).toBe(false);
    // The point of the redesign: the event survives its own expiry.
    expect(cleared.setAt).toBeDefined();
    expect(cleared.clearedReason).toBe("teacher");
    expect(isPushDueForClear(cleared, NOW)).toBe(false);
  });

  test("homework stays shown past its due date", () => {
    const overdue = push({ timing: { kind: "homework", dueAt: NOW - 5 * MIN } });
    expect(isPushShowing(overdue)).toBe(true);
    expect(isPushDueForClear(overdue, NOW)).toBe(false);
  });

  test("an untilCleared push stays shown, and blocking, until cleared", () => {
    const dispatch = push({
      blocking: true,
      timing: { kind: "untilCleared" },
      setAt: NOW - 30 * 24 * 60 * MIN,
    });
    // A month later it is still there. Nothing but an explicit clear ends it.
    // It keeps its wall too: an untilCleared push has no window to overrun,
    // so this is a teacher deliberately holding the room, not a job that
    // failed to fire.
    expect(isPushShowing(dispatch)).toBe(true);
    expect(isPushBlocking(dispatch, NOW)).toBe(true);
    expect(isPushDueForClear(dispatch, NOW)).toBe(false);

    const cleared = {
      ...dispatch,
      clearedAt: NOW - MIN,
      clearedReason: "teacher" as const,
    };
    expect(isPushShowing(cleared)).toBe(false);
    expect(isPushBlocking(cleared, NOW)).toBe(false);
  });
});

describe("audience resolves live", () => {
  test("institution audience covers any scholar in that institution", () => {
    expect(pushCoversScholar(push(), scholar)).toBe(true);
  });

  test("a group audience follows CURRENT membership", () => {
    const p = push({ audience: { kind: "group", groupId: GECKOS } });
    expect(pushCoversScholar(p, scholar)).toBe(true);
    // Same push, scholar has since left Geckos — no fan-out to go stale.
    expect(pushCoversScholar(p, { ...scholar, groupIds: [SEALS] })).toBe(false);
    // ...and a scholar who just joined is covered immediately.
    expect(
      pushCoversScholar(p, { ...scholar, groupIds: [SEALS, GECKOS] }),
    ).toBe(true);
  });

  test("explicit scholar audience narrows to the named kids", () => {
    const p = push({ audience: { kind: "scholars", scholarIds: [OTHER_KID] } });
    expect(pushCoversScholar(p, scholar)).toBe(false);
    expect(
      pushCoversScholar(p, { ...scholar, scholarId: OTHER_KID }),
    ).toBe(true);
  });

  test("an assignment audience follows the CURRENT roster", () => {
    // This is what cohort-wide `activitySchedule` targeting meant: no stored
    // list, read against the roster of the moment. A scholar added to the
    // cohort while the focus is open must see it without a re-push.
    const p = push({ audience: { kind: "assignment", assignmentId: COHORT } });
    expect(pushCoversScholar(p, scholar)).toBe(true);
    // Removed from the roster — the push stops reaching them.
    expect(pushCoversScholar(p, { ...scholar, assignmentIds: [] })).toBe(false);
    // A different cohort's focus never leaks across.
    expect(
      pushCoversScholar(p, { ...scholar, assignmentIds: [OTHER_COHORT] }),
    ).toBe(false);
  });

  test("the institution boundary is never crossed, whatever the audience", () => {
    const p = push({ institutionId: OTHER_INST, audience: { kind: "institution" } });
    expect(pushCoversScholar(p, scholar)).toBe(false);
    // ...even when the group id itself matches.
    const g = push({ institutionId: OTHER_INST, audience: { kind: "group", groupId: GECKOS } });
    expect(pushCoversScholar(g, scholar)).toBe(false);
  });

  test("a scholar with no institution is covered by nothing", () => {
    expect(
      pushCoversScholar(push(), { ...scholar, institutionId: undefined }),
    ).toBe(false);
  });
});

describe("plate ordering", () => {
  test("focus outranks homework, then newest focus, then soonest due", () => {
    const oldFocus = push({ setAt: NOW - 30 * MIN });
    const newFocus = push({ setAt: NOW - MIN });
    const soonHw = push({ timing: { kind: "homework", dueAt: NOW + MIN } });
    const laterHw = push({ timing: { kind: "homework", dueAt: NOW + 99 * MIN } });

    const sorted = [laterHw, oldFocus, soonHw, newFocus].sort(
      comparePushesForPlate,
    );
    expect(sorted.map((p) => p._id)).toEqual([
      newFocus._id,
      oldFocus._id,
      soonHw._id,
      laterHw._id,
    ]);
  });

  test("windowed and untimed focus interleave by recency, not by kind", () => {
    // Both are the same lane, so a dispatch pushed just now must sit above a
    // timed focus set half an hour ago — not below every windowed push.
    const oldWindowed = push({ setAt: NOW - 30 * MIN });
    const newDispatch = push({
      timing: { kind: "untilCleared" },
      setAt: NOW - MIN,
    });
    const hw = push({ timing: { kind: "homework", dueAt: NOW + MIN } });

    const sorted = [hw, oldWindowed, newDispatch].sort(comparePushesForPlate);
    expect(sorted.map((p) => p._id)).toEqual([
      newDispatch._id,
      oldWindowed._id,
      hw._id,
    ]);
  });

  test("undated homework sinks below anything with a deadline", () => {
    // Program-group work is available until a teacher ends it. It must not
    // displace something actually due today.
    const undated = push({ timing: { kind: "homework" } });
    const dueSoon = push({ timing: { kind: "homework", dueAt: NOW + MIN } });
    const dueLater = push({
      timing: { kind: "homework", dueAt: NOW + 99 * MIN },
    });

    const sorted = [undated, dueLater, dueSoon].sort(comparePushesForPlate);
    expect(sorted.map((p) => p._id)).toEqual([
      dueSoon._id,
      dueLater._id,
      undated._id,
    ]);
  });

  test("two undated homework rows still order totally", () => {
    const a = push({ timing: { kind: "homework" } });
    const b = push({ timing: { kind: "homework" } });
    expect(comparePushesForPlate(a, b)).not.toBe(0);
    expect(comparePushesForPlate(a, b)).toBe(-comparePushesForPlate(b, a));
  });

  test("order is total, so renders are stable on identical timestamps", () => {
    const a = push({ setAt: NOW });
    const b = push({ setAt: NOW });
    expect(comparePushesForPlate(a, b)).not.toBe(0);
    expect(comparePushesForPlate(a, b)).toBe(-comparePushesForPlate(b, a));
  });
});

describe("livePushesForScholar", () => {
  test("filters by showing and audience together", () => {
    const mine = push({ audience: { kind: "group", groupId: GECKOS } });
    const theirs = push({ audience: { kind: "group", groupId: SEALS } });
    // Overrun but never wrapped: still the scholar's, still on the plate.
    const overrun = push({
      audience: { kind: "group", groupId: GECKOS },
      timing: { kind: "focus", endsAt: NOW - MIN },
    });
    const planned = push({ setAt: undefined });
    const cleared = push({ clearedAt: NOW - MIN, clearedReason: "expired" });

    const live = livePushesForScholar(
      [mine, theirs, overrun, planned, cleared],
      scholar,
    );
    expect(new Set(live.map((p) => p._id))).toEqual(
      new Set([mine._id, overrun._id]),
    );
  });
});

describe("blocking is intent, gated by release mechanism", () => {
  test("only an activity can block in v1", () => {
    expect(canTargetBlock(ACTIVITY_TARGET)).toBe(true);
    expect(canTargetBlock(APP_TARGET)).toBe(false);
    expect(canTargetBlock(LINK_TARGET)).toBe(false);
  });

  test("a non-blocking push of any target is always allowed", () => {
    expect(() => assertBlockingAllowed(APP_TARGET, false)).not.toThrow();
    expect(() => assertBlockingAllowed(LINK_TARGET, false)).not.toThrow();
  });

  test("a blocking non-activity push is refused, not silently downgraded", () => {
    expect(() => assertBlockingAllowed(APP_TARGET, true)).toThrow(/cannot block/);
  });
});

describe("focusEndsAt", () => {
  test("defaults to 60 minutes", () => {
    expect(focusEndsAt(NOW)).toBe(NOW + DEFAULT_FOCUS_MS);
    expect(DEFAULT_FOCUS_MS).toBe(60 * MIN);
  });

  test("honours an explicit duration — the 20-minute ad-hoc push", () => {
    expect(focusEndsAt(NOW, 20)).toBe(NOW + 20 * MIN);
  });

  test("clamps nonsense rather than creating an immortal or instant focus", () => {
    expect(focusEndsAt(NOW, 0)).toBe(NOW + MIN);
    expect(focusEndsAt(NOW, -5)).toBe(NOW + MIN);
    expect(focusEndsAt(NOW, 60 * 24)).toBe(NOW + 8 * 60 * MIN);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The whole migration rests on this one derivation: it is what decides
// whether a mirrored row means the same thing as the schedule entry it
// came from. Every branch is here because `mode` conflated two different
// promises, and getting one wrong silently changes what a scholar sees.
// ─────────────────────────────────────────────────────────────────────────

describe("pushFieldsFromScheduleEntry", () => {
  const ASG_ID = "asg1" as Id<"assignments">;
  // Only `_id` is read, so a narrow stub is honest about the coupling.
  const A = { _id: ASG_ID } as Doc<"assignments">;
  const ACT = "act1" as Id<"activities">;

  test("a timed class focus keeps its window", () => {
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "classFocus",
      endsAt: NOW + 30 * MIN,
    });
    expect(f.timing).toEqual({ kind: "focus", endsAt: NOW + 30 * MIN });
    expect(f.blocking).toBe(true);
    expect(f.target).toEqual({ kind: "activity", activityId: ACT });
  });

  test("a class focus with no end time becomes untilCleared, not a guessed hour", () => {
    // The dispatch path never sets endsAt. Inventing one would let
    // autoClear delete in-progress work at an arbitrary moment.
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "classFocus",
    });
    expect(f.timing).toEqual({ kind: "untilCleared" });
    expect(f.blocking).toBe(true);
  });

  test("homework carries its due date and never blocks", () => {
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "homework",
      dueAt: NOW + 24 * 60 * MIN,
    });
    expect(f.timing).toEqual({ kind: "homework", dueAt: NOW + 24 * 60 * MIN });
    expect(f.blocking).toBe(false);
  });

  test("undated homework stays undated — open-ended work is a real state", () => {
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "homework",
    });
    expect(f.timing).toEqual({ kind: "homework", dueAt: undefined });
  });

  test("named scholars address exactly those scholars", () => {
    const ids = ["s1", "s2"] as Id<"users">[];
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "classFocus",
      endsAt: NOW + MIN,
      scholarIds: ids,
    });
    expect(f.audience).toEqual({ kind: "scholars", scholarIds: ids });
  });

  test("no named scholars means the assignment's roster, resolved live", () => {
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "homework",
    });
    expect(f.audience).toEqual({ kind: "assignment", assignmentId: ASG_ID });
  });

  test("an empty scholarIds array is cohort-wide, not nobody", () => {
    // The old shape uses `undefined` for cohort-wide, but a prune can
    // leave `[]` behind; treating that as "nobody" would silently drop
    // the entry off every plate.
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "homework",
      scholarIds: [],
    });
    expect(f.audience).toEqual({ kind: "assignment", assignmentId: ASG_ID });
  });
});
