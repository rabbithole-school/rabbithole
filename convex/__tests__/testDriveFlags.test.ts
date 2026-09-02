import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : `Test ${role}`,
      username: role === "scholar" ? "testscholar" : `test${role}`,
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

async function seedTestDriveSessionWithMessages(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "U",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "L",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "A",
      kind: "online",
      systemPrompt: "You are a tutor.",
      order: 0,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: teacherId,
      unitId,
      lessonId,
      activityId,
      title: "A",
      isArchived: false,
      isTestDrive: true,
    });
    const userMsg = await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: "hi",
      flagged: false,
    });
    const assistantMsg1 = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "Welcome! Let's begin.",
      flagged: false,
    });
    const assistantMsg2 = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "What did you think?",
      flagged: false,
    });
    return { unitId, lessonId, activityId, sessionId, userMsg, assistantMsg1, assistantMsg2 };
  });
}

describe("testDriveFlags.toggle — auth + idempotency", () => {
  test("teacher can flag a tutor message in their own test drive", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { assistantMsg1 } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const r = await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });
    expect(r.kind).toBe("good");

    const flags = await t.run(async (ctx) =>
      ctx.db
        .query("testDriveFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg1))
        .collect(),
    );
    expect(flags.length).toBe(1);
    expect(flags[0].kind).toBe("good");
    expect(flags[0].teacherId).toBe(teacherId);
  });

  test("clicking the same kind twice toggles off", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { assistantMsg1 } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });
    const second = await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });
    expect(second.kind).toBeNull();
    const flags = await t.run(async (ctx) =>
      ctx.db
        .query("testDriveFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg1))
        .collect(),
    );
    expect(flags.length).toBe(0);
  });

  test("clicking the opposite kind replaces and drops any prior note", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { assistantMsg1 } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });
    // Attach a note to the 👍 — it should NOT carry over when the
    // teacher flips to 👎, since the rationale is now stale.
    await asTeacher.mutation(api.testDriveFlags.setNote, {
      messageId: assistantMsg1,
      note: "I liked this",
    });
    const second = await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "bad",
    });
    expect(second.kind).toBe("bad");
    const flags = await t.run(async (ctx) =>
      ctx.db
        .query("testDriveFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg1))
        .collect(),
    );
    expect(flags.length).toBe(1);
    expect(flags[0].kind).toBe("bad");
    expect(flags[0].note).toBeUndefined();
  });

  test("scholar cannot flag (Forbidden)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.testDriveFlags.toggle, {
        messageId: assistantMsg1,
        kind: "good",
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("non-test-drive projects reject flags", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacherId);
    const { messageId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U",
        isActive: true,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: teacherId,
        unitId,
        title: "regular",
        isArchived: false,
      });
      const messageId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "hi",
        flagged: false,
      });
      return { messageId };
    });

    await expect(
      asTeacher.mutation(api.testDriveFlags.toggle, {
        messageId,
        kind: "good",
      }),
    ).rejects.toThrow(/test-drive/);
  });

  test("user-role messages cannot be flagged", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { userMsg } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.testDriveFlags.toggle, {
        messageId: userMsg,
        kind: "good",
      }),
    ).rejects.toThrow(/tutor/);
  });
});

