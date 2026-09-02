import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDailyArc,
  buildPracticeClosure,
  closureSignalHash,
  effortShape,
  RECOVERY_CLOSURE_ENABLED,
  PRACTICE_RECOVERY_HEADLINE,
  sanitizeLabels,
  type DailyArcInput,
  type DailySignal,
  type PracticeClosureInput,
  type PracticeSignal,
} from "./closureLines";

function practice(over: Partial<PracticeClosureInput>): PracticeClosureInput {
  return {
    wrap: "session",
    skills: [],
    correctCount: 0,
    total: 0,
    challengeMoved: false,
    frontierSkills: [],
    ...over,
  };
}

function arc(over: Partial<DailyArcInput>): DailyArcInput {
  return {
    yoursNow: [],
    newOnMap: [],
    practiced: [],
    practicedCount: 0,
    finished: [],
    ...over,
  };
}

describe("effortShape", () => {
  it("buckets a raw score into a coarse shape without exposing the number", () => {
    expect(effortShape(6, 6)).toBe("steady");
    expect(effortShape(5, 6)).toBe("steady");
    expect(effortShape(3, 6)).toBe("stretched");
    expect(effortShape(1, 6)).toBe("hardSet");
    expect(effortShape(0, 0)).toBe("steady"); // no items → not a "hard set"
  });
});

describe("buildPracticeClosure — plain session", () => {
  it("does NOT name the skills — the 'You practiced' card below is their canonical roster", () => {
    const { headline } = buildPracticeClosure(
      practice({ skills: ["adding fractions"], correctCount: 6, total: 6 }),
    );
    expect(headline).toBe("You showed up and did the thinking — that's how the map grows.");
    expect(headline).not.toContain("adding fractions");
  });

  it("frames a hard set as the edge, never a verdict", () => {
    const { headline } = buildPracticeClosure(
      practice({ skills: ["long division"], correctCount: 1, total: 6 }),
    );
    expect(headline).toContain("found the edge");
    expect(headline).not.toContain("long division");
    expect(headline.toLowerCase()).not.toContain("wrong");
    expect(headline.toLowerCase()).not.toContain("failed");
  });

  it("says the same thing however many skills the run touched", () => {
    // The headline encodes the EFFORT SHAPE, not the roster, so skill count
    // cannot change it — that is what stops it duplicating the card.
    const one = buildPracticeClosure(
      practice({ skills: ["a"], correctCount: 6, total: 6 }),
    ).headline;
    const many = buildPracticeClosure(
      practice({ skills: ["a", "b", "c", "d"], correctCount: 6, total: 6 }),
    ).headline;
    expect(many).toBe(one);
    for (const label of ["a", "b", "c", "d"]) {
      expect(many.split(" ")).not.toContain(label);
    }
  });

  it("has a graceful no-skill fallback", () => {
    const { headline } = buildPracticeClosure(practice({ skills: [] }));
    expect(headline).toContain("did the thinking");
  });
});

describe("buildPracticeClosure — tune-up & challenge", () => {
  it("keeps a tune-up generic too — the card names what was refreshed", () => {
    const { headline } = buildPracticeClosure(
      practice({ wrap: "tuneup", skills: ["place value", "multiplication facts"] }),
    );
    expect(headline).toBe("You kept your map fresh — still yours. ✨");
    expect(headline).not.toContain("place value");
  });

  it("celebrates reaching past the edge on an uncleared challenge", () => {
    const { headline } = buildPracticeClosure(practice({ wrap: "challenge" }));
    expect(headline).toContain("reached past your usual work");
  });
});

describe("buildPracticeClosure — no raw score receipt in the scholar closure (pilot9 J4-A)", () => {
  // "N of M" · "N/M" · "N out of M" — the raw correctness count the ruling drops.
  const RAW_COUNT = /\b\d+\s*(?:\/|of|out of)\s*\d+\b/i;

  const cases: PracticeClosureInput[] = [
    practice({ skills: ["adding fractions"], correctCount: 2, total: 8 }), // the pilot9 Day-2 "2 of 8" set
    practice({ skills: ["long division"], correctCount: 1, total: 6 }), // hardSet
    practice({ skills: ["place value"], correctCount: 3, total: 6 }), // stretched
    practice({ skills: ["multiplication facts"], correctCount: 6, total: 6 }), // steady
    practice({ wrap: "tuneup", skills: ["add within 20"], correctCount: 4, total: 5 }), // label carries a digit
    practice({ wrap: "challenge", correctCount: 0, total: 4 }),
    practice({ skills: [], correctCount: 0, total: 5 }), // no-skill fallback
  ];

  it("never renders a raw N-of-M correctness count, whatever the score", () => {
    for (const input of cases) {
      const { headline } = buildPracticeClosure(input);
      expect(
        RAW_COUNT.test(headline),
        `wrap=${input.wrap} score=${input.correctCount}/${input.total} → "${headline}"`,
      ).toBe(false);
    }
  });

  it("the pilot9 Day-2 '2 of 8' set closes on the growth headline, not the score", () => {
    const { headline } = buildPracticeClosure(
      practice({ skills: ["adding fractions"], correctCount: 2, total: 8 }),
    );
    expect(headline).not.toContain("2 of 8");
    expect(headline).toContain("found the edge"); // hardSet → edge-framing, no roster
  });
});

