// App designer scholar edit policy (TRA-301) — the matrix for
// convex/lib/workshopPolicy.ts (pure + db halves) and the internal query
// that lets the stream re-derive the same verdict.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  effectiveEditAccessFor,
  resolveTurnMode,
  resolveWorkshopPolicy,
  scholarHasCompletedActivity,
  workshopOpeningFor,
} from "../lib/workshopPolicy";
import { editControlFor, resolveWorkshopMode } from "../../shared/workshopMode";
import { toolsForWorkshopMode } from "../sessionStreamHelpers";
import {
  grantStaffAccessToScholars,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : "Test Teacher",
      username: `${role}-${Math.random()}`,
      role,
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

async function seedVibecodeActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  editAccess?: "always" | "never" | "afterCompletion",
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
      kind: "vibecode",
      order: 0,
      ...(editAccess !== undefined ? { editAccess } : {}),
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  args: {
    userId: Id<"users">;
    activityId?: Id<"activities">;
    assignmentId?: Id<"assignments">;
    isTestDrive?: boolean;
    sessionMode?: "conversation" | "vibecode" | "workbench";
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: args.userId,
      activityId: args.activityId,
      assignmentId: args.assignmentId,
      title: "Test session",
      isArchived: false,
      sessionMode: args.sessionMode ?? "vibecode",
      ...(args.isTestDrive ? { isTestDrive: true } : {}),
    }),
  );
}

async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      scholarIds: [scholarId],
      startedAt: Date.now(),
    }),
  );
}

async function seedCompletion(
  t: ReturnType<typeof convexTest>,
  args: {
    scholarId: Id<"users">;
    activityId: Id<"activities">;
    assignmentId?: Id<"assignments">;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("activityCompletions", {
      scholarId: args.scholarId,
      activityId: args.activityId,
      assignmentId: args.assignmentId,
      completedAt: Date.now(),
    }),
  );
}

