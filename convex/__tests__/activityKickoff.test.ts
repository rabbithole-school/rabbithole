import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function seedUser(
  t: TC,
  role: "scholar" | "teacher",
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: username === "kai_kahale" ? "Kai Kahale" : "Lehua Torres",
      username,
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
  t: TC,
  teacherId: Id<"users">,
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
      kind: "online",
      systemPrompt: "Invite the scholar to investigate balance.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedSession(
  t: TC,
  userId: Id<"users">,
  overrides: Partial<Doc<"sessions">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: "Test Activity Session",
      isArchived: false,
      ...overrides,
    }),
  );
}

async function sessionMessages(
  t: TC,
  sessionId: Id<"sessions">,
) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
}

describe("sessions.startActivityKickoff", () => {
  test("an empty activity session gets exactly one assistant placeholder", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "kai_kahale");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      scholarId,
    );
    const sessionId = await seedSession(t, scholarId, {
      unitId,
      lessonId,
      activityId,
    });
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.mutation(api.sessions.startActivityKickoff, {
      sessionId,
    });

    expect(result).not.toBeNull();
    expect(result?.status).toBe("started");
    if (!result || result.status !== "started") {
      throw new Error("Expected kickoff to start");
    }
    expect(result.streamId).toBeTruthy();
    expect(result.sessionId).toBe(sessionId);
    const messages = await sessionMessages(t, sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      _id: result.assistantMsgId,
      role: "assistant",
      content: "",
      streamId: result.streamId,
      streamTrigger: "activityKickoff",
    });
  });

  test("a fresh kickoff placeholder reports pending without adding another", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "kai_kahale");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      scholarId,
    );
    const sessionId = await seedSession(t, scholarId, {
      unitId,
      lessonId,
      activityId,
    });
    const asScholar = await withUser(t, scholarId);

    const first = await asScholar.mutation(api.sessions.startActivityKickoff, {
      sessionId,
    });
    const second = await asScholar.mutation(api.sessions.startActivityKickoff, {
      sessionId,
    });

    expect(first).not.toBeNull();
    expect(second?.status).toBe("pending");
    expect(
      second?.status === "pending" ? second.retryAfterMs : 0,
    ).toBeGreaterThan(0);
    expect(await sessionMessages(t, sessionId)).toHaveLength(1);
  });

  test("a stale kickoff placeholder is replaced so the opener can retry", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "kai_kahale");
    const { activityId } = await seedUnitWithActivity(t, scholarId);
    const sessionId = await seedSession(t, scholarId, { activityId });
    const asScholar = await withUser(t, scholarId);

    const first = await asScholar.mutation(api.sessions.startActivityKickoff, {
      sessionId,
    });
    expect(first?.status).toBe("started");
    if (!first || first.status !== "started") {
      throw new Error("Expected kickoff to start");
    }
    await t.run(async (ctx) =>
      ctx.db.patch(first.assistantMsgId, {
        lastStreamActivityAt: Date.now() - 21_000,
      }),
    );

    const retry = await asScholar.mutation(api.sessions.startActivityKickoff, {
      sessionId,
    });

    expect(retry?.status).toBe("started");
    if (!retry || retry.status !== "started") {
      throw new Error("Expected stale kickoff to restart");
    }
    expect(retry.assistantMsgId).not.toBe(first.assistantMsgId);
    const messages = await sessionMessages(t, sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      _id: retry.assistantMsgId,
      role: "assistant",
      content: "",
      streamTrigger: "activityKickoff",
    });
  });

  test("an existing message prevents kickoff", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "kai_kahale");
    const { activityId } = await seedUnitWithActivity(t, scholarId);
    const sessionId = await seedSession(t, scholarId, { activityId });
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "I am ready.",
        flagged: false,
      }),
    );
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.mutation(api.sessions.startActivityKickoff, {
      sessionId,
    });

    expect(result).toBeNull();
    expect(await sessionMessages(t, sessionId)).toHaveLength(1);
  });

  test("non-activity, offline, and archived sessions do not kick off", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "kai_kahale");
    const { activityId } = await seedUnitWithActivity(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const noActivityId = await seedSession(t, scholarId);
    const offlineId = await seedSession(t, scholarId, {
      activityId,
      isOffline: true,
    });
    const archivedId = await seedSession(t, scholarId, {
      activityId,
      isArchived: true,
    });

    for (const sessionId of [noActivityId, offlineId, archivedId]) {
      expect(
        await asScholar.mutation(api.sessions.startActivityKickoff, {
          sessionId,
        }),
      ).toBeNull();
      expect(await sessionMessages(t, sessionId)).toHaveLength(0);
    }
  });

  test("a non-owner scholar is forbidden", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "scholar", "kai_kahale");
    const otherScholarId = await seedUser(t, "scholar", "lehua_torres");
    const { activityId } = await seedUnitWithActivity(t, ownerId);
    const sessionId = await seedSession(t, ownerId, { activityId });
    const asOtherScholar = await withUser(t, otherScholarId);

    await expect(
      asOtherScholar.mutation(api.sessions.startActivityKickoff, { sessionId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a teacher may start kickoff on a scholar's session", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "kai_kahale");
    const teacherId = await seedUser(t, "teacher", "lehua_torres");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const sessionId = await seedSession(t, scholarId, { activityId });
    await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
      });
      await ctx.db.insert("memberships", {
        userId: scholarId,
        role: "scholar",
        institutionId,
      });
      await ctx.db.insert("memberships", {
        userId: teacherId,
        role: "teacher",
        institutionId,
      });
    });
    const asTeacher = await withUser(t, teacherId);

    const result = await asTeacher.mutation(
      api.sessions.startActivityKickoff,
      { sessionId },
    );

    expect(result).not.toBeNull();
    expect(await sessionMessages(t, sessionId)).toHaveLength(1);
  });
});
