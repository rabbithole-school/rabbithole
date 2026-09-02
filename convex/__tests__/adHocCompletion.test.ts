import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Ad-hoc dispatch completion (FIX-WAVE item 3 / dayend-coherence §A).
 *
 * A teacher "Dispatch now" creates a lesson-less online activity under a
 * one-scholar `kind: "adHocDispatch"` assignment. Both completion gates used to
 * require `activity.lessonId`, so an ad-hoc dispatch could NEVER register a
 * completion and its assignment Debrief read zero forever. The shared
 * `isConversationCompletable` gate now anchors a lesson-less activity on its
 * ad-hoc dispatch, so the tutor's `mark_activity_complete` tool can close it out
 * and its assignment-scoped completion count reflects the real work.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function seedUser(t: TC, role: "scholar" | "teacher" = "scholar") {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username: `${role}-${Math.random().toString(36).slice(2, 8)}`,
      role,
    }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function addUserMessages(t: TC, sessionId: Id<"sessions">, n: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: `scholar turn ${i}`,
        flagged: false,
      });
    }
  });
}

const callTool = (t: TC, sessionId: Id<"sessions">, summary?: string) =>
  t.run(async (ctx) =>
    ctx.runMutation(internal.activityCompletions.markCompleteFromTool, {
      sessionId,
      summary,
    }),
  );

const completionsByAssignment = (t: TC, assignmentId: Id<"assignments">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("activityCompletions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect(),
  );

/** Dispatch a live ad-hoc activity, then start its session as the scholar. */
async function dispatchAndStart(
  t: TC,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
  title = "Lōʻihi field study",
) {
  const asTeacher = await withUser(t, teacherId);
  const asScholar = await withUser(t, scholarId);
  const { assignmentId, activityId } = await asTeacher.mutation(
    api.assignments.dispatchActivity,
    { scholarId, title },
  );
  const { id: sessionId } = await asScholar.mutation(api.sessions.create, {
    activityId,
    assignmentId,
  });
  return { assignmentId, activityId, sessionId };
}

describe("ad-hoc dispatch is conversation-completable", () => {
  test("dispatch → start → mark_activity_complete writes ONE completion stamped with the dispatched assignmentId + activityId", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    const { assignmentId, activityId, sessionId } = await dispatchAndStart(
      t,
      teacherId,
      scholarId,
    );
    await addUserMessages(t, sessionId, 2);

    const res = await callTool(t, sessionId, "Worked out when Lōʻihi surfaces.");
    expect(res.ok).toBe(true);

    const rows = await completionsByAssignment(t, assignmentId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].activityId)).toBe(String(activityId));
    expect(String(rows[0].scholarId)).toBe(String(scholarId));
    expect(String(rows[0].sessionId)).toBe(String(sessionId));
    // Lesson-less: no lesson/unit anchor is fabricated.
    expect(rows[0].lessonId).toBeUndefined();
    expect(rows[0].unitId).toBeUndefined();

    // The session card state reflects completion.
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeTruthy();

    // The Debrief's data source (collateCohort) now counts the finish.
    const digest = await t.run(async (ctx) =>
      ctx.runQuery(internal.classDigests.collateCohort, { assignmentId }),
    );
    expect(digest?.completionsTotal).toBe(1);
    expect(digest?.scholars[0].completedCount).toBe(1);
  });

  test("the tutor-tool exposure gate (getSessionContext) offers completion for the ad-hoc dispatch", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { sessionId } = await dispatchAndStart(t, teacherId, scholarId);

    const ctxOut = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut?.conversationCompletionContext).toEqual({
      activityTitle: "Lōʻihi field study",
    });
  });

  test("an unrelated completion (another assignment) does not count toward this dispatch", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    // The dispatch under test.
    const { assignmentId, sessionId } = await dispatchAndStart(
      t,
      teacherId,
      scholarId,
    );
    await addUserMessages(t, sessionId, 2);
    await callTool(t, sessionId, "dispatch done");

    // A SEPARATE lesson-anchored activity the same scholar also completes,
    // under its own assignment — the quest's "Up next", not this dispatch.
    const other = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Volcano quest",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Lesson",
        order: 0,
      });
      const otherActivityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Up next",
        kind: "online",
        order: 0,
        systemPrompt: "Explore.",
      });
      const otherAssignmentId = await ctx.db.insert("assignments", {
        unitId,
        teacherId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
      });
      const otherSessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId: otherActivityId,
        assignmentId: otherAssignmentId,
        title: "Session",
        isArchived: false,
      });
      return { otherAssignmentId, otherSessionId };
    });
    await addUserMessages(t, other.otherSessionId, 2);
    const otherRes = await callTool(t, other.otherSessionId, "quest done");
    expect(otherRes.ok).toBe(true);

    // The dispatch's assignment-scoped count is unchanged — the unrelated
    // completion lands under ITS assignment, never this one.
    const rows = await completionsByAssignment(t, assignmentId);
    expect(rows).toHaveLength(1);
    const otherRows = await completionsByAssignment(t, other.otherAssignmentId);
    expect(otherRows).toHaveLength(1);
  });

  test("negative: a lesson-less activity WITHOUT an adHocDispatch assignment still refuses", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    // Lesson-less online activity, but the session has NO adHocDispatch anchor
    // (a plain unit assignment referencing a lesson-less activity, or none).
    const { activityId, sessionId } = await t.run(async (ctx) => {
      const activityId = await ctx.db.insert("activities", {
        title: "Orphan chat",
        kind: "online",
        order: 0,
        systemPrompt: "Explore.",
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        scholarIds: [scholarId],
        title: "Standing",
        kind: "standing",
        startedAt: Date.now(),
        activitySchedule: [
          { activityId, mode: "classFocus" as const, setAt: Date.now() },
        ],
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        assignmentId,
        title: "Session",
        isArchived: false,
      });
      return { activityId, assignmentId, sessionId };
    });
    await addUserMessages(t, sessionId, 3);

    const res = await callTool(t, sessionId, "x");
    expect(res).toMatchObject({ ok: false, reason: "not_conversation_activity" });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(0);

    // And the exposure gate does not offer the tool either.
    const ctxOut = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut?.conversationCompletionContext).toBeNull();
  });
});
