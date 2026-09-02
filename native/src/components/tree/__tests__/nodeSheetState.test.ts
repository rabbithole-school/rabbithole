import { describe, expect, it } from "vitest";

import { canPracticeNode } from "../nodeSheetState";

describe("NodeSheet practice action", () => {
  it("only exposes targeted practice for a placed domain and an unlocked node", () => {
    expect(canPracticeNode("frontier", false, true)).toBe(true);
    expect(canPracticeNode("locked", false, true)).toBe(false);
    expect(canPracticeNode("fluent", true, true)).toBe(false);
    expect(canPracticeNode("placed", undefined, true)).toBe(false);
    expect(canPracticeNode("frontier", false, false)).toBe(false);
    expect(canPracticeNode("frontier", false, undefined)).toBe(false);
  });
});
