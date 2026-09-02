import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { seedScholarInInstitution, seedStaffWithMembership, seedTestInstitution } from "./institutionTestHelpers";
import { readScholarWebActivity } from "../lib/scholarReads";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  username = `test${role}`,
) {
  if (role === "platform_admin") return t.run((ctx) => ctx.db.insert("users", { name: `Test ${role}`, username, role }));
  const institutionId = await seedTestInstitution(t);
  return role === "scholar"
    ? seedScholarInInstitution(t, { institutionId, name: `Test ${role}`, username })
    : seedStaffWithMembership(t, { institutionId, name: `Test ${role}`, username });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

async function seedWebActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  overrides: Partial<{ webUrl: string | undefined }> = {},
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Math",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Daily practice",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Acme Practice",
      kind: "web",
      webUrl:
        "webUrl" in overrides ? overrides.webUrl : "https://www.acmepractice.com/learn",
      webAllowedHosts: ["acmepractice.com"],
      order: 0,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [],
      startedAt: Date.now(),
    });
    return { unitId, lessonId, activityId, assignmentId };
  });
}

describe("webActivitySessions.start", () => {
  test("creates a session owned by the caller", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, assignmentId } = await seedWebActivity(t, teacherId);
    await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        scholarIds: [scholarId],
        activitySchedule: [
          { activityId, mode: "homework" as const, setAt: Date.now() },
        ],
      });
    });
    const asScholar = await withUser(t, scholarId);

    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId, assignmentId },
    );
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.scholarId).toBe(scholarId);
    expect(session?.assignmentId).toBe(assignmentId);
    expect(session?.screenshotIds).toEqual([]);
  });

  test("rejects an activity targeted to another rostered scholar", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const targetedScholarId = await seedUser(t, "scholar", "targeted");
    const { activityId, assignmentId } = await seedWebActivity(t, teacherId);
    await t.run((ctx) =>
      ctx.db.patch(assignmentId, {
        scholarIds: [scholarId, targetedScholarId],
        activitySchedule: [
          {
            activityId,
            mode: "homework",
            setAt: Date.now(),
            scholarIds: [targetedScholarId],
          },
        ],
      }),
    );
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.webActivitySessions.start, {
        activityId,
        assignmentId,
      }),
    ).rejects.toThrow("Assignment does not include activity");
    expect(
      await t.run((ctx) => ctx.db.query("webActivitySessions").collect()),
    ).toHaveLength(0);
  });

  test("requires scoped assignment activities to be live", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, assignmentId } = await seedWebActivity(t, teacherId);
    await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        scholarIds: [scholarId],
        activitySchedule: [],
      });
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.webActivitySessions.start, {
        activityId,
        assignmentId,
      }),
    ).rejects.toThrow("Assignment does not include activity");

    await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        archivedAt: Date.now(),
        activitySchedule: [],
      });
    });
    await expect(
      asScholar.mutation(api.webActivitySessions.start, {
        activityId,
        assignmentId,
      }),
    ).rejects.toThrow("Assignment is archived");
  });

  test("rejects non-web activities and missing URLs", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    const { activityId: noUrl } = await seedWebActivity(t, teacherId, {
      webUrl: undefined,
    });
    await expect(
      asScholar.mutation(api.webActivitySessions.start, { activityId: noUrl }),
    ).rejects.toThrow("no URL");

    const onlineActivity = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U2",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L2",
        order: 0,
      });
      return await ctx.db.insert("activities", {
        lessonId,
        title: "Chat",
        kind: "online",
        systemPrompt: "x",
        order: 0,
      });
    });
    await expect(
      asScholar.mutation(api.webActivitySessions.start, {
        activityId: onlineActivity,
      }),
    ).rejects.toThrow("Not a web activity");
  });
});