describe("testDriveFlags.setNote — attach 'why' note after flagging", () => {
  test("setNote updates the existing flag's note in place", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { assistantMsg1 } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "bad",
    });
    const r = await asTeacher.mutation(api.testDriveFlags.setNote, {
      messageId: assistantMsg1,
      note: "tutor was rambling",
    });
    expect(r?.kind).toBe("bad");
    expect(r?.note).toBe("tutor was rambling");

    const flags = await t.run(async (ctx) =>
      ctx.db
        .query("testDriveFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg1))
        .collect(),
    );
    expect(flags[0].note).toBe("tutor was rambling");
    // Kind is preserved.
    expect(flags[0].kind).toBe("bad");
  });

  test("setNote returns null when no flag exists yet (no-op)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { assistantMsg1 } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const r = await asTeacher.mutation(api.testDriveFlags.setNote, {
      messageId: assistantMsg1,
      note: "doesn't matter",
    });
    expect(r).toBeNull();
  });

  test("scholar cannot setNote (Forbidden)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { assistantMsg1 } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });
    await expect(
      asScholar.mutation(api.testDriveFlags.setNote, {
        messageId: assistantMsg1,
        note: "trying to mess with the flag",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("testDriveFlags.listForSession", () => {
  test("returns this teacher's flags scoped to a test-drive project", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { sessionId, assistantMsg1, assistantMsg2 } =
      await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });
    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg2,
      kind: "bad",
    });
    // Notes are added separately via setNote.
    await asTeacher.mutation(api.testDriveFlags.setNote, {
      messageId: assistantMsg2,
      note: "too vague",
    });

    const flags = await asTeacher.query(api.testDriveFlags.listForSession, {
      sessionId,
    });
    expect(flags.length).toBe(2);
    const byKind = Object.fromEntries(flags.map((f) => [f.kind, f]));
    expect(byKind.good.messageId).toBe(assistantMsg1);
    expect(byKind.bad.messageId).toBe(assistantMsg2);
    expect(byKind.bad.note).toBe("too vague");
  });

  test("scholar gets an empty list", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { sessionId, assistantMsg1 } = await seedTestDriveSessionWithMessages(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });

    const flags = await asScholar.query(api.testDriveFlags.listForSession, {
      sessionId,
    });
    expect(flags).toEqual([]);
  });
});

describe("sendMessageForUnit + flagSnapshots — persisted in chat history", () => {
  test("flagSnapshots round-trip onto the user curriculum message", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { unitId } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const flagSnapshots = [
      { kind: "good" as const, snippet: "great opener" },
      { kind: "bad" as const, snippet: "bit rambling tho" },
    ];
    await asTeacher.mutation(api.curriculumAssistant.sendMessageForUnit, {
      unitId,
      message: "i liked this opener but the second message was rambling",
      flagSnapshots,
    });

    const userMsg = await t.run(async (ctx) =>
      ctx.db
        .query("curriculumMessages")
        .withIndex("by_teacher_unit", (q) =>
          q.eq("teacherId", teacherId).eq("unitId", unitId),
        )
        .filter((q) => q.eq(q.field("role"), "user"))
        .first(),
    );
    expect(userMsg).toBeTruthy();
    expect(userMsg!.flagSnapshots).toEqual(flagSnapshots);
  });

  test("empty flagSnapshots array is normalized to undefined (skip the field)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { unitId } = await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.curriculumAssistant.sendMessageForUnit, {
      unitId,
      message: "no flags this turn",
      flagSnapshots: [],
    });

    const userMsg = await t.run(async (ctx) =>
      ctx.db
        .query("curriculumMessages")
        .withIndex("by_teacher_unit", (q) =>
          q.eq("teacherId", teacherId).eq("unitId", unitId),
        )
        .filter((q) => q.eq(q.field("role"), "user"))
        .first(),
    );
    expect(userMsg).toBeTruthy();
    expect(userMsg!.flagSnapshots).toBeUndefined();
  });
});

describe("multi-flag setNote — same note across the cluster", () => {
  test("attaching one note to two flagged messages leaves both with the same note", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { assistantMsg1, assistantMsg2 } =
      await seedTestDriveSessionWithMessages(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });
    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg2,
      kind: "good",
    });
    await Promise.all([
      asTeacher.mutation(api.testDriveFlags.setNote, {
        messageId: assistantMsg1,
        note: "both for the same reason",
      }),
      asTeacher.mutation(api.testDriveFlags.setNote, {
        messageId: assistantMsg2,
        note: "both for the same reason",
      }),
    ]);

    const flag1 = await t.run(async (ctx) =>
      ctx.db
        .query("testDriveFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg1))
        .first(),
    );
    const flag2 = await t.run(async (ctx) =>
      ctx.db
        .query("testDriveFlags")
        .withIndex("by_message", (q) => q.eq("messageId", assistantMsg2))
        .first(),
    );
    expect(flag1?.note).toBe("both for the same reason");
    expect(flag2?.note).toBe("both for the same reason");
  });
});

