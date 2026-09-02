import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Q1 — ad-hoc dispatch ("give ONE scholar something to do right now"). It is
 * modeled as a normal one-scholar assignment with kind:"adHocDispatch" plus a
 * freshly-created ad-hoc online activity; no new table. The only thing that
 * makes it "right now" vs "add to their queue" is live-vs-planned: `live`
 * (default) stamps setAt=now so the scholar sees it at once; `live:false` plans
 * it. Both the teacher-UI mutation (dispatchActivity) and the aide gate
 * (aideDispatchActivity) run the same core.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  username = `u${Math.random().toString(36).slice(2)}`,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher" || role === "staff" || role === "school_admin") await grantInstitutionMembership(t, userId, institutionId, role);
  return userId;
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

const getAssignment = (t: ReturnType<typeof convexTest>, id: Id<"assignments">) =>
  t.run(async (ctx) => ctx.db.get(id));
const getActivity = (t: ReturnType<typeof convexTest>, id: Id<"activities">) =>
  t.run(async (ctx) => ctx.db.get(id));

describe("dispatchActivity (Q1 ad-hoc dispatch)", () => {
  test("live (default): one-scholar adHocDispatch assignment, ad-hoc activity, LIVE now", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);

    const { assignmentId, activityId } = await asT.mutation(api.assignments.dispatchActivity, {
      scholarId: scholar,
      title: "Copenhagen taxation exploration",
    });

    const a = (await getAssignment(t, assignmentId)) as Doc<"assignments">;
    expect(a.kind).toBe("adHocDispatch");
    expect(a.unitId).toBeUndefined();
    expect(a.scholarIds).toEqual([scholar]);
    expect(a.teacherId).toBe(teacher);
    expect(a.activitySchedule).toHaveLength(1);
    const entry = a.activitySchedule![0];
    expect(entry.activityId).toBe(activityId);
    expect(entry.mode).toBe("classFocus");
    expect(entry.setAt).toBeGreaterThan(0); // LIVE now

    const act = (await getActivity(t, activityId)) as Doc<"activities">;
    expect(act.lessonId).toBeUndefined(); // ad-hoc, no lesson/unit
    expect(act.kind).toBe("online");
    expect(act.systemPrompt).toBeTruthy();
  });

  test("live:false adds it to the scholar's queue (planned, setAt null)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const startsAt = Date.now() + 3 * 86_400_000;

    const { assignmentId } = await asT.mutation(api.assignments.dispatchActivity, {
      scholarId: scholar,
      title: "Read about tessellations",
      live: false,
      startsAt,
    });
    const a = (await getAssignment(t, assignmentId)) as Doc<"assignments">;
    const entry = a.activitySchedule![0];
    expect(entry.setAt).toBeUndefined(); // planned, not live
    expect(entry.startsAt).toBe(startsAt);
  });

  test("homework mode carries a dueAt and no endsAt", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const dueAt = Date.now() + 2 * 86_400_000;

    const { assignmentId } = await asT.mutation(api.assignments.dispatchActivity, {
      scholarId: scholar,
      title: "Practice set 3",
      mode: "homework",
      dueAt,
    });
    const a = (await getAssignment(t, assignmentId)) as Doc<"assignments">;
    const entry = a.activitySchedule![0];
    expect(entry.mode).toBe("homework");
    expect(entry.dueAt).toBe(dueAt);
    expect(entry.endsAt).toBeUndefined();
  });

  test("dispatches an offline homework handout with exact instructions through the aide", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const dueAt = Date.now() + 2 * 86_400_000;
    const handout = `
Read the passage below twice.

The tide pulls back from the rocks, leaving small pools full of moving life.

In your notebook:
1. Name two observations.
2. Ask one question you could investigate tomorrow.
`;

    const { assignmentId, activityId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideDispatchActivity, {
        callerUserId: teacher,
        scholarId: scholar,
        title: "Tide pool field notes",
        activityKind: "offline",
        description: handout,
        systemPrompt: "This must not be stored on an offline handout.",
        mode: "homework",
        dueAt,
      }),
    );

    const activity = (await getActivity(t, activityId)) as Doc<"activities">;
    expect(activity.kind).toBe("offline");
    expect(activity.description).toBeUndefined();
    expect(activity.scholarDescription).toBe(handout.trim());
    expect(activity.systemPrompt).toBeUndefined();

    const assignment = (await getAssignment(t, assignmentId)) as Doc<"assignments">;
    const entry = assignment.activitySchedule![0];
    expect(entry.mode).toBe("homework");
    expect(entry.dueAt).toBe(dueAt);
    expect(entry.setAt).toBeGreaterThan(0);
  });

  test("refuses offline dispatches without complete instructions", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacher);

    await expect(
      asTeacher.mutation(api.assignments.dispatchActivity, {
        scholarId: scholar,
        title: "Missing handout",
        activityKind: "offline",
      }),
    ).rejects.toThrow(/offline dispatch needs complete instructions/i);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideDispatchActivity, {
          callerUserId: teacher,
          scholarId: scholar,
          title: "Blank handout",
          activityKind: "offline",
          description: " \n\t ",
        }),
      ),
    ).rejects.toThrow(/offline dispatch needs complete instructions/i);

    await expect(
      asTeacher.mutation(api.assignments.dispatchActivity, {
        scholarId: scholar,
        title: "Invisible handout",
        activityKind: "offline",
        description: "Complete these instructions on paper.",
      }),
    ).rejects.toThrow(/offline dispatch must use homework mode/i);
  });

  test("dispatches a specific reading or video through the existing web activity", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);

    const { activityId } = await asT.mutation(api.assignments.dispatchActivity, {
      scholarId: scholar,
      title: "Read about triangle angle sums",
      activityKind: "web",
      webUrl: "https://example.com/triangle-angles",
      description: "Read this, then be ready to explain why the angles sum to 180°.",
    });

    const activity = (await getActivity(t, activityId)) as Doc<"activities">;
    expect(activity.kind).toBe("web");
    expect(activity.webUrl).toBe("https://example.com/triangle-angles");
    expect(activity.systemPrompt).toBeUndefined();
  });

  test("dispatches targeted practice using canonical knowledge-node keys", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "angle_sum_triangle",
        label: "Use the 180-degree angle sum of a triangle",
        domain: "geometry-measurement",
        source: "practice",
      });
    });

    const { activityId } = await asT.mutation(api.assignments.dispatchActivity, {
      scholarId: scholar,
      title: "Triangle angle tune-up",
      activityKind: "problem_set",
      targetSkillKeys: ["angle_sum_triangle"],
      itemCount: 8,
    });

    const activity = (await getActivity(t, activityId)) as Doc<"activities">;
    expect(activity.kind).toBe("problem_set");
    expect(activity.problemSet).toEqual({
      domain: "geometry-measurement",
      targetSkillKeys: ["angle_sum_triangle"],
      itemCount: 8,
    });
  });

  test("refuses unsafe web URLs and unknown practice keys", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);

    await expect(
      asT.mutation(api.assignments.dispatchActivity, {
        scholarId: scholar,
        title: "Unsafe reading",
        activityKind: "web",
        webUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/must use HTTPS/i);
    await expect(
      asT.mutation(api.assignments.dispatchActivity, {
        scholarId: scholar,
        title: "Mystery practice",
        activityKind: "problem_set",
        targetSkillKeys: ["not_a_real_skill"],
      }),
    ).rejects.toThrow(/Unknown practice skill key/i);
  });

  test("aideDispatchActivity rejects a non-teacher caller, works for a teacher", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const target = await seedUser(t, "scholar");
    const teacher = await seedUser(t, "teacher");

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideDispatchActivity, {
          callerUserId: scholar,
          scholarId: target,
          title: "no",
        }),
      ),
    ).rejects.toThrow(/teacher\/admin only/i);

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideDispatchActivity, {
        callerUserId: teacher,
        scholarId: target,
        title: "Explore prime gaps",
      }),
    );
    const a = (await getAssignment(t, res.assignmentId)) as Doc<"assignments">;
    expect(a.kind).toBe("adHocDispatch");
    expect(a.activitySchedule![0].setAt).toBeGreaterThan(0);
  });
});