describe("ownership gates", () => {
  test("another user cannot touch my session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const otherId = await seedUser(t, "scholar", "otherscholar");
    const { activityId } = await seedWebActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const asOther = await withUser(t, otherId);

    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId },
    );
    await expect(
      asOther.mutation(api.webActivitySessions.recordProgress, {
        sessionId,
        lastUrl: "https://x.com",
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      asOther.mutation(api.webActivitySessions.finalize, {
        sessionId,
        markDone: true,
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("listRecentForScholar is teacher-gated", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.webActivitySessions.listRecentForScholar, {
        scholarId,
      }),
    ).rejects.toThrow();
  });
});

describe("recordProgress", () => {
  test("stores extraction, accumulates off-domain blocks, truncates", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedWebActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId },
    );

    await asScholar.mutation(api.webActivitySessions.recordProgress, {
      sessionId,
      extracted: {
        xpToday: 30,
        xpGoal: 70,
        taskSummaries: Array.from({ length: 40 }, (_, i) => `t${i}`.repeat(150)),
      },
      extractedSource: "api",
      offDomainBlockDelta: 2,
    });
    await asScholar.mutation(api.webActivitySessions.recordProgress, {
      sessionId,
      offDomainBlockDelta: 1,
    });

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.extracted?.xpToday).toBe(30);
    expect(session?.extractedSource).toBe("api");
    expect(session?.offDomainBlocks).toBe(3);
    expect(session?.extracted?.taskSummaries?.length).toBe(30);
    expect(session!.extracted!.taskSummaries![0].length).toBeLessThanOrEqual(200);
  });
});

describe("finalize", () => {
  test("no markDone, no goal → ended but NOT completed", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedWebActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId },
    );

    const result = await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId,
    });
    expect(result).toEqual({ completed: false, goalMet: false });
    const completions = await t.run(async (ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(0);
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.endedAt).toBeDefined();
  });

  test("markDone completes and stamps assignmentId; idempotent (1 row)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, assignmentId, lessonId, unitId } = await seedWebActivity(
      t,
      teacherId,
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        scholarIds: [scholarId],
        activitySchedule: [
          { activityId, mode: "homework" as const, setAt: Date.now() },
        ],
      });
    });
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId, assignmentId },
    );

    const r1 = await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId,
      markDone: true,
    });
    expect(r1.completed).toBe(true);
    // Second finalize (e.g. done-prompt after close) must not duplicate.
    const r2 = await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId,
      markDone: true,
    });
    expect(r2.completed).toBe(true);

    const completions = await t.run(async (ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      scholarId,
      activityId,
      assignmentId,
      lessonId,
      unitId,
    });
  });

  test("completion rows are isolated per assignment", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, assignmentId } = await seedWebActivity(t, teacherId);
    const otherAssignment = await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        scholarIds: [scholarId],
        activitySchedule: [
          { activityId, mode: "homework" as const, setAt: Date.now() },
        ],
      });
      const base = await ctx.db.get(assignmentId);
      return await ctx.db.insert("assignments", {
        teacherId,
        unitId: base!.unitId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId, mode: "homework" as const, setAt: Date.now() },
        ],
      });
    });
    const asScholar = await withUser(t, scholarId);
    const first = await asScholar.mutation(api.webActivitySessions.start, {
      activityId,
      assignmentId,
    });
    const second = await asScholar.mutation(api.webActivitySessions.start, {
      activityId,
      assignmentId: otherAssignment,
    });

    await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId: first.sessionId,
      markDone: true,
    });
    await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId: second.sessionId,
      markDone: true,
    });

    const completions = await t.run(async (ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(2);
    expect(completions.map((c) => String(c.assignmentId)).sort()).toEqual(
      [String(assignmentId), String(otherAssignment)].sort(),
    );
  });

  test("finalize can complete a web activity after its live window expires", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, assignmentId } = await seedWebActivity(t, teacherId);
    await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        scholarIds: [scholarId],
        activitySchedule: [
          { activityId, mode: "classFocus" as const, setAt: Date.now() - 10_000 },
        ],
      });
    });
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId, assignmentId },
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        activitySchedule: [
          {
            activityId,
            mode: "classFocus" as const,
            setAt: Date.now() - 10_000,
            endsAt: Date.now() - 1,
          },
        ],
      });
    });

    const result = await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId,
      markDone: true,
    });

    expect(result.completed).toBe(true);
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.endedAt).toBeDefined();
  });

  test("XP goal met auto-completes with evidence note", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedWebActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId },
    );
    await asScholar.mutation(api.webActivitySessions.recordProgress, {
      sessionId,
      extracted: { xpToday: 72, xpGoal: 70 },
      extractedSource: "dom",
    });

    const result = await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId,
    });
    expect(result).toEqual({ completed: true, goalMet: true });
    const completions = await t.run(async (ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].note).toContain("72/70");
  });

  test("XP below goal does not auto-complete", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedWebActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId },
    );
    await asScholar.mutation(api.webActivitySessions.recordProgress, {
      sessionId,
      extracted: { xpToday: 30, xpGoal: 70 },
    });
    const result = await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId,
    });
    expect(result.completed).toBe(false);
  });
});