async function messagesFor(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
) {
  // `ReturnType<typeof convexTest>` erases the schema generic under the web
  // tsconfig, so filter by field rather than by the typed `by_session` index.
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .filter((q) => q.eq(q.field("sessionId"), sessionId))
      .collect(),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// effectiveEditAccessFor (pure)
// ─────────────────────────────────────────────────────────────────────────

describe("effectiveEditAccessFor", () => {
  test("a teacher-role caller is never gated, for every policy", () => {
    for (const editAccess of ["always", "never", "afterCompletion"] as const) {
      expect(
        effectiveEditAccessFor({
          editAccess,
          callerRole: "teacher",
          hasCompletion: false,
        }),
      ).toBe("allowed");
    }
  });

  test("scholar + always → allowed", () => {
    expect(
      effectiveEditAccessFor({
        editAccess: "always",
        callerRole: "scholar",
        hasCompletion: false,
      }),
    ).toBe("allowed");
  });

  test("scholar + undefined policy → allowed (the always default)", () => {
    expect(
      effectiveEditAccessFor({
        editAccess: undefined,
        callerRole: "scholar",
        hasCompletion: false,
      }),
    ).toBe("allowed");
  });

  test("scholar + never → hidden", () => {
    expect(
      effectiveEditAccessFor({
        editAccess: "never",
        callerRole: "scholar",
        hasCompletion: false,
      }),
    ).toBe("hidden");
  });

  test("scholar + afterCompletion, no completion → locked", () => {
    expect(
      effectiveEditAccessFor({
        editAccess: "afterCompletion",
        callerRole: "scholar",
        hasCompletion: false,
      }),
    ).toBe("locked");
  });

  test("scholar + afterCompletion, with completion → allowed", () => {
    expect(
      effectiveEditAccessFor({
        editAccess: "afterCompletion",
        callerRole: "scholar",
        hasCompletion: true,
      }),
    ).toBe("allowed");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveWorkshopPolicy (db)
// ─────────────────────────────────────────────────────────────────────────

describe("resolveWorkshopPolicy", () => {
  test("a completion under a DIFFERENT assignmentId than the session's does not unlock", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(
      t,
      teacherId,
      "afterCompletion",
    );
    const sessionAssignmentId = await seedAssignment(t, teacherId, scholarId);
    const otherAssignmentId = await seedAssignment(t, teacherId, scholarId);
    const sessionId = await seedSession(t, {
      userId: scholarId,
      activityId,
      assignmentId: sessionAssignmentId,
    });
    await seedCompletion(t, {
      scholarId,
      activityId,
      assignmentId: otherAssignmentId,
    });

    const session = (await t.run(async (ctx) => ctx.db.get(sessionId)))!;
    const scholar = (await t.run(async (ctx) => ctx.db.get(scholarId)))!;
    const policy = await t.run((ctx) =>
      resolveWorkshopPolicy(ctx, { session, caller: scholar }),
    );
    expect(policy.effectiveEditAccess).toBe("locked");
  });

  test("a completion under the SAME assignmentId unlocks", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(
      t,
      teacherId,
      "afterCompletion",
    );
    const assignmentId = await seedAssignment(t, teacherId, scholarId);
    const sessionId = await seedSession(t, {
      userId: scholarId,
      activityId,
      assignmentId,
    });
    await seedCompletion(t, { scholarId, activityId, assignmentId });

    const session = (await t.run(async (ctx) => ctx.db.get(sessionId)))!;
    const scholar = (await t.run(async (ctx) => ctx.db.get(scholarId)))!;
    const policy = await t.run((ctx) =>
      resolveWorkshopPolicy(ctx, { session, caller: scholar }),
    );
    expect(policy.effectiveEditAccess).toBe("allowed");
  });

  test("a session without an assignmentId accepts ANY completion of the activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(
      t,
      teacherId,
      "afterCompletion",
    );
    const someAssignmentId = await seedAssignment(t, teacherId, scholarId);
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    await seedCompletion(t, {
      scholarId,
      activityId,
      assignmentId: someAssignmentId,
    });

    const session = (await t.run(async (ctx) => ctx.db.get(sessionId)))!;
    const scholar = (await t.run(async (ctx) => ctx.db.get(scholarId)))!;
    const policy = await t.run((ctx) =>
      resolveWorkshopPolicy(ctx, { session, caller: scholar }),
    );
    expect(policy.effectiveEditAccess).toBe("allowed");

    // Cross-checked against the lower-level helper directly.
    expect(
      await t.run((ctx) =>
        scholarHasCompletedActivity(ctx, {
          scholarId,
          activityId,
          assignmentId: null,
        }),
      ),
    ).toBe(true);
  });

  test("a session without an activity → allowed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, { userId: scholarId });

    const session = (await t.run(async (ctx) => ctx.db.get(sessionId)))!;
    const scholar = (await t.run(async (ctx) => ctx.db.get(scholarId)))!;
    const policy = await t.run((ctx) =>
      resolveWorkshopPolicy(ctx, { session, caller: scholar }),
    );
    expect(policy.effectiveEditAccess).toBe("allowed");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveTurnMode (pure)
// ─────────────────────────────────────────────────────────────────────────

describe("resolveTurnMode", () => {
  test("requested edit + allowed → edit/designer", () => {
    expect(resolveTurnMode("edit", "allowed")).toEqual({
      mode: "edit",
      thread: "designer",
    });
  });

  test("requested edit + locked → play/tutor", () => {
    expect(resolveTurnMode("edit", "locked")).toEqual({
      mode: "play",
      thread: "tutor",
    });
  });

  test("requested edit + hidden → play/tutor", () => {
    expect(resolveTurnMode("edit", "hidden")).toEqual({
      mode: "play",
      thread: "tutor",
    });
  });

  test("requested play + allowed → play/tutor", () => {
    expect(resolveTurnMode("play", "allowed")).toEqual({
      mode: "play",
      thread: "tutor",
    });
  });

  test("requested undefined + hidden → play/tutor", () => {
    expect(resolveTurnMode(undefined, "hidden")).toEqual({
      mode: "play",
      thread: "tutor",
    });
  });

  test("requested undefined + allowed → edit/designer (legacy client default)", () => {
    expect(resolveTurnMode(undefined, "allowed")).toEqual({
      mode: "edit",
      thread: "designer",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// api.sessions.sendMessage — thread stamping
// ─────────────────────────────────────────────────────────────────────────

describe("api.sessions.sendMessage thread stamping", () => {
  test("a teacher's own test-drive vibecode session: mode 'edit' stamps designer on both rows", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedVibecodeActivity(t, teacherId);
    const sessionId = await seedSession(t, {
      userId: teacherId,
      activityId,
      isTestDrive: true,
    });
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "hello",
      mode: "edit",
    });

    const messages = await messagesFor(t, sessionId);
    const user = messages.find((m) => m.role === "user")!;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(user.thread).toBe("designer");
    expect(assistant.thread).toBe("designer");
  });

  test("a teacher's own test-drive vibecode session: mode 'play' stamps tutor on both rows", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedVibecodeActivity(t, teacherId);
    const sessionId = await seedSession(t, {
      userId: teacherId,
      activityId,
      isTestDrive: true,
    });
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "hello",
      mode: "play",
    });

    const messages = await messagesFor(t, sessionId);
    const user = messages.find((m) => m.role === "user")!;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(user.thread).toBe("tutor");
    expect(assistant.thread).toBe("tutor");
  });

  test("FORGED: a scholar session with editAccess 'never' sending mode 'edit' still gets tutor", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "let me in",
      mode: "edit",
    });

    const messages = await messagesFor(t, sessionId);
    const user = messages.find((m) => m.role === "user")!;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(user.thread).toBe("tutor");
    expect(assistant.thread).toBe("tutor");
  });

  test("afterCompletion: before completion, mode 'edit' → tutor; after completion, mode 'edit' → designer", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(
      t,
      teacherId,
      "afterCompletion",
    );
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "before completion",
      mode: "edit",
    });
    let messages = await messagesFor(t, sessionId);
    let user = messages.filter((m) => m.role === "user").at(-1)!;
    let assistant = messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(user.thread).toBe("tutor");
    expect(assistant.thread).toBe("tutor");

    await seedCompletion(t, { scholarId, activityId });

    await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "after completion",
      mode: "edit",
    });
    messages = await messagesFor(t, sessionId);
    user = messages.filter((m) => m.role === "user").at(-1)!;
    assistant = messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(user.thread).toBe("designer");
    expect(assistant.thread).toBe("designer");
  });

  test("mode omitted on a scholar 'never' session → tutor", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "no mode given",
    });

    const messages = await messagesFor(t, sessionId);
    const user = messages.find((m) => m.role === "user")!;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(user.thread).toBe("tutor");
    expect(assistant.thread).toBe("tutor");
  });

  test("mode omitted on an 'always' session → designer", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "no mode given",
    });

    const messages = await messagesFor(t, sessionId);
    const user = messages.find((m) => m.role === "user")!;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(user.thread).toBe("designer");
    expect(assistant.thread).toBe("designer");
  });

  test("a non-vibecode session never gets a thread field", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, {
      userId: scholarId,
      sessionMode: "conversation",
    });
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "just chatting",
      mode: "edit",
    });

    const messages = await messagesFor(t, sessionId);
    const user = messages.find((m) => m.role === "user")!;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(user.thread).toBeUndefined();
    expect(assistant.thread).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// api.sessions.getWithMessages — editAccess / effectiveEditAccess
