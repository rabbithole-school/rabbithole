import { describe, expect, test } from "vitest";
import {
  friendlyToolName,
  SCHOLAR_TOOL_LABELS,
} from "../toolLabels";

const INTERNAL_TERMS =
  /\b(?:verdicts?|observation|confidence|mastery(?:\s+row)?|credit|telemetry|evidence|rubric)\b|overall\s+(?:full|half|not)\b/i;

describe("native scholar tool labels", () => {
  test("contain no internal vocabulary", () => {
    for (const [tool, label] of Object.entries(SCHOLAR_TOOL_LABELS)) {
      expect(label, tool).not.toMatch(INTERNAL_TERMS);
    }
  });

  test("do not expose unknown internal tool identifiers", () => {
    expect(friendlyToolName("get_mastery_data")).toBe("Working");
    expect(friendlyToolName("new_internal_tool")).toBe("Working");
  });
});
