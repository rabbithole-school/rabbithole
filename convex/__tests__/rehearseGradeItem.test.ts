/**
 * `rehearseGradeItem` — the teacher-gated, read-only answer oracle behind the
 * Content-view "Rehearse" preview. It hands the full `ServableItem` (verifier
 * included) to the client, which grades with the shared `gradeSubmission` under
 * REHEARSE_POLICY. These tests pin its two contracts:
 *   • it REFUSES a dialogue item exactly as `submitAnswer` does (a dialogue has
 *     no typed answer — `buildStoredServable` casts "dialogue" to an AnswerType,
 *     so returning it would make the client silently grade it as an expression);
 *   • it is teacher-gated (a scholar cannot reach it), and it returns a normal
 *     stored item's verifier for a teacher.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const SKILL_KEY = "rehearse_oracle_skill";

async function seedUser(t: ReturnType<typeof convexTest>, role: "teacher" | "scholar") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `${role} user`, username: `${role}-u`, role }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedNode(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: SKILL_KEY,
      label: "Rehearse oracle skill",
      domain: DOMAIN,
      strand: "add-subtract",
      source: "practice",
    });
  });
}

async function seedStoredItem(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: SKILL_KEY,
      domain: DOMAIN,
      stem: "7 + 5 = ?",
      answerType: "integer",
      answerCanonical: "12",
      source: "authored",
      verifiedAt: Date.now(),
    }),
  );
}

async function seedDialogueItem(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: SKILL_KEY,
      domain: DOMAIN,
      stem: "Explain why the trick works.",
      answerType: "dialogue",
      answerCanonical: "",
      verifierKind: "rubric_dialogue",
      tier: "stretch",
      bloomLevel: 5,
      rubricCriteria: ["Names the idea.", "Defends it."],
      source: "authored",
      verifiedAt: Date.now(),
    }),
  );
}

describe("rehearseGradeItem", () => {
  test("returns a normal stored item's verifier for a teacher", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t);
    const teacher = await seedUser(t, "teacher");
    const item = await seedStoredItem(t);

    const asTeacher = await asUser(t, teacher);
    const resolved = await asTeacher.query(api.practiceSkills.rehearseGradeItem, {
      itemId: `gen#${item}`,
      domain: DOMAIN,
    });

    expect(resolved.kind).toBe("stored");
    expect(resolved.prompt.answerType).toBe("integer");
    // The verifier is included (server truth) so the client can grade locally.
    expect(resolved.verifier).toMatchObject({ kind: "storedAnswer", answerCanonical: "12" });
  });

  test("REFUSES a dialogue item (parity with submitAnswer), does not return it", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t);
    const teacher = await seedUser(t, "teacher");
    const dialogue = await seedDialogueItem(t);

    const asTeacher = await asUser(t, teacher);
    await expect(
      asTeacher.query(api.practiceSkills.rehearseGradeItem, {
        itemId: `gen#${dialogue}`,
        domain: DOMAIN,
      }),
    ).rejects.toThrow(/conversation/i);
  });

  test("is teacher-gated: a scholar cannot reach it", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t);
    const scholar = await seedUser(t, "scholar");
    const item = await seedStoredItem(t);

    const asScholar = await asUser(t, scholar);
    await expect(
      asScholar.query(api.practiceSkills.rehearseGradeItem, {
        itemId: `gen#${item}`,
        domain: DOMAIN,
      }),
    ).rejects.toThrow();
  });
});
