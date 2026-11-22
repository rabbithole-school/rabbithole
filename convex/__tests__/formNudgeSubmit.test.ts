/**
 * The "right value, not yet in the form asked" nudge, end to end through
 * `practiceSkills.submitAnswer`: a nudge returns `formNudge`, writes NO attempt
 * row and NO mastery row, and after `FORM_NUDGE_CAP` nudges the next submission
 * is graded (and recorded) as an ordinary miss.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FORM_NUDGE_CAP, formatAnswer } from "../lib/practice/answers";
import { makeItemId } from "../lib/practice/session";
import { generateItem } from "../lib/practice/templates";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const SKILL = "roots_simplify_radicals";
const SEED = 7;

async function setup() {
  const t = convexTest(schema, modules);
  const scholarId = await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: SKILL,
      label: "Simplify integer-index roots",
      domain: "algebra-1",
      strand: "exponents-exponential",
      source: "practice",
    });
    return ctx.db.insert("users", { name: "Form Scholar", username: "form-scholar", role: "scholar" });
  });
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: scholarId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  const asScholar = t.withIdentity({
    subject: `${scholarId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
  return { t, scholarId, asScholar };
}

async function rows(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return t.run(async (ctx) => ({
    attempts: await ctx.db
      .query("practiceAttempts")
      .filter((q) => q.eq(q.field("scholarId"), scholarId))
      .collect(),
    mastery: await ctx.db
      .query("practiceMastery")
      .filter((q) => q.and(q.eq(q.field("scholarId"), scholarId), q.eq(q.field("skillKey"), SKILL)))
      .collect(),
    errors: await ctx.db
      .query("practiceErrorEvents")
      .filter((q) => q.eq(q.field("scholarId"), scholarId))
      .collect(),
  }));
}

describe("submitAnswer form nudge", () => {
  const item = generateItem(SKILL, SEED)!;
  const itemId = makeItemId(SKILL, SEED);
  const dodge = item.stem.match(/Simplify (\S+)\./)![1];

  test("a nudge records nothing; after the cap the miss is recorded", async () => {
    const { t, scholarId, asScholar } = await setup();

    for (let used = 0; used < FORM_NUDGE_CAP; used++) {
      const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId,
        itemId,
        answer: dodge,
        formNudgesUsed: used,
      });
      expect(res.correct).toBe(false);
      expect(res.formNudge?.form).toBe("simplifiedRadical");
      expect(res.formNudge?.message).toMatch(/simplify the radical/);
      expect(res.attemptId).toBeUndefined();
      expect(res.correctAnswer).toBeUndefined();
      const after = await rows(t, scholarId);
      expect(after.attempts).toHaveLength(0);
      expect(after.mastery).toHaveLength(0);
      expect(after.errors).toHaveLength(0);
    }

    const graded = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: dodge,
      formNudgesUsed: FORM_NUDGE_CAP,
    });
    expect(graded.formNudge).toBeUndefined();
    expect(graded.correct).toBe(false);
    expect(graded.formOutcome).toBeUndefined();
    const after = await rows(t, scholarId);
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0].correct).toBe(false);
  });

  test("the asked-for form is credited normally", async () => {
    const { t, scholarId, asScholar } = await setup();
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: formatAnswer(item.answer),
      formNudgesUsed: 1,
    });
    expect(res.correct).toBe(true);
    expect(res.formNudge).toBeUndefined();
    expect((await rows(t, scholarId)).attempts).toHaveLength(1);
  });

  test("an installed client that sends no count is graded exactly as before (no nudge)", async () => {
    // An old build doesn't know `formNudge`: it would show a nudge as a miss
    // and move on while nothing was recorded. So no count = no nudge.
    const { t, scholarId, asScholar } = await setup();
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: dodge,
    });
    expect(res.formNudge).toBeUndefined();
    expect(res.correct).toBe(false);
    expect((await rows(t, scholarId)).attempts).toHaveLength(1);
  });
});
