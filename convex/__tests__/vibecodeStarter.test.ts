import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { buildVibecodeSection } from "../prompts";
import { generateAppToken } from "../customApps";
import { appAssetRef } from "../../shared/appAssets";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const STARTER_HTML = "<!doctype html><html><body>Starter</body></html>";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin",
  suffix: string = role,
) {
  return await t.run(async (ctx) => {
    const institutionId =
      role === "scholar"
        ? await ctx.db.insert("institutions", {
            name: `Test School ${suffix}`,
            slug: `test-school-${suffix}`,
            kind: "school",
          })
        : undefined;
    const userId = await ctx.db.insert("users", {
      name: `Test ${role} ${suffix}`,
      username: `test-${role}-${suffix}`,
      role,
      institutionId,
    });
    if (institutionId) {
      await ctx.db.insert("memberships", {
        userId,
        role: "scholar",
        institutionId,
      });
    }
    return userId;
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
  kind: "vibecode" | "online" = "vibecode",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Starter app unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Starter app lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Pattern explorer",
      kind,
      systemPrompt: "Use the app to investigate the pattern.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedArtifactSource(
  t: ReturnType<typeof convexTest>,
  args: {
    ownerId: Id<"users">;
    activityId: Id<"activities">;
    isTestDrive?: boolean;
    content?: string;
    title?: string;
  },
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: args.ownerId,
      activityId: args.activityId,
      title: "Starter rehearsal",
      isArchived: false,
      ...(args.isTestDrive === false ? {} : { isTestDrive: true }),
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: args.title ?? "Pattern explorer app",
      content: args.content ?? STARTER_HTML,
      lastEditedBy: "ai",
      revision: 0,
      type: "code",
      language: "html",
    });
    return { sessionId, artifactId };
  });
}

async function seedStaticApp(
  t: ReturnType<typeof convexTest>,
  args: {
    createdBy: Id<"users">;
    name?: string;
    html?: string | null;
    updatedAt?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("customApps", {
      token: generateAppToken(),
      name: args.name ?? "Pattern explorer app",
      kind: "static",
      status: "live",
      html: args.html === null ? undefined : args.html ?? STARTER_HTML,
      origin: "starter",
      createdBy: args.createdBy,
      updatedAt: args.updatedAt ?? 1_725_000_000_000,
    }),
  );
}

