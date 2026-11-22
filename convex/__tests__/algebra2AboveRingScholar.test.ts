import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import { ALGEBRA_2_EDGES, ALGEBRA_2_SKILLS } from "../seed/algebra2Graph";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

// Algebra 2 for a scholar far above her enrolled grade (fictional fixture).
// A grade-4 scholar on a LIMITED Math plan of six domains, whose Algebra 1
// check-in is complete: the linear, systems and exponent strands are
// placement-credited, factoring and quadratics are not started. A teacher adds
// algebra-2 to her plan through the ordinary plan mutation. These tests walk
// what happens next, in order, through the real serve and grade paths.

const ALGEBRA2 = "algebra-2";
// Every core domain below Algebra 1 her check-in mapped (probability included,
// so nothing else is left to map and Home's check-in prompt is about algebra-2
// alone).
const BELOW_ALGEBRA_1 = [
  "whole-number-arithmetic",
  "fraction-arithmetic",
  "probability",
  "geometry-measurement",
  "ratio-proportion-percent",
  "integers-coordinates",
  "early-algebra",
];
const CREDITED_ALGEBRA_1_STRANDS = new Set([
  "linear-equations",
  "linear-functions",
  "systems",
  "exponents-exponential",
]);
const PLAN_BEFORE = [
  "whole-number-arithmetic",
  "fraction-arithmetic",
  "ratio-proportion-percent",
  "integers-coordinates",
  "early-algebra",
  "algebra-1",
];
// The five strands with an entrance whose prerequisites she already holds.
const OPEN_STRANDS = [
  "functions",
  "complex-quadratics",
  "radicals-rational-exponents",
  "exponential-logarithmic",
  "sequences-series",
];

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

let sharedT: TestConvex<typeof schema>;
beforeAll(async () => {
  sharedT = convexTest(schema, modules);
  await sharedT.mutation(internal.practiceSkills.seedGraph, {});
});

async function asUser(t: TestConvex<typeof schema>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: 8_000_000_000_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

const strandOf = new Map(ALGEBRA_2_SKILLS.map((s) => [s.skillKey, s.strand]));
const alg2Keys = new Set(ALGEBRA_2_SKILLS.map((s) => s.skillKey));

/** The fictional scholar, her teacher, and her history before algebra-2. */
async function seedAboveRingScholar(t: TestConvex<typeof schema>, tag: string) {
  const institutionId = await seedTestInstitution(t, { slug: `alg2-above-ring-${tag}` });
  const teacher = await seedStaffWithMembership(t, {
    institutionId,
    username: `alg2_teacher_${tag}`,
  });
  const scholar = await seedScholarInInstitution(t, {
    institutionId,
    username: `alg2_scholar_${tag}`,
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(scholar, { gradeLevel: "4" });
    const nodes = await ctx.db.query("knowledgeNodes").collect();
    const now = Date.now();
    for (const domain of [...BELOW_ALGEBRA_1, "algebra-1"]) {
      const own = nodes.filter((n) => n.domain === domain);
      for (const node of own) {
        const credited =
          domain !== "algebra-1" || CREDITED_ALGEBRA_1_STRANDS.has(node.strand ?? "");
        if (!credited) continue;
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: node.nodeKey,
          domain,
          strand: node.strand,
          repetition: FLUENT_REPS,
          halfLifeDays: 30,
          lastPracticedAt: now,
          frontier: false,
          source: "placement",
          updatedAt: now,
        });
      }
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain,
        status: "complete",
        probesAnswered: 1,
        probeLog: [
          { nodeKey: own[0].nodeKey, strand: own[0].strand ?? "", outcome: "correct", at: now },
        ],
        updatedAt: now,
      });
    }
  });
  const asTeacher = await asUser(t, teacher);
  await asTeacher.mutation(api.mathPlans.saveForScholar, {
    scholarId: scholar,
    practiceScope: { kind: "limited", domains: PLAN_BEFORE.map((domain) => ({ domain })) },
    checkpoint: null,
  });
  return { teacher, scholar, asTeacher, asScholar: await asUser(t, scholar) };
}