// ─────────────────────────────────────────────────────────────────────────

describe("api.sessions.getWithMessages editAccess surfacing", () => {
  test("scholar on a 'never' activity: hidden", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(result.session.editAccess).toBe("never");
    expect(result.session.effectiveEditAccess).toBe("hidden");
  });

  test("scholar on an 'afterCompletion' activity: locked, then allowed once completed", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(
      t,
      teacherId,
      "afterCompletion",
    );
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);

    const before = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(before.session.editAccess).toBe("afterCompletion");
    expect(before.session.effectiveEditAccess).toBe("locked");

    await seedCompletion(t, { scholarId, activityId });

    const after = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(after.session.effectiveEditAccess).toBe("allowed");
  });

  test("a teacher viewing the same 'never' session: allowed", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      slug: "workshop-policy-fixture-school",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
    });
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherId,
      scholarIds: [scholarId],
      institutionId,
    });
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asTeacher = await withUser(t, teacherId);

    const result = await asTeacher.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(result.session.editAccess).toBe("never");
    expect(result.session.effectiveEditAccess).toBe("allowed");
  });

  test("messages carry their stamped thread", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedVibecodeActivity(t, teacherId);
    const sessionId = await seedSession(t, {
      userId: teacherId,
      activityId,
      isTestDrive: true,
    });
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "hi",
      mode: "edit",
    });

    const result = await asTeacher.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    const userMsg = result.messages.find((m) => m.role === "user")!;
    expect(userMsg.thread).toBe("designer");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// internal.workshopPolicy.resolveTurnModeForStream
// ─────────────────────────────────────────────────────────────────────────

