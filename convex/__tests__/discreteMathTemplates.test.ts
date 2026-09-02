import { describe, expect, test } from "vitest";
import { formatAnswer } from "../lib/practice/answers";
import { classifyDomain } from "../lib/domainTaxonomy";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import {
  DISCRETE_MATH_DOMAIN,
  DISCRETE_MATH_EDGES,
  DISCRETE_MATH_IMPLIES_EDGES,
  DISCRETE_MATH_SKILLS,
} from "../seed/discreteMathGraph";

const SKILL_KEYS = DISCRETE_MATH_SKILLS.map((skill) => skill.skillKey);
const SKILL_KEY_SET = new Set(SKILL_KEYS);

// Every cross-domain prerequisite `fromKey` (an edge whose source lives in
// whole-number-arithmetic). Recounted directly from the real graph in the
// count test; this is the expected sorted list.
const CROSS_DOMAIN_FROM_KEYS = [
  "divisibility_rules_2_5_10",
  "divisibility_rules_3_9",
  "equal_groups_concept",
  "exponents_repeated_mult",
  "gcf",
  "prime_or_composite",
  "remainder_cycles",
  "square_cube_numbers",
];

const STRAND_COUNTS: Record<string, number> = {
  counting: 12,
  "graph-theory": 12,
  "number-theory": 13,
  logic: 11,
};

// Decision/classification nodes that must stay multiple choice (no free-
// response equivalent — a scholar cannot type "≡", set braces, or an edge
// list on the number pad).
const MULTIPLE_CHOICE_KEYS = [
  "permutation_vs_combination",
  "gt_degree_sequence",
  "gt_connected",
  "gt_path_vs_circuit",
  "gt_euler_path",
  "gt_tree_definition",
  "gt_bipartite",
  "nt_parity_classify",
  "nt_parity_argument",
  "nt_parity_proof",
  "nt_divisibility_proof",
  // The repeating-cycle item answers with a cycle ENTRY (a color/word), so it
  // is multiple choice (QB fix from the Sol review — the first draft was a
  // plain-division integer item that never exercised the cycle).
  "nt_mod_cycle",
  "nt_prime_test_deeper",
  "lg_truth_value",
  "lg_and",
  "lg_or",
  "lg_not",
  "lg_compound_truth",
  "lg_negate",
  "lg_if_then",
  "lg_converse",
  "lg_counterexample",
  "lg_knights_knaves",
  "lg_deduce_clues",
];

// Free-response numeric families; every answer is an integer the code
// computed, never an equivalent expression string.
const NUMERIC_OUTCOME_KEYS = SKILL_KEYS.filter((key) => !MULTIPLE_CHOICE_KEYS.includes(key));

const ALLOWED_ANSWER_TYPES = new Set(["integer", "multipleChoice"]);

function requiredItem(skillKey: string, seed: number, form?: string): PracticeItem {
  const item = generateItem(skillKey, seed, form);
  expect(item, `${skillKey} seed=${seed} form=${form ?? "direct"}`).not.toBeNull();
  if (!item) throw new Error(`Missing discrete-math template: ${skillKey}`);
  return item;
}

function graderSubmission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice" ? String(item.answer.choiceIndex) : formatAnswer(item.answer);
}