describe("buildDailyArc — connects the honest buckets", () => {
  it("links became-fluent to newly-opened ground", () => {
    const line = buildDailyArc(
      arc({ yoursNow: ["equivalent fractions"], newOnMap: ["comparing fractions"] }),
    );
    expect(line).toBe(
      "Equivalent fractions became yours today — and that opened the door to comparing fractions.",
    );
  });

  it("handles became-fluent alone", () => {
    const line = buildDailyArc(arc({ yoursNow: ["place value"] }));
    expect(line).toBe("Place value became yours today — solid ground on your map now.");
  });

  it("handles newly-opened ground alone", () => {
    const line = buildDailyArc(arc({ newOnMap: ["comparing fractions"] }));
    expect(line).toBe("You opened up new ground today: comparing fractions.");
  });

  it("names finished work and folds in practice", () => {
    const line = buildDailyArc(arc({ finished: ["Fraction Sense — Lesson 2"], practicedCount: 2 }));
    expect(line).toBe(
      "You finished Fraction Sense — Lesson 2 — and kept 2 skills moving along the way.",
    );
  });

  it("falls back to a practice-only line, count-form when many", () => {
    expect(buildDailyArc(arc({ practiced: ["adding within 20"], practicedCount: 1 }))).toBe(
      "You put in real practice today on adding within 20.",
    );
    expect(buildDailyArc(arc({ practiced: ["a", "b", "c", "d"], practicedCount: 7 }))).toBe(
      "You put in real practice today, across 7 skills.",
    );
  });

  it("returns null when nothing moved", () => {
    expect(buildDailyArc(arc({}))).toBeNull();
  });
});

describe("sanitizeLabels — defense-in-depth for the signal", () => {
  it("trims, drops empties, and caps the list", () => {
    expect(sanitizeLabels(["  fractions ", "", "   ", "place value"])).toEqual([
      "fractions",
      "place value",
    ]);
    expect(sanitizeLabels(["a", "b", "c", "d", "e", "f", "g", "h"]).length).toBe(6);
  });

  it("truncates an over-long label", () => {
    const long = "x".repeat(80);
    expect(sanitizeLabels([long])[0].length).toBe(60);
  });
});

describe("closureSignalHash — stable, order-insensitive cache key", () => {
  function pSignal(over: Partial<PracticeSignal>): PracticeSignal {
    return {
      wrap: "session",
      skills: [],
      effortShape: "steady",
      challengeMoved: false,
      frontierSkills: [],
      ...over,
    };
  }
  function dSignal(over: Partial<DailySignal>): DailySignal {
    return { yoursNow: [], newOnMap: [], practiced: [], finished: [], practicedCount: 0, ...over };
  }

  it("is namespaced by kind", () => {
    expect(closureSignalHash("practice", pSignal({}))).toMatch(/^practice:/);
    expect(closureSignalHash("daily", dSignal({}))).toMatch(/^daily:/);
  });

  it("ignores skill ORDER (same set → same key)", () => {
    const a = closureSignalHash("practice", pSignal({ skills: ["adding", "subtracting"] }));
    const b = closureSignalHash("practice", pSignal({ skills: ["subtracting", "adding"] }));
    expect(a).toBe(b);
  });

  it("changes when a meaningful field changes", () => {
    const base = closureSignalHash("practice", pSignal({ skills: ["adding"] }));
    expect(closureSignalHash("practice", pSignal({ skills: ["adding"], effortShape: "hardSet" }))).not.toBe(base);
    expect(closureSignalHash("practice", pSignal({ skills: ["adding"], challengeMoved: true }))).not.toBe(base);
    expect(closureSignalHash("practice", pSignal({ skills: ["dividing"] }))).not.toBe(base);
  });

  it("is insensitive to label whitespace (sanitized before hashing)", () => {
    const a = closureSignalHash("daily", dSignal({ yoursNow: ["  place value "] }));
    const b = closureSignalHash("daily", dSignal({ yoursNow: ["place value"] }));
    expect(a).toBe(b);
  });
});

