import { describe, expect, test } from "vitest";
import {
  breakerMissStreakAttempts,
  breakerFlowFromLifecycle,
  consecutiveMissStreak,
  isBreakerCountedAttempt,
  pickRecoverySkill,
  projectBreakerEpisode,
  SPIRAL_GAP_MS,
  SPIRAL_MISS_THRESHOLD,
  SPIRAL_SCAN_LIMIT,
  type BreakerFullLifecycle,
  type RecoveryMasteryRow,
} from "../lib/practice/spiralBreaker";

const NOW = 1_000_000_000;

function miss(lane: string | undefined, age = 0) {
  return { correct: false, lane, createdAt: NOW - age };
}

describe("consecutiveMissStreak", () => {
  test("counts only review, frontier, and confirmation misses", () => {
    expect(
      consecutiveMissStreak([
        miss("review"),
        miss("frontier", 1),
        miss("confirmation", 2),
      ]),
    ).toBe(SPIRAL_MISS_THRESHOLD);
  });

  test("excluded and missing lanes are skipped without breaking the streak", () => {
    expect(
      consecutiveMissStreak([
        miss("review"),
        miss("stretch", 1),
        miss(undefined, 2),
        miss("challenge", 3),
        miss("frontier", 4),
      ]),
    ).toBe(2);
  });

  test("persisted exclusions are transparent and cannot become streak members", () => {
    const newest = { ...miss("review"), id: "newest" };
    const excluded = {
      ...miss("frontier", 1),
      id: "excluded",
      breakerEligible: false,
    };
    const oldest = { ...miss("confirmation", 2), id: "oldest" };

    expect(
      breakerMissStreakAttempts([newest, excluded, oldest]).map(
        (attempt) => attempt.id,
      ),
    ).toEqual(["newest", "oldest"]);
    expect(consecutiveMissStreak([newest, excluded, oldest])).toBe(2);
    expect(isBreakerCountedAttempt(excluded)).toBe(false);
  });

  test("a correct excluded attempt still resets the streak", () => {
    expect(
      consecutiveMissStreak([
        miss("review"),
        {
          correct: true,
          lane: "frontier",
          createdAt: NOW - 1,
          breakerEligible: false,
        },
        miss("confirmation", 2),
      ]),
    ).toBe(1);
  });

  test("legacy absence stays eligible while retry remains authoritative", () => {
    const legacy = miss("review");
    expect(isBreakerCountedAttempt(legacy)).toBe(true);
    expect(
      isBreakerCountedAttempt({
        ...legacy,
        retry: true,
        breakerEligible: true,
      }),
    ).toBe(false);
  });

  test("a counted correct attempt ends the streak", () => {
    expect(
      consecutiveMissStreak([
        miss("review"),
        { correct: true, lane: "frontier", createdAt: NOW - 1 },
        miss("confirmation", 2),
      ]),
    ).toBe(1);
  });

  test("a gap over thirty minutes ends the streak between counted attempts", () => {
    expect(
      consecutiveMissStreak([
        miss("review"),
        miss("stretch", SPIRAL_GAP_MS),
        miss("frontier", SPIRAL_GAP_MS + 1),
      ]),
    ).toBe(1);
  });

  test("scans at most twenty-four rows, including skipped rows", () => {
    const skipped = Array.from({ length: SPIRAL_SCAN_LIMIT - 1 }, (_, i) =>
      miss("placement", i + 1),
    );
    expect(
      consecutiveMissStreak([
        miss("review"),
        ...skipped,
        miss("frontier", SPIRAL_SCAN_LIMIT + 1),
      ]),
    ).toBe(1);
  });

  test("the threshold boundary trips at exactly three misses", () => {
    expect(consecutiveMissStreak([miss("review"), miss("frontier")])).toBe(
      SPIRAL_MISS_THRESHOLD - 1,
    );
    expect(
      consecutiveMissStreak([
        miss("review"),
        miss("frontier"),
        miss("confirmation"),
      ]),
    ).toBe(SPIRAL_MISS_THRESHOLD);
  });

  test("dontKnow is represented by correct false and counts as a miss", () => {
    expect(
      consecutiveMissStreak([
        { correct: false, lane: "review", createdAt: NOW },
      ]),
    ).toBe(1);
  });
});

