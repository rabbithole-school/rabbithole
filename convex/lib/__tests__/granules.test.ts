import { describe, expect, test } from "vitest";
import {
  deriveGranuleStatuses,
  granuleTexts,
  legacyGranuleKey,
  mergeKeyedGranules,
  normalizeGranules,
  statusFromEvidence,
  toKeyedGranules,
  unitGranules,
} from "../granules";

describe("normalizeGranules", () => {
  test("legacy strings get deterministic keys (same on every read)", () => {
    const a = normalizeGranules(["What makes a community thrive?"], "eq");
    const b = normalizeGranules(["What makes a community thrive?"], "eq");
    expect(a).toHaveLength(1);
    expect(a[0].key).toBe(b[0].key);
    expect(a[0].key).toBe(legacyGranuleKey("eq", "What makes a community thrive?"));
    expect(a[0].text).toBe("What makes a community thrive?");
  });

  test("kind disambiguates identical EQ/EU texts", () => {
    const eq = normalizeGranules(["Balance matters"], "eq")[0];
    const eu = normalizeGranules(["Balance matters"], "eu")[0];
    expect(eq.key).not.toBe(eu.key);
  });

  test("already-keyed entries pass through unchanged", () => {
    const keyed = [{ key: "eq:r1234", text: "Why do maps lie?" }];
    expect(normalizeGranules(keyed, "eq")).toEqual(keyed);
  });

  test("duplicate legacy texts get uniquified keys", () => {
    const out = normalizeGranules(["Same?", "Same?"], "eq");
    expect(out[0].key).not.toBe(out[1].key);
    expect(out.map((g) => g.text)).toEqual(["Same?", "Same?"]);
  });

  test("empty / missing input → empty list", () => {
    expect(normalizeGranules(undefined, "eq")).toEqual([]);
    expect(normalizeGranules(null, "eu")).toEqual([]);
    expect(normalizeGranules([], "eq")).toEqual([]);
  });
});

describe("granuleTexts", () => {
  test("handles both shapes", () => {
    expect(granuleTexts(["a", "b"])).toEqual(["a", "b"]);
    expect(
      granuleTexts([
        { key: "eq:x", text: "a" },
        { key: "eq:y", text: "b" },
      ]),
    ).toEqual(["a", "b"]);
    expect(granuleTexts(undefined)).toEqual([]);
  });
});

describe("toKeyedGranules", () => {
  test("preserves the existing key for unchanged texts", () => {
    const existing = [{ key: "eq:rabc", text: "Why do maps lie?" }];
    const out = toKeyedGranules(
      ["Why do maps lie?", "What is scale?"],
      existing,
      "eq",
    );
    expect(out[0].key).toBe("eq:rabc");
    expect(out[1].text).toBe("What is scale?");
    expect(out[1].key).not.toBe("eq:rabc");
  });

  test("removal: texts absent from the input are dropped", () => {
    const existing = [
      { key: "eq:r1", text: "Keep me" },
      { key: "eq:r2", text: "Drop me" },
    ];
    const out = toKeyedGranules(["Keep me"], existing, "eq");
    expect(out).toEqual([{ key: "eq:r1", text: "Keep me" }]);
  });

  test("reorder preserves keys", () => {
    const existing = [
      { key: "eq:r1", text: "First" },
      { key: "eq:r2", text: "Second" },
    ];
    const out = toKeyedGranules(["Second", "First"], existing, "eq");
    expect(out.map((g) => g.key)).toEqual(["eq:r2", "eq:r1"]);
  });

  test("matches against legacy (string) existing via deterministic keys", () => {
    // A unit not yet migrated: existing is a bare string array. The
    // write must hand the text its legacy hash key, so any evidence
    // recorded pre-migration (against the normalized read) stays
    // attached after this write.
    const out = toKeyedGranules(
      ["What makes a community thrive?"],
      ["What makes a community thrive?"],
      "eq",
    );
    expect(out[0].key).toBe(legacyGranuleKey("eq", "What makes a community thrive?"));
  });

  test("blank texts are dropped; whitespace is trimmed", () => {
    const out = toKeyedGranules(["  ok  ", "", "   "], undefined, "eq");
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("ok");
  });

  test("duplicate texts in input each get a distinct key", () => {
    const out = toKeyedGranules(["Same", "Same"], undefined, "eq");
    expect(out[0].key).not.toBe(out[1].key);
  });
});