describe("Vibecode starter promotion", () => {
  test("creates an uninstalled static app reference from the caller's rehearsal", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const asTeacher = await withUser(t, teacherId);

    const starter = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );

    expect(starter).toMatchObject({
      name: "Pattern explorer app",
    });
    expect(starter.updatedAt).toEqual(expect.any(Number));
    const state = await t.run(async (ctx) => ({
      activity: await ctx.db.get(activityId),
      app: await ctx.db.get(starter.id),
      customApps: await ctx.db.query("customApps").collect(),
      externalApps: await ctx.db.query("externalApps").collect(),
      scholarApps: await ctx.db.query("scholarApps").collect(),
      appAudiences: await ctx.db.query("appAudiences").collect(),
    }));
    expect(state.activity?.starterAppId).toBe(starter.id);
    // First promotion switches scholars onto the saved app (TRA-301 F8):
    // with autosave and no Save button, the first save is the only switch.
    expect(state.activity?.scholarsStartFrom).toBe("starter");
    expect(state.app).toMatchObject({
      name: "Pattern explorer app",
      kind: "static",
      status: "live",
      html: STARTER_HTML,
      origin: "starter",
      createdBy: teacherId,
      updatedAt: starter.updatedAt,
    });
    expect(state.app?.token).toMatch(/^[0-9a-f]{48}$/);
    expect(state.customApps).toHaveLength(1);
    expect(state.externalApps).toEqual([]);
    expect(state.scholarApps).toEqual([]);
    expect(state.appAudiences).toEqual([]);

    const hydrated = await asTeacher.query(api.activities.get, { id: activityId });
    expect(hydrated?.starterApp).toEqual({
      id: starter.id,
      name: "Pattern explorer app",
      updatedAt: starter.updatedAt,
    });
  });

  test("copies the newest rehearsal app snapshot onto the promoted starter", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const { sessionId, artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });

    const { olderStorageId, newestStorageId } = await t.run(async (ctx) => {
      const olderStorageId = await ctx.storage.store(
        new Blob(["older"], { type: "image/png" }),
      );
      const newestStorageId = await ctx.storage.store(
        new Blob(["newest"], { type: "image/jpeg" }),
      );
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "First render",
        flagged: false,
        appSnapshotStorageId: olderStorageId,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "Latest render",
        flagged: false,
        appSnapshotStorageId: newestStorageId,
      });
      return { olderStorageId, newestStorageId };
    });
    const asTeacher = await withUser(t, teacherId);

    const starter = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );
    const app = await t.run((ctx) => ctx.db.get(starter.id));

    expect(app?.thumbnailStorageId).toBe(newestStorageId);
    expect(app?.thumbnailStorageId).not.toBe(olderStorageId);
  });

  test("copies referenced session images into the starter and carries them into scholar artifacts", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "asset-teacher");
    const scholarId = await seedUser(t, "scholar", "asset-scholar");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const { sessionId, artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const sourceAssetId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
          type: "image/png",
        }),
      );
      await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "Parrotfish",
        flagged: false,
        imageId: id,
      });
      await ctx.db.patch(artifactId, {
        content: `<!doctype html><html><body><img alt="Parrotfish" src="${appAssetRef(String(id))}"></body></html>`,
      });
      return id;
    });
    const asTeacher = await withUser(t, teacherId);

    const starter = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );
    await asTeacher.mutation(api.activities.setScholarsStartFrom, {
      activityId,
      value: "starter",
    });
    const promoted = await t.run((ctx) => ctx.db.get(starter.id));
    expect(promoted?.appAssetIds).toHaveLength(1);
    expect(promoted?.appAssetIds?.[0]).not.toBe(sourceAssetId);
    expect(promoted?.html).toContain(
      appAssetRef(String(promoted?.appAssetIds?.[0])),
    );
    expect(promoted?.html).not.toContain(appAssetRef(String(sourceAssetId)));

    const asScholar = await withUser(t, scholarId);
    const session = await asScholar.mutation(api.sessions.create, {
      activityId,
    });
    const scholarArtifact = await t.run((ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", session.id))
        .first(),
    );
    expect(scholarArtifact?.appAssetIds).toEqual(promoted?.appAssetIds);
    expect(scholarArtifact?.content).toBe(promoted?.html);
    if (!scholarArtifact || !promoted?.appAssetIds?.[0]) {
      throw new Error("Expected promoted app asset");
    }

    const resolved = await asScholar.action(
      api.appAssetHostActions.resolveArtifactAssets,
      {
        artifactId: scholarArtifact._id,
        html: scholarArtifact.content,
      },
    );
    expect(new URL(resolved[0]?.url ?? "").protocol).toBe("https:");
  });

  test("replaces the same referenced app by id", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const firstSource = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const firstSourceStorage = await t.run(async (ctx) => {
      const assetId = await ctx.storage.store(
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
          type: "image/png",
        }),
      );
      const thumbnailId = await ctx.storage.store(
        new Blob(["first thumbnail"], { type: "image/jpeg" }),
      );
      await ctx.db.patch(firstSource.sessionId, { appAssetIds: [assetId] });
      await ctx.db.patch(firstSource.artifactId, {
        content: `<!doctype html><html><body><img src="${appAssetRef(String(assetId))}"></body></html>`,
      });
      await ctx.db.insert("messages", {
        sessionId: firstSource.sessionId,
        role: "user",
        content: "First render",
        flagged: false,
        appSnapshotStorageId: thumbnailId,
      });
      return { assetId, thumbnailId };
    });
    const asTeacher = await withUser(t, teacherId);

    const first = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId: firstSource.artifactId },
    );
    const original = await t.run((ctx) => ctx.db.get(first.id));
    const originalAssetId = original?.appAssetIds?.[0];
    const originalThumbnailId = original?.thumbnailStorageId;
    if (!originalAssetId || !originalThumbnailId) {
      throw new Error("Expected the original starter blobs");
    }
    expect(originalAssetId).not.toBe(firstSourceStorage.assetId);
    expect(originalThumbnailId).toBe(firstSourceStorage.thumbnailId);
    const secondSource = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
      title: "Revised pattern explorer",
    });
    const secondSourceStorage = await t.run(async (ctx) => {
      const assetId = await ctx.storage.store(
        new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
          type: "image/jpeg",
        }),
      );
      const thumbnailId = await ctx.storage.store(
        new Blob(["second thumbnail"], { type: "image/png" }),
      );
      await ctx.db.patch(secondSource.sessionId, { appAssetIds: [assetId] });
      await ctx.db.patch(secondSource.artifactId, {
        content: `<!doctype html><html><body>Revised<img src="${appAssetRef(String(assetId))}"></body></html>`,
      });
      await ctx.db.insert("messages", {
        sessionId: secondSource.sessionId,
        role: "user",
        content: "Second render",
        flagged: false,
        appSnapshotStorageId: thumbnailId,
      });
      return { assetId, thumbnailId };
    });

    const second = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId: secondSource.artifactId },
    );
    const state = await t.run(async (ctx) => ({
      activity: await ctx.db.get(activityId),
      app: await ctx.db.get(second.id),
      customApps: await ctx.db.query("customApps").collect(),
    }));

    expect(second.id).toBe(first.id);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(state.activity?.starterAppId).toBe(first.id);
    expect(state.customApps).toHaveLength(1);
    const replacementAssetId = state.app?.appAssetIds?.[0];
    if (!replacementAssetId) {
      throw new Error("Expected the replacement starter asset");
    }
    expect(state.app).toMatchObject({
      token: original?.token,
      name: "Revised pattern explorer",
      origin: "starter",
      updatedAt: second.updatedAt,
    });
    expect(state.app?.html).toContain(appAssetRef(String(replacementAssetId)));
    expect(state.app?.html).not.toContain(
      appAssetRef(String(secondSourceStorage.assetId)),
    );
    expect(state.app?.thumbnailStorageId).toBe(secondSourceStorage.thumbnailId);
    await expect(
      t.run((ctx) => ctx.storage.get(originalAssetId)),
    ).resolves.toBeNull();
    await expect(
      t.run((ctx) => ctx.storage.get(originalThumbnailId)),
    ).resolves.toBeNull();
    await expect(
      t.run(async (ctx) => (await ctx.storage.get(replacementAssetId)) !== null),
    ).resolves.toBe(true);
  });

  test("starter names neither shadow nor receive aide app updates", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const installed = await t.mutation(
      internal.customApps.createStaticApp,
      {
        name: "Pattern explorer app",
        html: "<!doctype html><html><body>Installed old</body></html>",
        token: generateAppToken(),
        callerUserId: teacherId,
        scholarIds: [],
        groupIds: [],
        scholarLensResolved: true,
      },
    );
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const asTeacher = await withUser(t, teacherId);
    const starter = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );

    const updated = await t.mutation(
      internal.customApps.updateStaticApp,
      {
        name: "Pattern explorer app",
        html: "<!doctype html><html><body>Installed new</body></html>",
        callerUserId: teacherId,
        scholarLensResolved: true,
      },
    );
    expect(updated).toMatchObject({
      kind: "updated",
      customAppId: installed.customAppId,
    });
    let state = await t.run(async (ctx) => ({
      installed: await ctx.db.get(installed.customAppId),
      starter: await ctx.db.get(starter.id),
    }));
    expect(state.installed?.html).toBe(
      "<!doctype html><html><body>Installed new</body></html>",
    );
    expect(state.starter?.html).toBe(STARTER_HTML);

    await t.run((ctx) => ctx.db.delete(installed.customAppId));
    expect(
      await t.mutation(internal.customApps.updateStaticApp, {
        name: "Pattern explorer app",
        html: "<!doctype html><html><body>Must not land</body></html>",
        callerUserId: teacherId,
        scholarLensResolved: true,
      }),
    ).toEqual({ kind: "not_found" });
    state = await t.run(async (ctx) => ({
      installed: await ctx.db.get(installed.customAppId),
      starter: await ctx.db.get(starter.id),
    }));
    expect(state.installed).toBeNull();
    expect(state.starter?.html).toBe(STARTER_HTML);
  });

  test("rejects an artifact owned by another rehearsal author", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "owner");
    const otherTeacherId = await seedUser(t, "teacher", "other");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: otherTeacherId,
      activityId,
    });
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.action(api.vibecodeStarterActions.setVibecodeStarterFromArtifact, {
        activityId,
        artifactId,
      }),
    ).rejects.toThrow(/your rehearsal/i);
  });

  test("rejects an artifact from a non-test-drive session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
      isTestDrive: false,
    });
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.action(api.vibecodeStarterActions.setVibecodeStarterFromArtifact, {
        activityId,
        artifactId,
      }),
    ).rejects.toThrow(/your rehearsal/i);
  });

  test("rejects an artifact rehearsed for a different activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { lessonId, activityId } = await seedUnitWithActivity(t, teacherId);
    const otherActivityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Other vibecode activity",
        kind: "vibecode",
        systemPrompt: "Explore something else.",
        order: 1,
      }),
    );
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.action(api.vibecodeStarterActions.setVibecodeStarterFromArtifact, {
        activityId: otherActivityId,
        artifactId,
      }),
    ).rejects.toThrow(/your rehearsal/i);
  });

  test("rejects a code artifact that is not an HTML app", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(
      t,
      teacherId,
      "vibecode",
    );
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
      content: "console.log('not a page');",
    });
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.action(api.vibecodeStarterActions.setVibecodeStarterFromArtifact, {
        activityId,
        artifactId,
      }),
    ).rejects.toThrow(/HTML app/i);
  });

  test("rejects promotion for an online activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(
      t,
      teacherId,
      "online",
    );
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.action(api.vibecodeStarterActions.setVibecodeStarterFromArtifact, {
        activityId,
        artifactId,
      }),
    ).rejects.toThrow(/must be vibecode/i);
  });

  test("rejects choosing the saved app before a starter exists", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.activities.setScholarsStartFrom, {
        activityId,
        value: "starter",
      }),
    ).rejects.toThrow(/save an activity starter/i);
  });

  test.each(["missing", "non-static", "no-html"] as const)(
    "does not expose or clone an unusable starter when the reference is %s",
    async (invalidKind) => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher", invalidKind);
      const scholarId = await seedUser(t, "scholar", invalidKind);
      const { activityId } = await seedUnitWithActivity(t, teacherId);
      const invalidStarterAppId = await t.run(async (ctx) => {
        if (invalidKind === "non-static") {
          return await ctx.db.insert("customApps", {
            token: generateAppToken(),
            name: "Coded starter",
            kind: "coded",
            status: "live",
            routePath: "/custom-apps/coded-starter",
            createdBy: teacherId,
          });
        }
        const id = await ctx.db.insert("customApps", {
          token: generateAppToken(),
          name: "Incomplete starter",
          kind: "static",
          status: "live",
          ...(invalidKind === "no-html" ? {} : { html: STARTER_HTML }),
          origin: "starter",
          createdBy: teacherId,
        });
        if (invalidKind === "missing") await ctx.db.delete(id);
        return id;
      });
      await t.run((ctx) =>
        ctx.db.patch(activityId, { starterAppId: invalidStarterAppId }),
      );
      const asTeacher = await withUser(t, teacherId);

      expect(
        (await asTeacher.query(api.activities.get, { id: activityId }))
          ?.starterApp,
      ).toBeNull();
      await expect(
        asTeacher.mutation(api.activities.setScholarsStartFrom, {
          activityId,
          value: "starter",
        }),
      ).rejects.toThrow(/save an activity starter/i);

      await t.run((ctx) =>
        ctx.db.patch(activityId, { scholarsStartFrom: "starter" }),
      );
      const asScholar = await withUser(t, scholarId);
      const created = await asScholar.mutation(api.sessions.create, {
        activityId,
      });
      const result = await t.run(async (ctx) => ({
        session: await ctx.db.get(created.id),
        artifacts: await ctx.db
          .query("artifacts")
          .withIndex("by_session", (q) => q.eq("sessionId", created.id))
          .collect(),
      }));

      expect(result.artifacts).toEqual([]);
      expect(result.session?.vibecodeStarterUsedAt).toBeUndefined();
    },
  );

  test("clears the reference without deleting the app", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const asTeacher = await withUser(t, teacherId);
    const starter = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );
    await asTeacher.mutation(api.activities.setScholarsStartFrom, {
      activityId,
      value: "starter",
    });

    await asTeacher.mutation(api.activities.clearVibecodeStarter, {
      activityId,
    });

    const state = await t.run(async (ctx) => ({
      activity: await ctx.db.get(activityId),
      app: await ctx.db.get(starter.id),
    }));
    expect(state.activity?.starterAppId).toBeUndefined();
    expect(state.activity?.scholarsStartFrom).toBeUndefined();
    expect(state.app).toMatchObject({
      _id: starter.id,
      status: "live",
      html: STARTER_HTML,
    });
  });
});

