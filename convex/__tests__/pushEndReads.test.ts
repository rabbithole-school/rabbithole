import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  comparePushesForPlate,
  explicitFocusEnd,
  homeworkDueAt,
  isPushBlocking,
  isPushDueForClear,
  isPushShowing,
  liveUntil,
  pushExpiresAt,
  pushLane,
  scheduleEntryFromPush,
  type FocusClock,
  type PushDoc,
  type ScheduleEntry,
} from "../lib/pushes";
import { endFieldsForPush } from "../lib/classLink";
import { isFocusShowing } from "../../shared/focusShowing";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  dueStatus,
  shiftDayKey,
} from "../../shared/institutionDay";
import type { RequestedWindow } from "../../shared/classMeetings";

// ─────────────────────────────────────────────────────────────────────────
// TRA-580 step 4: every numeric end/due read moved from the nested
// `timing.endsAt`/`timing.dueAt` onto the give's one end (`endsAt` +
// `afterEnd`). The switch must change nothing anyone sees. So each legacy
// timing variant is built twice — as a pre-step-2 row (legacy timing only)
// and as today's writers store it (step 5: kind-only `timing` +
// `endFieldsForPush` from the requested number) — and
// the switched helpers on the stored row must match a frozen copy of the
// pre-switch logic, at clock points chosen to hit the edges where a naive
// "fade means gone at endsAt" rule would differ.
// ─────────────────────────────────────────────────────────────────────────

const TZ = "Pacific/Honolulu";
const MONDAY = "2026-11-09";
const at = (clock: string, day = MONDAY) => {
  const full = clock.length === 5 ? `${clock}:00` : clock;
  return Date.parse(`${day}T${full}-10:00`);
};
const MONDAY_LAST_MS = at("23:59:59.999");
const clockAt = (nowMs: number): FocusClock => ({
  nowMs,
  todayDayKey: dayKeyForTimezone(nowMs, TZ),
  timeZone: TZ,
});

// ── Frozen pre-switch logic: the oracle. Do not "fix" it to the new fields. ──

/**
 * A pre-step-2 row: the end lived only in the nested `timing` numbers. The
 * schema no longer allows this shape (step 5b), so the oracle has its own type.
 */
type LegacyRow = Omit<PushDoc, "timing" | "endsAt" | "afterEnd"> & {
  timing: RequestedWindow | { kind: "focus"; endsAt?: number };
};

