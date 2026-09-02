import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  advanceStep,
  applyKey,
  applyUnitKey,
  choiceSubmitValue,
  classifyVerdict,
  comesBackLine,
  computeTiming,
  EXPLAIN_STREAM_INACTIVITY_TIMEOUT_MS,
  EXPLAIN_STREAM_TOTAL_TIMEOUT_MS,
  formatComesBack,
  isFirstAttempt,
  isLastItem,
  isMultipleChoiceItem,
  isPadAnswerType,
  mappingPretestProgress,
  MAPPING_PRETEST_MAX_QUESTIONS,
  MISSES_BEFORE_STUCK,
  nextStreak,
  padAcceptsFraction,
  padShowFraction,
  padShowRemainder,
  padShowSign,
  placementFeedback,
  placementProgress,
  placementQuestionCap,
  payloadClientEventReceipt,
  PRACTICE_SESSION_SIZE,
  progressFraction,
  shouldPulseStreak,
  showsMappingFeedback,
  streamStoryOpenTurn,
  STREAK_PULSE_DELAY_MS,
  STREAK_PULSE_EVERY,
  summarize,
  challengeFrontierMove,
  CHALLENGE_OFFER_TITLE,
  CHALLENGE_OFFER_ACCEPT,
  CHALLENGE_OFFER_DECLINE,
  challengeOfferBody,
  STRETCH_TILE_HEADLINE,
  STRETCH_TILE_SUBTITLE,
  STRETCH_TILE_ARIA_LABEL,
  SPIRAL_COACH_LABEL,
  SPIRAL_COACH_BODY,
  SPIRAL_COACH_COMPLETE_BODY,
  SPIRAL_HANDOFF_OPENER,
  SPIRAL_FRESH_BODY,
  SPIRAL_OFFER_SECONDARY,
  SPIRAL_REPAIR_BODY,
  SPIRAL_REPAIR_NO_STEP_BODY,
  SPIRAL_RECOVERY_WON_CLOSE,
  SPIRAL_WARM_CLOSE,
  advanceBreakerFlow,
  breakerBody,
  breakerCloseLine,
  breakerControlLabel,
  breakerEasySubmitArgs,
  breakerFreshSubmitArgs,
  breakerShouldAutoOpenCoach,
  breakerFreshReconstructable,
  breakerSupportRecorded,
  breakerControls,
  breakerLegacyOffer,
  breakerLegacyRecovery,
  breakerRecovered,
  newBreakerFlow,
  requestBreakerEasyFinish,
  type BreakerEvent,
  type BreakerFlow,
  type ExplainFetch,
  sanitizePadInput,
  unitKeyFamily,
  UNIT_MISSING_NUDGE,
  UNIT_WRONG_NUDGE,
  unitOutcomeNudge,
  type SessionLogEntry,
} from "./practiceLoop";
import { RECOVERY_CLOSURE_ENABLED } from "./closureLines";
import { superscriptExponents } from "./mathNotation";
import { hasUnitToken, splitUnitSuffix } from "@/convex/lib/practice/answers";

describe("payload client-event receipts", () => {
  it("preserves an id only for an identical payload", () => {
    const first = payloadClientEventReceipt(
      null,
      '{"answer":"one"}',
      "practice-answer",
    );
    expect(
      payloadClientEventReceipt(
        first,
        '{"answer":"one"}',
        "practice-answer",
      ),
    ).toBe(first);

    const changed = payloadClientEventReceipt(
      first,
      '{"answer":"two"}',
      "practice-answer",
    );
    expect(changed.payloadKey).toBe('{"answer":"two"}');
    expect(changed.clientEventId).not.toBe(first.clientEventId);
  });
});

