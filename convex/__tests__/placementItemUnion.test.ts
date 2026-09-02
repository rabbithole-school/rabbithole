/**
 * Placement serves the full item union (U-3) — convex-test coverage for the
 * manipulative-probe additions to the placement / mixed-check-in loops:
 *
 *   • Probe SELECTION policy: prefer the fast template; swap in a curated
 *     manipulative only when (a) the node has one, (b) < K=3 manipulatives have
 *     been served this check-in, (c) the strand already served a template probe
 *     (the affect-safe first probe stays a template). REPLACEMENT, not addition —
 *     a manipulative probe is ONE probeLog entry against the caps.
 *   • Manipulative probes are SCORED and participate in the per-strand binary
 *     search exactly like a template probe (a miss caps the frontier).
 *   • Mixed check-in: the at-most-ONE-live-probe invariant holds with
 *     manipulatives in play, and K=3 is check-in-wide (across domains).
 *   • Legacy `servedProbe` rows (no `kind`/`ref`) resolve as a template — no crash.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../lib/manipulative/practiceContract";

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

// Concrete tester type inferred from the VALUE (not a type-level instantiation,
// which CI's convex-test rejects, nor the erased generic, which unties ctx.db).
const _makeTester = () => convexTest(schema, modules);
type Tester = ReturnType<typeof _makeTester>;

// ── Fixtures (copied verbatim per the testing conventions) ──────────────────

async function seedScholar(t: Tester, username = "union-scholar") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Union Scholar", username, role: "scholar" }),
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

// A width-4 rectangle is the ONLY area-16 solution at perimeter 16 — kind-agnostic
// (its correctness doesn't depend on the node's own math), so we can attach it to
// any probeable node and answer it deterministically.
const AREA_SPEC = {
  kind: "areaPerimeter",
  id: "manip-ap",
  concept: "Area with fixed perimeter",
  prompt: "Fence in exactly 16 square units.",
  perimeter: 16,
  startWidth: 1,
  goal: { type: "areaEquals", value: 16 },
};
const CORRECT_STATE = JSON.stringify({ width: 4 });
const WRONG_STATE = JSON.stringify({ width: 3 });

/** Attach a curated manipulative practiceItems row to a node. */
async function seedManipItem(
  t: Tester,
  skillKey: string,
  domain: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey,
      domain,
      stem: AREA_SPEC.prompt,
      answerType: MANIPULATIVE_ANSWER_TYPE,
      answerCanonical: "",
      verifierKind: MANIPULATIVE_VERIFIER_KIND,
      manipulativeSpec: JSON.stringify(AREA_SPEC),
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
}

/** Seed a custom, grade-less domain from `[strand, [nodeKeys...]]` — a linear
 *  buildsOn chain per strand. Every nodeKey must be a real template key (so the
 *  node is probeable). */
async function seedDomain(
  t: Tester,
  domain: string,
  strands: [string, string[]][],
) {
  await t.run(async (ctx) => {
    for (const [strand, keys] of strands) {
      for (let i = 0; i < keys.length; i++) {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: keys[i],
          label: keys[i],
          domain,
          strand,
          order: i,
          source: "practice",
        });
        if (i > 0) {
          await ctx.db.insert("knowledgeNodeEdges", {
            fromKey: keys[i - 1],
            toKey: keys[i],
            domain,
            kind: "buildsOn",
          });
        }
      }
    }
  });
}

type ServedRow = { itemId: string; skillKey: string; strand: string; answerType: string };

/** Drive the single-domain placement loop, answering each probe by `kindFor`;
 *  a manipulative probe is answered with the correct/incorrect BOARD STATE (not a
 *  typed number). Returns the served probes (with answerType) + the last graded. */
async function runPlacement(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  domain: string,
  kindFor: (skillKey: string) => "correct" | "incorrect" | "unknown",
  seed = 11,
) {
  const base = { scholarId, seed, domain };
  let cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
  const served: ServedRow[] = [];
  let lastGraded: { outcome: string } | null = null;
  for (let i = 0; i < 60 && !cur.done && cur.probe; i++) {
    const probe = cur.probe as ServedRow;
    served.push({
      itemId: probe.itemId,
      skillKey: probe.skillKey,
      strand: probe.strand,
      answerType: probe.answerType,
    });
    const kind = kindFor(probe.skillKey);
    const isManip = probe.answerType === MANIPULATIVE_ANSWER_TYPE;
    const extra =
      kind === "unknown"
        ? { itemId: probe.itemId, answer: "", dontKnow: true }
        : {
            itemId: probe.itemId,
            answer: isManip
              ? kind === "correct"
                ? CORRECT_STATE
                : WRONG_STATE
              : kind === "correct"
                ? gradeTemplateItem(probe.itemId, "0")?.correctAnswer ?? "0"
                : "-999999",
          };
    cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, { ...base, ...extra });
    lastGraded = (cur.graded ?? null) as { outcome: string } | null;
  }
  return { cur, served, lastGraded };
}