function legacyExpiresAt(p: LegacyRow): number | null {
  return p.timing.kind === "focus" ? (p.timing.endsAt ?? null) : null;
}
function legacyLane(p: LegacyRow): "classFocus" | "homework" {
  return p.timing.kind === "homework" ? "homework" : "classFocus";
}
function legacyShowing(p: LegacyRow, c: FocusClock): boolean {
  if (p.setAt === undefined || p.clearedAt !== undefined) return false;
  if (p.timing.kind === "homework") return true;
  return isFocusShowing(
    { setAt: p.setAt, endsAt: p.timing.kind === "focus" ? p.timing.endsAt : undefined },
    c.nowMs, c.todayDayKey, c.timeZone,
  );
}
function legacyBlocking(p: LegacyRow, c: FocusClock): boolean {
  if (!legacyShowing(p, c) || p.blocking !== true) return false;
  const e = legacyExpiresAt(p);
  return !(e !== null && e <= c.nowMs);
}
function legacyDueForClear(p: LegacyRow, now: number): boolean {
  if (p.clearedAt !== undefined || p.setAt === undefined) return false;
  const e = legacyExpiresAt(p);
  return e !== null && e <= now;
}
function legacyLiveUntil(p: LegacyRow, c: FocusClock): number | null {
  if (p.timing.kind === "homework") return null;
  const e = legacyExpiresAt(p);
  if (e !== null && e > c.nowMs) return e;
  return dayStartForDayKey(shiftDayKey(c.todayDayKey, 1), c.timeZone);
}
/** `pushes.autoClearPush`'s pre-switch guard: would it clear now? */
function legacyAutoClears(p: LegacyRow, now: number): boolean {
  return p.clearedAt === undefined && p.timing.kind === "focus" &&
    p.timing.endsAt !== undefined && p.timing.endsAt <= now;
}
/** `pushes.hydratePush`'s pre-switch wire end/due. */
function legacyHydrated(p: LegacyRow) {
  return {
    endsAt: p.timing.kind === "focus" ? (p.timing.endsAt ?? null) : null,
    dueAt: p.timing.kind === "homework" ? (p.timing.dueAt ?? null) : null,
  };
}
function legacyScheduleEntry(p: LegacyRow): ScheduleEntry | null {
  if (p.target.kind !== "activity") return null;
  const entry: ScheduleEntry = {
    activityId: p.target.activityId,
    mode: p.timing.kind === "homework" ? "homework" : "classFocus",
  };
  if (p.setAt !== undefined) entry.setAt = p.setAt;
  if (p.startsAt !== undefined) entry.startsAt = p.startsAt;
  if (p.scheduledFnId !== undefined) entry.scheduledFnId = p.scheduledFnId;
  if (p.timing.kind === "focus") entry.endsAt = p.timing.endsAt;
  // A legacy focus row is stored as `focus`: "in that class" (TRA-726).
  if (p.timing.kind === "focus" && p.timing.endsAt !== undefined) entry.openUntilKind = false;
  if (p.timing.kind === "homework" && p.scheduleWithdrawn === true && p.clearedAt !== undefined) {
    entry.endsAt = p.clearedAt;
  }
  if (p.timing.kind === "homework" && p.timing.dueAt !== undefined) entry.dueAt = p.timing.dueAt;
  if (p.audience.kind === "scholars") entry.scholarIds = p.audience.scholarIds;
  return entry;
}
function legacyCompare(a: LegacyRow, b: LegacyRow): number {
  const la = legacyLane(a);
  const lb = legacyLane(b);
  if (la !== lb) return la === "classFocus" ? -1 : 1;
  if (la === "classFocus") {
    const d = (b.setAt ?? 0) - (a.setAt ?? 0);
    if (d !== 0) return d;
  } else if (a.timing.kind === "homework" && b.timing.kind === "homework") {
    const d = (a.timing.dueAt ?? Infinity) - (b.timing.dueAt ?? Infinity);
    if (d !== 0 && !Number.isNaN(d)) return d;
  }
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
}

// ── Fixtures ──

let seq = 0;
function legacyRow(overrides: Partial<LegacyRow>): LegacyRow {
  seq += 1;
  return {
    _id: `push${String(seq).padStart(4, "0")}` as Id<"pushes">,
    _creationTime: at("08:00"),
    institutionId: "inst1" as Id<"institutions">,
    target: { kind: "activity", activityId: "act1" as Id<"activities"> },
    audience: { kind: "institution" },
    timing: { kind: "untilCleared" },
    blocking: true,
    pushedBy: "teacher1" as Id<"users">,
    ...overrides,
  };
}
/**
 * The same row as today's writers store it: `timing` is the kind alone and the
 * requested number goes to the one end (TRA-580 step 5).
 */
function stored(row: LegacyRow): PushDoc {
  const t = row.timing;
  const requested = t.kind === "focus" ? t.endsAt : t.kind === "homework" ? t.dueAt : undefined;
  return {
    ...row,
    timing: { kind: t.kind },
    ...endFieldsForPush(t.kind, requested, row.setAt, row.startsAt, TZ),
  };
}

