import { describe, expect, test } from "vitest";
import { parseIdentification } from "../equipmentIdentify";

// Why this file: parseIdentification is the seam between the model's free-text
// reply and the add-by-photo prefill. It must survive code fences, prose
// around the JSON, and junk fields — and return null (manual entry) rather
// than a half-broken suggestion when the reply is unusable.

describe("parseIdentification", () => {
  test("parses a clean JSON reply", () => {
    const result = parseIdentification(
      JSON.stringify({
        name: "Set of hand bells",
        category: "Musical",
        quantity: "8 bells (C–C)",
        description: "Tuned hand bells, one octave.",
      }),
    );
    expect(result).toEqual({
      name: "Set of hand bells",
      category: "musical",
      quantity: "8 bells (C–C)",
      description: "Tuned hand bells, one octave.",
      safetyNotes: undefined,
    });
  });

  test("tolerates code fences and surrounding prose", () => {
    const result = parseIdentification(
      'Here you go:\n```json\n{"name": "Singing bowl", "category": "musical"}\n```\nHope that helps!',
    );
    expect(result?.name).toBe("Singing bowl");
    expect(result?.category).toBe("musical");
  });

  test("drops blank/whitespace fields", () => {
    const result = parseIdentification(
      '{"name": "Compass", "quantity": "  ", "description": ""}',
    );
    expect(result).toMatchObject({ name: "Compass" });
    expect(result?.quantity).toBeUndefined();
    expect(result?.description).toBeUndefined();
  });

  test("returns null when there is no name", () => {
    expect(parseIdentification('{"category": "tools"}')).toBeNull();
  });

  test("returns null on non-JSON replies", () => {
    expect(parseIdentification("I can't tell what this is.")).toBeNull();
    expect(parseIdentification("")).toBeNull();
    expect(parseIdentification("{broken json")).toBeNull();
  });

  test("ignores non-string field values", () => {
    const result = parseIdentification(
      '{"name": "Scale", "quantity": 3, "category": ["measurement"]}',
    );
    expect(result).toEqual({
      name: "Scale",
      category: undefined,
      quantity: undefined,
      description: undefined,
      safetyNotes: undefined,
    });
  });
});
