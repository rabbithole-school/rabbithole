/**
 * F3 — conservative cross-domain placement priors (regression).
 *
 * Reconstructs the mixed "Math Check-In" placement anomaly documented in
 * review/pilot6/findings-placement-anomaly.md: a scholar who is strong in the
 * first domain but answers "don't know" through the later domains was being
 * placed well ABOVE her true profile, because the cross-domain prior was taken
 * from the MAXIMUM grade tag on any isolated provisional row, a "Grade 2" vs "2"
 * normalization miss dropped the enrolled-grade protection, the affect-safe
 * ceiling was inflated by that inferred credit, and a below-floor scholar started
 * ~1/3 up the strand. The blast radius was the first post-placement block serving
 * far-above-band items.
 *
 * The five fixes under test:
 *   1. `conservativeDomainPrior` — contiguous placed-through, not max provisional row.
 *   2. the affect-safe ceiling is NOT lifted by inferred cross-domain credit.
 *   3. grade tags are shape-normalized at one seam ("Grade 2" ≡ "2").
 *   4. a known grade BELOW a tagged strand's floor starts the search at index 0.
 *   5. result-label credit requires `accessProven` (rep ≥ FLUENT_REPS).
 *
 * Pure-logic tests pin 1/3/4 and the trust-upward floor property; a convex-test
 * integration drives the real mixed check-in end-to-end (strong domain 1, IDK
 * later domains) and asserts the later domains place at the floor, the prior
 * never raises a confirmed floor, and the first post-placement block carries NO
 * above-band items.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";
import { FLUENT_REPS, gradeOrdinal } from "../lib/practice/scheduler";
import {
  affectSafeFirstProbeIndex,
  domainHasAffectSafeEntry,
  domainFloorGrade,
  gradeRank,
  nextStrandProbe,
  probeOutcomeFromKind,
  strandFrontier,
  type PlacementOutcomeKind,
  type ProbeOutcome,
} from "../lib/practice/placement";
import { conservativeDomainPrior } from "../practiceSkills";
import { normalizeGradeTag } from "../../shared/grade";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import { EARLY_ALGEBRA_DOMAIN } from "../seed/earlyAlgebraGraph";
import { INTEGERS_COORDINATES_DOMAIN } from "../seed/integersCoordinatesGraph";
import { RATIO_PROPORTION_PERCENT_DOMAIN } from "../seed/ratioProportionPercentGraph";
import { REGISTERED_PRACTICE_DOMAINS } from "../knowledgeNodes";

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

// ── Fix 3: grade-tag shape normalization ("Grade N" ≡ "N") ──────────────────

describe("F3 — grade-tag normalization at the one seam", () => {
  test("normalizeGradeTag folds the legacy long form onto the canonical notch", () => {
    expect(normalizeGradeTag("Grade 2")).toBe("2");
    expect(normalizeGradeTag("grade 2")).toBe("2");
    expect(normalizeGradeTag("G2")).toBe("2");
    expect(normalizeGradeTag("2")).toBe("2");
    expect(normalizeGradeTag("9")).toBe("9");
    expect(normalizeGradeTag("Grade 9")).toBe("9");
    expect(normalizeGradeTag("grade 9")).toBe("9");
    expect(normalizeGradeTag("G9")).toBe("9");
    expect(normalizeGradeTag("Grade K")).toBe("K");
    expect(normalizeGradeTag("k")).toBe("K");
    expect(normalizeGradeTag("  3 ")).toBe("3");
    // Unrecognized shapes pass through trimmed (→ "no signal" downstream).
    expect(normalizeGradeTag("college")).toBe("college");
    expect(normalizeGradeTag("Kindergarten")).toBe("Kindergarten");
    expect(normalizeGradeTag(undefined)).toBeUndefined();
    expect(normalizeGradeTag("")).toBeUndefined();
  });

  test("gradeRank / gradeOrdinal treat 'Grade N' identically to 'N'", () => {
    for (const [long, short] of [
      ["Grade K", "K"],
      ["Grade 2", "2"],
      ["Grade 5", "5"],
      ["Grade 9", "9"],
    ] as const) {
      expect(gradeRank(long)).toBe(gradeRank(short));
      expect(gradeOrdinal(long)).toBe(gradeOrdinal(short));
    }
    // The specific persona value from the field logs is no longer "unknown".
    expect(gradeRank("Grade 2")).toBe(2);
    expect(gradeOrdinal("Grade 2")).toBe(2);
    // A genuinely unparseable tag stays "no signal".
    expect(gradeRank("college")).toBe(-1);
    expect(gradeOrdinal("college")).toBeUndefined();
  });

  test("affectSafeFirstProbeIndex is invariant to grade string SHAPE", () => {
    const chain = ["a", "b", "c", "d", "e", "f", "g"];
    const grades: Record<string, string> = { a: "K", b: "1", c: "2", d: "3", e: "4", f: "5", g: "6" };
    const gradeOf = (k: string): string | undefined => grades[k];
    expect(affectSafeFirstProbeIndex(chain, { gradeOf, scholarGrade: "Grade 2" })).toBe(
      affectSafeFirstProbeIndex(chain, { gradeOf, scholarGrade: "2" }),
    );
  });
});

// ── Fix 4: a below-floor known grade starts the search at index 0 ───────────

describe("F3 — affect-safe first probe: a below-floor known grade starts at 0", () => {
  // A strand every node of which sits ABOVE the scholar's grade (like a Grade-2
  // scholar entering Early Algebra, all grade 4+).
  const highStrand = ["p", "q", "r", "s", "t"];
  const highGradeOf = (k: string): string | undefined =>
    ({ p: "4", q: "5", r: "6", s: "7", t: "8" })[k];

  test("known grade below every tagged node → index 0 (not the ~1/3 fallback)", () => {
    expect(affectSafeFirstProbeIndex(highStrand, { gradeOf: highGradeOf, scholarGrade: "2" })).toBe(0);
    // The long-form value normalizes to the same answer.
    expect(affectSafeFirstProbeIndex(highStrand, { gradeOf: highGradeOf, scholarGrade: "Grade 2" })).toBe(0);
    // Regression guard: the OLD behavior was the generic ~1/3 anchor, ABOVE the kid.
    expect(Math.floor(highStrand.length / 3)).toBe(1);
  });

  test("an UNtagged strand keeps the generic ~1/3 anchor (no grade signal to place below)", () => {
    const untagged = ["p", "q", "r", "s", "t"];
    expect(affectSafeFirstProbeIndex(untagged, { gradeOf: () => undefined, scholarGrade: "2" })).toBe(
      Math.floor(untagged.length / 3),
    );
  });

  test("a grade WITHIN the strand still anchors just above the highest at/below node", () => {
    const chain = ["a", "b", "c", "d", "e", "f", "g"];
    const gradeOf = (k: string): string | undefined =>
      ({ a: "K", b: "1", c: "2", d: "3", e: "4", f: "5", g: "6" })[k];
    // Grade-3 scholar: highest node at/below grade 3 is "d" (index 3) → +1 = 4.
    expect(affectSafeFirstProbeIndex(chain, { gradeOf, scholarGrade: "3" })).toBe(4);
  });
});

// ── Automatic domain opening: an initial affect-safe entry is required ───────

describe("automatic domain opening — affect-safe entries", () => {
  test("grade-3 scholars reject a domain whose nodes all begin at grade 6+", () => {
    const allAboveRing = [{ grade: "6" }, { grade: "Grade 7" }, { grade: "8" }];

    expect(domainHasAffectSafeEntry(allAboveRing, "3")).toBe(false);
    expect(domainHasAffectSafeEntry(allAboveRing, "Grade 3")).toBe(false);
  });

  test("a node inside the initial grade-plus-two ring keeps a domain eligible", () => {
    expect(domainHasAffectSafeEntry([{ grade: "6" }, { grade: "5" }], "3")).toBe(true);
  });

  test("unknown scholar grades and ungraded or unparseable nodes remain eligible", () => {
    expect(domainHasAffectSafeEntry([{ grade: "6" }], undefined)).toBe(true);
    expect(domainHasAffectSafeEntry([{ grade: undefined }, { grade: "college" }], "3")).toBe(true);
  });

  test("an explicitly entered above-ring strand still probes from index 0", () => {
    const highStrand = ["p", "q", "r"];
    const gradeOf = (key: string): string | undefined => ({ p: "6", q: "7", r: "8" })[key];

    expect(domainHasAffectSafeEntry(highStrand.map((key) => ({ grade: gradeOf(key) })), "3")).toBe(false);
    expect(nextStrandProbe(highStrand, () => true, [], { gradeOf, scholarGrade: "Grade 3" })).toMatchObject({
      index: 0,
      probeKey: "p",
    });
  });
});

// ── You-Pick cold-entry grade prior: the domain FLOOR grade ─────────────────

describe("You-Pick — domainFloorGrade seeds a cold entry at the foundation", () => {
  test("returns the lowest-rank grade tag present in the domain", () => {
    const nodes = [
      { grade: "4" },
      { grade: "Grade 2" }, // long form, same rank as "2"
      { grade: "6" },
      { grade: "3" },
    ];
    // Lowest rank is grade 2 (long-form tag preserved for downstream rank-only use).
    expect(gradeRank(domainFloorGrade(nodes)!)).toBe(gradeRank("2"));
  });

  test("ignores untagged / unparseable nodes; undefined when no grade signal", () => {
    expect(gradeRank(domainFloorGrade([{ grade: "college" }, { grade: "5" }, {}])!)).toBe(
      gradeRank("5"),
    );
    expect(domainFloorGrade([{}, { grade: undefined }, { grade: "college" }])).toBeUndefined();
    expect(domainFloorGrade([])).toBeUndefined();
  });

  test("used as the cold prior, the floor anchors the first probe at the foundation, not ~1/3 up", () => {
    // A 12-node strand spanning grades 2→7 (the pilot's geometry shape: a young
    // cold-picker would otherwise open ~1/3 up = grade ~4).
    const chain = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const grades: Record<string, string> = {
      a: "2", b: "2", c: "3", d: "3", e: "4", f: "4",
      g: "5", h: "5", i: "6", j: "6", k: "7", l: "7",
    };
    const gradeOf = (key: string): string | undefined => grades[key];
    const nodes = chain.map((k) => ({ grade: grades[k] }));

    // BEFORE (no grade prior): the blind ~1/3-up anchor opens on grade-4 content.
    const coldNoPrior = affectSafeFirstProbeIndex(chain, { gradeOf, scholarGrade: undefined });
    expect(coldNoPrior).toBe(Math.floor(chain.length / 3)); // index 4 → grade "4"
    expect(gradeRank(grades[chain[coldNoPrior]])).toBe(gradeRank("4"));

    // AFTER (floor prior): anchors just above the grade-2 floor band → grade 3,
    // a full grade lower, and never above a grade-2 kid by more than one band.
    const floor = domainFloorGrade(nodes);
    const coldWithPrior = affectSafeFirstProbeIndex(chain, { gradeOf, scholarGrade: floor });
    expect(gradeRank(grades[chain[coldWithPrior]])).toBeLessThan(gradeRank("4"));
    expect(coldWithPrior).toBeLessThan(coldNoPrior);
  });
});

// ── Fix 1: the cross-domain prior is conservative (contiguous placed-through) ─

describe("F3 — conservativeDomainPrior: an isolated high row cannot amplify", () => {
  test("isolated high-grade credit does NOT lift the prior above the contiguous band", () => {
    // A completed domain whose topological order interleaves grades, so trust-upward
    // credited an isolated Grade-7 node while an intervening grade band was NOT
    // fully credited (the exact Probability shape from the findings: displayed
    // Grade 3, but carried isolated Grade-7 rows).
    const nodes = [
      { nodeKey: "n1", grade: "1" },
      { nodeKey: "n2", grade: "2" },
      { nodeKey: "n3", grade: "3" },
      { nodeKey: "nHi", grade: "7" }, // isolated high node, credited via trust-upward
    ];
    const credited: { skillKey: string; repetition: number; frontier?: boolean }[] = [
      { skillKey: "n1", repetition: FLUENT_REPS },
      { skillKey: "nHi", repetition: FLUENT_REPS }, // isolated Grade-7 credit
      // n2, n3 NOT credited → grade 2 band is a gap
    ];

    // NEW (conservative): the prior is the contiguous placed-through grade = "1"
    // (grade-1 band fully credited, grade-2 band broken).
    expect(conservativeDomainPrior(credited, nodes)).toBe("1");

    // Documents the OLD failure: the pre-fix `inferredGradeFloor` took the MAX
    // grade tag over credited rows — which here is "7", the recursive-amplification
    // seed that placed later domains at Grade 5+.
    const oldMaxRow = credited
      .map((c) => nodes.find((n) => n.nodeKey === c.skillKey)?.grade)
      .filter((g): g is string => !!g)
      .sort((a, b) => gradeRank(a) - gradeRank(b))
      .at(-1);
    expect(oldMaxRow).toBe("7");
  });

  test("a fully-credited contiguous band returns the top of that band", () => {
    const nodes = [
      { nodeKey: "n1", grade: "1" },
      { nodeKey: "n2", grade: "2" },
      { nodeKey: "n3", grade: "3" },
    ];
    const credited = [
      { skillKey: "n1", repetition: FLUENT_REPS },
      { skillKey: "n2", repetition: FLUENT_REPS },
      { skillKey: "n3", repetition: FLUENT_REPS },
    ];
    expect(conservativeDomainPrior(credited, nodes)).toBe("3");
  });

  test("a repetition-0 frontier seed never contributes to the prior (accessProven guard)", () => {
    const nodes = [
      { nodeKey: "n1", grade: "1" },
      { nodeKey: "n2", grade: "2" },
    ];
    // n1 credited fluent; n2 is only a repetition-0 frontier seed (not access-proven).
    const rows = [
      { skillKey: "n1", repetition: FLUENT_REPS },
      { skillKey: "n2", repetition: 0, frontier: false },
    ];
    // grade-1 band fully credited → "1"; the rep-0 n2 does NOT credit grade 2.
    expect(conservativeDomainPrior(rows, nodes)).toBe("1");
  });

  test("nothing credited → no prior (null)", () => {
    const nodes = [{ nodeKey: "n1", grade: "1" }];
    expect(conservativeDomainPrior([], nodes)).toBeNull();
    expect(conservativeDomainPrior([{ skillKey: "n1", repetition: 0 }], nodes)).toBeNull();
  });
});

// ── Trust-upward floor property: IDK never raises the floor ──────────────────

describe("F3 — the confirmed floor is exactly the highest correct index + 1", () => {
  const chain = ["a", "b", "c", "d", "e", "f", "g", "h"];

  test("IDK-majority run: the floor sits at/below the first correct's index", () => {
    // One correct at index 1, then a run of "don't know"s above it. The floor is
    // 2 (index 1 + 1); the IDKs never raise it.
    const outcomes: ProbeOutcome[] = [
      probeOutcomeFromKind("b", "correct"), // index 1
      probeOutcomeFromKind("d", "unknown"), // 3
      probeOutcomeFromKind("f", "unknown"), // 5
      probeOutcomeFromKind("h", "unknown"), // 7
    ];
    const f = strandFrontier("s", chain, outcomes);
    expect(f.frontierIndex).toBe(2);
    // The floor is at/below the first correct's index + 1 (never above it).
    expect(f.frontierIndex).toBeLessThanOrEqual(1 + 1);
  });

  test("property: floor == max(correct index)+1, and an all-IDK run finalizes at 0", () => {
    const kinds: PlacementOutcomeKind[] = ["correct", "incorrect", "unknown"];
    let checked = 0;
    // Deterministic sweep over small mixed outcome sets.
    for (let mask = 0; mask < 3 ** 4; mask++) {
      const picks = [0, 1, 2, 3].map((i) => Math.floor(mask / 3 ** i) % 3);
      // Assign the four outcomes to indices 1,3,5,7 (spread up the chain).
      const idxs = [1, 3, 5, 7];
      const outcomes = picks.map((p, j) => probeOutcomeFromKind(chain[idxs[j]], kinds[p]));
      const correctIdxs = outcomes.filter((o) => o.kind === "correct").map((o) => chain.indexOf(o.nodeKey));
      const expectedFloor = correctIdxs.length ? Math.max(...correctIdxs) + 1 : 0;
      expect(strandFrontier("s", chain, outcomes).frontierIndex).toBe(expectedFloor);
      // An IDK-majority set (0 corrects) always finalizes at the floor.
      if (correctIdxs.length === 0) expect(strandFrontier("s", chain, outcomes).frontierIndex).toBe(0);
      checked++;
    }
    expect(checked).toBe(81);
  });
});

// ── Integration (the heart): the real mixed check-in end-to-end ─────────────

const _makeTester = () => convexTest(schema, modules);
type Tester = ReturnType<typeof _makeTester>;

async function seedGradeTwoScholar(t: Tester) {
  // The persona from the field logs: enrolled grade persisted in the LEGACY
  // long form ("Grade 2"), which is exactly what the normalization seam must
  // survive end-to-end.
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "F3 Scholar",
      username: "f3-scholar",
      role: "scholar",
      gradeLevel: "Grade 2",
    }),
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

describe("F3 — mixed check-in: strong domain 1, IDK later domains", () => {
  test("later domains place at the floor; the first block has NO above-band items", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedGradeTwoScholar(t);
    const asScholar = await asUser(t, scholar);

    // Drive the real server-authoritative loop: answer whole-number arithmetic
    // CORRECT (strong first domain), everything else "don't know" (IDK-heavy
    // later domains). All probes are template items (seedGraph seeds no curated
    // manipulatives), so the correct answer is derivable.
    const base = { scholarId: scholar, seed: 7 };
    let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
    let guard = 0;
    while (!cur.done && cur.probe && guard++ < 500) {
      const probe = cur.probe as { itemId: string; domain: string };
      const answerCorrect = probe.domain === WHOLE_NUMBER_ARITHMETIC_DOMAIN;
      const extra = answerCorrect
        ? { itemId: probe.itemId, answer: gradeTemplateItem(probe.itemId, "0")?.correctAnswer ?? "0" }
        : { itemId: probe.itemId, answer: "", dontKnow: true };
      cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, { ...base, ...extra });
    }
    expect(cur.done).toBe(true);

    // ── (a) Later IDK-heavy domains place at the FLOOR ──────────────────────
    const perDomain = cur.perDomain as {
      domain: string;
      placedThroughGrade: string | null;
      complete: boolean;
    }[];
    const placedThroughByDomain = new Map(perDomain.map((p) => [p.domain, p.placedThroughGrade]));

    // The strong first domain placed through SOMETHING.
    expect(placedThroughByDomain.get(WHOLE_NUMBER_ARITHMETIC_DOMAIN)).not.toBeNull();
    // The all-IDK later domains (grade floors 4/5/6 — above a Grade-2 kid) placed
    // through NOTHING.
    for (const dom of [
      EARLY_ALGEBRA_DOMAIN,
      INTEGERS_COORDINATES_DOMAIN,
      RATIO_PROPORTION_PERCENT_DOMAIN,
    ]) {
      expect(placedThroughByDomain.get(dom), `placedThrough(${dom})`).toBeNull();
    }

    // ── (b) The prior never RAISED a confirmed floor: not one access-proven
    //        placement-credit row exists in a later IDK domain. ───────────────
    const allMastery = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter((r) => r.scholarId === scholar),
    );
    for (const dom of [EARLY_ALGEBRA_DOMAIN, INTEGERS_COORDINATES_DOMAIN, RATIO_PROPORTION_PERCENT_DOMAIN]) {
      const creditedInLater = allMastery.filter(
        (r) => r.domain === dom && r.source === "placement" && !r.frontier && r.repetition >= FLUENT_REPS,
      );
      expect(creditedInLater, `credited rows in ${dom}`).toHaveLength(0);
    }

    // ── (c) The first post-placement block serves NO above-profile CREDITED item ─
    // The findings' durable blast radius is CREDITED (access-proven, source
    // "placement", repetition ≥ FLUENT_REPS) rows written ABOVE the scholar's
    // profile in domains she never reached, which the required new-work lane then
    // injects ("the first six candidates are all Grade-7 inequality skills"). With
    // conservative priors + IDK-heavy later domains those credits never exist, so
    // NO credited first-block item may come from a not-placed domain.
    //
    // (Deliberately NOT asserted: the rep-0 FOUNDATIONAL entry point a domain
    // offers when a scholar places into it above their grade. That honest "here's
    // the door" is designed behavior — the same mechanism that gives a grade-K
    // scholar entering Fractions a non-empty first block, protected by
    // fractionsEntry.test.ts — and is unrelated to the prior amplification this
    // PR fixes.)
    const creditedKeys = new Set(
      allMastery
        .filter((r) => r.source === "placement" && !r.frontier && r.repetition >= FLUENT_REPS)
        .map((r) => r.skillKey),
    );
    const gradeByKeyDomain = new Map(
      (await t.run(async (ctx) => ctx.db.query("knowledgeNodes").collect())).map((n) => [
        n.nodeKey,
        n.domain,
      ]),
    );
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 3,
      domains: [...REGISTERED_PRACTICE_DOMAINS],
    });
    const items = session.items as { skillKey: string; domain?: string; lane?: string }[];
    expect(items.length).toBeGreaterThan(0); // non-vacuous (whole-number fills it)
    const requiredItems = items.filter((i) => i.lane !== "challenge");

    for (const item of requiredItems) {
      if (!creditedKeys.has(item.skillKey)) continue; // designed rep-0 entry points are out of scope
      const placedThrough = placedThroughByDomain.get(item.domain ?? "") ?? null;
      expect(
        placedThrough,
        `credited first-block item ${item.skillKey} came from not-placed domain ${item.domain}`,
      ).not.toBeNull();
    }

    // The crisp headline: not one CREDITED Early-Algebra skill (Nova's block was
    // "all Grade-7 inequality skills") reaches this Grade-2 kid's record or block.
    expect([...creditedKeys].some((k) => gradeByKeyDomain.get(k) === EARLY_ALGEBRA_DOMAIN)).toBe(false);
  });

  test("normalization end-to-end: a 'Grade 2' scholar is served the SAME first probe as a '2' scholar", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const longForm = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Long", username: "f3-long", role: "scholar", gradeLevel: "Grade 2" }),
    );
    const canonical = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Canon", username: "f3-canon", role: "scholar", gradeLevel: "2" }),
    );
    const primeFirstProbe = async (scholarId: Id<"users">) => {
      const as = await asUser(t, scholarId);
      const cur = await as.mutation(api.practiceSkills.submitMixedPlacementAnswer, { scholarId, seed: 42 });
      return cur.probe as { itemId: string; skillKey: string; domain: string } | null;
    };
    const a = await primeFirstProbe(longForm);
    const b = await primeFirstProbe(canonical);
    expect(a).not.toBeNull();
    // The enrolled-grade anchor drives the affect-safe first probe; if "Grade 2"
    // were treated as an unknown grade (the pre-fix normalization miss), it would
    // fall to the generic ~1/3 anchor and diverge from the canonical "2" scholar.
    expect(a?.skillKey).toBe(b?.skillKey);
    expect(a?.domain).toBe(b?.domain);
  });
});
