/**
 * "Confirm before you cap" on the `· mapping` band — the surface `/scholar/practice`
 * actually serves. This is the parity twin of `checkInConfirm.test.ts` (which
 * covers the retired standalone `submitPlacementAnswer` gate): a FIRST typed miss
 * on a mapping item must NOT permanently cap the strand's ceiling. Instead
 * `submitMappingAnswer` re-serves a FRESH item on the SAME skill (the confirm)
 * and flags `retry`, so the scholar surface can offer the slip/concede choice.
 *
 * Locks the SERVER contract both frontends depend on:
 *   • a first typed miss ⇒ `retry: true` + a `retryItem` on the SAME skill, whose
 *     itemId DIFFERS from the one just missed;
 *   • a correct confirm supersedes the slip — the discovered frontier matches a
 *     clean (never-slipped) run;
 *   • a SECOND miss, an honest don't-know, and a strand with no confirm budget
 *     left all return `retry: false` (the cap paths).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { strandOrders } from "../lib/practice/placement";
import { hasTemplate } from "../lib/practice/templates";

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

type Tester = ReturnType<typeof convexTest>;

const WHOLE = "whole-number-arithmetic";

async function seedScholar(t: Tester, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar" }),
  );
}

async function asUser(t: Tester, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

type Item = { itemId: string; lane?: string; domain?: string; skillKey: string };
type Served = { items: Item[] };
type Graded = {
  outcome: string | null;
  domainJustMapped: boolean;
  retry?: boolean;
  retryItem?: { itemId: string; skillKey: string; lane?: string } | null;
};

/** Serve one recomposition and return the first WHOLE `· mapping` item. */
async function firstMappingItem(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  seed: number,
): Promise<Item> {
  const res = (await asScholar.query(api.practiceSkills.practiceSession, {
    scholarId,
    seed,
    includeMapping: true,
    domain: WHOLE,
  })) as unknown as Served;
  const item = res.items.find((it) => it.lane === "mapping" && (it.domain ?? WHOLE) === WHOLE);
  if (!item) throw new Error("no mapping item served");
  return item;
}

async function grade(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  itemId: string,
  answer: "correct" | "wrong" | "dontKnow",
  seed: number,
): Promise<Graded> {
  const extra =
    answer === "dontKnow"
      ? { answer: "", dontKnow: true }
      : {
          answer:
            answer === "correct" ? gradeTemplateItem(itemId, "0")?.correctAnswer ?? "0" : "-999999",
        };
  return (await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
    scholarId,
    domain: WHOLE,
    itemId,
    seed,
    ...extra,
  })) as unknown as Graded;
}

async function placementRow(t: Tester, scholarId: Id<"users">) {
  return await t.run(
    async (ctx) =>
      (await ctx.db.query("practicePlacements").collect()).find(
        (r) => r.scholarId === scholarId && r.domain === WHOLE,
      ) ?? null,
  );
}

/** Map WHOLE to completion answering every served mapping item correct. */
async function mapAllCorrect(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  startSeed: number,
) {
  for (let i = 0; i < 60; i++) {
    const seed = startSeed + i;
    const res = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      seed,
      includeMapping: true,
      domain: WHOLE,
    })) as unknown as Served;
    const mapping = res.items.filter((it) => it.lane === "mapping" && (it.domain ?? WHOLE) === WHOLE);
    if (mapping.length === 0) break;
    for (const it of mapping) {
      await grade(asScholar, scholarId, it.itemId, "correct", seed);
    }
  }
}

