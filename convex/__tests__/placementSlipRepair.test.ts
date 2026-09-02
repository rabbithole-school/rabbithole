/**
 * The one-off repair for runs a SLIP finalized under the OLD rule
 * (`practiceSkills.reopenSlipCappedPlacement`).
 *
 * Before "confirm before you cap", one typed miss lowered a strand's ceiling
 * permanently and the run converged AT the slipped skill. The fix changed the
 * SEARCH, not the stored rows — a converged row still reads `status: "complete"`,
 * which `domainMapStatus` treats as "mapped", so the check-in never revisits it.
 * This mutation re-opens exactly those rows so the normal check-in can serve the
 * confirm the new rule says is due. It grants NO credit.
 *
 * Locks the two properties that make it safe to run against production:
 *   • dry-run by default — it reports the plan and writes nothing;
 *   • it re-opens ONLY rows where the live engine would actually serve a confirm,
 *     so a cleanly-converged run is never disturbed.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { strandOrders } from "../lib/practice/placement";

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

const WHOLE = "whole-number-arithmetic";
type Tester = ReturnType<typeof convexTest>;

async function seedScholar(t: Tester) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "slip", username: "slip", role: "scholar" }),
  );
}

/** The first two nodes of some seeded whole-number strand, in topological order. */
async function firstStrand(t: Tester) {
  return await t.run(async (ctx) => {
    const nodes = (await ctx.db.query("knowledgeNodes").collect()).filter(
      (n) => n.domain === WHOLE,
    );
    const edges = await ctx.db.query("knowledgeNodeEdges").collect();
    const order = strandOrders(nodes, edges).find((o) => o.orderedKeys.length >= 3)!;
    return { strand: order.strand, keys: order.orderedKeys };
  });
}

/** A run finalized the OLD way: converged, with ONE unconfirmed miss capping it. */
async function seedSlipCappedRun(
  t: Tester,
  scholarId: Id<"users">,
  strand: string,
  nodeKey: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("practicePlacements", {
      scholarId,
      domain: WHOLE,
      status: "complete",
      probesAnswered: 1,
      probeLog: [{ nodeKey, strand, outcome: "incorrect", at: Date.now() }],
      servedProbe: { nodeKey, strand, itemId: `${nodeKey}#1`, seed: 1 },
      updatedAt: Date.now(),
    }),
  );
}

describe("reopenSlipCappedPlacement", () => {
  test("dry run reports the confirm and writes NOTHING", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t);
    const { strand, keys } = await firstStrand(t);
    const rowId = await seedSlipCappedRun(t, scholarId, strand, keys[1]);

    const res = await t.mutation(internal.practiceSkills.reopenSlipCappedPlacement, {
      scholarId,
    });

    expect(res.applied).toBe(false);
    expect(res.confirmProbes).toBeGreaterThan(0);
    expect(res.domains.map((d) => d.domain)).toContain(WHOLE);
    // the row is untouched
    const after = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(after?.status).toBe("complete");
    expect(after?.servedProbe).toBeTruthy();
  });

  test("apply re-opens the run and clears the stale served probe", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t);
    const { strand, keys } = await firstStrand(t);
    const rowId = await seedSlipCappedRun(t, scholarId, strand, keys[1]);

    const res = await t.mutation(internal.practiceSkills.reopenSlipCappedPlacement, {
      scholarId,
      apply: true,
    });
    expect(res.applied).toBe(true);

    const after = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(after?.status).toBe("in_progress");
    expect(after?.servedProbe).toBeUndefined();
    // credit is never granted by the repair
    const mastery = await t.run(async (ctx) =>
      ctx.db.query("practiceMastery").collect(),
    );
    expect(mastery).toHaveLength(0);
  });

  test("a domain with NOTHING locked above is skipped, even with a real pending confirm", async () => {
    // The production dry run surfaced exactly this: a genuine unconfirmed slip in
    // a domain the scholar was already 87/87 credited in. Re-opening there can
    // only cost — no ground to win back, and a second miss would cap a strand
    // that is currently complete. The repair must give ground back, never take it.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t);
    const { strand, keys } = await firstStrand(t);
    const rowId = await seedSlipCappedRun(t, scholarId, strand, keys[1]);

    // credit EVERY node in the domain — nothing is locked above the slip
    await t.run(async (ctx) => {
      const nodes = (await ctx.db.query("knowledgeNodes").collect()).filter(
        (n) => n.domain === WHOLE,
      );
      for (const n of nodes) {
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey: n.nodeKey,
          domain: WHOLE,
          repetition: 3,
          halfLifeDays: 4,
          frontier: false,
          source: "placement",
          updatedAt: Date.now(),
        });
      }
    });

    const res = await t.mutation(internal.practiceSkills.reopenSlipCappedPlacement, {
      scholarId,
      apply: true,
    });

    expect(res.domains).toHaveLength(0);
    expect(res.skipped.map((s) => s.domain)).toContain(WHOLE);
    expect(await t.run(async (ctx) => (await ctx.db.get(rowId))?.status)).toBe("complete");
  });

  test("a cleanly-converged run is left alone", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t);
    const { strand, keys } = await firstStrand(t);
    // every probe answered CORRECTLY — no pending confirm anywhere
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("practicePlacements", {
        scholarId,
        domain: WHOLE,
        status: "complete",
        probesAnswered: keys.length,
        probeLog: keys.map((nodeKey) => ({
          nodeKey,
          strand,
          outcome: "correct",
          at: Date.now(),
        })),
        updatedAt: Date.now(),
      }),
    );

    const res = await t.mutation(internal.practiceSkills.reopenSlipCappedPlacement, {
      scholarId,
      apply: true,
    });

    expect(res.domains).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.get(rowId))?.status)).toBe("complete");
  });
});
