import { describe, expect, test } from "vitest";
import {
  frontierRank,
  frontierGradeValue,
  fluentCount,
  fluentSkillLabelsNewestFirst,
  gradeLabelFromRankOrNull,
  gradeLabelFromValueOrNull,
  monthBoundaries,
  mathLevel,
  isLearnedSkill,
  learnedPace,
  paceWindowStart,
  type MasteryRowForGrade,
} from "../lib/practice/frontierGrade";

// The legacy "highest" figure (demonstrated-fluent frontier), shown beside the
// level on every surface. These pin its two invariants: (1) the DEMONSTRATED
// gate (a placement/valve credit never raises the highest figure), and (2) the
// trajectory
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

describe("fluentSkillLabelsNewestFirst", () => {
  const labels = new Map<string, string | undefined>([
    ["add", "Add within 20"],
    ["mul", "Multiply by 10"],
    ["frac", "Equivalent fractions"],
    ["ungraded", "Count to 100"],
    ["blank", "  "],
  ]);

  test("names exactly the skills fluentCount counts, newest fluent first, unstamped last", () => {
    const rows = [
      row("add"), // fluent before stamps existed
      row("mul", { becameFluentAt: 200 }),
      row("frac", { becameFluentAt: 300 }),
      row("ungraded", { source: "placement" }), // placement credit is never named
      row("blank", { becameFluentAt: 400 }), // no usable label: counted, never named
    ];
    expect(fluentSkillLabelsNewestFirst(rows, labels)).toEqual([
      "Equivalent fractions",
      "Multiply by 10",
      "Add within 20",
    ]);
    expect(fluentCount(rows)).toBe(4);
  });

  test("a limit keeps only the newest", () => {
    const rows = [
      row("add", { becameFluentAt: 100 }),
      row("mul", { becameFluentAt: 400 }),
      row("frac", { becameFluentAt: 300 }),
      row("ungraded", { becameFluentAt: 200 }),
    ];
    expect(fluentSkillLabelsNewestFirst(rows, labels, 3)).toEqual([
      "Multiply by 10",
      "Equivalent fractions",
      "Count to 100",
    ]);
  });
});

