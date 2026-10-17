// TRA-519 one app surface: with an older app open in the builder, every turn
// acts on THAT app — never the newest — and an absent or invalid id keeps the
// old newest-app behavior (older iPads). Covers the pure pick
// (lib/focusApp.ts), the stamp on the turn placeholder (sendMessage /
// startRubricCheck / startAppUpdateTurn), and the server reads that consume
// it (getSessionContext, the version baseline and recorder).

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { pickFocusApp, pickTurnRecordApp } from "../lib/focusApp";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = TestConvex<typeof schema>;

const S = "session-a" as Id<"sessions">;
const OTHER = "session-b" as Id<"sessions">;
const app = (id: string, at: number, sessionId = S, type = "code") => ({
  _id: id as Id<"artifacts">,
  _creationTime: at,
  sessionId,
  type,
});

describe("pickFocusApp (pure)", () => {
  const older = app("older", 1);
  const newer = app("newer", 2);
  const doc = app("doc", 3, S, "text");
  const foreign = app("foreign", 4, OTHER);
  const all = [older, newer, doc, foreign];

  test("the named app wins over a newer one", () => {
    expect(pickFocusApp(all, S, "older")).toBe(older);
  });

  test("absent, stale, a document, or another session's app → the newest app", () => {
    expect(pickFocusApp(all, S, undefined)).toBe(newer);
    expect(pickFocusApp(all, S, "gone")).toBe(newer);
    expect(pickFocusApp(all, S, "doc")).toBe(newer);
    expect(pickFocusApp(all, S, "foreign")).toBe(newer);
  });

  test("no app → null", () => {
    expect(pickFocusApp([doc], S, "doc")).toBeNull();
  });

  test("the recorder versions an app created this turn, else the named one", () => {
    expect(pickTurnRecordApp(all, S, "older", 1.5)).toBe(newer);
    expect(pickTurnRecordApp(all, S, "older", 10)).toBe(older);
    expect(pickTurnRecordApp(all, S, undefined, 10)).toBe(newer);
  });
});

async function seedTwoApps(t: TestCtx) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Scholar",
      username: `scholar-${crypto.randomUUID()}`,
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Two apps",
      isArchived: false,
    });
    const olderApp = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Older app",
      content: "<html><body>old</body></html>",
      type: "code",
      lastEditedBy: "ai",
      revision: 0,
    });
    const newerApp = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Newer app",
      content: "<html><body>new</body></html>",
      type: "code",
      lastEditedBy: "ai",
      revision: 0,
    });
    const writing = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Notes",
      content: "words",
      type: "text",
      lastEditedBy: "scholar",
    });
    return { userId, sessionId, olderApp, newerApp, writing };
  });
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

async function placeholderFocus(t: TestCtx, msgId: Id<"messages">) {
  return (await t.run((ctx) => ctx.db.get(msgId)))?.focusArtifactId;
}

describe("the open app is stamped on the turn", () => {
  test("sendMessage stamps a valid app and drops an invalid one", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionId, olderApp, writing } = await seedTwoApps(t);
    const asScholar = await withUser(t, userId);

    const named = await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "make it blue",
      appArtifactId: olderApp,
    });
    expect(await placeholderFocus(t, named.assistantMsgId)).toBe(olderApp);

    // A document is not an app: dropped, so the stream falls back to newest.
    const notAnApp = await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "and bigger",
      appArtifactId: writing,
    });
    expect(await placeholderFocus(t, notAnApp.assistantMsgId)).toBeUndefined();

    // Older clients send nothing: nothing is stamped.
    const old = await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "thanks",
    });
    expect(await placeholderFocus(t, old.assistantMsgId)).toBeUndefined();
  });

  test("another session's app is never stamped", async () => {
    const t = convexTest(schema, modules);
    const a = await seedTwoApps(t);
    const b = await seedTwoApps(t);
    const asScholar = await withUser(t, a.userId);
    const res = await asScholar.mutation(api.sessions.sendMessage, {
      sessionId: a.sessionId,
      message: "hi",
      appArtifactId: b.olderApp,
    });
    expect(await placeholderFocus(t, res.assistantMsgId)).toBeUndefined();
  });

  test("startRubricCheck stamps the open app", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionId, olderApp } = await seedTwoApps(t);
    const asScholar = await withUser(t, userId);
    const res = await asScholar.mutation(api.sessions.startRubricCheck, {
      sessionId,
      appArtifactId: olderApp,
    });
    expect(await placeholderFocus(t, res.assistantMsgId)).toBe(olderApp);
  });
});

describe("the stream acts on the open app", () => {
  test("getSessionContext names the open app; without one, nothing changes", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionId, olderApp } = await seedTwoApps(t);
    const asScholar = await withUser(t, userId);
    const named = await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "make it blue",
      appArtifactId: olderApp,
    });

    const ctxNamed = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
      assistantMsgId: String(named.assistantMsgId),
    });
    expect(ctxNamed?.focusAppId).toBe(olderApp);
    expect(
      ctxNamed?.artifactData?.filter((a) => a.openInBuilder).map((a) => a.id),
    ).toEqual([olderApp]);

    const ctxPlain = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(ctxPlain?.focusAppId).toBeNull();
    expect(ctxPlain?.artifactData?.some((a) => a.openInBuilder)).toBe(false);
  });

  test("the version baseline and recorder follow the open app", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, olderApp, newerApp } = await seedTwoApps(t);

    const baseline = await t.query(
      internal.codeArtifactRevisions.newestCodeArtifactBaseline,
      { sessionId, focusArtifactId: olderApp },
    );
    expect(baseline?.artifactId).toBe(olderApp);
    const fallback = await t.query(
      internal.codeArtifactRevisions.newestCodeArtifactBaseline,
      { sessionId },
    );
    expect(fallback?.artifactId).toBe(newerApp);

    // The designer edits the OLDER app this turn.
    const messageId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Made it blue.",
        flagged: false,
      });
      await ctx.db.patch(olderApp, {
        content: "<html><body style='color:blue'>old</body></html>",
        revision: 1,
      });
      return id;
    });
    const rec = await t.mutation(
      internal.codeArtifactRevisions.recordTurnRevision,
      {
        sessionId,
        messageId,
        baselineArtifactId: olderApp,
        baselineRevision: 0,
        focusArtifactId: olderApp,
      },
    );
    expect(rec).toMatchObject({ recorded: true, artifactId: olderApp, revision: 1 });
  });

  test("an app created this turn is versioned even with an older one open", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, olderApp } = await seedTwoApps(t);
    const { messageId, brandNew } = await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Built a new one.",
        flagged: false,
      });
      const brandNew = await ctx.db.insert("artifacts", {
        sessionId,
        title: "Brand new",
        content: "<html><body>fresh</body></html>",
        type: "code",
        lastEditedBy: "ai",
        revision: 0,
      });
      return { messageId, brandNew };
    });
    const rec = await t.mutation(
      internal.codeArtifactRevisions.recordTurnRevision,
      {
        sessionId,
        messageId,
        baselineArtifactId: olderApp,
        baselineRevision: 0,
        focusArtifactId: olderApp,
      },
    );
    expect(rec).toMatchObject({ recorded: true, artifactId: brandNew });
  });
});