async function addAlgebra2ToPlan(
  asTeacher: Awaited<ReturnType<typeof asUser>>,
  scholar: Id<"users">,
) {
  await asTeacher.mutation(api.mathPlans.saveForScholar, {
    scholarId: scholar,
    practiceScope: {
      kind: "limited",
      domains: [...PLAN_BEFORE, ALGEBRA2].map((domain) => ({ domain })),
    },
    checkpoint: null,
  });
}

/** A submission the server grades correct: the canonical answer, or for a
 *  multiple-choice item the right choice index. */
function rightAnswer(itemId: string): string {
  const canonical = gradeTemplateItem(itemId, "0")?.correctAnswer ?? "0";
  for (const candidate of [canonical, "0", "1", "2", "3", "4", "5"]) {
    if (gradeTemplateItem(itemId, candidate)?.correct === true) return candidate;
  }
  throw new Error(`no correct submission found for ${itemId}`);
}

type ServedItem = { itemId: string; lane?: string; domain?: string; skillKey: string };

/** Run the deliberate Algebra 2 mapping to convergence. `answerCorrect`
 *  decides each probe; everything else is "I don't know". */
async function mapAlgebra2(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholar: Id<"users">,
  strand: string,
  answerCorrect: (skillKey: string, firstInStrand: boolean) => boolean,
) {
  const probes: { skillKey: string; strand: string; correct: boolean; outcome: string | null }[] = [];
  const seenStrands = new Set<string>();
  for (let round = 0; round < 80; round++) {
    const served = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 500 + round,
      includeMapping: true,
      domain: ALGEBRA2,
      choiceHint: { domain: ALGEBRA2, strand },
    })) as unknown as { items: ServedItem[] };
    const mapping = served.items.filter((it) => it.lane === "mapping" && (it.domain ?? ALGEBRA2) === ALGEBRA2);
    if (mapping.length === 0) break;
    for (const it of mapping) {
      const s = strandOf.get(it.skillKey) ?? "?";
      const first = !seenStrands.has(s);
      seenStrands.add(s);
      const correct = answerCorrect(it.skillKey, first);
      const res = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
        scholarId: scholar,
        domain: ALGEBRA2,
        itemId: it.itemId,
        seed: 500 + round,
        ...(correct
          ? { answer: rightAnswer(it.itemId) }
          : { dontKnow: true }),
      });
      probes.push({ skillKey: it.skillKey, strand: s, correct, outcome: (res as { outcome: string | null }).outcome });
      if ((res as { alreadyMapped?: boolean }).alreadyMapped) break;
    }
  }
  return probes;
}

async function masteryOf(t: TestConvex<typeof schema>, scholar: Id<"users">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("practiceMastery").collect()).filter((r) => r.scholarId === scholar),
  );
}

/** Structural frontier: an algebra-2 node not yet access-proven whose every
 *  buildsOn prerequisite (in any domain) is. */
function frontierOf(rows: Doc<"practiceMastery">[]) {
  const proven = new Set(rows.filter((r) => r.repetition >= FLUENT_REPS).map((r) => r.skillKey));
  const prereqs = new Map<string, string[]>();
  for (const e of ALGEBRA_2_EDGES) prereqs.set(e.toKey, [...(prereqs.get(e.toKey) ?? []), e.fromKey]);
  return ALGEBRA_2_SKILLS.map((s) => s.skillKey)
    .filter((k) => !proven.has(k) && (prereqs.get(k) ?? []).every((p) => proven.has(p)))
    .sort();
}

/** Every cross-domain prerequisite edge into a CREDITED algebra-2 node whose
 *  lower-domain source is NOT access-proven: credit that crossed an unmet
 *  prerequisite. */
function leaks(rows: Doc<"practiceMastery">[]) {
  const proven = new Set(rows.filter((r) => r.repetition >= FLUENT_REPS).map((r) => r.skillKey));
  return ALGEBRA_2_EDGES.filter(
    (e) => !alg2Keys.has(e.fromKey) && proven.has(e.toKey) && !proven.has(e.fromKey),
  ).map((e) => `${e.fromKey} -> ${e.toKey}`);
}

