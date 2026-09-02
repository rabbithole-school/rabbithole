import { describe, expect, test } from "vitest";
import {
  classFocusPlateLine,
  focusMismatchBannerText,
  formatRoomTurnTime,
  INITIAL_ROOM_TURN_MEMORY,
  isClassFocusRunningLong,
  nextRoomTurnMemory,
  roomTurnPhase,
  ROOM_TURN_WINDING_DOWN_MS,
  shouldShowTurnBanner,
  turnBannerLabel,
  TURNED_BANNER_TEXT,
  TYPICAL_BLOCK_MS,
  WINDING_DOWN_BANNER_TEXT,
} from "./roomTurn";
import type { RoomTurnMemory, RoomTurnPhase } from "./roomTurn";

function advance(
  prev: RoomTurnMemory,
  isFocusMatch: boolean,
  phase: RoomTurnPhase,
  label: string | null,
  endsAt: number | null = null,
  nowMs = 0,
) {
  return nextRoomTurnMemory(prev, {
    isFocusMatch,
    phase,
    label,
    endsAt,
    nowMs,
  });
}

describe("roomTurnPhase", () => {
  test("no endsAt (open-ended push) is always withClass", () => {
    expect(roomTurnPhase(Date.now(), null)).toBe("withClass");
    expect(roomTurnPhase(Date.now(), undefined)).toBe("withClass");
  });

  test("well before endsAt is withClass", () => {
    const now = 1_000_000;
    expect(roomTurnPhase(now, now + 10 * 60_000)).toBe("withClass");
  });

  test("inside the winding-down window is windingDown", () => {
    const now = 1_000_000;
    expect(roomTurnPhase(now, now + ROOM_TURN_WINDING_DOWN_MS)).toBe(
      "windingDown",
    );
    expect(roomTurnPhase(now, now + 1)).toBe("windingDown");
  });

  test("at or past endsAt is turned", () => {
    const now = 1_000_000;
    expect(roomTurnPhase(now, now)).toBe("turned");
    expect(roomTurnPhase(now, now - 1)).toBe("turned");
  });

  test("exactly at the winding-down boundary is windingDown (inclusive)", () => {
    const now = 1_000_000;
    expect(roomTurnPhase(now, now + ROOM_TURN_WINDING_DOWN_MS + 1)).toBe(
      "withClass",
    );
  });
});

describe("regression: fresh-morning Home, no live class focus (pilot6 W2)", () => {
  // A blind pilot sim (review/pilot6/, branch qb/pilot6-harness) flagged
  // "winding down" / end-of-day copy appearing on a FRESH scholar's Home in
  // the MORNING with no live class focus. Root-caused to a DIFFERENT,
  // pre-existing Scholar's Prep chooser, since retired in favor of a
  // window-gated sunset doorway. Its hardcoded "The day's winding down" copy
  // was unrelated to this file, `roomTurnPhase`, or any class-focus `endsAt`.
  // These tests lock down, defensively, that THIS module's derivation was never
  // the culprit and stays that way.
  test("a genuinely fresh morning with NO live focus never derives windingDown/turned", () => {
    // An arbitrary concrete morning wall-clock instant.
    const freshMorningNow = new Date("2026-07-13T08:00:00-10:00").getTime();
    // No live class-focus push at all ⇒ every real call site (see
    // hooks/useRoomTurnPhase.ts + the native twin) passes null/undefined for
    // endsAt — there is no server-side "stale push" value to leak in, because
    // currentClassFocusForMe/scholarClassFocusEntries (convex/assignments.ts)
    // only ever return LIVE entries (`isLiveEntry`: setAt stamped AND endsAt
    // still in the future); an ended push simply isn't in the result set.
    expect(roomTurnPhase(freshMorningNow, null)).toBe("withClass");
    expect(roomTurnPhase(freshMorningNow, undefined)).toBe("withClass");
  });

  test("a STALE, long-past endsAt (e.g. yesterday's push) is honestly 'turned', never silently 'withClass'", () => {
    // Defense in depth, not a workaround: this function does NOT special-case
    // "too old to count" — if a caller ever did hand it a stale past endsAt,
    // it correctly reports "turned" (never a fabricated windingDown/withClass
    // reading). The actual safety net that keeps this scenario from reaching
    // a scholar's screen lives upstream (the LIVE-only filtering described
    // above), not in this function pretending old timestamps are current.
    const freshMorningNow = new Date("2026-07-13T08:00:00-10:00").getTime();
    const yesterdaysStaleEndsAt = freshMorningNow - 18 * 60 * 60 * 1000;
    expect(roomTurnPhase(freshMorningNow, yesterdaysStaleEndsAt)).toBe(
      "turned",
    );
  });

  test("withClass copy never mentions winding down / the room moving on", () => {
    const line = classFocusPlateLine("withClass", "8:00 AM");
    expect(line.toLowerCase()).not.toContain("winding down");
    expect(line.toLowerCase()).not.toContain("moves on");
    expect(line.toLowerCase()).not.toContain("moved on");
  });

  test("a scholar who was never matched to a live focus never sees the turn banner, no matter the wall clock", () => {
    // Mirrors a fresh Home's actual call: isFocusMatch is false all morning
    // (no live push exists at all), so the at-the-turn memory never latches
    // "turned" regardless of how many times the client re-checks.
    let memory = INITIAL_ROOM_TURN_MEMORY;
    for (let i = 0; i < 10; i++) {
      memory = advance(memory, false, "withClass", null);
      expect(shouldShowTurnBanner(memory)).toBe(false);
    }
  });
});

