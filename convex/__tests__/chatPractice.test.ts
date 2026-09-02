import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../lib/manipulative/practiceContract";
import type { AreaPerimeterSpec } from "../../lib/manipulative/types";

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function asScholar(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** A scholar with a session, an in-flight assistant placeholder, and one
 *  frontier mastery row on a templated skill (so resolution has a candidate). */
async function setup(t: TC) {
  await t.mutation(internal.practiceSkills.seedGraph, {});
  return await t.run(async (ctx) => {
    const scholar = await ctx.db.insert("users", {
      name: "Chat Scholar",
      username: "chatscholar",
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholar,
      title: "Session",
      isArchived: false,
    });
    const assistantMsg = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "Sure — let's try one.",
      promptVersion: "prompt-v1",
      flagged: false,
    });
    await ctx.db.insert("practiceMastery", {
      scholarId: scholar,
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      skillKey: "mult_facts_7_8_9",
      strand: "mult",
      repetition: 1,
      halfLifeDays: 2,
      lastPracticedAt: Date.now() - 5 * 86_400_000,
      frontier: true,
      source: "practice",
      updatedAt: Date.now(),
    });
    return { scholar, sessionId, assistantMsg };
  });
}

async function chatPracticeRow(t: TC, sessionId: Id<"sessions">) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    return rows.find((r) => r.role === "tool" && r.chatPractice);
  });
}

const manipulativeSpec: AreaPerimeterSpec = {
  kind: "areaPerimeter",
  id: "chat-area",
  concept: "Area with fixed perimeter",
  prompt: "Fence in exactly 16 square units.",
  perimeter: 16,
  startWidth: 1,
  goal: { type: "areaEquals", value: 16 },
};

async function seedManipulative(t: TC, skillKey = "mult_facts_7_8_9") {
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey,
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      stem: manipulativeSpec.prompt,
      answerType: MANIPULATIVE_ANSWER_TYPE,
      answerCanonical: "",
      verifierKind: MANIPULATIVE_VERIFIER_KIND,
      manipulativeSpec: JSON.stringify(manipulativeSpec),
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
}