describe("paceWindowStart", () => {
  const termStart = Date.UTC(2026, 7, 11);
  test("a scholar who joined before the term is measured from the term's start", () => {
    expect(paceWindowStart(termStart, termStart - 90 * 86_400_000)).toBe(termStart);
  });
  test("a scholar who joined after the term began is measured from the day they joined", () => {
    const joined = Date.UTC(2026, 10, 1);
    expect(paceWindowStart(termStart, joined)).toBe(joined);
  });
  test("with no join time the term's start stands", () => {
    expect(paceWindowStart(termStart, undefined)).toBe(termStart);
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

describe("gradeLabelFromValueOrNull — rounding (cross-family review)", () => {
  test("rounds the whole value before splitting, so 1.96 is Grade 2.0, never Grade 1.10", () => {
    expect(gradeLabelFromValueOrNull(1.96)).toBe("Grade 2.0");
    expect(gradeLabelFromValueOrNull(0.97)).toBe("Grade 1.0");
    expect(gradeLabelFromValueOrNull(4.94)).toBe("Grade 4.9");
    expect(gradeLabelFromValueOrNull(0.5)).toBe("Grade K.5");
  });
});

describe("mathLevel asOf — credit that came before the demonstration", () => {
  // A row the placement check-in credited and the scholar later demonstrated:
  // the demonstrating attempt stamps `becameFluentAt` but never
  // `frontierAdvancedAt` (access was already proven), so the missing stamp is
  // the record that the credit came first.
  const g = new Map<string, string | null | undefined>([["add", "1"], ["sub", "1"]]);
  const t = Date.UTC(2026, 9, 1);
  test("a placement credit demonstrated later still counts before the demonstration, as placement", () => {
    const rows = [row("add", { becameFluentAt: t + 10 * 86_400_000 })];
    const before = mathLevel(rows, g, { asOf: t });
    expect(before?.value).toBeCloseTo(1.5);
    expect(before?.bands[0]).toEqual({ rank: 1, total: 2, daily: 0, placement: 1 });
    expect(mathLevel(rows, g)?.bands[0]).toEqual({ rank: 1, total: 2, daily: 1, placement: 0 });
  });
  test("a skill demonstrated from scratch (both stamps) does not count before it", () => {
    const at = t + 10 * 86_400_000;
    const rows = [row("add", { becameFluentAt: at, frontierAdvancedAt: at }), row("sub", { becameFluentAt: t - 1, frontierAdvancedAt: t - 1 })];
    expect(mathLevel(rows, g, { asOf: t })?.bands[0]).toEqual({ rank: 1, total: 2, daily: 1, placement: 0 });
  });
  test("a valve credit counts from its frontierAdvancedAt, as inferred until demonstrated", () => {
    const rows = [row("add", { becameFluentAt: t + 20 * 86_400_000, frontierAdvancedAt: t + 5 * 86_400_000 })];
    expect(mathLevel(rows, g, { asOf: t })).toBeNull();
    expect(mathLevel(rows, g, { asOf: t + 10 * 86_400_000 })?.bands[0]).toEqual({ rank: 1, total: 2, daily: 0, placement: 1 });
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

describe("mathLevel over the whole catalog (the overall level)", () => {
  const catalog = new Map<string, string | null | undefined>([
    ["k1", "K"],
    ["k2", "K"],
    ["a1", "1"],
    ["a2", "1"],
    ["a3", "1"],
    ["a4", "1"],
    ["a5", "1"],
    ["b1", "2"],
    ["b2", "2"],
    ["nograde", null],
  ]);
  const credit = (skillKey: string, source: string): MasteryRowForGrade => ({
    skillKey,
    repetition: FLUENT,
    source,
  });

  test("adds each grade's credited share and splits daily work from placement", () => {
    const level = mathLevel(
      [
        credit("k1", "practice"),
        credit("k2", "placement"),
        credit("a1", "practice"),
        credit("a2", "practice"),
        credit("a3", "placement"),
        credit("a4", "placement"),
        credit("b1", "practice"),
        credit("nograde", "practice"),
        // Below the fluent line, and a second row for a counted skill.
        { skillKey: "a5", repetition: 1, source: "practice" },
        credit("k1", "practice"),
      ],
      catalog,
    )!;
    // K 2/2, grade 1 4/5, grade 2 1/2.
    expect(level.value).toBeCloseTo(1 + 0.8 + 0.5);
    expect(level.dailyValue).toBeCloseTo(0.5 + 0.4 + 0.5);
    expect(level.placementValue).toBeCloseTo(0.5 + 0.4);
    expect(level.dailySkills).toBe(4);
    expect(level.placementSkills).toBe(3);
    // Grade 1 is solid at exactly four fifths; grade 2 at half is not.
    expect(level.solidThroughRank).toBe(1);
    expect(level.bands).toEqual([
      { rank: 0, total: 2, daily: 1, placement: 1 },
      { rank: 1, total: 5, daily: 2, placement: 2 },
      { rank: 2, total: 2, daily: 1, placement: 0 },
    ]);
  });

  test("a gap low down stops the solid run, whatever sits above it", () => {
    const level = mathLevel(
      [credit("k1", "practice"), credit("b1", "practice"), credit("b2", "practice")],
      catalog,
    )!;
    expect(level.solidThroughRank).toBeNull();
    expect(level.value).toBeCloseTo(0.5 + 1);
  });

  test("nothing credited yet is null, never a zero level", () => {
    expect(mathLevel([{ skillKey: "a1", repetition: 1 }], catalog)).toBeNull();
  });
});

describe("mathLevel over one area's catalog", () => {
  // A stamped skill here was learned in practice: access and fluency crossed
  // on the same attempt, so both stamps match (a placement credit demonstrated
  // later has only `becameFluentAt`; see the "credit that came before the
  // demonstration" tests).
  const credit = (skillKey: string, source: string, becameFluentAt?: number): MasteryRowForGrade => ({
    skillKey,
    repetition: FLUENT,
    source,
    becameFluentAt,
    frontierAdvancedAt: becameFluentAt,
  });

  test("the whole catalog keeps the overall level: base 0, value is the two parts", () => {
    const catalog = new Map<string, string | null | undefined>([
      ["k1", "K"],
      ["a1", "1"],
      ["a2", "1"],
    ]);
    const level = mathLevel([credit("k1", "practice"), credit("a1", "placement")], catalog)!;
    expect(level.baseValue).toBe(0);
    expect(level.value).toBeCloseTo(1.5);
    expect(level.value).toBeCloseTo(level.baseValue + level.dailyValue + level.placementValue);
  });

  test("an area whose catalog starts at grade 6 starts its level at 6", () => {
    const ratios = new Map<string, string | null | undefined>([
      ["r1", "6"],
      ["r2", "6"],
      ["r3", "7"],
      ["r4", "7"],
    ]);
    const level = mathLevel([credit("r1", "practice")], ratios)!;
    expect(level.baseValue).toBe(6);
    expect(level.value).toBeCloseTo(6.5);
    expect(level.solidThroughRank).toBeNull();
    const all6 = mathLevel([credit("r1", "practice"), credit("r2", "placement")], ratios)!;
    expect(all6.value).toBeCloseTo(7);
    expect(all6.solidThroughRank).toBe(6);
  });

  // Grades 1 and 3 present, grade 2 absent.
  const gapped = new Map<string, string | null | undefined>([
    ["a1", "1"],
    ["a2", "1"],
    ["c1", "3"],
    ["c2", "3"],
  ]);

  test("an absent grade below the highest credited one counts as passed", () => {
    const level = mathLevel(
      [credit("a1", "practice"), credit("a2", "practice"), credit("c1", "practice")],
      gapped,
    )!;
    // Start at 1, grade 1 full (1), grade 2 absent and passed (1), half of grade 3.
    expect(level.baseValue).toBe(2);
    expect(level.value).toBeCloseTo(3.5);
    // The solid run skips the absent grade.
    expect(level.solidThroughRank).toBe(1);
  });

  test("an absent grade above the highest credited one adds nothing", () => {
    const level = mathLevel([credit("a1", "practice")], gapped)!;
    expect(level.baseValue).toBe(1);
    expect(level.value).toBeCloseTo(1.5);
  });

  test("placement credit raises the area's level, while the highest figure stays put", () => {
    const level = mathLevel([credit("a1", "practice"), credit("c1", "placement")], gapped)!;
    expect(level.value).toBeCloseTo(1 + 0.5 + 1 + 0.5);
    expect(level.placementSkills).toBe(1);
    expect(frontierGradeValue([credit("a1", "practice"), credit("c1", "placement")], gapped)).toBeCloseTo(1.5);
  });

  test("asOf leaves out daily skills stamped later, keeps unstamped and placement credit", () => {
    const t0 = 1_000;
    const rows = [
      credit("a1", "practice", t0 + 10), // stamped after t0
      credit("a2", "practice"), // unstamped baseline
      credit("c1", "placement"), // placement: from the baseline
    ];
    const then = mathLevel(rows, gapped, { asOf: t0 })!;
    expect(then.dailySkills).toBe(1);
    expect(then.placementSkills).toBe(1);
    expect(then.value).toBeCloseTo(1 + 0.5 + 1 + 0.5);
    const now = mathLevel(rows, gapped)!;
    expect(now.value).toBeCloseTo(1 + 1 + 1 + 0.5);
    expect(mathLevel(rows, gapped, { asOf: t0 + 10 })!.value).toBeCloseTo(now.value);
  });

  test("nothing credited is null, in an area too", () => {
    expect(mathLevel([{ skillKey: "c1", repetition: 1, source: "practice" }], gapped)).toBeNull();
    expect(mathLevel([credit("a1", "practice", 5)], gapped, { asOf: 1 })).toBeNull();
  });
});

describe("isLearnedSkill", () => {
  test("in an already-solid grade it takes two misses", () => {
    expect(isLearnedSkill({ misses: 0, skillRank: 1, firstOpenRank: 3 })).toBe(false);
    expect(isLearnedSkill({ misses: 1, skillRank: 1, firstOpenRank: 3 })).toBe(false);
    expect(isLearnedSkill({ misses: 2, skillRank: 1, firstOpenRank: 3 })).toBe(true);
  });

  test("in a grade with open skills one miss is enough", () => {
    expect(isLearnedSkill({ misses: 0, skillRank: 3, firstOpenRank: 3 })).toBe(false);
    expect(isLearnedSkill({ misses: 1, skillRank: 3, firstOpenRank: 3 })).toBe(true);
    expect(isLearnedSkill({ misses: 1, skillRank: 4, firstOpenRank: 3 })).toBe(true);
    expect(isLearnedSkill({ misses: 2, skillRank: 4, firstOpenRank: 3 })).toBe(true);
  });

  test("with no level at the start every grade is new territory", () => {
    expect(isLearnedSkill({ misses: 0, skillRank: 0, firstOpenRank: null })).toBe(false);
    expect(isLearnedSkill({ misses: 1, skillRank: 0, firstOpenRank: null })).toBe(true);
  });
});

describe("learnedPace", () => {
  const DAY = 86_400_000;
  const MONTH = 30.44 * DAY;
  // Grade 1 has four skills, so each is a quarter of a grade: 2.5 school months.
  const catalog = new Map<string, string | null | undefined>([
    ["a1", "1"],
    ["a2", "1"],
    ["a3", "1"],
    ["a4", "1"],
    ["nograde", null],
  ]);
  const start = 1_000 * DAY;
  const end = start + 2 * MONTH;
  const fluentAt = (skillKey: string, at: number, source = "practice"): MasteryRowForGrade => ({
    skillKey,
    repetition: FLUENT,
    source,
    becameFluentAt: at,
  });

  test("only skills in the learned set count as new learning", () => {
    const pace = learnedPace(
      [
        fluentAt("a1", start + DAY), // learned
        fluentAt("a2", start + 2 * DAY), // already known
        fluentAt("a3", start - DAY), // fluent before the term
        fluentAt("a4", start + DAY, "placement"), // credited, never demonstrated
        fluentAt("nograde", start + DAY),
      ],
      catalog,
      new Set(["a1", "a3", "nograde"]),
      start,
      end,
    );
    expect(pace.learnedSkills).toBe(1);
    expect(pace.knownSkills).toBe(1);
    expect(pace.learnedMonths).toBeCloseTo(2.5);
    expect(pace.knownMonths).toBeCloseTo(2.5);
    expect(pace.schoolMonths).toBeCloseTo(2);
    // 2.5 months of curriculum in 2 months of school.
    expect(pace.pace).toBeCloseTo(1.25);
  });

  test("under a month of school states no rate", () => {
    const pace = learnedPace([fluentAt("a1", start + DAY)], catalog, new Set(["a1"]), start, start + 10 * DAY);
    expect(pace.learnedMonths).toBeCloseTo(2.5);
    expect(pace.pace).toBeNull();
  });
});