describe("queue release — teacher pushActivity on a queued ad-hoc dispatch", () => {
  test("live:false stays planned + invisible to the scholar; pushActivity releases it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const asS = await withUser(t, scholar);

    // 1) Teacher stages ad-hoc work with "Add to queue" (live:false).
    const { assignmentId, activityId } = await asT.mutation(
      api.assignments.dispatchActivity,
      { scholarId: scholar, title: "Sketch a Voronoi diagram", live: false },
    );

    // 2a) The schedule entry is PLANNED — no setAt.
    const queued = (await getAssignment(t, assignmentId)) as Doc<"assignments">;
    const queuedEntry = queued.activitySchedule![0];
    expect(queuedEntry.activityId).toBe(activityId);
    expect(queuedEntry.setAt).toBeUndefined();

    // 2b) The scholar's Home plate omits it (planned entries are skipped).
    const beforeRows = (
      await asS.query(api.scholarPlate.activeForMe, {})
    ).rows;
    expect(
      beforeRows.some((r) => String(r.activityId) === String(activityId)),
    ).toBe(false);

    // 2c) A scholar cannot start it directly — not live.
    await expect(
      asS.mutation(api.sessions.create, { activityId, assignmentId }),
    ).rejects.toThrow(/not live/i);

    // 3) Teacher hits "Start now" → the existing pushActivity releases the
    //    SAME assignment/activity (no duplicate created).
    await asT.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: queuedEntry.mode,
    });
    const assignmentsAfter = await t.run(async (ctx) =>
      ctx.db
        .query("assignments")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher))
        .collect(),
    );
    expect(assignmentsAfter).toHaveLength(1); // no second assignment
    const released = (await getAssignment(t, assignmentId)) as Doc<"assignments">;
    expect(released.activitySchedule).toHaveLength(1); // no second activity
    expect(released.activitySchedule![0].setAt).toBeGreaterThan(0); // now LIVE

    // 4a) It now appears as a not-started Home row for the scholar.
    const afterRows = (
      await asS.query(api.scholarPlate.activeForMe, {})
    ).rows;
    const row = afterRows.find(
      (r) => String(r.activityId) === String(activityId),
    );
    expect(row).toBeTruthy();
    expect(row!.notStarted).toBe(true);
    expect(row!.sessionId).toBeNull();
    expect(String(row!.assignmentId)).toBe(String(assignmentId));

    // 4b) …and the scholar can now start it.
    const { id } = await asS.mutation(api.sessions.create, {
      activityId,
      assignmentId,
    });
    const session = await t.run(async (ctx) => ctx.db.get(id));
    expect(session?.userId).toBe(scholar);
    expect(String(session?.assignmentId)).toBe(String(assignmentId));
    expect(String(session?.activityId)).toBe(String(activityId));
  });
});
