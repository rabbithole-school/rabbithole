import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function makeArtifact(
  t: ReturnType<typeof convexTest>,
  options: {
    content: string;
    revision?: number;
    type?: "map" | "slides";
  },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Artifact Scholar",
      username: `artifact-${Math.random()}`,
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Artifact Session",
      isArchived: false,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Notes",
      content: options.content,
      lastEditedBy: "scholar",
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      ...(options.type ? { type: options.type } : {}),
    });
    return { userId, sessionId, artifactId };
  });
}

describe("artifact session membership", () => {
  test("AI edit and read refuse an artifact from another session", async () => {
    const t = convexTest(schema, modules);
    const { firstSessionId, secondArtifactId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Avery Stone", username: "avery-artifact-test", role: "scholar",
      });
      const firstSessionId = await ctx.db.insert("sessions", {
        userId, title: "First Session", isArchived: false,
      });
      const secondSessionId = await ctx.db.insert("sessions", {
        userId, title: "Second Session", isArchived: false,
      });
      const secondArtifactId = await ctx.db.insert("artifacts", {
        sessionId: secondSessionId,
        title: "Second Session Notes",
        content: "original text",
        lastEditedBy: "scholar",
      });
      return { firstSessionId, secondArtifactId };
    });

    await expect(t.mutation(internal.artifacts.aiStrReplace, {
      sessionId: firstSessionId, artifactId: secondArtifactId,
      oldStr: "original", newStr: "changed",
    })).rejects.toThrow("Artifact does not belong to session");
    await expect(t.query(internal.artifacts.aiGetContent, {
      sessionId: firstSessionId, artifactId: secondArtifactId,
    })).rejects.toThrow("Artifact does not belong to session");
  });
});

describe("text artifact revisions", () => {
  test("scholarUpdate returns the public CAS contract", async () => {
    const t = convexTest(schema, modules);
    const { userId, artifactId } = await makeArtifact(t, {
      content: "first draft", revision: 0,
    });
    const asScholar = t.withIdentity({ subject: userId });

    expect(await asScholar.mutation(api.artifacts.scholarUpdate, {
      artifactId, content: "final draft", baseRevision: 0,
    })).toEqual({ ok: true, revision: 1 });
    expect(await asScholar.mutation(api.artifacts.scholarUpdate, {
      artifactId, content: "stale draft", baseRevision: 0,
    })).toEqual({
      ok: false,
      conflict: true,
      artifact: {
        _id: artifactId,
        title: "Notes",
        content: "final draft",
        revision: 1,
        lastEditedBy: "scholar",
      },
    });
  });

  test("CAS edits increment once and preserve stale content", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeArtifact(t, {
      content: "first draft", revision: 0,
    });
    const success = await t.mutation(internal.artifacts.aiStrReplace, {
      sessionId, artifactId, oldStr: "first", newStr: "final", baseRevision: 0,
    });
    expect(success).toMatchObject({
      kind: "success", artifact: { content: "final draft", revision: 1 },
    });
    const stale = await t.mutation(internal.artifacts.aiStrReplace, {
      sessionId, artifactId, oldStr: "final", newStr: "stale", baseRevision: 0,
    });
    expect(stale).toMatchObject({
      kind: "conflict", artifact: { content: "final draft", revision: 1 },
    });
  });

  test("an omitted revision stamps a legacy row once", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeArtifact(t, { content: "old" });
    expect(await t.mutation(internal.artifacts.aiRename, {
      sessionId, artifactId, title: "Stamped",
    })).toMatchObject({
      kind: "success", artifact: { revision: 1, title: "Stamped" },
    });
    expect(await t.mutation(internal.artifacts.aiRename, {
      sessionId, artifactId, title: "Must conflict",
    })).toMatchObject({ kind: "conflict" });
  });

  test("structured artifacts are excluded and replacement needs one match", async () => {
    const t = convexTest(schema, modules);
    const { userId, sessionId, artifactId: mapId } = await makeArtifact(t, {
      content: "{}", type: "map",
    });
    const slidesId = await t.run(async (ctx) => ctx.db.insert("artifacts", {
      sessionId,
      title: "Slides",
      content: "{}",
      lastEditedBy: "ai",
      revision: 0,
      type: "slides",
    }));
    const textId = await t.run(async (ctx) => ctx.db.insert("artifacts", {
      sessionId, title: "Text", content: "same same", lastEditedBy: "ai", revision: 0,
    }));
    const listed = await t.query(internal.artifacts.aiGetContent, { sessionId });
    expect(Array.isArray(listed) && listed.map((a) => a._id)).toEqual([textId]);
    expect(await t.mutation(internal.artifacts.aiInsert, {
      sessionId, artifactId: mapId, insertLine: 0, insertText: "no", baseRevision: 0,
    })).toMatchObject({ kind: "refused" });
    expect(await t.mutation(internal.artifacts.aiInsert, {
      sessionId, artifactId: slidesId, insertLine: 0, insertText: "no", baseRevision: 0,
    })).toMatchObject({ kind: "refused" });
    expect(await t.mutation(internal.artifacts.aiStrReplace, {
      sessionId, artifactId: textId, oldStr: "same", newStr: "different", baseRevision: 0,
    })).toMatchObject({ kind: "refused" });
    await expect(
      t.withIdentity({ subject: userId }).mutation(api.artifacts.scholarUpdate, {
        artifactId: mapId, content: "not a map", baseRevision: 0,
      }),
    ).rejects.toThrow("Structured artifacts must be edited with their own tool.");
    await expect(
      t.withIdentity({ subject: userId }).mutation(api.artifacts.scholarUpdate, {
        artifactId: slidesId, content: "not slides", baseRevision: 0,
      }),
    ).rejects.toThrow("Structured artifacts must be edited with their own tool.");
    expect(await t.run(async (ctx) => ctx.db.get(textId))).toMatchObject({
      content: "same same",
    });
  });
});