describe("mapping band — confirm before you cap (submitMappingAnswer)", () => {
  test("a first typed miss returns retry:true + a FRESH confirm item on the SAME skill", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_confirm_retry");
    const asScholar = await asUser(t, scholar);

    const first = await firstMappingItem(asScholar, scholar, 7);
    const missed = await grade(asScholar, scholar, first.itemId, "wrong", 7);

    expect(missed.outcome).toBe("incorrect");
    expect(missed.retry).toBe(true);
    expect(missed.domainJustMapped).toBe(false);
    expect(missed.retryItem).toBeTruthy();
    // A FRESH item on the SAME skill — never the identical stem just slipped on.
    expect(missed.retryItem!.skillKey).toBe(first.skillKey);
    expect(missed.retryItem!.itemId).not.toBe(first.itemId);
    expect(missed.retryItem!.lane).toBe("mapping");
  });

  test("a correct confirm supersedes the slip — frontier matches a clean run (retry:false)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});

    // Scholar A: slip the first item, confirm CORRECT, then map the rest correct.
    const slipper = await seedScholar(t, "map_confirm_slip");
    const asSlip = await asUser(t, slipper);
    const first = await firstMappingItem(asSlip, slipper, 21);
    const slippedStrand = await t.run(
      async (ctx) =>
        (await ctx.db.query("knowledgeNodes").collect()).find(
          (n) => n.domain === WHOLE && n.nodeKey === first.skillKey,
        )?.strand ?? "",
    );
    const missed = await grade(asSlip, slipper, first.itemId, "wrong", 21);
    expect(missed.retry).toBe(true);
    const confirmed = await grade(asSlip, slipper, missed.retryItem!.itemId, "correct", 21);
    expect(confirmed.outcome).toBe("correct");
    expect(confirmed.retry ?? false).toBe(false);
    await mapAllCorrect(asSlip, slipper, 22);

    // Scholar B: a clean run, never slipping.
    const clean = await seedScholar(t, "map_confirm_clean");
    const asClean = await asUser(t, clean);
    await mapAllCorrect(asClean, clean, 21);

    const slipRow = await placementRow(t, slipper);
    const cleanRow = await placementRow(t, clean);
    expect(slipRow?.status).toBe("complete");
    expect(cleanRow?.status).toBe("complete");
    // The superseded slip leaves the SLIPPED strand's discovered frontier exactly
    // where the clean run landed — a silly mistake costs nothing. (Breadth-first
    // exploration of OTHER strands legitimately differs by one probe, so this
    // pins the strand the slip actually happened on.)
    const frontierFor = (row: Doc<"practicePlacements"> | null, strand: string) =>
      (row?.frontierByStrand ?? []).find((f) => f.strand === strand)?.frontierKey ?? null;
    expect(slippedStrand).not.toBe("");
    expect(frontierFor(slipRow, slippedStrand)).toBe(frontierFor(cleanRow, slippedStrand));
  });

  test("a second miss on the node caps — retry:false", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_confirm_two_miss");
    const asScholar = await asUser(t, scholar);

    const first = await firstMappingItem(asScholar, scholar, 33);
    const m1 = await grade(asScholar, scholar, first.itemId, "wrong", 33);
    expect(m1.retry).toBe(true);
    const m2 = await grade(asScholar, scholar, m1.retryItem!.itemId, "wrong", 33);
    expect(m2.outcome).toBe("incorrect");
    expect(m2.retry ?? false).toBe(false);
    expect(m2.retryItem ?? null).toBeNull();
  });

  test("an honest don't-know is the fast path — caps immediately, retry:false", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_confirm_idk");
    const asScholar = await asUser(t, scholar);

    const first = await firstMappingItem(asScholar, scholar, 44);
    const conceded = await grade(asScholar, scholar, first.itemId, "dontKnow", 44);
    expect(conceded.outcome).toBe("unknown");
    expect(conceded.retry ?? false).toBe(false);
    expect(conceded.retryItem ?? null).toBeNull();
  });

  test("no confirm budget left ⇒ a first miss caps immediately (retry:false)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_confirm_no_budget");
    const asScholar = await asUser(t, scholar);

    // Find a strand with ≥3 template-backed nodes and pick two HIGH nodes to
    // pre-spend the strand's confirm budget (2 misses each ⇒ budget 0), plus one
    // LOW node (below the miss-bounded ceiling) that is still a fresh first miss.
    const graph = await t.run(async (ctx) => ({
      nodes: await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", WHOLE))
        .collect(),
      edges: (
        await ctx.db
          .query("knowledgeNodeEdges")
          .withIndex("by_domain", (q) => q.eq("domain", WHOLE))
          .collect()
      ).filter((e) => e.kind === "buildsOn"),
    }));
    const order = strandOrders(graph.nodes, graph.edges).find(
      (o) => o.orderedKeys.filter(hasTemplate).length >= 3,
    );
    if (!order) throw new Error("no strand with ≥3 template nodes");
    const keys = order.orderedKeys;
    const low = keys.find(hasTemplate)!;
    const highSpenders = [...keys].filter(hasTemplate).slice(-2); // two topmost
    expect(highSpenders).toHaveLength(2);
    expect(highSpenders).not.toContain(low);

    const now = Date.now();
    // Pre-spend the budget: each high node carries TWO misses (total ≥ 2).
    const spentLog = highSpenders.flatMap((nodeKey) => [
      { nodeKey, strand: order.strand, outcome: "incorrect" as const, at: now, itemId: makeItemId(nodeKey, 1) },
      { nodeKey, strand: order.strand, outcome: "incorrect" as const, at: now + 1, itemId: makeItemId(nodeKey, 2) },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: WHOLE,
        status: "in_progress",
        probesAnswered: spentLog.length,
        probeLog: spentLog,
        updatedAt: now,
      });
    });

    // A brand-new first miss on the LOW node — the strand has no confirm budget
    // left, so it caps immediately rather than offering a retry.
    const missed = await grade(asScholar, scholar, makeItemId(low, 99), "wrong", 99);
    expect(missed.outcome).toBe("incorrect");
    expect(missed.retry ?? false).toBe(false);
    expect(missed.retryItem ?? null).toBeNull();
  });
});