const VARIANTS = {
  explicitFocus: legacyRow({
    timing: { kind: "focus", endsAt: at("10:00") }, setAt: at("09:00"),
  }),
  explicitFocusToMidnight: legacyRow({
    timing: { kind: "focus", endsAt: MONDAY_LAST_MS }, setAt: at("09:00"),
  }),
  untilClearedActivated: legacyRow({ setAt: at("09:00") }),
  untilClearedPlanned: legacyRow({ startsAt: at("13:00") }),
  untilClearedUndatedPlan: legacyRow({}),
  datedHomework: legacyRow({
    timing: { kind: "homework", dueAt: at("12:00") }, setAt: at("09:00"), blocking: false,
  }),
  undatedHomework: legacyRow({
    timing: { kind: "homework" }, setAt: at("09:00"), blocking: false,
  }),
  // Due Friday, withdrawn by staff on Tuesday.
  withdrawnHomework: legacyRow({
    timing: { kind: "homework", dueAt: at("15:00", "2026-11-13") },
    setAt: at("09:00"), blocking: false, scheduleMirror: true, scheduleWithdrawn: true,
    clearedAt: at("10:00", "2026-11-10"), clearedReason: "teacher",
  }),
  // Opened Monday, open until Saturday afternoon.
  openUntilFocus: legacyRow({
    timing: { kind: "focus", endsAt: at("17:00", "2026-11-14") }, setAt: at("09:00"),
    audience: { kind: "scholars", scholarIds: ["kid1" as Id<"users">] },
  }),
};

const CLOCKS = [
  at("08:30"),
  at("09:30"),
  at("10:00"), // an explicit end, exactly
  at("10:05"), // just past it, the same day
  at("12:00"),
  at("15:00"), // after a noon due, the same day
  at("23:59:59.998"),
  MONDAY_LAST_MS, // an untilCleared give's stored end, exactly
  at("00:00", "2026-11-10"),
  at("12:00", "2026-11-10"),
  at("12:00", "2026-11-14"),
  at("18:00", "2026-11-14"),
];

describe("switched end reads match the pre-switch logic", () => {
  for (const [name, row] of Object.entries(VARIANTS)) {
    test(name, () => {
      const push = stored(row);
      // The stored row really carries the fields this test is about, and no
      // nested number to fall back on.
      expect(push.afterEnd).toBe(row.timing.kind === "homework" ? "late" : "fade");
      expect(push.timing).toEqual({ kind: row.timing.kind });

      expect(pushExpiresAt(push)).toBe(legacyExpiresAt(row));
      expect(pushLane(push)).toBe(legacyLane(row));
      expect(explicitFocusEnd(push)).toBe(legacyHydrated(row).endsAt);
      expect(homeworkDueAt(push)).toBe(legacyHydrated(row).dueAt);
      expect(scheduleEntryFromPush(push)).toEqual(legacyScheduleEntry(row));
      for (const now of CLOCKS) {
        const clock = clockAt(now);
        const label = `${name} at ${new Date(now).toISOString()}`;
        expect(isPushShowing(push, clock), label).toBe(legacyShowing(row, clock));
        expect(isPushBlocking(push, clock), label).toBe(legacyBlocking(row, clock));
        expect(isPushDueForClear(push, now), label).toBe(legacyDueForClear(row, now));
        const end = explicitFocusEnd(push);
        expect(push.clearedAt === undefined && end !== null && end <= now, label)
          .toBe(legacyAutoClears(row, now));
        if (legacyShowing(row, clock)) {
          expect(liveUntil(push, clock), label).toBe(legacyLiveUntil(row, clock));
        }
      }
    });
  }

  test("plate order is unchanged across every variant", () => {
    const rows = Object.values(VARIANTS);
    const legacyOrder = [...rows].sort(legacyCompare).map((p) => p._id);
    const switched = rows.map(stored).sort(comparePushesForPlate).map((p) => p._id);
    expect(switched).toEqual(legacyOrder);
  });
});