describe("internal.workshopPolicy.resolveTurnModeForStream", () => {
  test("FORGED: scholar caller, 'never' policy, requestedMode 'edit' → play/tutor/hidden, and code tools are dropped", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    // An UNSTAMPED placeholder (an older client path): the stream derives.
    const assistantMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "s1",
      }),
    );

    const result = await t.run((ctx) =>
      ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
        sessionId,
        callerUserId: scholarId,
        requestedMode: "edit",
        streamId: "s1",
        assistantMsgId,
      }),
    );

    expect(result).toEqual({
      mode: "play",
      thread: "tutor",
      effectiveEditAccess: "hidden",
      stampNeeded: true,
      // An ordinary turn: no server trigger, no app asks.
      streamTrigger: null,
      appUpdateAskCount: 0,
    });

    const tools = [
      { name: "create_code" },
      { name: "edit_document" },
      { name: "other" },
    ];
    const filtered = toolsForWorkshopMode(tools, result.mode).map(
      (tool) => tool.name,
    );
    expect(filtered).toEqual(["other"]);
  });

  test("REJECT: a placeholder from ANOTHER session is refused (no stamp replay)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const otherSessionId = await seedSession(t, {
      userId: scholarId,
      activityId,
    });
    // A designer-stamped placeholder belonging to a DIFFERENT session, offered
    // under this session's live stream.
    const foreignMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId: otherSessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "live",
        thread: "designer",
      }),
    );

    await expect(
      t.run((ctx) =>
        ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
          sessionId,
          callerUserId: scholarId,
          requestedMode: "edit",
          streamId: "live",
          assistantMsgId: foreignMsgId,
        }),
      ),
    ).rejects.toThrow(/placeholder/i);
  });

  test("REJECT: a placeholder whose streamId is not the live stream is refused", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const staleMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "old-stream",
        thread: "designer",
      }),
    );

    await expect(
      t.run((ctx) =>
        ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
          sessionId,
          callerUserId: scholarId,
          requestedMode: "edit",
          streamId: "live-stream",
          assistantMsgId: staleMsgId,
        }),
      ),
    ).rejects.toThrow(/placeholder/i);
  });

  test("REJECT (ordinary session): a placeholder from ANOTHER session is refused", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, {
      userId: scholarId,
      sessionMode: "conversation",
    });
    const otherSessionId = await seedSession(t, {
      userId: scholarId,
      sessionMode: "conversation",
    });
    // A placeholder that belongs to a DIFFERENT ordinary session, offered under
    // this session's live stream. Even though a conversation session has no Play
    // to clamp, the stream would still patch/delete/finalize this row — so the
    // binding must reject it before any write.
    const foreignMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId: otherSessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "live",
      }),
    );

    await expect(
      t.run((ctx) =>
        ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
          sessionId,
          callerUserId: scholarId,
          requestedMode: "edit",
          streamId: "live",
          assistantMsgId: foreignMsgId,
        }),
      ),
    ).rejects.toThrow(/placeholder/i);
  });

  test("REJECT (ordinary session): a placeholder with a stale streamId is refused", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, {
      userId: scholarId,
      sessionMode: "conversation",
    });
    const staleMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "old-stream",
      }),
    );

    await expect(
      t.run((ctx) =>
        ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
          sessionId,
          callerUserId: scholarId,
          requestedMode: "edit",
          streamId: "live-stream",
          assistantMsgId: staleMsgId,
        }),
      ),
    ).rejects.toThrow(/placeholder/i);
  });

  test("PASS (ordinary session): the live placeholder resolves to an Edit turn", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, {
      userId: scholarId,
      sessionMode: "conversation",
    });
    const assistantMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "live",
      }),
    );

    const result = await t.run((ctx) =>
      ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
        sessionId,
        callerUserId: scholarId,
        requestedMode: "edit",
        streamId: "live",
        assistantMsgId,
      }),
    );
    expect(result).toEqual({
      effectiveEditAccess: "allowed",
      mode: "edit",
      thread: null,
      stampNeeded: false,
      streamTrigger: null,
      appUpdateAskCount: 0,
    });
  });

  test("BYPASS BLOCKED end-to-end: an old designer stamp under 'never' runs Play — code tools dropped, no revision", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    // An assistant placeholder stamped `designer` from an earlier stream (when
    // Edit was still allowed), replayed under the SAME streamId while the
    // activity is now `never`. Binding passes; the stamp must NOT buy Edit.
    const artifactId = await t.run(async (ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "App",
        content: "<!doctype html><html><body>App</body></html>",
        lastEditedBy: "ai",
        revision: 1,
        type: "code",
        language: "html",
      }),
    );
    const assistantMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "replayed",
        thread: "designer",
      }),
    );

    // 1. The stream resolver clamps the stamped Edit to Play under `never`.
    const result = await t.run((ctx) =>
      ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
        sessionId,
        callerUserId: scholarId,
        requestedMode: "edit",
        streamId: "replayed",
        assistantMsgId,
      }),
    );
    expect(result.effectiveEditAccess).toBe("hidden");
    expect(result.mode).toBe("play");
    expect(result.thread).toBe("tutor");
    // The stored designer stamp is corrected to the thread it actually ran in.
    expect(result.stampNeeded).toBe(true);

    // 2. The Play tool set drops the code tools.
    const filtered = toolsForWorkshopMode(
      [{ name: "create_code" }, { name: "edit_document" }, { name: "other" }],
      result.mode,
    ).map((tool) => tool.name);
    expect(filtered).toEqual(["other"]);

    // 3. The revision recorder is a no-op in Play — no version is written.
    await expect(
      t.action(internal.vibecodeStarterActions.recordWorkshopTurn, {
        sessionId,
        messageId: assistantMsgId,
        callerUserId: scholarId,
        sessionMode: "vibecode",
        workshopMode: result.mode,
        baselineArtifactId: artifactId,
        baselineRevision: -1,
      }),
    ).resolves.toBeNull();
    const revisions = await t.run(async (ctx) =>
      (await ctx.db.query("codeArtifactRevisions").collect()).filter(
        (r) => r.sessionId === sessionId,
      ),
    );
    expect(revisions).toHaveLength(0);
  });

  // "No revision is recorded in Play" is already covered end-to-end by
  // convex/__tests__/recordWorkshopTurn.test.ts ("Play mode is a no-op
  // (records nothing, resolves)") — not duplicated here.
});

