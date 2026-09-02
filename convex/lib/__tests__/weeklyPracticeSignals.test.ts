/**
 * The weekly practice read model — the ONE definition shared by the cron digest
 * and the teacher-facing `practiceDigest:weeklySignalsForScholars` query.
 *
 * These tests exist to pin the honesty properties, not the arithmetic: every
 * assertion below is a claim about what the number is allowed to mean. The
 * repeated shape is "an inferred/placement row must not move a number that is
 * labelled as demonstrated practice".
 */
import { describe, expect, it } from "vitest";
import {
  computeWeeklyPracticeSignals,
  FRICTION_MIN_MISSES,
  type WeeklyErrorRow,
  type WeeklyMasteryRow,
} from "../practiceDigest";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const SINCE = NOW - 7 * DAY_MS;
const DOMAIN = "whole-number-arithmetic";

function mastery(over: Partial<WeeklyMasteryRow> = {}): WeeklyMasteryRow {
  return {
    skillKey: "add-within-20",
    domain: DOMAIN,
    frontier: false,
    ...over,
  };
}

function error(over: Partial<WeeklyErrorRow> = {}): WeeklyErrorRow {
  return {
    domain: DOMAIN,
    nodeKey: "add-within-20",
    createdAt: NOW - DAY_MS,
    ...over,
  };
}

function run(
  masteryRows: WeeklyMasteryRow[],
  errorRows: WeeklyErrorRow[] = [],
  labelOf = new Map<string, string>(),
) {
  return computeWeeklyPracticeSignals({
    masteryRows,
    errorRows,
    domain: DOMAIN,
    since: SINCE,
    now: NOW,
    labelOf,
  });
}

describe("practicedDays", () => {
  it("counts distinct real drill days from lastAttemptAt", () => {
    const signals = run([
      mastery({ skillKey: "a", lastAttemptAt: NOW - DAY_MS }),
      mastery({ skillKey: "b", lastAttemptAt: NOW - DAY_MS - 60_000 }), // same day
      mastery({ skillKey: "c", lastAttemptAt: NOW - 3 * DAY_MS }),
    ]);
    expect(signals.practicedDays).toBe(2);
  });

  it("ignores lastPracticedAt, which placement and reprobe also stamp", () => {
    // A scholar who was placed this week but never drilled must read as quiet.
    const signals = run([
      mastery({ skillKey: "a", lastPracticedAt: NOW - DAY_MS }),
      mastery({ skillKey: "b", lastPracticedAt: NOW - 2 * DAY_MS }),
    ]);
    expect(signals.practicedDays).toBe(0);
    expect(signals.lastAttemptAt).toBeNull();
  });

  it("ignores attempts outside the window and caps at 7", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      mastery({ skillKey: `s${i}`, lastAttemptAt: NOW - i * DAY_MS }),
    );
    expect(run(rows).practicedDays).toBe(7);
  });

  it("only counts the requested domain", () => {
    const signals = run([
      mastery({ skillKey: "a", domain: "fractions", lastAttemptAt: NOW - DAY_MS }),
    ]);
    expect(signals.practicedDays).toBe(0);
  });
});

describe("skillsTurnedFluent", () => {
  it("reads the stored crossing stamp, newest first", () => {
    const signals = run(
      [
        mastery({ skillKey: "older", becameFluentAt: NOW - 4 * DAY_MS }),
        mastery({ skillKey: "newer", becameFluentAt: NOW - DAY_MS }),
      ],
      [],
      new Map([
        ["older", "Older skill"],
        ["newer", "Newer skill"],
      ]),
    );
    expect(signals.skillsTurnedFluent).toBe(2);
    expect(signals.turnedFluentLabels).toEqual(["Newer skill", "Older skill"]);
  });

  it("does not count a crossing that happened before the window", () => {
    const signals = run([mastery({ becameFluentAt: NOW - 30 * DAY_MS })]);
    expect(signals.skillsTurnedFluent).toBe(0);
  });

  it("does not count an unstamped row, however high its repetition count", () => {
    // Placement/accelerated credit can leave a high-repetition row that has
    // never been demonstrated. It is not a crossing and must not read as one.
    const signals = run([mastery({ skillKey: "placed" })]);
    expect(signals.skillsTurnedFluent).toBe(0);
    expect(signals.turnedFluentLabels).toEqual([]);
  });

  it("falls back to a humanised key when the graph has no label", () => {
    const signals = run([
      mastery({ skillKey: "add_within-20", becameFluentAt: NOW - DAY_MS }),
    ]);
    expect(signals.turnedFluentLabels).toEqual(["add within 20"]);
  });
});