async function placementRow(t: Tester, scholarId: Id<"users">, domain: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId).eq("domain", domain))
      .first(),
  );
}

async function masteryByKey(t: Tester, scholarId: Id<"users">, domain: string) {
  const rows = await t.run(async (ctx) =>
    (await ctx.db.query("practiceMastery").collect()).filter(
      (r) => r.scholarId === scholarId && r.domain === domain,
    ),
  );
  return new Map(rows.map((r) => [r.skillKey, r]));
}

// ── Probe-selection policy ──────────────────────────────────────────────────

describe("U-3 placement — manipulative probe selection policy", () => {
  const DOMAIN = "union-kcap";
  // 4 two-node strands. Each strand's FIRST probe is node `a` (affect-safe
  // template), its SECOND probe is node `b` — and every `b` carries a
  // manipulative, so 4 manipulatives are ELIGIBLE. K=3 must cap it at 3.
  const STRANDS: [string, string[]][] = [
    ["s1", ["count_to_10", "add_within_5"]],
    ["s2", ["add_within_10", "add_within_20_regroup"]],
    ["s3", ["add_2digit_regroup", "skip_count_2s_5s_10s"]],
    ["s4", ["mult_facts_0_1_2_5_10", "mult_facts_3_4_6"]],
  ];
  const B_NODES = STRANDS.map(([, keys]) => keys[1]);
  const A_NODES = STRANDS.map(([, keys]) => keys[0]);

  test("K=3 cap, replacement-not-addition, affect-safe first probe stays a template", async () => {
    const t = convexTest(schema, modules);
    await seedDomain(t, DOMAIN, STRANDS);
    for (const b of B_NODES) await seedManipItem(t, b, DOMAIN);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const { cur, served } = await runPlacement(asScholar, scholar, DOMAIN, () => "correct");
    expect(cur.done).toBe(true);

    // Affect-safe: the first probe served in EACH strand is a template.
    for (const [strand] of STRANDS) {
      const firstInStrand = served.find((s) => s.strand === strand)!;
      expect(firstInStrand.answerType, `first probe of ${strand}`).not.toBe(MANIPULATIVE_ANSWER_TYPE);
      expect(A_NODES).toContain(firstInStrand.skillKey);
    }

    // Exactly K=3 manipulatives served across the check-in (the 4th eligible
    // `b`-node falls back to a template).
    const manipServed = served.filter((s) => s.answerType === MANIPULATIVE_ANSWER_TYPE);
    expect(manipServed.length).toBe(3);
    // …and every served manipulative is on a `b` node.
    for (const m of manipServed) expect(B_NODES).toContain(m.skillKey);

    // Replacement, not addition: exactly one probe per node (8 total), so a
    // manipulative did not buy an EXTRA probe against the caps.
    const row = await placementRow(t, scholar, DOMAIN);
    expect(row?.probeLog).toHaveLength(8);
    const probedKeys = (row?.probeLog ?? []).map((e) => e.nodeKey).sort();
    expect(probedKeys).toEqual([...A_NODES, ...B_NODES].sort());
    // The manipulative entries carry a gen# itemId (the manipulative discriminator).
    const manipLog = (row?.probeLog ?? []).filter((e) => e.itemId?.startsWith("gen#"));
    expect(manipLog).toHaveLength(3);

    // The whole domain converged + credited (manipulatives graded correct).
    const mastery = await masteryByKey(t, scholar, DOMAIN);
    for (const key of [...A_NODES, ...B_NODES]) {
      expect(mastery.get(key)?.repetition, `credited ${key}`).toBe(FLUENT_REPS);
    }
  });

  test("a manipulative probe is SCORED — a miss caps the strand frontier like any probe", async () => {
    const t = convexTest(schema, modules);
    // One 2-node strand: `a` (template, first) then `b` (manipulative, second).
    await seedDomain(t, DOMAIN, [["only", ["count_to_10", "add_within_5"]]]);
    await seedManipItem(t, "add_within_5", DOMAIN);
    const scholar = await seedScholar(t, "union-scored");
    const asScholar = await asUser(t, scholar);

    // Answer `a` correct, then MISS the manipulative on `b`.
    const { cur, served } = await runPlacement(asScholar, scholar, DOMAIN, (key) =>
      key === "add_within_5" ? "incorrect" : "correct",
    );
    expect(cur.done).toBe(true);
    // `b` really was served as a manipulative (not coerced to a typed probe).
    expect(served.find((s) => s.skillKey === "add_within_5")?.answerType).toBe(MANIPULATIVE_ANSWER_TYPE);

    // The manipulative miss caps the frontier at `b`: `a` credited fluent, `b` a
    // frontier node (repetition 0) — exactly a template miss's effect.
    const mastery = await masteryByKey(t, scholar, DOMAIN);
    expect(mastery.get("count_to_10")?.repetition).toBe(FLUENT_REPS);
    expect(mastery.get("add_within_5")?.repetition).toBe(0);
    expect(mastery.get("add_within_5")?.frontier).toBe(true);
    const row = await placementRow(t, scholar, DOMAIN);
    expect(row?.frontierByStrand).toEqual([{ strand: "only", frontierKey: "add_within_5" }]);
  });
});

