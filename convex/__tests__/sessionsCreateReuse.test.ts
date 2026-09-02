import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActivityKind } from "../../lib/activityKinds";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  username = role === "scholar" ? "testscholar" : `test${role}`,
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : `Test ${role}`,
      username,
      role,
    });
  });
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

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  kind: ActivityKind = "online",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind,
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedLiveAssignment(
  t: ReturnType<typeof convexTest>,
  {
    teacherId,
    scholarId,
    unitId,
    activityId,
  }: {
    teacherId: Id<"users">;
    scholarId: Id<"users">;
    unitId: Id<"units">;
    activityId: Id<"activities">;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now() - 60_000,
      activitySchedule: [
        {
          activityId,
          mode: "classFocus" as const,
          setAt: Date.now() - 60_000,
          endsAt: Date.now() + 60_000,
        },
      ],
    }),
  );
}

describe("sessions.create — live activity reuse", () => {
  test("keeps an unresolved legacy scholar session unstamped and readable", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Primary School",
        slug: "primary-school",
        kind: "school",
        isPrimary: true,
      }),
    );
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    const { id } = await asScholar.mutation(api.sessions.create, {});

    const created = await t.run((ctx) => ctx.db.get(id));
    expect(created?.institutionId).toBeUndefined();
    await expect(asScholar.query(api.sessions.get, { id })).resolves.toMatchObject({
      _id: id,
      userId: scholarId,
    });
  });

  test.each([
    ["simulator", "workbench"],
    ["vibecode", "vibecode"],
    ["online", undefined],
  ] as const)("maps a %s activity to session mode %s", async (kind, expectedMode) => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
      kind,
    );
    const assignmentId = await seedLiveAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      activityId,
    });
    const asScholar = await withUser(t, scholarId);

    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId,
      lessonId,
      activityId,
      assignmentId,
    });

    const created = await t.run(async (ctx) => ctx.db.get(id));
    expect(created?.sessionMode).toBe(expectedMode);
  });

  test("rejects a live activity targeted to another rostered scholar", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const targetedScholarId = await seedUser(t, "scholar", "targeted");
    const teacherId = await seedUser(t, "teacher");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const assignmentId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId, targetedScholarId],
        startedAt: Date.now() - 60_000,
        activitySchedule: [
          {
            activityId,
            mode: "classFocus",
            setAt: Date.now() - 60_000,
            endsAt: Date.now() + 60_000,
            scholarIds: [targetedScholarId],
          },
        ],
      }),
    );
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.sessions.create, {
        unitId,
        lessonId,
        activityId,
        assignmentId,
      }),
    ).rejects.toThrow("Assignment activity is not live");
    expect(
      await t.run((ctx) => ctx.db.query("sessions").collect()),
    ).toHaveLength(0);
  });

  test("repairs the mode on a reused legacy activity session", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
      "simulator",
    );
    const assignmentId = await seedLiveAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      activityId,
    });
    const existingId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        assignmentId,
        title: "Legacy world session",
        isArchived: false,
      }),
    );
    const asScholar = await withUser(t, scholarId);

    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId,
      lessonId,
      activityId,
      assignmentId,
    });

    expect(id).toBe(existingId);
    const reused = await t.run(async (ctx) => ctx.db.get(id));
    expect(reused?.sessionMode).toBe("workbench");
  });

  test("does not resume a seed-exemplar transcript for a live assignment activity", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const assignmentId = await seedLiveAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      activityId,
    });
    const exemplarId = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        assignmentId,
        title: "Scripted exemplar",
        isArchived: false,
        seedExemplar: true,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "This is the scripted seed transcript.",
        flagged: false,
      });
      return sessionId;
    });
    const asScholar = await withUser(t, scholarId);

    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId,
      lessonId,
      activityId,
      assignmentId,
    });

    expect(String(id)).not.toBe(String(exemplarId));
    const created = await t.run(async (ctx) => ctx.db.get(id));
    const createdMessages = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", id))
        .collect(),
    );
    const exemplarMessages = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", exemplarId))
        .collect(),
    );
    expect(created?.seedExemplar).toBeUndefined();
    expect(createdMessages).toHaveLength(0);
    expect(exemplarMessages).toHaveLength(1);
  });

  test("still reuses a normal active session for the same live assignment activity", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const assignmentId = await seedLiveAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      activityId,
    });
    const liveSessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        assignmentId,
        title: "Live work in progress",
        isArchived: false,
      }),
    );
    const asScholar = await withUser(t, scholarId);

    const { id } = await asScholar.mutation(api.sessions.create, {
      unitId,
      lessonId,
      activityId,
      assignmentId,
    });
    const sessions = await t.run(async (ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholarId))
        .collect(),
    );

    expect(String(id)).toBe(String(liveSessionId));
    expect(sessions).toHaveLength(1);
  });
});
