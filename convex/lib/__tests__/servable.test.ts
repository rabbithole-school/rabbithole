/**
 * Unit tests for the unified serve/grade dispatcher (lib/practice/servable.ts).
 *
 * Pure tests — no Convex ctx. They cover the resolver builders and the full
 * grading matrix: each ServableItem kind (template / stored / manipulative) ×
 * each Submission kind (typed / choice / manipulativeState / dontKnow) × two
 * policies (the drill-loop PRACTICE_POLICY and the record-nothing
 * GRADE_ONLY_POLICY), plus malformed manipulative state and the unknown-id
 * fall-through. The grading VERDICT must not depend on the policy (only the
 * side-effect intentions do), so every case is asserted under both.
 */

import { describe, expect, test } from "vitest";
import { makeItemId } from "../practice/session";
import { formatAnswer, type TypedAnswer } from "../practice/answers";
import type { Id } from "../../_generated/dataModel";
import {
  buildTemplateServable,
  buildStoredServable,
  gradeSubmission,
  GRADE_ONLY_POLICY,
  PRACTICE_POLICY,
  PLACEMENT_POLICY,
  type GradePolicy,
  type ServableItem,
  type StoredPracticeItem,
  type Submission,
} from "../practice/servable";

const DOMAIN = "whole-number-arithmetic";
const node = { label: "A Skill", domain: DOMAIN };

// A width-4 rectangle is the only area-16 solution at perimeter 16.
const areaSpec = {
  kind: "areaPerimeter",
  id: "ap",
  concept: "Area with fixed perimeter",
  prompt: "Fence in exactly 16 square units.",
  perimeter: 16,
  startWidth: 1,
  goal: { type: "areaEquals", value: 16 },
};

function storedDoc(overrides: Partial<StoredPracticeItem> = {}): StoredPracticeItem {
  return {
    _id: "stored1" as Id<"practiceItems">,
    skillKey: "multiply_single_digit",
    stem: "What is 6 × 7?",
    answerType: "integer",
    answerCanonical: "42",
    verifierKind: "arithmetic",
    ...overrides,
  };
}

function manipulativeDoc(overrides: Partial<StoredPracticeItem> = {}): StoredPracticeItem {
  return {
    _id: "manip1" as Id<"practiceItems">,
    skillKey: "manip_area",
    stem: areaSpec.prompt,
    answerType: "manipulative",
    answerCanonical: "",
    verifierKind: "manipulative",
    manipulativeSpec: JSON.stringify(areaSpec),
    ...overrides,
  };
}

// The two template items the matrix reuses (built once — pure + deterministic).
const templateInt = buildTemplateServable(makeItemId("count_to_10", 7), node, DOMAIN);
const templateMC = buildTemplateServable(makeItemId("compare_same_denominator", 7), null, DOMAIN);