describe("formatRoomTurnTime", () => {
  test("formats an instant in the given IANA timezone", () => {
    // 2026-01-15T20:00:00Z is 10:00 AM Hawaii time (UTC-10, no DST).
    const endsAt = Date.UTC(2026, 0, 15, 20, 0, 0);
    const label = formatRoomTurnTime(endsAt, "Pacific/Honolulu");
    expect(label).toBe("10:00 AM");
  });

  test("returns null for a bogus timezone instead of throwing", () => {
    expect(formatRoomTurnTime(Date.now(), "Not/AZone")).toBeNull();
  });
});

describe("copy builders (the ONE source of scholar-facing strings)", () => {
  test("classFocusPlateLine — withClass with a time", () => {
    expect(classFocusPlateLine("withClass", "10:25 AM")).toBe(
      "With the class until the block wraps (~10:25 AM)",
    );
  });

  test("classFocusPlateLine — withClass with no time (open-ended)", () => {
    expect(classFocusPlateLine("withClass", null)).toBe(
      "With the class right now",
    );
  });

  test("classFocusPlateLine — windingDown softens and never shows a number of minutes", () => {
    const line = classFocusPlateLine("windingDown", "10:25 AM");
    expect(line).toContain("find a good stopping point");
    expect(line).not.toMatch(/\d+\s*(min|minute|sec)/i);
  });

  test("focusMismatchBannerText names the focus and never says 'unlock'", () => {
    const line = focusMismatchBannerText("withClass", "Aquaponics", "10:25 AM");
    expect(line).toContain("Aquaponics");
    expect(line).toContain("10:25 AM");
    expect(line.toLowerCase()).not.toContain("unlock");
  });

  test("focusMismatchBannerText never tells the scholar to stop or wait", () => {
    // The hard focus gate is gone (shared/focusLock.ts): a scholar reading
    // this banner can still send in the session they're in, so the copy must
    // not imply a read-only wall in any phase.
    for (const phase of ["withClass", "windingDown", "turned"] as const) {
      for (const time of ["10:25 AM", null]) {
        const line = focusMismatchBannerText(phase, "Aquaponics", time).toLowerCase();
        expect(line).not.toContain("read-only");
        expect(line).not.toContain("can wait");
        expect(line).not.toContain("paused");
      }
    }
  });

  test("focusMismatchBannerText falls back gracefully with no focus name or time", () => {
    const line = focusMismatchBannerText("withClass", null, null);
    expect(line).toContain("something else");
    expect(line).not.toContain("null");
  });

  test("winding-down and turned scholar copy are fixed, soft, and numberless", () => {
    expect(WINDING_DOWN_BANNER_TEXT).not.toMatch(/\d/);
    expect(TURNED_BANNER_TEXT).not.toMatch(/\d/);
    expect(TURNED_BANNER_TEXT.toLowerCase()).not.toContain("overdue");
  });
});