describe("discrete-math deterministic templates", () => {
  test("the authoritative graph has 48 nodes, 56 edges, 8 foreign prerequisites, and 0 implies edges", () => {
    expect(DISCRETE_MATH_DOMAIN).toBe("discrete-math");
    expect(DISCRETE_MATH_SKILLS).toHaveLength(48);
    expect(SKILL_KEY_SET.size).toBe(48);
    expect(DISCRETE_MATH_EDGES).toHaveLength(56);

    const localFrom = DISCRETE_MATH_EDGES.filter((edge) => SKILL_KEY_SET.has(edge.fromKey));
    expect(localFrom).toHaveLength(48);

    const foreign = DISCRETE_MATH_EDGES.filter((edge) => !SKILL_KEY_SET.has(edge.fromKey));
    expect(foreign).toHaveLength(8);
    expect(foreign.map((edge) => edge.fromKey).sort()).toEqual(CROSS_DOMAIN_FROM_KEYS);

    // Every edge endpoint is a real key: `toKey` is always local (discrete-math
    // is a pure sink domain — no edge points out of it).
    for (const edge of DISCRETE_MATH_EDGES) {
      expect(SKILL_KEY_SET.has(edge.toKey), `toKey ${edge.toKey}`).toBe(true);
    }

    // Every LOCAL edge is grade-forward (the repo-wide drift lock only covers
    // CROSS-DOMAIN edges — graphGrades.test.ts).
    const gradeByKey = new Map(DISCRETE_MATH_SKILLS.map((s) => [s.skillKey, s.grade]));
    const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    for (const edge of DISCRETE_MATH_EDGES) {
      const from = gradeByKey.get(edge.fromKey);
      if (from === undefined) continue; // foreign edges: covered by graphGrades
      const to = gradeByKey.get(edge.toKey)!;
      expect(
        GRADE_ORDER.indexOf(from) <= GRADE_ORDER.indexOf(to),
        `local edge ${edge.fromKey}(${from}) -> ${edge.toKey}(${to}) goes backward in grade`,
      ).toBe(true);
    }

    expect(DISCRETE_MATH_IMPLIES_EDGES).toHaveLength(0);

    const counts: Record<string, number> = {};
    for (const skill of DISCRETE_MATH_SKILLS) {
      const strand = (skill as { strand?: string }).strand ?? "";
      counts[strand] = (counts[strand] ?? 0) + 1;
    }
    expect(counts).toEqual(STRAND_COUNTS);

    expect(classifyDomain(DISCRETE_MATH_DOMAIN, "counting")).toEqual({
      domain: "discrete-math",
      strand: "counting",
    });
  });

  test("every graph node has exactly one deterministic, reproducible template", () => {
    for (const skillKey of SKILL_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
      for (let seed = 1; seed <= 30; seed++) {
        expect(generateItem(skillKey, seed), `${skillKey} seed=${seed}`).toEqual(generateItem(skillKey, seed));
      }
    }
  });

  test("every template produces varied items across seeds", () => {
    for (const skillKey of SKILL_KEYS) {
      const signatures = new Set<string>();
      for (let seed = 1; seed <= 50; seed++) {
        const item = requiredItem(skillKey, seed);
        // MC families carry a fixed question stem sometimes; their variation
        // lives in the choices and the answer.
        signatures.add(
          [item.stem, JSON.stringify(item.choices ?? null), JSON.stringify(item.promptVisual ?? null), formatAnswer(item.answer)].join(
            "¦",
          ),
        );
      }
      expect(signatures.size, `${skillKey} only produced ${signatures.size} distinct items`).toBeGreaterThanOrEqual(3);
    }
  });

  test("every generated answer round-trips through its own grader", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 40; seed++) {
        const item = requiredItem(skillKey, seed);
        const result = gradeTemplateItem(makeItemId(skillKey, seed), graderSubmission(item));
        expect(result, `${skillKey} seed=${seed}`).not.toBeNull();
        expect(result?.correct, `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("answer types stay within the integer-or-multiple-choice policy (no fraction/expression/CAS)", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 40; seed++) {
        const item = requiredItem(skillKey, seed);
        expect(item.answerType, `${skillKey} seed=${seed}`).not.toBe("expression");
        expect(item.answerType, `${skillKey} seed=${seed}`).not.toBe("fraction");
        expect(ALLOWED_ANSWER_TYPES.has(item.answerType), `${skillKey} seed=${seed}: unexpected type ${item.answerType}`).toBe(
          true,
        );
      }
    }
  });

  test("multiple-choice items have 3 or 4 unique, gradeable options", () => {
    let multipleChoiceItems = 0;
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 60; seed++) {
        const item = requiredItem(skillKey, seed);
        if (item.answerType !== "multipleChoice") continue;
        multipleChoiceItems++;
        expect(MULTIPLE_CHOICE_KEYS, `${skillKey} unexpectedly MC`).toContain(skillKey);
        expect(item.choices?.length, `${skillKey} seed=${seed}`).toBeGreaterThanOrEqual(3);
        expect(item.choices?.length, `${skillKey} seed=${seed}`).toBeLessThanOrEqual(4);
        expect(new Set(item.choices).size, `${skillKey} seed=${seed}`).toBe(item.choices?.length);
        expect(item.answer.type, `${skillKey} seed=${seed}`).toBe("multipleChoice");
        if (item.answer.type === "multipleChoice") {
          expect(item.answer.choiceIndex).toBeGreaterThanOrEqual(0);
          expect(item.answer.choiceIndex).toBeLessThan(item.choices?.length ?? 0);
        }
      }
    }
    expect(multipleChoiceItems).toBeGreaterThan(0);
  });

  test("every multiple-choice skill key is actually served as multiple choice", () => {
    for (const skillKey of MULTIPLE_CHOICE_KEYS) {
      expect(requiredItem(skillKey, 1).answerType, skillKey).toBe("multipleChoice");
    }
  });

  test("free-response families are integer, never multiple choice or expression", () => {
    for (const skillKey of NUMERIC_OUTCOME_KEYS) {
      for (let seed = 1; seed <= 60; seed++) {
        const item = requiredItem(skillKey, seed);
        expect(item.answerType, `${skillKey} seed=${seed}`).toBe("integer");
        const value = item.answer.type === "integer" ? item.answer.value : NaN;
        expect(Number.isFinite(value), `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
        // Every discrete-math numeric family is a count/gap/remainder/hour —
        // never negative.
        expect(value, `${skillKey} seed=${seed}: ${item.stem}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("no prompt visuals are used anywhere in this domain (renderability constraint)", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 10; seed++) {
        expect(requiredItem(skillKey, seed).promptVisual, `${skillKey} seed=${seed}`).toBeUndefined();
      }
    }
  });

  test("graph-theory stems are answerable from text alone (edge list / degree sequence / n-vertex sentence)", () => {
    const graphKeys = SKILL_KEYS.filter((k) => k.startsWith("gt_"));
    expect(graphKeys).toHaveLength(12);
    for (const skillKey of graphKeys) {
      for (let seed = 1; seed <= 20; seed++) {
        const item = requiredItem(skillKey, seed);
        const hasEdgeList = /\{[A-L]–[A-L](, [A-L]–[A-L])*\}/.test(item.stem);
        const hasDegreeSequence = /\(\d+(, \d+)*\)/.test(item.stem);
        const hasVertexSentence = /\d+ vertices/.test(item.stem);
        const hasWalk = /[A-L](→[A-L])+/.test(item.stem);
        const hasEdgeCountSentence = /\d+ edges/.test(item.stem);
        const hasNamedTriangle = /triangle/.test(item.stem);
        expect(
          hasEdgeList || hasDegreeSequence || hasVertexSentence || hasWalk || hasEdgeCountSentence || hasNamedTriangle,
          `${skillKey} seed=${seed} not text-renderable: ${item.stem}`,
        ).toBe(true);
      }
    }
  });

  // "Unique" here means a unique CORRECT OPTION: the deliberate self-liar
  // variant ("I am a liar") has NO consistent assignment — its unique answer is
  // the paradox option, which the re-derivation below treats as first-class.
  test("knights-and-knaves items admit a unique consistent assignment", () => {
    // Re-derive the answer from the SAME logical rules the generator uses,
    // independently of the generator's own labeling, to guard against a
    // silently-ambiguous draw.
    for (let seed = 1; seed <= 60; seed++) {
      const item = requiredItem("lg_knights_knaves", seed);
      const m = item.stem.match(/says '(.+)\.' Only truth-tellers/);
      expect(m, item.stem).not.toBeNull();
      if (!m) continue;
      const statement = m[1];
      const correctLabel = item.choices?.[(item.answer as { choiceIndex: number }).choiceIndex];
      if (statement === "I am a liar") {
        // The classic paradox: neither role is internally consistent.
        expect(correctLabel).toBe("impossible / paradox");
        continue;
      }
      // Every other statement is an objective arithmetic/comparison/parity
      // fact; re-evaluate its truth value independently from the rendered
      // text and check it forces the label the generator picked.
      const eqMatch = statement.match(/^(\d+) \+ (\d+) = (\d+)$/);
      const parityMatch = statement.match(/^(\d+) is (even|odd)$/);
      const relMatch = statement.match(/^(\d+) is (greater than|less than) (\d+)$/);
      let truth: boolean;
      if (eqMatch) {
        truth = Number(eqMatch[1]) + Number(eqMatch[2]) === Number(eqMatch[3]);
      } else if (parityMatch) {
        const n = Number(parityMatch[1]);
        truth = parityMatch[2] === "even" ? n % 2 === 0 : n % 2 === 1;
      } else if (relMatch) {
        const a = Number(relMatch[1]);
        const b = Number(relMatch[3]);
        const actual = a > b ? "greater than" : a < b ? "less than" : "equal";
        truth = relMatch[2] === actual;
      } else {
        throw new Error(`Unrecognized knights-knaves statement shape: ${statement}`);
      }
      // A TRUE statement forces Truth-teller; a FALSE statement forces Liar —
      // the only two internally-consistent single roles.
      expect(correctLabel, `seed=${seed}: '${statement}' truth=${truth}`).toBe(truth ? "Truth-teller" : "Liar");
    }
  });

  test("lg_deduce_clues' two beat-clues force a unique 1st/2nd/3rd order", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const item = requiredItem("lg_deduce_clues", seed);
      const names = item.choices;
      expect(names, item.stem).toBeDefined();
      if (!names) continue;
      expect(names).toHaveLength(3);
      // Parse both "X beat Y" clues from the stem, independent of which order
      // they were rendered in, and rebuild the total order transitively: the
      // winner beats someone but is never beaten; the loser is beaten but
      // never beats anyone; the middle finisher does both.
      const beatPairs = [...item.stem.matchAll(/(\w+) beat (\w+)/g)].map((m) => [m[1], m[2]] as const);
      expect(beatPairs, item.stem).toHaveLength(2);
      const beats = new Map<string, string>(beatPairs);
      const beaten = new Set(beatPairs.map(([, loser]) => loser));
      const first = names.find((n) => beats.has(n) && !beaten.has(n));
      expect(first, item.stem).toBeDefined();
      const second = first ? beats.get(first) : undefined;
      const third = second ? beats.get(second) : undefined;
      // The reconstructed order is a permutation of the three rendered names.
      expect([first, second, third].sort()).toEqual([...names].sort());

      const askedOrdinal = item.stem.match(/Who came (1st|2nd|3rd)\?/)?.[1];
      const expectedByOrdinal: Record<string, string | undefined> = { "1st": first, "2nd": second, "3rd": third };
      const correctLabel = item.choices?.[(item.answer as { choiceIndex: number }).choiceIndex];
      expect(correctLabel, item.stem).toBe(expectedByOrdinal[askedOrdinal ?? ""]);
    }
  });

  test("pigeonhole answers are exact integers with no rounding ambiguity", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const basic = requiredItem("pigeonhole_basic", seed);
      const basicMatch = basic.stem.match(/come in (\d+) colors/);
      expect(basicMatch, basic.stem).not.toBeNull();
      if (basicMatch) {
        expect((basic.answer as { value: number }).value).toBe(Number(basicMatch[1]) + 1);
      }

      const generalized = requiredItem("pigeonhole_generalized", seed);
      const genMatch = generalized.stem.match(/^(\d+) books go on (\d+) shelves/);
      expect(genMatch, generalized.stem).not.toBeNull();
      if (genMatch) {
        const n = Number(genMatch[1]);
        const k = Number(genMatch[2]);
        expect((generalized.answer as { value: number }).value).toBe(Math.ceil(n / k));
      }
    }
  });
});