describe("the edges a strict fade cutoff would break", () => {
  test("at 10:05 after a 10:00 focus it still shows, no longer walls, and is due for clear", () => {
    const push = stored(VARIANTS.explicitFocus);
    const clock = clockAt(at("10:05"));
    expect(isPushShowing(push, clock)).toBe(true);
    expect(isPushBlocking(push, clock)).toBe(false);
    expect(isPushDueForClear(push, clock.nowMs)).toBe(true);
    expect(liveUntil(push, clock)).toBe(at("00:00", "2026-11-10"));
  });

  test("untilCleared and a focus ending 23:59:59.999 store the same end but read differently", () => {
    const untimed = stored(VARIANTS.untilClearedActivated);
    const timed = stored(VARIANTS.explicitFocusToMidnight);
    expect([untimed.endsAt, untimed.afterEnd]).toEqual([timed.endsAt, timed.afterEnd]);
    expect(untimed.endsAt).toBe(MONDAY_LAST_MS);

    // Only the explicit one has a window: an expiry, an auto-clear, an end.
    expect(pushExpiresAt(untimed)).toBeNull();
    expect(pushExpiresAt(timed)).toBe(MONDAY_LAST_MS);
    expect(isPushDueForClear(untimed, MONDAY_LAST_MS)).toBe(false);
    expect(isPushDueForClear(timed, MONDAY_LAST_MS)).toBe(true);
    expect(scheduleEntryFromPush(untimed)?.endsAt).toBeUndefined();
    expect(scheduleEntryFromPush(timed)?.endsAt).toBe(MONDAY_LAST_MS);
    expect(liveUntil(untimed, clockAt(at("12:00")))).toBe(at("00:00", "2026-11-10"));
    expect(liveUntil(timed, clockAt(at("12:00")))).toBe(MONDAY_LAST_MS);
    // At its stored end the untimed focus still shows: it owns the whole day.
    expect(isPushShowing(untimed, clockAt(MONDAY_LAST_MS))).toBe(true);
  });

  test("homework due at noon is still due today that afternoon, and never expires", () => {
    const push = stored(VARIANTS.datedHomework);
    expect(dueStatus(homeworkDueAt(push), at("15:00"), TZ)?.status).toBe("dueToday");
    expect(dueStatus(homeworkDueAt(push), at("09:00", "2026-11-10"), TZ)?.status)
      .toBe("overdue");
    expect(isPushShowing(push, clockAt(at("09:00", "2026-11-20")))).toBe(true);
    expect(pushExpiresAt(push)).toBeNull();
    expect(liveUntil(push, clockAt(at("15:00")))).toBeNull();
  });

  test("withdrawn homework keeps its withdrawal as the entry end and its due as the due", () => {
    expect(scheduleEntryFromPush(stored(VARIANTS.withdrawnHomework))).toMatchObject({
      mode: "homework",
      endsAt: at("10:00", "2026-11-10"),
      dueAt: at("15:00", "2026-11-13"),
    });
  });

  test("open-until focus keeps its multi-day end through the schedule projection", () => {
    const push = stored(VARIANTS.openUntilFocus);
    expect(scheduleEntryFromPush(push)).toMatchObject({
      mode: "classFocus", endsAt: at("17:00", "2026-11-14"), scholarIds: ["kid1"],
    });
    expect(isPushShowing(push, clockAt(at("12:00", "2026-11-12")))).toBe(true);
    expect(isPushShowing(push, clockAt(at("18:00", "2026-11-14")))).toBe(false);
  });
});

describe("the reads come from the new fields", () => {
  // Rows built with an end other than the requested one, to prove the readers
  // follow `endsAt`/`afterEnd` rather than recomputing from the request.
  test("an explicit focus's end, a homework due and the lane follow endsAt/afterEnd", () => {
    const focus: PushDoc = { ...stored(VARIANTS.explicitFocus), endsAt: at("11:00") };
    expect(pushExpiresAt(focus)).toBe(at("11:00"));
    expect(scheduleEntryFromPush(focus)?.endsAt).toBe(at("11:00"));

    const homework: PushDoc = {
      ...stored(VARIANTS.datedHomework), endsAt: at("12:00", "2026-11-11"),
    };
    expect(homeworkDueAt(homework)).toBe(at("12:00", "2026-11-11"));
    expect(scheduleEntryFromPush(homework)?.dueAt).toBe(at("12:00", "2026-11-11"));
    expect(pushLane({ ...homework, afterEnd: "fade" })).toBe("classFocus");
  });
});