describe("mergeKeyedGranules", () => {
  test("preserves a known key when editing text in place", () => {
    const out = mergeKeyedGranules(
      [{ key: "eq:r1", text: "How do maps reveal choices?" }],
      [{ key: "eq:r1", text: "Why do maps lie?" }],
      "eq",
    );
    expect(out).toEqual([{ key: "eq:r1", text: "How do maps reveal choices?" }]);
  });

  test("mints a fresh key for a new item with no key", () => {
    const out = mergeKeyedGranules(
      [
        { key: "eq:r1", text: "Keep me" },
        { text: "What is scale?" },
      ],
      [{ key: "eq:r1", text: "Keep me" }],
      "eq",
    );
    expect(out[0]).toEqual({ key: "eq:r1", text: "Keep me" });
    expect(out[1].text).toBe("What is scale?");
    expect(out[1].key).toMatch(/^eq:r/);
    expect(out[1].key).not.toBe("eq:r1");
  });

  test("mints a fresh key for an unknown or stale key", () => {
    const out = mergeKeyedGranules(
      [{ key: "eq:stale", text: "A resurrected question" }],
      [{ key: "eq:r1", text: "Current question" }],
      "eq",
    );
    expect(out[0].text).toBe("A resurrected question");
    expect(out[0].key).toMatch(/^eq:r/);
    expect(out[0].key).not.toBe("eq:stale");
    expect(out[0].key).not.toBe("eq:r1");
  });

  test("drops blank texts and trims whitespace", () => {
    const out = mergeKeyedGranules(
      [
        { key: "eq:r1", text: "   " },
        { key: "eq:r2", text: "  Keep me  " },
        { text: "" },
      ],
      [
        { key: "eq:r1", text: "Drop me" },
        { key: "eq:r2", text: "Keep me" },
      ],
      "eq",
    );
    expect(out).toEqual([{ key: "eq:r2", text: "Keep me" }]);
  });

  test("reorder preserves known keys", () => {
    const existing = [
      { key: "eq:r1", text: "First" },
      { key: "eq:r2", text: "Second" },
    ];
    const out = mergeKeyedGranules(
      [
        { key: "eq:r2", text: "Second, edited" },
        { key: "eq:r1", text: "First, edited" },
      ],
      existing,
      "eq",
    );
    expect(out.map((g) => g.key)).toEqual(["eq:r2", "eq:r1"]);
    expect(out.map((g) => g.text)).toEqual(["Second, edited", "First, edited"]);
  });

  test("delete drops only the omitted key", () => {
    const out = mergeKeyedGranules(
      [{ key: "eu:r2", text: "Systems have feedback loops" }],
      [
        { key: "eu:r1", text: "Drop me" },
        { key: "eu:r2", text: "Systems have feedback loops" },
      ],
      "eu",
    );
    expect(out).toEqual([
      { key: "eu:r2", text: "Systems have feedback loops" },
    ]);
  });
});

describe("unitGranules", () => {
  test("merges EQs then EUs with kind tags", () => {
    const out = unitGranules({
      essentialQuestions: ["Q1"],
      enduringUnderstandings: [{ key: "eu:r9", text: "U1" }],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "eq", text: "Q1" });
    expect(out[1]).toMatchObject({ kind: "eu", text: "U1", key: "eu:r9" });
  });
});

describe("deriveGranuleStatuses", () => {
  const granules = [{ key: "eq:1" }, { key: "eq:2" }, { key: "eu:1" }];

  test("gray by default, yellow on probed, green on demonstrated", () => {
    const statuses = deriveGranuleStatuses(granules, [
      { granuleKey: "eq:1", outcome: "probed" },
      { granuleKey: "eq:2", outcome: "demonstrated" },
    ]);
    expect(statuses.get("eq:1")).toBe("yellow");
    expect(statuses.get("eq:2")).toBe("green");
    expect(statuses.get("eu:1")).toBe("gray");
  });

  test("green sticks — a later probed row doesn't demote", () => {
    const statuses = deriveGranuleStatuses(granules, [
      { granuleKey: "eq:1", outcome: "demonstrated" },
      { granuleKey: "eq:1", outcome: "probed" },
    ]);
    expect(statuses.get("eq:1")).toBe("green");
  });

  test("orphaned evidence (key not on the unit) is ignored", () => {
    const statuses = deriveGranuleStatuses(granules, [
      { granuleKey: "eq:deleted", outcome: "demonstrated" },
    ]);
    expect(statuses.get("eq:1")).toBe("gray");
    expect(statuses.has("eq:deleted")).toBe(false);
  });
});

describe("statusFromEvidence (pre/post snapshot)", () => {
  test("empty rows are gray", () => {
    expect(statusFromEvidence([])).toBe("gray");
  });

  test("probed-only is yellow", () => {
    expect(statusFromEvidence([{ outcome: "probed" }])).toBe("yellow");
  });

  test("any demonstration is green, regardless of order", () => {
    expect(
      statusFromEvidence([{ outcome: "demonstrated" }, { outcome: "probed" }]),
    ).toBe("green");
    expect(
      statusFromEvidence([{ outcome: "probed" }, { outcome: "demonstrated" }]),
    ).toBe("green");
  });
});
