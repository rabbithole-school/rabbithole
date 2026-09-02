import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../lib/manipulative/practiceContract";
import type { DistributorSpec, ManipulativeSpec } from "../../lib/manipulative/types";

/**
 * U-4 — the manipulative handoff/don't-know cores accept MANIPULATIVE items.
 * Covers the testable cores (per rabbithole-test-strategy: the httpAction SSE +
 * Anthropic call aren't convex-test-drivable, so we drive the internalQuery
 * resolvers directly):
 *   • manipulativeHandoffContext resolves a gen# manipulative + submitted state
 *     → structured no-leak context (concept/prompt/task/boardState), null for a
 *     non-manipulative / unresolvable id.
 *   • submitAnswer tolerates dontKnow on a manipulative (records a dont_know
 *     miss, never reveals an answer).
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const json = (v: unknown) => JSON.stringify(v);

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `${role} ${username}`, username, role }),
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

// A COMPUTE-STYLE manipulative (17 ÷ 5 → 3 remainder 2), so the no-leak
// assertions have a real derived answer to check against.
const distributorSpec: DistributorSpec = {
  id: "manip-share-17-5",
  concept: "Division as sharing",
  prompt: "Share 17 counters onto 5 plates.",
  kind: "distributor",
  total: 17,
  groups: 5,
  goal: { type: "shareEqually" },
};

async function seedManipulativeItem(
  t: ReturnType<typeof convexTest>,
  itemSpec: ManipulativeSpec = distributorSpec,
  skillKey = "division_as_sharing",
) {
  const domain = "whole-number-arithmetic";
  const itemId = await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: skillKey,
      label: itemSpec.concept,
      domain,
      strand: "division",
      source: "practice",
    });
    return await ctx.db.insert("practiceItems", {
      skillKey,
      domain,
      stem: itemSpec.prompt,
      answerType: MANIPULATIVE_ANSWER_TYPE,
      answerCanonical: "",
      verifierKind: MANIPULATIVE_VERIFIER_KIND,
      manipulativeSpec: json(itemSpec),
      source: "generated",
      verifiedAt: Date.now(),
    });
  });
  return { itemId: `gen#${itemId}`, skillKey };
}

/** A stored (NON-manipulative) word-problem item — the resolver must reject it. */
async function seedStoredWordItem(t: ReturnType<typeof convexTest>) {
  const domain = "whole-number-arithmetic";
  const itemId = await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: "add_two_digit",
      domain,
      stem: "What is 12 + 30?",
      answerType: "integer",
      answerCanonical: "42",
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
  return `gen#${itemId}`;
}

// A wrong deal (1 per plate, leftover 12) — never the true 3-each / remainder-2.
const wrongStateJson = json({ perGroup: 1 });
const forbidden = ["3", "2"]; // the quotient + remainder must never appear
function hasToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}([^\\w]|$)`).test(text);
}

describe("manipulativeHandoffContext — the /practice-handoff resolver", () => {
  test("resolves a gen# manipulative + submitted state to no-leak context", async () => {
    const t = convexTest(schema, modules);
    const { itemId, skillKey } = await seedManipulativeItem(t);

    const ctxData = await t.run(async (ctx) =>
      ctx.runQuery(internal.practiceSkills.manipulativeHandoffContext, {
        itemId,
        stateJson: wrongStateJson,
      }),
    );
    expect(ctxData).not.toBeNull();
    if (!ctxData) throw new Error("expected context");
    expect(ctxData.concept).toBe("Division as sharing");
    expect(ctxData.skillKey).toBe(skillKey);
    expect(ctxData.task).toMatch(/17 counters onto 5 equal plates/);
    // The board description reflects the SUBMITTED (wrong) state.
    expect(ctxData.boardState).toMatch(/plates holds 1 counter/);
    expect(ctxData.boardState).toMatch(/leftover pile/);
    // Neither the task nor the board leaks the quotient/remainder.
    for (const a of forbidden) {
      expect(hasToken(ctxData.task, a), `task leaked "${a}"`).toBe(false);
      expect(hasToken(ctxData.boardState ?? "", a), `board leaked "${a}"`).toBe(false);
    }
  });

  test("omitting the state yields a null boardState (a pure don't-know)", async () => {
    const t = convexTest(schema, modules);
    const { itemId } = await seedManipulativeItem(t);
    const ctxData = await t.run(async (ctx) =>
      ctx.runQuery(internal.practiceSkills.manipulativeHandoffContext, { itemId }),
    );
    expect(ctxData?.boardState).toBeNull();
  });

  test("returns null for a non-manipulative / unresolvable id", async () => {
    const t = convexTest(schema, modules);
    const storedWord = await seedStoredWordItem(t);
    for (const itemId of ["gen#abc123", storedWord, "count_to_10#7", "garbage"]) {
      const ctxData = await t.run(async (ctx) =>
        ctx.runQuery(internal.practiceSkills.manipulativeHandoffContext, { itemId }),
      );
      expect(ctxData, `itemId=${itemId}`).toBeNull();
    }
  });
});

describe("submitAnswer — dontKnow on a manipulative item", () => {
  test("records a dont_know miss and never reveals an answer", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "mx-dk");
    const asScholar = await asUser(t, scholar);
    const { itemId, skillKey } = await seedManipulativeItem(t);

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "",
      dontKnow: true,
    });
    expect(res.correct).toBe(false);
    expect(res.correctAnswer).toBeUndefined();
    expect(res.skillKey).toBe(skillKey);

    // The attempt was recorded as an honest don't-know (a miss), not skipped.
    const attempts = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .filter((q) => q.eq(q.field("scholarId"), scholar))
        .collect(),
    );
    expect(attempts.length).toBe(1);
    expect(attempts[0].correct).toBe(false);
    expect(attempts[0].explanationReason).toBe("dont_know");

    // The item still grades normally afterward — dontKnow didn't corrupt it.
    const correct = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ perGroup: 3 }),
      record: false,
    });
    expect(correct.correct).toBe(true);
    expect(correct.correctAnswer).toBeUndefined();
  });
});
