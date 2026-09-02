import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { generateItem } from "../lib/practice/templates";
import { makeItemId } from "../lib/practice/session";
import { SCAFFOLDED_SOURCE } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const TEMPLATE_SKILL = "add_multidigit_algorithm";
const TEMPLATE_ITEM_ID = makeItemId(TEMPLATE_SKILL, 12345);

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Lehua Torres",
      username: "lehua_hint_ladder",
      role: "scholar",
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

function templateAnswer(): string {
  const item = generateItem(TEMPLATE_SKILL, 12345);
  if (!item || item.answer.type !== "integer") {
    throw new Error("expected integer template fixture");
  }
  return String(item.answer.value);
}

async function masterySource(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const row = (await ctx.db.query("practiceMastery").collect()).find(
      (candidate) =>
        candidate.scholarId === scholarId &&
        candidate.skillKey === TEMPLATE_SKILL,
    );
    return row?.source;
  });
}

describe("serveHintStep anti-leak contract", () => {
  test("serves one intermediate rung at a time, writes the marker, and withholds the final step and answer", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const scholar = await withUser(t, scholarId);
    const itemId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("practiceItems", {
        skillKey: "hint_ladder_fixture",
        domain: DOMAIN,
        stem: "Add 40 + 2.",
        answerType: "integer",
        answerCanonical: "42",
        verifierKind: "arithmetic",
        workedSteps: [
          { text: "Split 40 into tens: 4 × 10 = 40.", blankText: "Count the tens: ?" },
          { text: "Keep the extra ones beside the tens.", blankText: "Keep the ones beside it." },
          { text: "Combine the tens and ones: 40 + 2 = 42.", blankText: "Combine them: ?" },
        ],
        source: "generated",
        verifiedAt: Date.now(),
      });
      return `gen#${id}`;
    });

    const first = await scholar.mutation(api.practiceSkills.serveHintStep, {
      scholarId,
      itemId,
      stepIndex: 0,
    });
    expect(first).toMatchObject({
      rung: { kind: "completion", stepIndex: 0, expected: "40" },
      hasMore: true,
      stepCount: 2,
    });
    expect(first).not.toHaveProperty("answer");
    expect(first).not.toHaveProperty("answerCanonical");
    expect(JSON.stringify(first)).not.toContain("Combine the tens and ones");
    expect(JSON.stringify(first)).not.toContain('"42"');

    const markers = await t.run(async (ctx) =>
      ctx.db.query("practiceHintReveals").collect(),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      scholarId,
      itemId,
      maxStepServed: 0,
    });

    const second = await scholar.mutation(api.practiceSkills.serveHintStep, {
      scholarId,
      itemId,
      stepIndex: 1,
    });
    expect(second).toEqual({
      rung: {
        kind: "reveal",
        stepIndex: 1,
        text: "Keep the extra ones beside the tens.",
      },
      hasMore: false,
      stepCount: 2,
    });
    expect(JSON.stringify(second)).not.toContain("40 + 2 = 42");
  });

  test("items with fewer than two worked steps have no step tier and write no marker", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const scholar = await withUser(t, scholarId);
    const itemId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("practiceItems", {
        skillKey: "atomic_hint_fixture",
        domain: DOMAIN,
        stem: "What is 2 + 2?",
        answerType: "integer",
        answerCanonical: "4",
        verifierKind: "arithmetic",
        workedSteps: [{ text: "Add: 2 + 2 = 4.", blankText: "Add: ?" }],
        source: "generated",
        verifiedAt: Date.now(),
      });
      return `gen#${id}`;
    });

    expect(
      await scholar.mutation(api.practiceSkills.serveHintStep, {
        scholarId,
        itemId,
        stepIndex: 0,
      }),
    ).toEqual({ rung: null, hasMore: false, stepCount: 0 });
    expect(
      await t.run(async (ctx) => ctx.db.query("practiceHintReveals").collect()),
    ).toHaveLength(0);
  });

  test("resumes ordered rungs after the assistance window and refreshes the marker", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const scholar = await withUser(t, scholarId);
    const itemId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("practiceItems", {
        skillKey: "resumable_hint_fixture",
        domain: DOMAIN,
        stem: "Combine three place-value parts.",
        answerType: "integer",
        answerCanonical: "123",
        verifierKind: "arithmetic",
        workedSteps: [
          { text: "Start with the hundred: 1 × 100 = 100.", blankText: "Find the hundreds: ?" },
          { text: "Add the tens beside it.", blankText: "Add the tens." },
          { text: "Finish with the ones: 120 + 3 = 123.", blankText: "Add the ones: ?" },
        ],
        source: "generated",
        verifiedAt: Date.now(),
      });
      return `gen#${id}`;
    });
    await t.run(async (ctx) =>
      ctx.db.insert("practiceHintReveals", {
        scholarId,
        itemId,
        maxStepServed: 0,
        createdAt: Date.now() - 15 * 60 * 1000 - 1,
      }),
    );

    const resumed = await scholar.mutation(api.practiceSkills.serveHintStep, {
      scholarId,
      itemId,
      stepIndex: 1,
    });
    expect(resumed.rung).toMatchObject({ kind: "reveal", stepIndex: 1 });

    const markers = await t.run(async (ctx) =>
      ctx.db
        .query("practiceHintReveals")
        .withIndex("by_scholar_item_createdAt", (q) =>
          q.eq("scholarId", scholarId).eq("itemId", itemId),
        )
        .collect(),
    );
    expect(markers).toHaveLength(2);
    expect(markers.some((marker) => marker.maxStepServed === 1)).toBe(true);
  });
});

describe("hint marker keeps template attempts assisted", () => {
  test("a correct template answer after the first rung lands inferred", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const scholar = await withUser(t, scholarId);

    const served = await scholar.mutation(api.practiceSkills.serveHintStep, {
      scholarId,
      itemId: TEMPLATE_ITEM_ID,
      stepIndex: 0,
    });
    expect(served.rung).not.toBeNull();

    await scholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: TEMPLATE_ITEM_ID,
      answer: templateAnswer(),
      record: true,
    });

    expect(await masterySource(t, scholarId)).toBe(SCAFFOLDED_SOURCE);
  });
});
