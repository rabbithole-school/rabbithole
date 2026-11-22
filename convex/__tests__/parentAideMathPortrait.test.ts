import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { gatherMathPortrait } from "../mathPortrait";
import { makeScholarReadTools, staffMathLevel } from "../lib/scholarReadTools";
import { gradeRelativeBand, levelDelta, schoolYearTenths } from "../../shared/gradeEquivalent";
import { assembleUnitDesignerTools } from "../lib/unitDesignerTools";
import { redactScholarPractice } from "../lib/scholarReads";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { atClock } from "./clockTestHelpers";
import { dayKeyForTimezone } from "../../shared/institutionDay";

// TRA-619: the parent aide's `get_scholar_practice` carries the Math Skills
// portrait the parent portal shows (grade level and growth per domain), first
// in its result, so the aide cannot describe a child below the grade the portal
// shows. Every other role's result is unchanged.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

const WNA = "whole-number-arithmetic";
const FRAC = "fraction-arithmetic";
const DAY = 86_400_000;
const SCHOLAR_NAME = "Kai Test";

async function seedWorld(t: TC) {
  const now = Date.now();
  // Enrolled well before any term a test opens.
  const scholarId = await atClock(now - 365 * DAY, async () =>
    seedScholarInInstitution(t, {
      institutionId: await seedTestInstitution(t),
      name: SCHOLAR_NAME,
      username: "kai_test",
    }),
  );
  await t.run(async (ctx) => {
    for (const [nodeKey, domain, grade] of [
      ["add", WNA, "1"],
      ["longdiv", WNA, "5"],
      ["longdiv2", WNA, "5"],
      ["equiv", FRAC, "3"],
      ["equiv2", FRAC, "3"],
    ] as const) {
      await ctx.db.insert("knowledgeNodes", { nodeKey, label: nodeKey, domain, grade });
    }
    // Whole numbers rise from grade 1 to grade 5 inside the window (growth);
    // fractions has one recent fluency event (no growth yet).
    for (const [skillKey, domain, becameFluentAt] of [
      ["add", WNA, now - 200 * DAY],
      ["longdiv", WNA, now - 1000],
      ["equiv", FRAC, now - 10 * DAY],
    ] as const) {
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey,
        domain,
        repetition: FLUENT_REPS,
        halfLifeDays: 30,
        frontier: false,
        source: "practice",
        updatedAt: now,
        // Learned in practice: access and fluency on the same attempt.
        becameFluentAt,
        frontierAdvancedAt: becameFluentAt,
      });
    }
  });
  return scholarId;
}

// An ActionCtx whose runQuery runs the real internal queries against the
// convex-test database, recording which functions the tool called.
function realCtx(t: TC) {
  const called: string[] = [];
  const ctx = {
    runQuery: async (ref: FunctionReference<"query", "internal">, args: never) => {
      called.push(getFunctionName(ref));
      return await t.run((c) => c.runQuery(ref, args));
    },
  } as unknown as ActionCtx;
  return { ctx, called };
}

async function runPracticeTool(
  t: TC,
  role: "parent" | "teacher" | "scholar",
  scholarId: Id<"users">,
  guardianScopedParentAide = false,
) {
  const { ctx, called } = realCtx(t);
  const tools = await makeScholarReadTools(
    ctx,
    () => {},
    role,
    role === "teacher" ? undefined : new Set([scholarId]),
    "",
    undefined,
    undefined,
    false,
    { guardianScopedParentAide },
  );
  const tool = tools.find((x) => x.name === "get_scholar_practice")!;
  const raw = (await tool.run({ scholarName: "kai" })) as string;
  return { raw, called };
}

async function practiceFor(t: TC, scholarId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.runQuery(internal.curriculumAssistant.getScholarPractice, { scholarId }),
  );
}