describe("App designer G3: scholarUpdate autosaves to the activity starter", () => {
  async function seedBuildFixture(
    t: ReturnType<typeof convexTest>,
    options: { isTestDrive: boolean; ownerRole: "teacher" | "scholar"; appRequest?: string | null },
  ) {
    return await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Build Teacher",
        username: `build-teacher-${Math.random()}`,
        role: "teacher",
      });
      const ownerId =
        options.ownerRole === "teacher"
          ? teacherId
          : await ctx.db.insert("users", {
              name: "Build Scholar",
              username: `build-scholar-${Math.random()}`,
              role: "scholar",
            });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Build unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Build lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Build activity",
        kind: "vibecode",
        order: 0,
        ...(options.appRequest === null
          ? {}
          : { appRequest: options.appRequest ?? "Build a counter app" }),
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: ownerId,
        activityId,
        title: "Build rehearsal",
        isArchived: false,
        ...(options.isTestDrive ? { isTestDrive: true } : {}),
      });
      const artifactId = await ctx.db.insert("artifacts", {
        sessionId,
        title: "Counter app",
        content: "<!doctype html><html><body>v1</body></html>",
        lastEditedBy: "ai",
        revision: 0,
        type: "code",
        language: "html",
      });
      return { teacherId, ownerId, activityId, sessionId, artifactId };
    });
  }

  async function scheduledAutosaves(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
        f.name.includes("autosaveStarterFromArtifact"),
      ),
    );
  }

  test("a teacher's manual edit on a build session schedules the promotion", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, activityId, artifactId } = await seedBuildFixture(t, {
      isTestDrive: true,
      ownerRole: "teacher",
    });
    const asTeacher = t.withIdentity({ subject: teacherId });

    expect(
      await asTeacher.mutation(api.artifacts.scholarUpdate, {
        artifactId,
        content: "<!doctype html><html><body>v2</body></html>",
        baseRevision: 0,
      }),
    ).toEqual({ ok: true, revision: 1 });

    const scheduled = await scheduledAutosaves(t);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args[0]).toMatchObject({
      sessionId: expect.any(String),
      callerUserId: teacherId,
      activityId,
      artifactId,
    });
  });

  test("a Restore (restoredFromRevision) on a build session also schedules the promotion", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, artifactId } = await seedBuildFixture(t, {
      isTestDrive: true,
      ownerRole: "teacher",
    });
    const asTeacher = t.withIdentity({ subject: teacherId });

    await asTeacher.mutation(api.artifacts.scholarUpdate, {
      artifactId,
      content: "<!doctype html><html><body>restored</body></html>",
      baseRevision: 0,
      restoredFromRevision: 1,
    });

    expect(await scheduledAutosaves(t)).toHaveLength(1);
  });

  test("a scholar session does NOT schedule the promotion", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, artifactId } = await seedBuildFixture(t, {
      isTestDrive: false,
      ownerRole: "scholar",
    });
    const asScholar = t.withIdentity({ subject: ownerId });

    expect(
      await asScholar.mutation(api.artifacts.scholarUpdate, {
        artifactId,
        content: "<!doctype html><html><body>edited</body></html>",
        baseRevision: 0,
      }),
    ).toEqual({ ok: true, revision: 1 });

    expect(await scheduledAutosaves(t)).toHaveLength(0);
  });

  test("a build session whose activity has no appRequest does NOT schedule", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, artifactId } = await seedBuildFixture(t, {
      isTestDrive: true,
      ownerRole: "teacher",
      appRequest: null,
    });
    const asTeacher = t.withIdentity({ subject: teacherId });

    await asTeacher.mutation(api.artifacts.scholarUpdate, {
      artifactId,
      content: "<!doctype html><html><body>v2</body></html>",
      baseRevision: 0,
    });

    expect(await scheduledAutosaves(t)).toHaveLength(0);
  });
});

