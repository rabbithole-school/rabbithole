import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { makeMathPlanTools } from "../mathPlanTools";
import type { Role } from "../roles";
import { ALGEBRA_1_DOMAIN } from "../../seed/algebra1Graph";
import { GEOMETRY_MEASUREMENT_DOMAIN } from "../../seed/geometryMeasurementGraph";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../../seed/wholeNumberArithmeticGraph";
import { humanizeStrand } from "../../../shared/practiceDomainLabels";
import { FLUENT_REPS } from "../practice/scheduler";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "../../__tests__/institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

type Tool = {
  run: (input: Record<string, unknown>) => Promise<string>;
};

function actionCtxFor(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (
        t as unknown as {
          query: (r: unknown, a: unknown) => Promise<unknown>;
        }
      ).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (
        t as unknown as {
          mutation: (r: unknown, a: unknown) => Promise<unknown>;
        }
      ).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function seedDomain(
  t: ReturnType<typeof convexTest>,
  domain: string,
  strand: string,
  grade: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("knowledgeNodes", {
      nodeKey: `${domain}-${strand}-${grade}`,
      label: `${humanizeStrand(strand)} ${grade}`,
      domain,
      strand,
      grade,
    }),
  );
}

async function seedTeacherAndScholar(t: ReturnType<typeof convexTest>) {
  const institutionId = await seedTestInstitution(t, {
    name: "Moli School",
    slug: `moli-${Math.random().toString(36).slice(2)}`,
  });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    name: "Lehua Torres",
    username: `lehua-${Math.random().toString(36).slice(2)}`,
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Hoku Makani",
    username: `hoku-${Math.random().toString(36).slice(2)}`,
  });
  return { institutionId, teacherId, scholarId };
}

async function toolsFor(
  t: ReturnType<typeof convexTest>,
  callerUserId: Id<"users">,
  role: Role,
  allowedScholarIds?: Set<Id<"users">>,
) {
  const tools = await makeMathPlanTools(actionCtxFor(t), () => {}, {
    callerUserId,
    role,
    allowedScholarIds,
  });
  return Object.fromEntries(
    tools.map((tool) => [tool.name, tool]),
  ) as unknown as Record<string, Tool>;
}

function parse(result: string) {
  return JSON.parse(result) as {
    practiceScope: {
      kind: "open" | "limited";
      domains?: Array<{
        domain: string;
        label: string;
        strands?: Array<{ strand: string; label: string }>;
      }>;
    };
    scopeSource: "math_plan" | "legacy_standing" | "open_default";
    checkpoint: CheckpointTarget | null;
    groupCheckpoint: CheckpointTarget | null;
    checkpointSuppressed: boolean;
    conflict: boolean;
    domains: Array<{
      domain: string;
      label: string;
      inPlan: boolean;
      strandsInPlan: Array<{ strand: string; label: string }>;
      checkIn: {
        state:
          | "not_started"
          | "in_progress"
          | "placed_without_checkin"
          | "complete";
        probesAnswered: number;
        placedThroughGrade?: string;
      };
      shownInDomainSwitcher: boolean;
    }>;
  };
}

type CheckpointTarget = {
  domain: string;
  strand?: string;
  grade: string;
};

