import { describe, expect, it } from "vitest";

import { rawAnswersEqual } from "../../convex/lib/practice/answers";
import { applyKeyToInputBuffer } from "../../shared/practiceLoop";

describe("teach-as-action grading", () => {
  it("grades 807 correctly when the final key lands immediately before Check", () => {
    const renderedInput = "80";
    const inputBuffer = { current: renderedInput };

    const nextInput = applyKeyToInputBuffer(inputBuffer, "7");

    expect(renderedInput).toBe("80");
    expect(nextInput).toBe("807");
    expect(inputBuffer.current).toBe("807");
    expect(rawAnswersEqual(inputBuffer.current, "807", "integer")).toBe(true);
  });

  it("still rejects the actually incomplete value", () => {
    expect(rawAnswersEqual("80", "807", "integer")).toBe(false);
  });
});
