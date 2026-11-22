import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ACTIVE_SEED_READ_LIMIT, SEED_READ_LIMIT } from "../lib/seeds";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// The tutor's seeds read (getSessionContext): only an active seed a teacher
// planted is labelled approved, and the read is bounded and newest-first.

type Origin =
  | "teacher"
  | "story"
  | "badge_follow"
  | "parked"
  | "ai"
  | "ai-constellation";

async function world(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Scholar A",
      username: "scholar-a",
      role: "scholar" as const,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Exploring",
      isArchived: false,
    });
    return { scholarId, sessionId };
  });
}

async function plant(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  topic: string,
  origin: Origin,
  status: "active" | "pending",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("seeds", {
      scholarId,
      origin,
      status,
      topic,
      suggestionType: "frontier",
      rationale: "r",
    });
  });
}

describe("tutor seeds read", () => {
  test("only an active teacher-origin seed is approved", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await world(t);
    await plant(t, scholarId, "planted", "teacher", "active");
    await plant(t, scholarId, "story", "story", "active");
    await plant(t, scholarId, "follow", "badge_follow", "active");
    await plant(t, scholarId, "parked", "parked", "active");
    await plant(t, scholarId, "observer", "ai", "active");
    await plant(t, scholarId, "pending-teacher", "teacher", "pending");
    await plant(t, scholarId, "pending-ai", "ai", "pending");

    const out = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    const flags = Object.fromEntries(
      (out?.seeds ?? []).map((s) => [s.topic, s.approved]),
    );
    expect(flags).toEqual({
      planted: true,
      story: false,
      follow: false,
      parked: false,
      observer: false,
      "pending-teacher": false,
      "pending-ai": false,
    });
  });

  test("the read is bounded per status and keeps the newest", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await world(t);
    const extra = 5;
    for (let i = 0; i < ACTIVE_SEED_READ_LIMIT + extra; i++) {
      await plant(t, scholarId, `a-${i}`, "story", "active");
    }
    for (let i = 0; i < SEED_READ_LIMIT + extra; i++) {
      await plant(t, scholarId, `p-${i}`, "ai", "pending");
    }

    const out = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    const topics = (out?.seeds ?? []).map((s) => s.topic);
    expect(topics).toHaveLength(ACTIVE_SEED_READ_LIMIT + SEED_READ_LIMIT);
    // Newest first within each status; the oldest `extra` rows fall off.
    expect(topics[0]).toBe(`a-${ACTIVE_SEED_READ_LIMIT + extra - 1}`);
    expect(topics).not.toContain("a-0");
    expect(topics).toContain(`a-${extra}`);
    expect(topics).not.toContain("p-0");
    expect(topics).toContain(`p-${extra}`);
  });
});
