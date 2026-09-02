import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeRank } from "../lib/practice/placement";
import { gradeTemplateItem } from "../lib/practice/session";

// Fix lane (pilot9 blind findings — evidence PR #1022). Option D folded placement
// mapping INTO the daily drill, but the You Pick EXPLICIT-domain entry still
// (F1) routed to the retired standalone placement gate, and the mapping
// preview/serve (F2) composed for the GLOBAL next-unmapped domain instead of the
// SELECTED one. F3 is the batch-boundary IDK reveal swallow. These lock the
// SERVER contract both frontends depend on.

const WHOLE = "whole-number-arithmetic";
const FRAC = "fraction-arithmetic";
const PROB = "probability";
const RATIO = "ratio-proportion-percent";

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob(
  "../**/*.ts",
);

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
  gradeLevel?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "YouPick Scholar",
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

/** The first seeded strand of a domain — a valid `choiceHint.strand` value. */
async function aStrandOf(t: ReturnType<typeof convexTest>, domain: string) {
  return await t.run(async (ctx) => {
    const n = await ctx.db
      .query("knowledgeNodes")
      .filter((q) => q.eq(q.field("domain"), domain))
      .first();
    return n?.strand ?? "concept";
  });
}

type ServedItem = { itemId: string; lane?: string; domain?: string; skillKey: string; skillLabel: string };
type Served = { items: ServedItem[]; allMapping: boolean };

async function serve(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  args: { domain: string; choiceHint?: { domain: string; strand: string }; seed?: number },
): Promise<Served> {
  return (await asScholar.query(api.practiceSkills.practiceSession, {
    scholarId,
    seed: args.seed ?? 7,
    includeMapping: true,
    domain: args.domain,
    ...(args.choiceHint ? { choiceHint: args.choiceHint } : {}),
  })) as unknown as Served;
}

type PreviewRow = { key: string; label: string; reason: string };
type Preview = { set: PreviewRow[]; mappingPreview: boolean; allMapping: boolean };

async function preview(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  args: { domain?: string; choiceHint?: { domain: string; strand: string } },
): Promise<Preview> {
  return (await asScholar.query(api.practiceSkills.playlistForScholar, {
    scholarId,
    includeMapping: true,
    ...(args.domain ? { domain: args.domain } : {}),
    ...(args.choiceHint ? { choiceHint: args.choiceHint } : {}),
  })) as unknown as Preview;
}

const mappingLabels = (rows: { label: string; reason: string }[]) =>
  rows.filter((r) => r.reason === "mapping").map((r) => r.label);

/** Answer every whole-number mapping item until the domain finishes placing. */
async function mapWholeToDone(asScholar: Awaited<ReturnType<typeof asUser>>, scholarId: Id<"users">) {
  for (let i = 0; i < 60; i++) {
    const res = await serve(asScholar, scholarId, { domain: WHOLE, seed: 11 + i });
    const mapping = res.items.filter((it) => it.lane === "mapping" && (it.domain ?? WHOLE) === WHOLE);
    if (mapping.length === 0) break;
    for (const it of mapping) {
      await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
        scholarId,
        domain: WHOLE,
        itemId: it.itemId,
        seed: 11 + i,
        answer: gradeTemplateItem(it.itemId, "0")?.correctAnswer ?? "0",
      });
    }
  }
}

/** Mark every domain but `targetDomain` MAPPED. Since finish-the-check-in
 *  (founder 2026-08-18) "mapped" means a CONVERGED placement run, so this seeds
 *  a `complete` row alongside the mastery a real finalize would have written —
 *  mastery alone is shadow placement, which is deliberately still searched. */