describe("servable resolver builders", () => {
  test("buildTemplateServable resolves a template id into a graded-ready item", () => {
    expect(templateInt).not.toBeNull();
    const item = templateInt!;
    expect(item.kind).toBe("template");
    expect(item.skillKey).toBe("count_to_10");
    expect(item.itemId).toBe(makeItemId("count_to_10", 7));
    expect(item.skillLabel).toBe("A Skill");
    expect(item.domain).toBe(DOMAIN);
    expect(item.ref).toEqual({ skillKey: "count_to_10", seed: 7 });
    expect(item.prompt.stem.length).toBeGreaterThan(0);
    expect(item.tutorContext).toEqual({ type: "text", stem: item.prompt.stem });
    if (item.kind === "template") expect(item.verifier.kind).toBe("template");
  });

  test("buildTemplateServable falls back to skillKey/defaultDomain when node is absent", () => {
    expect(templateMC).not.toBeNull();
    expect(templateMC!.skillLabel).toBe("compare_same_denominator");
    expect(templateMC!.domain).toBe(DOMAIN);
    expect(templateMC!.prompt.answerType).toBe("multipleChoice");
  });

  test("buildTemplateServable returns null for a non-template id (unknown-item fall-through)", () => {
    // A "gen#<id>" id, an id whose skill has no template, and pure garbage all
    // parse to null — the signal the ctx resolver turns into an Unknown-item throw.
    expect(buildTemplateServable("gen#abc123", node, DOMAIN)).toBeNull();
    expect(buildTemplateServable("totally_unknown_skill#5", node, DOMAIN)).toBeNull();
    expect(buildTemplateServable("garbage", node, DOMAIN)).toBeNull();
  });

  test("buildStoredServable dispatches manipulative vs stored on verifierKind", () => {
    const stored = buildStoredServable("gen#stored1", storedDoc(), node, DOMAIN)!;
    expect(stored.kind).toBe("stored");
    expect(stored.ref).toBe("stored1");
    expect(stored.domain).toBe(DOMAIN);
    if (stored.kind === "stored") {
      expect(stored.verifier).toEqual({
        kind: "storedAnswer",
        answerType: "integer",
        answerCanonical: "42",
      });
    }

    const manip = buildStoredServable("gen#manip1", manipulativeDoc(), null, DOMAIN)!;
    expect(manip.kind).toBe("manipulative");
    expect(manip.skillLabel).toBe("manip_area"); // node absent → skillKey fallback
    if (manip.kind === "manipulative") {
      expect(manip.verifier.kind).toBe("manipulative");
      expect(manip.prompt.answerType).toBe("manipulative");
      expect(manip.prompt.manipulativeSpec).toBe(JSON.stringify(areaSpec));
    }
  });

  test("buildStoredServable EXCLUDES a manipulative whose kind has been retired", () => {
    // The `factorGame` shape prod actually held: valid JSON, a string `kind`, so
    // `parseManipulativeSpec` accepts it — but no renderer and no `isSolved`
    // branch handles it any more, so serving it shows a blank frame that can
    // never be solved. Exclusion (null), not degradation to a text stem.
    const retired = buildStoredServable(
      "gen#manip1",
      manipulativeDoc({
        manipulativeSpec: JSON.stringify({
          kind: "factorGame",
          id: "factor-game-30",
          concept: "Factors and multiples",
          prompt: "Claim more of the 1–30 board than the bot.",
          boardSize: 30,
        }),
      }),
      node,
      DOMAIN,
    );
    expect(retired).toBeNull();
  });

  test("buildStoredServable EXCLUDES a specifically retired content spec", () => {
    const retired = buildStoredServable(
      "gen#manip1",
      manipulativeDoc({
        manipulativeSpec: JSON.stringify({
          kind: "numberline",
          id: "compare-4200-vs-3800",
          concept: "Comparing multi-digit numbers",
          prompt:
            "Place 4,200 on the line. Is it more or less than the marked 3,800?",
          min: 0,
          max: 10000,
          tickStep: 1000,
          snap: 100,
          start: 1000,
          markers: [{ value: 3800, label: "3,800" }],
          goal: { type: "placeAt", value: 4200, tolerance: 0.5 },
        }),
      }),
      node,
      DOMAIN,
    );
    expect(retired).toBeNull();
  });

  test("buildStoredServable still serves a manipulative whose spec is merely malformed", () => {
    // Unparseable is NOT retired: there is no evidence the mechanic is gone, so
    // the long-standing degrade-to-text-stem behavior is preserved and the row
    // keeps serving rather than silently vanishing from a scholar's queue.
    const malformed = buildStoredServable(
      "gen#manip1",
      manipulativeDoc({ manipulativeSpec: "{not json" }),
      node,
      DOMAIN,
    );
    expect(malformed).not.toBeNull();
    expect(malformed!.kind).toBe("manipulative");
    expect(malformed!.tutorContext).toEqual({ type: "text", stem: malformed!.prompt.stem });
  });

  test("buildStoredServable marks a stored item scaffold-eligible via prompt.workedSteps", () => {
    const withSteps = buildStoredServable(
      "gen#stored1",
      storedDoc({ workedSteps: [{ text: "step 1" }, { text: "step 2" }] }),
      node,
      DOMAIN,
    )!;
    expect(withSteps.prompt.workedSteps?.length).toBe(2);
  });
});

// ── Grading matrix ─────────────────────────────────────────────────────────

const stored = buildStoredServable("gen#stored1", storedDoc(), node, DOMAIN)!;
const manip = buildStoredServable("gen#manip1", manipulativeDoc(), node, DOMAIN)!;

function templateVerifier(item: ServableItem) {
  if (item.verifier.kind !== "template") throw new Error("expected a template verifier");
  return item.verifier;
}
const correctIntRaw = formatAnswer(templateVerifier(templateInt!).answer);
const mcAnswer = templateVerifier(templateMC!).answer as Extract<TypedAnswer, { type: "multipleChoice" }>;

type Case = {
  name: string;
  item: ServableItem;
  submission: Submission;
  correct: boolean;
};

