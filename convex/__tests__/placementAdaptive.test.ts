import { describe, expect, test } from "vitest";
import {
  affectSafeFirstProbeIndex,
  gradeRank,
  nextStrandProbe,
  outcomeCredits,
  probeOutcomeFromKind,
  strandFrontier,
  strandOrders,
  type ProbeOutcome,
} from "../lib/practice/placement";
import { generateItem, hasTemplate, templatedSkillKeys } from "../lib/practice/templates";
import { isPadAnswerType } from "../../shared/practiceLoop";
import {
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
  type SeedSkill,
  type SeedEdge,
} from "../seed/wholeNumberArithmeticGraph";
import {
  FRACTION_ARITHMETIC_SKILLS,
  FRACTION_ARITHMETIC_EDGES,
} from "../seed/fractionArithmeticGraph";
import { PROBABILITY_SKILLS, PROBABILITY_EDGES } from "../seed/probabilityGraph";
import {
  GEOMETRY_MEASUREMENT_SKILLS,
  GEOMETRY_MEASUREMENT_EDGES,
} from "../seed/geometryMeasurementGraph";
import {
  RATIO_PROPORTION_PERCENT_SKILLS,
  RATIO_PROPORTION_PERCENT_EDGES,
} from "../seed/ratioProportionPercentGraph";
import {
  INTEGERS_COORDINATES_SKILLS,
  INTEGERS_COORDINATES_EDGES,
} from "../seed/integersCoordinatesGraph";
import { EARLY_ALGEBRA_SKILLS, EARLY_ALGEBRA_EDGES } from "../seed/earlyAlgebraGraph";
import { ALGEBRA_1_SKILLS, ALGEBRA_1_EDGES } from "../seed/algebra1Graph";

// Pure-logic tests for the placement-v2 additions to convex/lib/practice/
// placement.ts: the ternary outcome mapping, the affect-safe first-probe anchor,
// and how a "don't know" caps the ceiling exactly like a miss in the binary
// search. No convexTest / DB — these are the cheapest, most valuable tests.

const CHAIN = ["a", "b", "c", "d", "e", "f", "g"]; // 7-node linear strand
const allProbeable = () => true;

describe("placement v2 — ternary outcome", () => {
  test("only 'correct' credits (raises the floor); miss + unknown do not", () => {
    expect(outcomeCredits("correct")).toBe(true);
    expect(outcomeCredits("incorrect")).toBe(false);
    expect(outcomeCredits("unknown")).toBe(false);
  });

  test("probeOutcomeFromKind carries the ternary kind (confirm-before-cap needs the distinction)", () => {
    expect(probeOutcomeFromKind("c", "correct")).toEqual({ nodeKey: "c", kind: "correct" });
    expect(probeOutcomeFromKind("c", "incorrect")).toEqual({ nodeKey: "c", kind: "incorrect" });
    expect(probeOutcomeFromKind("c", "unknown")).toEqual({ nodeKey: "c", kind: "unknown" });
  });

  test("an 'unknown' caps the ceiling identically to a miss in strandFrontier", () => {
    // Correct at index 1 (b), then unknown at index 3 (d) — the frontier must land
    // at 2 (c), exactly as if d had been answered wrong.
    const viaUnknown: ProbeOutcome[] = [
      probeOutcomeFromKind("b", "correct"),
      probeOutcomeFromKind("d", "unknown"),
    ];
    const viaMiss: ProbeOutcome[] = [
      probeOutcomeFromKind("b", "correct"),
      probeOutcomeFromKind("d", "incorrect"),
    ];
    expect(strandFrontier("s", CHAIN, viaUnknown).frontierIndex).toBe(
      strandFrontier("s", CHAIN, viaMiss).frontierIndex,
    );
    expect(strandFrontier("s", CHAIN, viaUnknown).frontierKey).toBe("c");
  });
});

