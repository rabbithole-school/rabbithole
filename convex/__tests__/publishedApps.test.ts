// Publishing a scholar's app to other scholars (convex/publishedApps.ts): the
// frozen copy, its credit, Publish latest in place (including across a
// free-play copy), the asset copies, and who may publish.
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { appAssetRef } from "../../shared/appAssets";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

const V3 = "<!doctype html><html><body>Volcano v3</body></html>";
const V4 = "<!doctype html><html><body>Volcano v4</body></html>";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function asUser(t: T, userId: Id<"users">) {
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

async function seedWorld(t: T) {
  const institutionId = await seedTestInstitution(t);
  const otherInstitutionId = await seedTestInstitution(t, {
    slug: "other-school",
    name: "Other School",
  });
  const teacherId = await seedStaffWithMembership(t, { institutionId });
  const otherTeacherId = await seedStaffWithMembership(t, {
    institutionId: otherInstitutionId,
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Pat Example",
  });
  const { sessionId, artifactId } = await t.run(async (ctx) => {
    // A free build: no activity, so the session can hold a built app.
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      institutionId,
      title: "Volcano game",
      isArchived: false,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Volcano Run",
      content: V3,
      lastEditedBy: "ai",
      revision: 3,
      type: "code",
      language: "html",
    });
    return { sessionId, artifactId };
  });
  return { institutionId, teacherId, otherTeacherId, scholarId, sessionId, artifactId };
}

async function scholarCard(
  t: T,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
) {
  const asTeacher = await asUser(t, teacherId);
  const { page } = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
    scholarIds: [scholarId],
    archived: false,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(page).toHaveLength(1);
  return page[0];
}

describe("publishedApps.publish", () => {
  test("copies the app into an ungranted tile and credits the builder", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);

    const target = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });

    expect(target.name).toBe("Volcano Run");
    const row = await t.run((ctx) => ctx.db.get(target.customAppId));
    expect(row).toMatchObject({
      kind: "static",
      status: "live",
      html: V3,
      externalAppId: target.externalAppId,
      sourceArtifactId: w.artifactId,
      sourceRevision: 3,
      publishedFrom: { sessionId: w.sessionId, builderId: w.scholarId },
    });
    // Publishing grants nothing: the teacher picks who gets it next.
    const grants = await t.run(async (ctx) => ({
      audiences: await ctx.db
        .query("appAudiences")
        .withIndex("by_app", (q) => q.eq("appId", target.externalAppId))
        .collect(),
      direct: (await ctx.db.query("scholarApps").collect()).filter(
        (r) => r.appId === target.externalAppId,
      ),
    }));
    expect(grants.audiences).toEqual([]);
    expect(grants.direct).toEqual([]);

    const hosted = await t.action(
      api.appAssetHostActions.resolveCustomAppForHost,
      { token: row!.token },
    );
    expect(hosted?.credit).toBe("Pat");
    expect(hosted?.html).toBe(V3);

    const card = await scholarCard(t, w.teacherId, w.scholarId);
    expect(card.published).toMatchObject({
      customAppId: target.customAppId,
      externalAppId: target.externalAppId,
      current: true,
    });
  });

  test("publishes the session's newest app, the one free play carries", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const newerId = await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId: w.sessionId,
        title: "Lava Lab",
        content: V4,
        lastEditedBy: "ai",
        revision: 1,
        type: "code",
        language: "html",
      }),
    );
    const asTeacher = await asUser(t, w.teacherId);

    const target = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });

    expect(target.name).toBe("Lava Lab");
    expect(await t.run((ctx) => ctx.db.get(target.customAppId))).toMatchObject({
      html: V4,
      sourceArtifactId: newerId,
    });
  });

  test("publishing again returns the same tile", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);

    const first = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });
    const second = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });

    expect(second.customAppId).toBe(first.customAppId);
    const rows = await t.run((ctx) => ctx.db.query("customApps").collect());
    expect(rows).toHaveLength(1);
  });

  test("an archived tile no longer counts, so publishing makes a fresh one", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);
    const first = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });
    await t.run((ctx) => ctx.db.patch(first.externalAppId, { archived: true }));

    expect((await scholarCard(t, w.teacherId, w.scholarId)).published).toBeNull();
    const second = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });
    expect(second.customAppId).not.toBe(first.customAppId);
  });

  test("copies the app's pictures so the tile owns its own blobs", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const sourceId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob([PNG], { type: "image/png" }));
      await ctx.db.insert("messages", {
        sessionId: w.sessionId,
        role: "tool",
        content: "Lava",
        flagged: false,
        imageId: id,
      });
      await ctx.db.patch(w.artifactId, {
        content: `<html><body><img src="${appAssetRef(String(id))}"></body></html>`,
      });
      return id;
    });
    const asTeacher = await asUser(t, w.teacherId);

    const target = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });

    const row = await t.run((ctx) => ctx.db.get(target.customAppId));
    expect(row?.appAssetIds).toHaveLength(1);
    const copyId = row!.appAssetIds![0];
    expect(copyId).not.toBe(sourceId);
    expect(row?.html).toContain(appAssetRef(String(copyId)));
    expect(row?.html).not.toContain(appAssetRef(String(sourceId)));
  });

  test("refuses another school's teacher, a scholar, and an app with an AI character", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);

    const asOther = await asUser(t, w.otherTeacherId);
    await expect(
      asOther.action(api.publishedApps.publish, { sessionId: w.sessionId }),
    ).rejects.toThrow();
    const asScholar = await asUser(t, w.scholarId);
    await expect(
      asScholar.action(api.publishedApps.publish, { sessionId: w.sessionId }),
    ).rejects.toThrow(/Forbidden/);

    await t.run((ctx) => ctx.db.patch(w.artifactId, { appAi: { updatedAt: 1 } }));
    const asTeacher = await asUser(t, w.teacherId);
    await expect(
      asTeacher.action(api.publishedApps.publish, { sessionId: w.sessionId }),
    ).rejects.toThrow(/AI character/);

    expect(await t.run((ctx) => ctx.db.query("customApps").collect())).toEqual(
      [],
    );
  });
});

