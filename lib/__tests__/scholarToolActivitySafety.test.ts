import { describe, expect, test } from "vitest";
import {
  groupLabel,
  isScholarToolActivityVisible,
  SCHOLAR_TOOL_LABELS,
} from "../toolLabels";
import type { ToolGroup } from "../toolActivityGroups";

const INTERNAL_TERMS =
  /\b(?:verdicts?|observation|confidence|mastery(?:\s+row)?|credit|telemetry|evidence|rubric)\b|overall\s+(?:full|half|not)\b/i;

describe("scholar tool activity safety", () => {
  test("keeps assessment completion payloads staff-only", () => {
    const group: ToolGroup = {
      name: "update_rubric_score",
      status: "complete",
      items: [{ result: "Recorded 2 verdicts · overall full" }],
    };

    expect(isScholarToolActivityVisible(group)).toBe(false);
    expect(groupLabel(group).done).toBe("Recorded 2 verdicts · overall full");
  });

  test("allows only curated in-progress tool labels on scholar surfaces", () => {
    expect(
      isScholarToolActivityVisible({
        name: "update_rubric_score",
        status: "running",
      }),
    ).toBe(true);
    expect(
      isScholarToolActivityVisible({
        name: "get_mastery_data",
        status: "running",
      }),
    ).toBe(false);
    expect(
      isScholarToolActivityVisible({
        name: "new_internal_tool",
        status: "running",
      }),
    ).toBe(false);
  });

  test("scholar-facing tool label constants contain no internal vocabulary", () => {
    for (const [tool, label] of Object.entries(SCHOLAR_TOOL_LABELS)) {
      expect(label, tool).not.toMatch(INTERNAL_TERMS);
      expect(
        groupLabel({
          name: tool,
          status: "running",
          items: [{}],
        }).running,
        `${tool} rendered label`,
      ).not.toMatch(INTERNAL_TERMS);
    }
  });
});