describe("placement v2 — affect-safe first probe", () => {
  const grades = { a: "K", b: "1", c: "2", d: "3", e: "4", f: "5", g: "6" };
  const gradeOf = (k: string): string | undefined => (grades as Record<string, string>)[k];

  test("anchors just above the highest node at/below the scholar's grade", () => {
    // A grade-2 scholar: highest node at/below grade 2 is "c" (index 2) → +1 = 3.
    expect(affectSafeFirstProbeIndex(CHAIN, { gradeOf, scholarGrade: "2" })).toBe(3);
  });

  test("clamps to the last node when the grade is at/above the top", () => {
    expect(affectSafeFirstProbeIndex(CHAIN, { gradeOf, scholarGrade: "8" })).toBe(CHAIN.length - 1);
  });

  test("falls back to ~1/3 up the strand when no usable grade", () => {
    expect(affectSafeFirstProbeIndex(CHAIN, {})).toBe(Math.floor(CHAIN.length / 3));
    // A grade with no matching node tag also falls back.
    expect(affectSafeFirstProbeIndex(CHAIN, { gradeOf: () => undefined, scholarGrade: "3" })).toBe(
      Math.floor(CHAIN.length / 3),
    );
  });

  test("first probe of a fresh strand uses the affect-safe target, not the midpoint", () => {
    const target = affectSafeFirstProbeIndex(CHAIN, { gradeOf, scholarGrade: "2" }); // 3
    const probe = nextStrandProbe(CHAIN, allProbeable, [], { firstProbeTarget: target });
    expect(probe?.index).toBe(3); // not the midpoint (also 3 here by coincidence — use a lower target below)
    // With a low target the first probe lands low (not the midpoint 3).
    const low = nextStrandProbe(CHAIN, allProbeable, [], { firstProbeTarget: 1 });
    expect(low?.index).toBe(1);
  });

  test("firstProbeTarget is ignored once the strand has any outcome (search takes over)", () => {
    const outcomes = [probeOutcomeFromKind("a", "correct")];
    // lo=1, hi=7 → midpoint 4. firstProbeTarget must NOT override anymore.
    const probe = nextStrandProbe(CHAIN, allProbeable, outcomes, { firstProbeTarget: 1 });
    expect(probe?.index).toBe(4);
  });

  test("firstProbeTarget is ignored on a resumed strand (resumeFloor > 0)", () => {
    const probe = nextStrandProbe(CHAIN, allProbeable, [], { firstProbeTarget: 0, resumeFloor: 2 });
    // lo=2, hi=7 → midpoint 4, not the target 0.
    expect(probe?.index).toBe(4);
  });
});