describe("Vibecode starter session setup", () => {
  test.each([
    ["absent", undefined],
    ["blank", "blank" as const],
  ])(
    "does not clone a saved starter when scholarsStartFrom is %s",
    async (_label, scholarsStartFrom) => {
      const t = convexTest(schema, modules);
      const teacherId = await seedUser(t, "teacher");
      const scholarId = await seedUser(t, "scholar");
      const { activityId } = await seedUnitWithActivity(t, teacherId);
      const starterAppId = await seedStaticApp(t, {
        createdBy: teacherId,
      });
      await t.run((ctx) =>
        ctx.db.patch(activityId, {
          starterAppId,
          ...(scholarsStartFrom ? { scholarsStartFrom } : {}),
        }),
      );
      const asScholar = await withUser(t, scholarId);

      const created = await asScholar.mutation(api.sessions.create, {
        activityId,
      });
      const result = await t.run(async (ctx) => ({
        session: await ctx.db.get(created.id),
        artifacts: await ctx.db
          .query("artifacts")
          .withIndex("by_session", (q) => q.eq("sessionId", created.id))
          .collect(),
      }));

      expect(result.artifacts).toEqual([]);
      expect(result.session?.vibecodeStarterUsedAt).toBeUndefined();
    },
  );

  test("clones the referenced app once and stamps its version", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const updatedAt = 1_725_000_000_000;
    const starterAppId = await seedStaticApp(t, {
      createdBy: teacherId,
      name: "Referenced pattern explorer",
      html: "<!doctype html><html><body>Referenced</body></html>",
      updatedAt,
    });
    await t.run((ctx) =>
      ctx.db.patch(activityId, {
        starterAppId,
        scholarsStartFrom: "starter",
      }),
    );
    const asScholar = await withUser(t, scholarId);

    const first = await asScholar.mutation(api.sessions.create, { activityId });
    const second = await asScholar.mutation(api.sessions.create, { activityId });
    const result = await t.run(async (ctx) => ({
      session: await ctx.db.get(first.id),
      artifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", first.id))
        .collect(),
      promptContext: await ctx.runQuery(
        internal.sessionHelpers.getSessionContext,
        { sessionId: first.id },
      ),
    }));

    expect(second.id).toBe(first.id);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      title: "Referenced pattern explorer",
      content: "<!doctype html><html><body>Referenced</body></html>",
      type: "code",
      language: "html",
      lastEditedBy: "ai",
      revision: 0,
    });
    expect(result.session?.vibecodeStarterUsedAt).toBe(updatedAt);
    expect(result.promptContext?.vibecodeStarterUsedAt).toBe(updatedAt);
  });

  test("does not replace an artifact already in the session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const first = await asScholar.mutation(api.sessions.create, { activityId });
    const existingArtifactId = await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId: first.id,
        title: "Scholar draft",
        content: "<html><body>Keep me</body></html>",
        lastEditedBy: "scholar",
        revision: 4,
        type: "code",
        language: "html",
      }),
    );
    const starterAppId = await seedStaticApp(t, {
      createdBy: teacherId,
      name: "New teacher starter",
      updatedAt: 1_725_000_000_001,
    });
    await t.run((ctx) =>
      ctx.db.patch(activityId, { starterAppId, scholarsStartFrom: "starter" }),
    );

    await asScholar.mutation(api.sessions.create, { activityId });
    const result = await t.run(async (ctx) => ({
      session: await ctx.db.get(first.id),
      artifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", first.id))
        .collect(),
    }));

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      _id: existingArtifactId,
      title: "Scholar draft",
      content: "<html><body>Keep me</body></html>",
      revision: 4,
    });
    expect(result.session?.vibecodeStarterUsedAt).toBeUndefined();
  });

  test("Reset loads the current starter into the fresh rehearsal", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const rehearsal = await asTeacher.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true,
    });
    const artifactId = await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId: rehearsal.id,
        title: "Teacher-built explorer",
        content: STARTER_HTML,
        lastEditedBy: "ai",
        revision: 3,
        type: "code",
        language: "html",
      }),
    );
    const starter = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );
    await asTeacher.mutation(api.activities.setScholarsStartFrom, {
      activityId,
      value: "starter",
    });

    const reset = await asTeacher.mutation(api.sessions.resetTestDrive, {
      sessionId: rehearsal.id,
    });
    const result = await t.run(async (ctx) => ({
      session: await ctx.db.get(reset.id),
      artifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", reset.id))
        .collect(),
    }));

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      title: "Teacher-built explorer",
      content: STARTER_HTML,
      type: "code",
      language: "html",
      lastEditedBy: "ai",
      revision: 0,
    });
    expect(result.session?.vibecodeStarterUsedAt).toBe(starter.updatedAt);
  });
});