describe("summary scheduling on finalize", () => {
  const scheduled = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());

  test("schedules the Haiku recap when the session has captured content", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedWebActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId },
    );
    await asScholar.mutation(api.webActivitySessions.recordProgress, {
      sessionId,
      extracted: { xpToday: 14, xpGoal: 15, tasksCompletedToday: 2 },
      extractedSource: "api",
    });
    await asScholar.mutation(api.webActivitySessions.finalize, { sessionId });

    const jobs = await scheduled(t);
    expect(jobs.length).toBe(1);
    expect(jobs[0].name).toContain("summarize");
  });

  test("does NOT schedule a recap when nothing was captured", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedWebActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId },
    );
    await asScholar.mutation(api.webActivitySessions.finalize, {
      sessionId,
      markDone: true,
    });
    expect(await scheduled(t)).toHaveLength(0);
  });
});

describe("teacher reads", () => {
  test("listRecentForScholar returns enriched sessions", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedWebActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { activityId },
    );
    await asScholar.mutation(api.webActivitySessions.recordProgress, {
      sessionId,
      extracted: { xpToday: 10, xpGoal: 70 },
    });

    const rows = await asTeacher.query(
      api.webActivitySessions.listRecentForScholar,
      { scholarId },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].activityTitle).toBe("Acme Practice");
    expect(rows[0].extracted?.xpToday).toBe(10);
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("agent web-activity time semantics", () => {
  test("labels the institution-local day and refuses stale sessions as active", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      slug: "web-activity-time-school",
    });
    await t.run((ctx) =>
      ctx.db.patch(institutionId, { timeZone: "Pacific/Honolulu" }),
    );
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Test Scholar",
      username: "web-activity-time-scholar",
    });
    const now = Date.parse("2026-08-26T19:17:00.000Z"); // 9:17 AM HST
    await t.run(async (ctx) => {
      await ctx.db.insert("webActivitySessions", {
        scholarId,
        startedAt: Date.parse("2026-08-25T22:13:47.129Z"), // 12:13 PM HST
        endedAt: Date.parse("2026-08-26T00:40:16.064Z"), // 2:40 PM HST
        lastHeartbeatAt: Date.parse("2026-08-26T00:40:14.995Z"),
        screenshotIds: [],
        extracted: {},
      });
      await ctx.db.insert("webActivitySessions", {
        scholarId,
        startedAt: now - 30 * 60_000,
        lastHeartbeatAt: now - 20 * 60_000,
        screenshotIds: [],
      });
      await ctx.db.insert("webActivitySessions", {
        scholarId,
        startedAt: now - 5 * 60_000,
        lastHeartbeatAt: now - 30_000,
        screenshotIds: [],
        extracted: { tasksCompletedToday: 1 },
      });
      await ctx.db.insert("webActivitySessions", {
        scholarId,
        startedAt: now - 60_000,
        lastHeartbeatAt: now + 10_000,
        screenshotIds: [],
        extracted: { xpToday: 2 },
      });
    });

    const result = await t.run((ctx) =>
      readScholarWebActivity(ctx, scholarId, 10, now),
    );

    expect(result.currentTimeLocal).toContain("Aug 26, 2026");
    expect(result.currentTimeLocal).toContain("9:17 AM HST");
    expect(result.todayDayKey).toBe("2026-08-26");

    const ended = result.sessions.find(
      (session) => session.status === "ended",
    );
    expect(ended).toMatchObject({
      localDay: "2026-08-25",
      dayRelation: "yesterday",
      activeNow: false,
      webviewOpenMinutes: 146,
      hasCapturedProgress: false,
    });
    expect(ended?.startedAtLocal).toContain("12:13 PM HST");
    expect(ended?.endedAtLocal).toContain("2:40 PM HST");

    const stale = result.sessions.find(
      (session) => session.status === "stale_unfinalized",
    );
    expect(stale).toMatchObject({
      dayRelation: "today",
      activeNow: false,
      hasCapturedProgress: false,
    });

    const active = result.sessions.find(
      (session) =>
        session.status === "active" && session.webviewOpenMinutes === 5,
    );
    expect(active).toMatchObject({
      dayRelation: "today",
      activeNow: true,
      webviewOpenMinutes: 5,
      hasCapturedProgress: true,
    });
    const slightlyFutureHeartbeat = result.sessions.find(
      (session) =>
        session.status === "active" && session.webviewOpenMinutes === 1,
    );
    expect(slightlyFutureHeartbeat).toMatchObject({
      activeNow: true,
      dayRelation: "today",
      hasCapturedProgress: true,
    });
    expect(result.interpretation).toContain(
      "not proof of continuous attention or practice",
    );
  });
});