const cases: Case[] = [
  // template (integer)
  { name: "template × typed correct", item: templateInt!, submission: { kind: "typed", raw: correctIntRaw }, correct: true },
  { name: "template × typed wrong", item: templateInt!, submission: { kind: "typed", raw: "-999999" }, correct: false },
  { name: "template × choice (mismatched type)", item: templateInt!, submission: { kind: "choice", index: 0 }, correct: false },
  { name: "template × manipulativeState (mismatched)", item: templateInt!, submission: { kind: "manipulativeState", stateJson: "{}" }, correct: false },
  { name: "template × dontKnow", item: templateInt!, submission: { kind: "dontKnow" }, correct: false },
  // template (multipleChoice) — the meaningful choice/typed-index paths
  { name: "template-MC × choice correct", item: templateMC!, submission: { kind: "choice", index: mcAnswer.choiceIndex }, correct: true },
  { name: "template-MC × choice wrong", item: templateMC!, submission: { kind: "choice", index: (mcAnswer.choiceIndex + 1) % 3 }, correct: false },
  { name: "template-MC × typed index correct", item: templateMC!, submission: { kind: "typed", raw: String(mcAnswer.choiceIndex) }, correct: true },
  { name: "template-MC × dontKnow", item: templateMC!, submission: { kind: "dontKnow" }, correct: false },
  // stored (integer word problem)
  { name: "stored × typed correct", item: stored, submission: { kind: "typed", raw: "42" }, correct: true },
  { name: "stored × typed wrong", item: stored, submission: { kind: "typed", raw: "41" }, correct: false },
  { name: "stored × choice (mismatched type)", item: stored, submission: { kind: "choice", index: 0 }, correct: false },
  { name: "stored × manipulativeState (mismatched)", item: stored, submission: { kind: "manipulativeState", stateJson: "{}" }, correct: false },
  { name: "stored × dontKnow", item: stored, submission: { kind: "dontKnow" }, correct: false },
  // manipulative
  { name: "manipulative × manipulativeState correct", item: manip, submission: { kind: "manipulativeState", stateJson: JSON.stringify({ width: 4 }) }, correct: true },
  { name: "manipulative × manipulativeState wrong", item: manip, submission: { kind: "manipulativeState", stateJson: JSON.stringify({ width: 3 }) }, correct: false },
  { name: "manipulative × manipulativeState malformed", item: manip, submission: { kind: "manipulativeState", stateJson: "not json {" }, correct: false },
  { name: "manipulative × typed (raw as opaque state) correct", item: manip, submission: { kind: "typed", raw: JSON.stringify({ width: 4 }) }, correct: true },
  { name: "manipulative × typed (raw as opaque state) wrong", item: manip, submission: { kind: "typed", raw: "garbage" }, correct: false },
  { name: "manipulative × choice (no state)", item: manip, submission: { kind: "choice", index: 4 }, correct: false },
  { name: "manipulative × dontKnow", item: manip, submission: { kind: "dontKnow" }, correct: false },
];

describe("gradeSubmission matrix (each item kind × each submission kind × three policies)", () => {
  for (const c of cases) {
    for (const policy of [PRACTICE_POLICY, GRADE_ONLY_POLICY, PLACEMENT_POLICY] as GradePolicy[]) {
      test(`${c.name} [${policy.surface}]`, () => {
        const g = gradeSubmission(c.item, c.submission, policy);

        // The verdict is policy-independent.
        expect(g.correct).toBe(c.correct);

        const isManipulative = c.item.kind === "manipulative";
        const isDontKnow = c.submission.kind === "dontKnow";
        expect(g.isManipulative).toBe(isManipulative);
        expect(g.isDontKnow).toBe(isDontKnow);
        expect(g.skillKey).toBe(c.item.skillKey);
        expect(g.stem).toBe(c.item.prompt.stem);

        // Record intentions mirror the policy verbatim.
        expect(g.shouldRecordMastery).toBe(policy.recordMastery);
        expect(g.shouldRecordPracticeAttempt).toBe(policy.recordPracticeAttempt);
        expect(g.shouldRecordLatency).toBe(policy.recordLatency);

        // Error classification: gated to a non-manipulative, non-dontKnow miss,
        // AND the policy opting in.
        const wantClassify = policy.classifyErrorPatterns && !c.correct && !isManipulative && !isDontKnow;
        expect(g.shouldClassifyError).toBe(wantClassify);

        // Explanation reason: only a dontKnow miss, only when the policy stamps it.
        expect(g.explanationReason).toBe(
          policy.explanation === "dontKnowReason" && isDontKnow ? "dont_know" : undefined,
        );

        // Reveal: a manipulative never reveals; otherwise per the policy rule.
        if (isManipulative || policy.revealAnswer === "never") {
          expect(g.revealedAnswer).toBeUndefined();
        } else if (policy.revealAnswer === "onCorrect") {
          expect(g.revealedAnswer).toBe(c.correct ? g.correctAnswer : undefined);
        } else {
          // "always" (PLACEMENT_POLICY): a locked measurement reveals on a miss
          // AND a correct — even a dontKnow reveals the answer (to teach).
          expect(g.revealedAnswer).toBe(g.correctAnswer);
        }
      });
    }
  }
});