// ─────────────────────────────────────────────────────────────────────────
// internal.sessions.stampTurnThread
// ─────────────────────────────────────────────────────────────────────────

describe("internal.sessions.stampTurnThread", () => {
  test("patches an unstamped assistant placeholder", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const sessionId = await seedSession(t, { userId: teacherId });
    const messageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "s1",
      }),
    );

    await t.run((ctx) =>
      ctx.runMutation(internal.sessions.stampTurnThread, {
        sessionId,
        streamId: "s1",
        assistantMsgId: messageId,
        thread: "designer",
      }),
    );

    const message = await t.run((ctx) => ctx.db.get(messageId));
    expect(message?.thread).toBe("designer");
  });

  test("is a no-op when already equal", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const sessionId = await seedSession(t, { userId: teacherId });
    const messageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        thread: "tutor",
        streamId: "s1",
      }),
    );

    // Should not throw and should leave the row exactly as-is.
    await t.run((ctx) =>
      ctx.runMutation(internal.sessions.stampTurnThread, {
        sessionId,
        streamId: "s1",
        assistantMsgId: messageId,
        thread: "tutor",
      }),
    );

    const message = await t.run((ctx) => ctx.db.get(messageId));
    expect(message?.thread).toBe("tutor");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// internal.sessionHelpers.splitStream — thread propagation
// ─────────────────────────────────────────────────────────────────────────

describe("internal.sessionHelpers.splitStream thread propagation", () => {
  test("the tool row and the new assistant placeholder both carry the current thread", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const sessionId = await seedSession(t, { userId: teacherId });
    const currentMessageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        thread: "tutor",
      }),
    );

    const newMessageId = await t.run((ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId,
        sessionId,
        contentSoFar: "some text before the tool call",
        toolAction: "some_tool",
      }),
    );

    const messages = await messagesFor(t, sessionId);
    const toolRow = messages.find((m) => m.role === "tool")!;
    const newPlaceholder = messages.find((m) => m._id === newMessageId)!;
    expect(toolRow.thread).toBe("tutor");
    expect(newPlaceholder.thread).toBe("tutor");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// api.activities editAccess persistence
// ─────────────────────────────────────────────────────────────────────────

