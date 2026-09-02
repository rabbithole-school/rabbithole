import { describe, expect, test } from "vitest";
import {
  normalizeDeliverable,
  normalizeAdvanceRubric,
  requireDeliverableForOnline,
  renderCriteriaForRubricCheck,
  renderCriteriaForTutor,
  rubricStringToCriteria,
} from "../lib/deliverable";
import { parseCriteriaGenToolInput } from "../deliverables";

const validCriteria = [
  { label: "Details that transport", description: "Names a person and place." },
  { label: "A structure that guides", description: "Uses a clear beginning and ending." },
  { label: "Words with precision", description: "Chooses words that make the scene clear." },
];

describe("parseCriteriaGenToolInput", () => {
  test("accepts the strict tool schema's criteria array", () => {
    expect(parseCriteriaGenToolInput({ criteria: validCriteria })).toEqual(
      validCriteria,
    );
  });

  test("rejects a wrong top-level shape", () => {
    expect(() => parseCriteriaGenToolInput(validCriteria)).toThrow(
      /input must contain only criteria/,
    );
  });

  test("rejects criteria that is not an array", () => {
    expect(() => parseCriteriaGenToolInput({ criteria: {} })).toThrow(
      /criteria must be an array/,
    );
  });

  test("enforces the 3-5 criteria domain invariant", () => {
    expect(() =>
      parseCriteriaGenToolInput({ criteria: validCriteria.slice(0, 2) }),
    ).toThrow(/criteria must contain 3-5 items/);
  });

  test("rejects malformed criterion entries", () => {
    expect(() =>
      parseCriteriaGenToolInput({
        criteria: [
          { label: "Details that transport", description: "Names a person and place." },
          { label: "A structure that guides", description: 3 },
          { label: "Words with precision", description: "Chooses clear words." },
        ],
      }),
    ).toThrow(/criterion 2 description must be a non-empty string/);
  });

  test("rejects unexpected top-level properties", () => {
    expect(() =>
      parseCriteriaGenToolInput({ criteria: validCriteria, extra: true }),
    ).toThrow(/input must contain only criteria/);
  });

  test("rejects unexpected criterion properties", () => {
    expect(() =>
      parseCriteriaGenToolInput({
        criteria: [
          { label: "Details that transport", description: "Names a person and place." },
          { label: "A structure that guides", description: "Uses a clear ending." },
          {
            label: "Words with precision",
            description: "Chooses clear words.",
            extra: true,
          },
        ],
      }),
    ).toThrow(/criterion 3 must contain only label and description/);
  });
});

describe("normalizeDeliverable", () => {
  test("returns undefined for undefined input", () => {
    expect(normalizeDeliverable(undefined)).toBeUndefined();
  });

  test("trims prompt + labels + descriptions", () => {
    const out = normalizeDeliverable({
      kind: "text",
        mode: "manual",
      prompt: "  Write a story  ",
      criteria: [
        { id: "", label: "  Specificity  ", description: "  At least one name  " },
      ],
    });
    expect(out).toEqual({
      kind: "text",
      mode: "manual",
      notes: undefined,
      prompt: "Write a story",
      criteria: [
        { id: "specificity", label: "Specificity", description: "At least one name" },
      ],
    });
  });

  test("auto-generates IDs from labels via slugify when id is empty", () => {
    const out = normalizeDeliverable({
      kind: "text",
        mode: "manual",
      prompt: "p",
      criteria: [
        { id: "", label: "Beginning, middle, end" },
        { id: "", label: "Length & detail" },
      ],
    });
    expect(out?.criteria.map((c) => c.id)).toEqual([
      "beginning-middle-end",
      "length-detail",
    ]);
  });

  test("disambiguates duplicate IDs by suffix", () => {
    const out = normalizeDeliverable({
      kind: "text",
        mode: "manual",
      prompt: "p",
      criteria: [
        { id: "x", label: "First" },
        { id: "x", label: "Second" },
        { id: "x", label: "Third" },
      ],
    });
    expect(out?.criteria.map((c) => c.id)).toEqual(["x", "x-2", "x-3"]);
  });

  test("throws when prompt is empty", () => {
    expect(() =>
      normalizeDeliverable({
        kind: "text",
        mode: "manual",
        prompt: "   ",
        criteria: [{ id: "", label: "x" }],
      }),
    ).toThrow(/prompt/);
  });

  test("throws when criteria array is empty in manual mode", () => {
    expect(() =>
      normalizeDeliverable({
        kind: "text",
        mode: "manual",
        prompt: "p",
        criteria: [],
      }),
    ).toThrow(/criteria/);
  });

  test("auto mode allows an empty criteria array (generator fills it)", () => {
    const out = normalizeDeliverable({
      kind: "text",
      mode: "auto",
      prompt: "p",
      notes: "Calibrate to reading level",
      criteria: [],
    });
    expect(out?.mode).toBe("auto");
    expect(out?.notes).toBe("Calibrate to reading level");
    expect(out?.criteria).toEqual([]);
  });

  test("throws when a criterion label is empty", () => {
    expect(() =>
      normalizeDeliverable({
        kind: "text",
        mode: "manual",
        prompt: "p",
        criteria: [{ id: "x", label: "  " }],
      }),
    ).toThrow(/label/);
  });
});