describe("answer normalization", () => {
  it("classifies pad answer types", () => {
    expect(isPadAnswerType("integer")).toBe(true);
    expect(isPadAnswerType("decimal")).toBe(true);
    expect(isPadAnswerType("fraction")).toBe(true);
    expect(isPadAnswerType("expression")).toBe(true);
    expect(isPadAnswerType("multipleChoice")).toBe(false);
    expect(isPadAnswerType("manipulative")).toBe(false);
    expect(isPadAnswerType("nonsense")).toBe(false);
  });

  it("only shows the remainder key for expressions", () => {
    expect(padShowRemainder("expression")).toBe(true);
    expect(padShowRemainder("integer")).toBe(false);
    expect(padShowRemainder("fraction")).toBe(false);
    expect(padShowRemainder("decimal")).toBe(false);
  });

  it("shows the sign-toggle key for every numeric type except expression", () => {
    expect(padShowSign("integer")).toBe(true);
    expect(padShowSign("decimal")).toBe(true);
    expect(padShowSign("fraction")).toBe(true);
    expect(padShowSign("expression")).toBe(false);
  });

  it("shows the wide fraction key only for decimal items", () => {
    expect(padShowFraction("decimal")).toBe(true);
    expect(padShowFraction("integer")).toBe(false);
    expect(padShowFraction("fraction")).toBe(false); // `/` already in the grid
    expect(padShowFraction("expression")).toBe(false);
  });

  it("offers a `/` affordance for every flat type that accepts one (web parity)", () => {
    // Web has no number grid, so it reads this to decide whether to render an
    // on-screen `/` key. Integers never take a slash; the other three do.
    expect(padAcceptsFraction("decimal")).toBe(true);
    expect(padAcceptsFraction("fraction")).toBe(true);
    expect(padAcceptsFraction("expression")).toBe(true);
    expect(padAcceptsFraction("integer")).toBe(false);
  });

  it("applies a keypad press like the web onKey reducer", () => {
    expect(applyKey("", "7")).toBe("7");
    expect(applyKey("7", "8")).toBe("78");
    expect(applyKey("78", "⌫")).toBe("7");
    expect(applyKey("", "⌫")).toBe("");
    expect(applyKey("3", "/")).toBe("3/");
    expect(applyKey("3/4", ".")).toBe("3/4.");
  });

  it("toggles a LEADING minus sign with ± (or a hardware -), never mid-number", () => {
    // Starting from empty, toggling goes straight to a leading minus.
    expect(applyKey("", "±")).toBe("-");
    expect(applyKey("", "-")).toBe("-");
    // Digits after the toggle build up normally.
    expect(applyKey(applyKey("", "±"), "5")).toBe("-5");
    expect(applyKey("-5", "3")).toBe("-53");
    // Pressing ± again REMOVES the leading minus (a true toggle).
    expect(applyKey("-53", "±")).toBe("53");
    // Toggling on an already-typed positive number prepends the minus —
    // never inserts one mid-string.
    expect(applyKey("53", "-")).toBe("-53");
    // Backspace still trims from the end, independent of the sign.
    expect(applyKey("-53", "⌫")).toBe("-5");
    // Clearing to empty and re-toggling starts clean.
    expect(applyKey(applyKey("-5", "⌫"), "⌫")).toBe("");
  });

  it("inserts a spaced remainder token for the R key (the '7 R 2' form)", () => {
    expect(applyKey("7", "R")).toBe("7 R ");
    // A full division-with-remainder answer builds up key by key.
    expect(applyKey(applyKey("7", "R"), "2")).toBe("7 R 2");
  });

  it("sanitizes hardware-typed input to each pad type's charset", () => {
    // Digits pass through for every type.
    expect(sanitizePadInput("integer", "42")).toBe("42");
    // Letters / stray symbols are dropped.
    expect(sanitizePadInput("integer", "4a2!")).toBe("42");
    // `.` is decimal-only.
    expect(sanitizePadInput("decimal", "3.5")).toBe("3.5");
    expect(sanitizePadInput("integer", "3.5")).toBe("35");
    // `/` is decimal/fraction/expression — decimal items accept fraction
    // input because the grader compares by value (105/16 ≡ 6.5625).
    expect(sanitizePadInput("fraction", "3/4")).toBe("3/4");
    expect(sanitizePadInput("expression", "12/4")).toBe("12/4");
    expect(sanitizePadInput("decimal", "105/16")).toBe("105/16");
    expect(sanitizePadInput("integer", "3/4")).toBe("34");
    // Expression keeps the remainder token; lowercase r is normalized to R.
    expect(sanitizePadInput("expression", "7 r 2")).toBe("7 R 2");
    expect(sanitizePadInput("expression", "7 R 2")).toBe("7 R 2");
    // A LEADING `-` (negatives) is accepted for parity with web's keydown
    // handler and the pad's own ± toggle.
    expect(sanitizePadInput("integer", "-5")).toBe("-5");
    // A `-` that isn't leading is dropped — never a mid-number minus.
    expect(sanitizePadInput("integer", "5-3")).toBe("53");
    expect(sanitizePadInput("decimal", "1.5-2")).toBe("1.52");
  });

  it("widens the charset for a unit-bearing item only when allowUnit is set", () => {
    // Byte-identical to before when opts is omitted — every existing caller
    // (a unit-free item) is unaffected.
    expect(sanitizePadInput("integer", "112 cm")).toBe("112");
    // With allowUnit, letters/space/caret/superscript glyphs survive.
    expect(sanitizePadInput("integer", "112 cm", { allowUnit: true })).toBe("112 cm");
    expect(sanitizePadInput("integer", "112 cm^3", { allowUnit: true })).toBe("112 cm^3");
    expect(sanitizePadInput("integer", "112 cm³", { allowUnit: true })).toBe("112 cm³");
    expect(sanitizePadInput("integer", "24 sq cm", { allowUnit: true })).toBe("24 sq cm");
    // Digits/sign/decimal keep their exact per-type rules underneath the
    // widened unit charset — a stray `!` still drops.
    expect(sanitizePadInput("integer", "112! cm", { allowUnit: true })).toBe("112 cm");
  });

  it("submits a multiple-choice option as its index string", () => {
    expect(choiceSubmitValue(0)).toBe("0");
    expect(choiceSubmitValue(3)).toBe("3");
  });

  it("derives a unit key family from the served display unit", () => {
    // The whole dimension family, base-first, regardless of which power the
    // item actually asked for.
    expect(unitKeyFamily("cm³")).toEqual(["cm", "cm²", "cm³"]);
    expect(unitKeyFamily("cm²")).toEqual(["cm", "cm²", "cm³"]);
    expect(unitKeyFamily("cm")).toEqual(["cm", "cm²", "cm³"]);
    expect(unitKeyFamily("m³")).toEqual(["m", "m²", "m³"]);
    expect(unitKeyFamily("")).toEqual([]);
    // Degrees is dimensionless: a single ° key, never the "°²"/"°³" family the
    // cm/m branch would otherwise produce.
    expect(unitKeyFamily("°")).toEqual(["°"]);
  });

  it("applies a tapped unit key by replacing any trailing unit token", () => {
    // No unit typed yet — appended with a separating space.
    expect(applyUnitKey("112", "cm³")).toBe("112 cm³");
    // A prior unicode-superscript unit is swapped, not stacked.
    expect(applyUnitKey("112 cm²", "cm³")).toBe("112 cm³");
    // A prior hardware-typed CARET unit is swapped too — applyUnitKey doesn't
    // care which form produced the trailing token. (Regression: this used to
    // append instead of replace, producing the broken "112 cm^2 cm³".)
    expect(applyUnitKey("112 cm^2", "cm³")).toBe("112 cm³");
    // An in-progress caret with no digit typed yet is also swapped cleanly.
    expect(applyUnitKey("112 cm^", "cm³")).toBe("112 cm³");
    // A bare unit with no number yet passes through untouched (no leading space).
    expect(applyUnitKey("", "cm³")).toBe("cm³");
    // Degrees binds to the number with NO space, and re-tapping is idempotent
    // (never "65° °") — its trailing token is stripped the same as a letter unit.
    expect(applyUnitKey("65", "°")).toBe("65°");
    expect(applyUnitKey("65°", "°")).toBe("65°");
    expect(applyUnitKey("65 °", "°")).toBe("65°");
    expect(applyUnitKey("", "°")).toBe("°");
  });

  it("degrees round-trips as a required unit: typed ° and tapped ° grade alike", () => {
    // The ° key produces "65°"; a hardware-typed "65°" (allowed through by
    // sanitizePadInput's unit carve-out) must reach the same graded token.
    const tapped = applyUnitKey("65", "°");
    let typed = "";
    for (const ch of "65°") {
      typed = applyKey(typed, sanitizePadInput("integer", ch, { allowUnit: true }));
    }
    expect(typed).toBe("65°");
    expect(typed).toBe(tapped);
    expect(splitUnitSuffix(typed).unit).toBe("deg");
    expect(hasUnitToken(typed)).toBe(true);
  });

  it("nudges missing vs. wrong unit outcomes with the same two lines everywhere", () => {
    expect(unitOutcomeNudge("missing")).toBe(UNIT_MISSING_NUDGE);
    expect(unitOutcomeNudge("wrong")).toBe(UNIT_WRONG_NUDGE);
    expect(unitOutcomeNudge(undefined)).toBeNull();
  });

  it("a hardware-typed caret exponent normalizes to the SAME unicode form the unit-key tap produces", () => {
    // This is the exact composition every practice surface (web + native)
    // applies at its input call site: sanitize the widened unit charset,
    // append via applyKey, then normalize the exponent for display. It must
    // converge on the identical string a tap of the pad's unit key would
    // have produced directly via applyUnitKey.
    const typeUnit = (raw: string) => {
      let buf = "";
      for (const ch of raw) {
        const next = applyKey(buf, sanitizePadInput("integer", ch, { allowUnit: true }));
        buf = superscriptExponents(next);
      }
      return buf;
    };

    const typed = typeUnit("112 cm^3");
    const tapped = applyUnitKey("112", "cm³");
    expect(typed).toBe("112 cm³");
    expect(typed).toBe(tapped);

    // The two-superscript family (area) converges the same way.
    expect(typeUnit("24 m^2")).toBe(applyUnitKey("24", "m²"));

    // And both forms grade identically server-side — the display fix is
    // purely cosmetic, never a second code path for the grader.
    expect(splitUnitSuffix(typed)).toEqual(splitUnitSuffix(tapped));
    expect(hasUnitToken(typed)).toBe(hasUnitToken(tapped));
  });

  it("identifies a multiple-choice item only when it carries tappable choices", () => {
    // MC WITH choices → tappable buttons; qualifies for the IHLTY escape (J5).
    expect(isMultipleChoiceItem("multipleChoice", 3)).toBe(true);
    expect(isMultipleChoiceItem("multipleChoice", 1)).toBe(true);
    // A bare `multipleChoice` with no choices coerces to the pad — not MC-tappable.
    expect(isMultipleChoiceItem("multipleChoice", 0)).toBe(false);
    expect(isMultipleChoiceItem("multipleChoice", undefined)).toBe(false);
    // Every other answer type is never a tappable-choice item.
    expect(isMultipleChoiceItem("integer", 4)).toBe(false);
    expect(isMultipleChoiceItem("manipulative", 4)).toBe(false);
    expect(isMultipleChoiceItem("fraction", 4)).toBe(false);
  });
});