describe("placement v2 — expanding-ring search", () => {
  const grades = { a: "K", b: "1", c: "2", d: "3", e: "4", f: "5", g: "6" };
  const gradeOf = (k: string): string | undefined => (grades as Record<string, string>)[k];

  test("initial hi is bounded by scholar grade + 2", () => {
    const bounded = nextStrandProbe(CHAIN, allProbeable, [], {
      gradeOf,
      scholarGrade: "2",
    });
    const oldBehavior = nextStrandProbe(CHAIN, allProbeable, []);

    expect(bounded?.index).toBe(2); // midpoint of [0, grade-4-inclusive hi)
    expect(oldBehavior?.index).toBe(3); // midpoint of the whole strand
  });

  test("a correct answer at the ring top expands by one grade", () => {
    const probe = nextStrandProbe(CHAIN, allProbeable, [probeOutcomeFromKind("e", "correct")], {
      gradeOf,
      scholarGrade: "2",
    });

    expect(probe?.probeKey).toBe("f");
    expect(probe?.index).toBe(5);
  });

  test("unknown scholar grade preserves the old whole-strand behavior", () => {
    const unknown = nextStrandProbe(CHAIN, allProbeable, [], {
      gradeOf,
    });
    const unparseable = nextStrandProbe(CHAIN, allProbeable, [], {
      gradeOf,
      scholarGrade: "college",
    });

    expect(unknown?.index).toBe(3);
    expect(unparseable?.index).toBe(3);
  });

  test("the ring never STRANDS a scholar whose grade is below the whole strand", () => {
    // Regression (fractions inert-world, week-2 pilot): a strand whose EVERY node
    // sits above the scholar's grade+2 used to collapse the ring to hi=0 →
    // `lo >= hi` → ZERO probes, an inert placement. The ring caps how HIGH the
    // first probe reaches; it must not skip the domain. A grade-K scholar
    // (rank 0, ring ≤ grade 2) on a strand of all grade-3+ nodes must still get a
    // probe — the LOWEST available node — not null.
    const highStrand = ["p", "q", "r", "s"];
    const highGradeOf = (k: string): string | undefined =>
      ({ p: "3", q: "4", r: "5", s: "6" })[k];
    const probe = nextStrandProbe(highStrand, allProbeable, [], {
      gradeOf: highGradeOf,
      scholarGrade: "K",
    });
    expect(probe).not.toBeNull();
    expect(probe?.index).toBe(0); // the gentlest (lowest) available node

    // And it still converges honestly: after a "don't know" on that floor node,
    // the frontier lands at 0 (nothing credited) and there's nothing left to ask.
    const afterMiss = nextStrandProbe(
      highStrand,
      allProbeable,
      [probeOutcomeFromKind("p", "unknown")],
      { gradeOf: highGradeOf, scholarGrade: "K" },
    );
    expect(afterMiss).toBeNull();
    expect(strandFrontier("s", highStrand, [probeOutcomeFromKind("p", "unknown")]).frontierIndex).toBe(0);
  });

  test("a correct fallback expands an empty ring into an adaptive search", () => {
    // Every node is one grade above a K scholar's initial grade+2 ring. The first
    // fallback must still count as reaching the empty ring's top: its correct
    // answer admits the whole grade-3 strand, letting the remaining probes narrow
    // adaptively instead of walking one node at a time until the five-probe cap.
    const highStrand = Array.from({ length: 13 }, (_, i) => `high-${i}`);
    const outcomes: ProbeOutcome[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const probe = nextStrandProbe(highStrand, allProbeable, outcomes, {
        gradeOf: () => "3",
        scholarGrade: "K",
      });
      if (!probe) break;
      outcomes.push(probeOutcomeFromKind(probe.probeKey, "correct"));
    }

    expect(outcomes).toHaveLength(4);
    expect(strandFrontier("high", highStrand, outcomes).frontierIndex).toBe(highStrand.length);
  });

  test("an above-ring node topo-sorted EARLY is skipped (the ring is per-node, not a prefix)", () => {
    // Regression: `hiForMaxGrade` builds a PREFIX window ending after the LAST
    // in-band node, so a high-grade node that topo-sorts EARLY (a real shape —
    // e.g. probability center-spread's grade-6 `statistical_question` root sorts
    // before the grade-5 `ordering`) sits INSIDE the window. The per-node
    // predicate must skip it even when the target lands right on it.
    const strand = ["z", "a", "b", "c"];
    const g = { z: "6", a: "K", b: "1", c: "2" } as Record<string, string>;
    const probe = nextStrandProbe(strand, allProbeable, [], {
      gradeOf: (k) => g[k],
      scholarGrade: "K", // ring cap = grade 2
      firstProbeTarget: 0, // aim straight at the inverted grade-6 node
    });
    expect(probe).not.toBeNull();
    expect(probe?.probeKey).not.toBe("z");
    expect(probe?.probeKey).toBe("a"); // nearest in-ring node to the target
  });

  test("a real confirmed miss still ends the search (ring relaxation never re-probes above a miss)", () => {
    // The relaxation only lifts the affect-safe GRADE ring, never the confirmed-
    // miss ceiling. A pass at index 1 then a CONFIRMED miss at index 2 (an honest
    // don't-know caps immediately) → frontier is 2 and the search is done,
    // regardless of grade ring. (A single typed "incorrect" would instead re-serve
    // index 2 as a confirm — see the confirm-before-cap tests below.)
    const probe = nextStrandProbe(
      CHAIN,
      allProbeable,
      [probeOutcomeFromKind("b", "correct"), probeOutcomeFromKind("c", "unknown")],
      { gradeOf, scholarGrade: "K" },
    );
    expect(probe).toBeNull();
  });
});

