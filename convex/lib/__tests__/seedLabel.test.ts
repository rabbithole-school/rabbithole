import { describe, expect, test } from "vitest";
import { cleanSeedLabel, seedScholarText } from "../seedLabel";

describe("cleanSeedLabel", () => {
  test("keeps the star-label head and drops arrow-connector tails", () => {
    expect(
      cleanSeedLabel("Counting by 2s → odd, even, and how computers count (binary)"),
    ).toBe("Counting by 2s");
    expect(
      cleanSeedLabel("Skip-counting   ->   rhythm, beats, and time signatures in music"),
    ).toBe("Skip-counting");
    expect(
      cleanSeedLabel("Sharing fairly ➜ fractions (what if it doesn't come out even?)"),
    ).toBe("Sharing fairly");
    expect(
      cleanSeedLabel("Times tables —> hidden patterns (why the 9s digits always add to 9)"),
    ).toBe("Times tables");
  });

  test("passes through labels without arrow connectors", () => {
    expect(cleanSeedLabel("Vampire-bat reciprocity")).toBe("Vampire-bat reciprocity");
  });
});

describe("seedScholarText", () => {
  // A row as stored: the teacher-private `rationale` is always present, and
  // the helper must never return it.
  const row = (fields: {
    origin?: string;
    topic?: string;
    connectionTo?: string;
    scholarInvitation?: string;
  }) => ({ topic: "Game Theory", rationale: "ROW_RATIONALE", ...fields });

  test("the scholar invitation always wins", () => {
    expect(seedScholarText(row({ origin: "ai", scholarInvitation: "ROW_INVITATION" }))).toBe(
      "ROW_INVITATION",
    );
  });

  test("an older badge-follow trail rebuilds its line from topic and inspirer, never the rationale", () => {
    expect(seedScholarText(row({ origin: "badge_follow", connectionTo: "Bea" }))).toBe(
      "Inspired by the “Game Theory” badge Bea earned — chase the same trail and make it your own.",
    );
    expect(seedScholarText(row({ origin: "badge_follow" }))).toBeNull();
  });

  test.each([
    ["an observer seed", { origin: "ai" }],
    ["a teacher seed (hand-planted or a quest offer)", { origin: "teacher" }],
    ["a constellation seed", { origin: "ai-constellation" }],
    ["a story souvenir", { origin: "story", connectionTo: "Counting" }],
    ["a seed with no origin", {}],
  ])("%s with no invitation shows nothing", (_label, fields) => {
    expect(seedScholarText(row(fields))).toBeNull();
  });
});