describe("record semantics", () => {
  it("records the first attempt, not a retry", () => {
    expect(isFirstAttempt(false)).toBe(true); // nothing recorded yet
    expect(isFirstAttempt(true)).toBe(false); // already recorded → a retry
  });
});

describe("mapping feedback visibility (Option D check-in vs. blended playlist)", () => {
  it("stays silent for the true check-in/pretest sit (allMapping)", () => {
    // The day-1/cold-start sit where EVERY served item is a mapping probe —
    // the only surface this repo still calls "the pretest". No verdict,
    // reveal, or haptic; the scholar just advances (`server allMapping: true`
    // — see convex/lib/practice/__tests__/mapping.test.ts).
    expect(showsMappingFeedback(true)).toBe(false);
  });

  it("shows the same reveal-only feedback as an ordinary drill item once mapping is folded into a normal playlist", () => {
    // An already-placed scholar picking up an unmapped domain gets ≤2
    // mapping items blended alongside real review/new work
    // (`server allMapping: false`) — those items must surface a verdict rather
    // than silently advancing as though the whole playlist were a check-in.
    expect(showsMappingFeedback(false)).toBe(true);
  });
});

describe("mapping pretest progress", () => {
  it("keeps one honest ceiling from the first probe through recompositions", () => {
    expect(MAPPING_PRETEST_MAX_QUESTIONS).toBe(18);
    expect(mappingPretestProgress(0)).toEqual({
      label: "1 of up to 18",
      fraction: 0,
      questionNumber: 1,
      maxQuestions: 18,
    });
    expect(mappingPretestProgress(9).label).toBe("10 of up to 18");
    expect(mappingPretestProgress(15).label).toBe("16 of up to 18");
  });

  it("clamps malformed or overshot indices to the fixed sitting cap", () => {
    expect(mappingPretestProgress(-3).questionNumber).toBe(1);
    expect(mappingPretestProgress(99)).toEqual({
      label: "18 of up to 18",
      fraction: 17 / 18,
      questionNumber: 18,
      maxQuestions: 18,
    });
  });
});

describe("placement feedback", () => {
  it("reveals the answer but no longer promises an interactive step it can't render", () => {
    // Placement probes are template/manipulative items — they never carry
    // `workedSteps` — so the copy must not promise "work through one step here"
    // (that action lives only on the drill's don't-know teaching step, where
    // stored items with worked steps exist).
    const unknown = placementFeedback("unknown", "14");
    expect(unknown.body).toContain("The answer was 14.");
    expect(unknown.body).not.toContain("work through one step");

    const miss = placementFeedback("incorrect", "14");
    expect(miss.body).toContain("The answer was 14.");
    expect(miss.body).not.toContain("work through one step");
  });

  it("does not double punctuation already present in a choice label", () => {
    const feedback = placementFeedback(
      "unknown",
      "Yes. The points form a straight line through the origin.",
    );
    expect(feedback.body).toContain(
      "The answer was Yes. The points form a straight line through the origin.",
    );
    expect(feedback.body).not.toContain("origin..");
  });
});

describe("computeTiming", () => {
  it("measures elapsed + first-key latency on the first attempt", () => {
    expect(
      computeTiming({ firstAttempt: true, nowMs: 1000, renderAtMs: 200, firstKeyAtMs: 500 }),
    ).toEqual({ elapsedMs: 800, firstKeyMs: 300 });
  });

  it("omits firstKeyMs when no keystroke was observed", () => {
    expect(
      computeTiming({ firstAttempt: true, nowMs: 1000, renderAtMs: 200, firstKeyAtMs: null }),
    ).toEqual({ elapsedMs: 800 });
  });

  it("measures nothing on a retry (stale clock, not recorded)", () => {
    expect(
      computeTiming({ firstAttempt: false, nowMs: 1000, renderAtMs: 200, firstKeyAtMs: 500 }),
    ).toEqual({});
  });
});

describe("streak + haptic cadence", () => {
  it("bumps on correct and resets to zero on a miss", () => {
    expect(nextStreak(0, true)).toBe(1);
    expect(nextStreak(4, true)).toBe(5);
    expect(nextStreak(4, false)).toBe(0);
    expect(nextStreak(0, false)).toBe(0);
  });

  it("pulses only on every Nth in a row (never at zero)", () => {
    expect(STREAK_PULSE_EVERY).toBe(3);
    expect(STREAK_PULSE_DELAY_MS).toBe(140);
    expect(shouldPulseStreak(0)).toBe(false);
    expect(shouldPulseStreak(1)).toBe(false);
    expect(shouldPulseStreak(2)).toBe(false);
    expect(shouldPulseStreak(3)).toBe(true);
    expect(shouldPulseStreak(6)).toBe(true);
    expect(shouldPulseStreak(4)).toBe(false);
  });
});