describe("Math plan aide tools", () => {
  test("tools are absent for parent and scholar roles", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await seedTeacherAndScholar(t);
    for (const role of ["parent", "scholar"] as const) {
      const tools = await makeMathPlanTools(actionCtxFor(t), () => {}, {
        callerUserId: scholarId,
        role,
      });
      expect(tools).toHaveLength(0);
    }
  });

  test("read reports a limited plan, check-in state, labels, and plan-driven switcher visibility", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    await seedDomain(t, GEOMETRY_MEASUREMENT_DOMAIN, "measurement", "4");
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarMathPlans", {
        scholarId,
        practiceScope: {
          kind: "limited",
          domains: [
            {
              domain: ALGEBRA_1_DOMAIN,
              strands: ["expressions_equations"],
            },
            { domain: GEOMETRY_MEASUREMENT_DOMAIN },
          ],
        },
        updatedBy: teacherId,
        updatedAt: 1,
      });
      await ctx.db.insert("practicePlacements", {
        scholarId,
        domain: ALGEBRA_1_DOMAIN,
        status: "in_progress",
        probesAnswered: 1,
        probeLog: [
          {
            nodeKey: `${ALGEBRA_1_DOMAIN}-expressions_equations-8`,
            strand: "expressions_equations",
            outcome: "correct",
            at: 1,
          },
        ],
        updatedAt: 1,
      });
      await ctx.db.insert("practicePlacements", {
        scholarId,
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        status: "complete",
        probesAnswered: 2,
        probeLog: [
          {
            nodeKey: `${GEOMETRY_MEASUREMENT_DOMAIN}-measurement-4`,
            strand: "measurement",
            outcome: "correct",
            at: 1,
          },
          {
            nodeKey: `${GEOMETRY_MEASUREMENT_DOMAIN}-measurement-4`,
            strand: "measurement",
            outcome: "incorrect",
            at: 2,
          },
        ],
        updatedAt: 2,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: `${GEOMETRY_MEASUREMENT_DOMAIN}-measurement-4`,
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        strand: "measurement",
        repetition: FLUENT_REPS,
        halfLifeDays: 4,
        frontier: false,
        source: "placement",
        updatedAt: 2,
      });
    });

    const tools = await toolsFor(t, teacherId, "teacher");
    const result = parse(
      await tools.get_scholar_math_plan.run({ scholarName: "Hoku" }),
    );
    expect(result.practiceScope).toEqual({
      kind: "limited",
      domains: [
        {
          domain: ALGEBRA_1_DOMAIN,
          label: "Algebra 1",
          strands: [
            {
              strand: "expressions_equations",
              label: humanizeStrand("expressions_equations"),
            },
          ],
        },
        {
          domain: GEOMETRY_MEASUREMENT_DOMAIN,
          label: "Geometry & measurement",
        },
      ],
    });

    const algebra = result.domains.find(
      (domain) => domain.domain === ALGEBRA_1_DOMAIN,
    )!;
    expect(algebra).toMatchObject({
      inPlan: true,
      checkIn: { state: "in_progress", probesAnswered: 1 },
      shownInDomainSwitcher: true,
    });
    expect(algebra.strandsInPlan).toEqual([
      {
        strand: "expressions_equations",
        label: humanizeStrand("expressions_equations"),
      },
    ]);

    const geometry = result.domains.find(
      (domain) => domain.domain === GEOMETRY_MEASUREMENT_DOMAIN,
    )!;
    expect(geometry).toMatchObject({
      inPlan: true,
      checkIn: {
        state: "complete",
        probesAnswered: 2,
        placedThroughGrade: "4",
      },
      shownInDomainSwitcher: true,
    });
    expect(geometry.strandsInPlan).toEqual([
      { strand: "measurement", label: humanizeStrand("measurement") },
    ]);
  });

  test("an open plan shows only domains the scholar has started in the switcher", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    await seedDomain(t, GEOMETRY_MEASUREMENT_DOMAIN, "measurement", "4");
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarMathPlans", {
        scholarId,
        practiceScope: { kind: "open" },
        updatedBy: teacherId,
        updatedAt: 1,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: `${ALGEBRA_1_DOMAIN}-expressions_equations-8`,
        domain: ALGEBRA_1_DOMAIN,
        strand: "expressions_equations",
        repetition: 1,
        halfLifeDays: 1,
        frontier: true,
        source: "practice",
        updatedAt: 1,
      });
    });

    const tools = await toolsFor(t, teacherId, "teacher");
    const result = parse(
      await tools.get_scholar_math_plan.run({ scholarName: "Hoku Makani" }),
    );
    expect(result.practiceScope).toEqual({ kind: "open" });
    expect(
      result.domains.find((domain) => domain.domain === ALGEBRA_1_DOMAIN),
    ).toMatchObject({
      inPlan: true,
      shownInDomainSwitcher: true,
      checkIn: { state: "not_started", probesAnswered: 0 },
    });
    expect(
      result.domains.find(
        (domain) => domain.domain === GEOMETRY_MEASUREMENT_DOMAIN,
      ),
    ).toMatchObject({
      inPlan: true,
      shownInDomainSwitcher: false,
      checkIn: { state: "not_started", probesAnswered: 0 },
    });
  });

  test("an open default does not claim the legacy-governed switcher shows started domains", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: `${ALGEBRA_1_DOMAIN}-expressions_equations-8`,
        domain: ALGEBRA_1_DOMAIN,
        strand: "expressions_equations",
        repetition: 1,
        halfLifeDays: 1,
        frontier: true,
        source: "practice",
        updatedAt: 1,
      }),
    );

    const tools = await toolsFor(t, teacherId, "teacher");
    const result = parse(
      await tools.get_scholar_math_plan.run({ scholarName: "Hoku Makani" }),
    );
    expect(result.scopeSource).toBe("open_default");
    expect(
      result.domains.find((domain) => domain.domain === ALGEBRA_1_DOMAIN),
    ).toMatchObject({
      inPlan: true,
      shownInDomainSwitcher: false,
    });
  });

  test("legacy standing switcher domains come from the same active-standing projection as the frontends", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    await seedDomain(t, GEOMETRY_MEASUREMENT_DOMAIN, "measurement", "4");
    await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId,
        scholarIds: [scholarId],
        practiceMode: "standing",
        practiceConfig: {
          domain: ALGEBRA_1_DOMAIN,
          domains: [ALGEBRA_1_DOMAIN],
          excludedStrands: ["expressions_equations"],
        },
        startedAt: 1,
        activitySchedule: [],
      }),
    );

    const tools = await toolsFor(t, teacherId, "teacher");
    const result = parse(
      await tools.get_scholar_math_plan.run({ scholarName: "Hoku Makani" }),
    );
    expect(result.scopeSource).toBe("legacy_standing");
    expect(result.practiceScope).toEqual({ kind: "open" });
    expect(
      result.domains.find((domain) => domain.domain === ALGEBRA_1_DOMAIN),
    ).toMatchObject({
      shownInDomainSwitcher: true,
    });
    expect(
      result.domains.find(
        (domain) => domain.domain === GEOMETRY_MEASUREMENT_DOMAIN,
      ),
    ).toMatchObject({
      shownInDomainSwitcher: false,
    });
  });

  test("shadow placement is reported as placed without a converged check-in", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "K");
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: `${WHOLE_NUMBER_ARITHMETIC_DOMAIN}-counting-K`,
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "counting",
        repetition: FLUENT_REPS,
        halfLifeDays: 4,
        frontier: false,
        source: "placement",
        updatedAt: 1,
      }),
    );

    const tools = await toolsFor(t, teacherId, "teacher");
    const result = parse(
      await tools.get_scholar_math_plan.run({ scholarName: "Hoku Makani" }),
    );
    expect(
      result.domains.find(
        (domain) => domain.domain === WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      ),
    ).toMatchObject({
      checkIn: {
        state: "placed_without_checkin",
        probesAnswered: 0,
      },
    });
  });

  test("write re-checks the caller role and institution boundary", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    const otherInstitutionId = await seedTestInstitution(t, {
      name: "Other School",
      slug: `other-${Math.random().toString(36).slice(2)}`,
    });
    const outsideScholarId = await seedScholarInInstitution(t, {
      institutionId: otherInstitutionId,
      name: "Malia Reef",
      username: `malia-${Math.random().toString(36).slice(2)}`,
    });

    const roleMismatchTools = await toolsFor(t, scholarId, "teacher");
    await expect(
      roleMismatchTools.set_scholar_math_plan.run({
        scholarName: "Hoku Makani",
        practiceScope: { kind: "open" },
        checkpoint: null,
      }),
    ).rejects.toThrow("Forbidden");

    const teacherTools = await toolsFor(t, teacherId, "teacher");
    await expect(
      teacherTools.set_scholar_math_plan.run({
        scholarName: "Malia Reef",
        practiceScope: { kind: "open" },
        checkpoint: null,
      }),
    ).rejects.toThrow("Forbidden: scholar is not in your current context");
    expect(outsideScholarId).toBeTruthy();
  });

  test("write saves a valid full scope and returns the canonical read-back", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    await seedDomain(t, GEOMETRY_MEASUREMENT_DOMAIN, "measurement", "4");
    const tools = await toolsFor(t, teacherId, "teacher");

    const result = parse(
      await tools.set_scholar_math_plan.run({
        scholarName: "Hoku Makani",
        practiceScope: {
          kind: "limited",
          domains: [
            { domain: ALGEBRA_1_DOMAIN },
            { domain: GEOMETRY_MEASUREMENT_DOMAIN },
          ],
        },
        checkpoint: {
          domain: ALGEBRA_1_DOMAIN,
          strand: "expressions_equations",
          grade: "8",
        },
      }),
    );

    expect(result.checkpoint).toMatchObject({
      domain: ALGEBRA_1_DOMAIN,
      strand: "expressions_equations",
      grade: "8",
    });
    expect(result.conflict).toBe(false);
    expect(
      result.domains
        .filter((domain) => domain.inPlan)
        .map((domain) => domain.domain),
    ).toEqual([GEOMETRY_MEASUREMENT_DOMAIN, ALGEBRA_1_DOMAIN]);
    const stored = await t.run((ctx) =>
      ctx.db
        .query("scholarMathPlans")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .unique(),
    );
    expect(stored?.practiceScope).toEqual({
      kind: "limited",
      domains: [
        { domain: ALGEBRA_1_DOMAIN },
        { domain: GEOMETRY_MEASUREMENT_DOMAIN },
      ],
    });
  });

  test("write rejects a checkpoint outside the replacement scope", async () => {
    const t = convexTest(schema, modules);
    const { teacherId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    await seedDomain(t, GEOMETRY_MEASUREMENT_DOMAIN, "measurement", "4");
    const tools = await toolsFor(t, teacherId, "teacher");

    await expect(
      tools.set_scholar_math_plan.run({
        scholarName: "Hoku Makani",
        practiceScope: {
          kind: "limited",
          domains: [{ domain: ALGEBRA_1_DOMAIN }],
        },
        checkpoint: {
          domain: GEOMETRY_MEASUREMENT_DOMAIN,
          strand: "measurement",
          grade: "4",
        },
      }),
    ).rejects.toThrow("Checkpoint must be inside the Practice scope");
  });

  test("write replaces rather than merges the existing scope", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    await seedDomain(t, GEOMETRY_MEASUREMENT_DOMAIN, "measurement", "4");
    await t.run((ctx) =>
      ctx.db.insert("scholarMathPlans", {
        scholarId,
        practiceScope: {
          kind: "limited",
          domains: [
            { domain: ALGEBRA_1_DOMAIN },
            { domain: GEOMETRY_MEASUREMENT_DOMAIN },
          ],
        },
        updatedBy: teacherId,
        updatedAt: 1,
      }),
    );
    const tools = await toolsFor(t, teacherId, "teacher");

    const result = parse(
      await tools.set_scholar_math_plan.run({
        scholarName: "Hoku Makani",
        practiceScope: {
          kind: "limited",
          domains: [{ domain: ALGEBRA_1_DOMAIN }],
        },
        checkpoint: null,
      }),
    );
    expect(
      result.domains.find(
        (domain) => domain.domain === GEOMETRY_MEASUREMENT_DOMAIN,
      ),
    ).toMatchObject({
      inPlan: false,
      shownInDomainSwitcher: false,
    });
    const stored = await t.run((ctx) =>
      ctx.db
        .query("scholarMathPlans")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .unique(),
    );
    expect(stored?.practiceScope).toEqual({
      kind: "limited",
      domains: [{ domain: ALGEBRA_1_DOMAIN }],
    });
  });

  test("null checkpoint read-back exposes suppression of an inherited group target", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedDomain(t, ALGEBRA_1_DOMAIN, "expressions_equations", "8");
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Mathematicians",
        scholarIds: [scholarId],
      });
      await ctx.db.insert("mathGroupCheckpoint", {
        groupId,
        domain: ALGEBRA_1_DOMAIN,
        strand: "expressions_equations",
        grade: "8",
        updatedBy: teacherId,
        updatedAt: 1,
      });
    });
    const tools = await toolsFor(t, teacherId, "teacher");

    const result = parse(
      await tools.set_scholar_math_plan.run({
        scholarName: "Hoku Makani",
        practiceScope: { kind: "open" },
        checkpoint: null,
      }),
    );
    expect(result.checkpoint).toBeNull();
    expect(result.groupCheckpoint).toMatchObject({
      domain: ALGEBRA_1_DOMAIN,
      strand: "expressions_equations",
      grade: "8",
    });
    expect(result.checkpointSuppressed).toBe(true);
  });

  test("write refuses an ambiguous partial scholar name without saving", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, teacherId } = await seedTeacherAndScholar(t);
    await seedScholarInInstitution(t, {
      institutionId,
      name: "Hoku Moon",
      username: `hoku-moon-${Math.random().toString(36).slice(2)}`,
    });
    const tools = await toolsFor(t, teacherId, "teacher");

    const result = await tools.set_scholar_math_plan.run({
      scholarName: "Hoku",
      practiceScope: { kind: "open" },
      checkpoint: null,
    });
    expect(result).toContain("Ambiguous scholar");
    expect(
      await t.run((ctx) => ctx.db.query("scholarMathPlans").collect()),
    ).toHaveLength(0);
  });
});