describe("chatPractice.serveChatPracticeItem", () => {
  test("serves an inline item on the resolved skill — with NO answer stored", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);

    const res = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Sure — let's try one.",
      skill: "multiplication facts for 7, 8, 9",
    });
    expect(res.ok).toBe(true);

    const row = await chatPracticeRow(t, sessionId);
    expect(row).toBeTruthy();
    const cp = row!.chatPractice!;
    expect(cp.skillKey).toBe("mult_facts_7_8_9");
    expect(cp.kind).toBe("typed");
    if (cp.kind !== "typed") throw new Error("Expected typed chat item");
    expect(cp.stem.length).toBeGreaterThan(0);
    expect(cp.itemId).toContain("mult_facts_7_8_9#");
    // ANTI-CHEAT: the stored payload has no answer field of any kind.
    expect(Object.keys(cp).sort()).toEqual([
      "answerType",
      "itemId",
      "kind",
      "skillKey",
      "skillLabel",
      "stem",
    ]);
  });

  test("serves a stored-only candidate and round-trips the typed payload", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    const scholarClient = await asScholar(t, scholar);
    const skillKey = "contextual_division";
    const itemId = await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: skillKey,
        label: "Contextual division",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "division",
        source: "practice",
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey,
        strand: "division",
        repetition: 1,
        halfLifeDays: 2,
        lastPracticedAt: Date.now(),
        frontier: true,
        source: "practice",
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("practiceItems", {
        skillKey,
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        stem: "Twenty-four markers are shared among six tables. How many per table?",
        answerType: "integer",
        answerCanonical: "4",
        verifierKind: "arithmetic",
        source: "generated",
        verifiedAt: Date.now(),
      });
    });

    const res = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Try this one.",
      skill: "contextual division",
    });
    expect(res.ok).toBe(true);

    const transcript = await scholarClient.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    const payload = transcript.messages.find((message) => message.chatPractice)
      ?.chatPractice;
    expect(payload).toEqual({
      kind: "typed",
      itemId: `gen#${itemId}`,
      skillKey,
      skillLabel: "Contextual division",
      stem: "Twenty-four markers are shared among six tables. How many per table?",
      answerType: "integer",
    });

    await t.mutation(internal.practiceSkills.storeGeneratedItems, {
      skillKey,
      replace: true,
      items: [
        {
          skillKey,
          domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
          stem: "A replacement item",
          answerType: "integer",
          answerCanonical: "1",
        },
      ],
    });
    expect(await t.run(async (ctx) => ctx.db.get(itemId))).not.toBeNull();
  });

  test("serves a fraction template with the 2-D answer shape", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        domain: "fraction-arithmetic",
        skillKey: "fraction_as_division",
        strand: "concept",
        repetition: 1,
        halfLifeDays: 2,
        lastPracticedAt: Date.now(),
        frontier: true,
        source: "practice",
        updatedAt: Date.now(),
      });
    });

    const res = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Write this division as a fraction.",
      skill: "fraction_as_division",
      domain: "fraction-arithmetic",
    });
    expect(res.ok).toBe(true);

    expect((await chatPracticeRow(t, sessionId))!.chatPractice).toMatchObject({
      kind: "typed",
      skillKey: "fraction_as_division",
      answerType: "expression",
      answerShape: "twoD",
    });
  });

  test("explicit exploration intent serves the curated manipulative payload", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    const itemId = await seedManipulative(t);

    await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Let's explore it.",
      skill: "explore a visual model of multiplication facts for 7, 8, 9",
    });
    const payload = (await chatPracticeRow(t, sessionId))!.chatPractice!;
    expect(payload).toEqual({
      kind: "manipulative",
      itemId: `gen#${itemId}`,
      skillKey: "mult_facts_7_8_9",
      skillLabel: "Multiplication facts: ×7, ×8, ×9 (fluency)",
      manipulativeSpec: JSON.stringify(manipulativeSpec),
    });
    expect(JSON.stringify(payload)).not.toContain("answerCanonical");
  });

  test("splits the stream: keeps the pre-tool bubble, opens a fresh placeholder", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);

    const res = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Sure — let's try one.",
      skill: "your 7s",
    });
    expect(res.ok && res.newMessageId).toBeTruthy();

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    // Original bubble kept (had content), tool row inserted, new placeholder opened.
    const original = rows.find((r) => r._id === assistantMsg);
    expect(original?.content).toBe("Sure — let's try one.");
    expect(
      rows.some(
        (r) =>
          r.role === "tool" &&
          r.chatPractice &&
          r.promptVersion === "prompt-v1",
      ),
    ).toBe(true);
    expect(
      rows.some(
        (r) =>
          r.role === "assistant" &&
          r.content === "" &&
          r.promptVersion === "prompt-v1",
      ),
    ).toBe(true);
  });

  test("deletes an empty pre-tool placeholder (no blank bubble left behind)", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    await t.run(async (ctx) => ctx.db.patch(assistantMsg, { content: "" }));

    await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "",
      skill: "your 7s",
    });
    const original = await t.run(async (ctx) => ctx.db.get(assistantMsg));
    expect(original).toBeNull();
  });

  test("returns ok:false when the skill can't be resolved (tutor recovers)", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);

    const res = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Sure — let's try one.",
      skill: "photosynthesis and the calvin cycle",
    });
    expect(res.ok).toBe(false);
    // No tool row inserted, placeholder untouched.
    expect(await chatPracticeRow(t, sessionId)).toBeFalsy();
    const original = await t.run(async (ctx) => ctx.db.get(assistantMsg));
    expect(original?.content).toBe("Sure — let's try one.");
  });

  test("restricts a problem-set call to its authored target skills", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);

    // The scholar's domain contains the multiplication frontier from setup, but
    // this activity authorizes only addition.
    const outsideTarget = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Let's practice.",
      skill: "multiplication facts for 7, 8, 9",
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      targetSkillKeys: ["add_2digit_regroup"],
    });
    expect(outsideTarget).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(await chatPracticeRow(t, sessionId)).toBeFalsy();

    const inTarget = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Let's practice.",
      skill: "add two-digit numbers with regrouping",
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      targetSkillKeys: ["add_2digit_regroup"],
    });
    expect(inTarget.ok).toBe(true);
    expect((await chatPracticeRow(t, sessionId))?.chatPractice?.skillKey).toBe(
      "add_2digit_regroup",
    );
  });

  test("gracefully declines an empty or stale problem-set target list", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);

    for (const targetSkillKeys of [[], ["missing_skill"]]) {
      const result = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
        sessionId,
        scholarId: scholar,
        currentMessageId: assistantMsg,
        contentSoFar: "Let's practice.",
        skill: "multiplication facts for 7, 8, 9",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        targetSkillKeys,
      });
      expect(result.ok).toBe(false);
    }
    expect(await chatPracticeRow(t, sessionId)).toBeFalsy();
  });

  test("withholds an authored problem-set item after explicit frustration", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "ugh, I am frustrated and this is dumb",
        flagged: false,
      });
    });

    const result = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Let's practice.",
      skill: "multiplication facts for 7, 8, 9",
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      targetSkillKeys: ["mult_facts_7_8_9"],
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining("support or a pause") });
    expect(await chatPracticeRow(t, sessionId)).toBeFalsy();
  });

  test("checks the latest scholar message without reading a long assistant transcript", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "I am frustrated and need a pause",
        flagged: false,
      });
      for (let index = 0; index < 40; index++) {
        await ctx.db.insert("messages", {
          sessionId,
          role: "assistant",
          content: `Prior tutor response ${index}`,
          flagged: false,
        });
      }
    });

    const result = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Let's practice.",
      skill: "multiplication facts for 7, 8, 9",
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      targetSkillKeys: ["mult_facts_7_8_9"],
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("support or a pause"),
    });
    expect(await chatPracticeRow(t, sessionId)).toBeFalsy();
  });

  test("keeps ordinary chat practice domain-wide when no activity targets are supplied", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    const result = await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Let's practice.",
      skill: "multiplication facts for 7, 8, 9",
    });
    expect(result.ok).toBe(true);
    expect((await chatPracticeRow(t, sessionId))?.chatPractice?.skillKey).toBe(
      "mult_facts_7_8_9",
    );
  });

  test("the served item grades + records mastery through submitAnswer (a chat item COUNTS)", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    const scholarClient = await asScholar(t, scholar);

    await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "x",
      skill: "multiplication facts for 7, 8, 9",
    });
    const row = await chatPracticeRow(t, sessionId);
    const itemId = row!.chatPractice!.itemId;

    // Derive the correct answer server-side (never sent to the client) to drive
    // the test, exactly as the widget's server grade would.
    const truth = gradeTemplateItem(itemId, "0")!.correctAnswer;

    // A MISS reveals nothing (anti-offloading).
    const miss = await scholarClient.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "-1",
    });
    expect(miss.correct).toBe(false);
    expect(miss.correctAnswer).toBeUndefined();

    // A CORRECT answer echoes it back and advances mastery.
    const before = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_skill", (q) =>
            q.eq("scholarId", scholar).eq("skillKey", "mult_facts_7_8_9"),
          )
          .first()
      )?.repetition,
    );
    const hit = await scholarClient.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: truth,
      record: false, // retry semantics — grade only, don't double-count the miss
    });
    expect(hit.correct).toBe(true);
    expect(hit.correctAnswer).toBe(truth);

    // A fresh correct attempt WITH recording bumps the repetition.
    const item2 = await t.run(async (ctx) => {
      await t.mutation(internal.chatPractice.serveChatPracticeItem, {
        sessionId,
        scholarId: scholar,
        currentMessageId: await ctx.db.insert("messages", {
          sessionId,
          role: "assistant",
          content: "",
          flagged: false,
        }),
        contentSoFar: "",
        skill: "your 7s",
      });
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect();
      const cps = rows.filter((r) => r.role === "tool" && r.chatPractice);
      return cps[cps.length - 1]!.chatPractice!.itemId;
    });
    const truth2 = gradeTemplateItem(item2, "0")!.correctAnswer;
    await scholarClient.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item2,
      answer: truth2,
    });
    const after = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_skill", (q) =>
            q.eq("scholarId", scholar).eq("skillKey", "mult_facts_7_8_9"),
          )
          .first()
      )?.repetition,
    );
    expect((after ?? 0)).toBeGreaterThan(before ?? 0);
  });

  test("manipulative first attempt records; a record:false retry only re-grades", async () => {
    const t = convexTest(schema, modules);
    const { scholar, sessionId, assistantMsg } = await setup(t);
    const scholarClient = await asScholar(t, scholar);
    await seedManipulative(t);

    await t.mutation(internal.chatPractice.serveChatPracticeItem, {
      sessionId,
      scholarId: scholar,
      currentMessageId: assistantMsg,
      contentSoFar: "Build it.",
      skill: "explore a visual model of multiplication facts for 7, 8, 9",
    });
    const payload = (await chatPracticeRow(t, sessionId))!.chatPractice!;
    expect(payload.kind).toBe("manipulative");

    const miss = await scholarClient.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: payload.itemId,
      answer: JSON.stringify({ width: 3 }),
    });
    expect(miss.correct).toBe(false);
    expect(miss.correctAnswer).toBeUndefined();

    const afterFirst = await t.run(async (ctx) => {
      const attempts = await ctx.db
        .query("practiceAttempts")
        .filter((q) => q.eq(q.field("scholarId"), scholar))
        .collect();
      const mastery = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholar).eq("skillKey", "mult_facts_7_8_9"),
        )
        .first();
      return { attempts: attempts.length, repetition: mastery?.repetition };
    });
    expect(afterFirst.attempts).toBe(1);

    const retry = await scholarClient.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: payload.itemId,
      answer: JSON.stringify({ width: 4 }),
      record: false,
    });
    expect(retry.correct).toBe(true);
    expect(retry.correctAnswer).toBeUndefined();

    const afterRetry = await t.run(async (ctx) => {
      const attempts = await ctx.db
        .query("practiceAttempts")
        .filter((q) => q.eq(q.field("scholarId"), scholar))
        .collect();
      const mastery = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholar).eq("skillKey", "mult_facts_7_8_9"),
        )
        .first();
      const retryRow = attempts.find((row) => row.retry === true);
      return {
        attempts: attempts.length,
        repetition: mastery?.repetition,
        retryRow,
      };
    });
    // Mastery is unchanged (the retry only re-grades)...
    expect(afterRetry.repetition).toEqual(afterFirst.repetition);
    // ...but the retry itself is now captured as a flagged diagnostic row that
    // stores the resubmitted answer, so a stuck item's later tries aren't invisible.
    expect(afterRetry.attempts).toBe(afterFirst.attempts + 1);
    expect(afterRetry.retryRow).toMatchObject({
      itemId: payload.itemId,
      correct: true,
      retry: true,
      answerText: JSON.stringify({ width: 4 }),
    });
    expect(afterRetry.retryRow?.lane).toBeUndefined();
  });
});