describe("advance state machine", () => {
  it("knows the last item of a session", () => {
    expect(isLastItem(0, 10)).toBe(false);
    expect(isLastItem(8, 10)).toBe(false);
    expect(isLastItem(9, 10)).toBe(true);
    expect(isLastItem(9, 1)).toBe(true);
  });

  it("advances to the next item until the session finishes", () => {
    expect(advanceStep(0, 3)).toEqual({ done: false, nextIdx: 1 });
    expect(advanceStep(1, 3)).toEqual({ done: false, nextIdx: 2 });
    expect(advanceStep(2, 3)).toEqual({ done: true });
  });

  it("classifies the four feedback verdicts", () => {
    expect(MISSES_BEFORE_STUCK).toBe(2);
    // correct → accelerated vs plain correct
    expect(classifyVerdict({ correct: true, accelerated: true }, 0)).toBe("accelerated");
    expect(classifyVerdict({ correct: true }, 0)).toBe("correct");
    // miss → retry until the stuck threshold, then stuck
    expect(classifyVerdict({ correct: false }, 0)).toBe("retry");
    expect(classifyVerdict({ correct: false }, 1)).toBe("retry");
    expect(classifyVerdict({ correct: false }, 2)).toBe("stuck");
    expect(classifyVerdict({ correct: false }, 3)).toBe("stuck");
  });

  it("walks a full miss → retry → second miss → stuck sequence", () => {
    // first miss: still retry, item stays; record only the first attempt
    expect(isFirstAttempt(false)).toBe(true);
    expect(classifyVerdict({ correct: false }, 1)).toBe("retry");
    // retry is graded but not recorded
    expect(isFirstAttempt(true)).toBe(false);
    // second miss: stuck (offer help / fresh variant)
    expect(classifyVerdict({ correct: false }, 2)).toBe("stuck");
  });
});

describe("progress + summary", () => {
  // Shortened core (raise-the-ceiling plan §C-3): the mandatory core dropped
  // 10 → 6, with optional bonus sets (challenge / more-of-your-pick / tune-up)
  // offered on the done screen for anyone who wants more.
  it("defaults a session to six items", () => {
    expect(PRACTICE_SESSION_SIZE).toBe(6);
  });

  it("counts the current item, plus one once it is answered", () => {
    expect(progressFraction(0, 10, false)).toBeCloseTo(0);
    expect(progressFraction(0, 10, true)).toBeCloseTo(0.1);
    expect(progressFraction(4, 10, false)).toBeCloseTo(0.4);
    expect(progressFraction(9, 10, true)).toBeCloseTo(1);
  });

  it("shows bounded progress for an adaptive placement", () => {
    expect(placementQuestionCap(2)).toBe(10);
    expect(placementQuestionCap(20)).toBe(25);
    expect(placementQuestionCap([5, 4])).toBe(9);
    expect(placementProgress(3, 10)).toEqual({
      label: "Question 4 of up to 10",
      percent: 30,
      questionNumber: 4,
      maxQuestions: 10,
    });
    expect(placementProgress(3, 10, true).questionNumber).toBe(3);
  });

  it("summarizes count, correct total, and distinct skills in first-seen order", () => {
    const log: SessionLogEntry[] = [
      { correct: true, skillLabel: "Add within 20" },
      { correct: false, skillLabel: "Add within 20" },
      { correct: true, skillLabel: "Subtract within 20" },
      { correct: true, skillLabel: "Add within 20" },
    ];
    expect(summarize(log)).toEqual({
      total: 4,
      correctCount: 3,
      skills: ["Add within 20", "Subtract within 20"],
    });
  });

  it("summarizes an empty log", () => {
    expect(summarize([])).toEqual({ total: 0, correctCount: 0, skills: [] });
  });
});

describe("challengeFrontierMove — loosened above-band clear trigger", () => {
  const skill = (n: number, correct: boolean, dontKnow = false): SessionLogEntry => ({
    correct,
    skillLabel: `Skill ${n}`,
    dontKnow,
  });

  it("FIRES on a strong clear with honest don't-know flags (8/10, 2 IDK)", () => {
    // The round-4 kid: clears the ones she's met, honestly flags the rest.
    const log: SessionLogEntry[] = [
      ...Array.from({ length: 8 }, (_, i) => skill(i, true)),
      skill(8, false, true),
      skill(9, false, true),
    ];
    const res = challengeFrontierMove(log);
    expect(res.moved).toBe(true);
    expect(res.skills).toHaveLength(8);
  });

  it("FIRES on 9/10 with a single honest don't-know flag", () => {
    const log: SessionLogEntry[] = [
      ...Array.from({ length: 9 }, (_, i) => skill(i, true)),
      skill(9, false, true),
    ];
    expect(challengeFrontierMove(log).moved).toBe(true);
  });

  it("FIRES on a majority clear with real misses (8 correct, 2 wrong)", () => {
    const log: SessionLogEntry[] = [
      ...Array.from({ length: 8 }, (_, i) => skill(i, true)),
      skill(8, false),
      skill(9, false),
    ];
    expect(challengeFrontierMove(log).moved).toBe(true);
  });

  it("does NOT fire on a failed round (2/10)", () => {
    const log: SessionLogEntry[] = [
      skill(0, true),
      skill(1, true),
      ...Array.from({ length: 8 }, (_, i) => skill(i + 2, false)),
    ];
    expect(challengeFrontierMove(log).moved).toBe(false);
  });

  it("does NOT fire when every item is honestly flagged (all IDK)", () => {
    const log: SessionLogEntry[] = Array.from({ length: 4 }, (_, i) =>
      skill(i, false, true),
    );
    const res = challengeFrontierMove(log);
    expect(res.moved).toBe(false);
    expect(res.skills).toEqual([]);
  });

  it("does NOT fire on an exact half-and-half split (no honest flags)", () => {
    const log: SessionLogEntry[] = [
      ...Array.from({ length: 5 }, (_, i) => skill(i, true)),
      ...Array.from({ length: 5 }, (_, i) => skill(i + 5, false)),
    ];
    expect(challengeFrontierMove(log).moved).toBe(false);
  });

  it("does NOT fire on an empty log", () => {
    expect(challengeFrontierMove([])).toEqual({ moved: false, skills: [] });
  });

  it("names the distinct cleared skills in first-seen order, deduped", () => {
    const log: SessionLogEntry[] = [
      { correct: true, skillLabel: "Powers of ten" },
      { correct: true, skillLabel: "Powers of ten" },
      { correct: false, skillLabel: "Long division", dontKnow: true },
      { correct: true, skillLabel: "Exponent laws" },
    ];
    const res = challengeFrontierMove(log);
    expect(res.moved).toBe(true);
    // "Long division" was honestly flagged — attempted = 3, cleared = 3 (dedup 2)
    expect(res.skills).toEqual(["Powers of ten", "Exponent laws"]);
  });
});

describe("challenge invitation copy (shared web/native)", () => {
  it("uses the calm, no-penalty invitation title", () => {
    expect(CHALLENGE_OFFER_TITLE).toBe("Want a challenge?");
  });

  it("phrases the body one-vs-few by stretch count, with a stated no-penalty out", () => {
    expect(challengeOfferBody(1)).toContain("one that's");
    expect(challengeOfferBody(2)).toContain("a few that are");
    // Never gamified: no score/streak/timer language; the decline is penalty-free.
    for (const n of [1, 2, 3]) {
      const body = challengeOfferBody(n);
      expect(body.toLowerCase()).not.toMatch(/streak|timer|points|score you|beat/);
      expect(body).toContain("No score");
      expect(body).toContain("stopping is always fine");
    }
  });

  it("labels the decline as a soft out, not skip/quit", () => {
    expect(CHALLENGE_OFFER_DECLINE).toBe("Not now");
    expect(CHALLENGE_OFFER_ACCEPT).toBe("Try it");
  });
});