describe("gradeSubmission policy differences", () => {
  test("PRACTICE_POLICY reveals a correct non-manipulative answer; GRADE_ONLY never reveals", () => {
    const sub: Submission = { kind: "typed", raw: "42" };
    const practice = gradeSubmission(stored, sub, PRACTICE_POLICY);
    expect(practice.correct).toBe(true);
    expect(practice.revealedAnswer).toBe("42");

    const gradeOnly = gradeSubmission(stored, sub, GRADE_ONLY_POLICY);
    expect(gradeOnly.correct).toBe(true);
    expect(gradeOnly.revealedAnswer).toBeUndefined();
    expect(gradeOnly.shouldRecordMastery).toBe(false);
    expect(gradeOnly.shouldRecordPracticeAttempt).toBe(false);
    expect(gradeOnly.shouldRecordLatency).toBe(false);
  });

  test("a wrong non-manipulative answer never reveals under either policy", () => {
    const sub: Submission = { kind: "typed", raw: "41" };
    expect(gradeSubmission(stored, sub, PRACTICE_POLICY).revealedAnswer).toBeUndefined();
    expect(gradeSubmission(stored, sub, GRADE_ONLY_POLICY).revealedAnswer).toBeUndefined();
  });

  test("finalCredit forces the recorded outcome, but an explicit dontKnow stays a miss", () => {
    const creditPolicy: GradePolicy = { ...GRADE_ONLY_POLICY, finalCredit: true };
    // A wrong typed answer is force-credited correct...
    expect(gradeSubmission(stored, { kind: "typed", raw: "41" }, creditPolicy).correct).toBe(true);
    // ...but an honest "I don't know" is never force-credited.
    expect(gradeSubmission(stored, { kind: "dontKnow" }, creditPolicy).correct).toBe(false);
  });
});

describe("PLACEMENT_POLICY (U-3) — locked-measurement reveal + no drill side effects", () => {
  test("a TEMPLATE reveals its answer on a correct AND on a miss (the placement carve-out)", () => {
    const correct = gradeSubmission(templateInt!, { kind: "typed", raw: correctIntRaw }, PLACEMENT_POLICY);
    expect(correct.correct).toBe(true);
    expect(correct.revealedAnswer).toBe(correct.correctAnswer);

    const miss = gradeSubmission(templateInt!, { kind: "typed", raw: "-999999" }, PLACEMENT_POLICY);
    expect(miss.correct).toBe(false);
    expect(miss.revealedAnswer).toBe(miss.correctAnswer);
  });

  test("a dontKnow on a template is a miss that STILL reveals the answer (teach)", () => {
    const g = gradeSubmission(templateInt!, { kind: "dontKnow" }, PLACEMENT_POLICY);
    expect(g.correct).toBe(false);
    expect(g.isDontKnow).toBe(true);
    expect(g.revealedAnswer).toBe(g.correctAnswer);
  });

  test("a MANIPULATIVE never reveals — even under the always-reveal placement policy", () => {
    const ok = gradeSubmission(
      manip,
      { kind: "manipulativeState", stateJson: JSON.stringify({ width: 4 }) },
      PLACEMENT_POLICY,
    );
    expect(ok.correct).toBe(true);
    expect(ok.revealedAnswer).toBeUndefined();

    const bad = gradeSubmission(
      manip,
      { kind: "manipulativeState", stateJson: JSON.stringify({ width: 3 }) },
      PLACEMENT_POLICY,
    );
    expect(bad.correct).toBe(false);
    expect(bad.revealedAnswer).toBeUndefined();

    const idk = gradeSubmission(manip, { kind: "dontKnow" }, PLACEMENT_POLICY);
    expect(idk.revealedAnswer).toBeUndefined();
  });

  test("records NO drill side effects (placement drives its own attempt/credit)", () => {
    const g = gradeSubmission(templateInt!, { kind: "typed", raw: correctIntRaw }, PLACEMENT_POLICY);
    expect(g.shouldRecordMastery).toBe(false);
    expect(g.shouldRecordPracticeAttempt).toBe(false);
    expect(g.shouldRecordLatency).toBe(false);
    expect(g.shouldClassifyError).toBe(false);
    // No error classifier on a placement miss, either.
    expect(gradeSubmission(templateInt!, { kind: "typed", raw: "-1" }, PLACEMENT_POLICY).shouldClassifyError).toBe(false);
  });
});
