import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Serve-path coverage for the PLACEMENT WARMTH FLOOR (ruling-placement-idk.html
 * Option F): a graded placement MISS / "I haven't learned this yet" returns a
 * warm, non-empty `revealLine` in its `graded` payload — deterministically, with
 * NO live LLM call — while a CORRECT answer carries none. The reveal stays
 * reveal-only: the graded payload never smuggles an interactive teaching step.
 */

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

async function seedUser(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `scholar ${username}`, username, role: "scholar" }),
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

describe("placement warmth floor — serve path", () => {
  test("a graded MISS returns a warm, non-empty reveal line", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "floor_miss");
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 7 };

    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    const graded = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: primed.probe!.itemId,
      answer: "-999999", // deliberately wrong
    });

    expect(graded.graded?.outcome).toBe("incorrect");
    expect(typeof graded.graded?.revealLine).toBe("string");
    expect(graded.graded!.revealLine!.trim().length).toBeGreaterThan(0);
  });

  test("an honest 'I haven't learned this yet' returns a warm reveal line", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "floor_idk");
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 11 };

    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    const graded = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: primed.probe!.itemId,
      dontKnow: true,
    });

    expect(graded.graded?.outcome).toBe("unknown");
    expect(typeof graded.graded?.revealLine).toBe("string");
    expect(graded.graded!.revealLine!.trim().length).toBeGreaterThan(0);
    // Reveal-only: the graded payload carries no interactive teaching step.
    expect(graded.graded).not.toHaveProperty("steps");
    expect(graded.graded).not.toHaveProperty("teachingStep");
    expect(graded.graded).not.toHaveProperty("workedSteps");
  });

  test("a CORRECT answer carries no reveal line (affirmation only)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "floor_correct");
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 3 };

    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    // Re-derive the served template item's correct answer to answer correctly.
    const itemId = primed.probe!.itemId;
    const { generateItem } = await import("../lib/practice/templates");
    const { parseItemId } = await import("../lib/practice/session");
    const { formatAnswerForDisplay } = await import("../lib/practice/answers");
    const parsed = parseItemId(itemId)!;
    const item = generateItem(parsed.skillKey, parsed.seed, parsed.form)!;
    const correct = formatAnswerForDisplay(item.answer, item.choices);

    const graded = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId,
      answer: correct,
    });

    expect(graded.graded?.outcome).toBe("correct");
    expect(graded.graded?.revealLine).toBeUndefined();
  });
});