describe("three-miss breaker copy (shared web/native)", () => {
  it("pushes a concrete half-step instead of the old binary ask", () => {
    // The binary "Crack one together / Easy one, then stop" offer is gone: every
    // observed scholar answered it by leaving. The repair card names the size of
    // the ask — the SMALLEST missing piece — not an open-ended conversation.
    expect(SPIRAL_REPAIR_BODY).toBe(
      "Those were some tricky ones. Let\u2019s find the smallest missing piece.",
    );
    expect(SPIRAL_REPAIR_NO_STEP_BODY).toContain("take one apart together");
    expect(SPIRAL_FRESH_BODY).toBe("Here’s a fresh one on this.");
    expect(SPIRAL_COACH_LABEL).toBe("Still stuck? Crack it with the tutor");
    expect(SPIRAL_OFFER_SECONDARY).toBe("Easy one, then stop");
  });

  it("makes no time promise and never speaks in scores", () => {
    for (const copy of [
      SPIRAL_REPAIR_BODY,
      SPIRAL_REPAIR_NO_STEP_BODY,
      SPIRAL_FRESH_BODY,
      SPIRAL_COACH_LABEL,
      SPIRAL_OFFER_SECONDARY,
      breakerControlLabel("checkStep"),
    ]) {
      expect(copy.toLowerCase()).not.toMatch(/minute|min\b|second|sec\b|\d/);
      expect(copy.toLowerCase()).not.toMatch(
        /streak|timer|points|score|badge|grit|remediat/,
      );
    }
  });

  it("keeps the one exit dignified and jargon-free (never the naughty choice)", () => {
    expect(SPIRAL_OFFER_SECONDARY.toLowerCase()).not.toMatch(
      /wrong|fail|give up|quit|stuck|trouble|can't|behind/,
    );
  });

  it("uses sentence case (no title-case buttons)", () => {
    // Only the first word capitalized (no genuine proper nouns in these strings).
    for (const copy of [
      SPIRAL_OFFER_SECONDARY,
      breakerControlLabel("checkStep"),
    ]) {
      const words = copy.split(/\s+/);
      expect(words.slice(1).every((w) => w[0] === w[0].toLowerCase())).toBe(true);
    }
  });

  it("opens the coach on the ONE problem already on the table", () => {
    // The repair rung put a specific item up, so there is nothing left to pick.
    expect(SPIRAL_HANDOFF_OPENER).not.toContain("Pick the one");
    expect(SPIRAL_HANDOFF_OPENER).toContain("this one");
  });

  it("is read from the shared module by BOTH frontends, not hardcoded", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const web = readFileSync(resolve(repoRoot, "components/practice/PracticeSession.tsx"), "utf8");
    const webHost = readFileSync(resolve(repoRoot, "hooks/usePracticeMachine.ts"), "utf8");
    const machine = readFileSync(resolve(repoRoot, "shared/practiceMachine.ts"), "utf8");
    const native = readFileSync(resolve(repoRoot, "native/src/app/practice.tsx"), "utf8");
    const nativeHost = readFileSync(resolve(repoRoot, "native/src/hooks/usePracticeMachine.ts"), "utf8");
    const vendor = readFileSync(resolve(repoRoot, "native/vendor/shared/practiceLoop.ts"), "utf8");
    const shared = readFileSync(resolve(repoRoot, "shared/practiceLoop.ts"), "utf8");

    for (const src of [web, native]) {
      expect(src).toContain("breakerControls");
      expect(src).toContain("breakerControlLabel");
      // The retired binary offer must not linger as a literal on either surface.
      expect(src).not.toContain("Crack one together");
      expect(src).not.toContain("SPIRAL_OFFER_PRIMARY");
      expect(src).not.toContain("Talk it out together");
      expect(src).not.toContain("One more, then done");
      // The fresh same-node item comes from the server-issued recovery session,
      // never from a client-assembled playlist serve.
      // Recovery recognition stays behind the shared evidence gate on BOTH
      // surfaces — no reward, icon or closure line ships ahead of the evidence.
      expect(src).toContain("RECOVERY_CLOSURE_ENABLED");
      // The plan's rejected sketch line must not exist anywhere.
      expect(src).not.toContain("The fresh try held");
    }
    // Both screens consume the shared command machine; their platform hooks own
    // every mutation boundary.
    expect(native).toContain("usePracticeMachine");
    expect(native).not.toContain("advanceBreakerFlow");
    expect(native).toContain("breakerFreshSubmitArgs");
    expect(web).toContain("usePracticeMachine");
    expect(web).not.toContain("advanceBreakerFlow");
    expect(machine).toContain("advanceBreakerFlow");
    expect(webHost).toContain("api.practiceSkills.breakerRecoverySession");
    expect(webHost).toContain("recordBreakerRecoveryLifecycle");
    expect(nativeHost).toContain("api.practiceSkills.breakerRecoverySession");
    expect(nativeHost).toContain("api.practiceSkills.recordBreakerRecoveryLifecycle");
    // Native reads the vendored copy — it must be byte-identical to the source.
    expect(vendor).toBe(shared);
  });
});

