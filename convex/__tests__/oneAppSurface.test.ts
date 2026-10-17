// TRA-519 one app surface — the server gates that used to key on
// sessionMode "vibecode" and now key on the app itself (L1). Prompt and
// stream gates live in sessionAppContext.test.ts.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ensureSessionActivitySetup } from "../lib/sessionActivitySetup";
import { resolveScorableArtifactId } from "../deliverables";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = TestConvex<typeof schema>;

async function seedUser(t: TestCtx, role: "scholar" | "teacher") {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: role === "scholar" ? "Hoku Makani" : "Avery Stone",
      username: `${role}-${crypto.randomUUID()}`,
      role,
    }),
  );
}

async function withUser(t: TestCtx, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

const WRITING = {
  kind: "text" as const,
  prompt: "Write about how volcanoes form.",
  mode: "none" as const,
  criteria: [],
};
const APP_DELIVERABLE = {
  kind: "artifact" as const,
  prompt: "Build your app and try it out.",
  mode: "none" as const,
  criteria: [],
};

async function seedActivity(
  t: TestCtx,
  teacherId: Id<"users">,
  fields: Partial<Doc<"activities">> & Pick<Doc<"activities">, "kind">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Activity",
      order: 0,
      systemPrompt: "Help the scholar.",
      ...fields,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedSession(
  t: TestCtx,
  userId: Id<"users">,
  fields: Partial<Doc<"sessions">> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: "Session",
      isArchived: false,
      ...fields,
    }),
  );
}

async function seedCodeArtifact(t: TestCtx, sessionId: Id<"sessions">) {
  return await t.run((ctx) =>
    ctx.db.insert("artifacts", {
      sessionId,
      title: "Volcano game",
      content: "<!doctype html><html><body>Boom</body></html>",
      lastEditedBy: "ai",
      type: "code",
      language: "html",
    }),
  );
}

async function artifactsFor(t: TestCtx, sessionId: Id<"sessions">) {
  return await t.run((ctx) =>
    ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
}

describe("ensureSessionActivitySetup", () => {
  test("an app activity (either shape) opens builder-primary with no empty seeded app", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    for (const shape of [
      { kind: "online" as const, appActivity: true, deliverable: APP_DELIVERABLE },
      { kind: "vibecode" as const },
    ]) {
      const { activityId } = await seedActivity(t, teacherId, shape);
      const sessionId = await seedSession(t, scholarId, { activityId });
      const activity = (await t.run((ctx) => ctx.db.get(activityId)))!;
      const result = await t.run((ctx) =>
        ensureSessionActivitySetup(ctx, { sessionId, activity }),
      );
      expect(result.seededArtifact).toBe(false);
      expect(await artifactsFor(t, sessionId)).toHaveLength(0);
      const session = await t.run((ctx) => ctx.db.get(sessionId));
      expect(session?.sessionMode).toBe("vibecode");
    }
  });

  test("an online activity with an app deliverable still seeds its empty app", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedActivity(t, teacherId, {
      kind: "online",
      deliverable: APP_DELIVERABLE,
    });
    const sessionId = await seedSession(t, scholarId, { activityId });
    const activity = (await t.run((ctx) => ctx.db.get(activityId)))!;
    const result = await t.run((ctx) =>
      ensureSessionActivitySetup(ctx, { sessionId, activity }),
    );
    expect(result.seededArtifact).toBe(true);
    const artifacts = await artifactsFor(t, sessionId);
    expect(artifacts.map((a) => a.type)).toEqual(["code"]);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.sessionMode).toBeUndefined();
  });
});

describe("resolveScorableArtifactId", () => {
  test("a writing activity scores the writing, not the side app built later", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedActivity(t, teacherId, {
      kind: "online",
      deliverable: WRITING,
    });
    const sessionId = await seedSession(t, scholarId, { activityId });
    const writingId = await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "Volcanoes",
        content: "Magma rises because…",
        lastEditedBy: "scholar",
        type: "text",
      }),
    );
    await seedCodeArtifact(t, sessionId);
    await expect(
      t.run((ctx) => resolveScorableArtifactId(ctx, sessionId)),
    ).resolves.toBe(writingId);
  });

  test("an app deliverable scores the app, even beside newer writing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedActivity(t, teacherId, {
      kind: "online",
      appActivity: true,
      deliverable: APP_DELIVERABLE,
    });
    const sessionId = await seedSession(t, scholarId, {
      activityId,
      sessionMode: "vibecode",
    });
    const appId = await seedCodeArtifact(t, sessionId);
    await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "Notes",
        content: "ideas",
        lastEditedBy: "scholar",
        type: "text",
      }),
    );
    await expect(
      t.run((ctx) => resolveScorableArtifactId(ctx, sessionId)),
    ).resolves.toBe(appId);
  });
});