describe("api.activities editAccess persistence", () => {
  test("update persists editAccess, and get returns it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.activities.update, {
      id: activityId,
      editAccess: "afterCompletion",
    });

    const activity = await asTeacher.query(api.activities.get, {
      id: activityId,
    });
    expect(activity?.editAccess).toBe("afterCompletion");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// api.artifacts.scholarUpdate — the direct html write honors the same verdict
// ─────────────────────────────────────────────────────────────────────────

describe("api.artifacts.scholarUpdate edit gate", () => {
  async function seedCodeArtifact(
    t: ReturnType<typeof convexTest>,
    sessionId: Id<"sessions">,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        type: "code",
        title: "App",
        content: "<!doctype html><html><body>v0</body></html>",
        revision: 0,
        lastEditedBy: "ai",
      }),
    );
  }

  test("a scholar under 'never' cannot write the code app's html (no revision)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const artifactId = await seedCodeArtifact(t, sessionId);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.artifacts.scholarUpdate, {
        artifactId,
        content: "<!doctype html><html><body>forged</body></html>",
        baseRevision: 0,
      }),
    ).rejects.toThrow(/Edit is not available/);

    const after = await t.run(async (ctx) => ({
      artifact: await ctx.db.get(artifactId),
      revisions: await ctx.db
        .query("codeArtifactRevisions")
        .filter((q) => q.eq(q.field("sessionId"), sessionId))
        .collect(),
    }));
    expect(after.artifact?.content).toContain("v0");
    expect(after.revisions).toHaveLength(0);
  });

  test("a scholar under 'always' can write it; a teacher is never gated", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const artifactId = await seedCodeArtifact(t, sessionId);
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.mutation(api.artifacts.scholarUpdate, {
      artifactId,
      content: "<!doctype html><html><body>v1</body></html>",
      baseRevision: 0,
    });
    expect(result.ok).toBe(true);

    // A teacher's own build session under `never` is still allowed Edit.
    const { activityId: lockedActivityId } = await seedVibecodeActivity(
      t,
      teacherId,
      "never",
    );
    const buildSessionId = await seedSession(t, {
      userId: teacherId,
      activityId: lockedActivityId,
      isTestDrive: true,
    });
    const buildArtifactId = await seedCodeArtifact(t, buildSessionId);
    const asTeacher = await withUser(t, teacherId);
    const teacherResult = await asTeacher.mutation(
      api.artifacts.scholarUpdate,
      {
        artifactId: buildArtifactId,
        content: "<!doctype html><html><body>v1</body></html>",
        baseRevision: 0,
      },
    );
    expect(teacherResult.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Review follow-ups: bare completion rows, session-checked stamps, the other
// placeholder paths, and the mutation's returned mode
// ─────────────────────────────────────────────────────────────────────────

describe("review follow-ups", () => {
  test("a truly BARE completion row (no assignmentId, no session) does NOT unlock a session that has one", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(
      t,
      teacherId,
      "afterCompletion",
    );
    const assignmentId = await seedAssignment(t, teacherId, scholarId);
    const sessionId = await seedSession(t, {
      userId: scholarId,
      activityId,
      assignmentId,
    });
    // A bare self-mark (no assignment scope) must not buy Edit in an
    // assignment-scoped run.
    await seedCompletion(t, { scholarId, activityId });
    const asScholar = await withUser(t, scholarId);
    const data = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(data.session.effectiveEditAccess).toBe("locked");
  });

  test("a completion in assignment A does not unlock the same activity's session in assignment B", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(
      t,
      teacherId,
      "afterCompletion",
    );
    const assignmentA = await seedAssignment(t, teacherId, scholarId);
    const assignmentB = await seedAssignment(t, teacherId, scholarId);
    // The scholar completed the activity within assignment A (session-scoped).
    const sessionInA = await seedSession(t, {
      userId: scholarId,
      activityId,
      assignmentId: assignmentA,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        sessionId: sessionInA,
        completedAt: Date.now(),
      }),
    );
    // A DIFFERENT run of the same activity (assignment B) stays locked.
    const sessionInB = await seedSession(t, {
      userId: scholarId,
      activityId,
      assignmentId: assignmentB,
    });
    expect(
      await t.run((ctx) =>
        scholarHasCompletedActivity(ctx, {
          scholarId,
          activityId,
          assignmentId: assignmentB,
        }),
      ),
    ).toBe(false);
    // The session that IS in assignment A unlocks from that session-scoped row.
    expect(
      await t.run((ctx) =>
        scholarHasCompletedActivity(ctx, {
          scholarId,
          activityId,
          assignmentId: assignmentA,
        }),
      ),
    ).toBe(true);

    const asScholar = await withUser(t, scholarId);
    const dataB = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionInB,
    });
    expect(dataB.session.effectiveEditAccess).toBe("locked");
    const dataA = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionInA,
    });
    expect(dataA.session.effectiveEditAccess).toBe("allowed");
  });

  test("sendMessage returns the effective mode so a clamped client snaps before the stream", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "hi",
      mode: "edit",
    });
    expect(result.workshopMode).toBe("play");
  });

  test("stampTurnThread ignores a message outside the given session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const sessionA = await seedSession(t, { userId: scholarId, activityId });
    const sessionB = await seedSession(t, { userId: scholarId, activityId });
    const foreignMsg = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId: sessionB,
        role: "assistant",
        content: "",
        flagged: false,
        thread: "designer",
      }),
    );
    await t.mutation(internal.sessions.stampTurnThread, {
      sessionId: sessionA,
      streamId: "s1",
      assistantMsgId: foreignMsg,
      thread: "tutor",
    });
    const after = await t.run(async (ctx) => ctx.db.get(foreignMsg));
    expect(after?.thread).toBe("designer");
  });

  test("a scholar's kickoff under 'never' lands in the tutor thread", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.mutation(api.sessions.startActivityKickoff, {
      sessionId,
    });
    expect(result?.status).toBe("started");
    const messages = await messagesFor(t, sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0].thread).toBe("tutor");
  });

  test("a retried turn follows the thread of the scholar turn it answers", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    // A finished Play turn whose reply never arrived: only the user row.
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "why did it bounce?",
        flagged: false,
        thread: "tutor",
      }),
    );
    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).not.toBeNull();
    const messages = await messagesFor(t, sessionId);
    const placeholder = messages.find((m) => m.role === "assistant")!;
    expect(placeholder.thread).toBe("tutor");
  });

  test("retry restamps the retried question to the placeholder's thread when the verdict changed", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    // A designer question whose reply never arrived (Edit was allowed then).
    const userMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "make it blue",
        flagged: false,
        thread: "designer",
      }),
    );
    // The teacher hides Edit before the scholar retries.
    await t.run(async (ctx) =>
      ctx.db.patch(activityId, { editAccess: "never" }),
    );
    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).not.toBeNull();
    const messages = await messagesFor(t, sessionId);
    const placeholder = messages.find((m) => m.role === "assistant")!;
    // The clamped placeholder AND the question it answers are both `tutor`:
    // the turn is not split across threads.
    expect(placeholder.thread).toBe("tutor");
    const question = messages.find((m) => m._id === userMsgId)!;
    expect(question.thread).toBe("tutor");
  });
});