describe("breaker flow (shared state machine)", () => {
  const run = (events: BreakerEvent[], from: BreakerFlow = newBreakerFlow()) =>
    events.reduce(advanceBreakerFlow, from);

  it("opens on the pushed repair rung, never on a choice", () => {
    const flow = newBreakerFlow();
    expect(flow.stage).toBe("repair");
    expect(flow.repair).toBe("opening");
    expect(breakerBody(flow)).toBe(SPIRAL_REPAIR_BODY);
  });

  it("can arrive with the first repair rung already actionable", () => {
    const open = newBreakerFlow("open");
    expect(open.repair).toBe("open");
    expect(breakerControls(open).primary).toBe("checkStep");

    const unavailable = newBreakerFlow("unavailable");
    expect(unavailable.repair).toBe("unavailable");
    expect(breakerControls(unavailable).primary).toBe("coach");
  });

  it("keeps the easy finish a visible peer in EVERY support state", () => {
    const states: BreakerFlow[] = [
      newBreakerFlow(),
      run([{ type: "repairOpened" }]),
      run([{ type: "repairUnavailable" }]),
      run([{ type: "repairOpened" }, { type: "repairDone" }]),
      run([{ type: "repairOpened" }, { type: "repairDone" }, { type: "coachOpened" }]),
      run([{ type: "repairUnavailable" }, { type: "coachOpened" }]),
    ];
    for (const state of states) {
      expect(breakerControls(state).peers).toContain("easyFinish");
    }
  });

  it("keeps web and native retryable until the easy-finish mutation succeeds", async () => {
    const item = { itemId: "easy#1" };
    const request = vi
      .fn<() => Promise<{ available: boolean; items: typeof item[] }>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ available: true, items: [item] });

    await expect(requestBreakerEasyFinish(request)).rejects.toThrow("transient");
    expect(await requestBreakerEasyFinish(request)).toEqual({
      item,
      events: [{ type: "easyRequested" }],
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("commits terminal easy unavailability only from a successful response", async () => {
    await expect(
      requestBreakerEasyFinish(async () => ({ available: false, items: [] })),
    ).resolves.toEqual({
      item: null,
      events: [{ type: "easyRequested" }, { type: "easyUnavailable" }],
    });
  });

  it("offers the coach as an escalation, not as the entry", () => {
    const open = run([{ type: "repairOpened" }]);
    expect(breakerControls(open).primary).toBe("checkStep");
    expect(breakerControls(open).peers).toContain("coach");

    // No openable worked step ⇒ the coach IS the offer rather than a dead end.
    const noStep = run([{ type: "repairUnavailable" }]);
    expect(breakerControls(noStep).primary).toBe("coach");
    expect(breakerBody(noStep)).toBe(SPIRAL_REPAIR_NO_STEP_BODY);
  });

  it("skips the decision screen and opens the coach when no repair rung exists", () => {
    expect(
      breakerShouldAutoOpenCoach(run([{ type: "repairUnavailable" }])),
    ).toBe(true);
    expect(
      breakerShouldAutoOpenCoach(
        run([{ type: "repairUnavailable" }, { type: "coachOpened" }]),
      ),
    ).toBe(false);
    expect(breakerShouldAutoOpenCoach(run([{ type: "repairOpened" }]))).toBe(
      false,
    );
  });

  it("automatically leads to ONE fresh same-node item after support", () => {
    const afterRepair = run([{ type: "repairOpened" }, { type: "repairDone" }]);
    expect(breakerControls(afterRepair)).toEqual({
      primary: null,
      peers: ["easyFinish"],
    });
    expect(breakerBody(afterRepair)).toBe(SPIRAL_FRESH_BODY);

    const afterCoach = run([{ type: "coachOpened" }], afterRepair);
    expect(afterCoach.stage).toBe("coach");
    expect(breakerControls(afterCoach)).toEqual({
      primary: null,
      peers: ["easyFinish"],
    });
  });

  it("keeps the brake and escape without advertising an unauthorized fresh item", () => {
    const afterRepair = run([{ type: "repairOpened" }, { type: "repairDone" }]);
    expect(breakerControls(afterRepair, false)).toEqual({
      primary: "coach",
      peers: ["easyFinish"],
    });
    expect(breakerBody(afterRepair, false)).toBe(SPIRAL_COACH_BODY);

    const afterCoach = run([{ type: "coachOpened" }], afterRepair);
    expect(breakerControls(afterCoach, false)).toEqual({
      primary: "easyFinish",
      peers: [],
    });
    expect(breakerBody(afterCoach, false)).toBe(SPIRAL_COACH_COMPLETE_BODY);
  });

  it("recognizes ONLY an unassisted fresh same-node success", () => {
    const supported = run([{ type: "repairOpened" }, { type: "repairDone" }, { type: "freshServed" }]);
    expect(
      breakerRecovered(
        run(
          [{ type: "freshGraded", correct: true, assisted: false, verified: true }],
          supported,
        ),
      ),
    ).toBe(true);
    // Matching client state cannot celebrate without the server's linked verdict.
    expect(
      breakerRecovered(
        run(
          [{ type: "freshGraded", correct: true, assisted: false, verified: false }],
          supported,
        ),
      ),
    ).toBe(false);
    // Support was used ON the fresh item — independence is unproven.
    expect(
      breakerRecovered(
        run(
          [{ type: "freshGraded", correct: true, assisted: true, verified: false }],
          supported,
        ),
      ),
    ).toBe(false);
    // A miss earns nothing, and neither does an unrelated easy win.
    expect(
      breakerRecovered(
        run(
          [{ type: "freshGraded", correct: false, assisted: false, verified: false }],
          supported,
        ),
      ),
    ).toBe(false);
    expect(
      breakerRecovered(
        run([{ type: "easyRequested" }, { type: "easyGraded", correct: true }]),
      ),
    ).toBe(false);
  });

  it("never loops after a missed fresh item and keeps one honest exit", () => {
    const missed = run([
      { type: "repairOpened" },
      { type: "repairDone" },
      { type: "freshServed" },
      { type: "freshGraded", correct: false, assisted: false, verified: false },
      { type: "closed" },
    ]);
    const controls = breakerControls(missed);
    expect(controls.primary).toBe("easyFinish");
    expect(controls.peers).toEqual([]);
    expect(breakerCloseLine(missed)).toBe(SPIRAL_WARM_CLOSE);
    // No third hard item is ever on offer.
    expect(controls.peers).not.toContain("freshItem");
  });

  it("closes warmly when the easy finish is taken, and never calls it a recovery", () => {
    const easy = run([
      { type: "easyRequested" },
      { type: "easyGraded", correct: true },
      { type: "closed" },
    ]);
    expect(breakerCloseLine(easy)).toBe(SPIRAL_RECOVERY_WON_CLOSE);
    expect(breakerRecovered(easy)).toBe(false);
    expect(breakerControls(easy)).toEqual({ primary: null, peers: [] });
  });

  it("ignores impossible or repeated transitions instead of stranding the learner", () => {
    const twice = run([{ type: "repairOpened" }, { type: "repairOpened" }]);
    expect(twice.repair).toBe("open");
    // A fresh grade with no fresh item served is dropped.
    expect(
      run([
        { type: "freshGraded", correct: true, assisted: false, verified: true },
      ]).fresh,
    ).toBeUndefined();
    // A second grade never overwrites the first.
    const graded = run([
      { type: "repairOpened" },
      { type: "repairDone" },
      { type: "freshServed" },
      { type: "freshGraded", correct: false, assisted: false, verified: false },
      { type: "freshGraded", correct: true, assisted: false, verified: true },
    ]);
    expect(graded.fresh).toEqual({
      correct: false,
      assisted: false,
      verified: false,
    });
  });

  it("keeps the legacy staff telemetry truthful under the new mechanism", () => {
    // `offer` now means "did they engage the pushed support at all"...
    expect(breakerLegacyOffer(newBreakerFlow())).toBe("declined");
    expect(
      breakerLegacyOffer(run([{ type: "repairOpened" }, { type: "repairDone" }])),
    ).toBe("accepted");
    expect(breakerLegacyOffer(run([{ type: "coachOpened" }]))).toBe("accepted");

    // ...and `recovery` still means ONLY how the final EASIER item went, so the
    // shipped alert copy ("They got the final easier item right.") stays true.
    expect(breakerLegacyRecovery(newBreakerFlow())).toBe("none");
    expect(
      breakerLegacyRecovery(
        run([{ type: "easyRequested" }, { type: "easyGraded", correct: true }]),
      ),
    ).toBe("won");
    expect(
      breakerLegacyRecovery(
        run([{ type: "easyRequested" }, { type: "easyGraded", correct: false }]),
      ),
    ).toBe("missed");
    expect(
      breakerLegacyRecovery(run([{ type: "easyRequested" }, { type: "easyUnavailable" }])),
    ).toBe("skipped");
    expect(
      breakerLegacyRecovery(
        run([
          { type: "repairOpened" },
          { type: "repairDone" },
          { type: "freshServed" },
          { type: "freshGraded", correct: true, assisted: false, verified: true },
        ]),
      ),
    ).toBe("none");
  });
});

describe("stretch tile copy (shared web/native)", () => {
  it("headline is a non-empty string", () => {
    expect(typeof STRETCH_TILE_HEADLINE).toBe("string");
    expect(STRETCH_TILE_HEADLINE.length).toBeGreaterThan(0);
  });

  it("subtitle is a non-empty string", () => {
    expect(typeof STRETCH_TILE_SUBTITLE).toBe("string");
    expect(STRETCH_TILE_SUBTITLE.length).toBeGreaterThan(0);
  });

  it("aria label is a non-empty string", () => {
    expect(typeof STRETCH_TILE_ARIA_LABEL).toBe("string");
    expect(STRETCH_TILE_ARIA_LABEL.length).toBeGreaterThan(0);
  });

  it("copy contains no streak/timer/points/score gamification language", () => {
    for (const copy of [STRETCH_TILE_HEADLINE, STRETCH_TILE_SUBTITLE, STRETCH_TILE_ARIA_LABEL]) {
      expect(copy.toLowerCase()).not.toMatch(/streak|timer|point|score|beat|rank/);
    }
  });
});

describe("review-visibility — formatComesBack / comesBackLine (P1e)", () => {
  const DAY = 86_400_000;
  const now = 1_700_000_000_000;
  const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  it("reads ~soon for an already-due or same-day return", () => {
    expect(formatComesBack(now - 5_000, now)).toBe("~soon");
    expect(formatComesBack(now, now)).toBe("~soon");
  });

  it("names the weekday when the return is within 6 days", () => {
    for (let d = 1; d <= 6; d++) {
      const due = now + d * DAY;
      const out = formatComesBack(due, now);
      expect(out.startsWith("~")).toBe(true);
      expect(WEEKDAYS).toContain(out.slice(1));
      // The named weekday is the due date's own weekday (local tz).
      expect(out.slice(1)).toBe(WEEKDAYS[new Date(due).getDay()]);
    }
  });

  it("switches to '~in N weeks' past 6 days (singular at 1)", () => {
    expect(formatComesBack(now + 7 * DAY, now)).toBe("~in 1 week");
    expect(formatComesBack(now + 10 * DAY, now)).toBe("~in 1 week");
    expect(formatComesBack(now + 11 * DAY, now)).toBe("~in 2 weeks");
    expect(formatComesBack(now + 14 * DAY, now)).toBe("~in 2 weeks");
    expect(formatComesBack(now + 30 * DAY, now)).toBe("~in 4 weeks");
  });

  it("wraps the phrase in warm, growth-framed copy (never a threat/score)", () => {
    expect(comesBackLine("~Thursday")).toBe(
      "You've got this — comes back ~Thursday to keep it sharp.",
    );
    expect(comesBackLine("~in 2 weeks")).toBe(
      "You've got this — comes back ~in 2 weeks to keep it sharp.",
    );
  });
});

describe("streamStoryOpenTurn — always settles (stall watchdog)", () => {
  const enc = new TextEncoder();
  const ARGS = { scholarId: "s", fromKey: "a", toKey: "b", messages: [] };
  // Build an ExplainFetch whose body reader yields the given SSE lines, then done.
  const fetchFromLines = (lines: string[], ok = true): ExplainFetch => {
    let i = 0;
    return () =>
      Promise.resolve({
        ok,
        body: ok
          ? {
              getReader: () => ({
                read: () =>
                  i < lines.length
                    ? Promise.resolve({ done: false, value: enc.encode(lines[i++]) })
                    : Promise.resolve({ done: true }),
              }),
            }
          : null,
      });
  };

  it("streams deltas and resolves not-errored on a normal stream", async () => {
    const fetchImpl = fetchFromLines([
      'data: {"text":"A hexagon "}\n',
      'data: {"text":"tiles the plane."}\n',
      'data: {"done":true}\n',
    ]);
    const deltas: string[] = [];
    const res = await streamStoryOpenTurn(fetchImpl, "http://x", ARGS, null, (t) =>
      deltas.push(t),
    );
    expect(res).toEqual({ text: "A hexagon tiles the plane.", ended: false, errored: false });
    expect(deltas.join("")).toBe("A hexagon tiles the plane.");
  });

  it("surfaces the server's turn-cap close as ended", async () => {
    const res = await streamStoryOpenTurn(
      fetchFromLines(['data: {"text":"That was the last one."}\n', 'data: {"done":true,"ended":true}\n']),
      "http://x",
      ARGS,
      null,
      () => {},
    );
    expect(res).toEqual({ text: "That was the last one.", ended: true, errored: false });
  });

  it("resolves errored and cancels when the stream hangs mid-read", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    // read() never resolves — the classic tutor/model stall.
    const fetchImpl: ExplainFetch = () =>
      Promise.resolve({
        ok: true,
        body: { getReader: () => ({ read: () => new Promise(() => {}), cancel }) },
      });
    const deltas: string[] = [];
    // Tiny inactivity timeout so the watchdog fires fast with real timers.
    const res = await streamStoryOpenTurn(
      fetchImpl,
      "http://x",
      ARGS,
      null,
      (t) => deltas.push(t),
      10, // inactivityTimeoutMs
      1000, // totalTimeoutMs
    );
    expect(res).toEqual({ text: "", ended: false, errored: true });
    expect(deltas).toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves partial deltas when the stream stalls after some text", async () => {
    let sent = false;
    const fetchImpl: ExplainFetch = () =>
      Promise.resolve({
        ok: true,
        body: {
          getReader: () => ({
            read: () => {
              if (!sent) {
                sent = true;
                return Promise.resolve({ done: false, value: enc.encode('data: {"text":"partial"}\n') });
              }
              return new Promise(() => {}); // then hang
            },
          }),
        },
      });
    const deltas: string[] = [];
    const res = await streamStoryOpenTurn(
      fetchImpl,
      "http://x",
      ARGS,
      null,
      (t) => deltas.push(t),
      10,
      1000,
    );
    expect(res.errored).toBe(true);
    expect(res.text).toBe("partial"); // caller keeps what arrived
    expect(deltas.join("")).toBe("partial");
  });

  it("resolves errored on a non-ok response", async () => {
    const res = await streamStoryOpenTurn(fetchFromLines([], false), "http://x", ARGS, null, () => {});
    expect(res).toEqual({ text: "", ended: false, errored: true });
  });

  it("flags errored on a server error event", async () => {
    const res = await streamStoryOpenTurn(
      fetchFromLines(['data: {"error":"boom"}\n', 'data: {"done":true}\n']),
      "http://x",
      ARGS,
      null,
      () => {},
    );
    expect(res.errored).toBe(true);
  });

  it("has sane default watchdog bounds", () => {
    expect(EXPLAIN_STREAM_INACTIVITY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(EXPLAIN_STREAM_TOTAL_TIMEOUT_MS).toBeGreaterThanOrEqual(
      EXPLAIN_STREAM_INACTIVITY_TIMEOUT_MS,
    );
  });
});

describe("breaker ↔ backend contract (the exact wire the surfaces use)", () => {
  const run = (events: BreakerEvent[], from: BreakerFlow = newBreakerFlow()) =>
    events.reduce(advanceBreakerFlow, from);
  const repaired = run([{ type: "repairOpened" }, { type: "repairDone" }]);
  const coached = run([{ type: "repairUnavailable" }, { type: "coachOpened" }]);

  it("asks for a fresh item ONLY from a state whose support the server recorded", () => {
    // breakerRecoverySession refuses until repair_completed or coach_escalated.
    expect(breakerSupportRecorded(repaired)).toBe(true);
    expect(breakerSupportRecorded(coached)).toBe(true);
    expect(breakerSupportRecorded(newBreakerFlow())).toBe(false);
    expect(breakerSupportRecorded(run([{ type: "repairOpened" }]))).toBe(false);
    expect(breakerSupportRecorded(run([{ type: "repairUnavailable" }]))).toBe(false);
  });

  it("stops asking once the episode is terminal (the server refuses then too)", () => {
    const missed = run(
      [
        { type: "freshServed" },
        { type: "freshGraded", correct: false, assisted: false, verified: false },
      ],
      repaired,
    );
    expect(breakerSupportRecorded(missed)).toBe(false);
    expect(breakerSupportRecorded(run([{ type: "easyRequested" }], repaired))).toBe(false);
  });

  // `breakerSupportRecorded` deliberately returns false once the stage is
  // "fresh" — exactly the state a genuine resume needs to reconstruct FROM.
  // Regression coverage for a real bug found via live verification: a second
  // reload (after a first resume already pinned the fresh item) rendered an
  // empty breaker card forever, because `breakerSupportRecorded` returned
  // false for stage "fresh" and nothing else tried to reconstruct it.
  describe("breakerFreshReconstructable — breaker-episode resume", () => {
    it("is true once support is recorded but no fresh item has ever been served (first resume)", () => {
      expect(breakerFreshReconstructable(repaired)).toBe(true);
      expect(breakerFreshReconstructable(coached)).toBe(true);
    });

    it("is true once the stage has already advanced to fresh (a SECOND resume, item already pinned)", () => {
      const alreadyFresh = run([{ type: "freshServed" }], repaired);
      expect(alreadyFresh.stage).toBe("fresh");
      expect(alreadyFresh.fresh).toBeUndefined();
      expect(breakerFreshReconstructable(alreadyFresh)).toBe(true);
      // breakerSupportRecorded alone would (wrongly) say no — this is
      // exactly the gap breakerFreshReconstructable closes.
      expect(breakerSupportRecorded(alreadyFresh)).toBe(false);
    });

    it("is false before support is recorded (repair not done, coach not escalated)", () => {
      expect(breakerFreshReconstructable(newBreakerFlow())).toBe(false);
      expect(breakerFreshReconstructable(run([{ type: "repairOpened" }]))).toBe(false);
    });

    it("is false once the fresh item has actually been graded — never a regrade", () => {
      const graded = run(
        [
          { type: "freshServed" },
          { type: "freshGraded", correct: true, assisted: false, verified: true },
        ],
        repaired,
      );
      expect(breakerFreshReconstructable(graded)).toBe(false);
    });

    it("is false once the episode has moved on to the easy finish", () => {
      expect(breakerFreshReconstructable(run([{ type: "easyRequested" }], repaired))).toBe(
        false,
      );
    });
  });

  const argsFor = (over: Partial<Parameters<typeof breakerFreshSubmitArgs>[0]> = {}) =>
    breakerFreshSubmitArgs({
      flow: run([{ type: "freshServed" }], repaired),
      freshItemId: "item#fresh",
      itemId: "item#fresh",
      triggerAttemptId: "attempt#trigger",
      firstAttempt: true,
      ...over,
    });

  it("sends breakerTriggerAttemptId on the fresh same-node item's first attempt", () => {
    expect(argsFor()).toEqual({ breakerTriggerAttemptId: "attempt#trigger" });
  });

  it("sends it on NOTHING else — the server throws on a mismatch", () => {
    // A playlist item, or the easy finish, mid-episode.
    expect(argsFor({ itemId: "item#other" })).toEqual({});
    expect(argsFor({ flow: run([{ type: "easyRequested" }], repaired) })).toEqual({});
    // Before the fresh item is served, and after it has been graded.
    expect(argsFor({ flow: repaired })).toEqual({});
    expect(
      argsFor({
        flow: run(
          [
            { type: "freshServed" },
            { type: "freshGraded", correct: true, assisted: false, verified: true },
          ],
          repaired,
        ),
      }),
    ).toEqual({});
    // A retry is not the recovery evidence.
    expect(argsFor({ firstAttempt: false })).toEqual({});
    // Nothing to hang it off (a server without the v2 recovery handle).
    expect(argsFor({ triggerAttemptId: null })).toEqual({});
    expect(argsFor({ freshItemId: null })).toEqual({});
    expect(argsFor({ flow: null })).toEqual({});
  });

  it("binds only the easier finish's first attempt to the breaker", () => {
    const easy = run([{ type: "easyRequested" }], repaired);
    expect(
      breakerEasySubmitArgs({
        flow: easy,
        triggerAttemptId: "attempt#trigger",
        firstAttempt: true,
      }),
    ).toEqual({ breakerEasyTriggerAttemptId: "attempt#trigger" });
    expect(
      breakerEasySubmitArgs({
        flow: repaired,
        triggerAttemptId: "attempt#trigger",
        firstAttempt: true,
      }),
    ).toEqual({});
    expect(
      breakerEasySubmitArgs({
        flow: easy,
        triggerAttemptId: "attempt#trigger",
        firstAttempt: false,
      }),
    ).toEqual({});
  });
});

describe("recovery recognition uses the server evidence floor", () => {
  const run = (events: BreakerEvent[], from: BreakerFlow = newBreakerFlow()) =>
    events.reduce(advanceBreakerFlow, from);

  it("recognizes the server-verified unassisted fresh solve", () => {
    const won = run([
      { type: "repairOpened" },
      { type: "repairDone" },
      { type: "freshServed" },
      { type: "freshGraded", correct: true, assisted: false, verified: true },
      { type: "closed" },
    ]);
    expect(breakerRecovered(won)).toBe(true);
    expect(RECOVERY_CLOSURE_ENABLED).toBe(true);
    expect(breakerCloseLine(won)).toBe(SPIRAL_WARM_CLOSE);
    expect(breakerControls(won)).toEqual({ primary: null, peers: [] });
  });
});
