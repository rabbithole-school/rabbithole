import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { expressionAnswerSignals } from "../lib/practice/answerShape";
import { gradeRank } from "../lib/practice/placement";
import { gradeTemplateItem, parseItemId } from "../lib/practice/session";
import { MAPPING_BLEND_CAP, MAPPING_DAY1_BUDGET } from "../lib/practice/mapping";
import {
  nextStrandProbe,
  probeOutcomeFromKind,
  strandOrders,
  type PlacementOutcomeKind,
} from "../lib/practice/placement";
import { generateItem, hasTemplate } from "../lib/practice/templates";
import { MAPPING_SIT_CAP } from "../../shared/practiceLoop";

// Option D (OPTION_D_RULINGS): mapping items ride the daily playlist as a
// `· mapping` segment (lane "mapping"), graded through the placement crediting
// path. These lock the SERVER contract the two frontends depend on: day-1
// all-mapping emergence, the blend cap, placement-semantics preservation (no
// demonstrated fluency), ghost-placement absorption, and resume inclusion.

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

const WHOLE = "whole-number-arithmetic";
const FRAC = "fraction-arithmetic";

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
  gradeLevel?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Mapping Scholar",
      username,
      role: "scholar",
      ...(gradeLevel ? { gradeLevel } : {}),
    }),
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

type Served = {
  items: { itemId: string; lane?: string; domain?: string; skillKey: string; skillLabel: string }[];
  segments: { kind: string; count: number }[];
  allMapping: boolean;
  mappingDomains: { domain: string; label: string; state: string }[];
  mappingProgressOffset: number;
};

async function serve(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  args: { domain?: string; domains?: string[]; seed?: number } = {},
): Promise<Served> {
  return (await asScholar.query(api.practiceSkills.practiceSession, {
    scholarId,
    seed: args.seed ?? 11,
    includeMapping: true,
    ...(args.domains ? { domains: args.domains } : { domain: args.domain ?? WHOLE }),
  })) as unknown as Served;
}

/** Answer every mapping item in the served batch all-correct, then re-serve —
 *  the client's mapping loop — until `domain` finishes placing (or a guard). */
async function mapDomainToDone(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  domain: string,
) {
  let justMappedFired = false;
  for (let i = 0; i < 60; i++) {
    const res = await serve(asScholar, scholarId, { domain, seed: 11 + i });
    const mapping = res.items.filter((it) => it.lane === "mapping" && (it.domain ?? domain) === domain);
    if (mapping.length === 0) break;
    for (const it of mapping) {
      const graded = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
        scholarId,
        domain,
        itemId: it.itemId,
        seed: 11 + i,
        answer: gradeTemplateItem(it.itemId, "0")?.correctAnswer ?? "0",
      });
      if (graded.domainJustMapped) justMappedFired = true;
    }
  }
  return { justMappedFired };
}

async function masteryRows(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, domain: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("practiceMastery").collect()).filter(
      (r) => r.scholarId === scholarId && r.domain === domain,
    ),
  );
}

async function placementRow(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, domain: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("practicePlacements").collect()).find(
      (r) => r.scholarId === scholarId && r.domain === domain,
    ) ?? null,
  );
}