describe("projectBreakerEpisode", () => {
  const lifecycle = { triggeredAt: NOW };

  test("is active until the exact thirty-minute expiry boundary", () => {
    expect(
      projectBreakerEpisode(lifecycle, NOW, NOW + SPIRAL_GAP_MS - 1).status,
    ).toBe("active");
    expect(
      projectBreakerEpisode(lifecycle, NOW, NOW + SPIRAL_GAP_MS).status,
    ).toBe("expired");
  });

  test("treats an issued easy item as activity, but not completion", () => {
    const issuedAt = NOW + 10;
    expect(
      projectBreakerEpisode(
        { ...lifecycle, easyItemId: "easy", easyIssuedAt: issuedAt, easyExitedAt: issuedAt },
        NOW,
        issuedAt + 1,
      ).status,
    ).toBe("active");
    expect(
      projectBreakerEpisode(
        { ...lifecycle, easyItemId: "easy", easyExitedAt: issuedAt },
        NOW,
        issuedAt + 1,
        "won",
      ).status,
    ).toBe("terminal");
  });

  test("uses a later counted miss as episode activity", () => {
    expect(
      projectBreakerEpisode(
        lifecycle,
        NOW + SPIRAL_GAP_MS - 1,
        NOW + SPIRAL_GAP_MS,
      ),
    ).toMatchObject({ status: "active", lastActivityAt: NOW + SPIRAL_GAP_MS - 1 });
  });
});

describe("pickRecoverySkill", () => {
  const DOMAIN = "whole-number-arithmetic";
  // A demonstrated-fluent row: access-proven reps, earned through practice, fresh
  // retention (practiced now, positive half-life), no latency signal.
  const fluent = (skillKey: string, repetition = 4): RecoveryMasteryRow => ({
    skillKey,
    domain: DOMAIN,
    repetition,
    source: "practice",
    halfLifeDays: 10,
    lastPracticedAt: NOW,
  });
  // A placement credit: access-proven reps but an INFERRED source, so never fluent.
  const placement = (
    skillKey: string,
    repetition = 4,
    domain = DOMAIN,
  ): RecoveryMasteryRow => ({
    skillKey,
    domain,
    repetition,
    source: "placement",
  });

  test("prefers a demonstrated-fluent skill over a higher-rep placement credit", () => {
    expect(
      pickRecoverySkill([placement("place_value", 6), fluent("add_within_20", 3)], {
        now: NOW,
      }),
    ).toEqual({ skillKey: "add_within_20", domain: DOMAIN });
  });

  test("within the fluent tier, highest repetition wins (ties broken by skillKey)", () => {
    expect(
      pickRecoverySkill([fluent("b_skill", 3), fluent("a_skill", 5)], { now: NOW })?.skillKey,
    ).toBe("a_skill");
    expect(
      pickRecoverySkill([fluent("b_skill", 4), fluent("a_skill", 4)], { now: NOW })?.skillKey,
    ).toBe("a_skill");
  });

  // The regression this fix targets: a brand-new scholar who spirals right after
  // placement has ZERO demonstrated-fluent skills (every row is a placement
  // credit). The offer still promises "one more", so a recovery skill MUST come
  // back — the best access-proven credit — instead of undefined (which bounced
  // the scholar straight home).
  test("falls back to the best access-proven skill when none are fluent", () => {
    expect(
      pickRecoverySkill(
        [placement("compare_2digit", 4), placement("count_to_20", 5), placement("arrays", 4)],
        { now: NOW },
      )?.skillKey,
    ).toBe("count_to_20");
    // deterministic tie-break by skillKey when reps are equal
    expect(
      pickRecoverySkill([placement("zzz", 4), placement("aaa", 4)], { now: NOW })?.skillKey,
    ).toBe("aaa");
  });

  test("falls back to any practiced skill when nothing is access-proven", () => {
    expect(
      pickRecoverySkill(
        [
          { skillKey: "just_started", domain: DOMAIN, repetition: 1, source: "practice" },
          { skillKey: "twice", domain: DOMAIN, repetition: 2, source: "practice" },
        ],
        { now: NOW },
      )?.skillKey,
    ).toBe("twice");
  });

  test("returns undefined only when there is no mastery at all", () => {
    expect(pickRecoverySkill([], { now: NOW })).toBeUndefined();
  });

  // The domain travels with the skill so the client's single-domain recovery
  // serve doesn't drop a cross-domain pick. A scholar whose best credit is in a
  // NON-default domain must get that domain back, not the whole-number default.
  test("returns the chosen skill's own domain (cross-domain pick)", () => {
    expect(
      pickRecoverySkill([placement("compare_fractions", 5, "fraction-arithmetic")], {
        now: NOW,
      }),
    ).toEqual({ skillKey: "compare_fractions", domain: "fraction-arithmetic" });
  });

  // `isServable` gates the pool to skills that can actually generate an item. A
  // placement-credited concept node with neither a template nor a stored variant
  // would serve nothing; filtering it out keeps the "one more" promise honest —
  // the best SERVABLE credit is chosen even if an unservable one ranks higher.
  test("skips unservable skills, choosing the best servable credit instead", () => {
    const servable = (key: string) => key !== "concept_only";
    expect(
      pickRecoverySkill(
        [placement("concept_only", 9), placement("add_within_20", 4)],
        { now: NOW },
        servable,
      ),
    ).toEqual({ skillKey: "add_within_20", domain: DOMAIN });
  });

  test("returns undefined when no mastery skill is servable", () => {
    expect(
      pickRecoverySkill([placement("concept_only", 9)], { now: NOW }, () => false),
    ).toBeUndefined();
  });
});

