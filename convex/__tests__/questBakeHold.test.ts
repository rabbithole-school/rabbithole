import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

/**
 * `questBakeStatus` is the server half of the opening-turn hold
 * (shared/questBakeHold.ts): while it is "pending", the scholar's session shows
 * "building your quest" and sends nothing. So the property that matters is not
 * that it gets SET — it is that it always gets CLEARED. A session left pending
 * by a bake that ended some other way is a scholar sitting on a spinner until
 * the client cap rescues them.
 *
 * These cover the mutation-level state machine (set → linked, set → released).
 * The wrapper that guarantees every action exit reaches one of those two,
 * including a throw, is `withQuestBakeHoldReleased` in bakeUnitFromSeed.ts; the
 * bake actions themselves need a live model and are exercised by hand.
 */

async function seedScholar(t: TC): Promise<Id<"users">> {
  const institutionId = await seedTestInstitution(t);
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Scholar One",
      username: "scholar_one",
      role: "scholar",
    });
    await ctx.db.patch(userId, { institutionId });
    return userId;
  });
}

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** A Custom Quest at the moment it launches: empty unit, session, no activity. */
async function seedCustomQuestLaunch(t: TC, scholarId: Id<"users">) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      authorScholarId: scholarId,
      title: "How do bridges hold themselves up?",
      isActive: true,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "How do bridges hold themselves up?",
      isArchived: false,
      unitId,
    });
    return { unitId, sessionId };
  });
}

/** `t.run` encodes an absent optional field as null on the way out. */
function status(t: TC, sessionId: Id<"sessions">) {
  return t.run(
    async (ctx) => (await ctx.db.get(sessionId))?.questBakeStatus ?? null,
  );
}

function activityId(t: TC, sessionId: Id<"sessions">) {
  return t.run(async (ctx) => (await ctx.db.get(sessionId))?.activityId ?? null);
}

/** What the path picker hands back when the scholar chooses a designed angle. */
const CHOSEN_PATH = {
  title: "Be a bridge engineer",
  blurb: "Build one from paper and find where it gives way.",
};