const ALL_STRANDS = [...OPEN_STRANDS, "polynomials", "rational"].sort();
const credited = (rows: Doc<"practiceMastery">[]) =>
  rows
    .filter((r) => r.domain === ALGEBRA2 && r.repetition >= FLUENT_REPS)
    .map((r) => r.skillKey)
    .sort();

async function openAlgebra2(tag: string) {
  const t = sharedT;
  const fixture = await seedAboveRingScholar(t, tag);
  await addAlgebra2ToPlan(fixture.asTeacher, fixture.scholar);
  const card = (await fixture.asScholar.query(api.practiceSkills.newTerritoryCards, {})).find(
    (c) => c.domain === ALGEBRA2,
  )!;
  return { t, ...fixture, card };
}

describe("algebra-2 for a grade-4 scholar on a limited Math plan", () => {
  test("adding algebra-2 to the plan offers a new-territory tile, never an automatic check-in", async () => {
    const t = sharedT;
    const { scholar, asTeacher, asScholar } = await seedAboveRingScholar(t, "offer");

    // Before: outside her plan, so no tile.
    const before = await asScholar.query(api.practiceSkills.newTerritoryCards, {});
    expect(before.some((c) => c.domain === ALGEBRA2)).toBe(false);

    await addAlgebra2ToPlan(asTeacher, scholar);

    // No "Start check-in": algebra-2 is above her grade ring, so it is not in
    // the map she owes and nothing automatic serves it. Her map stays complete.
    const progress = await asScholar.query(api.practiceSkills.mapProgressForScholar, { scholarId: scholar });
    const map = await asScholar.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar });
    expect(map.find((d) => d.domain === ALGEBRA2)).toMatchObject({ status: "ineligible", eligible: false });
    expect(progress).toMatchObject({ hasServable: false, allMapped: true });
    expect(await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar })).toBe(false);

    // Instead Home offers the Algebra 2 tile, sampling a strand she can open.
    const card = (await asScholar.query(api.practiceSkills.newTerritoryCards, {})).find(
      (c) => c.domain === ALGEBRA2,
    );
    expect(card).toBeTruthy();
    expect(OPEN_STRANDS).toContain(card!.strand);
  });

  test("tapping the tile opens the run; from the first answer it is her check-in", async () => {
    const { scholar, asScholar, card } = await openAlgebra2("first-probe");
    const served = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 41,
      includeMapping: true,
      domain: ALGEBRA2,
      choiceHint: { domain: ALGEBRA2, strand: card.strand },
    })) as unknown as { items: ServedItem[] };
    const first = served.items.find((it) => it.lane === "mapping")!;
    expect(first.skillKey).toBe(card.sampleSkillKey);
    await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: ALGEBRA2,
      itemId: first.itemId,
      seed: 41,
      dontKnow: true,
    });
    const map = await asScholar.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar });
    expect(map.find((d) => d.domain === ALGEBRA2)).toMatchObject({ status: "in_flight", eligible: true });
    expect(await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar })).toBe(true);
  });

  test("worst case (knows nothing): seven probes, one per strand, nothing credited", async () => {
    const { t, scholar, asScholar, card } = await openAlgebra2("worst");
    const probes = await mapAlgebra2(asScholar, scholar, card.strand, () => false);
    // One probe per strand, the bottom node of each, including the polynomial
    // and rational roots, whose Algebra 1 prerequisites she has not met.
    expect(probes.map((p) => p.skillKey).sort()).toEqual([
      "cx_imaginary_unit",
      "exp_solve_common_base",
      "fn_domain_range_graph",
      "poly_end_behavior",
      "rat_excluded_values",
      "rexp_convert",
      "seq_arithmetic_explicit",
    ]);
    expect([...new Set(probes.map((p) => p.strand))].sort()).toEqual(ALL_STRANDS);
    const all = await masteryOf(t, scholar);
    expect(credited(all)).toEqual([]);
    // Frontier: every entrance whose prerequisites she holds; nothing in the
    // polynomial or rational strands.
    expect(frontierOf(all)).toEqual([
      "cx_imaginary_unit",
      "exp_solve_common_base",
      "fn_avg_rate_of_change",
      "fn_compose",
      "fn_domain_range_graph",
      "rad_add_multiply",
      "rexp_convert",
      "seq_arithmetic_explicit",
    ]);
    const map = await asScholar.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar });
    expect(map.find((d) => d.domain === ALGEBRA2)?.status).toBe("converged");
  });

  test("the five entrance strands' first probes right, then nothing: twelve probes, the entrances credited", async () => {
    const { t, scholar, asScholar, card } = await openAlgebra2("entrances");
    const probes = await mapAlgebra2(asScholar, scholar, card.strand, (k, first) =>
      first && OPEN_STRANDS.includes(strandOf.get(k) ?? ""),
    );
    expect(probes).toHaveLength(12);
    expect(probes.filter((p) => p.correct).every((p) => p.outcome === "correct")).toBe(true);
    const all = await masteryOf(t, scholar);
    expect(credited(all)).toEqual([
      "cx_imaginary_unit",
      "exp_solve_common_base",
      "fn_domain_range_graph",
      "rexp_convert",
      "seq_arithmetic_explicit",
    ]);
    expect(frontierOf(all)).toEqual([
      "cx_add_subtract",
      "cx_plane_plot",
      "fn_avg_rate_of_change",
      "fn_compose",
      "fn_piecewise_evaluate",
      "log_definition",
      "rad_add_multiply",
      "rexp_evaluate",
      "seq_geometric_explicit",
      "series_sigma_notation",
    ]);
    expect(leaks(all)).toEqual([]);
  });

  test("every probe answered right: eighteen probes, inside the per-domain cap", async () => {
    const { scholar, asScholar, card } = await openAlgebra2("cap");
    const probes = await mapAlgebra2(asScholar, scholar, card.strand, () => true);
    expect(probes.every((p) => p.outcome === "correct")).toBe(true);
    expect(probes).toHaveLength(18);
    expect(probes.length).toBeLessThanOrEqual(25); // PLACEMENT_GLOBAL_CAP
  });

  // The check-in probes the bottom node of EVERY strand, including strands whose
  // Algebra 1 prerequisites are unmet. A probe answered correctly earns its
  // credit: nothing is inferred upward, and a scholar who can do the thing has
  // shown it (the engine recommends an order; it does not gate on one). The
  // consequence worth knowing: such a scholar can end up with Algebra 2
  // frontier nodes whose Algebra 1 prerequisites are still open.
  test("a correctly answered probe earns credit even past an unmet cross-domain prerequisite", async () => {
    const { t, scholar, asScholar, card } = await openAlgebra2("leak");
    await mapAlgebra2(asScholar, scholar, card.strand, () => true);
    expect(leaks(await masteryOf(t, scholar)).length).toBeGreaterThan(0);
  });
});

