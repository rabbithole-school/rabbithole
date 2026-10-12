import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { assembleCurriculumTools } from "../lib/aideTools";
import { assembleUnitDesignerTools } from "../lib/unitDesignerTools";
import { buildRubricCheckUserMessage } from "../lib/rubricCheckPrompt";
import { buildScanAssessInstructions } from "../deliverableAssess";
import { buildCriteriaGenUserMessage, mintFlair } from "../deliverables";
import { buildStandaloneDeliverableSection } from "../sessionHelpers";
import { scoreRubricVerdicts } from "../lib/deliverable";
import {
  WRITING_MECHANICS_ASSESSED,
  WRITING_MECHANICS_CRITERIA_ALLOWED,
  WRITING_MECHANICS_CRITERIA_FORBIDDEN,
  WRITING_MECHANICS_NOT_ASSESSED,
  writingMechanicsPolicy,
} from "../lib/writingMechanicsPolicy";
import {
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * TRA-502: `activities.assessesWritingMechanics` is the one switch that tells
 * every assessor an activity is about spelling/typing. Unset = the default
 * (dictation earns full credit; mechanics never move a verdict).
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

async function seedTeacher(t: T) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Test teacher",
      username: "mechanics-teacher",
      role: "teacher",
    }),
  );
}

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedLesson(t: T, teacherId: Id<"users">) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Words in the wild",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Spelling patterns",
      order: 0,
    });
    return { unitId, lessonId };
  });
}

function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
  } as unknown as ActionCtx;
}

