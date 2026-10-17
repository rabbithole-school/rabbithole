import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/convex", () => ({
  api: {
    sessions: { startFreePlay: "sessions.startFreePlay", questFromParkedIdea: "sessions.questFromParkedIdea" },
    quests: { appendBuildStep: "quests.appendBuildStep" },
  },
}));
import { headerLockLine } from "./missionApi";

describe("headerLockLine (TRA-519 B6 session header)", () => {
  const lock = { prerequisiteTitle: "What changes the swing?", prerequisiteId: "learn1" };

  test("drops the line when the lock waits on the current activity", () => {
    expect(headerLockLine(lock, { id: "learn1", title: "What changes the swing?" })).toBeNull();
  });

  test("keeps the line when the lock waits on a different activity", () => {
    expect(headerLockLine(lock, { id: "intro", title: "Meet the pendulum" })).toBe(lock);
  });

  test("older servers without an id fall back to the title", () => {
    const old = { prerequisiteTitle: "What changes the swing?" };
    expect(headerLockLine(old, { id: "learn1", title: "What changes the swing?" })).toBeNull();
    expect(headerLockLine(old, { id: "intro", title: "Meet the pendulum" })).toBe(old);
  });

  test("no lock, no line", () => {
    expect(headerLockLine(null, { id: "x" })).toBeNull();
  });
});
