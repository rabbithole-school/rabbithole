import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  mergeInterests,
  renderInterestsForPrompt,
  type Interest,
} from "../lib/interests";

const sessionA = "session-a" as Id<"sessions">;
const sessionB = "session-b" as Id<"sessions">;
const sep3 = Date.UTC(2026, 8, 3, 10);
const sep4 = Date.UTC(2026, 8, 4, 10);

function interest(overrides: Partial<Interest> = {}): Interest {
  return {
    label: "rainbows",
    how: "said",
    dates: [sep3],
    sessionIds: [sessionA],
    state: "active",
    ...overrides,
  };
}

describe("mergeInterests", () => {
  test("merges the rainbows fixture across distinct days", () => {
    const first = mergeInterests(
      undefined,
      [{ label: " Rainbows! ", how: "said", words: "I always see rainbows…" }],
      { sessionId: sessionA, at: sep3 },
    );
    const second = mergeInterests(
      first,
      [{ label: "rainbows.", how: "said", words: "new words" }],
      { sessionId: sessionB, at: sep4 },
    );

    expect(second).toEqual([
      {
        label: "Rainbows!",
        how: "said",
        dates: [sep3, sep4],
        sessionIds: [sessionA, sessionB],
        words: "I always see rainbows…",
        state: "active",
        changedBy: "observer",
      },
    ]);
  });

  test("replaying the tardigrade menu choice does not duplicate evidence", () => {
    const once = mergeInterests(
      undefined,
      [{ label: "tardigrades", how: "menu" }],
      { sessionId: sessionA, at: sep3 },
    );
    expect(
      mergeInterests(once, [{ label: "tardigrades", how: "menu" }], {
        sessionId: sessionA,
        at: sep3,
      }),
    ).toEqual(once);
  });

  test("upgrades menu to said and never downgrades said to menu", () => {
    const upgraded = mergeInterests(
      [interest({ how: "menu" })],
      [{ label: "rainbows", how: "said", words: "I love rainbows" }],
      { sessionId: sessionB, at: sep4 },
    );
    expect(upgraded[0].how).toBe("said");
    expect(upgraded[0].words).toBe("I love rainbows");

    const notDowngraded = mergeInterests(
      upgraded,
      [{ label: "rainbows", how: "menu" }],
      { sessionId: sessionB, at: sep4 },
    );
    expect(notDowngraded[0].how).toBe("said");
  });

  test("keeps a past interest past while recording recurrence", () => {
    const merged = mergeInterests(
      [interest({ state: "past" })],
      [{ label: "rainbows", how: "said" }],
      { sessionId: sessionB, at: sep4 },
    );
    expect(merged[0].state).toBe("past");
    expect(merged[0].dates).toEqual([sep3, sep4]);
  });

  test("caps at 40 by dropping oldest menu rows before other evidence", () => {
    const existing = Array.from({ length: 40 }, (_, index) =>
      interest({
        label: index === 0 ? "old menu" : `said ${index}`,
        how: index === 0 ? "menu" : "said",
        dates: [sep3 + index],
      }),
    );
    const merged = mergeInterests(
      existing,
      [{ label: "new teacher-worthy topic", how: "picked" }],
      { sessionId: sessionB, at: sep4 },
    );
    expect(merged).toHaveLength(40);
    expect(merged.some((row) => row.label === "old menu")).toBe(false);
    expect(merged.some((row) => row.label === "said 1")).toBe(true);
  });

  test("is idempotent for the same incoming session and timestamp", () => {
    const once = mergeInterests(
      undefined,
      [{ label: "rainbows", how: "said", words: "I love rainbows" }],
      { sessionId: sessionA, at: sep3 },
    );
    expect(
      mergeInterests(
        once,
        [{ label: "rainbows", how: "said", words: "I love rainbows" }],
        { sessionId: sessionA, at: sep3 },
      ),
    ).toEqual(once);
  });
});

describe("renderInterestsForPrompt", () => {
  test("parent rendering drops menu rows and provenance dates", () => {
    const rendered = renderInterestsForPrompt(
      [
        interest({ words: "I always see rainbows…" }),
        interest({ label: "tardigrades", how: "menu" }),
        interest({ label: "Japanese", how: "picked" }),
      ],
      "parent",
    );
    expect(rendered).toContain(
      '- rainbows — in their own words: "I always see rainbows…"',
    );
    expect(rendered).toContain("- Japanese — they chose this themselves");
    expect(rendered).not.toContain("tardigrades");
    expect(rendered).not.toContain("Sep");
    expect(rendered).not.toContain(String(sessionA));
  });
});