describe("getTestDriveContext — transcript + flags inline (phase 3a/3b)", () => {
  test("returns activity systemPrompt, transcript, and flagged tutor messages", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { sessionId, assistantMsg1 } = await seedTestDriveSessionWithMessages(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);

    // Flag one of the tutor messages, then attach a "why" note via the
    // separate setNote path (matching the FE flow: toggle on click,
    // setNote on send).
    await asTeacher.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "bad",
    });
    await asTeacher.mutation(api.testDriveFlags.setNote, {
      messageId: assistantMsg1,
      note: "rambling",
    });

    const ctxResult = await t.run(async (ctx) => {
      return await ctx.runQuery(
        internal.curriculumAssistant.getTestDriveContext,
        { sessionId, teacherId },
      );
    });
    expect(ctxResult).toBeTruthy();
    expect(ctxResult!.activity?.title).toBe("A");
    expect(ctxResult!.activity?.systemPrompt).toBe("You are a tutor.");
    expect(ctxResult!.messages.length).toBe(3); // 1 user + 2 assistant
    expect(ctxResult!.totalCount).toBe(3);
    expect(ctxResult!.truncated).toBe(false);
    const flagged = ctxResult!.messages.find((m) => m.flag);
    expect(flagged).toBeTruthy();
    expect(flagged!.flag!.kind).toBe("bad");
    expect(flagged!.flag!.note).toBe("rambling");
  });

  test("returns null when caller isn't the project owner (cross-teacher exfil guard)", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher");
    const teacherB = await seedUser(t, "teacher");
    const { sessionId, assistantMsg1 } = await seedTestDriveSessionWithMessages(
      t,
      teacherA,
    );
    const asTeacherA = await withUser(t, teacherA);

    // Teacher A flags a tutor message in their own drive.
    await asTeacherA.mutation(api.testDriveFlags.toggle, {
      messageId: assistantMsg1,
      kind: "good",
    });

    // Teacher B tries to read teacher A's test-drive context — must
    // return null even though the projectId is valid.
    const spoofed = await t.run(async (ctx) => {
      return await ctx.runQuery(
        internal.curriculumAssistant.getTestDriveContext,
        { sessionId, teacherId: teacherB },
      );
    });
    expect(spoofed).toBeNull();

    // Teacher A still gets their own context back, of course.
    const own = await t.run(async (ctx) => {
      return await ctx.runQuery(
        internal.curriculumAssistant.getTestDriveContext,
        { sessionId, teacherId: teacherA },
      );
    });
    expect(own).toBeTruthy();
    expect(own!.activity?.title).toBe("A");
  });

  test("returns null for non-test-drive projects (even when caller is the owner)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const sessionId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U",
        isActive: true,
      });
      return await ctx.db.insert("sessions", {
        userId: teacherId,
        unitId,
        title: "real session",
        isArchived: false,
      });
    });

    const ctxResult = await t.run(async (ctx) => {
      return await ctx.runQuery(
        internal.curriculumAssistant.getTestDriveContext,
        { sessionId, teacherId },
      );
    });
    expect(ctxResult).toBeNull();
  });

  test("truncates to last N messages and reports totalCount", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { sessionId } = await seedTestDriveSessionWithMessages(t, teacherId);

    // Pad with many extra messages to exceed the default limit.
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("messages", {
          sessionId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `msg ${i}`,
          flagged: false,
        });
      }
    });

    const ctxResult = await t.run(async (ctx) => {
      return await ctx.runQuery(
        internal.curriculumAssistant.getTestDriveContext,
        { sessionId, teacherId, limit: 30 },
      );
    });
    expect(ctxResult!.messages.length).toBe(30);
    expect(ctxResult!.totalCount).toBe(43); // 3 seeded + 40 padded
    expect(ctxResult!.truncated).toBe(true);
  });
});