async function markEveryDomainExceptDone(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  targetDomain: string,
) {
  await t.run(async (ctx) => {
    const firstNodeByDomain = new Map<
      string,
      Doc<"knowledgeNodes">
    >();
    for (const node of await ctx.db.query("knowledgeNodes").collect()) {
      if (!firstNodeByDomain.has(node.domain)) {
        firstNodeByDomain.set(node.domain, node);
      }
    }
    for (const [domain, node] of firstNodeByDomain) {
      if (domain === targetDomain) continue;
      await ctx.db.insert("practiceMastery", {
        scholarId,
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
        scholarId,
        domain,
        status: "complete",
        probesAnswered: 1,
        probeLog: [
          { nodeKey: node.nodeKey, strand: node.strand ?? "", outcome: "correct", at: Date.now() },
        ],
        updatedAt: Date.now(),
      });
    }
  });
}

describe("Fix lane — You Pick mapping entry (server contract)", () => {
  test("automatic opening grade-gates a high-floor domain, while age-appropriate and deliberate entries still open", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});

    const younger = await seedScholar(t, "automatic_grade_gate", "Grade 3");
    const asYounger = await asUser(t, younger);
    await markEveryDomainExceptDone(t, younger, RATIO);

    const ratioNodes = await t.run(async (ctx) =>
      ctx.db
        .query("knowledgeNodes")
        .filter((q) => q.eq(q.field("domain"), RATIO))
        .collect(),
    );
    const ratioRanks = ratioNodes
      .map((node) => gradeRank(node.grade ?? ""))
      .filter((rank) => rank >= 0);
    expect(ratioRanks.length).toBe(ratioNodes.length);
    expect(Math.min(...ratioRanks)).toBeGreaterThan(gradeRank("3") + 2);

    // All cross-domain prerequisites are complete, but the default entry must
    // not auto-open a domain whose whole graph sits above the initial ring.
    const automatic = await serve(asYounger, younger, { domain: WHOLE });
    expect(automatic.items.some((item) => item.lane === "mapping")).toBe(false);
    expect(
      await asYounger.query(api.practiceSkills.needsAnyPlacement, {
        scholarId: younger,
      }),
    ).toBe(false);
    expect(
      await asYounger.query(api.practiceSkills.mappingPlaylistState, {
        scholarId: younger,
      }),
    ).toMatchObject({ hasMapping: false, allMapping: false });

    // A deliberate upward pick remains available and uses the existing gentle
    // floor probe rather than turning the recommendation into a hard lock.
    const ratioStrand = await aStrandOf(t, RATIO);
    const deliberate = await serve(asYounger, younger, {
      domain: RATIO,
      choiceHint: { domain: RATIO, strand: ratioStrand },
    });
    expect(deliberate.items.some((item) => item.lane === "mapping")).toBe(true);
    expect(
      deliberate.items
        .filter((item) => item.lane === "mapping")
        .every((item) => (item.domain ?? RATIO) === RATIO),
    ).toBe(true);
    const firstDeliberate = deliberate.items.find(
      (item) => item.lane === "mapping",
    )!;
    await asYounger.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: younger,
      domain: RATIO,
      itemId: firstDeliberate.itemId,
      seed: 7,
      answer:
        gradeTemplateItem(firstDeliberate.itemId, "0")?.correctAnswer ?? "0",
    });

    // Once the deliberate entry opens a run, the default path resumes it instead
    // of applying the automatic-opening gate retroactively.
    expect(
      await asYounger.query(api.practiceSkills.needsAnyPlacement, {
        scholarId: younger,
      }),
    ).toBe(true);
    const resumed = await serve(asYounger, younger, { domain: WHOLE });
    const resumedMapping = resumed.items.filter(
      (item) => item.lane === "mapping",
    );
    expect(resumedMapping.length).toBeGreaterThan(0);
    expect(
      resumedMapping.every((item) => item.domain === RATIO),
    ).toBe(true);

    // The same grade-3 scholar still auto-opens a domain with an entry inside
    // the ring once its ordinary prerequisites are complete.
    const ageAppropriate = await seedScholar(
      t,
      "automatic_grade_gate_positive",
      "3",
    );
    const asAgeAppropriate = await asUser(t, ageAppropriate);
    await markEveryDomainExceptDone(t, ageAppropriate, FRAC);
    const allowed = await serve(asAgeAppropriate, ageAppropriate, {
      domain: WHOLE,
    });
    const allowedMapping = allowed.items.filter(
      (item) => item.lane === "mapping",
    );
    expect(allowedMapping.length).toBeGreaterThan(0);
    expect(
      allowedMapping.every((item) => (item.domain ?? FRAC) === FRAC),
    ).toBe(true);
    expect(
      await asAgeAppropriate.query(api.practiceSkills.needsAnyPlacement, {
        scholarId: ageAppropriate,
      }),
    ).toBe(true);
  });

  // ── F1 ────────────────────────────────────────────────────────────────────
  test("F1: a You Pick of an unmapped, prereq-gated domain serves THAT domain's mapping (scoped ceremony), never the global foundational set", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "youpick_f1");
    const asScholar = await asUser(t, scholar);
    const fracStrand = await aStrandOf(t, FRAC);

    // The DEFAULT entry (no pick) maps the foundational domain (whole-number):
    // fractions is prereq-gated behind it.
    const def = await serve(asScholar, scholar, { domain: WHOLE });
    expect(def.items.length).toBeGreaterThan(0);
    expect(def.items.every((it) => it.lane === "mapping")).toBe(true);
    expect(def.items.every((it) => (it.domain ?? WHOLE) === WHOLE)).toBe(true);

    // A DELIBERATE You Pick of fractions (choiceHint === the picked domain) serves
    // FRACTION mapping — scoped to the pick even though its prereqs aren't placed —
    // as an all-mapping ceremony. This is exactly the serve path the web/native
    // You Pick entry routes through (includeMapping + domain + choiceHint), so the
    // old standalone placement gate is never reached.
    const picked = await serve(asScholar, scholar, {
      domain: FRAC,
      choiceHint: { domain: FRAC, strand: fracStrand },
    });
    expect(picked.items.length).toBeGreaterThan(0);
    expect(picked.items.every((it) => it.lane === "mapping")).toBe(true);
    expect(picked.items.every((it) => (it.domain ?? FRAC) === FRAC)).toBe(true);
    expect(picked.allMapping).toBe(true);
    // Never the global foundational (whole-number) set the old preview showed.
    expect(picked.items.some((it) => (it.domain ?? "") === WHOLE)).toBe(false);
  });

  // ── F2 ────────────────────────────────────────────────────────────────────
  test("F2: playlistForScholar previews the SELECTED domain's mapping (differs per tile) and matches what Start serves, label-for-label", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "youpick_f2");
    const asScholar = await asUser(t, scholar);
    const fracStrand = await aStrandOf(t, FRAC);
    const probStrand = await aStrandOf(t, PROB);

    // Default (no-selection) preview → the global foundational domain.
    const defPrev = await preview(asScholar, scholar, {});
    // Two DIFFERENT unmapped-domain picks preview DIFFERENT, non-empty sets.
    const fracPrev = await preview(asScholar, scholar, {
      domain: FRAC,
      choiceHint: { domain: FRAC, strand: fracStrand },
    });
    const probPrev = await preview(asScholar, scholar, {
      domain: PROB,
      choiceHint: { domain: PROB, strand: probStrand },
    });

    expect(fracPrev.mappingPreview).toBe(true);
    expect(probPrev.mappingPreview).toBe(true);
    const fracPrevLabels = mappingLabels(fracPrev.set);
    const probPrevLabels = mappingLabels(probPrev.set);
    const defPrevLabels = mappingLabels(defPrev.set);
    expect(fracPrevLabels.length).toBeGreaterThan(0);
    expect(probPrevLabels.length).toBeGreaterThan(0);
    // Different tiles no longer all preview the same (fraction) skills.
    expect(fracPrevLabels).not.toEqual(defPrevLabels);
    expect(fracPrevLabels).not.toEqual(probPrevLabels);

    // Preview == Start: the fraction pick's previewed labels equal the served
    // mapping labels (byte-faithful stand-in, seed-independent skill selection).
    const fracServe = await serve(asScholar, scholar, {
      domain: FRAC,
      choiceHint: { domain: FRAC, strand: fracStrand },
      seed: 99,
    });
    const fracServeLabels = fracServe.items
      .filter((it) => it.lane === "mapping")
      .map((it) => it.skillLabel);
    expect(fracPrevLabels).toEqual(fracServeLabels);
  });

  // ── F2 (exact production shape — the qbwalk3 live-walk regression) ──────────
  // The live failure: a scholar with the FOUNDATIONAL domain (whole-number)
  // PLACED and everything else unmapped picked "Reading Data Displays"
  // (probability / data-displays) — the real URL
  // `/scholar/practice?choiceDomain=probability&choiceStrand=data-displays&domain=probability`.
  // Probability is prereq-gated behind fraction (`fraction_as_parts →
  // probability_as_fraction`), so it is NOT in `eligibleUnmapped`, and without
  // `forceLeadDomain` scoping the composition fell back to the GLOBAL priority
  // (fraction). This case asserts the SELECTED domain leads on BOTH preview and
  // serve for the exact three-arg production shape (`domain` + `choiceHint`
  // {domain, strand} + `includeMapping`), even though its cross-domain prereq is
  // unplaced and a placed foundational domain competes.
  test("F2 (prod shape): foundational placed + a prereq-gated You Pick leads with the SELECTED domain, not the global fallback", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "youpick_f2_prod");
    const asScholar = await asUser(t, scholar);

    // Place ONLY whole-number (the foundational domain) — fraction + probability
    // stay unmapped, and probability is prereq-gated behind the unmapped fraction.
    await mapWholeToDone(asScholar, scholar);
    const wholePlaced = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).some(
        (r) => r.scholarId === scholar && r.domain === WHOLE,
      ),
    );
    expect(wholePlaced).toBe(true);

    // SERVE — the exact production arg shape (domain + choiceHint + includeMapping).
    const served = await serve(asScholar, scholar, {
      domain: PROB,
      choiceHint: { domain: PROB, strand: "data-displays" },
      seed: 7,
    });
    const servedMappingDomains = new Set(
      served.items.filter((it) => it.lane === "mapping").map((it) => it.domain ?? PROB),
    );
    expect(served.items.some((it) => it.lane === "mapping")).toBe(true);
    // The SELECTED (probability) domain leads the mapping composition — never the
    // global foundational fallback (fraction) the stale path served.
    expect([...servedMappingDomains]).toEqual([PROB]);
    expect(served.items.some((it) => (it.domain ?? "") === FRAC)).toBe(false);

    // PREVIEW — the same three-arg shape the Home tile's `choicePreview` sends.
    const prev = await preview(asScholar, scholar, {
      domain: PROB,
      choiceHint: { domain: PROB, strand: "data-displays" },
    });
    expect(prev.mappingPreview).toBe(true);
    const prevLabels = mappingLabels(prev.set);
    const servedLabels = served.items.filter((it) => it.lane === "mapping").map((it) => it.skillLabel);
    expect(prevLabels.length).toBeGreaterThan(0);
    // Preview == Start, label-for-label, for the exact production shape.
    expect(prevLabels).toEqual(servedLabels);
  });

  // ── F3 ────────────────────────────────────────────────────────────────────
  test("F3: an answer on a STALE `· mapping` probe (its domain already placed) still returns a graded reveal — never a bare no-op that swallows the acknowledgement", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "youpick_f3");
    const asScholar = await asUser(t, scholar);

    // Capture a whole-number mapping probe from a batch (a DISTINCT seed so it is
    // NOT itself answered while we finish placing the domain below).
    const batch = await serve(asScholar, scholar, { domain: WHOLE, seed: 777 });
    const stale = batch.items.find((it) => it.lane === "mapping" && (it.domain ?? WHOLE) === WHOLE);
    expect(stale).toBeTruthy();

    // Finish placing whole-number (a sibling would converge it mid-batch); its
    // mastery rows now exist, so the captured probe is STALE.
    await mapWholeToDone(asScholar, scholar);
    const mastered = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).some(
        (r) => r.scholarId === scholar && r.domain === WHOLE,
      ),
    );
    expect(mastered).toBe(true);

    // Answering the stale probe with "I haven't learned this yet" MUST still grade
    // + reveal (so the client shows "The answer was …" before recomposing), and
    // credit nothing new (no double-placement).
    const graded = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      itemId: stale!.itemId,
      seed: 777,
      dontKnow: true,
    });
    expect(graded.alreadyMapped).toBe(true);
    expect(graded.outcome).toBe("unknown");
    expect(typeof graded.correctAnswer).toBe("string");
    expect((graded.correctAnswer ?? "").length).toBeGreaterThan(0);
    expect(graded.domainJustMapped).toBe(false);

    // And a truly unresolvable / cross-domain id stays a bare no-op (nothing to
    // reveal) — the split the client relies on to recompose silently.
    const bogus = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      itemId: "not-a-real-item::0",
      seed: 777,
      dontKnow: true,
    });
    expect(bogus.alreadyMapped).toBe(true);
    expect(bogus.outcome).toBeNull();
    expect(bogus.correctAnswer).toBeNull();
  });

  test("a REACHABLE above-ring domain's newTerritoryCards sample matches exactly what the deliberate-pick serve path opens", async () => {
    // Raise-the-ceiling: the card's (domain, strand, sampleSkillKey) comes from
    // the SAME `mappingCandidatesForDomain` derivation the `forceLeadDomain`
    // serve branch scans — so a You-Pick tap on this card can never open a
    // different first probe than the one it advertised.
    const ALGEBRA1 = "algebra-1";
    const A1_PREREQS = [
      WHOLE,
      FRAC,
      "geometry-measurement",
      RATIO,
      "integers-coordinates",
      "early-algebra",
    ];
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "youpick_reachable_ceiling", "4");
    const asScholar = await asUser(t, scholar);
    await t.run(async (ctx) => {
      const nodes = await ctx.db.query("knowledgeNodes").collect();
      for (const domain of A1_PREREQS) {
        const own = nodes.filter((n) => n.domain === domain);
        for (const node of own) {
          await ctx.db.insert("practiceMastery", {
            scholarId: scholar,
            skillKey: node.nodeKey,
            domain,
            strand: node.strand,
            repetition: 3,
            halfLifeDays: 30,
            lastPracticedAt: Date.now(),
            frontier: false,
            source: "placement",
            updatedAt: Date.now(),
          });
        }
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain,
          status: "complete",
          probesAnswered: 1,
          probeLog: [
            { nodeKey: own[0].nodeKey, strand: own[0].strand ?? "", outcome: "correct", at: Date.now() },
          ],
          updatedAt: Date.now(),
        });
      }
    });

    const cards = await asScholar.query(api.practiceSkills.newTerritoryCards, {});
    const a1Card = cards.find((c) => c.domain === ALGEBRA1);
    expect(a1Card).toBeTruthy();

    // Deliberately pick it, exactly as the frontend's Start action would.
    const deliberate = await serve(asScholar, scholar, {
      domain: ALGEBRA1,
      choiceHint: { domain: ALGEBRA1, strand: a1Card!.strand },
    });
    const firstMapping = deliberate.items.find((it) => it.lane === "mapping");
    expect(firstMapping).toBeTruthy();
    expect(firstMapping!.skillKey).toBe(a1Card!.sampleSkillKey);
    expect(firstMapping!.domain ?? ALGEBRA1).toBe(ALGEBRA1);

    // The map now agrees the domain is `in_flight`, not merely `reachable`.
    await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: ALGEBRA1,
      itemId: firstMapping!.itemId,
      seed: 7,
      answer: gradeTemplateItem(firstMapping!.itemId, "0")?.correctAnswer ?? "0",
    });
    const map = await asScholar.query(api.practiceSkills.domainMapForScholar, {
      scholarId: scholar,
    });
    expect(map.find((d) => d.domain === ALGEBRA1)?.status).toBe("in_flight");
  });
});
