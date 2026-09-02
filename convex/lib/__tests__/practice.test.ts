import { describe, expect, test } from "vitest";
import {
  answersEqual,
  parseAnswer,
  reduceFraction,
  intAns,
  decAns,
  fracAns,
  formatAnswer,
} from "../practice/answers";
import {
  proficiencyFromReps,
  HALFLIFE_GROWTH,
  DUE_THRESHOLD,
  retention,
  isDue,
  applyAttempt,
  computeFrontier,
  nextPractice,
  isFluentPlus,
  type SkillState,
  type GraphEdge,
} from "../practice/scheduler";
import {
  generateItem,
  generateSet,
  formatOrdinal,
  templatedSkillKeys,
  type PracticeItem,
} from "../practice/templates";
import {
  buildSession,
  gradeTemplateItem,
  parseItemId,
} from "../practice/session";
import {
  areaModelGeometry,
  arrayGeometry,
  clockfaceGeometry,
  fractionPartGeometry,
  groupsGeometry,
} from "../../../shared/practicePromptVisual";
import { buildStoredServable } from "../practice/servable";
import type { Id } from "../../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────
describe("answers — typed equivalence (the spike's representation lesson)", () => {
  test("1/2 ≡ 0.5 ≡ 2/4 across types", () => {
    expect(answersEqual(fracAns(1, 2), decAns(0.5))).toBe(true);
    expect(answersEqual(fracAns(1, 2), fracAns(2, 4))).toBe(true);
    expect(answersEqual(decAns(0.5), fracAns(4, 8))).toBe(true);
  });
  test("integer ≡ decimal numerically (24 ≡ 24.0)", () => {
    expect(answersEqual(intAns(24), decAns(24))).toBe(true);
  });
  test("6.50 ≡ 6.5", () => {
    expect(answersEqual(decAns(6.5), parseAnswer("6.50", "decimal")!)).toBe(true);
  });
  test("distinct values are not equal", () => {
    expect(answersEqual(intAns(24), intAns(25))).toBe(false);
    expect(answersEqual(fracAns(1, 3), decAns(0.3))).toBe(false);
  });
  test("multiple choice compares on index only", () => {
    expect(answersEqual({ type: "multipleChoice", choiceIndex: 1 }, { type: "multipleChoice", choiceIndex: 1 })).toBe(true);
    expect(answersEqual({ type: "multipleChoice", choiceIndex: 1 }, intAns(1))).toBe(false);
  });
});

describe("answers — parse normalizes the spike's failure modes", () => {
  test("strips units: '24 m^2' parses to 24", () => {
    expect(answersEqual(parseAnswer("24 m^2", "integer")!, intAns(24))).toBe(true);
    // Multi-word and unrecognized units both parse to the same value — the
    // unit-aware split is a strict widening of the old single-token regex.
    // Whether the unit is REQUIRED is the grader's question, not the parser's
    // (see answerUnits.test.ts).
    expect(answersEqual(parseAnswer("24 square meters", "integer")!, intAns(24))).toBe(true);
    expect(answersEqual(parseAnswer("24 quarts", "integer")!, intAns(24))).toBe(true);
  });
  test("strips a leading variable: 'x = 8' parses to 8", () => {
    expect(answersEqual(parseAnswer("x = 8", "integer")!, intAns(8))).toBe(true);
  });
  test("strips currency/commas: '$1,250' parses to 1250", () => {
    expect(answersEqual(parseAnswer("$1,250", "integer")!, intAns(1250))).toBe(true);
  });
  test("fraction string reduces: '2/4' parses equal to 1/2", () => {
    expect(answersEqual(parseAnswer("2/4", "fraction")!, fracAns(1, 2))).toBe(true);
  });
  test("an expression answer can equal a numeric one (8 ≡ 'x=8')", () => {
    expect(answersEqual(parseAnswer("x = 8", "expression")!, intAns(8))).toBe(true);
  });
  test("reduceFraction normalizes sign + lowest terms", () => {
    expect(reduceFraction(4, -8)).toEqual({ num: -1, den: 2 });
    expect(formatAnswer(fracAns(6, 8))).toBe("3/4");
  });
  test("whole-valued fractions display as whole numbers", () => {
    expect(formatAnswer(fracAns(2, 1))).toBe("2");
    expect(formatAnswer(fracAns(8, 4))).toBe("2");
  });
});