test("a published copy can't be picked up by name as an activity starter", async () => {
  const t = convexTest(schema, modules);
  const w = await seedWorld(t);
  const asTeacher = await asUser(t, w.teacherId);
  await asTeacher.action(api.publishedApps.publish, { sessionId: w.sessionId });

  const resolved = await t.query(
    internal.customApps.resolveStaticAppForCoachedActivity,
    {
      name: "Volcano Run",
      callerUserId: w.teacherId,
      scholarLensResolved: true,
    },
  );
  expect(resolved.kind).toBe("not_found");
});

describe("publishedApps.publishLatest", () => {
  test("stays frozen until a teacher publishes the latest, then replaces it in place", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);
    const target = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });
    const before = await t.run((ctx) => ctx.db.get(target.customAppId));

    // The scholar keeps building: the copy does not change on its own.
    await t.run((ctx) => ctx.db.patch(w.artifactId, { content: V4, revision: 4 }));
    expect((await t.run((ctx) => ctx.db.get(target.customAppId)))?.html).toBe(V3);
    expect((await scholarCard(t, w.teacherId, w.scholarId)).published?.current).toBe(
      false,
    );

    const result = await asTeacher.action(api.publishedApps.publishLatest, {
      customAppId: target.customAppId,
    });

    expect(result).toEqual({ updated: true });
    const after = await t.run((ctx) => ctx.db.get(target.customAppId));
    expect(after).toMatchObject({
      html: V4,
      sourceRevision: 4,
      token: before!.token,
      externalAppId: before!.externalAppId,
    });
    expect((await scholarCard(t, w.teacherId, w.scholarId)).published?.current).toBe(
      true,
    );
    expect(
      await asTeacher.action(api.publishedApps.publishLatest, {
        customAppId: target.customAppId,
      }),
    ).toEqual({ updated: false });
  });

  test("follows the app into the scholar's free-play copy", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);
    const target = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });
    const copyArtifactId = await t.run(async (ctx) => {
      const copyId = await ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Volcano game (free play)",
        isArchived: false,
        freePlay: true,
        freePlayOf: w.sessionId,
      });
      return await ctx.db.insert("artifacts", {
        sessionId: copyId,
        title: "Volcano Run",
        content: V4,
        lastEditedBy: "ai",
        revision: 0,
        type: "code",
        language: "html",
      });
    });

    // The card is now the copy, and still knows about the published tile.
    const card = await scholarCard(t, w.teacherId, w.scholarId);
    expect(card.published).toMatchObject({
      customAppId: target.customAppId,
      current: false,
    });

    await asTeacher.action(api.publishedApps.publishLatest, {
      customAppId: target.customAppId,
    });
    expect(await t.run((ctx) => ctx.db.get(target.customAppId))).toMatchObject({
      html: V4,
      sourceArtifactId: copyArtifactId,
      sourceRevision: 0,
    });
  });

  test("an unchanged free-play copy still reads as current", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);
    await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });
    // Free play copies the app into a new artifact at revision 0.
    await t.run(async (ctx) => {
      const copyId = await ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Volcano game (free play)",
        isArchived: false,
        freePlay: true,
        freePlayOf: w.sessionId,
      });
      await ctx.db.insert("artifacts", {
        sessionId: copyId,
        title: "Volcano Run",
        content: V3,
        lastEditedBy: "ai",
        revision: 0,
        type: "code",
        language: "html",
      });
    });

    expect((await scholarCard(t, w.teacherId, w.scholarId)).published?.current).toBe(
      true,
    );
  });

  test("drops the previous copy's pictures a day after Publish latest", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const w = await seedWorld(t);
      await t.run(async (ctx) => {
        const id = await ctx.storage.store(
          new Blob([PNG], { type: "image/png" }),
        );
        await ctx.db.insert("messages", {
          sessionId: w.sessionId,
          role: "tool",
          content: "Lava",
          flagged: false,
          imageId: id,
        });
        await ctx.db.patch(w.artifactId, {
          content: `<html><body><img src="${appAssetRef(String(id))}"></body></html>`,
        });
      });
      const asTeacher = await asUser(t, w.teacherId);
      const target = await asTeacher.action(api.publishedApps.publish, {
        sessionId: w.sessionId,
      });
      const oldCopy = (await t.run((ctx) => ctx.db.get(target.customAppId)))!
        .appAssetIds![0];

      await t.run((ctx) =>
        ctx.db.patch(w.artifactId, { content: V4, revision: 4 }),
      );
      await asTeacher.action(api.publishedApps.publishLatest, {
        customAppId: target.customAppId,
      });

      // Classmates with the old version open keep its pictures for now.
      expect(
        (await t.run((ctx) => ctx.db.get(target.customAppId)))?.appAssetIds,
      ).toBeUndefined();
      const stored = () =>
        t.run(async (ctx) => (await ctx.storage.get(oldCopy)) !== null);
      expect(await stored()).toBe(true);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await stored()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("refuses a teacher who can't see everyone the tile reaches", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const classmateId = await seedScholarInInstitution(t, {
      institutionId: w.institutionId,
    });
    const asTeacher = await asUser(t, w.teacherId);
    const target = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId: w.teacherId,
        institutionId: w.institutionId,
        name: "Class",
        scholarIds: [classmateId],
      });
      await ctx.db.insert("appAudiences", {
        appId: target.externalAppId,
        audienceKind: "group",
        audienceId: String(groupId),
        enabled: true,
      });
      // The builder moves schools; the classmates keep the tile.
      const otherInstitutionId = (await ctx.db.query("institutions").collect())
        .find((i) => i.slug === "other-school")!._id;
      await ctx.db.patch(w.scholarId, { institutionId: otherInstitutionId });
      await ctx.db.patch(w.artifactId, { content: V4, revision: 4 });
    });

    const asNewTeacher = await asUser(t, w.otherTeacherId);
    await expect(
      asNewTeacher.action(api.publishedApps.publishLatest, {
        customAppId: target.customAppId,
      }),
    ).rejects.toThrow(/outside your school/);
    expect((await t.run((ctx) => ctx.db.get(target.customAppId)))?.html).toBe(V3);
  });

  test("refuses another school's teacher", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await asUser(t, w.teacherId);
    const target = await asTeacher.action(api.publishedApps.publish, {
      sessionId: w.sessionId,
    });
    await t.run((ctx) => ctx.db.patch(w.artifactId, { content: V4, revision: 4 }));

    const asOther = await asUser(t, w.otherTeacherId);
    await expect(
      asOther.action(api.publishedApps.publishLatest, {
        customAppId: target.customAppId,
      }),
    ).rejects.toThrow();
    expect((await t.run((ctx) => ctx.db.get(target.customAppId)))?.html).toBe(V3);
  });
});
