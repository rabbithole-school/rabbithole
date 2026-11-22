import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { internal } from "../_generated/api";
import {
  MAX_APP_ASSET_BYTES,
  MAX_APP_ASSET_DIMENSION,
} from "../../shared/appAssets";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("app asset image normalization", () => {
  test("downscales and re-encodes a source image within the app caps", async () => {
    const photon = await import("@cf-wasm/photon/node");
    const width = MAX_APP_ASSET_DIMENSION + 200;
    const height = 4;
    const pixels = new Uint8Array(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 30;
      pixels[index + 1] = 160;
      pixels[index + 2] = 210;
      pixels[index + 3] = 255;
    }
    const image = new photon.PhotonImage(pixels, width, height);
    const png = image.get_bytes();
    image.free();

    const t = convexTest(schema, modules);
    const sourceId = await t.run((ctx) =>
      ctx.storage.store(new Blob([png as BlobPart], { type: "image/png" })),
    );
    const normalized = await t.action(
      internal.appAssetActions.normalizeStoredImage,
      { storageId: sourceId },
    );

    expect(normalized).not.toBeNull();
    expect(normalized?.width).toBeLessThanOrEqual(MAX_APP_ASSET_DIMENSION);
    expect(normalized?.height).toBeLessThanOrEqual(MAX_APP_ASSET_DIMENSION);
    expect(normalized?.sizeBytes).toBeLessThanOrEqual(MAX_APP_ASSET_BYTES);
    expect(["image/jpeg", "image/webp"]).toContain(normalized?.mimeType);
    expect(normalized?.storageId).not.toBe(sourceId);
    expect(await t.run((ctx) => ctx.storage.get(sourceId))).toBeNull();
  });

  test("prepareSessionPhotoAssets gives a chat photo an app-usable copy and keeps the photo", async () => {
    const photon = await import("@cf-wasm/photon/node");
    const width = MAX_APP_ASSET_DIMENSION + 200;
    const height = 4;
    const pixels = new Uint8Array(width * height * 4).fill(120);
    const image = new photon.PhotonImage(pixels, width, height);
    const png = image.get_bytes();
    image.free();

    const t = convexTest(schema, modules);
    const { sessionId, messageId, photoId, toolImageId, gifMessageId } = await t.run(
      async (ctx) => {
        const userId = await ctx.db.insert("users", {
          name: "Photo scholar",
          username: "photo-scholar",
          role: "scholar",
        });
        const sessionId = await ctx.db.insert("sessions", {
          userId,
          title: "Photo app",
          isArchived: false,
        });
        const photoId = await ctx.storage.store(
          new Blob([png as BlobPart], { type: "image/png" }),
        );
        const messageId = await ctx.db.insert("messages", {
          sessionId,
          role: "user",
          content: "use my map",
          flagged: false,
          imageId: photoId,
        });
        // The tutor's own picture is already an app asset: left alone.
        const toolImageId = await ctx.storage.store(
          new Blob([png as BlobPart], { type: "image/png" }),
        );
        await ctx.db.insert("messages", {
          sessionId,
          role: "tool",
          content: "A drawing",
          flagged: false,
          imageId: toolImageId,
        });
        // An upload no copy can be made from: marked, not retried.
        const gifId = await ctx.storage.store(
          new Blob([new Uint8Array([0x47, 0x49, 0x46, 0x38])], {
            type: "image/gif",
          }),
        );
        const gifMessageId = await ctx.db.insert("messages", {
          sessionId,
          role: "user",
          content: "and this one",
          flagged: false,
          imageId: gifId,
        });
        return { sessionId, messageId, photoId, toolImageId, gifMessageId };
      },
    );

    const prepared = await t.action(
      internal.appAssetActions.prepareSessionPhotoAssets,
      { sessionId },
    );
    expect(prepared).toHaveLength(1);
    expect(prepared[0].messageId).toBe(messageId);
    const message = await t.run((ctx) => ctx.db.get(messageId));
    expect(message?.appAssetId).toBe(prepared[0].appAssetId);
    expect(message?.appAssetId).not.toBe(photoId);
    // The chat photo the message shows is still there (metadata, not the
    // blob: convex-test cannot return a Blob from t.run).
    expect(
      await t.run((ctx) => ctx.storage.getMetadata(photoId)),
    ).not.toBeNull();
    const copy = await t.run((ctx) =>
      ctx.storage.getMetadata(prepared[0].appAssetId),
    );
    expect(copy?.size).toBeLessThanOrEqual(MAX_APP_ASSET_BYTES);
    const toolMessage = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("messages")
          .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
          .collect()
      ).find((row) => row.imageId === toolImageId),
    );
    expect(toolMessage?.appAssetId).toBeUndefined();
    const gifMessage = await t.run((ctx) => ctx.db.get(gifMessageId));
    expect(gifMessage?.appAssetId).toBeUndefined();
    expect(gifMessage?.appAssetUnavailable).toBe(true);

    // Idempotent: nothing left to prepare.
    expect(
      await t.action(internal.appAssetActions.prepareSessionPhotoAssets, {
        sessionId,
      }),
    ).toEqual([]);
  });
});