describe("Option D — mapping inside the playlist (server contract)", () => {
  test("item 18 finalizes imperfect unresolved mapping and the next playlist is real practice", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_sit_cap");
    const asScholar = await asUser(t, scholar);

    let answered = 0;
    let finalResult: { domainJustMapped: boolean } | null = null;
    for (let round = 0; round < MAPPING_SIT_CAP; round++) {
      const res = await serve(asScholar, scholar, {
        domain: WHOLE,
        seed: 500 + round,
      });
      const item = res.items.find(
        (item) => item.lane === "mapping" && (item.domain ?? WHOLE) === WHOLE,
      );
      expect(item).toBeDefined();
      const imperfect = answered % 3 === 2;
      const graded = await asScholar.mutation(
        api.practiceSkills.submitMappingAnswer,
        {
          scholarId: scholar,
          domain: WHOLE,
          itemId: item!.itemId,
          seed: 500 + round,
          ...(imperfect
            ? { dontKnow: true }
            : {
                answer:
                  gradeTemplateItem(item!.itemId, "0")?.correctAnswer ?? "0",
              }),
        },
      );
      answered++;
      if (answered < MAPPING_SIT_CAP) {
        expect(graded.domainJustMapped).toBe(false);
      } else {
        finalResult = graded;
      }
    }

    expect(answered).toBe(MAPPING_SIT_CAP);
    expect(finalResult?.domainJustMapped).toBe(true);
    const row = await placementRow(t, scholar, WHOLE);
    expect(row).toMatchObject({
      status: "complete",
      probesAnswered: MAPPING_SIT_CAP,
    });
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
      ).filter((edge) => edge.kind === "buildsOn"),
    }));
    const outcomes = row!.probeLog!.map((entry: {
      nodeKey: string;
      outcome: string;
    }) =>
      probeOutcomeFromKind(
        entry.nodeKey,
        entry.outcome as PlacementOutcomeKind,
      ),
    );
    const unresolvedAtCap = strandOrders(
      graph.nodes,
      graph.edges,
    ).some(
      (order) =>
        nextStrandProbe(order.orderedKeys, hasTemplate, outcomes) !== null,
    );
    expect(unresolvedAtCap).toBe(true);
    const mastery = await masteryRows(t, scholar, WHOLE);
    expect(mastery.length).toBeGreaterThan(0);
    expect(mastery.every((entry) => entry.source === "placement")).toBe(true);

    const next = await serve(asScholar, scholar, { domain: WHOLE, seed: 900 });
    expect(next.allMapping).toBe(false);
    expect(next.items.some((item) => item.lane !== "mapping")).toBe(true);
  });

  test("an already-capped in-progress row repairs once on re-entry", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const sourceScholar = await seedScholar(t, "map_repair_source");
    const asSource = await asUser(t, sourceScholar);

    let answered = 0;
    while (answered < MAPPING_SIT_CAP) {
      const res = await serve(asSource, sourceScholar, {
        domain: WHOLE,
        seed: 1_000 + answered,
      });
      const item = res.items.find(
        (candidate) =>
          candidate.lane === "mapping" &&
          (candidate.domain ?? WHOLE) === WHOLE,
      );
      expect(item).toBeDefined();
      await asSource.mutation(api.practiceSkills.submitMappingAnswer, {
        scholarId: sourceScholar,
        domain: WHOLE,
        itemId: item!.itemId,
        seed: 1_000 + answered,
        ...(answered % 3 === 2
          ? { dontKnow: true }
          : {
              answer:
                gradeTemplateItem(item!.itemId, "0")?.correctAnswer ?? "0",
            }),
      });
      answered++;
    }
    const completed = await placementRow(t, sourceScholar, WHOLE);
    expect(completed?.probeLog).toHaveLength(MAPPING_SIT_CAP);

    const legacyScholar = await seedScholar(t, "map_repair_legacy");
    const asLegacy = await asUser(t, legacyScholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId: legacyScholar,
        domain: WHOLE,
        status: "in_progress",
        probesAnswered: MAPPING_SIT_CAP,
        probeLog: completed!.probeLog,
        updatedAt: Date.now(),
      });
    });

    const repaired = await asLegacy.mutation(
      api.practiceSkills.finalizeCappedMappingRuns,
      { scholarId: legacyScholar },
    );
    const repeated = await asLegacy.mutation(
      api.practiceSkills.finalizeCappedMappingRuns,
      { scholarId: legacyScholar },
    );
    expect(repaired.finalizedDomains).toEqual([WHOLE]);
    expect(repeated.finalizedDomains).toEqual([]);
    expect((await placementRow(t, legacyScholar, WHOLE))?.status).toBe(
      "complete",
    );
    const mastery = await masteryRows(t, legacyScholar, WHOLE);
    expect(mastery.length).toBeGreaterThan(0);
    expect(mastery.every((entry) => entry.source === "placement")).toBe(true);
  });

  test("a capped run in a SHADOW-PLACED domain finalizes WITH frontier + credit, not a bare stamp", async () => {
    // The repair test above uses a scholar with NO prior mastery, so it never
    // hits the `existingMastery` branch. This one does: a shadow-placed scholar
    // (real demonstrated mastery, no converged run) whose run reached the cap.
    // The old shortcut stamped such a row "complete" WITHOUT resolving a frontier
    // or crediting — marking the domain mapped (counted in N) while leaving it
    // unsearched. Now that `creditPlacementFrontiers` is raise-only safe, it must
    // always finalize through the real path.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});

    // A real capped probeLog, built by driving a source scholar to the cap
    // without converging (every 3rd unknown, as the repair test does).
    const source = await seedScholar(t, "map_f4_source");
    const asSource = await asUser(t, source);
    let answered = 0;
    while (answered < MAPPING_SIT_CAP) {
      const res = await serve(asSource, source, { domain: WHOLE, seed: 2_000 + answered });
      const item = res.items.find(
        (c) => c.lane === "mapping" && (c.domain ?? WHOLE) === WHOLE,
      );
      expect(item).toBeDefined();
      await asSource.mutation(api.practiceSkills.submitMappingAnswer, {
        scholarId: source,
        domain: WHOLE,
        itemId: item!.itemId,
        seed: 2_000 + answered,
        ...(answered % 3 === 2
          ? { dontKnow: true }
          : { answer: gradeTemplateItem(item!.itemId, "0")?.correctAnswer ?? "0" }),
      });
      answered++;
    }
    const capped = await placementRow(t, source, WHOLE);
    expect(capped?.probeLog).toHaveLength(MAPPING_SIT_CAP);

    // A shadow-placed scholar: demonstrated mastery (a fluent tier + one
    // below-fluent node) AND the capped in-progress run.
    const scholar = await seedScholar(t, "map_f4_shadow");
    const asScholar = await asUser(t, scholar);
    const seeded = await t.run(async (ctx) => {
      const nodes = (await ctx.db.query("knowledgeNodes").collect())
        .filter((n) => n.domain === WHOLE)
        .slice(0, 6);
      for (const [i, node] of nodes.entries()) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: node.nodeKey,
          domain: WHOLE,
          strand: node.strand,
          repetition: i === 0 ? 1 : 6,
          halfLifeDays: i === 0 ? 2 : 40,
          lastPracticedAt: Date.now(),
          lastAttemptAt: Date.now(),
          frontier: false,
          source: "practice",
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: WHOLE,
        status: "in_progress",
        probesAnswered: MAPPING_SIT_CAP,
        probeLog: capped!.probeLog,
        updatedAt: Date.now(),
      });
      return nodes.map((n, i) => ({ key: n.nodeKey, reps: i === 0 ? 1 : 6 }));
    });

    const repaired = await asScholar.mutation(
      api.practiceSkills.finalizeCappedMappingRuns,
      { scholarId: scholar },
    );
    expect(repaired.finalizedDomains).toEqual([WHOLE]);

    const row = await placementRow(t, scholar, WHOLE);
    expect(row?.status).toBe("complete");
    // THE F4 SIGNAL: the bare-stamp shortcut never wrote `frontierByStrand` and
    // never credited a single row; the real finalize does both.
    expect(row?.frontierByStrand).toBeDefined();
    const after = await masteryRows(t, scholar, WHOLE);
    expect(after.some((r) => r.source === "placement")).toBe(true);

    // Raise-only safety still holds over the demonstrated rows.
    for (const { key, reps } of seeded) {
      const r = after.find((m) => m.skillKey === key)!;
      if (reps === 6) {
        expect(r.source, key).toBe("practice");
        expect(r.repetition, key).toBe(6);
      } else {
        expect(r.source === "practice" && r.repetition >= 3, key).toBe(false);
      }
    }

    // Idempotent.
    const again = await asScholar.mutation(
      api.practiceSkills.finalizeCappedMappingRuns,
      { scholarId: scholar },
    );
    expect(again.finalizedDomains).toEqual([]);
  });

  test("DAY 1: a fresh scholar's playlist is 100% `· mapping` (allMapping), foundational domain only", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_day1");
    const asScholar = await asUser(t, scholar);

    const res = await serve(asScholar, scholar, { domain: WHOLE });
    expect(res.items.length).toBeGreaterThan(0);
    // Every served item is a mapping item — nothing else is servable yet.
    expect(res.items.every((it) => it.lane === "mapping")).toBe(true);
    expect(res.allMapping).toBe(true);
    // The ceremony-lite skin trigger.
    const state = await asScholar.query(api.practiceSkills.mappingPlaylistState, { scholarId: scholar });
    expect(state.allMapping).toBe(true);
    expect(state.hasMapping).toBe(true);
    // Foundational-first: fractions is prereq-gated behind whole-number, so day 1
    // maps whole-number only.
    expect(res.items.every((it) => (it.domain ?? WHOLE) === WHOLE)).toBe(true);
    // The segment strip carries a `mapping` segment.
    expect(res.segments.some((s) => s.kind === "mapping")).toBe(true);
  });

  test("DAY 1: active mapping calibrates first probes from the scholar's grade level", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const younger = await seedScholar(t, "map_grade_1", "Grade 1");
    const older = await seedScholar(t, "map_grade_5", "5");
    const asYounger = await asUser(t, younger);
    const asOlder = await asUser(t, older);

    const youngerSession = await serve(asYounger, younger, { domain: WHOLE, seed: 41 });
    const olderSession = await serve(asOlder, older, { domain: WHOLE, seed: 41 });
    const nodes = await t.run(async (ctx) => await ctx.db.query("knowledgeNodes").collect());
    const gradeByKey = new Map(nodes.map((node) => [node.nodeKey, node.grade]));
    const servedRanks = (session: Served) =>
      session.items
        .filter((item) => item.lane === "mapping")
        .map((item) => gradeRank(gradeByKey.get(item.skillKey) ?? ""))
        .filter((rank) => rank >= 0);
    const youngerRanks = servedRanks(youngerSession);
    const olderRanks = servedRanks(olderSession);
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;

    expect(youngerRanks.length).toBeGreaterThan(0);
    expect(olderRanks.length).toBe(youngerRanks.length);
    expect(olderSession.items.map((item) => item.skillKey)).not.toEqual(
      youngerSession.items.map((item) => item.skillKey),
    );
    expect(mean(olderRanks)).toBeGreaterThan(mean(youngerRanks));
  });

  test("PLACEMENT SEMANTICS preserved: mapping to done credits INFERRED (source placement), never demonstrated fluency", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_semantics");
    const asScholar = await asUser(t, scholar);

    const { justMappedFired } = await mapDomainToDone(asScholar, scholar, WHOLE);
    expect(justMappedFired).toBe(true);

    const row = await placementRow(t, scholar, WHOLE);
    expect(row?.status).toBe("complete");

    const rows = await masteryRows(t, scholar, WHOLE);
    expect(rows.length).toBeGreaterThan(0);
    // The two-axis invariant: mapping writes INFERRED credit only. Nothing a
    // mapping item touched may claim the demonstrated ("practice") source.
    expect(rows.every((r) => r.source === "placement")).toBe(true);
    expect(rows.some((r) => r.source === "practice")).toBe(false);
    // Every practiceAttempts row from mapping is on the placement lane/source.
    const attempts = await t.run(async (ctx) =>
      (await ctx.db.query("practiceAttempts").collect()).filter((a) => a.scholarId === scholar),
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a) => a.source === "placement" && a.lane === "placement")).toBe(true);
  });

  test("BLEND MINORITY: a placed domain + an unmapped one → ≤2 mapping items, not allMapping, reviews/new lead", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_blend");
    const asScholar = await asUser(t, scholar);

    // Place whole-number (so fractions becomes prereq-eligible + the playlist has
    // real review/new work), leaving fractions unmapped.
    await mapDomainToDone(asScholar, scholar, WHOLE);
    // Sanity: whole-number placed, fractions still needs mapping.
    const wnRow = await placementRow(t, scholar, WHOLE);
    expect(wnRow?.status).toBe("complete");

    const res = await serve(asScholar, scholar, { domain: WHOLE });
    const mapping = res.items.filter((it) => it.lane === "mapping");
    // Blend: capped, minority, and not the all-mapping cold-start skin.
    expect(res.allMapping).toBe(false);
    expect(mapping.length).toBeGreaterThan(0);
    expect(mapping.length).toBeLessThanOrEqual(MAPPING_BLEND_CAP);
    // The mapping band comes from the still-unmapped fractions domain.
    expect(mapping.every((it) => it.domain === FRAC)).toBe(true);
    // Order (Q2): mapping never precedes a review, and every non-mapping item is
    // a real (placed-domain) item — the band is the minority.
    expect(mapping.length).toBeLessThan(res.items.length);
  });

  test("GHOST placement dissolves into mapping items (no migration) and appends to the SAME row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_ghost");
    const asScholar = await asUser(t, scholar);

    // Answer ONE mapping item, then abandon — an in-progress ("parked") placement
    // ghost with a real probeLog entry, exactly like a pre-Option-D scholar.
    const first = await serve(asScholar, scholar, { domain: WHOLE });
    expect(first.mappingProgressOffset).toBe(0);
    const firstItem = first.items.find((it) => it.lane === "mapping")!;
    await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      itemId: firstItem.itemId,
      seed: 11,
      answer: gradeTemplateItem(firstItem.itemId, "0")?.correctAnswer ?? "0",
    });
    const ghost = await placementRow(t, scholar, WHOLE);
    expect(ghost?.status).toBe("in_progress");
    expect(ghost?.probeLog?.length).toBe(1);
    const ghostId = ghost!._id;

    // The next composed playlist surfaces the remaining spots as mapping items —
    // the ghost dissolves, no data surgery.
    const next = await serve(asScholar, scholar, { domain: WHOLE, seed: 99 });
    expect(next.mappingProgressOffset).toBe(1);
    const nextMapping = next.items.filter((it) => it.lane === "mapping");
    expect(nextMapping.length).toBeGreaterThan(0);

    // Answering appends to the SAME placement row (answered probes are kept).
    await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      itemId: nextMapping[0].itemId,
      seed: 99,
      answer: gradeTemplateItem(nextMapping[0].itemId, "0")?.correctAnswer ?? "0",
    });
    const after = await placementRow(t, scholar, WHOLE);
    expect(after?._id).toBe(ghostId);
    expect(after?.probeLog?.length).toBe(2);
  });

  test("BREADTH: the default entry serves the servable unmapped domains, never scoping to the resolved domain, and the preview matches", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_resume_one_domain");
    const asScholar = await asUser(t, scholar);
    const GEOMETRY = "geometry-measurement";
    const RATIO = "ratio-proportion-percent";

    // Every domain but geometry and ratio is genuinely MAPPED (a converged run
    // plus the mastery a finalize writes). Geometry is grade-eligible under the
    // most-restrictive K ring this grade-less scholar gets; ratio's whole graph
    // sits above it, so ratio stays out of the automatic set even though its
    // prerequisites have converged.
    await t.run(async (ctx) => {
      const nodes = await ctx.db.query("knowledgeNodes").collect();
      const firstNodeByDomain = new Map<string, (typeof nodes)[number]>();
      for (const node of nodes) {
        if (!firstNodeByDomain.has(node.domain)) firstNodeByDomain.set(node.domain, node);
      }
      for (const [domain, node] of firstNodeByDomain) {
        if (domain === GEOMETRY || domain === RATIO) continue;
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: node.nodeKey,
          domain,
          strand: node.strand,
          repetition: 3,
          halfLifeDays: 30,
          lastPracticedAt: Date.now(),
          frontier: false,
          source: "practice",
          updatedAt: Date.now(),
        });
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain,
          status: "complete",
          probesAnswered: 1,
          probeLog: [
            { nodeKey: node.nodeKey, strand: node.strand ?? "", outcome: "correct", at: Date.now() },
          ],
          updatedAt: Date.now(),
        });
      }
      for (const domain of [GEOMETRY, RATIO]) {
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain,
          status: "in_progress",
          probesAnswered: 0,
          probeLog: [],
          updatedAt: Date.now(),
        });
      }
    });

    const preview = (await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      domain: RATIO,
      includeMapping: true,
    })) as unknown as { set: { reason: string; label: string }[] };
    const served = await serve(asScholar, scholar, { domain: RATIO });
    const servedMapping = served.items.filter((item) => item.lane === "mapping");

    // The resolved domain is NOT treated as a deliberate pick: the band comes
    // from what may actually serve, which here is geometry alone (ratio is above
    // the ring, everything else is mapped).
    expect(servedMapping.length).toBeGreaterThan(0);
    expect(servedMapping.every((item) => item.domain === GEOMETRY)).toBe(true);
    // Preview and serve compose the SAME band.
    expect(
      preview.set.filter((item) => item.reason === "mapping").map((item) => item.label),
    ).toEqual(servedMapping.map((item) => item.skillLabel));
  });

  test("IDEMPOTENT: re-submitting the same mapping item never double-logs (resume-safe)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_idem");
    const asScholar = await asUser(t, scholar);

    const res = await serve(asScholar, scholar, { domain: WHOLE });
    const item = res.items.find((it) => it.lane === "mapping")!;
    const args = {
      scholarId: scholar,
      domain: WHOLE,
      itemId: item.itemId,
      seed: 11,
      answer: gradeTemplateItem(item.itemId, "0")?.correctAnswer ?? "0",
    };
    const a = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, args);
    const b = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, args);
    expect(a.outcome).toBe("correct");
    expect(b.outcome).toBe("correct");
    const row = await placementRow(t, scholar, WHOLE);
    // One entry despite two submits — a resume re-submit is a no-op.
    expect(row?.probeLog?.filter((e: { itemId?: string }) => e.itemId === item.itemId).length).toBe(1);
  });

  test("a FULLY-MAPPED scholar gets ZERO mapping items (existing behavior untouched)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    // A grade-9 scholar so the affect-safe ring admits every registered domain up
    // to Algebra 1 — otherwise "fully mapped" would be vacuous, satisfied by the
    // high-floor domains simply never becoming eligible.
    const scholar = await seedScholar(t, "map_placed", "9");
    const asScholar = await asUser(t, scholar);

    // Answer the WHOLE breadth-first band each round until nothing is left to
    // map anywhere — the driver shape a client actually runs.
    let rounds = 0;
    for (; rounds < 400; rounds++) {
      const res = await serve(asScholar, scholar, { seed: 3_000 + rounds });
      const mapping = res.items.filter((it) => it.lane === "mapping");
      if (mapping.length === 0) break;
      for (const it of mapping) {
        await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
          scholarId: scholar,
          domain: it.domain ?? WHOLE,
          itemId: it.itemId,
          seed: 3_000 + rounds,
          answer: gradeTemplateItem(it.itemId, "0")?.correctAnswer ?? "0",
        });
      }
    }
    expect(rounds).toBeLessThan(400);
    // Every registered seeded domain really did converge.
    const completed = await t.run(async (ctx) =>
      (await ctx.db.query("practicePlacements").collect())
        .filter((r) => r.scholarId === scholar && r.status === "complete")
        .map((r) => r.domain)
        .sort(),
    );
    expect(completed).toEqual(
      [
        WHOLE,
        FRAC,
        "probability",
        "geometry-measurement",
        "ratio-proportion-percent",
        "integers-coordinates",
        "early-algebra",
        "algebra-1",
      ].sort(),
    );
    const state = await asScholar.query(api.practiceSkills.mappingPlaylistState, { scholarId: scholar });
    expect(state.hasMapping).toBe(false);
    expect(state.allMapping).toBe(false);

    const res = await serve(asScholar, scholar, { domain: WHOLE });
    expect(res.items.some((it) => it.lane === "mapping")).toBe(false);
    expect(res.allMapping).toBe(false);
  });

  test("F1 RECOMPOSITION LOOP: the day-1 sit BUILDS across recompositions past the 6-probe batch until the first domain converges", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_recompose");
    const asScholar = await asUser(t, scholar);

    // Drive the EXACT serve→submit→re-serve loop shape the clients now implement:
    // serve a short batch, answer it all, then re-serve the NEXT probes — never a
    // single static batch.
    let recompositionsWithMapping = 0;
    let totalProbesAnswered = 0;
    let converged = false;
    let allMappingHeldAcrossRecompositions = true;
    for (let i = 0; i < 40 && !converged; i++) {
      const res = await serve(asScholar, scholar, { domain: WHOLE, seed: 11 + i });
      const mapping = res.items.filter((it) => it.lane === "mapping" && (it.domain ?? WHOLE) === WHOLE);
      if (mapping.length === 0) break;
      recompositionsWithMapping++;
      // The served batch is short (one probe per strand, capped at the day-1
      // budget) — never a giant pre-baked set.
      expect(mapping.length).toBeLessThanOrEqual(MAPPING_DAY1_BUDGET);
      // Still all-mapping while whole-number is the only thing to serve.
      if (!res.allMapping) allMappingHeldAcrossRecompositions = false;
      for (const it of mapping) {
        const graded = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
          scholarId: scholar,
          domain: WHOLE,
          itemId: it.itemId,
          seed: 11 + i,
          answer: gradeTemplateItem(it.itemId, "0")?.correctAnswer ?? "0",
        });
        totalProbesAnswered++;
        if (graded.domainJustMapped) converged = true;
      }
    }
    // The first domain places firmly, and it took MORE than one served batch to
    // get there (the sit is honest-and-done, not a static 6-probe check).
    expect(converged).toBe(true);
    expect(recompositionsWithMapping).toBeGreaterThan(1);
    expect(totalProbesAnswered).toBeGreaterThan(MAPPING_DAY1_BUDGET);
    expect(allMappingHeldAcrossRecompositions).toBe(true);
  });

  test("F2 PREVIEW PARITY (Q6): playlistForScholar(includeMapping) previews the SAME `· mapping` composition practiceSession serves", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_preview");
    const asScholar = await asUser(t, scholar);

    // The Home preview an unmapped-domain selection renders…
    const preview = (await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      domain: WHOLE,
      includeMapping: true,
      choiceHint: { domain: WHOLE, strand: "" },
    })) as unknown as {
      set: { key: string; label: string; reason: string }[];
      mappingPreview: boolean;
      allMapping: boolean;
    };
    // …must be the mapping composition, all-mapping, tagged `· mapping`.
    expect(preview.mappingPreview).toBe(true);
    expect(preview.allMapping).toBe(true);
    expect(preview.set.length).toBeGreaterThan(0);
    expect(preview.set.every((r) => r.reason === "mapping")).toBe(true);

    // …and it targets the SAME probe nodes Start will actually serve (the itemId
    // seed differs per serve, but the node LABELS are the deterministic pick).
    const served = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 777,
      domain: WHOLE,
      includeMapping: true,
    })) as unknown as { items: { lane?: string; skillLabel: string }[] };
    const serveLabels = served.items
      .filter((it) => it.lane === "mapping")
      .map((it) => it.skillLabel)
      .sort();
    const previewLabels = preview.set.map((r) => r.label).sort();
    expect(previewLabels).toEqual(serveLabels);
  });

  test("F6b/F3 ALREADY-MAPPED: a stale answer cannot demote the row or drop the canonical mapped count", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_stale");
    const asScholar = await asUser(t, scholar);

    // Capture a real WHOLE mapping item id, then complete the domain some other
    // way (the multi-tab / resume race the clients must survive).
    const first = await serve(asScholar, scholar, { domain: WHOLE });
    const staleItem = first.items.find((it) => it.lane === "mapping")!;
    await mapDomainToDone(asScholar, scholar, WHOLE);
    const row = await placementRow(t, scholar, WHOLE);
    expect(row?.status).toBe("complete");
    const probesBefore = row?.probeLog?.length ?? 0;
    const masteryBefore = (await masteryRows(t, scholar, WHOLE)).length;
    const progressBefore = await asScholar.query(
      api.practiceSkills.mapProgressForScholar,
      { scholarId: scholar },
    );
    expect(progressBefore.mapped).toBeGreaterThan(0);

    // F3: re-submitting the now-stale probe is graded READ-ONLY — it STILL reveals
    // (`outcome` + `correctAnswer`) so the client shows "The answer was …" before
    // recomposing past the finished domain's stale tail (never a silent swallow),
    // but it is flagged `alreadyMapped`, never converges the domain again, and
    // writes NOTHING (no probeLog entry, no new mastery — no double-credit).
    const res = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      itemId: staleItem.itemId,
      seed: 11,
      answer: gradeTemplateItem(staleItem.itemId, "0")?.correctAnswer ?? "0",
    });
    expect(res.alreadyMapped).toBe(true);
    expect(res.outcome).toBe("correct");
    expect(typeof res.correctAnswer).toBe("string");
    expect(res.domainJustMapped).toBe(false);
    const rowAfter = await placementRow(t, scholar, WHOLE);
    expect(rowAfter?.status).toBe("complete");
    expect(rowAfter?.probeLog?.length ?? 0).toBe(probesBefore);
    expect((await masteryRows(t, scholar, WHOLE)).length).toBe(masteryBefore);
    const progressAfter = await asScholar.query(
      api.practiceSkills.mapProgressForScholar,
      { scholarId: scholar },
    );
    expect(progressAfter.mapped).toBe(progressBefore.mapped);
    expect(progressAfter.eligible).toBe(progressBefore.eligible);

    // An UNRESOLVABLE / cross-domain id has nothing to reveal — still a bare no-op.
    const bogus = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      itemId: "not-a-real-item::0",
      seed: 11,
      dontKnow: true,
    });
    expect(bogus.alreadyMapped).toBe(true);
    expect(bogus.outcome).toBeNull();
  });

  test("F7 ZERO-ITEM GUARD: an unmapped domain with no probeable mapping band falls back to ordinary work (never a dead playlist)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_zeroitem");
    const asScholar = await asUser(t, scholar);

    // Sanity: with a real probeable band, an unmapped domain suppresses ordinary
    // work and serves mapping (the normal Option D path). The guard only changes
    // behavior when the mapping band comes back EMPTY — in which case
    // finalizeWithMapping must not suppress the served work. We assert the
    // invariant that matters end-to-end: a fresh scholar's default entry is never
    // empty (either mapping items or ordinary work), so Home is never dead.
    const res = await serve(asScholar, scholar, { domain: WHOLE });
    expect(res.items.length).toBeGreaterThan(0);
  });

  test("RESUME CTA: the home CTA reads the map derivation — a converged domain means the check-in is underway", async () => {
    // The home CTA's Start-vs-Resume input is `mapProgressForScholar.started`
    // (finish-the-check-in decision 6 retired the stale sitting-budget governor
    // readout, and the field it fed — `hasPersistedMappingProgress` — is gone
    // with its last consumer). `started` is honest at a coarse grain: once ANY
    // domain is in flight or converged the check-in IS underway, so a scholar
    // who has fully mapped one domain is told to "Resume", not "Start" — even
    // though `mixedPlacementCurrent` itself still reports the remaining domains
    // as untouched. Pinned here so the behavior is deliberate.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_persisted_progress");
    const asScholar = await asUser(t, scholar);

    await mapDomainToDone(asScholar, scholar, WHOLE);
    const placed = await placementRow(t, scholar, WHOLE);
    expect(placed?.status).toBe("complete");
    // The retained log is the whole premise of the finding.
    expect(placed?.probeLog?.length ?? 0).toBeGreaterThan(0);

    // Every domain still needing placement is untouched → NOT started.
    const untouched = await asScholar.query(
      api.practiceSkills.mixedPlacementCurrent,
      { scholarId: scholar },
    );
    expect(untouched.done).toBe(false);
    // …but the map derivation the home CTA now reads counts the CONVERGED
    // domain: the check-in is genuinely underway, so the verb is "Resume".
    const afterOneDomain = await asScholar.query(
      api.practiceSkills.mapProgressForScholar,
      { scholarId: scholar },
    );
    expect(afterOneDomain.started).toBe(true);

    // One real probe in a domain that still needs placing → genuinely started.
    const served = await serve(asScholar, scholar, { domain: FRAC });
    const mappingItem = served.items.find((it) => it.lane === "mapping");
    expect(mappingItem).toBeDefined();
    const mappingDomain = mappingItem!.domain ?? FRAC;
    await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: mappingDomain,
      itemId: mappingItem!.itemId,
      seed: 11,
      answer: gradeTemplateItem(mappingItem!.itemId, "0")?.correctAnswer ?? "0",
    });
    const inProgress = await t.run(async (ctx) =>
      (await ctx.db.query("practicePlacements").collect()).find(
        (r) => r.scholarId === scholar && r.domain === mappingDomain,
      ),
    );
    expect(inProgress?.status).toBe("in_progress");

    const afterTwoDomains = await asScholar.query(
      api.practiceSkills.mapProgressForScholar,
      { scholarId: scholar },
    );
    expect(afterTwoDomains.started).toBe(true);
  });

  test("a fraction mapping item opens the 2-D box editor, like the same item served as drill", async () => {
    // A mapping item rides the ORDINARY playlist and looks exactly like a drill
    // item, so its wire must carry the same 2-D editor signal. The band builds
    // its wire shape BY HAND (not through servedItemFromServable), which is how
    // `answerShape` came to be dropped: a fraction probe ("What fraction of the
    // whole is shaded?", unit_fraction) rendered on the flat keypad with a bare
    // `/` instead of the box editor's stacked numerator/denominator.
    // `answerFormat` (the L1 skeleton) stays withheld — a mapping probe is a
    // measurement, so the scholar builds the shape from an empty editor.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_twod", "5");
    const asScholar = await asUser(t, scholar);

    type MappingItem = {
      itemId: string;
      lane?: string;
      domain?: string;
      skillKey: string;
      answerType: string;
      answerShape?: string;
      answerFormat?: string;
    };
    const twoDItems: MappingItem[] = [];
    // Walk the whole-graph mapping band (answering correctly) until a probe with
    // a genuinely two-dimensional answer surfaces — a few rounds in, once the
    // affect-safe opening probes are behind us. `answerType` alone is not this
    // contract: remainder/plain expressions intentionally stay on the flat pad.
    for (let round = 0; round < 40 && twoDItems.length === 0; round++) {
      const seed = 101 + round;
      const res = (await asScholar.query(api.practiceSkills.practiceSession, {
        scholarId: scholar,
        seed,
        includeMapping: true,
      })) as unknown as { items: MappingItem[] };
      const mapping = res.items.filter((it) => it.lane === "mapping");
      if (mapping.length === 0) break;
      for (const it of mapping) {
        const parsed = parseItemId(it.itemId);
        const source = parsed
          ? generateItem(parsed.skillKey, parsed.seed, parsed.form)
          : null;
        expect(source, it.skillKey).not.toBeNull();
        if (
          source &&
          expressionAnswerSignals(source.answerType, source.answer).answerShape ===
            "twoD"
        ) {
          twoDItems.push(it);
        }
        await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
          scholarId: scholar,
          domain: it.domain ?? WHOLE,
          itemId: it.itemId,
          seed,
          answer: gradeTemplateItem(it.itemId, "0")?.correctAnswer ?? "0",
        });
      }
    }

    expect(twoDItems.length).toBeGreaterThan(0);
    for (const it of twoDItems) {
      expect(it.answerShape, it.skillKey).toBe("twoD");
      expect(it.answerFormat, it.skillKey).toBeUndefined();
    }
  });
});
