/**
 * The practice-flag read model's pure core (`practiceFlagsFromEvents` +
 * `openErrorPatterns.openedAt`). Ordering of the flagged node itself is pinned
 * through `pickFlaggedNode` in remediation.test.ts.
 */
import { describe, expect, test } from "vitest";
import {
  ERROR_FLAG_WINDOW_MS,
  practiceFlagsFromEvents,
  type NodeErrorEvent,
} from "../lib/practice/errorFlags";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

function miss(nodeKey: string, pattern: string, ageDays: number): NodeErrorEvent {
  return { nodeKey, pattern, createdAt: NOW - ageDays * DAY };
}

describe("practiceFlagsFromEvents", () => {
  test("keeps only nodes with an open pattern, grouped per node", () => {
    const flags = practiceFlagsFromEvents(
      [
        miss("a", "DROPPED_CARRY", 1),
        miss("a", "DROPPED_CARRY", 2),
        miss("a", "DROPPED_CARRY", 3),
        miss("a", "REVERSED_OPERANDS", 1), // one-off: not open
        miss("b", "DROPPED_CARRY", 1),
        miss("b", "DROPPED_CARRY", 2), // two: not open
      ],
      NOW,
    );
    expect(flags.map((f) => f.nodeKey)).toEqual(["a"]);
    expect(flags[0].patterns.map((p) => p.pattern)).toEqual(["DROPPED_CARRY"]);
  });

  test("openedAt is the third in-window miss, ignoring aged-out and future rows", () => {
    const [flag] = practiceFlagsFromEvents(
      [
        { nodeKey: "a", pattern: "DROPPED_CARRY", createdAt: NOW - ERROR_FLAG_WINDOW_MS - 1 },
        miss("a", "DROPPED_CARRY", 9),
        miss("a", "DROPPED_CARRY", 5),
        miss("a", "DROPPED_CARRY", 4),
        miss("a", "DROPPED_CARRY", 1),
        { nodeKey: "a", pattern: "DROPPED_CARRY", createdAt: NOW + DAY },
      ],
      NOW,
    );
    expect(flag.patterns[0]).toMatchObject({
      count: 4,
      openedAt: NOW - 4 * DAY,
      lastAt: NOW - 1 * DAY,
    });
  });
});
