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
