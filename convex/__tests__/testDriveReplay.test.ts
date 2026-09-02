import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Standard fixtures (copied verbatim from the other test-drive specs) ──

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`),
      username:
        overrides.username ??
        (role === "scholar" ? "testscholar" : `test${role}`),
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
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
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function createTestDrive(
  asTeacher: Awaited<ReturnType<typeof withUser>>,
  activityId: Id<"activities">,
) {
  const result = await asTeacher.mutation(api.sessions.create, {
    activityId,
    isTestDrive: true,
  });
  return result.id;
}

// Seed a transcript onto a project, in order. Returns the message ids so a
// test can flag a specific tutor reply.
async function seedTranscript(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
  turns: Array<["user" | "assistant", string]>,
) {
  return await t.run(async (ctx) => {
    const ids: Id<"messages">[] = [];
    for (const [role, content] of turns) {
      ids.push(
        await ctx.db.insert("messages", {
          sessionId,
          role,
          content,
          flagged: false,
        }),
      );
    }
    return ids;
  });
}

describe("Test Drive — Reset & replay", () => {
  test("withReplay stamps the scholar turns (minus <start>) and replays all when nothing is flagged", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const oldId = await createTestDrive(asTeacher, activityId);

    await seedTranscript(t, oldId, [
      ["user", "<start>"],
      ["assistant", "Hi! What are we exploring?"],
      ["user", "sharks"],
      ["assistant", "Cool — what do you know?"],
      ["user", "they have teeth"],
      ["assistant", "Lots! Why so many?"],
    ]);

    const { id: newId } = await asTeacher.mutation(
      api.sessions.resetTestDrive,
      { sessionId: oldId, withReplay: true },
    );

    const newP = await t.run(async (ctx) => ctx.db.get(newId));
    expect(newP!.replayScript).toEqual(["sharks", "they have teeth"]);
    // No flags → replay everything.
    expect(newP!.replayStopAfter).toBe(2);
  });

  test("withReplay pauses at the flagged tutor turn", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const oldId = await createTestDrive(asTeacher, activityId);

    const ids = await seedTranscript(t, oldId, [
      ["user", "<start>"],
      ["assistant", "greeting"], // ids[1]
      ["user", "sharks"],
      ["assistant", "reply to sharks"], // ids[3] — flag this
      ["user", "teeth"],
      ["assistant", "reply to teeth"], // ids[5]
    ]);
    await t.run(async (ctx) => {
      await ctx.db.insert("testDriveFlags", {
        sessionId: oldId,
        messageId: ids[3],
        teacherId,
        kind: "bad",
      });
    });

    const { id: newId } = await asTeacher.mutation(
      api.sessions.resetTestDrive,
      { sessionId: oldId, withReplay: true },
    );

    const newP = await t.run(async (ctx) => ctx.db.get(newId));
    expect(newP!.replayScript).toEqual(["sharks", "teeth"]);
    // Flagged reply answered the 1st scholar turn → stop after 1.
    expect(newP!.replayStopAfter).toBe(1);
  });

  test("withReplay on a greeting-only drive stages nothing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const oldId = await createTestDrive(asTeacher, activityId);
    await seedTranscript(t, oldId, [
      ["user", "<start>"],
      ["assistant", "Hi!"],
    ]);

    const { id: newId } = await asTeacher.mutation(
      api.sessions.resetTestDrive,
      { sessionId: oldId, withReplay: true },
    );
    const newP = await t.run(async (ctx) => ctx.db.get(newId));
    expect(newP!.replayScript).toBeUndefined();
    expect(newP!.replayStopAfter).toBeUndefined();
  });

  test("withReplay reset is rejected when the caller doesn't own the drive", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher");
    const teacherB = await seedUser(t, "teacher", { username: "teacherb" });
    const { activityId } = await seedUnitWithActivity(t, teacherA);
    const asA = await withUser(t, teacherA);
    const asB = await withUser(t, teacherB);
    const oldId = await createTestDrive(asA, activityId);
    await seedTranscript(t, oldId, [
      ["user", "<start>"],
      ["assistant", "Hi!"],
      ["user", "sharks"],
      ["assistant", "Cool"],
    ]);

    await expect(
      asB.mutation(api.sessions.resetTestDrive, {
        sessionId: oldId,
        withReplay: true,
      }),
    ).rejects.toThrow();
  });

  test("a plain reset (no withReplay) stages no script", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const oldId = await createTestDrive(asTeacher, activityId);
    await seedTranscript(t, oldId, [
      ["user", "<start>"],
      ["assistant", "Hi!"],
      ["user", "sharks"],
      ["assistant", "Cool"],
    ]);

    const { id: newId } = await asTeacher.mutation(
      api.sessions.resetTestDrive,
      { sessionId: oldId },
    );
    const newP = await t.run(async (ctx) => ctx.db.get(newId));
    expect(newP!.replayScript).toBeUndefined();
    expect(newP!.replayStopAfter).toBeUndefined();
  });
});

describe("Test Drive — clearReplayScript", () => {
  async function createWithScript(
    t: ReturnType<typeof convexTest>,
    asTeacher: Awaited<ReturnType<typeof withUser>>,
    activityId: Id<"activities">,
  ) {
    const oldId = await createTestDrive(asTeacher, activityId);
    await seedTranscript(t, oldId, [
      ["user", "<start>"],
      ["assistant", "Hi!"],
      ["user", "sharks"],
      ["assistant", "Cool"],
    ]);
    const { id } = await asTeacher.mutation(api.sessions.resetTestDrive, {
      sessionId: oldId,
      withReplay: true,
    });
    return id;
  }

  test("owner clears the staged script", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await createWithScript(t, asTeacher, activityId);

    let p = await t.run(async (ctx) => ctx.db.get(id));
    expect(p!.replayScript).toEqual(["sharks"]);

    await asTeacher.mutation(api.sessions.clearReplayScript, { sessionId: id });
    p = await t.run(async (ctx) => ctx.db.get(id));
    expect(p!.replayScript).toBeUndefined();
    expect(p!.replayStopAfter).toBeUndefined();
  });

  test("rejected when caller doesn't own the drive", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher");
    const teacherB = await seedUser(t, "teacher", { username: "teacherb" });
    const { activityId } = await seedUnitWithActivity(t, teacherA);
    const asA = await withUser(t, teacherA);
    const asB = await withUser(t, teacherB);
    const id = await createWithScript(t, asA, activityId);

    await expect(
      asB.mutation(api.sessions.clearReplayScript, { sessionId: id }),
    ).rejects.toThrow();
  });

  test("rejected on a non-test-drive project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const { id } = await asScholar.mutation(api.sessions.create, { activityId });

    await expect(
      asTeacher.mutation(api.sessions.clearReplayScript, { sessionId: id }),
    ).rejects.toThrow();
  });
});
