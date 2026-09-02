import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FLUENT_REPS, accessProven } from "../lib/practice/scheduler";
import { gradeTemplateItem } from "../lib/practice/session";

/**
 * Production-faithful proof that INFERENCE-ONLY `implies` edges do REAL work.
 *
 * A cross-domain `implies` edge S -> T (S in another domain, T an entrance here)
 * is a placement-diagnostic: a scholar who has DEMONSTRATED the source S is
 * trusted-upward through T without a probe. This drives the REAL placement path
 * (`submitPlacementAnswer`) — not the pure sim — and shows the shipped edges
 * `count_objects_within_20 -> {read_picture_graph, read_bar_graph, read_line_plot}`
 * skip + credit those probability entrances for a scholar with whole-number
 * strength, and do NOTHING for a scholar without it (isolating the effect to the
 * edges + a demonstrated source).
 */

const modules = (import.meta as ImportMeta & {
  glob: (p: string) => Record<string, () => Promise<unknown>>;
}).glob("../**/*.ts");

const PROBABILITY = "probability";
const WHOLE_NUMBER = "whole-number-arithmetic";
const DISPLAY_ENTRANCES = ["read_picture_graph", "read_bar_graph", "read_line_plot"];

async function seedScholar(t: ReturnType<typeof convexTest>, username: string): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Placement Scholar", username, role: "scholar" }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: 8_000_000_000_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** Give a scholar a genuinely-demonstrated (accessProven) whole-number skill —
 *  a real `practiceMastery` row in the source's OWN domain, exactly as practice
 *  would leave it. This is the "measured whole-number strength" precondition. */
async function demonstrateSource(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  skillKey: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain: WHOLE_NUMBER,
      repetition: FLUENT_REPS,
      halfLifeDays: 7,
      lastPracticedAt: Date.now(),
      frontier: false,
      source: "practice",
      updatedAt: Date.now(),
    });
  });
}

/** Drive the REAL single-domain placement loop to completion through the actual
 *  `submitPlacementAnswer` mutation. `mode="correct"` answers each template with
 *  its true answer (a strong scholar); `mode="dontknow"` answers "don't know"
 *  (so the `implies` floor is the ONLY thing that can credit a node — clean
 *  isolation). Non-template probes (curated manipulatives) fall back to
 *  "don't know". Returns the nodeKeys actually probed. */
async function runPlacement(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  mode: "correct" | "dontknow",
): Promise<{ probedKeys: string[] }> {
  const base = { scholarId, domain: PROBABILITY, seed: 7 };
  let cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
  const probedKeys: string[] = [];
  for (let i = 0; i < 200 && !cur.done && cur.probe; i++) {
    const probe = cur.probe;
    probedKeys.push(probe.skillKey);
    const graded = mode === "correct" ? gradeTemplateItem(probe.itemId, "0") : null;
    cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: probe.itemId,
      ...(graded ? { answer: graded.correctAnswer } : { dontKnow: true }),
    });
  }
  expect(cur.done).toBe(true);
  return { probedKeys };
}

/** The probability skills the scholar was CREDITED (accessProven placement rows). */
async function creditedKeys(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
): Promise<Set<string>> {
  const keys = await t.run(async (ctx) => {
    const rows = (await ctx.db.query("practiceMastery").collect()).filter(
      (r) =>
        r.scholarId === scholarId &&
        r.domain === PROBABILITY &&
        r.source === "placement" &&
        !r.frontier &&
        accessProven(r),
    );
    return rows.map((r) => r.skillKey);
  });
  return new Set(keys);
}

async function probeLogLen(t: ReturnType<typeof convexTest>, scholarId: Id<"users">): Promise<number> {
  return await t.run(async (ctx) => {
    const row = (await ctx.db.query("practicePlacements").collect()).find(
      (r) => r.scholarId === scholarId && r.domain === PROBABILITY,
    );
    return row?.probeLog?.length ?? 0;
  });
}

/** How many probes the scholar spent inside the `data-displays` strand — the
 *  strand whose entrances the `implies` floor pre-credits. */
async function dataDisplayProbeCount(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
): Promise<number> {
  return await t.run(async (ctx) => {
    const row = (await ctx.db.query("practicePlacements").collect()).find(
      (r) => r.scholarId === scholarId && r.domain === PROBABILITY,
    );
    return (row?.probeLog ?? []).filter((e: { strand?: string }) => e.strand === "data-displays").length;
  });
}

