/**
 * Contract: a template item must not be answerable without doing the math.
 *
 * A 2026-10 audit generated every template hundreds of times and found four
 * kinds of shortcut: the grader accepting the question's own fraction back
 * ("Simplify 72/80" → 72/80), answers that sat in the stem ("Find the mean of
 * 14, 11, 12, 8, 10" → the middle value, every time), one constant guess that
 * beat chance by a wide margin ("No" on is-a-factor items, 79%), and the
 * correct option always being the longest. These checks run the real grader
 * over every template so a new template has to pass them too.
 */
import { describe, expect, test } from "vitest";
import { allTemplatedSkillKeys, generateItem, type PracticeItem } from "./templates";
import { gradeTemplateItem, makeItemId } from "./session";
import { formatUnit } from "./answers";
import {
  buildTemplateServable,
  gradeSubmission,
  GRADE_ONLY_POLICY,
  PRACTICE_POLICY,
  type FormOutcome,
} from "./servable";

const DRAWS = 300;
const seedAt = (i: number) => 1000 + i * 7919;

function draws(skillKey: string, n = DRAWS): { item: PracticeItem; itemId: string }[] {
  const out: { item: PracticeItem; itemId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const item = generateItem(skillKey, seedAt(i));
    if (item) out.push({ item, itemId: makeItemId(skillKey, seedAt(i)) });
  }
  return out;
}

/** Every number written in the stem, as the scholar could type it back. */
function stemNumbers(stem: string): string[] {
  return [...new Set(stem.replace(/−/g, "-").match(/-?\d+(?:\.\d+)?(?:\/\d+)?/g) ?? [])];
}

/** Templates where typing a number from the question is the skill itself, so
 *  the answer appearing there is not a shortcut. Each needs a reason. */
const ANSWER_IN_STEM_BY_DESIGN: Record<string, string> = {
  compare_within_10: "picks the larger of the two numbers shown",
  compare_2digit: "picks the larger of the two numbers shown",
  compare_3digit: "picks the larger of the two numbers shown",
  add_subtract_properties: "the identity property: n − 0 is n",
  mult_commutative_associative: "the property is that the factor reappears",
  whole_as_fraction: "n = n/1 is the notation being taught",
  mode: "the mode is one of the values by definition",
  median: "the median is one of the values by definition",
  quad_zero_product: "reading roots off factored form is the skill",
  quad_vertex_form: "reading the vertex off vertex form is the skill",
  mult_facts_0_1_2_5_10: "×1 facts return the other factor",
  outlier_effect_on_mean_median: "a median is usually one of the data values",
  positive_negative_contexts: "the skill is attaching the sign to the number given",
  absolute_value_distance_zero: "|n| is n for positive n",
  absolute_value_rationals: "|n| is n for positive n",
  lin_fn_parallel_perpendicular: "a parallel line keeps the same slope",
  nt_last_digit: "powers of 5 and 6 always end in 5 and 6, part of the pattern taught",
  nt_modular_clock: "the stem's (Answer 0–m−1) note names 0 and m−1",
  measure_with_ruler: "reading a length off a ruler that starts at 0 is the skill",
};