describe("shouldShowTurnBanner / turnBannerLabel (the at-the-turn state machine)", () => {
  test("never shows while solidly with the class", () => {
    const m1 = advance(INITIAL_ROOM_TURN_MEMORY, true, "withClass", null);
    expect(shouldShowTurnBanner(m1)).toBe(false);
    const m2 = advance(INITIAL_ROOM_TURN_MEMORY, true, "windingDown", null);
    expect(shouldShowTurnBanner(m2)).toBe(false);
  });

  test("shows the instant the client clock crosses endsAt while still matched", () => {
    const m = advance(INITIAL_ROOM_TURN_MEMORY, true, "turned", "Aquaponics");
    expect(shouldShowTurnBanner(m)).toBe(true);
  });

  test("recognizes a scheduled turn from its end instant even before a phase poll catches up", () => {
    const endsAt = 1_800_000;
    const m = nextRoomTurnMemory(INITIAL_ROOM_TURN_MEMORY, {
      isFocusMatch: true,
      phase: "withClass",
      label: "Aquaponics",
      endsAt,
      nowMs: endsAt,
    });

    expect(shouldShowTurnBanner(m)).toBe(true);
  });

  test("shows once the server confirms the lock lifted after a prior match", () => {
    const wasMatched = advance(
      INITIAL_ROOM_TURN_MEMORY,
      true,
      "windingDown",
      "Aquaponics",
    );
    const afterLiftedLock = advance(wasMatched, false, "withClass", null);
    expect(shouldShowTurnBanner(afterLiftedLock)).toBe(true);
  });

  test("does not treat completion before a scheduled end as the room turning", () => {
    const endsAt = 1_800_000;
    const matchingScheduledFocus = nextRoomTurnMemory(
      INITIAL_ROOM_TURN_MEMORY,
      {
        isFocusMatch: true,
        phase: "withClass",
        label: "Aquaponics",
        endsAt,
        nowMs: endsAt - 60_000,
      },
    );
    const activityCompletedBeforeTheTurn = nextRoomTurnMemory(
      matchingScheduledFocus,
      {
        isFocusMatch: false,
        phase: "withClass",
        label: null,
        endsAt: null,
        nowMs: endsAt - 1,
      },
    );

    expect(shouldShowTurnBanner(activityCompletedBeforeTheTurn)).toBe(false);
  });

  test("shows after a scheduled focus's known end even if it no longer matches", () => {
    const endsAt = 1_800_000;
    const matchingScheduledFocus = nextRoomTurnMemory(
      INITIAL_ROOM_TURN_MEMORY,
      {
        isFocusMatch: true,
        phase: "windingDown",
        label: "Aquaponics",
        endsAt,
        nowMs: endsAt - 60_000,
      },
    );
    const afterScheduledTurn = nextRoomTurnMemory(matchingScheduledFocus, {
      isFocusMatch: false,
      phase: "withClass",
      label: null,
      endsAt: null,
      nowMs: endsAt,
    });

    expect(shouldShowTurnBanner(afterScheduledTurn)).toBe(true);
  });

  test("keeps a scheduled turn pending across an early unmatch until its end", () => {
    const endsAt = 1_800_000;
    const matchingScheduledFocus = nextRoomTurnMemory(
      INITIAL_ROOM_TURN_MEMORY,
      {
        isFocusMatch: true,
        phase: "withClass",
        label: "Aquaponics",
        endsAt,
        nowMs: endsAt - 60_000,
      },
    );
    const earlyUnmatch = nextRoomTurnMemory(matchingScheduledFocus, {
      isFocusMatch: false,
      phase: "withClass",
      label: null,
      endsAt: null,
      nowMs: endsAt - 1,
    });
    const scheduledTurn = nextRoomTurnMemory(earlyUnmatch, {
      isFocusMatch: false,
      phase: "withClass",
      label: null,
      endsAt: null,
      nowMs: endsAt,
    });

    expect(shouldShowTurnBanner(earlyUnmatch)).toBe(false);
    expect(shouldShowTurnBanner(scheduledTurn)).toBe(true);
  });

  test("shows when an open-ended teacher-controlled focus is explicitly lifted", () => {
    const openEndedFocus = nextRoomTurnMemory(INITIAL_ROOM_TURN_MEMORY, {
      isFocusMatch: true,
      phase: "withClass",
      label: "Aquaponics",
      endsAt: null,
      nowMs: 1_000_000,
    });
    const afterTeacherWrap = nextRoomTurnMemory(openEndedFocus, {
      isFocusMatch: false,
      phase: "withClass",
      label: null,
      endsAt: null,
      nowMs: 1_000_001,
    });

    expect(shouldShowTurnBanner(afterTeacherWrap)).toBe(true);
  });

  test("does NOT show if there was never a matching focus", () => {
    const m = advance(INITIAL_ROOM_TURN_MEMORY, false, "withClass", null);
    expect(shouldShowTurnBanner(m)).toBe(false);
  });

  test("STAYS shown across later checks, even once phase catches up a tick late", () => {
    // Regression: isFocusMatch (a query result) and phase (a client-side
    // clock hook) update on independent renders, so a real transition can
    // fire the state machine TWICE in quick succession — once with a STALE
    // phase, once with the caught-up one. The second check must not
    // un-decide the first's "turned" verdict.
    const wasMatched = advance(
      INITIAL_ROOM_TURN_MEMORY,
      true,
      "windingDown",
      "Aquaponics",
    );
    // First check: isFocusMatch already false, phase still stale from before.
    const firstCheck = advance(wasMatched, false, "windingDown", null);
    expect(shouldShowTurnBanner(firstCheck)).toBe(true);
    // Second check: phase has now caught up to "withClass" (no endsAt once
    // the lock's gone) — must NOT flip back off.
    const secondCheck = advance(firstCheck, false, "withClass", null);
    expect(shouldShowTurnBanner(secondCheck)).toBe(true);
  });

  test("does not auto-dismiss on its own — stays turned across many not-matched checks", () => {
    let memory = advance(INITIAL_ROOM_TURN_MEMORY, true, "turned", "Aquaponics");
    expect(shouldShowTurnBanner(memory)).toBe(true);
    for (let i = 0; i < 5; i++) {
      memory = advance(memory, false, "withClass", null);
      expect(shouldShowTurnBanner(memory)).toBe(true);
    }
  });

  test("a FRESH live match resets turned — the new push gets a clean slate", () => {
    const turned = advance(INITIAL_ROOM_TURN_MEMORY, true, "turned", "Aquaponics");
    const afterLift = advance(turned, false, "withClass", null);
    expect(shouldShowTurnBanner(afterLift)).toBe(true);
    const freshPush = advance(afterLift, true, "withClass", "Small Moments");
    expect(shouldShowTurnBanner(freshPush)).toBe(false);
  });

  test("turnBannerLabel prefers the live label, falling back to memory", () => {
    const m = advance(INITIAL_ROOM_TURN_MEMORY, true, "withClass", "Aquaponics");
    expect(turnBannerLabel(m)).toBe("Aquaponics");
    const afterLift = advance(m, false, "withClass", null);
    expect(turnBannerLabel(afterLift)).toBe("Aquaponics");
    expect(turnBannerLabel(INITIAL_ROOM_TURN_MEMORY)).toBeNull();
  });
});

describe("isClassFocusRunningLong (teacher-only awareness)", () => {
  test("a push with a future endsAt is never running long", () => {
    const now = 1_000_000;
    expect(isClassFocusRunningLong(now, now - 60_000, now + 60_000)).toBe(
      false,
    );
  });

  test("a push still visible past its own endsAt IS running long (lag edge case)", () => {
    const now = 1_000_000;
    expect(isClassFocusRunningLong(now, now - TYPICAL_BLOCK_MS, now - 1)).toBe(
      true,
    );
  });

  test("an open-ended push under the typical block length is not running long", () => {
    const now = 1_000_000;
    expect(
      isClassFocusRunningLong(now, now - (TYPICAL_BLOCK_MS - 1), null),
    ).toBe(false);
  });

  test("an open-ended push past the typical block length IS running long", () => {
    const now = 1_000_000;
    expect(
      isClassFocusRunningLong(now, now - (TYPICAL_BLOCK_MS + 1), undefined),
    ).toBe(true);
  });
});
