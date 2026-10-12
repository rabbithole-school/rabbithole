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
});