describe("quest bake hold", () => {
  test("scheduling a Custom Quest bake marks the session as waiting", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { unitId, sessionId } = await seedCustomQuestLaunch(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    expect(await status(t, sessionId)).toBeNull();

    await asScholar.mutation(api.units.scheduleCustomQuestBake, {
      unitId,
      sessionId,
      bakePath: CHOSEN_PATH,
    });

    // The mark must land in the SAME mutation that schedules the bake — a
    // client that observes the session in between opens the ad-lib turn this
    // hold exists to prevent.
    expect(await status(t, sessionId)).toBe("pending");
  });

  test("linking the baked activity clears the hold", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { unitId, sessionId } = await seedCustomQuestLaunch(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.units.scheduleCustomQuestBake, {
      unitId,
      sessionId,
      bakePath: CHOSEN_PATH,
    });

    const { lessonId, activityId: bakedActivityId } = await t.run(async (ctx) => {
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "The arch that carries itself",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Build a bridge from paper",
        kind: "online",
        order: 0,
        systemPrompt: "Set up the paper-bridge build.",
      });
      return { lessonId, activityId };
    });

    const res = await t.mutation(
      internal.bakeUnitFromSeed.linkBakedUnitToSession,
      { sessionId, scholarId, unitId, lessonId, activityId: bakedActivityId },
    );

    expect(res.linked).toBe(true);
    expect(await status(t, sessionId)).toBeNull();
    expect(await activityId(t, sessionId)).toBe(bakedActivityId);
  });

  test("a bake that ends without linking releases the hold", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { unitId, sessionId } = await seedCustomQuestLaunch(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.units.scheduleCustomQuestBake, {
      unitId,
      sessionId,
      bakePath: CHOSEN_PATH,
    });

    await t.mutation(internal.bakeUnitFromSeed.releaseQuestBakeHold, {
      sessionId,
    });

    // No activity ever arrived, so the session opens exactly the way it did
    // before this feature existed rather than waiting out the client cap.
    expect(await status(t, sessionId)).toBeNull();
    expect(await activityId(t, sessionId)).toBeNull();
  });

  test("releasing is idempotent and never disturbs an already-linked session", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { sessionId } = await seedCustomQuestLaunch(t, scholarId);

    // Never pending: the release is a no-op rather than a write.
    await t.mutation(internal.bakeUnitFromSeed.releaseQuestBakeHold, {
      sessionId,
    });
    expect(await status(t, sessionId)).toBeNull();

    // A second release after a real one is equally harmless — the wrapper's
    // `finally` can run against a session another path already resolved.
    await t.mutation(internal.bakeUnitFromSeed.releaseQuestBakeHold, {
      sessionId,
    });
    expect(await status(t, sessionId)).toBeNull();
  });

  test('"Endless chat" bakes without holding — the scholar asked to talk now', async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { unitId, sessionId } = await seedCustomQuestLaunch(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    // Both Custom Quest dialogs omit bakePath for exactly one choice: the
    // endless-chat card, whose promise is "No plan — just start talking".
    await asScholar.mutation(api.units.scheduleCustomQuestBake, {
      unitId,
      sessionId,
    });

    // The bake still runs (the unit becomes a structured quest), but the
    // session opens immediately rather than showing "building your quest".
    expect(await status(t, sessionId)).toBeNull();

    // …and the bake is handed no session, so it can never upgrade the open
    // chat in place into the baked unit's first activity mid-conversation.
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const bakes = scheduled.filter((f) => f.name.includes("bakeCustomQuestUnit"));
    expect(bakes).toHaveLength(1);
    expect(bakes[0].args[0]).toEqual({ unitId });
  });

  test("re-scheduling a bake for an already-structured session does not re-hold it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { unitId, sessionId } = await seedCustomQuestLaunch(t, scholarId);

    await t.run(async (ctx) => {
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "The arch that carries itself",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Build a bridge from paper",
        kind: "online",
        order: 0,
      });
      await ctx.db.patch(sessionId, { lessonId, activityId });
    });

    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.units.scheduleCustomQuestBake, {
      unitId,
      sessionId,
      bakePath: CHOSEN_PATH,
    });

    // The session already has its task; holding it would blank a live chat.
    expect(await status(t, sessionId)).toBeNull();
  });

  test("an upgraded Endless chat can be reopened as an open chat", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { unitId, sessionId } = await seedCustomQuestLaunch(t, scholarId);
    // The pre-fix state, produced by the real link: a bake upgraded the live
    // chat into its first activity, seeding that activity's canvas.
    const { lessonId, bakedActivityId } = await t.run(async (ctx) => {
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "The arch that carries itself",
        order: 0,
      });
      const bakedActivityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Build a bridge from paper",
        kind: "online",
        order: 0,
        deliverable: {
          kind: "text",
          prompt: "Describe your bridge.",
          mode: "auto",
          criteria: [],
        },
      });
      return { lessonId, bakedActivityId };
    });
    await t.mutation(internal.bakeUnitFromSeed.linkBakedUnitToSession, {
      sessionId,
      scholarId,
      unitId,
      lessonId,
      activityId: bakedActivityId,
    });
    const seeded = await t.run((ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(seeded.map((a) => a.title)).toEqual(["Build a bridge from paper"]);
    // Something the scholar wrote themselves must survive the repair.
    const keptId = await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "My bridge notes",
        content: "Arches push outward.",
        lastEditedBy: "scholar",
        type: "text",
      }),
    );

    const res = await t.mutation(
      internal.bakeUnitFromSeed.reopenBakedSessionAsEndlessChat,
      { sessionId },
    );

    expect(res.reopened).toBe(true);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.activityId).toBeUndefined();
    expect(session?.lessonId).toBeUndefined();
    expect(session?.deliverableCriteriaStatus).toBeUndefined();
    expect(session?.reflectionStatus).toBeUndefined();
    // Still inside the scholar's quest.
    expect(session?.unitId).toBe(unitId);
    // The untouched seeded canvas is gone; the scholar's own writing is not.
    const left = await t.run((ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(left.map((a) => a._id)).toEqual([keptId]);
  });

  test("reopening refuses a session that belongs to a teacher assignment", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { unitId, sessionId } = await seedCustomQuestLaunch(t, scholarId);
    const assignedActivityId = await t.run(async (ctx) => {
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Arches",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Build a bridge",
        kind: "online",
        order: 0,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        unitId,
        teacherId: scholarId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
        activitySchedule: [],
      });
      await ctx.db.patch(sessionId, { lessonId, activityId, assignmentId });
      return activityId;
    });

    const res = await t.mutation(
      internal.bakeUnitFromSeed.reopenBakedSessionAsEndlessChat,
      { sessionId },
    );

    expect(res.reopened).toBe(false);
    expect(await activityId(t, sessionId)).toBe(assignedActivityId);
  });

  test("reopening refuses a session whose unit the scholar did not author", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const { sessionId, assignedActivityId } = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Teacher",
        username: "reopen-teacher",
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Bridges",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Arches",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Build a bridge",
        kind: "online",
        order: 0,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Bridges",
        isArchived: false,
        unitId,
        lessonId,
        activityId,
      });
      return { sessionId, assignedActivityId: activityId };
    });

    const res = await t.mutation(
      internal.bakeUnitFromSeed.reopenBakedSessionAsEndlessChat,
      { sessionId },
    );

    expect(res.reopened).toBe(false);
    expect(await activityId(t, sessionId)).toBe(assignedActivityId);
  });
});