// Can Algebra 2 reach an OPEN-scope scholar by any path other than a teacher's
// plan or the scholar's own tap on the new-territory tile?
describe("algebra-2 for an open-scope scholar with Algebra 1 credit", () => {
  async function seedOpenScholar(tag: string, grade: string | null) {
    const t = sharedT;
    const institutionId = await seedTestInstitution(t, { slug: `alg2-open-${tag}` });
    const scholar = await seedScholarInInstitution(t, { institutionId, username: `alg2_open_${tag}` });
    await t.run(async (ctx) => {
      if (grade) await ctx.db.patch(scholar, { gradeLevel: grade });
      const nodes = await ctx.db.query("knowledgeNodes").collect();
      const now = Date.now();
      for (const domain of [...BELOW_ALGEBRA_1, "algebra-1"]) {
        const own = nodes.filter((n) => n.domain === domain);
        for (const node of own) {
          if (domain === "algebra-1" && !CREDITED_ALGEBRA_1_STRANDS.has(node.strand ?? "")) continue;
          await ctx.db.insert("practiceMastery", {
            scholarId: scholar,
            skillKey: node.nodeKey,
            domain,
            strand: node.strand,
            repetition: FLUENT_REPS,
            halfLifeDays: 30,
            lastPracticedAt: now,
            lastAttemptAt: now,
            frontier: false,
            source: "practice",
            updatedAt: now,
          });
        }
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain,
          status: "complete",
          probesAnswered: 1,
          probeLog: [{ nodeKey: own[0].nodeKey, strand: own[0].strand ?? "", outcome: "correct", at: now }],
          updatedAt: now,
        });
      }
    });
    return { scholar, as: await asUser(t, scholar) };
  }

  /** Every Algebra 2 node a surface would show her without her asking. */
  async function algebra2Exposure(as: Awaited<ReturnType<typeof asUser>>, scholar: Id<"users">) {
    const started = [...BELOW_ALGEBRA_1, "algebra-1"];
    const seen: string[] = [];
    const next = await as.query(api.practiceSkills.nextForScholar, { scholarId: scholar, limit: 40 });
    for (const e of next) if (alg2Keys.has(e.key)) seen.push(`next:${e.key}`);
    const playlist = (await as.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      includeMapping: true,
    })) as unknown as { set: { key: string }[] };
    for (const r of playlist.set) if (alg2Keys.has(r.key)) seen.push(`playlist:${r.key}`);
    // The auto-blend runs every domain she has started (app/scholar/practice).
    const blend = (await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 3,
      domains: started,
      includeMapping: true,
    })) as unknown as { items: ServedItem[]; challenge: ServedItem[] };
    for (const it of [...blend.items, ...blend.challenge]) {
      if (alg2Keys.has(it.skillKey)) seen.push(`blend:${it.skillKey}`);
    }
    for (const d of started) {
      const s = (await as.query(api.practiceSkills.practiceSession, { scholarId: scholar, seed: 4, domain: d })) as unknown as {
        items: ServedItem[];
        challenge: ServedItem[];
        stretch: ServedItem[];
      };
      for (const it of [...s.items, ...s.challenge, ...s.stretch]) {
        if (alg2Keys.has(it.skillKey)) seen.push(`${d}:${it.skillKey}`);
      }
    }
    // The domain switcher lists only started domains.
    const domains = await as.query(api.practiceSkills.domainsForScholar, { scholarId: scholar });
    if (domains.find((d) => d.domain === ALGEBRA2)!.started) seen.push("switcher:algebra-2");
    return seen;
  }

  test("enrolled grade 4: only the new-territory tile; never the blend, a run, You Pick or the switcher", async () => {
    const { scholar, as } = await seedOpenScholar("g4", "4");
    expect(await algebra2Exposure(as, scholar)).toEqual([]);
    const choice = await as.query(api.practiceSkills.choiceSetForSelf, {});
    expect(choice.some((c) => c.domain === ALGEBRA2)).toBe(false);
    const territory = await as.query(api.practiceSkills.newTerritoryCards, {});
    expect(territory.filter((c) => c.domain === ALGEBRA2).map((c) => c.strand)).toEqual(["complex-quadratics"]);
  });

  // FINDING (2026-11-20): with NO enrolled grade, the grade band has no base in
  // a domain where she holds nothing (`gradeBandCeiling` returns undefined, so
  // no band applies), and Algebra 2's open entrances count as ordinary
  // frontier: You Pick offers an "Algebra 2 · Functions" card. Still only a
  // choice she taps; it never enters the blend, a run or the switcher unasked.
  test("no grade on file: You Pick can offer an Algebra 2 card (a choice, never served unasked)", async () => {
    const { scholar, as } = await seedOpenScholar("nograde", null);
    expect(await algebra2Exposure(as, scholar)).toEqual([]);
    const choice = await as.query(api.practiceSkills.choiceSetForSelf, {});
    expect(choice.filter((c) => c.domain === ALGEBRA2).map((c) => c.strand)).toEqual(["functions"]);
  });
});
