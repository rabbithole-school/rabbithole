import { describe, expect, test } from "vitest";
import type { ActivityKind } from "./activityKinds";
import {
  isRehearsableActivityKind,
  rehearsalSurfaceForActivityKind,
} from "./rehearsalActivityKinds";

describe("rehearsal activity gates", () => {
  test.each([
    ["online", "scholar-bot"],
    ["vibecode", "vibecode"],
    ["simulator", "simulator"],
    ["simulator", "simulator"],
    ["offline", "unavailable"],
  ] as const)("%s uses the %s surface", (kind, expected) => {
    expect(rehearsalSurfaceForActivityKind(kind)).toBe(expected);
  });

  test("roll-ups include Vibecode and Worlds but exclude unavailable activities", () => {
    const kinds: ActivityKind[] = [
      "online",
      "vibecode",
      "simulator",
      "offline",
      "web",
    ];

    expect(kinds.filter(isRehearsableActivityKind)).toEqual([
      "online",
      "vibecode",
      "simulator",
    ]);
  });
});
