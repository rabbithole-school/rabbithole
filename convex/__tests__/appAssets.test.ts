import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  appAssetRef,
  MAX_APP_ASSETS,
  MAX_APP_ASSET_BYTES,
} from "../../shared/appAssets";
import { generateAppToken } from "../customApps";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38]);

async function seedUser(t: ReturnType<typeof convexTest>, suffix: string) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Asset ${suffix}`,
      username: `asset-${suffix}`,
      role: "scholar",
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedArtifact(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Asset app",
      isArchived: false,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Food web",
      content: "<!doctype html>",
      lastEditedBy: "ai",
      type: "code",
      language: "html",
    });
    return { sessionId, artifactId };
  });
}

describe("artifact app asset resolver", () => {
  test("resolves only session-owned or inherited assets", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "owner");
    const { sessionId, artifactId } = await seedArtifact(t, userId);
    const ids = await t.run(async (ctx) => {
      const sessionImage = await ctx.storage.store(
        new Blob([PNG], { type: "image/png" }),
      );
      const inherited = await ctx.storage.store(
        new Blob([JPEG], { type: "image/jpeg" }),
      );
      const sessionAsset = await ctx.storage.store(
        new Blob([PNG], { type: "image/png" }),
      );
      const charmCopy = await ctx.storage.store(
        new Blob([PNG], { type: "image/png" }),
      );
      await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "Parrotfish",
        flagged: false,
        imageId: sessionImage,
      });
      await ctx.db.patch(artifactId, { appAssetIds: [inherited] });
      await ctx.db.patch(sessionId, {
        appAssetIds: [sessionAsset, charmCopy],
      });
      return { sessionImage, inherited, sessionAsset, charmCopy };
    });
    const asUser = await withUser(t, userId);

    const resolved = await asUser.action(
      api.appAssetHostActions.resolveArtifactAssets,
      {
        artifactId,
        html: Object.values(ids)
          .map((id) => `<img src="${appAssetRef(String(id))}">`)
          .join(""),
      },
    );

    expect(resolved.map((asset) => asset.id)).toEqual(
      Object.values(ids).map(String),
    );
    expect(resolved.every((asset) => new URL(asset.url).protocol === "https:")).toBe(
      true,
    );
  });

  test("rejects a raw ready charm cache id", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "owner-charm-cache");
    const { artifactId } = await seedArtifact(t, userId);
    const charm = await t.run(async (ctx) => {
      const imageStorageId = await ctx.storage.store(
        new Blob([PNG], { type: "image/png" }),
      );
      await ctx.db.insert("manipulativeThemeIcons", {
        label: "app:flat:coral",
        displayLabel: "coral",
        imageStorageId,
        status: "ready",
        createdAt: Date.now(),
      });
      return imageStorageId;
    });
    const asUser = await withUser(t, userId);

    await expect(
      asUser.action(api.appAssetHostActions.resolveArtifactAssets, {
        artifactId,
        html: `<img src="${appAssetRef(String(charm))}">`,
      }),
    ).rejects.toThrow(/does not belong to this session/i);
  });

  test("rejects a blob owned by another session", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner-foreign");
    const foreign = await seedUser(t, "foreign");
    const { artifactId } = await seedArtifact(t, owner);
    const { sessionId: foreignSession } = await seedArtifact(t, foreign);
    const foreignImage = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob([PNG]));
      await ctx.db.insert("messages", {
        sessionId: foreignSession,
        role: "tool",
        content: "Foreign",
        flagged: false,
        imageId: id,
      });
      return id;
    });
    const asOwner = await withUser(t, owner);

    await expect(
      asOwner.action(api.appAssetHostActions.resolveArtifactAssets, {
        artifactId,
        html: `<img src="${appAssetRef(String(foreignImage))}">`,
      }),
    ).rejects.toThrow(/does not belong to this session/i);
  });

  test("enforces the distinct asset count cap", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner-cap");
    const { artifactId } = await seedArtifact(t, owner);
    const asOwner = await withUser(t, owner);

    await expect(
      asOwner.action(api.appAssetHostActions.resolveArtifactAssets, {
        artifactId,
        html: Array.from(
          { length: MAX_APP_ASSETS + 1 },
          (_, index) => `<img src="/app-assets/asset-${index}">`,
        ).join(""),
      }),
    ).rejects.toThrow(/at most 8 assets/i);
  });

  test("rejects an owned blob over the per-asset byte cap", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner-size");
    const { sessionId, artifactId } = await seedArtifact(t, owner);
    const imageId = await t.run(async (ctx) => {
      const bytes = new Uint8Array(MAX_APP_ASSET_BYTES + 1);
      bytes.set(JPEG);
      const id = await ctx.storage.store(new Blob([bytes]));
      await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "Large",
        flagged: false,
        imageId: id,
      });
      return id;
    });
    const asOwner = await withUser(t, owner);

    await expect(
      asOwner.action(api.appAssetHostActions.resolveArtifactAssets, {
        artifactId,
        html: `<img src="${appAssetRef(String(imageId))}">`,
      }),
    ).rejects.toThrow(/bytes or smaller/i);
  });

  test("rejects an owned blob outside the approved image types", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner-type");
    const { sessionId, artifactId } = await seedArtifact(t, owner);
    const imageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(
        new Blob([GIF], { type: "image/gif" }),
      );
      await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "Animated",
        flagged: false,
        imageId: id,
      });
      return id;
    });
    const asOwner = await withUser(t, owner);

    await expect(
      asOwner.action(api.appAssetHostActions.resolveArtifactAssets, {
        artifactId,
        html: `<img src="${appAssetRef(String(imageId))}">`,
      }),
    ).rejects.toThrow(/JPEG, PNG, or WebP/i);
  });

  test("fails closed when an owned blob is missing", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner-missing");
    const { sessionId, artifactId } = await seedArtifact(t, owner);
    const imageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(
        new Blob([PNG], { type: "image/png" }),
      );
      await ctx.db.patch(sessionId, { appAssetIds: [id] });
      await ctx.storage.delete(id);
      return id;
    });
    const asOwner = await withUser(t, owner);

    await expect(
      asOwner.action(api.appAssetHostActions.resolveArtifactAssets, {
        artifactId,
        html: `<img src="${appAssetRef(String(imageId))}">`,
      }),
    ).rejects.toThrow(/no longer available/i);
  });
});

describe("static custom app asset resolver", () => {
  test("resolves recorded assets and rejects an unowned reference", async () => {
    const t = convexTest(schema, modules);
    const owned = await t.run((ctx) =>
      ctx.storage.store(new Blob([PNG], { type: "image/png" })),
    );
    const token = generateAppToken();
    await t.run((ctx) =>
      ctx.db.insert("customApps", {
        token,
        name: "Reef",
        kind: "static",
        status: "live",
        html: `<img src="${appAssetRef(String(owned))}">`,
        appAssetIds: [owned],
      }),
    );

    const resolved = await t.action(
      api.appAssetHostActions.resolveCustomAppForHost,
      { token },
    );
    expect(resolved?.html).toContain(appAssetRef(String(owned)));
    expect(resolved?.appAssets).toHaveLength(1);
    expect(resolved?.appAssets[0]?.id).toBe(String(owned));
    expect(new URL(resolved?.appAssets[0]?.url ?? "").protocol).toBe("https:");

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("customApps")
        .withIndex("by_token", (q) => q.eq("token", token))
        .first();
      await ctx.db.patch(row!._id, {
        html: '<img src="/app-assets/not-owned">',
      });
    });
    await expect(
      t.action(api.appAssetHostActions.resolveCustomAppForHost, { token }),
    ).rejects.toThrow(/unowned asset reference/i);
  });
});
