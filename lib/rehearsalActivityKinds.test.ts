import { describe, expect, test } from "vitest";
import { rehearsalSurfaceForActivityKind } from "./rehearsalActivityKinds";

describe("rehearsal activity gates", () => {
  test.each([
    ["online", "scholar-bot"],
    ["vibecode", "vibecode"],
    ["simulator", "simulator"],
    ["offline", "unavailable"],
    ["shareBack", "unavailable"],
    ["web", "unavailable"],
    ["problem_set", "unavailable"],
    ["game", "unavailable"],
  ] as const)("%s uses the %s surface", (kind, expected) => {
    expect(rehearsalSurfaceForActivityKind(kind)).toBe(expected);
  });
});
