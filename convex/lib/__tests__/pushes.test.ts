import { describe, expect, test } from "vitest";
import {
  DEFAULT_FOCUS_MS,
  assertPushAllowed,
  canTargetBlock,
  comparePushesForPlate,
  endlessAppPushReason,
  focusEndsAt,
  isPushDueForClear,
  isPushBlocking,
  isPushShowing,
  livePushesForScholar,
  pushCoversScholar,
  pushExpiresAt,
  pushFieldsFromScheduleEntry,
  pushLane,
  scheduleEntryFromPush,
  type PushDoc,
  type ScheduleEntry,
  type ScholarAudienceContext,
} from "../pushes";
import type { Doc, Id } from "../../_generated/dataModel";
import { dayKeyForTimezone } from "../../../shared/institutionDay";
import type { RequestedWindow } from "../../../shared/classMeetings";
import { storedTiming } from "../../__tests__/pushTimingFixture";

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
const TIME_ZONE = "Pacific/Honolulu";
const clockAt = (nowMs: number) => ({
  nowMs,
  todayDayKey: dayKeyForTimezone(nowMs, TIME_ZONE),
  timeZone: TIME_ZONE,
});

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
/** A stored push; `timing` is given as the requested window (TRA-580). */
function push(
  overrides: Partial<Omit<PushDoc, "timing">> & { timing?: RequestedWindow } = {},
): PushDoc {
  seq += 1;
  const { timing = { kind: "focus", endsAt: NOW + 20 * MIN }, ...rest } = overrides;
  return {
    _id: `push${String(seq).padStart(4, "0")}` as Id<"pushes">,
    _creationTime: NOW,
    institutionId: INST,
    target: ACTIVITY_TARGET,
    audience: { kind: "institution" },
    ...storedTiming(timing),
    blocking: false,
    setAt: NOW - MIN,
    pushedBy: "teacher1" as Id<"users">,
    ...rest,
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
    expect(pushExpiresAt(storedTiming({ kind: "focus", endsAt: 123 }))).toBe(123);
    // Overdue homework must STAY on the plate — being overdue is the signal.
    expect(pushExpiresAt(storedTiming({ kind: "homework", dueAt: 123 }))).toBeNull();
  });

  test("an untilCleared push has no clock at all", () => {
    // A dispatch is released by finishing it, not by a timer. Giving it an
    // expiry would delete a scholar's in-progress work out from under them.
    expect(pushExpiresAt(storedTiming({ kind: "untilCleared" }))).toBeNull();
  });

  test("lane is derived from timing, not a stored mode", () => {
    expect(pushLane(storedTiming({ kind: "focus", endsAt: 1 }))).toBe("classFocus");
    expect(pushLane(storedTiming({ kind: "homework", dueAt: 1 }))).toBe("homework");
    // Everything that isn't homework shares the focus lane, so a new timing
    // kind can never silently land in the homework list.
    expect(pushLane(storedTiming({ kind: "untilCleared" }))).toBe("classFocus");
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
    expect(isPushShowing(push({ setAt: undefined }), clockAt(NOW))).toBe(false);
    expect(
      isPushBlocking(
        push({ setAt: undefined, blocking: true }),
        clockAt(NOW),
      ),
    ).toBe(false);
  });

  test("an open, unexpired focus is shown", () => {
    expect(isPushShowing(push(), clockAt(NOW))).toBe(true);
  });

  test("a same-day overrun focus is still shown", () => {
    const stale = push({ timing: { kind: "focus", endsAt: NOW - MIN } });
    expect(stale.clearedAt).toBeUndefined();
    expect(isPushShowing(stale, clockAt(NOW))).toBe(true);
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
    expect(isPushBlocking(stale, clockAt(NOW))).toBe(false);
    expect(isPushBlocking(stale, clockAt(NOW - 2 * MIN))).toBe(true);
  });

  test("endsAt is exclusive at the wall's boundary", () => {
    const p = push({ blocking: true, timing: { kind: "focus", endsAt: NOW } });
    expect(isPushBlocking(p, clockAt(NOW))).toBe(false);
    expect(isPushBlocking(p, clockAt(NOW - 1))).toBe(true);
  });

  test("a non-blocking push never walls anyone in, inside its window or not", () => {
    expect(isPushBlocking(push({ blocking: false }), clockAt(NOW))).toBe(false);
  });

  test("a cleared push stops showing but still exists as a record", () => {
    const cleared = push({
      blocking: true,
      clearedAt: NOW - MIN,
      clearedReason: "teacher",
    });
    expect(isPushShowing(cleared, clockAt(NOW))).toBe(false);
    expect(isPushBlocking(cleared, clockAt(NOW))).toBe(false);
    // The point of the redesign: the event survives its own expiry.
    expect(cleared.setAt).toBeDefined();
    expect(cleared.clearedReason).toBe("teacher");
    expect(isPushDueForClear(cleared, NOW)).toBe(false);
  });

  test("homework stays shown past its due date", () => {
    const overdue = push({ timing: { kind: "homework", dueAt: NOW - 5 * MIN } });
    expect(isPushShowing(overdue, clockAt(NOW))).toBe(true);
    expect(isPushDueForClear(overdue, NOW)).toBe(false);
  });

  test("an untilCleared push is a same-day focus", () => {
    const dispatch = push({
      blocking: true,
      timing: { kind: "untilCleared" },
      setAt: NOW - MIN,
    });
    expect(isPushShowing(dispatch, clockAt(NOW))).toBe(true);
    expect(isPushBlocking(dispatch, clockAt(NOW))).toBe(true);
    expect(isPushDueForClear(dispatch, NOW)).toBe(false);

    const tomorrow = NOW + 36 * 60 * MIN;
    expect(isPushShowing(dispatch, clockAt(tomorrow))).toBe(false);
    expect(isPushBlocking(dispatch, clockAt(tomorrow))).toBe(false);

    const cleared = {
      ...dispatch,
      clearedAt: NOW - MIN,
      clearedReason: "teacher" as const,
    };
    expect(isPushShowing(cleared, clockAt(NOW))).toBe(false);
    expect(isPushBlocking(cleared, clockAt(NOW))).toBe(false);
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
      clockAt(NOW),
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

  const FOCUS = { kind: "focus" as const };

  test("a non-blocking timed push of any target is allowed", () => {
    for (const target of [ACTIVITY_TARGET, APP_TARGET, LINK_TARGET]) {
      expect(() =>
        assertPushAllowed({ target, timing: FOCUS, blocking: false, endsAt: NOW + MIN }),
      ).not.toThrow();
    }
  });

  test("a blocking non-activity push is refused, not silently downgraded", () => {
    expect(() =>
      assertPushAllowed({ target: APP_TARGET, timing: FOCUS, blocking: true, endsAt: NOW + MIN }),
    ).toThrow(/cannot block/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TRA-336: an app give must end. Homework or untilCleared timing on an app
// target would unlock the tile, launch gates, credential autofill and the MDM
// allowlist with no end: a standing grant in disguise.
// ─────────────────────────────────────────────────────────────────────────

describe("an app give must end (write boundary)", () => {
  test("an app give as homework or until-cleared is refused", () => {
    for (const kind of ["homework", "untilCleared"] as const) {
      expect(() =>
        assertPushAllowed({
          target: APP_TARGET,
          timing: { kind },
          blocking: false,
          endsAt: NOW + MIN,
        }),
      ).toThrow(/needs an end time/);
    }
  });

  test("an app focus without a finite end is refused", () => {
    for (const endsAt of [undefined, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() =>
        assertPushAllowed({ target: APP_TARGET, timing: { kind: "focus" }, blocking: false, endsAt }),
      ).toThrow(/needs an end time/);
    }
  });

  test("activity, link and resource gives keep every timing", () => {
    const RESOURCE_TARGET = {
      kind: "resource" as const,
      resourceId: "res1" as Id<"activityResources">,
    };
    for (const target of [ACTIVITY_TARGET, LINK_TARGET, RESOURCE_TARGET]) {
      for (const kind of ["focus", "homework", "untilCleared"] as const) {
        expect(() =>
          assertPushAllowed({ target, timing: { kind }, blocking: false }),
        ).not.toThrow();
      }
    }
  });
});

describe("an app give must end (read boundary)", () => {
  const clock = clockAt(NOW);

  test("a timed, fading app focus shows exactly as before", () => {
    expect(isPushShowing(push({ target: APP_TARGET }), clock)).toBe(true);
    expect(endlessAppPushReason(push({ target: APP_TARGET }))).toBeNull();
  });

  test("an app give as homework grants nothing, dated or not", () => {
    for (const dueAt of [NOW + 60 * MIN, undefined]) {
      const row = push({ target: APP_TARGET, timing: { kind: "homework", dueAt } });
      expect(isPushShowing(row, clock)).toBe(false);
      expect(endlessAppPushReason(row)).toBe("homework");
    }
  });

  test("an until-cleared app give grants nothing, even on its own day", () => {
    const row = push({ target: APP_TARGET, timing: { kind: "untilCleared" } });
    expect(isPushShowing(row, clock)).toBe(false);
    expect(endlessAppPushReason(row)).toBe("untilCleared");
  });

  test("an app focus that goes late, or has no end, grants nothing", () => {
    const late = push({ target: APP_TARGET, afterEnd: "late" });
    expect(isPushShowing(late, clock)).toBe(false);
    expect(endlessAppPushReason(late)).toBe("lateFocus");

    const noEnd = push({ target: APP_TARGET, endsAt: undefined });
    expect(isPushShowing(noEnd, clock)).toBe(false);
    expect(endlessAppPushReason(noEnd)).toBe("noEnd");
  });

  test("activity and link gives are unchanged: homework still never expires", () => {
    for (const target of [ACTIVITY_TARGET, LINK_TARGET]) {
      const hw = push({ target, timing: { kind: "homework", dueAt: NOW - 60 * MIN } });
      expect(isPushShowing(hw, clock)).toBe(true);
      expect(endlessAppPushReason(hw)).toBeNull();
      const untimed = push({ target, timing: { kind: "untilCleared" } });
      expect(isPushShowing(untimed, clock)).toBe(true);
    }
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
    // The kind alone; the window goes to the one end field (TRA-580 step 5).
    expect(f.timing).toEqual({ kind: "focus" });
    expect(f.endsAt).toBe(NOW + 30 * MIN);
    expect(f.afterEnd).toBe("fade");
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
    // No end key at all: its end-of-day needs the school's time zone, which
    // the store adds; a pure undefined here would wipe it on update.
    expect("endsAt" in f).toBe(false);
    expect(f.afterEnd).toBe("fade");
    expect(f.blocking).toBe(true);
  });

  test("homework carries its due date and never blocks", () => {
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "homework",
      dueAt: NOW + 24 * 60 * MIN,
    });
    expect(f.timing).toEqual({ kind: "homework" });
    expect(f.endsAt).toBe(NOW + 24 * 60 * MIN);
    expect(f.afterEnd).toBe("late");
    expect(f.blocking).toBe(false);
  });

  test("undated homework stays undated — open-ended work is a real state", () => {
    const f = pushFieldsFromScheduleEntry(A, {
      activityId: ACT,
      mode: "homework",
    });
    expect(f.timing).toEqual({ kind: "homework" });
    expect("endsAt" in f && f.endsAt === undefined).toBe(true);
    expect(f.afterEnd).toBe("late");
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

  test("an empty scholarIds array is kept as written, and reads back as []", () => {
    // A prune can leave `[]` behind. Entry-shaped readers treat it as
    // cohort-wide, but one (programScheduleOverview) counts it as 0
    // recipients, so the mirror keeps [] exactly rather than widening it to
    // the assignment (TRA-572 review). A schedule mirror is never served to
    // genuine-push readers, so an empty `scholars` audience on a mirror
    // cannot drop anyone; the write switch (L4) must carry [] as cohort-wide.
    const entry = {
      activityId: ACT,
      mode: "homework" as const,
      scholarIds: [],
    };
    const f = pushFieldsFromScheduleEntry(A, entry);
    expect(f.audience).toEqual({ kind: "scholars", scholarIds: [] });
  });
});

describe("schedule entry <-> push round trip (kind-only timing)", () => {
  const A = { _id: "asg1" as Id<"assignments"> } as Doc<"assignments">;
  const ACT = "act1" as Id<"activities">;
  const asRow = (entry: ScheduleEntry): PushDoc => {
    return {
      ...push(),
      endsAt: undefined,
      ...pushFieldsFromScheduleEntry(A, entry),
      setAt: entry.setAt,
      startsAt: entry.startsAt,
      scheduledFnId: entry.scheduledFnId,
    };
  };
  const ENTRIES: Array<[string, ScheduleEntry]> = [
    // A timed focus carries the teacher's finish both ways (TRA-726).
    ["timed focus", {
      activityId: ACT, mode: "classFocus", setAt: NOW, endsAt: NOW + 30 * MIN, openUntilKind: false,
    }],
    ["planned timed focus", {
      activityId: ACT, mode: "classFocus", startsAt: NOW + 60 * MIN, endsAt: NOW + 90 * MIN,
      openUntilKind: false,
    }],
    ["open-until focus", {
      activityId: ACT, mode: "classFocus", setAt: NOW, endsAt: NOW + 3 * 24 * 60 * MIN,
      openUntilKind: true,
    }],
    ["untimed focus", { activityId: ACT, mode: "classFocus", setAt: NOW }],
    ["dated homework", { activityId: ACT, mode: "homework", setAt: NOW, dueAt: NOW + 24 * 60 * MIN }],
    ["undated homework, named scholars", {
      activityId: ACT, mode: "homework", setAt: NOW, scholarIds: ["s1" as Id<"users">],
    }],
  ];
  test.each(ENTRIES)("%s reads back as the same entry", (_label, entry) => {
    const row = asRow(entry);
    expect(row.timing).toEqual({ kind: row.timing.kind });
    expect(scheduleEntryFromPush(row)).toEqual(entry);
  });

  // An entry that doesn't say (a seed, an older client) is decided by the
  // schedule store; this pure mapping writes it as `focus`, which reads back
  // as "in that class". Reading always says, so a copied entry keeps its
  // finish (TRA-726).
  test("a timed focus that doesn't give its finish reads back as in that class", () => {
    const entry: ScheduleEntry = { activityId: ACT, mode: "classFocus", setAt: NOW, endsAt: NOW + 30 * MIN };
    expect(scheduleEntryFromPush(asRow(entry))).toEqual({ ...entry, openUntilKind: false });
  });
});
