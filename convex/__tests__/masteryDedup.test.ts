import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

// Exercise the enforce path deterministically regardless of shell env.
process.env.OBSERVER_DEDUP_MODE = "enforce";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Test Scholar",
      username: "dedupscholar",
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Test",
      isArchived: false,
    });
    return { scholarId, sessionId };
  });
}

function recordArgs(
  scholarId: Id<"users">,
  sessionId: Id<"sessions">,
  conceptLabel: string,
  opts: { domain?: string; masteryLevel?: number; evidenceType?: string } = {},
) {
  return {
    scholarId,
    conceptLabel,
    domain: opts.domain ?? "Computer Science",
    sessionId,
    transcriptExcerpt: "...",
    masteryLevel: opts.masteryLevel ?? 3,
    confidenceScore: 0.8,
    evidenceSummary: "...",
    evidenceType: opts.evidenceType ?? "direct_demonstration",
    attemptContext: "conversation",
    studentInitiated: true,
  };
}

async function currentLabels(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("masteryObservations").collect();
    return rows
      .filter((r) => r.scholarId === scholarId && !r.isSuperseded)
      .map((r) => r.conceptLabel)
      .sort();
  });
}

describe("masteryObservations.record — write-path dedup backstop", () => {
  test("auto-supersedes an exact / qualifier-variant duplicate the model didn't collapse", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);

    await t.mutation(internal.masteryObservations.record, recordArgs(scholarId, sessionId, "Sensor-actuated mechanisms", { domain: "Engineering" }));
    // A qualifier-suffix variant, no supersedesObservationId (model forgot to consolidate).
    await t.mutation(internal.masteryObservations.record, recordArgs(scholarId, sessionId, "Sensor-actuated mechanisms (Engineering)", { domain: "Engineering" }));

    // Only the newest survives as current.
    expect(await currentLabels(t, scholarId)).toEqual(["Sensor-actuated mechanisms (Engineering)"]);
    // The old one is flagged auto-superseded (auditable), not deleted.
    const audited = await t.run(async (ctx) => {
      const all = await ctx.db.query("masteryObservations").collect();
      return all.filter((o) => o.autoSuperseded === true).map((o) => o.conceptLabel);
    });
    expect(audited).toEqual(["Sensor-actuated mechanisms"]);
  });

  test("does NOT merge two labels each carrying a distinguishing word (conservative — averts the fraction false-merge)", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);

    await t.mutation(internal.masteryObservations.record, recordArgs(scholarId, sessionId, "Addition of fractions with like denominators", { domain: "Mathematics" }));
    await t.mutation(internal.masteryObservations.record, recordArgs(scholarId, sessionId, "Subtraction of fractions with like denominators", { domain: "Mathematics" }));

    expect(await currentLabels(t, scholarId)).toEqual([
      "Addition of fractions with like denominators",
      "Subtraction of fractions with like denominators",
    ]);
  });

  test("keeps genuinely distinct concepts in the same domain", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);

    await t.mutation(internal.masteryObservations.record, recordArgs(scholarId, sessionId, "Area of rectangles", { domain: "Mathematics" }));
    await t.mutation(internal.masteryObservations.record, recordArgs(scholarId, sessionId, "Area of triangles", { domain: "Mathematics" }));

    expect(await currentLabels(t, scholarId)).toEqual(["Area of rectangles", "Area of triangles"]);
  });

  test("does not merge identical labels across different domains", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);

    await t.mutation(internal.masteryObservations.record, recordArgs(scholarId, sessionId, "Iterative design refinement under constraints", { domain: "Engineering" }));
    await t.mutation(internal.masteryObservations.record, recordArgs(scholarId, sessionId, "Iterative design refinement under constraints", { domain: "Game Design" }));

    expect((await currentLabels(t, scholarId)).length).toBe(2);
  });

  test("never auto-merges misconceptions (own lifecycle), even exact duplicates", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);

    await t.mutation(
      internal.masteryObservations.record,
      recordArgs(scholarId, sessionId, "Heavier objects fall faster", { evidenceType: "misconception_signal", masteryLevel: 1 }),
    );
    await t.mutation(
      internal.masteryObservations.record,
      recordArgs(scholarId, sessionId, "Heavier objects fall faster", { evidenceType: "misconception_signal", masteryLevel: 1 }),
    );

    // Both misconceptions remain — they are not collapsed by the net.
    expect((await currentLabels(t, scholarId)).length).toBe(2);
  });
});

describe("masteryObservations.record — model-supplied supersedesObservationId", () => {
  test("an id from another table is ignored instead of failing the insert", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);

    // The observer hallucinated a session id where an observation id belongs.
    const newId = await t.mutation(internal.masteryObservations.record, {
      ...recordArgs(scholarId, sessionId, "Recursion", { domain: "Computer Science" }),
      supersedesObservationId: sessionId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(newId));
    expect(row?.supersedesId).toBeUndefined();
    expect(row?.isSuperseded).toBe(false);
  });

  test("a malformed id is ignored", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);

    const newId = await t.mutation(internal.masteryObservations.record, {
      ...recordArgs(scholarId, sessionId, "Recursion", { domain: "Computer Science" }),
      supersedesObservationId: "not-an-id",
    });

    expect((await t.run(async (ctx) => ctx.db.get(newId)))?.supersedesId).toBeUndefined();
  });

  test("another scholar's observation is neither superseded nor linked", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);
    const otherScholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Other Scholar", username: "otherscholar", role: "scholar" }),
    );
    const othersId = await t.mutation(
      internal.masteryObservations.record,
      recordArgs(otherScholarId, sessionId, "Fractions", { domain: "Mathematics" }),
    );

    const newId = await t.mutation(internal.masteryObservations.record, {
      ...recordArgs(scholarId, sessionId, "Recursion", { domain: "Computer Science" }),
      supersedesObservationId: othersId,
    });

    const [others, mine] = await t.run(async (ctx) => [await ctx.db.get(othersId), await ctx.db.get(newId)]);
    expect(others?.isSuperseded).toBe(false);
    expect(mine?.supersedesId).toBeUndefined();
  });

  test("a valid id for the same scholar still supersedes and links", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seed(t);
    const oldId = await t.mutation(
      internal.masteryObservations.record,
      recordArgs(scholarId, sessionId, "Loops", { domain: "Computer Science" }),
    );

    const newId = await t.mutation(internal.masteryObservations.record, {
      ...recordArgs(scholarId, sessionId, "Iteration with loops", { domain: "Computer Science" }),
      supersedesObservationId: oldId,
    });

    const [old, fresh] = await t.run(async (ctx) => [await ctx.db.get(oldId), await ctx.db.get(newId)]);
    expect(old?.isSuperseded).toBe(true);
    expect(fresh?.supersedesId).toBe(oldId);
  });
});
