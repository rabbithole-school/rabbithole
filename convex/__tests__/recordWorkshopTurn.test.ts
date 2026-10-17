import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const VALID_HTML = "<!doctype html><html><body>App</body></html>";

async function seedFixture(
  t: ReturnType<typeof convexTest>,
  options: {
    sessionMode?: "conversation" | "vibecode" | "workbench" | null;
    isTestDrive?: boolean;
    appRequest?: string | null;
    artifactRevision?: number;
    content?: string;
  },
) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "Turn Teacher",
      username: `turn-teacher-${Math.random()}`,
      role: "teacher",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Turn unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Turn lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Turn activity",
      kind: "vibecode",
      order: 0,
      ...(options.appRequest === null
        ? {}
        : { appRequest: options.appRequest ?? "Build an app" }),
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: teacherId,
      activityId,
      title: "Turn rehearsal",
      isArchived: false,
      sessionMode: options.sessionMode ?? "vibecode",
      ...(options.isTestDrive ? { isTestDrive: true } : {}),
    });
    const messageId = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "done",
      flagged: false,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "App",
      content: options.content ?? VALID_HTML,
      lastEditedBy: "ai",
      revision: options.artifactRevision ?? 1,
      type: "code",
      language: "html",
    });
    return { teacherId, activityId, sessionId, messageId, artifactId };
  });
}

async function revisionRows(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
) {
  return await t.run(async (ctx) => {
    const all = await ctx.db.query("codeArtifactRevisions").collect();
    return all.filter((r) => r.sessionId === sessionId);
  });
}

describe("App designer G4: recordWorkshopTurn", () => {
  test("Play mode is a no-op (records nothing, resolves)", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, sessionId, messageId } = await seedFixture(t, {});

    await expect(
      t.action(internal.vibecodeStarterActions.recordWorkshopTurn, {
        sessionId,
        messageId,
        callerUserId: teacherId,
        appBuild: true,
        workshopMode: "play",
        baselineRevision: -1,
      }),
    ).resolves.toBeNull();

    expect(await revisionRows(t, sessionId)).toHaveLength(0);
  });

  test("a turn that worked on no app (appBuild false) is a no-op", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, sessionId, messageId } = await seedFixture(t, {
      sessionMode: "conversation",
    });

    await expect(
      t.action(internal.vibecodeStarterActions.recordWorkshopTurn, {
        sessionId,
        messageId,
        callerUserId: teacherId,
        appBuild: false,
        workshopMode: "edit",
        baselineRevision: -1,
      }),
    ).resolves.toBeNull();

    expect(await revisionRows(t, sessionId)).toHaveLength(0);
  });

  test("a chat session's app turn records a version too (TRA-519)", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, sessionId, messageId } = await seedFixture(t, {
      sessionMode: "conversation",
      artifactRevision: 2,
    });

    await expect(
      t.action(internal.vibecodeStarterActions.recordWorkshopTurn, {
        sessionId,
        messageId,
        callerUserId: teacherId,
        appBuild: true,
        workshopMode: "edit",
        baselineRevision: -1,
      }),
    ).resolves.toBeNull();

    expect(await revisionRows(t, sessionId)).toHaveLength(1);
  });

  test("no change (revision == baseline) records nothing", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, sessionId, messageId, artifactId } = await seedFixture(
      t,
      { isTestDrive: true, artifactRevision: 3 },
    );

    // Baseline is the SAME artifact at the SAME revision → unchanged this turn.
    await expect(
      t.action(internal.vibecodeStarterActions.recordWorkshopTurn, {
        sessionId,
        messageId,
        callerUserId: teacherId,
        appBuild: true,
        workshopMode: "edit",
        baselineArtifactId: artifactId,
        baselineRevision: 3,
      }),
    ).resolves.toBeNull();

    expect(await revisionRows(t, sessionId)).toHaveLength(0);
  });

  test("a changed turn records a revision and autosaves the build starter", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, activityId, sessionId, messageId } = await seedFixture(
      t,
      { isTestDrive: true, artifactRevision: 2, content: VALID_HTML },
    );

    await expect(
      t.action(internal.vibecodeStarterActions.recordWorkshopTurn, {
        sessionId,
        messageId,
        callerUserId: teacherId,
        appBuild: true,
        workshopMode: "edit",
        baselineRevision: -1,
      }),
    ).resolves.toBeNull();

    expect(await revisionRows(t, sessionId)).toHaveLength(1);
    // The build session's app was promoted to the activity starter.
    const activity = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(activity?.starterAppId).toBeTruthy();
    // A successful autosave leaves no failure stamp.
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.appAutosaveFailedAt ?? null).toBeNull();
  });

  test("an internal autosave failure is swallowed — never throws out, stamps failure", async () => {
    const t = convexTest(schema, modules);
    // Invalid (non-HTML) app content makes the starter promotion throw
    // INSIDE the autosave helper; recordWorkshopTurn must still resolve.
    const { teacherId, sessionId, messageId } = await seedFixture(t, {
      isTestDrive: true,
      artifactRevision: 2,
      content: "this is not html",
    });

    await expect(
      t.action(internal.vibecodeStarterActions.recordWorkshopTurn, {
        sessionId,
        messageId,
        callerUserId: teacherId,
        appBuild: true,
        workshopMode: "edit",
        baselineRevision: -1,
      }),
    ).resolves.toBeNull();

    // The turn's revision was still recorded, and the failed autosave was
    // stamped on the session rather than thrown to the stream.
    expect(await revisionRows(t, sessionId)).toHaveLength(1);
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.appAutosaveFailedAt).toEqual(expect.any(Number));
  });
});