describe("placement v2 — every servable answerType has an input path", () => {
  // The placement loop serves the SAME template-generated items as the drill
  // (via generateItem), so every answerType any template can emit must be
  // enterable on placement. Web enters `integer`/`decimal`/`fraction`/
  // `expression` via the hardware keyboard (isPadAnswerType — digits plus `/`,
  // `.`, R; native uses its touch pad) and `multipleChoice` via tappable option
  // buttons. A NEW template answerType that isn't renderable would silently
  // force a miss — this guards it.
  const RENDERABLE = (t: string): boolean => isPadAnswerType(t) || t === "multipleChoice";

  test("no template emits an answerType the pad can't render", () => {
    const keys = templatedSkillKeys();
    expect(keys.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    const orphans: { skillKey: string; answerType: string }[] = [];
    for (const skillKey of keys) {
      // A few deterministic seeds per template — some emit variant forms.
      for (const seed of [1, 7, 42, 1000, 999999]) {
        const item = generateItem(skillKey, seed);
        if (!item) continue;
        seen.add(item.answerType);
        if (!RENDERABLE(item.answerType)) orphans.push({ skillKey, answerType: item.answerType });
      }
    }
    expect(orphans).toEqual([]);
    // Sanity: we actually exercised more than one answerType (not a vacuous pass).
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("placement v2 — grade ring holds on the REAL seeded graphs", () => {
  // The synthetic chains above are grade-monotone in topo order; the real seed
  // graphs are NOT (a high-grade strand root can topo-sort before lower-grade
  // nodes). This sweep runs the ring against all seven registered domains and
  // asserts no probe opens above scholarGrade+2 — except the sanctioned
  // never-strand relaxation, which only fires when the window holds NO probeable
  // in-ring node at all.
  const RING_WIDTH = 2;
  const ALL_GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const REAL_DOMAINS: { label: string; skills: readonly SeedSkill[]; edges: readonly SeedEdge[] }[] = [
    { label: "whole-number-arithmetic", skills: WHOLE_NUMBER_ARITHMETIC_SKILLS, edges: WHOLE_NUMBER_ARITHMETIC_EDGES },
    { label: "fraction-arithmetic", skills: FRACTION_ARITHMETIC_SKILLS, edges: FRACTION_ARITHMETIC_EDGES },
    { label: "probability", skills: PROBABILITY_SKILLS, edges: PROBABILITY_EDGES },
    { label: "geometry-measurement", skills: GEOMETRY_MEASUREMENT_SKILLS, edges: GEOMETRY_MEASUREMENT_EDGES },
    { label: "ratio-proportion-percent", skills: RATIO_PROPORTION_PERCENT_SKILLS, edges: RATIO_PROPORTION_PERCENT_EDGES },
    { label: "integers-coordinates", skills: INTEGERS_COORDINATES_SKILLS, edges: INTEGERS_COORDINATES_EDGES },
    { label: "early-algebra", skills: EARLY_ALGEBRA_SKILLS, edges: EARLY_ALGEBRA_EDGES },
    { label: "algebra-1", skills: ALGEBRA_1_SKILLS, edges: ALGEBRA_1_EDGES },
  ];

  // Mirror loadPlacementContext: strand orders from the seed nodes (order = seed
  // index, exactly what rebuildPracticeNodes stamps) + the domain's buildsOn
  // edges; probeable = hasTemplate, the production predicate.
  const domainOrders = (skills: readonly SeedSkill[], edges: readonly SeedEdge[]) =>
    strandOrders(
      skills.map((s, i) => ({ nodeKey: s.skillKey, strand: s.strand, order: i })),
      edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey })),
    );

  const inRingFor = (gradeOf: (k: string) => string | undefined, cap: number) => (k: string) => {
    const rank = gradeRank(gradeOf(k) ?? "");
    return rank < 0 || rank <= cap;
  };

  test("no FIRST probe opens above scholarGrade+2 while an in-ring probeable node exists", () => {
    const violations: string[] = [];
    for (const { label, skills, edges } of REAL_DOMAINS) {
      const gradeByKey = new Map(skills.map((s) => [s.skillKey, s.grade]));
      const gradeOf = (k: string): string | undefined => gradeByKey.get(k);
      for (const scholarGrade of ALL_GRADES) {
        const cap = gradeRank(scholarGrade) + RING_WIDTH;
        const inRing = inRingFor(gradeOf, cap);
        for (const { strand, orderedKeys } of domainOrders(skills, edges)) {
          const probe = nextStrandProbe(orderedKeys, hasTemplate, [], {
            firstProbeTarget: affectSafeFirstProbeIndex(orderedKeys, { gradeOf, scholarGrade }),
            gradeOf,
            scholarGrade,
          });
          if (!probe || inRing(probe.probeKey)) continue;
          // Sanctioned never-strand relaxation: the ring excluded every probeable node.
          if (!orderedKeys.some((k) => hasTemplate(k) && inRing(k))) continue;
          violations.push(
            `${label}/${strand} grade-${scholarGrade}: first probe ${probe.probeKey} (g${gradeOf(probe.probeKey)})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("no probe in a miss-driven walk exceeds the ring while an in-ring candidate remains", () => {
    // Misses never bump the ring cap (only correct answers do), so every probe of
    // an all-miss walk must stay at/below scholarGrade+2 — unless the shrinking
    // miss-bounded window [0, hiNoRing) has run out of probeable in-ring nodes
    // (the sanctioned relaxation).
    const violations: string[] = [];
    for (const { label, skills, edges } of REAL_DOMAINS) {
      const gradeByKey = new Map(skills.map((s) => [s.skillKey, s.grade]));
      const gradeOf = (k: string): string | undefined => gradeByKey.get(k);
      for (const scholarGrade of ALL_GRADES) {
        const cap = gradeRank(scholarGrade) + RING_WIDTH;
        const inRing = inRingFor(gradeOf, cap);
        for (const { strand, orderedKeys } of domainOrders(skills, edges)) {
          const indexOf = new Map(orderedKeys.map((k, i) => [k, i]));
          const firstProbeTarget = affectSafeFirstProbeIndex(orderedKeys, { gradeOf, scholarGrade });
          const outcomes: ProbeOutcome[] = [];
          for (let step = 0; step <= orderedKeys.length; step++) {
            const probe = nextStrandProbe(orderedKeys, hasTemplate, outcomes, {
              firstProbeTarget,
              gradeOf,
              scholarGrade,
            });
            if (!probe) break;
            if (!inRing(probe.probeKey)) {
              const hiNoRing = Math.min(
                orderedKeys.length,
                ...outcomes.map((o) => indexOf.get(o.nodeKey)!),
              );
              const anyInRingLeft = orderedKeys
                .slice(0, hiNoRing)
                .some((k) => hasTemplate(k) && inRing(k));
              if (anyInRingLeft) {
                violations.push(
                  `${label}/${strand} grade-${scholarGrade} step ${step}: probe ${probe.probeKey} (g${gradeOf(probe.probeKey)})`,
                );
                break;
              }
            }
            outcomes.push(probeOutcomeFromKind(probe.probeKey, "incorrect"));
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("regression: the probability center-spread inversion no longer opens a grade-3 scholar on statistical_question", () => {
    // The concrete instance the fix was cut for: `statistical_question` (grade 6)
    // topo-sorts BEFORE `ordering` (grade 5) — both are strand roots, so seed
    // order breaks the tie — leaving the grade-6 node inside a grade-3 scholar's
    // ring window (grade+2 = 5).
    const gradeByKey = new Map(PROBABILITY_SKILLS.map((s) => [s.skillKey, s.grade]));
    const gradeOf = (k: string): string | undefined => gradeByKey.get(k);
    const cs = domainOrders(PROBABILITY_SKILLS, PROBABILITY_EDGES).find(
      (o) => o.strand === "center-spread",
    );
    expect(cs).toBeDefined();
    // The inversion still exists in the seed (else this test has gone vacuous —
    // move it to whichever strand carries the next inversion).
    const iSq = cs!.orderedKeys.indexOf("statistical_question");
    const iOrd = cs!.orderedKeys.indexOf("ordering");
    expect(iSq).toBeGreaterThanOrEqual(0);
    expect(iOrd).toBeGreaterThan(iSq);

    const probe = nextStrandProbe(cs!.orderedKeys, hasTemplate, [], {
      firstProbeTarget: affectSafeFirstProbeIndex(cs!.orderedKeys, { gradeOf, scholarGrade: "3" }),
      gradeOf,
      scholarGrade: "3",
    });
    expect(probe).not.toBeNull();
    expect(probe?.probeKey).not.toBe("statistical_question");
    expect(gradeRank(gradeOf(probe!.probeKey) ?? "")).toBeLessThanOrEqual(gradeRank("3") + RING_WIDTH);
  });
});
