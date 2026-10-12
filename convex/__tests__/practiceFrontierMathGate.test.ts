import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// TRA-239 — the PRACTICE FRONTIER label section is math zone-awareness, so it
// must reach the tutor only in a MATH session. These tests pin the gate: the
// same scholar with the same practice history gets labels in a math unit and
// nothing (not even the DB read's result) in a non-math or unit-less session.

type T = ReturnType<typeof convexTest>;

async function seedScholarWithMathPractice(t: T) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Test scholar",
      username: "frontier_scholar",
      role: "scholar",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: "add_within_20",
      label: "Add within 20",
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: "add_within_20",
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      repetition: 2,
      halfLifeDays: 3,
      lastPracticedAt: Date.now(),
      frontier: true,
      source: "practice",
      updatedAt: Date.now(),
    });
    return scholarId;
  });
}

async function seedSession(
  t: T,
  scholarId: Id<"users">,
  unit: { mathDomain?: string; subject?: string } | null,
) {
  return await t.run(async (ctx) => {
    let unitId: Id<"units"> | undefined;
    if (unit) {
      const teacherId = await ctx.db.insert("users", {
        name: "Test teacher",
        username: `teacher_${Math.random().toString(36).slice(2, 8)}`,
        role: "teacher",
      });
      unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Test unit",
        isActive: true,
        ...unit,
      });
    }
    return await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "New Session",
      isArchived: false,
      ...(unitId ? { unitId } : {}),
    });
  });
}

describe("getSessionContext — PRACTICE FRONTIER is gated to math sessions", () => {
  test("a unit with mathDomain → labels are injected", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholarWithMathPractice(t);
    const sessionId = await seedSession(t, scholarId, {
      mathDomain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    const c = await t.query(internal.sessionHelpers.getSessionContext, { sessionId });
    expect(c?.practiceSkillsContext?.frontierLabels).toEqual(["Add within 20"]);
  });

  test("a unit whose subject is math (no mathDomain) → labels are injected", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholarWithMathPractice(t);
    const sessionId = await seedSession(t, scholarId, { subject: "Mathematics" });
    const c = await t.query(internal.sessionHelpers.getSessionContext, { sessionId });
    expect(c?.practiceSkillsContext?.frontierLabels).toEqual(["Add within 20"]);
  });

  test("a History unit → NO math labels bleed in", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholarWithMathPractice(t);
    const sessionId = await seedSession(t, scholarId, { subject: "History" });
    const c = await t.query(internal.sessionHelpers.getSessionContext, { sessionId });
    expect(c?.practiceSkillsContext).toBeNull();
  });

  test("a unit-less session → NO math labels", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholarWithMathPractice(t);
    const sessionId = await seedSession(t, scholarId, null);
    const c = await t.query(internal.sessionHelpers.getSessionContext, { sessionId });
    expect(c?.practiceSkillsContext).toBeNull();
  });
});