describe("skillsAdvanced / frontierLabels", () => {
  it("counts frontierAdvancedAt stamps inside the window only", () => {
    const signals = run([
      mastery({ skillKey: "a", frontierAdvancedAt: NOW - 2 * DAY_MS }),
      mastery({ skillKey: "b", frontierAdvancedAt: NOW - 20 * DAY_MS }),
    ]);
    expect(signals.skillsAdvanced).toBe(1);
  });

  it("lists the CURRENT frontier, most recently practised first", () => {
    const signals = run(
      [
        mastery({ skillKey: "a", frontier: true, lastPracticedAt: NOW - 5 * DAY_MS }),
        mastery({ skillKey: "b", frontier: true, lastPracticedAt: NOW - DAY_MS }),
        mastery({ skillKey: "c", frontier: false, lastPracticedAt: NOW }),
      ],
      [],
      new Map([
        ["a", "Skill A"],
        ["b", "Skill B"],
        ["c", "Skill C"],
      ]),
    );
    expect(signals.frontierLabels).toEqual(["Skill B", "Skill A"]);
  });
});

describe("friction", () => {
  it("stays silent below the calibrated floor", () => {
    const rows = Array.from({ length: FRICTION_MIN_MISSES - 1 }, () => error());
    const signals = run([mastery()], rows);
    expect(signals.frictionSkillLabel).toBeNull();
    expect(signals.frictionMisses).toBe(0);
  });

  it("reports the worst skill at or above the floor", () => {
    const signals = run(
      [mastery()],
      [
        ...Array.from({ length: 4 }, () => error({ nodeKey: "hard" })),
        ...Array.from({ length: 3 }, () => error({ nodeKey: "less-hard" })),
      ],
      new Map([
        ["hard", "Hard skill"],
        ["less-hard", "Less hard skill"],
      ]),
    );
    expect(signals.frictionSkillLabel).toBe("Hard skill");
    expect(signals.frictionMisses).toBe(4);
  });

  it("excludes a skill that turned fluent in the same window", () => {
    // Struggling on the way to a crossing is learning, not friction.
    const signals = run(
      [mastery({ skillKey: "hard", becameFluentAt: NOW - DAY_MS })],
      Array.from({ length: 5 }, () => error({ nodeKey: "hard" })),
      new Map([["hard", "Hard skill"]]),
    );
    expect(signals.frictionSkillLabel).toBeNull();
  });

  it("ignores misses from another domain and outside the window", () => {
    const signals = run(
      [mastery()],
      [
        ...Array.from({ length: 5 }, () => error({ domain: "fractions" })),
        ...Array.from({ length: 5 }, () =>
          error({ createdAt: NOW - 30 * DAY_MS }),
        ),
      ],
    );
    expect(signals.frictionSkillLabel).toBeNull();
  });
});

describe("lastAttemptAt", () => {
  it("is the newest real attempt across the domain", () => {
    const signals = run([
      mastery({ skillKey: "a", lastAttemptAt: NOW - 3 * DAY_MS }),
      mastery({ skillKey: "b", lastAttemptAt: NOW - 40 * DAY_MS }),
    ]);
    // Deliberately NOT clamped to the window: it powers the "last practised …"
    // clause of the quiet note, which is about how long it has been.
    expect(signals.lastAttemptAt).toBe(NOW - 3 * DAY_MS);
  });
});