describe("template shortcuts", () => {
  const skillKeys = allTemplatedSkillKeys();

  test("typing a number from the question is not graded correct, except by design", () => {
    const offenders: string[] = [];
    for (const skillKey of skillKeys) {
      if (ANSWER_IN_STEM_BY_DESIGN[skillKey]) continue;
      let typed = 0;
      let copied = 0;
      let example = "";
      for (const { item, itemId } of draws(skillKey)) {
        if (item.answer.type === "multipleChoice") continue;
        typed++;
        // Typed with the unit when the item requires one, as a scholar would.
        const unit = item.answerUnit ? ` ${formatUnit(item.answerUnit)}` : "";
        const hit = stemNumbers(item.stem).find((token) => gradeTemplateItem(itemId, token + unit)?.correct);
        if (hit !== undefined) {
          copied++;
          example ||= `${item.stem} → "${hit}"`;
        }
      }
      if (typed > 0 && copied / typed >= 0.4) {
        offenders.push(`${skillKey} (${Math.round((copied / typed) * 100)}%): ${example}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every by-design exception is a real template that still needs it", () => {
    for (const skillKey of Object.keys(ANSWER_IN_STEM_BY_DESIGN)) {
      expect(skillKeys, skillKey).toContain(skillKey);
    }
  });

  test("no single multiple-choice answer wins by always guessing it", () => {
    const offenders: string[] = [];
    for (const skillKey of skillKeys) {
      const counts = new Map<string, number>();
      let total = 0;
      for (const { item } of draws(skillKey)) {
        if (item.answer.type !== "multipleChoice" || !item.choices) continue;
        const label = item.choices[item.answer.choiceIndex];
        counts.set(label, (counts.get(label) ?? 0) + 1);
        total++;
      }
      if (total === 0) continue;
      const [label, count] = [...counts].sort((x, y) => y[1] - x[1])[0];
      if (count / total > 0.6) offenders.push(`${skillKey}: "${label}" ${Math.round((count / total) * 100)}%`);
    }
    expect(offenders).toEqual([]);
  });

  test("option length does not give the answer away", () => {
    // Rank each item's options by length (options that are never correct for
    // the template don't count — "not enough information" is easy to ignore),
    // and fail when one rank, longest or shortest or any other, is the answer
    // too often. The bar is loose for two live options, which are usually an
    // outcome pair like "<" / ">" that is already balanced.
    const offenders: string[] = [];
    for (const skillKey of skillKeys) {
      const items = draws(skillKey)
        .map(({ item }) => item)
        .filter((item) => item.answer.type === "multipleChoice" && item.choices && item.choices.length >= 3);
      if (items.length === 0) continue;
      // All-number options: length is magnitude, a different question.
      if (items.every((item) => item.choices!.every((choice) => /^-?\d+(\.\d+)?$/.test(choice)))) continue;
      const everCorrect = new Set(
        items.map((item) => item.choices![(item.answer as { choiceIndex: number }).choiceIndex]),
      );
      const rankCounts = new Map<number, number>();
      let ranked = 0;
      let live = 0;
      for (const item of items) {
        const correct = item.choices![(item.answer as { choiceIndex: number }).choiceIndex];
        const options = item.choices!.filter((choice) => everCorrect.has(choice));
        live = Math.max(live, options.length);
        if (options.length < 2) continue;
        const lengths = options.map((option) => option.length);
        if (new Set(lengths).size !== lengths.length) continue; // a tie has no rank
        const rank = [...lengths].sort((a, b) => a - b).indexOf(correct.length);
        rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
        ranked++;
      }
      if (ranked < 30) continue;
      const bar = live >= 4 ? 0.45 : live === 3 ? 0.6 : 0.7;
      for (const [rank, count] of rankCounts) {
        if (count / ranked > bar) {
          offenders.push(`${skillKey}: length rank ${rank} of ${live} live options is right ${Math.round((count / ranked) * 100)}%`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no single typed answer dominates a template", () => {
    const offenders: string[] = [];
    for (const skillKey of skillKeys) {
      const counts = new Map<string, number>();
      let total = 0;
      for (const { item } of draws(skillKey)) {
        if (item.answer.type === "multipleChoice") continue;
        const key = JSON.stringify(item.answer);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        total++;
      }
      if (total === 0) continue;
      const top = Math.max(...counts.values());
      if (top / total > 0.6) offenders.push(`${skillKey}: ${Math.round((top / total) * 100)}%`);
    }
    expect(offenders).toEqual([]);
  });

  test("the mean is never one of the values and never the median", () => {
    for (const { item } of draws("mean")) {
      const values = (item.stem.match(/-?\d+/g) ?? []).map(Number);
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      const median = sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
      const mean = item.answer.type === "integer" ? item.answer.value : NaN;
      expect(values, item.stem).not.toContain(mean);
      expect(median, item.stem).not.toBe(mean);
    }
  });

  test("small addition and subtraction facts are rarely zero facts", () => {
    for (const skillKey of [
      "add_within_5",
      "subtract_within_5",
      "add_within_10",
      "subtract_within_10",
      "add_subtract_fluency_within_20",
    ]) {
      const all = draws(skillKey, 1000);
      const zeroFacts = all.filter(({ item }) => {
        const v = item.variant;
        return !!v && (v.a === 0 || v.b === 0 || (v.op === "−" && v.a === v.b));
      });
      expect(zeroFacts.length / all.length, skillKey).toBeLessThan(0.2);
    }
  });
});

describe("answer form", () => {
  /** For each form-graded template: the value-equal dodge read from the stem. */
  const DODGES: Record<string, (stem: string) => string | null> = {
    simplify_fractions: (stem) => stem.match(/Simplify (\d+\/\d+)/)?.[1] ?? null,
    decimal_notation_fractions: (stem) => stem.match(/Write (\d+\/\d+)/)?.[1] ?? null,
    probability_as_fraction: (stem) => {
      const m = stem.match(/holds (\d+) marbles, and (\d+) of/);
      return m ? `${m[2]}/${m[1]}` : null;
    },
    percent_fraction_decimal: (stem) => {
      const m = stem.match(/Write (\d+)% as a decimal/);
      return m ? `${m[1]}/100` : null;
    },
  };

  const FORM_OUTCOMES: Record<string, FormOutcome> = {
    simplify_fractions: "notLowestTerms",
    decimal_notation_fractions: "notDecimal",
    probability_as_fraction: "notLowestTerms",
    percent_fraction_decimal: "notDecimal",
  };

  for (const [skillKey, dodge] of Object.entries(DODGES)) {
    test(`${skillKey}: the unconverted form is wrong, the asked-for form is right`, () => {
      let checked = 0;
      for (const { item, itemId } of draws(skillKey, 60)) {
        const raw = dodge(item.stem);
        if (raw === null) continue;
        checked++;
        const expected = gradeTemplateItem(itemId, "")!.correctAnswer;
        expect(gradeTemplateItem(itemId, raw)?.correct, `${item.stem} ← ${raw}`).toBe(false);
        expect(gradeTemplateItem(itemId, expected)?.correct, `${item.stem} ← ${expected}`).toBe(true);

        // The drill loop's grader agrees with the oracle — and names the form,
        // so the surface says "same value, now write it…" instead of a flat miss.
        const servable = buildTemplateServable(itemId, null, "test")!;
        const dodged = gradeSubmission(servable, { kind: "typed", raw }, PRACTICE_POLICY);
        expect(dodged.correct).toBe(false);
        expect(dodged.formOutcome, `${item.stem} ← ${raw}`).toBe(FORM_OUTCOMES[skillKey]);
        const right = gradeSubmission(servable, { kind: "typed", raw: expected }, PRACTICE_POLICY);
        expect(right.correct).toBe(true);
        expect(right.formOutcome).toBeUndefined();
      }
      expect(checked).toBeGreaterThan(0);
    });
  }

  test("a wrong VALUE reports no formOutcome — the form is not what went wrong", () => {
    for (const { itemId } of draws("simplify_fractions", 20)) {
      const servable = buildTemplateServable(itemId, null, "test")!;
      const grade = gradeSubmission(servable, { kind: "typed", raw: "999/1000" }, PRACTICE_POLICY);
      expect(grade.correct).toBe(false);
      expect(grade.formOutcome).toBeUndefined();
      const dontKnow = gradeSubmission(servable, { kind: "dontKnow" }, PRACTICE_POLICY);
      expect(dontKnow.formOutcome).toBeUndefined();
    }
  });

  test("a wrong-form answer is still a miss for mastery, exactly like a unit miss", () => {
    const { item, itemId } = draws("simplify_fractions", 1)[0];
    const raw = DODGES.simplify_fractions(item.stem)!;
    const servable = buildTemplateServable(itemId, null, "test")!;
    const grade = gradeSubmission(servable, { kind: "typed", raw }, PRACTICE_POLICY);
    expect(grade.correct).toBe(false);
    expect(grade.shouldRecordMastery).toBe(true);
    // A grade-only retry (Socratic retry, TeachingStep) says the same sentence.
    expect(gradeSubmission(servable, { kind: "typed", raw }, GRADE_ONLY_POLICY).formOutcome).toBe(
      "notLowestTerms",
    );
    // A policy-forced credit retires the note: there is no "so close" on a win.
    const credited = gradeSubmission(
      servable,
      { kind: "typed", raw },
      { ...PRACTICE_POLICY, finalCredit: true },
    );
    expect(credited.correct).toBe(true);
    expect(credited.formOutcome).toBeUndefined();
  });

  test("the answer oracle rejects the unconverted form without a scholar-facing note", () => {
    // `gradeTemplateItem` feeds probes and harnesses, which have no scholar — it
    // reports correctness only, as it does for units.
    const { item, itemId } = draws("decimal_notation_fractions", 1)[0];
    const graded = gradeTemplateItem(itemId, DODGES.decimal_notation_fractions(item.stem)!)!;
    expect(graded.correct).toBe(false);
    expect(graded).not.toHaveProperty("formOutcome");
  });

  test("only the reduced fraction counts on a simplify item", () => {
    const itemId = makeItemId("simplify_fractions", seedAt(0));
    const answer = generateItem("simplify_fractions", seedAt(0))!.answer;
    if (answer.type !== "fraction") throw new Error("expected a fraction answer");
    expect(gradeTemplateItem(itemId, `${answer.num}/${answer.den}`)?.correct).toBe(true);
    expect(gradeTemplateItem(itemId, `${answer.num * 2}/${answer.den * 2}`)?.correct).toBe(false);
  });
});
