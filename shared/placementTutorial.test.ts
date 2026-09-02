import { describe, expect, it } from "vitest";
// The REAL grader — imported here (a test may import cross-dir; the vendored
// native copy injects its own vendored `rawAnswersEqual`). Asserting the module
// against the real comparator is the point: beat 1 must grade like placement.
import { rawAnswersEqual } from "../convex/lib/practice/answers";
import {
  checkTutorialAnswer,
  closeLine,
  TUTORIAL_BEATS,
  TUTORIAL_LABELS,
  type TutorialBeat,
} from "./placementTutorial";

describe("TUTORIAL_BEATS — the ordered warm-up", () => {
  it("is exactly three beats in the escalating order answer → dontKnow → free", () => {
    expect(TUTORIAL_BEATS.map((b) => b.id)).toEqual(["answer", "dontKnow", "free"]);
    expect(TUTORIAL_BEATS.map((b) => b.kind)).toEqual(["answer", "dontKnow", "free"]);
    expect(TUTORIAL_BEATS.map((b) => b.stem)).toEqual(["2 + 3", "x² + 3x = 10", "12 × 4"]);
  });

  it("beat 2 is the honest-escape beat: dontKnow-only, no gradable answer", () => {
    const beat2 = TUTORIAL_BEATS[1];
    expect(beat2.kind).toBe("dontKnow");
    expect(beat2.expected).toBeUndefined();
    // It carries the honest framing that makes tapping the escape truthful.
    expect(beat2.framing).toBeTruthy();
  });

  // The single teal ring follows `kind`, so exactly one beat can ever wear one
  // (the quiet gray escape link — everything else is already teal-edged).
  it("exactly one beat is the ringed honest-escape beat", () => {
    expect(TUTORIAL_BEATS.filter((b) => b.kind === "dontKnow")).toHaveLength(1);
  });

  // The gentle wrong-answer line must come off the BEAT, never a module
  // constant — a second answer beat would otherwise be told "close, it's 5".
  it("closeLine names the beat's own answer, and degrades without one", () => {
    expect(closeLine(TUTORIAL_BEATS[0])).toBe("Close — it's 5.");
    expect(closeLine({ ...TUTORIAL_BEATS[0], expected: undefined })).toBe(
      TUTORIAL_LABELS.closeFallback,
    );
    expect(closeLine({ ...TUTORIAL_BEATS[0], expected: { answer: "7", answerType: "integer" } }))
      .toBe("Close — it's 7.");
  });

  it("every beat carries non-empty web AND native callout copy", () => {
    for (const beat of TUTORIAL_BEATS) {
      expect(beat.callout.web.trim().length).toBeGreaterThan(0);
      expect(beat.callout.native.trim().length).toBeGreaterThan(0);
    }
  });

  it("shares callout copy across surfaces except where the input genuinely differs (beat 1)", () => {
    // Beat 1's input differs (laptop keyboard vs. tapped pad) → the copy differs.
    expect(TUTORIAL_BEATS[0].callout.web).not.toBe(TUTORIAL_BEATS[0].callout.native);
    // Beats 2 + 3 name the same affordance, so web + native must be byte-identical.
    expect(TUTORIAL_BEATS[1].callout.web).toBe(TUTORIAL_BEATS[1].callout.native);
    expect(TUTORIAL_BEATS[2].callout.web).toBe(TUTORIAL_BEATS[2].callout.native);
  });
});

describe("TUTORIAL_LABELS", () => {
  it("has non-empty copy for every label", () => {
    for (const value of Object.values(TUTORIAL_LABELS)) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("checkTutorialAnswer — client-side, records nothing", () => {
  const beat1 = TUTORIAL_BEATS[0];

  it("accepts 5 for 2 + 3", () => {
    expect(checkTutorialAnswer(beat1, "5", rawAnswersEqual)).toBe(true);
  });

  it("rejects 4 for 2 + 3", () => {
    expect(checkTutorialAnswer(beat1, "4", rawAnswersEqual)).toBe(false);
  });

  it("tolerates surrounding whitespace on a correct answer", () => {
    expect(checkTutorialAnswer(beat1, "  5 ", rawAnswersEqual)).toBe(true);
  });

  it("never grades a beat with no expected answer as correct", () => {
    const beat2: TutorialBeat = TUTORIAL_BEATS[1];
    const beat3: TutorialBeat = TUTORIAL_BEATS[2];
    // Even if the raw text happens to match nothing, a non-answer beat is inert.
    expect(checkTutorialAnswer(beat2, "10", rawAnswersEqual)).toBe(false);
    expect(checkTutorialAnswer(beat3, "48", rawAnswersEqual)).toBe(false);
  });
});