describe("App designer P3: deleteArtifact is gated by the workshop verdict", () => {
  async function seedDeleteFixture(
    t: ReturnType<typeof convexTest>,
    editAccess: "always" | "never" | "afterCompletion",
    ownerRole: "scholar" | "teacher" = "scholar",
  ) {
    return await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Del Teacher",
        username: `del-teacher-${Math.random()}`,
        role: "teacher",
      });
      const ownerId =
        ownerRole === "teacher"
          ? teacherId
          : await ctx.db.insert("users", {
              name: "Del Scholar",
              username: `del-scholar-${Math.random()}`,
              role: "scholar",
            });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Del unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Del lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Del activity",
        kind: "vibecode",
        order: 0,
        editAccess,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: ownerId,
        activityId,
        title: "Del session",
        isArchived: false,
        sessionMode: "vibecode",
      });
      const artifactId = await ctx.db.insert("artifacts", {
        sessionId,
        title: "App",
        content: "<!doctype html><html><body>App</body></html>",
        lastEditedBy: "ai",
        revision: 1,
        type: "code",
        language: "html",
      });
      return { teacherId, ownerId, artifactId };
    });
  }

  async function artifactExists(
    t: ReturnType<typeof convexTest>,
    artifactId: Awaited<ReturnType<typeof seedDeleteFixture>>["artifactId"],
  ) {
    return await t.run(async (ctx) => (await ctx.db.get(artifactId)) !== null);
  }

  test("a scholar pinned to Play (never) cannot delete the code app", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, artifactId } = await seedDeleteFixture(t, "never");
    const asScholar = t.withIdentity({ subject: ownerId });

    await expect(
      asScholar.mutation(api.artifacts.deleteArtifact, { artifactId }),
    ).rejects.toThrow(/Edit is not available/);
    expect(await artifactExists(t, artifactId)).toBe(true);
  });

  test("a scholar with Edit allowed (always) can delete the code app", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, artifactId } = await seedDeleteFixture(t, "always");
    const asScholar = t.withIdentity({ subject: ownerId });

    await asScholar.mutation(api.artifacts.deleteArtifact, { artifactId });
    expect(await artifactExists(t, artifactId)).toBe(false);
  });

  test("a teacher-role caller is never gated, even under never", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, artifactId } = await seedDeleteFixture(
      t,
      "never",
      "teacher",
    );
    const asTeacher = t.withIdentity({ subject: teacherId });

    await asTeacher.mutation(api.artifacts.deleteArtifact, { artifactId });
    expect(await artifactExists(t, artifactId)).toBe(false);
  });
});