describe("get_scholar_practice — the parent's Math Skills portrait", () => {
  test("a parent's result leads with the portal's portrait, then the existing fields", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedWorld(t);

    const { raw } = await runPracticeTool(t, "parent", scholarId, true);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const portrait = await t.run((ctx) =>
      gatherMathPortrait(ctx.db, scholarId, { withFluentSkillLabels: true }),
    );
    // Guard against a vacuous match: two domains, one of them with growth.
    expect(portrait.domains).toHaveLength(2);
    expect(portrait.domains.some((d) => d.growth !== null)).toBe(true);

    // TRA-322: each domain carries the tile's count and the skills it counts.
    const wna = portrait.domains.find((d) => d.domain === WNA)!;
    expect(wna.fluentSkills).toBe(2);
    expect([...(wna.fluentSkillLabels ?? [])].sort()).toEqual(["add", "longdiv"]);

    expect(Object.keys(parsed)[0]).toBe("mathPortrait");
    expect(parsed.mathPortrait).toEqual({
      domains: portrait.domains.map((d) => ({
        domain: d.domain,
        label: d.label,
        gradeLabel: d.gradeLabel,
        highestGradeLabel: d.highestGradeLabel,
        skillsFromDailyWork: d.fluentSkills,
        skillsFromPlacementCheckIn: d.placementSkills,
        fluentSkills: d.fluentSkills,
        fluentSkillLabels: d.fluentSkillLabels,
        growth: d.growth
          ? { fromLabel: d.growth.fromLabel, toLabel: d.growth.toLabel }
          : null,
      })),
      monthsCovered: portrait.monthsCovered,
    });

    // The redacted practice fields follow the portrait, unchanged.
    const rest = { ...parsed };
    delete rest.mathPortrait;
    const expectedRest = JSON.parse(
      JSON.stringify({
        scholar: SCHOLAR_NAME,
        ...redactScholarPractice(await practiceFor(t, scholarId), "parent"),
      }),
    );
    expect(rest).toEqual(expectedRest);
  });

  test.each(["scholar"] as const)(
    "a %s's result has no portrait and is byte-identical to before",
    async (role) => {
      const t = convexTest(schema, modules);
      const scholarId = await seedWorld(t);

      const { raw, called } = await runPracticeTool(t, role, scholarId);

      expect(JSON.parse(raw)).not.toHaveProperty("mathPortrait");
      expect(raw).toBe(
        JSON.stringify({
          scholar: SCHOLAR_NAME,
          ...redactScholarPractice(await practiceFor(t, scholarId), role),
        }),
      );
      // The portrait read never runs for these roles.
      expect(called).toEqual([
        "curriculumAssistant:listScholarsInternal",
        "curriculumAssistant:getScholarPractice",
      ]);
    },
  );
});

// TRA-322: the skill list behind "N skills fluent" goes only to the
// guardian-scoped parent aide. The quest baker and the designer tools pass an
// account's PRIMARY role, which can be "parent" for someone who also holds a
// teacher membership, alongside a staff roster; that path must not get it.
describe("get_scholar_practice — the fluent-skill list is parent-aide only", () => {
  test("role parent without the parent-aide option gets no count or skill list", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedWorld(t);
    const { raw } = await runPracticeTool(t, "parent", scholarId);
    const parsed = JSON.parse(raw) as {
      mathPortrait: { domains: Array<Record<string, unknown>> };
    };
    for (const d of parsed.mathPortrait.domains) {
      expect(d).not.toHaveProperty("fluentSkills");
      expect(d).not.toHaveProperty("fluentSkillLabels");
    }
    expect(raw).not.toContain("fluentSkillLabels");
  });

  test("the designer/baker tool path with a parent primary role gets no count or skill list", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedWorld(t);
    const institutionId = await t.run(
      async (ctx) => (await ctx.db.get(scholarId))!.institutionId!,
    );
    // Primary role parent, plus a teacher membership at the scholar's school
    // (memberships.addMembership allows this).
    const ownerId = await seedStaffWithMembership(t, {
      institutionId,
      username: "parent-and-teacher",
    });
    await t.run((ctx) => ctx.db.patch(ownerId, { role: "parent" }));
    const unitId = await t.run((ctx) =>
      ctx.db.insert("units", { teacherId: ownerId, title: "A quest", isActive: true }),
    );

    const { ctx } = realCtx(t);
    const tools = (await assembleUnitDesignerTools(ctx, () => {}, {
      teacherId: ownerId,
      unitId,
      role: "parent",
    })) as Array<{ name: string; run: (input: unknown) => Promise<unknown> }>;
    const tool = tools.find((x) => x.name === "get_scholar_practice")!;
    const raw = (await tool.run({ scholarName: "kai" })) as string;

    // The scholar resolved through the staff roster (not a refusal).
    expect(raw).toContain(SCHOLAR_NAME);
    expect(raw).not.toContain("fluentSkills");
    expect(raw).not.toContain("fluentSkillLabels");
    expect(tool).not.toHaveProperty(
      "description",
      expect.stringContaining("fluentSkillLabels"),
    );
  });
});