describe("requireDeliverableForOnline (single canonical guard)", () => {
  const okDeliv = {
    kind: "text" as const,
    prompt: "p",
    mode: "manual" as const,
    criteria: [{ id: "x", label: "Overall" }],
  };

  test("throws REFUSED when online + no deliverable AND no advanceRubric", () => {
    expect(() => requireDeliverableForOnline("online", undefined)).toThrow(
      /REFUSED/,
    );
    expect(() =>
      requireDeliverableForOnline("online", undefined, undefined),
    ).toThrow(/REFUSED/);
  });

  test("ok when online + deliverable present", () => {
    expect(() => requireDeliverableForOnline("online", okDeliv)).not.toThrow();
  });

  test("ok when online + advanceRubric present (no deliverable, no document)", () => {
    const advanceRubric = {
      criteria: [{ id: "located", label: "Located the places" }],
    };
    expect(() =>
      requireDeliverableForOnline("online", undefined, advanceRubric),
    ).not.toThrow();
  });

  test("ok when offline + no deliverable", () => {
    expect(() =>
      requireDeliverableForOnline("offline", undefined),
    ).not.toThrow();
  });
});

describe("normalizeAdvanceRubric", () => {
  test("returns undefined for undefined input", () => {
    expect(normalizeAdvanceRubric(undefined)).toBeUndefined();
  });

  test("trims labels + slugifies ids from labels", () => {
    expect(
      normalizeAdvanceRubric({
        criteria: [
          { label: "  Located the capitals  ", description: "  all three  " },
          { label: "Explained the why" },
        ],
      }),
    ).toEqual({
      criteria: [
        {
          id: "located-the-capitals",
          label: "Located the capitals",
          description: "all three",
        },
        { id: "explained-the-why", label: "Explained the why", description: undefined },
      ],
    });
  });

  test("throws on an empty criteria array (meaningless exit bar)", () => {
    expect(() => normalizeAdvanceRubric({ criteria: [] })).toThrow(
      /non-empty/,
    );
  });

  test("throws on a blank label", () => {
    expect(() =>
      normalizeAdvanceRubric({ criteria: [{ label: "   " }] }),
    ).toThrow(/label must be non-empty/);
  });
});

describe("renderCriteriaForRubricCheck", () => {
  test("renders ids + labels + descriptions for the AI", () => {
    const out = renderCriteriaForRubricCheck([
      { id: "spec", label: "Specificity", description: "Names a person" },
      { id: "len", label: "Length" },
    ]);
    expect(out).toBe("1. [spec] Specificity: Names a person\n2. [len] Length");
  });
});

describe("renderCriteriaForTutor", () => {
  test("renders numbered labels + descriptions WITHOUT ids", () => {
    const out = renderCriteriaForTutor([
      { id: "spec", label: "Specificity", description: "Names a person" },
      { id: "len", label: "Length" },
    ]);
    expect(out).toBe("1. Specificity: Names a person\n2. Length");
  });
});

describe("rubricStringToCriteria", () => {
  test("returns undefined for empty input", () => {
    expect(rubricStringToCriteria(undefined)).toBeUndefined();
    expect(rubricStringToCriteria("")).toBeUndefined();
    expect(rubricStringToCriteria("   ")).toBeUndefined();
  });

  test("wraps a string in a one-element criteria array", () => {
    expect(rubricStringToCriteria("Story must be at least 4 sentences")).toEqual([
      {
        id: "overall",
        label: "Overall",
        description: "Story must be at least 4 sentences",
      },
    ]);
  });
});