describe("breakerFlowFromLifecycle", () => {
  const base: BreakerFullLifecycle = { triggeredAt: NOW };

  test("a freshly triggered episode (no support yet) starts in repair/opening", () => {
    expect(breakerFlowFromLifecycle(base)).toEqual({
      stage: "repair",
      repair: "opening",
      coachUsed: false,
    });
  });

  test("a shown-but-not-yet-completed repair rung is repair/open", () => {
    expect(
      breakerFlowFromLifecycle({ ...base, repairShownAt: NOW + 1 }),
    ).toEqual({ stage: "repair", repair: "open", coachUsed: false });
  });

  test("an unavailable repair rung starts directly at repair/unavailable", () => {
    expect(
      breakerFlowFromLifecycle({ ...base, repairUnavailableAt: NOW + 1 }),
    ).toEqual({ stage: "repair", repair: "unavailable", coachUsed: false });
  });

  test("a completed repair rung is repair/done — still `repair` stage, never advanced further on its own", () => {
    expect(
      breakerFlowFromLifecycle({
        ...base,
        repairShownAt: NOW + 1,
        repairCompletedAt: NOW + 2,
      }),
    ).toEqual({ stage: "repair", repair: "done", coachUsed: false });
  });

  test("an escalated coach is stage coach, coachUsed true — coach-open never becomes coach-complete on its own", () => {
    expect(
      breakerFlowFromLifecycle({ ...base, coachEscalatedAt: NOW + 1 }),
    ).toEqual({ stage: "coach", repair: "opening", coachUsed: true });
  });

  test("a served-but-ungraded fresh item is stage fresh, no `fresh` result yet", () => {
    const flow = breakerFlowFromLifecycle({
      ...base,
      repairCompletedAt: NOW + 1,
      freshItemId: "gen#123",
      freshIssuedAt: NOW + 2,
    });
    expect(flow.stage).toBe("fresh");
    expect(flow.fresh).toBeUndefined();
  });

  test("a correctly graded fresh item closes with the recognized recovery", () => {
    const flow = breakerFlowFromLifecycle({
      ...base,
      repairCompletedAt: NOW + 1,
      freshItemId: "gen#123",
      freshResult: { attemptId: "att1" as never, itemId: "gen#123", correct: true, assisted: false, completedAt: NOW + 3 },
    });
    expect(flow.stage).toBe("close");
    expect(flow.fresh).toEqual({ correct: true, assisted: false, verified: true });
  });

  test("a MISSED fresh item still closes (never re-serves a different item), offering only the easy escape", () => {
    const flow = breakerFlowFromLifecycle({
      ...base,
      repairCompletedAt: NOW + 1,
      freshItemId: "gen#123",
      freshResult: { attemptId: "att1" as never, itemId: "gen#123", correct: false, assisted: false, completedAt: NOW + 3 },
    });
    expect(flow.stage).toBe("close");
    expect(flow.fresh).toEqual({ correct: false, assisted: false, verified: true });
    expect(flow.easy).toBeUndefined();
  });

  test("a pinned-but-ungraded easy item is stage easy, requested", () => {
    const flow = breakerFlowFromLifecycle({
      ...base,
      easyExitedAt: NOW + 1,
      easyItemId: "gen#456",
    });
    expect(flow.stage).toBe("easy");
    expect(flow.easy).toBe("requested");
  });

  test("an unavailable easy finish closes with easy: unavailable", () => {
    const flow = breakerFlowFromLifecycle({
      ...base,
      easyExitedAt: NOW + 1,
      easyUnavailableAt: NOW + 1,
    });
    expect(flow.stage).toBe("close");
    expect(flow.easy).toBe("unavailable");
  });

  test("a graded easy finish (won) closes with the recognized win", () => {
    const flow = breakerFlowFromLifecycle(
      { ...base, easyExitedAt: NOW + 1, easyItemId: "gen#456" },
      "won",
    );
    expect(flow.stage).toBe("close");
    expect(flow.easy).toBe("correct");
  });

  test("a graded easy finish (missed) closes with the recognized miss", () => {
    const flow = breakerFlowFromLifecycle(
      { ...base, easyExitedAt: NOW + 1, easyItemId: "gen#456" },
      "missed",
    );
    expect(flow.stage).toBe("close");
    expect(flow.easy).toBe("missed");
  });

  test("is idempotent: calling it twice on the same evidence produces the identical flow", () => {
    const lifecycle: BreakerFullLifecycle = {
      ...base,
      repairCompletedAt: NOW + 1,
      freshItemId: "gen#123",
    };
    expect(breakerFlowFromLifecycle(lifecycle)).toEqual(breakerFlowFromLifecycle(lifecycle));
  });
});