describe("markCompleteFromTool on an app activity", () => {
  test.each([
    ["folded", { kind: "online" as const, appActivity: true, deliverable: APP_DELIVERABLE }],
    ["legacy", { kind: "vibecode" as const }],
  ])("completes a %s app activity", async (_label, shape) => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedActivity(
      t,
      teacherId,
      shape,
    );
    const sessionId = await seedSession(t, scholarId, {
      unitId,
      lessonId,
      activityId,
      sessionMode: "vibecode",
    });
    await t.run(async (ctx) => {
      for (const content of ["make a volcano game", "now add lava"]) {
        await ctx.db.insert("messages", {
          sessionId,
          role: "user",
          content,
          flagged: false,
        });
      }
    });
    const result = await t.mutation(
      internal.activityCompletions.markCompleteFromTool,
      { sessionId, summary: "Built a working volcano game." },
    );
    expect(result).toMatchObject({ ok: true, alreadyComplete: false });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("sendMessage thread stamping in a chat-primary session", () => {
  async function threadsAfterSend(
    t: TestCtx,
    args: {
      activity: (Partial<Doc<"activities">> & Pick<Doc<"activities">, "kind">) | null;
      withApp: boolean;
      mode?: "edit" | "play";
    },
  ) {
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = args.activity
      ? (await seedActivity(t, teacherId, args.activity)).activityId
      : undefined;
    const sessionId = await seedSession(t, scholarId, {
      ...(activityId ? { activityId } : {}),
    });
    if (args.withApp) await seedCodeArtifact(t, sessionId);
    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "make the lava faster",
      ...(args.mode ? { mode: args.mode } : {}),
    });
    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    return messages.map((m) => m.thread ?? null);
  }

  test("an explicit builder-view mode on an app that is the work stamps the turn", async () => {
    const t = convexTest(schema, modules);
    expect(
      await threadsAfterSend(t, { activity: null, withApp: true, mode: "edit" }),
    ).toEqual(["designer", "designer"]);
    expect(
      await threadsAfterSend(t, { activity: null, withApp: true, mode: "play" }),
    ).toEqual(["tutor", "tutor"]);
  });

  test("a chat view (no mode) stays unstamped", async () => {
    const t = convexTest(schema, modules);
    expect(
      await threadsAfterSend(t, { activity: null, withApp: true }),
    ).toEqual([null, null]);
  });

  test("a side app (writing activity) never opens a thread", async () => {
    const t = convexTest(schema, modules);
    expect(
      await threadsAfterSend(t, {
        activity: { kind: "online", deliverable: WRITING },
        withApp: true,
        mode: "edit",
      }),
    ).toEqual([null, null]);
  });

  test("no app yet → no thread, even with a mode", async () => {
    const t = convexTest(schema, modules);
    expect(
      await threadsAfterSend(t, { activity: null, withApp: false, mode: "edit" }),
    ).toEqual([null, null]);
  });
});

describe("resolveTurnModeForStream in a chat-primary session", () => {
  async function resolveFor(t: TestCtx, thread?: "designer" | "tutor") {
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholarId);
    await seedCodeArtifact(t, sessionId);
    const assistantMsgId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
        streamId: "live",
        ...(thread ? { thread } : {}),
      }),
    );
    return await t.query(internal.workshopPolicy.resolveTurnModeForStream, {
      sessionId,
      callerUserId: scholarId,
      requestedMode: "play",
      streamId: "live",
      assistantMsgId,
    });
  }

  test("an unstamped placeholder runs as an ordinary edit turn whatever the body says", async () => {
    const t = convexTest(schema, modules);
    expect(await resolveFor(t)).toMatchObject({
      effectiveEditAccess: "allowed",
      mode: "edit",
      thread: null,
      stampNeeded: false,
    });
  });

  test("a stamped placeholder is the turn's mode of record", async () => {
    const t = convexTest(schema, modules);
    expect(await resolveFor(t, "tutor")).toMatchObject({
      mode: "play",
      thread: "tutor",
      stampNeeded: false,
    });
  });
});

describe("run_app_action in a chat session", () => {
  test("the owner's app in a conversation session can queue an action", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholarId, {
      sessionMode: "conversation",
    });
    const artifactId = await seedCodeArtifact(t, sessionId);
    const owner = await withUser(t, scholarId);
    await owner.mutation(api.appStates.updateSessionState, {
      artifactId,
      actions: [{ name: "erupt", description: "Make the volcano erupt." }],
    });
    const request = await t.mutation(
      internal.appStates.requestSessionActionForTutor,
      { sessionId, artifactId, callerUserId: scholarId, name: "erupt" },
    );
    expect(request.id).toBeTruthy();
  });
});

describe("the code edit gate follows the app activity, not sessionMode", () => {
  test("a non-app chat session's app is editable; a play-only app activity's is not", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const owner = await withUser(t, scholarId);

    const chat = await seedActivity(t, teacherId, {
      kind: "online",
      deliverable: WRITING,
    });
    const chatSession = await seedSession(t, scholarId, {
      activityId: chat.activityId,
    });
    const chatApp = await seedCodeArtifact(t, chatSession);
    await expect(
      owner.mutation(api.artifacts.scholarUpdate, {
        artifactId: chatApp,
        content: "<!doctype html><html><body>Edited</body></html>",
        baseRevision: 0,
      }),
    ).resolves.toMatchObject({ ok: true });

    const playOnly = await seedActivity(t, teacherId, {
      kind: "online",
      appActivity: true,
      deliverable: APP_DELIVERABLE,
      editAccess: "never",
    });
    const appSession = await seedSession(t, scholarId, {
      activityId: playOnly.activityId,
      sessionMode: "vibecode",
    });
    const app = await seedCodeArtifact(t, appSession);
    await expect(
      owner.mutation(api.artifacts.scholarUpdate, {
        artifactId: app,
        content: "<!doctype html><html><body>Edited</body></html>",
        baseRevision: 0,
      }),
    ).rejects.toThrow(/Edit is not available/);
  });
});