describe("Copilot review follow-ups", () => {
  test("the stored stamp NEVER widens access: an Edit stamp under a now-'never' verdict runs Play", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "always");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);
    const sent = await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "make it blue",
      mode: "edit",
    });
    // The teacher flips the policy between the mutation and the stream.
    await t.run(async (ctx) =>
      ctx.db.patch(activityId, { editAccess: "never" }),
    );
    const result = await t.run((ctx) =>
      ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
        sessionId,
        callerUserId: scholarId,
        requestedMode: "edit",
        streamId: sent.streamId,
        assistantMsgId: sent.assistantMsgId,
      }),
    );
    // The turn was stamped `designer`, but Edit is no longer allowed: the
    // effective mode is min(stamp, verdict) = Play, and the assistant row is
    // re-stamped to the tutor thread it actually ran in.
    expect(result.mode).toBe("play");
    expect(result.thread).toBe("tutor");
    expect(result.stampNeeded).toBe(true);
    expect(result.effectiveEditAccess).toBe("hidden");
  });

  test("a non-vibecode session always runs as Edit and stamps nothing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, {
      userId: scholarId,
      activityId,
      sessionMode: "conversation",
    });
    const assistantMsgId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "s1",
      }),
    );
    const result = await t.run((ctx) =>
      ctx.runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
        sessionId,
        callerUserId: scholarId,
        requestedMode: "play",
        streamId: "s1",
        assistantMsgId,
      }),
    );
    expect(result).toEqual({
      effectiveEditAccess: "allowed",
      mode: "edit",
      thread: null,
      stampNeeded: false,
      streamTrigger: null,
      appUpdateAskCount: 0,
    });
  });

  test("an activity that is no longer vibecode does not gate, even with editAccess left behind", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    await t.run(async (ctx) => ctx.db.patch(activityId, { kind: "online" }));
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    const asScholar = await withUser(t, scholarId);
    const data = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(data.session.effectiveEditAccess).toBe("allowed");
  });

  test("stampTurnThread ignores a user row and a stale stream's placeholder", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const sessionId = await seedSession(t, { userId: teacherId });
    const { userRow, staleRow } = await t.run(async (ctx) => ({
      userRow: await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "hi",
        flagged: false,
      }),
      staleRow: await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "old",
      }),
    }));
    for (const assistantMsgId of [userRow, staleRow]) {
      await t.mutation(internal.sessions.stampTurnThread, {
        sessionId,
        streamId: "s1",
        assistantMsgId,
        thread: "tutor",
      });
    }
    const rows = await t.run(async (ctx) => ({
      user: await ctx.db.get(userRow),
      stale: await ctx.db.get(staleRow),
    }));
    expect(rows.user?.thread).toBeUndefined();
    expect(rows.stale?.thread).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// workshopOpeningFor (TRA-477): a teacher rehearsing a Play-only app opens
// where the scholar does — in Play — with Edit kept as a teacher affordance.
// ─────────────────────────────────────────────────────────────────────────