describe("implies — REAL placement effect on an unmapped domain", () => {
  test("isolation: a demonstrated cross-domain source CREDITS the target entrances WITHOUT probing them; without it, nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});

    // Scholar A: no whole-number strength. Scholar B: demonstrated the shipped
    // `implies` source `count_objects_within_20`. Both answer every probe "don't
    // know", so the `implies` floor is the ONLY thing that can credit a node.
    const scholarA = await seedScholar(t, "placement_baseline");
    const scholarB = await seedScholar(t, "placement_strong");
    await demonstrateSource(t, scholarB, "count_objects_within_20");

    const asA = await asUser(t, scholarA);
    const asB = await asUser(t, scholarB);

    await runPlacement(asA, scholarA, "dontknow");
    const runB = await runPlacement(asB, scholarB, "dontknow");

    const creditedA = await creditedKeys(t, scholarA);
    const creditedB = await creditedKeys(t, scholarB);

    // B credits ALL three data-display entrances — WITHOUT probing any of them.
    for (const key of DISPLAY_ENTRANCES) {
      expect(creditedB.has(key), `B credits ${key} via the implies floor`).toBe(true);
      expect(runB.probedKeys, `B never probes ${key} (skipped)`).not.toContain(key);
    }
    // A (no demonstrated source, all "don't know") credits NONE of them — proving
    // the credit is due to the `implies` edges + a demonstrated source alone.
    for (const key of DISPLAY_ENTRANCES) {
      expect(creditedA.has(key), `A does NOT credit ${key}`).toBe(false);
    }
    // B maps strictly more of the domain than A for free (≥3 extra entrances).
    expect(creditedB.size).toBeGreaterThanOrEqual(creditedA.size + DISPLAY_ENTRANCES.length);
  });

  test("non-inferiority: the demonstrated source never costs MORE probes, and still credits every entrance for free", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});

    // Both scholars answer everything CORRECTLY (the realistic "strong scholar").
    // B additionally has the demonstrated cross-domain source, so its data-display
    // strand search starts above the three pre-credited entrances.
    const scholarA = await seedScholar(t, "reduce_baseline");
    const scholarB = await seedScholar(t, "reduce_strong");
    await demonstrateSource(t, scholarB, "count_objects_within_20");

    const asA = await asUser(t, scholarA);
    const asB = await asUser(t, scholarB);

    await runPlacement(asA, scholarA, "correct");
    const runB = await runPlacement(asB, scholarB, "correct");

    // POST-FIX NOTE: the You-Pick grade prior now opens a COLD baseline (A) at the
    // domain floor and trusts upward, so A's affect-safe anchor already lands just
    // above the foundational entrances and skips re-probing them — the same head
    // start the `implies` floor gives B. The source therefore no longer buys
    // strictly FEWER probes in this short strand (both converge equally). Its
    // DISTINCT value — crediting the entrances WITHOUT probing them, and doing
    // NOTHING for a scholar who cannot answer — is proven by the isolation test
    // above. Here we guard the two properties that must still hold: the source is
    // strictly NON-INFERIOR (never adds probes) and still mints the free credit.
    const [ddA, ddB] = [
      await dataDisplayProbeCount(t, scholarA),
      await dataDisplayProbeCount(t, scholarB),
    ];
    const [lenA, lenB] = [await probeLogLen(t, scholarA), await probeLogLen(t, scholarB)];
    expect(ddB).toBeLessThanOrEqual(ddA);
    expect(lenB).toBeLessThanOrEqual(lenA);

    // The `implies` floor still credits all three entrances WITHOUT probing them.
    const creditedB = await creditedKeys(t, scholarB);
    for (const key of DISPLAY_ENTRANCES) {
      expect(creditedB.has(key), `B credits ${key} via the implies floor`).toBe(true);
      expect(runB.probedKeys, `B never probes ${key} (skipped)`).not.toContain(key);
    }
  });

  test("no false credit: a scholar strong in the PRUNED §5 sources gets no probability entrance credited", async () => {
    // Guard: a scholar demonstrated in `compare_3digit` / `perimeter_polygons` /
    // `compare_within_10` (the PRUNED §5 sources) must NOT get any probability
    // entrance credited — those edges were removed precisely because the target
    // template doesn't exercise the source, so they must mint no placement credit.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "placement_pruned_source");
    for (const src of ["compare_3digit", "perimeter_polygons", "compare_within_10"]) {
      await demonstrateSource(t, scholar, src);
    }
    const asScholar = await asUser(t, scholar);
    await runPlacement(asScholar, scholar, "dontknow");
    const credited = await creditedKeys(t, scholar);
    for (const key of ["ordering", "collect_measurement_data", "statistical_question"]) {
      expect(credited.has(key), `pruned edge must not credit ${key}`).toBe(false);
    }
  });
});
