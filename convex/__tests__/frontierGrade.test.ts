import { describe, expect, test } from "vitest";
import {
  frontierRank,
  frontierGradeValue,
  fluentCount,
  gradeLabelFromRankOrNull,
  gradeLabelFromValueOrNull,
  monthBoundaries,
  type MasteryRowForGrade,
} from "../lib/practice/frontierGrade";

// The single canonical grade definition (demonstrated-fluent frontier) that
// feeds the working-level vector, the teacher portrait, and the parent read.
// These pin the two invariants the portrait leans on: (1) the DEMONSTRATED gate
// (a placement/valve credit never inflates the grade), and (2) the trajectory
// is real — reconstructed forward-only from `becameFluentAt`, monotonic, and
// equal to the live value at `asOf = now`, with un-timestamped fluent rows
// counted from the baseline (honest left-censoring, never a fabricated slope).

const FLUENT = 3; // FLUENT_REPS

const grades = new Map<string, string | null | undefined>([
  ["add", "1"],
  ["mul", "3"],
  ["frac", "5"],
  ["ungraded", null],
]);

function row(
  skillKey: string,
  over: Partial<MasteryRowForGrade> = {},
): MasteryRowForGrade {
  return { skillKey, repetition: FLUENT, source: "practice", ...over };
}

describe("frontierRank — demonstrated gate", () => {
  test("takes the max grade among demonstrated-fluent skills", () => {
    const rows = [row("add"), row("mul"), row("frac")];
    expect(frontierRank(rows, grades)).toBe(5);
  });

  test("a not-yet-access-proven skill does not count", () => {
    const rows = [row("add"), row("frac", { repetition: FLUENT - 1 })];
    expect(frontierRank(rows, grades)).toBe(1);
  });

  test("an INFERRED credit (placement) never inflates the grade", () => {
    // frac is access-proven but only via placement → provisional, not green.
    const rows = [row("add"), row("frac", { source: "placement" })];
    expect(frontierRank(rows, grades)).toBe(1);
  });

  test("a fluent skill with no known grade is skipped", () => {
    const rows = [row("ungraded")];
    expect(frontierRank(rows, grades)).toBeNull();
  });

  test("no demonstrated-fluent skill → null (no fabricated zero)", () => {
    const rows = [row("frac", { repetition: 0 })];
    expect(frontierRank(rows, grades)).toBeNull();
  });
});

describe("frontierRank — trajectory reconstruction (asOf)", () => {
  const t0 = Date.UTC(2026, 0, 1);
  const t1 = Date.UTC(2026, 1, 1);
  const t2 = Date.UTC(2026, 2, 1);

  test("only skills fluent by the cutoff count", () => {
    const rows = [
      row("add", { becameFluentAt: t0 }),
      row("mul", { becameFluentAt: t1 }),
      row("frac", { becameFluentAt: t2 }),
    ];
    expect(frontierRank(rows, grades, t0)).toBe(1); // add only
    expect(frontierRank(rows, grades, t1)).toBe(3); // add + mul
    expect(frontierRank(rows, grades, t2)).toBe(5); // all three
  });

  test("the series is monotonic non-decreasing over time", () => {
    const rows = [
      row("add", { becameFluentAt: t0 }),
      row("mul", { becameFluentAt: t1 }),
      row("frac", { becameFluentAt: t2 }),
    ];
    const series = [t0, t1, t2].map((t) => frontierRank(rows, grades, t) ?? -1);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
    }
  });

  test("un-timestamped fluent rows count from the baseline (left-censoring)", () => {
    // A pre-instrumentation demonstrated-fluent skill has no stamp; it must count
    // at EVERY cutoff — "fluent as of the start of our records", not fabrication.
    const rows = [row("frac"), row("mul", { becameFluentAt: t2 })];
    expect(frontierRank(rows, grades, t0)).toBe(5); // frac already present
    expect(frontierRank(rows, grades, t2)).toBe(5);
  });

  test("asOf=now equals the live (undefined) value", () => {
    const now = Date.now();
    const rows = [
      row("add", { becameFluentAt: now - 1000 }),
      row("frac", { becameFluentAt: now - 1000 }),
    ];
    expect(frontierRank(rows, grades, now)).toBe(frontierRank(rows, grades));
  });
});

