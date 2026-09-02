import { describe, expect, test } from "vitest";
import {
  completedGroupOutcome,
  friendlyToolName,
  groupLabel,
  stripFailurePrefix,
} from "../toolLabels";
import type { ToolGroup } from "../toolActivityGroups";

const group = (
  name: string,
  status: "running" | "complete",
  results: (string | undefined)[],
): ToolGroup => ({
  name,
  status,
  items: results.map((result) => ({ result })),
});

describe("groupLabel — rich (pluralizable) tools", () => {
  test("running, count 1 → singular gerund", () => {
    expect(groupLabel(group("create_activity", "running", [undefined])).running).toBe(
      "Adding activity…",
    );
  });

  test("running, count n → plural gerund with count", () => {
    expect(
      groupLabel(group("create_activity", "running", [undefined, undefined, undefined]))
        .running,
    ).toBe("Adding activities… (3)");
  });

  test("done, count 1 → prefers the call's own result string", () => {
    expect(
      groupLabel(group("create_activity", "complete", ['Added "X" to "Y"'])).done,
    ).toBe('Added "X" to "Y"');
  });

  test("done, count 1, no result → past + singular noun", () => {
    expect(groupLabel(group("create_activity", "complete", [undefined])).done).toBe(
      "Added activity",
    );
  });

  test("done, count n → past + count + plural noun (ignores per-item results)", () => {
    expect(
      groupLabel(group("create_lesson", "complete", ["L1", "L2", "L3", "L4", "L5", "L6", "L7"]))
        .done,
    ).toBe("Created 7 lessons");
  });
});

describe("groupLabel — singleton / unmapped tools", () => {
  test("done, count 1 → the result string", () => {
    expect(groupLabel(group("update_unit", "complete", ["Unit updated"])).done).toBe(
      "Unit updated",
    );
  });

  test("done, count 1, no result → friendlyToolName", () => {
    expect(groupLabel(group("read_unit_structure", "complete", [undefined])).done).toBe(
      "Reading unit structure",
    );
  });

  test("running, count 1 → friendlyToolName + ellipsis", () => {
    expect(groupLabel(group("list_scholars", "running", [undefined])).running).toBe(
      "Looking up scholars…",
    );
  });

  test("unmapped tool falls back to humanized name", () => {
    expect(friendlyToolName("some_new_tool")).toBe("some new tool");
    expect(groupLabel(group("some_new_tool", "running", [undefined])).running).toBe(
      "some new tool…",
    );
  });
});

describe("completedGroupOutcome", () => {
  test("no failures → failing 0, failureDetail null, done === groupLabel().done", () => {
    const g = group("create_lesson", "complete", ["L1", "L2", "L3"]);
    const outcome = completedGroupOutcome(g);
    expect(outcome.failing).toBe(0);
    expect(outcome.total).toBe(3);
    expect(outcome.allFailed).toBe(false);
    expect(outcome.failureDetail).toBeNull();
    expect(outcome.done).toBe(groupLabel(g).done);
    expect(outcome.done).toBe("Created 3 lessons");
  });

  test("one call, failed → allFailed, done is the friendly NAME (not the raw string)", () => {
    const outcome = completedGroupOutcome(
      group("dispatch_implementation", "complete", ["Failed: daily dispatch cap reached"]),
    );
    expect(outcome.allFailed).toBe(true);
    expect(outcome.failing).toBe(1);
    expect(outcome.done).toBe("dispatch implementation");
    expect(outcome.done).not.toContain("Failed:");
    expect(outcome.failureDetail).toBe("daily dispatch cap reached");
  });

  test("many calls, all failed → done is friendly name + (n), never the counted past-tense label", () => {
    const outcome = completedGroupOutcome(
      group("create_lesson", "complete", ["Failed: boom", "Failed: boom", "Failed: boom"]),
    );
    expect(outcome.allFailed).toBe(true);
    expect(outcome.failing).toBe(3);
    expect(outcome.done).toBe("Creating lesson (3)");
    expect(outcome.done).not.toContain("Created");
    expect(outcome.failureDetail).toBe("boom");
  });

  test("partial failure → done keeps groupLabel().done, failing counted, failureDetail set", () => {
    const g = group("create_lesson", "complete", [
      "Created lesson A",
      "Failed: boom",
      "Created lesson C",
    ]);
    const outcome = completedGroupOutcome(g);
    expect(outcome.allFailed).toBe(false);
    expect(outcome.failing).toBe(1);
    expect(outcome.total).toBe(3);
    expect(outcome.done).toBe(groupLabel(g).done);
    expect(outcome.done).toBe("Created 3 lessons");
    expect(outcome.failureDetail).toBe("boom");
  });

  test("Error:-prefixed results classify the same as Failed:", () => {
    const outcome = completedGroupOutcome(
      group("read_repo_file", "complete", ["Error: file not found"]),
    );
    expect(outcome.allFailed).toBe(true);
    expect(outcome.failing).toBe(1);
    expect(outcome.failureDetail).toBe("file not found");
  });
});

describe("stripFailurePrefix", () => {
  test("strips a Failed: prefix and trims", () => {
    expect(stripFailurePrefix("Failed: daily dispatch cap reached")).toBe(
      "daily dispatch cap reached",
    );
  });

  test("strips an Error: prefix (case-insensitive) and trims", () => {
    expect(stripFailurePrefix("error:   file not found  ")).toBe("file not found");
  });

  test("leaves a non-prefixed string alone (only trims)", () => {
    expect(stripFailurePrefix("  just a message  ")).toBe("just a message");
  });
});