describe("template copy helpers", () => {
  test("formats ordinals by their final digits with teen exceptions", () => {
    expect(formatOrdinal(1)).toBe("1st");
    expect(formatOrdinal(11)).toBe("11th");
    expect(formatOrdinal(12)).toBe("12th");
    expect(formatOrdinal(13)).toBe("13th");
    expect(formatOrdinal(21)).toBe("21st");
    expect(formatOrdinal(22)).toBe("22nd");
    expect(formatOrdinal(23)).toBe("23rd");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("scheduler — proficiency bands + retention", () => {
  test("reps map to the fuel-disc bands", () => {
    expect(proficiencyFromReps(0)).toBe("not_started");
    expect(proficiencyFromReps(2)).toBe("practicing");
    expect(proficiencyFromReps(3)).toBe("fluent");
    expect(proficiencyFromReps(5)).toBe("overlearned");
  });
  test("retention decays on the half-life curve; due crosses the threshold", () => {
    const now = 100 * 86_400_000;
    const fresh: SkillState = { repetition: 3, halfLifeDays: 10, lastPracticedAt: now };
    expect(retention(fresh, now)).toBeCloseTo(1, 5);
    const oneHalfLife: SkillState = { repetition: 3, halfLifeDays: 10, lastPracticedAt: now - 10 * 86_400_000 };
    expect(retention(oneHalfLife, now)).toBeCloseTo(0.5, 5);
    expect(isDue(oneHalfLife, now)).toBe(true); // 0.5 < 0.6 threshold
    expect(isDue(fresh, now)).toBe(false);
  });
  test("applyAttempt: success advances reps while half-life growth waits for retrieval", () => {
    const t = 1_000_000;
    const ok = applyAttempt({ repetition: 0, halfLifeDays: 0 }, true, t);
    expect(ok.repetition).toBe(1);
    expect(ok.halfLifeDays).toBe(1);
    const ok2 = applyAttempt(ok, true, t);
    expect(ok2.repetition).toBe(2);
    expect(ok2.halfLifeDays).toBeCloseTo(1, 5);
    const ok3 = applyAttempt(ok2, true, t);
    expect(ok3.repetition).toBe(3);
    expect(ok3.halfLifeDays).toBeCloseTo(1, 5);
    expect(isDue(ok3, t + 86_400_000)).toBe(true);

    const dueAt = t + Math.log2(1 / DUE_THRESHOLD) * 86_400_000;
    const spaced = applyAttempt(ok3, true, dueAt);
    expect(spaced.halfLifeDays).toBeCloseTo(HALFLIFE_GROWTH, 5);

    const miss = applyAttempt({ repetition: 4, halfLifeDays: 20 }, false, t);
    expect(miss.repetition).toBe(4); // no advance on a miss
    expect(miss.halfLifeDays).toBeLessThan(20);
  });

  test("applyAttempt: spacing credit normalizes to the SKILL'S OWN retention target (P2a — anti-tsunami)", () => {
    // Regression guard for the review-tsunami failure mode: once P2a moved the due
    // point to per-skill targets (0.80/0.85/0.90), spacing credit MUST normalize to
    // that target, not the legacy 0.6. Otherwise an on-time review of a 0.90 skill
    // (answered at R≈0.90) would earn only ×1.33 growth — half-lives crawl, reviews
    // stay perpetually due, review share balloons. It must earn the FULL ×2.3.
    const DAY = 86_400_000;
    const hl = 10;
    const t0 = 500 * DAY;
    for (const target of [0.8, 0.85, 0.9]) {
      // "On time" = answered exactly when retention has decayed to the target.
      const lastAt = t0 - Math.log2(1 / target) * hl * DAY;
      const prev: SkillState = { repetition: 4, halfLifeDays: hl, lastPracticedAt: lastAt };
      expect(retention(prev, t0)).toBeCloseTo(target, 5);
      const grown = applyAttempt(prev, true, t0, target);
      expect(grown.halfLifeDays / hl).toBeCloseTo(HALFLIFE_GROWTH, 5); // full ×2.3
    }

    // A high-fanout (0.90-target) skill reviewed on time still gets full growth —
    // the exact case the coordinator worried was capped at ×1.33.
    const lastAt90 = t0 - Math.log2(1 / 0.9) * hl * DAY;
    const foundation: SkillState = { repetition: 4, halfLifeDays: hl, lastPracticedAt: lastAt90 };
    const grown90 = applyAttempt(foundation, true, t0, 0.9);
    expect(grown90.halfLifeDays).toBeCloseTo(hl * HALFLIFE_GROWTH, 5);
    // The legacy-0.6 normalization would have crawled to ~×1.33; assert we beat it.
    expect(grown90.halfLifeDays / hl).toBeGreaterThan(2);

    // A same-session rep at the same 0.90 target still barely moves (R≈1 ⇒ ×1).
    const sameDay = applyAttempt(
      { repetition: 4, halfLifeDays: hl, lastPracticedAt: t0 - 0.001 * DAY },
      true,
      t0,
      0.9,
    );
    expect(sameDay.halfLifeDays / hl).toBeCloseTo(1, 2);
  });
});

describe("scheduler — frontier gating (the prereq lock)", () => {
  // tiny chain: a -> b -> c (c builds on b builds on a)
  const keys = ["a", "b", "c"];
  const edges: GraphEdge[] = [
    { fromKey: "a", toKey: "b" },
    { fromKey: "b", toKey: "c" },
  ];
  const fluent: SkillState = { repetition: 4, halfLifeDays: 30, lastPracticedAt: Date.now() };
  const none: SkillState = { repetition: 0, halfLifeDays: 0 };

  test("only roots are on the frontier when nothing is learned", () => {
    expect(computeFrontier(keys, edges, () => none)).toEqual(["a"]);
  });
  test("b unlocks only once a is fluent; c stays locked", () => {
    const state = (k: string) => (k === "a" ? fluent : none);
    expect(computeFrontier(keys, edges, state)).toEqual(["b"]);
  });
  test("a fluent skill is past the frontier", () => {
    const state = (k: string) => (k === "a" || k === "b" ? fluent : none);
    expect(computeFrontier(keys, edges, state)).toEqual(["c"]);
  });
  test("isFluentPlus gates at FLUENT_REPS", () => {
    expect(isFluentPlus({ repetition: 2 })).toBe(false);
    expect(isFluentPlus({ repetition: 3 })).toBe(true);
  });
});

describe("scheduler — a learner cannot reach a downstream skill early (Spike D in miniature)", () => {
  test("c is never on the frontier until b is fluent", () => {
    const keys = ["a", "b", "c"];
    const edges: GraphEdge[] = [
      { fromKey: "a", toKey: "b" },
      { fromKey: "b", toKey: "c" },
    ];
    const state: Record<string, SkillState> = {
      a: { repetition: 0, halfLifeDays: 0 },
      b: { repetition: 0, halfLifeDays: 0 },
      c: { repetition: 0, halfLifeDays: 0 },
    };
    const now = Date.now();
    let reachedCEarly = false;
    // practice the frontier repeatedly; c must not appear until b hits fluent
    for (let step = 0; step < 40; step++) {
      const queue = nextPractice(keys, edges, (k) => state[k], now, 1);
      if (queue.length === 0) break;
      const key = queue[0].key;
      if (key === "c" && state.b.repetition < 3) reachedCEarly = true;
      state[key] = applyAttempt(state[key], true, now);
    }
    expect(reachedCEarly).toBe(false);
    expect(state.c.repetition).toBeGreaterThan(0); // but it IS reached eventually
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Independently re-derive each generated answer from its stem — the same
// verification philosophy as Spike A, applied to the template engine.
function recompute(item: PracticeItem): { ok: boolean; expected: string } {
  const s = item.stem;
  let m: RegExpMatchArray | null;
  const ok = (exp: number) => ({ ok: answersEqual(item.answer, intAns(exp)), expected: String(exp) });

  // ── early-skill (counting / place value / skip counting) shapes ──
  if ((m = s.match(/^Count by tens: what comes after (\d+)\?$/))) return ok(+m[1] + 10);
  if ((m = s.match(/comes (?:right )?after (\d+)\?$/))) return ok(+m[1] + 1);
  if (s === "How many dots?" && item.promptVisual?.kind === "countables") {
    return ok(item.promptVisual.n);
  }
  if ((m = s.match(/^Which is greater, (\d+) or (\d+)\? \(type the larger number\)$/)))
    return ok(Math.max(+m[1], +m[2]));
  if ((m = s.match(/^(\d+) \+ \? = 10$/))) return ok(10 - +m[1]);
  if ((m = s.match(/^How many tens are in (\d+)\?$/))) return ok(Math.floor(+m[1] / 10));
  if ((m = s.match(/^How many hundreds are in (\d+)\?$/))) return ok(Math.floor(+m[1] / 100));
  if ((m = s.match(/^What is 10 (more|less) than (\d+)\?$/)))
    return ok(m[1] === "more" ? +m[2] + 10 : +m[2] - 10);
  if ((m = s.match(/^Skip count by (\d+): (\d+), \d+, \d+, \?$/))) return ok(+m[2] + 3 * +m[1]);

  if ((m = s.match(/^Round (\d+) to the nearest (\d+)\.$/))) {
    const n = +m[1], to = +m[2];
    const exp = Math.round(n / to) * to;
    return { ok: answersEqual(item.answer, intAns(exp)), expected: String(exp) };
  }
  if ((m = s.match(/^(\d+) ÷ (\d+) = \? \(give quotient/))) {
    const D = +m[1], d = +m[2];
    const canonical = `${Math.floor(D / d)}r${D % d}`;
    return {
      ok: item.answer.type === "expression" && item.answer.canonical === canonical,
      expected: canonical,
    };
  }
  if ((m = s.match(/^Write (\d+) ÷ (\d+) as a fraction\.$/))) {
    const canonical = `${+m[1]}/${+m[2]}`;
    return {
      ok: item.answer.type === "expression" && item.answer.canonical === canonical,
      expected: canonical,
    };
  }
  if ((m = s.match(/^(\d+) ÷ (\d+) = \?$/))) {
    const D = +m[1], d = +m[2];
    return { ok: answersEqual(item.answer, intAns(D / d)), expected: String(D / d) };
  }
  if ((m = s.match(/^\((\d+) \+ (\d+)\) × (\d+) = \?$/))) {
    const exp = (+m[1] + +m[2]) * +m[3];
    return { ok: answersEqual(item.answer, intAns(exp)), expected: String(exp) };
  }
  if ((m = s.match(/^(\d+) \+ (\d+) × (\d+) = \?$/))) {
    const exp = +m[1] + +m[2] * +m[3];
    return { ok: answersEqual(item.answer, intAns(exp)), expected: String(exp) };
  }
  if ((m = s.match(/^(\d+) ([+−×]) (\d+) = \?$/))) {
    const a = +m[1], b = +m[3];
    const exp = m[2] === "+" ? a + b : m[2] === "−" ? a - b : a * b;
    return { ok: answersEqual(item.answer, intAns(exp)), expected: String(exp) };
  }
  throw new Error(`test cannot parse stem: ${s}`);
}

describe("templates — every generated answer is correct by independent re-derivation", () => {
  test("all templated skills produce verifiable items across many seeds", () => {
    const keys = templatedSkillKeys();
    expect(keys.length).toBeGreaterThan(20);
    const failures: string[] = [];
    for (const key of keys) {
      for (let seed = 1; seed <= 60; seed++) {
        const item = generateItem(key, seed)!;
        const { ok, expected } = recompute(item);
        if (!ok) failures.push(`${key} seed=${seed}: "${item.stem}" answer=${formatAnswer(item.answer)} expected=${expected}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("structural guarantees hold (no-regroup, non-negative subtraction, exact division)", () => {
    for (let seed = 1; seed <= 80; seed++) {
      // no-regroup 2-digit addition: no column carries
      const add = generateItem("add_2digit_no_regroup", seed)!;
      const [aa, ab] = add.stem.match(/(\d+)/g)!.map(Number);
      expect((aa % 10) + (ab % 10)).toBeLessThanOrEqual(9);
      expect((Math.floor(aa / 10) % 10) + (Math.floor(ab / 10) % 10)).toBeLessThanOrEqual(9);

      // subtraction never negative
      const sub = generateItem("subtract_2digit_regroup", seed)!;
      expect((sub.answer as { value: number }).value).toBeGreaterThanOrEqual(0);

      // division facts are exact (integer quotient, no remainder) and never
      // the degenerate identity facts (0 ÷ d, d ÷ d) in the 6–9 band
      const div = generateItem("division_facts_6_9", seed)!;
      const [dividend, divisor] = div.stem.match(/(\d+)/g)!.map(Number);
      expect(dividend % divisor).toBe(0);
      expect(dividend / divisor, div.stem).toBeGreaterThanOrEqual(2);
      expect(dividend / divisor, div.stem).toBeLessThanOrEqual(10);
    }
  });

  test("generateSet returns the requested count of distinct items", () => {
    const set = generateSet("mult_2digit_by_1digit", 10, 42);
    expect(set).toHaveLength(10);
    expect(new Set(set.map((i) => i.stem)).size).toBe(10);
  });

  test("counting templates always emit a countables visual whose n equals the answer", () => {
    // The invariant that guarantees a served dots item is never bare: every
    // counting template carries a `countables` promptVisual, and its rendered
    // count `n` is exactly the graded answer (so the accessible label, which
    // states the count, always matches what's on screen).
    for (const key of ["cardinality_within_10", "count_objects_within_10", "count_objects_within_20"]) {
      for (let seed = 1; seed <= 40; seed++) {
        const item = generateItem(key, seed)!;
        expect(item.stem).toBe("How many dots?");
        expect(item.stem).not.toContain("●");
        expect(item.answerType).toBe("integer");
        if (item.promptVisual?.kind !== "countables") {
          throw new Error(`${key} seed=${seed}: countables visual missing`);
        }
        expect(item.promptVisual.motif).toBe("dot");
        expect(item.promptVisual.n).toBe((item.answer as { value: number }).value);
        expect(item.promptVisual.layout).toBe(
          key === "count_objects_within_10" ? "scatter" : "tenframe",
        );
      }
    }
  });

  test("a stored dots row is reconstructed or excluded — never served bare", () => {
    const node = { label: "Count", domain: "whole-number-arithmetic" };
    const countRow = (overrides: Record<string, unknown>) => ({
      _id: "count1" as Id<"practiceItems">,
      skillKey: "count_objects_within_20",
      stem: "How many dots?",
      answerType: "integer",
      answerCanonical: "12",
      verifiedAt: 1,
      ...overrides,
    });

    // (a) A counting-family row that LOST its promptVisual is rebuilt from its
    //     own answer — the count on the visual equals the stored answer.
    const reconstructed = buildStoredServable(
      "gen#count1",
      countRow({}),
      node,
      "whole-number-arithmetic",
    );
    expect(reconstructed).not.toBeNull();
    const visual = reconstructed!.prompt.promptVisual;
    if (visual?.kind !== "countables") throw new Error("expected a reconstructed countables visual");
    expect(visual.n).toBe(12);
    expect(visual.layout).toBe("tenframe");

    // (b) A row whose count can't be trusted (out of range, or disagreeing with
    //     the answer) is EXCLUDED — a null servable, never a bare dots stem.
    expect(
      buildStoredServable("gen#count2", countRow({ answerCanonical: "999" }), node, "whole-number-arithmetic"),
    ).toBeNull();
    expect(
      buildStoredServable("gen#count3", countRow({ answerCanonical: "notanumber" }), node, "whole-number-arithmetic"),
    ).toBeNull();

    // (b′) A legacy GLYPH stem carries a parseable count (5 dots), but its
    //      answerCanonical is unparseable — reconstructing off the glyph would
    //      leave the row ungradeable, so it must be EXCLUDED, not served.
    expect(
      buildStoredServable(
        "gen#count4",
        countRow({ stem: "How many dots? ●●●●●", answerCanonical: "notanumber" }),
        node,
        "whole-number-arithmetic",
      ),
    ).toBeNull();
    //      Same glyph count but the answer disagrees (5 dots, answer 7) → excluded.
    expect(
      buildStoredServable(
        "gen#count5",
        countRow({ stem: "How many dots? ●●●●●", answerCanonical: "7" }),
        node,
        "whole-number-arithmetic",
      ),
    ).toBeNull();
    //      Glyph count agrees with the answer (5 dots, answer 5) → reconstructed.
    const glyphOk = buildStoredServable(
      "gen#count6",
      countRow({ stem: "How many dots? ●●●●●", answerCanonical: "5" }),
      node,
      "whole-number-arithmetic",
    );
    expect(glyphOk).not.toBeNull();
    const glyphVisual = glyphOk!.prompt.promptVisual;
    if (glyphVisual?.kind !== "countables") throw new Error("expected a reconstructed countables visual");
    expect(glyphVisual.n).toBe(5);

    // (c) A NON-counting stored row legitimately has no visual and still resolves.
    const wordProblem = buildStoredServable(
      "gen#wp1",
      {
        _id: "wp1" as Id<"practiceItems">,
        skillKey: "multiply_single_digit",
        stem: "What is 6 × 7?",
        answerType: "integer",
        answerCanonical: "42",
      },
      node,
      "whole-number-arithmetic",
    );
    expect(wordProblem).not.toBeNull();
    expect(wordProblem!.prompt.promptVisual).toBeUndefined();
    expect(wordProblem!.prompt.stem).toBe("What is 6 × 7?");
  });

  test("concept prompt-visual templates emit expected specs and answers", () => {
    const equalGroups = generateItem("equal_groups_concept", 17)!;
    expect(equalGroups.promptVisual?.kind).toBe("groups");
    if (equalGroups.promptVisual?.kind !== "groups") throw new Error("groups visual missing");
    expect(equalGroups.answer).toEqual(intAns(equalGroups.promptVisual.groups * equalGroups.promptVisual.perGroup));
    expect(groupsGeometry(equalGroups.promptVisual).points).toHaveLength(
      equalGroups.promptVisual.groups * equalGroups.promptVisual.perGroup,
    );

    const sharing = generateItem("division_as_sharing", 18)!;
    expect(sharing.promptVisual?.kind).toBe("groups");
    if (sharing.promptVisual?.kind !== "groups" || sharing.answer.type !== "integer") throw new Error("sharing visual missing");
    expect(sharing.answer.value).toBe(sharing.promptVisual.perGroup);

    const grouping = generateItem("division_as_grouping", 19)!;
    expect(grouping.promptVisual?.kind).toBe("groups");
    if (grouping.promptVisual?.kind !== "groups" || grouping.answer.type !== "integer") throw new Error("grouping visual missing");
    expect(grouping.answer.value).toBe(grouping.promptVisual.groups);

    const array = generateItem("arrays_concept", 20)!;
    expect(array.promptVisual?.kind).toBe("array");
    if (array.promptVisual?.kind !== "array") throw new Error("array visual missing");
    expect(array.answer).toEqual(intAns(array.promptVisual.rows * array.promptVisual.cols));
    expect(arrayGeometry(array.promptVisual).points).toHaveLength(array.promptVisual.rows * array.promptVisual.cols);

    const areaModel = generateItem("area_model_multiplication", 21)!;
    expect(areaModel.promptVisual?.kind).toBe("areamodel");
    if (areaModel.promptVisual?.kind !== "areamodel") throw new Error("area model visual missing");
    const width = areaModel.promptVisual.widthParts.reduce((sum, part) => sum + part, 0);
    const height = areaModel.promptVisual.heightParts.reduce((sum, part) => sum + part, 0);
    expect(areaModel.answer).toEqual(intAns(width * height));
    expect(areaModelGeometry(areaModel.promptVisual).cells).toHaveLength(
      areaModel.promptVisual.widthParts.length * areaModel.promptVisual.heightParts.length,
    );

    const unitFraction = generateItem("unit_fraction", 22)!;
    expect(unitFraction.promptVisual?.kind).toBe("fractionpart");
    if (unitFraction.promptVisual?.kind !== "fractionpart") throw new Error("fraction visual missing");
    expect(unitFraction.answer).toEqual(fracAns(unitFraction.promptVisual.shaded, unitFraction.promptVisual.parts));
    expect(fractionPartGeometry(unitFraction.promptVisual).segments).toHaveLength(unitFraction.promptVisual.parts);

    const clock = generateItem("remainder_cycles", 23)!;
    expect(clock.promptVisual?.kind).toBe("clockface");
    if (clock.promptVisual?.kind !== "clockface") throw new Error("clock visual missing");
    expect(clock.answer.type).toBe("integer");
    expect(clockfaceGeometry(clock.promptVisual).ticks).toHaveLength(12);
  });

  test("generation is deterministic in the seed", () => {
    expect(generateItem("add_within_20_regroup", 7)).toEqual(generateItem("add_within_20_regroup", 7));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("session — build + grade round-trip (anti-cheat: no answer served)", () => {
  const skills = [
    { key: "add_within_20_regroup", label: "Add within 20 (regroup)" },
    { key: "mult_facts_7_8_9", label: "Multiply facts 7–9" },
  ];

  test("buildSession serves N items with ids + stems but no answers", () => {
    const items = buildSession(skills, 8, 123);
    expect(items).toHaveLength(8);
    for (const it of items) {
      expect(it.stem.length).toBeGreaterThan(0);
      expect(parseItemId(it.itemId)).not.toBeNull();
      // the served shape carries no answer field at all
      expect(Object.keys(it)).not.toContain("answer");
    }
  });

  test("skips skills with no template; empty when none templated", () => {
    expect(buildSession([{ key: "partition_shapes", label: "x" }], 5, 1)).toEqual([]);
  });

  test("forwards multiple-choice choices onto served comparison items", () => {
    const items = buildSession([{ key: "compare_unlike", label: "Compare fractions" }], 4, 42);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.answerType).toBe("multipleChoice");
      expect(it.choices).toEqual(["less than (<)", "equal (=)", "greater than (>)"]);
      // served shape still carries no answer
      expect(Object.keys(it)).not.toContain("answer");
    }
  });

  test("forwards countables prompt visuals onto served items without answers", () => {
    const [item] = buildSession([{ key: "cardinality_within_10", label: "Cardinality" }], 1, 42);
    expect(item.stem).toBe("How many dots?");
    expect(item.promptVisual?.kind).toBe("countables");
    if (item.promptVisual?.kind !== "countables") throw new Error("countables visual missing");
    expect(item.promptVisual.n).toBeGreaterThanOrEqual(1);
    expect(item.promptVisual.n).toBeLessThanOrEqual(10);
    expect(Object.keys(item)).not.toContain("answer");
  });

  test("a correct learner answer grades true; a wrong one grades false", () => {
    const [item] = buildSession(skills, 1, 999);
    const parsed = parseItemId(item.itemId)!;
    const truth = generateItem(parsed.skillKey, parsed.seed)!;
    const correctRaw = formatAnswer(truth.answer);
    const good = gradeTemplateItem(item.itemId, correctRaw)!;
    expect(good.correct).toBe(true);
    const bad = gradeTemplateItem(item.itemId, "999999")!;
    expect(bad.correct).toBe(false);
    expect(bad.correctAnswer).toBe(correctRaw);
  });

  test("grading is robust to formatting (units / spaces) via typed parse", () => {
    const items = buildSession([{ key: "mult_2digit_by_1digit", label: "x" }], 1, 7);
    const parsed = parseItemId(items[0].itemId)!;
    const truth = generateItem(parsed.skillKey, parsed.seed)!;
    const withJunk = ` ${formatAnswer(truth.answer)} `;
    expect(gradeTemplateItem(items[0].itemId, withJunk)!.correct).toBe(true);
  });

  test("gradeTemplateItem returns null for a non-template id", () => {
    expect(gradeTemplateItem("llm#abc123", "5")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
import { placedThroughGrade, anchorGrade, gradeRank, PLACEMENT_ANCHORS } from "../practice/placement";

describe("placement — placedThroughGrade (trusts upward, contiguous)", () => {
  test("all correct → placed through the top grade", () => {
    const r = PLACEMENT_ANCHORS.map((a) => ({ grade: a.grade, correct: true }));
    expect(placedThroughGrade(r)).toBe("5");
  });
  test("first miss stops the run (K-3 right, gr4 wrong → through 3)", () => {
    const r = [
      { grade: "K", correct: true }, { grade: "1", correct: true },
      { grade: "2", correct: true }, { grade: "3", correct: true },
      { grade: "4", correct: false }, { grade: "5", correct: true }, // later correct ignored
    ];
    expect(placedThroughGrade(r)).toBe("3");
  });
  test("miss the very first anchor → null (start from the bottom)", () => {
    expect(placedThroughGrade([{ grade: "K", correct: false }, { grade: "1", correct: true }])).toBeNull();
  });
  test("unordered input is sorted by grade first", () => {
    const r = [
      { grade: "2", correct: true }, { grade: "K", correct: true }, { grade: "1", correct: true },
    ];
    expect(placedThroughGrade(r)).toBe("2");
  });
  test("anchorGrade maps anchor skills; gradeRank orders", () => {
    expect(anchorGrade("mult_2digit_by_1digit")).toBe("4");
    expect(anchorGrade("not_an_anchor")).toBeNull();
    expect(gradeRank("3")).toBeGreaterThan(gradeRank("1"));
  });
});