// TRA-728: teacher/admin callers also get `mathLevel`, the overall level and
// learned pace from the same read model as the teacher's Math Skills view.
// Parents and scholars never do.
describe("get_scholar_practice — the staff mathLevel", () => {
  async function seedPaceTerm(t: TC, scholarId: Id<"users">) {
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(scholarId, { gradeLevel: "4" });
      await ctx.db.insert("reportingPeriods", {
        label: "Fall Term",
        startsAt: now - 60 * DAY,
        endsAt: now + 60 * DAY,
        status: "open",
      });
      // longdiv was missed before it turned fluent (learned); equiv was not
      // (already known).
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: "longdiv",
        correct: false,
        createdAt: now - 5 * DAY,
      });
    });
    return { termStartsAt: now - 60 * DAY };
  }

  test("a teacher's result carries mathLevel after the unchanged practice fields", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedWorld(t);
    const { termStartsAt } = await seedPaceTerm(t, scholarId);

    const { raw, called } = await runPracticeTool(t, "teacher", scholarId);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty("mathPortrait");
    expect(called).toContain("mathPortrait:getScholarMathPortrait");

    // Catalog bands: grade 1 (1 of 1), grade 3 (1 of 2), grade 5 (1 of 2).
    // This small catalog has no grade 2 or 4, and those count as passed below
    // the highest credited grade: 1 + 1 + 1 + 0.5 + 1 + 0.5 = 5.
    const gradeEquivalent = Math.round((4 + schoolYearTenths(new Date())) * 10) / 10;
    expect(parsed.mathLevel).toEqual({
      overallLevel: 5,
      enrolledGrade: "4",
      gradeEquivalent,
      // Level 5 against a fourth grader's grade equivalent depends on the month.
      position: gradeRelativeBand(levelDelta(5, gradeEquivalent)),
      solidThroughGrade: "1",
      skillsShownInDailyWork: 3,
      skillsCreditedFromPlacement: 0,
      paceThisTerm: {
        term: "Fall Term",
        // The scholar was enrolled before the term, so it starts the window.
        // In the school's time zone (the fixture school has none: the default).
        measuredFrom: dayKeyForTimezone(termStartsAt),
        // longdiv is half of grade 5: 0.5 × 10 months.
        monthsOfNewLearning: 5,
        monthsOfSchool: 2,
        timesStandardPace: 2.5,
        skillsLearned: 1,
        skillsAlreadyKnown: 1,
      },
    });

    // One read model: the same shaping over gatherMathPortrait.
    const portrait = await t.run((ctx) =>
      gatherMathPortrait(ctx.db, scholarId, { withOverall: true }),
    );
    expect(parsed.mathLevel).toEqual(staffMathLevel(portrait));

    // Everything else is the teacher's practice payload, unchanged.
    const rest = { ...parsed };
    delete rest.mathLevel;
    expect(rest).toEqual(
      JSON.parse(
        JSON.stringify({
          scholar: SCHOLAR_NAME,
          ...redactScholarPractice(await practiceFor(t, scholarId), "teacher"),
        }),
      ),
    );
  });

  test("a teacher's result omits mathLevel when nothing is credited yet", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedWorld(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("practiceMastery").collect()) {
        await ctx.db.delete(row._id);
      }
    });
    const { raw } = await runPracticeTool(t, "teacher", scholarId);
    expect(JSON.parse(raw)).not.toHaveProperty("mathLevel");
  });

  test.each(["parent", "scholar"] as const)(
    "a %s's result carries no mathLevel or overall",
    async (role) => {
      const t = convexTest(schema, modules);
      const scholarId = await seedWorld(t);
      await seedPaceTerm(t, scholarId);

      const { raw } = await runPracticeTool(t, role, scholarId, role === "parent");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("mathLevel");
      expect(raw).not.toContain("mathLevel");
      expect(raw).not.toContain("overallLevel");
      expect(raw).not.toContain("paceThisTerm");
      if (role === "parent") {
        expect(parsed.mathPortrait).not.toHaveProperty("overall");
        expect(Object.keys(parsed)[0]).toBe("mathPortrait");
      }
    },
  );
});