describe("workshopOpeningFor", () => {
  const rehearsal = {
    isTestDrive: true,
    callerRole: "teacher",
    openedOnStarter: true,
    hasAppRequest: false,
  } as const;

  test("teacher rehearsal of a starter + never app: Play, Edit is a teacher override", () => {
    expect(workshopOpeningFor({ ...rehearsal, editAccess: "never" })).toEqual({
      defaultMode: "play",
      teacherBuildKickoff: false,
      teacherEditOverride: true,
    });
  });

  test("teacher rehearsal of a starter + afterCompletion app: Play", () => {
    expect(
      workshopOpeningFor({ ...rehearsal, editAccess: "afterCompletion" })
        .defaultMode,
    ).toBe("play");
  });

  test("a starter + never app with a hand-off brief is a rehearsal, not a build", () => {
    expect(
      workshopOpeningFor({
        ...rehearsal,
        editAccess: "never",
        hasAppRequest: true,
      }),
    ).toMatchObject({ defaultMode: "play", teacherBuildKickoff: false });
  });

  test("no starter yet (the teacher is building it): Edit, build hand-off unchanged", () => {
    expect(
      workshopOpeningFor({
        ...rehearsal,
        editAccess: "never",
        openedOnStarter: false,
        hasAppRequest: true,
      }),
    ).toEqual({
      defaultMode: "edit",
      teacherBuildKickoff: true,
      teacherEditOverride: true,
    });
    expect(
      workshopOpeningFor({
        ...rehearsal,
        editAccess: "never",
        openedOnStarter: false,
      }).defaultMode,
    ).toBe("edit");
  });

  test("an 'always' starter app keeps today's Edit default and plain Edit", () => {
    expect(workshopOpeningFor({ ...rehearsal, editAccess: "always" })).toEqual({
      defaultMode: "edit",
      teacherBuildKickoff: false,
      teacherEditOverride: false,
    });
  });

  test("a scholar on a never app: no teacher override (their control is hidden)", () => {
    expect(
      workshopOpeningFor({
        isTestDrive: false,
        callerRole: "scholar",
        editAccess: "never",
        openedOnStarter: true,
        hasAppRequest: false,
      }),
    ).toEqual({
      defaultMode: "edit",
      teacherBuildKickoff: false,
      teacherEditOverride: false,
    });
  });
});

describe("api.sessions.getWithMessages workshop opening (TRA-477)", () => {
  async function seedRehearsal(
    t: ReturnType<typeof convexTest>,
    editAccess: "always" | "never" | "afterCompletion",
    openedOnStarter: boolean,
  ) {
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedVibecodeActivity(t, teacherId, editAccess);
    const sessionId = await seedSession(t, {
      userId: teacherId,
      activityId,
      isTestDrive: true,
    });
    if (openedOnStarter) {
      await t.run(async (ctx) =>
        ctx.db.patch(sessionId, { vibecodeStarterUsedAt: Date.now() }),
      );
    }
    const asTeacher = await withUser(t, teacherId);
    return (
      await asTeacher.query(api.sessions.getWithMessages, { id: sessionId })
    ).session;
  }

  test("starter + never: opens in Play with the Edit | Play control shown", async () => {
    const t = convexTest(schema, modules);
    const session = await seedRehearsal(t, "never", true);
    expect(session.defaultWorkshopMode).toBe("play");
    expect(session.effectiveEditAccess).toBe("allowed");
    expect(editControlFor(session.effectiveEditAccess).showControl).toBe(true);
    expect(session.teacherEditOverride).toBe(true);
  });

  test("afterCompletion starter rehearsal: opens in Play", async () => {
    const t = convexTest(schema, modules);
    const session = await seedRehearsal(t, "afterCompletion", true);
    expect(session.defaultWorkshopMode).toBe("play");
  });

  test("no starter (teacher building it): opens in Edit", async () => {
    const t = convexTest(schema, modules);
    const session = await seedRehearsal(t, "never", false);
    expect(session.defaultWorkshopMode).toBe("edit");
  });

  test("scholar on a never app: Play only, no control (unchanged)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedVibecodeActivity(t, teacherId, "never");
    const sessionId = await seedSession(t, { userId: scholarId, activityId });
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, { vibecodeStarterUsedAt: Date.now() }),
    );
    const asScholar = await withUser(t, scholarId);
    const { session } = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(session.effectiveEditAccess).toBe("hidden");
    expect(editControlFor(session.effectiveEditAccess).showControl).toBe(false);
    expect(
      resolveWorkshopMode({
        param: null,
        fallback: session.defaultWorkshopMode,
        editSelectable: false,
      }),
    ).toBe("play");
    expect(session.teacherEditOverride).toBe(false);
  });
});
