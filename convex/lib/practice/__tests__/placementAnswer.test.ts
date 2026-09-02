import { describe, it, expect } from "vitest";
import { sanitizePlacementAnswer, MAX_PLACEMENT_ANSWER_LEN } from "../placement";

// Pure-logic tests for placement answer sanitation — the storage-side cap
// `submitPlacementAnswer` enforces on every typed placement answer. (Ported
// from the retired placementExplain module's test file when the streamed
// /placement-explain surface was removed.)

describe("sanitizePlacementAnswer", () => {
  it("strips control characters (newlines, tabs) from the answer", () => {
    expect(sanitizePlacementAnswer("1\n2\t3\r4")).toBe("1234");
  });
  it("hard-caps the length at MAX_PLACEMENT_ANSWER_LEN", () => {
    const long = "7".repeat(500);
    expect(sanitizePlacementAnswer(long)).toHaveLength(MAX_PLACEMENT_ANSWER_LEN);
  });
  it("passes a normal short answer through unchanged", () => {
    expect(sanitizePlacementAnswer("3/4")).toBe("3/4");
    expect(sanitizePlacementAnswer("72 R 1")).toBe("72 R 1");
  });
  it("keeps undefined distinct from empty (Don't-Know vs. blank)", () => {
    expect(sanitizePlacementAnswer(undefined)).toBeUndefined();
    expect(sanitizePlacementAnswer("")).toBe("");
  });
});