// ── Legacy servedProbe tolerance ────────────────────────────────────────────

describe("U-3 placement — legacy servedProbe (no kind/ref) resolves as a template", () => {
  const DOMAIN = "union-legacy";
  test("an in-flight OLD-shape row does not crash placementCurrent / submit", async () => {
    const t = convexTest(schema, modules);
    await seedDomain(t, DOMAIN, [["only", ["count_to_10", "add_within_5"]]]);
    const scholar = await seedScholar(t, "union-legacy");
    const asScholar = await asUser(t, scholar);

    // Hand-write a pre-U-3 servedProbe: NO `kind`, NO `ref` (a template item id).
    const legacySeed = 4242;
    const legacyItemId = makeItemId("count_to_10", legacySeed);
    await t.run(async (ctx) =>
      ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: DOMAIN,
        status: "in_progress",
        probesAnswered: 0,
        probeLog: [],
        servedProbe: {
          nodeKey: "count_to_10",
          strand: "only",
          itemId: legacyItemId,
          seed: legacySeed,
        },
        updatedAt: Date.now(),
      }),
    );

    // placementCurrent resolves it as a template — no crash, real stem.
    const cur = await asScholar.query(api.practiceSkills.placementCurrent, {
      scholarId: scholar,
      domain: DOMAIN,
    });
    expect(cur.done).toBe(false);
    expect(cur.probe?.itemId).toBe(legacyItemId);
    expect(cur.probe?.answerType).not.toBe(MANIPULATIVE_ANSWER_TYPE);
    expect((cur.probe?.stem ?? "").length).toBeGreaterThan(0);

    // Grading that legacy probe works through the dispatcher.
    const graded = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      domain: DOMAIN,
      seed: 5,
      itemId: legacyItemId,
      answer: gradeTemplateItem(legacyItemId, "0")?.correctAnswer ?? "0",
    });
    expect(graded.graded?.outcome).toBe("correct");
  });
});

// ── Mixed check-in: one-live-probe invariant with manipulatives in play ─────

describe("U-3 mixed check-in — one-live-probe holds with manipulatives, K=3 is check-in-wide", () => {
  test("at most ONE domain holds a served probe at every step; ≥1 manipulative served; K≤3", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "union-mixed");
    const asScholar = await asUser(t, scholar);

    // Attach a manipulative to EVERY probeable whole-number node so that, after
    // each whole-number strand's affect-safe first (template) probe, later probes
    // become manipulatives — guaranteeing manipulatives appear in the mixed flow.
    const wnaNodes = await t.run(async (ctx) =>
      ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", "whole-number-arithmetic"))
        .collect(),
    );
    // hasTemplate mirrors the server's isProbeable; only probeable nodes are ever
    // served, so attaching to all of them is safe (non-probeable ones are inert).
    const { hasTemplate } = await import("../lib/practice/templates");
    for (const n of wnaNodes) if (hasTemplate(n.nodeKey)) await seedManipItem(t, n.nodeKey, "whole-number-arithmetic");

    const countServedProbes = async () =>
      await t.run(async (ctx) =>
        (await ctx.db.query("practicePlacements").collect()).filter(
          (r) => r.scholarId === scholar && r.servedProbe !== undefined,
        ).length,
      );

    const base = { scholarId: scholar, seed: 9 };
    let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
    let manipServed = 0;
    let guard = 0;
    while (!cur.done && cur.probe && guard++ < 250) {
      // The invariant: never more than ONE live probe across ALL domain rows.
      expect(await countServedProbes()).toBeLessThanOrEqual(1);
      const probe = cur.probe as { itemId: string; answerType: string };
      const isManip = probe.answerType === MANIPULATIVE_ANSWER_TYPE;
      if (isManip) manipServed++;
      const extra = isManip
        ? { itemId: probe.itemId, answer: CORRECT_STATE }
        : { itemId: probe.itemId, answer: gradeTemplateItem(probe.itemId, "0")?.correctAnswer ?? "0" };
      cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, { ...base, ...extra });
    }
    expect(cur.done).toBe(true);
    // Manipulatives really appeared in the mixed flow…
    expect(manipServed).toBeGreaterThanOrEqual(1);
    // …and the K=3 budget is check-in-wide (across all domains, not per-domain).
    expect(manipServed).toBeLessThanOrEqual(3);

    // Total manipulative-graded probes recorded across all domain logs ≤ 3.
    const totalManipLogged = await t.run(async (ctx) =>
      (await ctx.db.query("practicePlacements").collect())
        .filter((r) => r.scholarId === scholar)
        .reduce((n, r) => n + (r.probeLog ?? []).filter((e) => e.itemId?.startsWith("gen#")).length, 0),
    );
    expect(totalManipLogged).toBe(manipServed);
    expect(totalManipLogged).toBeLessThanOrEqual(3);
  });
});