async function runTool(
  tools: Array<{ name: string }>,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} was not registered`);
  return String(
    await (
      tool as unknown as {
        run: (args: Record<string, unknown>) => Promise<unknown>;
      }
    ).run(input),
  );
}

const flagOf = (t: T, id: Id<"activities">) =>
  t.run(async (ctx) => (await ctx.db.get(id))?.assessesWritingMechanics === true);

describe("activities.assessesWritingMechanics", () => {
  test("update sets it, and false clears it back to unset", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Silent letters",
      kind: "offline",
    });
    expect(await flagOf(t, id)).toBe(false);

    await asTeacher.mutation(api.activities.update, {
      id,
      assessesWritingMechanics: true,
    });
    expect(await flagOf(t, id)).toBe(true);

    await asTeacher.mutation(api.activities.update, {
      id,
      assessesWritingMechanics: false,
    });
    const cleared = await t.run((ctx) => ctx.db.get(id));
    expect(cleared?.assessesWritingMechanics).toBeUndefined();
    expect("assessesWritingMechanics" in (cleared ?? {})).toBe(false);
  });

  test("an unrelated update leaves the flag alone", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Silent letters",
      kind: "offline",
    });
    await asTeacher.mutation(api.activities.update, {
      id,
      assessesWritingMechanics: true,
    });
    await asTeacher.mutation(api.activities.update, {
      id,
      title: "Silent letters, round two",
    });
    expect(await flagOf(t, id)).toBe(true);
  });

  test("activities.create and createInternal can set it on an offline (paper) activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const viaCreate = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Paper spelling test",
      kind: "offline",
      assessesWritingMechanics: true,
    });
    expect(await flagOf(t, viaCreate)).toBe(true);

    const viaInternal = await t.mutation(internal.activities.createInternal, {
      lessonId,
      title: "Paper spelling test two",
      kind: "offline",
      assessesWritingMechanics: true,
    });
    expect(await flagOf(t, viaInternal)).toBe(true);
  });

  test("upsertInternal creates with the flag and a retry can clear it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);

    const created = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Typing warm-up" },
      title: "Typing warm-up",
      kind: "offline",
      assessesWritingMechanics: true,
    });
    expect(await flagOf(t, created.activityId)).toBe(true);

    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Typing warm-up" },
      title: "Typing warm-up",
      kind: "offline",
      assessesWritingMechanics: false,
    });
    expect(await flagOf(t, created.activityId)).toBe(false);
  });

  test("duplicating an activity carries the flag", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Silent letters",
      kind: "offline",
      assessesWritingMechanics: true,
    });
    const copy = await asTeacher.mutation(api.activities.duplicate, {
      activityId: id,
    });
    const copyId =
      typeof copy === "string" ? copy : (copy as { activityId: string }).activityId;
    expect(await flagOf(t, copyId as Id<"activities">)).toBe(true);
  });

  test("the unit designer's create_activity and update_activity write it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { unitId } = await seedLesson(t, teacherId);
    const tools = (await assembleUnitDesignerTools(actionCtxFor(t), () => {}, {
      teacherId,
      unitId,
      role: "teacher",
    })) as Array<{ name: string }>;

    await runTool(tools, "create_activity", {
      lessonTitle: "Spelling patterns",
      title: "Spelling bee",
      kind: "offline",
      assessesWritingMechanics: true,
    });
    await runTool(tools, "create_activity", {
      lessonTitle: "Spelling patterns",
      title: "Field journal",
      kind: "offline",
    });
    const byTitle = async (title: string) =>
      await t.run(async (ctx) =>
        (await ctx.db.query("activities").collect()).find(
          (row) => row.title === title,
        ),
      );
    expect((await byTitle("Spelling bee"))?.assessesWritingMechanics).toBe(true);
    expect((await byTitle("Field journal"))?.assessesWritingMechanics)
      .toBeUndefined();

    await runTool(tools, "update_activity", {
      lessonTitle: "Spelling patterns",
      activityTitle: "Spelling bee",
      assessesWritingMechanics: false,
    });
    expect((await byTitle("Spelling bee"))?.assessesWritingMechanics)
      .toBeUndefined();
  });

  test("the staff aide's create_scholar_activity writes it", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      name: "Voyager Academy",
      slug: "voyager-mechanics",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Lehua Torres",
      username: "lehua-mechanics",
    });
    const { lessonId } = await seedLesson(t, teacherId);
    const tools = (await assembleCurriculumTools(actionCtxFor(t), vi.fn(), {
      role: "teacher",
      callerUserId: teacherId,
      surface: "private",
      allowedScholarIds: new Set(),
      scholarLensResolved: true,
    })) as Array<{ name: string }>;

    await runTool(tools, "create_scholar_activity", {
      lessonId,
      title: "Paper spelling test",
      kind: "offline",
      assessesWritingMechanics: true,
    });
    const row = await t.run(async (ctx) =>
      (await ctx.db.query("activities").collect()).find(
        (a) => a.title === "Paper spelling test",
      ),
    );
    expect(row?.assessesWritingMechanics).toBe(true);
  });
});

describe("the policy reaches every assessor", () => {
  const criteria = [{ id: "c1", label: "Specifics", description: "Names one thing" }];

  test("Check-my-work judge", () => {
    const base = {
      activityTitle: "Field journal",
      deliverablePrompt: "Write about what you saw.",
      criteria,
      submissionText: "i saw a gecko on the wall",
    };
    const unflagged = buildRubricCheckUserMessage(base);
    const flagged = buildRubricCheckUserMessage({
      ...base,
      assessesWritingMechanics: true,
    });
    expect(unflagged).toContain(WRITING_MECHANICS_NOT_ASSESSED);
    expect(unflagged).not.toContain(WRITING_MECHANICS_ASSESSED);
    expect(flagged).toContain(WRITING_MECHANICS_ASSESSED);
    expect(flagged).not.toContain(WRITING_MECHANICS_NOT_ASSESSED);
  });

  test("scan/photo assessor", () => {
    const activity = {
      title: "Paper spelling test",
      deliverable: { prompt: "Spell the words." },
    };
    const unflagged = buildScanAssessInstructions({ activity, criteria });
    const flagged = buildScanAssessInstructions({
      activity: { ...activity, assessesWritingMechanics: true },
      criteria,
    });
    expect(unflagged).toContain(WRITING_MECHANICS_NOT_ASSESSED);
    expect(flagged).toContain(WRITING_MECHANICS_ASSESSED);
    expect(flagged).not.toContain(WRITING_MECHANICS_NOT_ASSESSED);
  });

  test("tutor rubric section", () => {
    const ctx = {
      activityTitle: "Field journal",
      prompt: "Write about what you saw.",
      rubric: "[c1] Specifics",
      kind: "text" as const,
      isComplete: false,
    };
    expect(buildStandaloneDeliverableSection(ctx)).toContain(
      WRITING_MECHANICS_NOT_ASSESSED,
    );
    expect(
      buildStandaloneDeliverableSection({ ...ctx, assessesWritingMechanics: true }),
    ).toContain(WRITING_MECHANICS_ASSESSED);
  });

  test("criteria generator", () => {
    const bundle = {
      activityTitle: "Field journal",
      activityDescription: null,
      deliverablePrompt: "Write about what you saw.",
      teacherNotes: null,
      readingLevel: "3",
      unitTitle: null,
      lessonTitle: null,
      angleTitle: null,
      angleDescription: null,
      assessesWritingMechanics: false,
    };
    expect(buildCriteriaGenUserMessage(bundle)).toContain(
      WRITING_MECHANICS_CRITERIA_FORBIDDEN,
    );
    expect(
      buildCriteriaGenUserMessage({ ...bundle, assessesWritingMechanics: true }),
    ).toContain(WRITING_MECHANICS_CRITERIA_ALLOWED);
  });

  test("unset, null and false all select the default block", () => {
    for (const unflagged of [undefined, null, false]) {
      expect(writingMechanicsPolicy(unflagged)).toBe(
        WRITING_MECHANICS_NOT_ASSESSED,
      );
    }
  });
});

describe("a waived verdict mints no flair", () => {
  const criteria = [
    { id: "idea", label: "The idea" },
    { id: "mech", label: "Mechanics" },
  ];

  test("scoreRubricVerdicts keeps level full, passes, and earns no star for a waived one", () => {
    const scored = scoreRubricVerdicts(criteria, [
      { criterionId: "idea", level: "full", note: "Clear reason." },
      { criterionId: "mech", level: "full", note: "Not assessed.", waived: true },
    ]);
    expect(scored.verdicts.find((v) => v.criterionId === "mech")).toMatchObject({
      level: "full",
      waived: true,
    });
    expect(scored.overall).toBe("full");
    expect(scored.passed).toBe(true);
    expect(scored.earned).toBe(1);
    expect(scored.total).toBe(2);
  });

  test("waived is dropped from a level that is not full", () => {
    const scored = scoreRubricVerdicts(criteria, [
      { criterionId: "idea", level: "half", waived: true },
      { criterionId: "mech", level: "full" },
    ]);
    expect(scored.verdicts.some((v) => v.waived)).toBe(false);
  });

  test("mintFlair skips a waived full and still mints a non-waived full", () => {
    const { flairEarned, newlyEarnedIds } = mintFlair(
      undefined,
      [
        { criterionId: "idea", level: "full", note: "Clear reason." },
        { criterionId: "mech", level: "full", waived: true },
      ],
      1000,
    );
    expect(newlyEarnedIds).toEqual(["idea"]);
    expect(flairEarned.map((f) => f.criterionId)).toEqual(["idea"]);
  });
});