describe("staffMathLevel", () => {
  // Mid-November, local time: a third grader's grade equivalent is 3.4.
  const asOfMs = new Date(2026, 10, 15).getTime();
  const level = {
    value: 4.26,
    baseValue: 0,
    dailyValue: 3.0,
    placementValue: 1.26,
    dailySkills: 40,
    placementSkills: 12,
    solidThroughRank: 0,
    bands: [],
  };

  test("null when there is no overall or no credited level", () => {
    expect(staffMathLevel(undefined)).toBeNull();
    expect(staffMathLevel({ asOfMs })).toBeNull();
    expect(
      staffMathLevel({ asOfMs, overall: { level: null, enrolledGradeRank: 3, pace: null } }),
    ).toBeNull();
  });

  test("rounds to one decimal, labels kindergarten K, and keeps a null pace null", () => {
    expect(
      staffMathLevel({
        asOfMs,
        overall: {
        level,
        enrolledGradeRank: 3,
        pace: {
          learnedMonths: 1.234,
          knownMonths: 3,
          learnedSkills: 2,
          knownSkills: 9,
          schoolMonths: 0.56,
          pace: null,
          periodLabel: "Spring Term",
          periodStartsAt: 0,
          windowStartsAt: Date.UTC(2026, 10, 1, 12),
          windowStartsDay: "2026-11-01",
        },
        },
      }),
    ).toEqual({
      overallLevel: 4.3,
      enrolledGrade: "3",
      // 4.26 against the November grade equivalent 3.4 is 0.9 ahead.
      gradeEquivalent: 3.4,
      position: "ahead",
      solidThroughGrade: "K",
      skillsShownInDailyWork: 40,
      skillsCreditedFromPlacement: 12,
      paceThisTerm: {
        term: "Spring Term",
        measuredFrom: "2026-11-01",
        monthsOfNewLearning: 1.2,
        monthsOfSchool: 0.6,
        timesStandardPace: null,
        skillsLearned: 2,
        skillsAlreadyKnown: 9,
      },
    });
  });

  test("bands with the skills matrix's cut-offs against the grade equivalent", () => {
    const at = (value: number, ms = asOfMs) =>
      staffMathLevel({ asOfMs: ms, overall: { level: { ...level, value }, enrolledGradeRank: 3, pace: null } })
        ?.position;
    expect(at(2.8)).toBe("behind");
    expect(at(2.9)).toBe("onPace");
    expect(at(3.9)).toBe("onPace");
    expect(at(4.9)).toBe("ahead");
    expect(at(5)).toBe("farAhead");
    // The same level reads on pace by April, when the grade equivalent is 3.9.
    expect(at(4.3, new Date(2027, 3, 15).getTime())).toBe("onPace");
  });

  test("no enrolled grade means no position; no term means no pace", () => {
    const shaped = staffMathLevel({
      asOfMs,
      overall: {
        level: { ...level, solidThroughRank: null },
        enrolledGradeRank: null,
        pace: null,
      },
    });
    expect(shaped).toMatchObject({
      enrolledGrade: null,
      gradeEquivalent: null,
      position: null,
      solidThroughGrade: null,
      paceThisTerm: null,
    });
  });
});