describe("Vibecode starter prompt", () => {
  test("includes the starter coaching branch when a starter was cloned", () => {
    expect(
      buildVibecodeSection({ vibecodeStarterUsedAt: 1 }),
    ).toContain("A teacher-authored app is already on screen.");
  });

  test("omits the starter coaching branch without a cloned starter", () => {
    const prompt = buildVibecodeSection();
    expect(prompt).not.toContain(
      "A teacher-authored app is already on screen.",
    );
    expect(prompt).toContain(
      "a compact first working version — a core you can extend with edit_document, not the whole spec at once",
    );
  });
});

describe("Vibecode starter duplication", () => {
  test("shares the starter reference with the duplicated activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const { artifactId } = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const asTeacher = await withUser(t, teacherId);
    const starter = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );
    await asTeacher.mutation(api.activities.setScholarsStartFrom, {
      activityId,
      value: "starter",
    });

    const copyId = await asTeacher.mutation(api.activities.duplicate, {
      activityId,
    });
    const copy = await t.run((ctx) => ctx.db.get(copyId));
    expect(copy?.starterAppId).toBe(starter.id);
    expect(copy?.scholarsStartFrom).toBe("starter");
  });

  test("forks a shared starter before replacing one duplicate", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const firstSource = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
    });
    const asTeacher = await withUser(t, teacherId);
    const shared = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId: firstSource.artifactId },
    );
    const copyId = await asTeacher.mutation(api.activities.duplicate, {
      activityId,
    });
    const replacementSource = await seedArtifactSource(t, {
      ownerId: teacherId,
      activityId,
      title: "Forked starter",
      content: "<!doctype html><html><body>Forked</body></html>",
    });

    const replacement = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId: replacementSource.artifactId },
    );
    const state = await t.run(async (ctx) => ({
      source: await ctx.db.get(activityId),
      copy: await ctx.db.get(copyId),
      sharedApp: await ctx.db.get(shared.id),
      replacementApp: await ctx.db.get(replacement.id),
      customApps: await ctx.db.query("customApps").collect(),
    }));

    expect(replacement.id).not.toBe(shared.id);
    expect(state.source?.starterAppId).toBe(replacement.id);
    expect(state.copy?.starterAppId).toBe(shared.id);
    expect(state.sharedApp).toMatchObject({
      name: "Pattern explorer app",
      html: STARTER_HTML,
      origin: "starter",
    });
    expect(state.replacementApp).toMatchObject({
      name: "Forked starter",
      html: "<!doctype html><html><body>Forked</body></html>",
      origin: "starter",
    });
    expect(state.customApps).toHaveLength(2);
  });
});

describe("Vibecode starter internal creation", () => {
  test("threads the reference and switch through the teacher aide upsert", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { lessonId } = await seedUnitWithActivity(t, teacherId);
    const starterAppId = await seedStaticApp(t, { createdBy: teacherId });

    const result = await t.mutation(
      internal.teacherAide.createScholarActivity,
      {
        lessonId,
        title: "Aide starter activity",
        kind: "vibecode",
        starterAppId,
        scholarsStartFrom: "starter",
      },
    );
    const activity = await t.run((ctx) => ctx.db.get(result.activityId));

    expect(activity).toMatchObject({
      kind: "vibecode",
      starterAppId,
      scholarsStartFrom: "starter",
    });
  });
});
