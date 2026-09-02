/**
 * Regression: a session spawned by clicking "Explore" on a seed
 * (sessions.createFromSeed) has NO unit/lesson/activity anchor, so before this
 * fix the tutor opened cold — "what's the context?" / "I can't see any
 * materials" — because getSessionContext never read session.seedId. These tests
 * pin that the originating seed now flows into the tutor's context + prompt.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { buildTutorSystemPrompt } from "../sessionStreamHelpers";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withScholar(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: scholarId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${scholarId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("seed-spawned session origin context", () => {
  test("createFromSeed → getSessionContext surfaces the originating seed", async () => {
    const t = convexTest(schema, modules);

    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Oliver",
        username: "oliver",
        role: "scholar",
      }),
    );

    const seedId = await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai",
        status: "active",
        topic: "Heat transfer and fluid dynamics in fire behavior",
        domain: "Physics",
        suggestionType: "depth_probe",
        rationale: "He's wrestling with gas behavior complexity.",
        approachHint: "Create visible demonstrations of convection currents.",
        connectionTo: "His hypothetical about NO₂ fire safety reversal",
      }),
    );

    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );

    // The session is anchorless (no activity/lesson/unit) but carries seedId.
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityId).toBeUndefined();
    expect(session?.lessonId).toBeUndefined();
    expect(session?.unitId).toBeUndefined();
    expect(session?.seedId).toBe(seedId);

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });

    expect(context?.seedOriginContext).toEqual({
      topic: "Heat transfer and fluid dynamics in fire behavior",
      domain: "Physics",
      rationale: "He's wrestling with gas behavior complexity.",
      approachHint: "Create visible demonstrations of convection currents.",
      connectionTo: "His hypothetical about NO₂ fire safety reversal",
      hasStructure: false,
      // A non-story seed carries no story-thread grounding.
      storyThreadContext: null,
    });

    const prompt = buildTutorSystemPrompt(context!);
    expect(prompt).toContain("SESSION FOCUS — SELF-DIRECTED EXPLORATION");
    expect(prompt).toContain(
      "Heat transfer and fluid dynamics in fire behavior",
    );
    expect(prompt).toContain("THIS topic");
  });

  test("a non-seed (blank) session has no origin context", async () => {
    const t = convexTest(schema, modules);

    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Kai",
        username: "kai",
        role: "scholar",
      }),
    );

    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(api.sessions.create, {});

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(context?.seedOriginContext).toBeNull();
    expect(buildTutorSystemPrompt(context!)).not.toContain("SESSION FOCUS");
  });
});