describe("buildPracticeClosure — recovery recognition", () => {
  it("keeps an unverified recovery silent even with the feature enabled", () => {
    expect(RECOVERY_CLOSURE_ENABLED).toBe(true);
    const plain = buildPracticeClosure(
      practice({ skills: ["long division"], correctCount: 1, total: 6 }),
    ).headline;
    const walked = buildPracticeClosure(
      practice({
        skills: ["long division"],
        correctCount: 1,
        total: 6,
        recovery: "sameNodeUnassisted",
      }),
    ).headline;
    expect(walked).toBe(plain);
    expect(walked).not.toBe(PRACTICE_RECOVERY_HEADLINE);
  });

  it("speaks the actual sequence once verified: help on the hard part, then a fresh one alone", () => {
    const { headline } = buildPracticeClosure(
      practice({ recovery: "sameNodeUnassisted", recoveryVerified: true, correctCount: 2, total: 8 }),
    );
    expect(headline).toBe(PRACTICE_RECOVERY_HEADLINE);
    expect(headline).toBe(
      "You used help on the hard part, then solved a fresh one on your own. 🧗",
    );
  });

  it("rejects the plan's sketch line, in the copy and in the source", () => {
    // It named neither the help nor the work, and described something happening
    // TO the scholar rather than anything they did.
    const rejected = ["The fresh", "try", "held."].join(" ");
    expect(PRACTICE_RECOVERY_HEADLINE).not.toContain(rejected);
    expect(PRACTICE_RECOVERY_HEADLINE.toLowerCase()).not.toContain("held");
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of [
      "shared/closureLines.ts",
      "shared/practiceLoop.ts",
      "components/practice/PracticeSession.tsx",
      "native/src/app/practice.tsx",
    ]) {
      expect(readFileSync(resolve(repoRoot, file), "utf8")).not.toContain(rejected);
    }
  });

  it("outranks the effort shape once verified — the run that hit the wall is what it is for", () => {
    const hardSet = buildPracticeClosure(
      practice({ skills: ["long division"], correctCount: 1, total: 6 }),
    ).headline;
    const recovered = buildPracticeClosure(
      practice({
        skills: ["long division"],
        correctCount: 1,
        total: 6,
        recovery: "sameNodeUnassisted",
        recoveryVerified: true,
      }),
    ).headline;
    expect(hardSet).toContain("found the edge");
    expect(recovered).toBe(PRACTICE_RECOVERY_HEADLINE);
  });

  it("needs BOTH halves: `recoveryVerified` alone is not a recovery either", () => {
    expect(
      buildPracticeClosure(practice({ correctCount: 1, total: 6, recoveryVerified: true })).headline,
    ).not.toBe(PRACTICE_RECOVERY_HEADLINE);
  });

  it("stays inside the closure contract: no count, no roster, no trait praise", () => {
    const { headline } = buildPracticeClosure(
      practice({
        skills: ["long division"],
        correctCount: 1,
        total: 6,
        recovery: "sameNodeUnassisted",
        recoveryVerified: true,
      }),
    );
    expect(/\b\d+\s*(?:\/|of|out of)\s*\d+\b/i.test(headline)).toBe(false);
    expect(headline).not.toContain("long division");
    // Praises the move that happened, never the kind of kid they are.
    expect(headline.toLowerCase()).not.toMatch(
      /resilien|grit|persever|brave|smart|talent|you are|you're a\b/,
    );
    // Not a score surface.
    expect(headline.toLowerCase()).not.toMatch(/point|badge|streak|level|bonus/);
  });

  it("is absent on an ordinary run", () => {
    expect(buildPracticeClosure(practice({ correctCount: 6, total: 6 })).headline).not.toBe(
      PRACTICE_RECOVERY_HEADLINE,
    );
  });

  it("keys the generated-line cache separately, so no generic line is served for it", () => {
    const base = closureSignalHash("practice", {
      wrap: "session",
      skills: ["long division"],
      effortShape: "hardSet",
      challengeMoved: false,
      frontierSkills: [],
    });
    const recovered = closureSignalHash("practice", {
      wrap: "session",
      skills: ["long division"],
      effortShape: "hardSet",
      challengeMoved: false,
      frontierSkills: [],
      recovery: "sameNodeUnassisted",
    });
    expect(recovered).not.toBe(base);
  });
});
