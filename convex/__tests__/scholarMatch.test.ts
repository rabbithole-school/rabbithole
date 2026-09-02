import { describe, expect, test } from "vitest";
import {
  matchScholar,
  normalizeName,
  type MatchCandidate,
} from "../lib/scholarMatch";

// Pure-function tests for the portfolio name matcher. No convex-test needed —
// this is the highest-leverage coverage in the feature (it decides which kid a
// scan gets filed under). See rabbithole-test-strategy.md decision tree #1.

describe("normalizeName", () => {
  test("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeName("  Kai   Nakamura! ")).toEqual(["kai", "nakamura"]);
  });
  test("strips diacritics", () => {
    expect(normalizeName("Lāni Keálohä")).toEqual(["lani", "kealoha"]);
  });
  test("empty / null → []", () => {
    expect(normalizeName("")).toEqual([]);
    expect(normalizeName(null)).toEqual([]);
    expect(normalizeName(undefined)).toEqual([]);
  });
});

const ROSTER: MatchCandidate[] = [
  { id: "kai", name: "Kai Nakamura", username: "kai_n" },
  { id: "lani", name: "Lani Kealoha", username: "lani_k" },
  { id: "noah", name: "Noah Takahashi", username: "noah_t" },
];

describe("matchScholar — confident matches", () => {
  test("exact full name", () => {
    const r = matchScholar("Kai Nakamura", ROSTER);
    expect(r.status).toBe("matched");
    expect(r.scholarId).toBe("kai");
  });

  test("case + whitespace insensitive", () => {
    expect(matchScholar("  kai   NAKAMURA ", ROSTER).scholarId).toBe("kai");
  });

  test("first + last initial ('Kai N')", () => {
    const r = matchScholar("Kai N", ROSTER);
    expect(r.status).toBe("matched");
    expect(r.scholarId).toBe("kai");
  });

  test("unique first name only", () => {
    const r = matchScholar("Noah", ROSTER);
    expect(r.status).toBe("matched");
    expect(r.scholarId).toBe("noah");
  });

  test("username fallback when written as a handle", () => {
    const r = matchScholar("kai_n", ROSTER);
    expect(r.status).toBe("matched");
    expect(r.scholarId).toBe("kai");
  });
});

describe("matchScholar — ambiguous", () => {
  test("two scholars share a first name, only first name written", () => {
    const roster: MatchCandidate[] = [
      { id: "a", name: "Kai Nakamura" },
      { id: "b", name: "Kai Watanabe" },
    ];
    const r = matchScholar("Kai", roster);
    expect(r.status).toBe("ambiguous");
    expect(r.candidateIds.sort()).toEqual(["a", "b"]);
  });
});

describe("matchScholar — unmatched", () => {
  test("name not on roster", () => {
    expect(matchScholar("Zebediah", ROSTER).status).toBe("unmatched");
  });
  test("no name detected", () => {
    expect(matchScholar(null, ROSTER).status).toBe("unmatched");
    expect(matchScholar("", ROSTER).status).toBe("unmatched");
  });
  test("empty roster", () => {
    expect(matchScholar("Kai", []).status).toBe("unmatched");
  });
});

describe("matchScholar — conservative bias", () => {
  // A wrong auto-file is worse than a review. A first-name match is the strong
  // signal (it's what kids write as the author). A bare LAST name is weaker —
  // siblings share it — so even a unique last-name hit goes to review rather
  // than auto-filing.
  test("last name only goes to review, not auto-file", () => {
    const r = matchScholar("Takahashi", ROSTER);
    expect(r.status).toBe("ambiguous");
    expect(r.candidateIds).toEqual(["noah"]);
  });

  test("a first-name hit still beats it (Noah auto-files)", () => {
    expect(matchScholar("Noah", ROSTER).status).toBe("matched");
  });

  // The real-world case that exposed the bug: one scholar has "Oliver" as a
  // FIRST name, another has it as a LAST name. Writing "Oliver" means the
  // first-name Oliver — it must auto-file, not go to review.
  test("first-name hit beats an incidental surname collision", () => {
    const roster: MatchCandidate[] = [
      { id: "oliver", name: "Oliver Stone" }, // first name Oliver
      { id: "test", name: "Test Oliver" }, // Oliver is the surname here
    ];
    const r = matchScholar("Oliver", roster);
    expect(r.status).toBe("matched");
    expect(r.scholarId).toBe("oliver");
  });
});