describe("fluentCount", () => {
  test("counts only demonstrated-fluent rows", () => {
    const rows = [
      row("add"),
      row("frac", { source: "placement" }), // provisional
      row("mul", { repetition: 0 }), // not access-proven
    ];
    expect(fluentCount(rows)).toBe(1);
  });

  test("asOf counts only skills fluent by that instant", () => {
    const t = Date.UTC(2026, 5, 1);
    const rows = [
      row("add", { becameFluentAt: t - 1 }),
      row("mul", { becameFluentAt: t + 1 }),
    ];
    expect(fluentCount(rows, t)).toBe(1);
  });
});

describe("gradeLabelFromRankOrNull", () => {
  test("renders K / N and preserves null", () => {
    expect(gradeLabelFromRankOrNull(0)).toBe("Grade K");
    expect(gradeLabelFromRankOrNull(5)).toBe("Grade 5");
    expect(gradeLabelFromRankOrNull(null)).toBeNull();
  });
});

describe("frontierGradeValue — continuous grade-equivalent", () => {
  // A denser catalog than the scholar's rows so within-grade completion is a
  // real fraction: grade 1 has {add, sub}, grade 3 has {mul}, grade 5 has
  // {frac, f2, f3, f4}. A scholar fluent in some subset of a grade lands partway
  // into it, never at a grade with no evidence.
  const catalog = new Map<string, string | null | undefined>([
    ["add", "1"],
    ["sub", "1"],
    ["mul", "3"],
    ["frac", "5"],
    ["f2", "5"],
    ["f3", "5"],
    ["f4", "5"],
  ]);

  test("frontier grade plus within-grade completion (fluent-at-G / catalog-at-G)", () => {
    // Fluent 1 of grade 5's 4 catalog skills → 5 + 0.25 = 5.25.
    const rows = [row("add"), row("frac")];
    expect(frontierGradeValue(rows, catalog)).toBeCloseTo(5.25, 5);
  });

  test("half of a grade's catalog → the .5 midpoint", () => {
    const rows = [row("add")]; // 1 of grade 1's 2 catalog skills
    expect(frontierGradeValue(rows, catalog)).toBeCloseTo(1.5, 5);
  });

  test("a fully-consolidated grade caps at .9 (never rolls into the next grade)", () => {
    const rows = [row("add"), row("sub")]; // 2 of 2 at grade 1 → completion 1.0
    expect(frontierGradeValue(rows, catalog)).toBeCloseTo(1.9, 5);
  });

  test("no demonstrated-fluent skill → null (no fabricated decimal)", () => {
    expect(frontierGradeValue([row("frac", { repetition: 0 })], catalog)).toBeNull();
  });

  test("the continuous series is monotonic non-decreasing over time", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const t1 = Date.UTC(2026, 1, 1);
    const t2 = Date.UTC(2026, 2, 1);
    const rows = [
      row("add", { becameFluentAt: t0 }),
      row("frac", { becameFluentAt: t1 }),
      row("f2", { becameFluentAt: t2 }),
    ];
    const series = [t0, t1, t2].map((t) => frontierGradeValue(rows, catalog, t) ?? -1);
    expect(series[0]).toBeCloseTo(1.5, 5); // only `add` fluent → 1 of grade 1's 2
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
    }
  });
});

describe("gradeLabelFromValueOrNull", () => {
  test("renders one decimal place, keeps the K token, preserves null", () => {
    expect(gradeLabelFromValueOrNull(2.2)).toBe("Grade 2.2");
    expect(gradeLabelFromValueOrNull(5.9)).toBe("Grade 5.9");
    expect(gradeLabelFromValueOrNull(0.4)).toBe("Grade K.4");
    expect(gradeLabelFromValueOrNull(0)).toBe("Grade K.0");
    expect(gradeLabelFromValueOrNull(null)).toBeNull();
  });
});

describe("monthBoundaries", () => {
  test("returns `count` points ending exactly at now", () => {
    const now = Date.UTC(2026, 6, 15);
    const pts = monthBoundaries(now, 6);
    expect(pts).toHaveLength(6);
    expect(pts[pts.length - 1]).toBe(now);
    // strictly increasing
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]).toBeGreaterThan(pts[i - 1]);
    }
  });

  test("uses calendar month starts without rolling short months forward", () => {
    const now = new Date(2026, 6, 31, 12).getTime();
    expect(monthBoundaries(now, 6)).toEqual([
      new Date(2026, 1, 1).getTime(),
      new Date(2026, 2, 1).getTime(),
      new Date(2026, 3, 1).getTime(),
      new Date(2026, 4, 1).getTime(),
      new Date(2026, 5, 1).getTime(),
      now,
    ]);
  });
});
