import { describe, expect, it } from "vitest";
import { validateClosureLine } from "./closureGuard";

/**
 * The anti-parasocial GATE for generated closure lines (Phase 3 of
 * review/practice/completion-messaging-plan.html). The exact predicate that
 * convex/closureLines.ts runs before a generated line is ever stored — so this
 * test IS the runtime contract, not a stand-in for it. Ground truth:
 * review/anti-parasocial-design.md + review/learner-parent-pedagogy.md.
 *
 * On-brand lines pass; anything that reads like a character praising the child
 * (traits, feelings, "I", numbers, comparisons) is rejected and the surface
 * keeps its deterministic fallback.
 */

describe("validateClosureLine — accepts on-brand growth lines", () => {
  const good = [
    "You put adding fractions to work today.",
    "Equivalent fractions became yours today — and that opened the door to comparing fractions.",
    "You found the edge of long division, and that's exactly where the next building starts.",
    "We'll practice from this edge, not from a score.",
    "You reached past your usual work today — that's how the map grows.",
    "Place value is solid ground on your map now. ✨",
  ];
  for (const line of good) {
    it(`passes: ${line}`, () => {
      expect(validateClosureLine(line)).toEqual({ ok: true });
    });
  }
});

describe("validateClosureLine — rejects parasocial / off-contract lines", () => {
  const bad: Array<[string, string]> = [
    ["You're so smart — great job today!", "banned word: smart"],
    ["What a brilliant mind you have.", "banned word: brilliant"],
    ["You're a natural genius at this.", "banned word: genius"],
    ["So proud of you today.", "banned phrase: so proud"],
    ["I'll miss you until next time.", "banned phrase: miss you"],
    ["My favorite part was your thinking today.", "first person"],
    ["You crushed it — 6 out of 6!", "score/streak framing"],
    ["You got 5 in a row, a new streak!", "score/streak framing"],
    ["You did better than everyone in your class.", "comparison"],
    ["You're ahead of the others now.", "comparison"],
    ["You are the best in the whole group.", "banned word: best"],
    ["", "empty"],
  ];
  for (const [line, reason] of bad) {
    it(`rejects (${reason}): ${line || "<empty>"}`, () => {
      const r = validateClosureLine(line);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    });
  }

  it("rejects a run-on of more than two sentences", () => {
    const r = validateClosureLine(
      "You practiced fractions. You did great work. Keep it up tomorrow.",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("more than 2 sentences");
  });

  it("rejects an over-long headline", () => {
    const r = validateClosureLine("You ".concat("practiced fractions ".repeat(12)).trim());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("too long");
  });
});

describe("validateClosureLine — allows the method 'we', forbids the self 'I'", () => {
  it("allows 'we' / 'our' / 'us' (the method-and-you)", () => {
    expect(validateClosureLine("We found your edge today.").ok).toBe(true);
    expect(validateClosureLine("That's now part of our map together.").ok).toBe(true);
  });

  it("rejects first-person singular even mid-sentence", () => {
    expect(validateClosureLine("Today my favorite part was your thinking.").ok).toBe(false);
  });

  it("does not false-positive on words that merely contain a banned substring", () => {
    // "start" contains "art"? no — but guard against "smart" tripping on "start".
    expect(validateClosureLine("You made a strong start on new ground today.").ok).toBe(true);
    // "bestir"/"bested" not our copy, but "best" as a whole word IS banned:
    expect(validateClosureLine("This is your best-fit next step.").ok).toBe(false);
  });
});

describe("validateClosureLine — digits from skill labels vs invented counts", () => {
  it("allows a numeric skill label when it is in allowedLabels (D2: name the skill)", () => {
    const line = "You put ×7, ×8, ×9 facts to work today. 🎯";
    // Without the allowlist a legit label reads as a stray number → rejected.
    expect(validateClosureLine(line).ok).toBe(false);
    // With the label allowlisted, the digits are legitimate → passes.
    expect(
      validateClosureLine(line, {
        allowedLabels: ["Multiplication facts: ×7, ×8, ×9 (fluency)"],
      }).ok,
    ).toBe(true);
  });

  it("allows other numeric labels (within 20, 3-digit) via the allowlist", () => {
    expect(
      validateClosureLine("Adding within 20 held steady today.", {
        allowedLabels: ["Add within 20"],
      }).ok,
    ).toBe(true);
    expect(
      validateClosureLine("You lined up 3-digit numbers before adding today.", {
        allowedLabels: ["Add 3-digit numbers without regrouping"],
      }).ok,
    ).toBe(true);
  });

  it("still rejects a stray invented number not drawn from any label", () => {
    const r = validateClosureLine("You solved 42 problems today.", {
      allowedLabels: ["Add within 20"],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("contains a digit");
  });

  it("rejects score framing even when the digits also appear in a label", () => {
    // "10" is in the label, but "10 of 10" is score framing → rejected.
    const r = validateClosureLine("You got 10 of 10 on adding within 10 today.", {
      allowedLabels: ["Add and subtract within 10"],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("score/streak framing");
  });

  it("rejects an invented count that reuses a label's digit in a DIFFERENT phrase", () => {
    // The "3" is legitimate only as "within 3" / "3-digit" — not as a free count.
    const a = validateClosureLine("You cleared 3 skills today.", {
      allowedLabels: ["Add within 3"],
    });
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("contains a digit");
    const b = validateClosureLine("You solved 3 problems today.", {
      allowedLabels: ["3-digit subtraction"],
    });
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("contains a digit");
  });
});

describe("validateClosureLine — spelled-out scores/streaks", () => {
  it("rejects a score written in words", () => {
    expect(validateClosureLine("You got nine out of ten correct today.").reason).toBe(
      "score/streak framing",
    );
    expect(validateClosureLine("Eight of ten landed today.").reason).toBe(
      "score/streak framing",
    );
  });

  it("rejects a streak written in words", () => {
    expect(validateClosureLine("You nailed three in a row today.").reason).toBe(
      "score/streak framing",
    );
    expect(validateClosureLine("Nine correct in the set today.").reason).toBe(
      "score/streak framing",
    );
  });

  it("does not reject an ordinary word that happens to be a number", () => {
    // "one" as a pronoun, not a count-of-N framing.
    expect(validateClosureLine("You found one clean path through today.").ok).toBe(true);
  });
});
