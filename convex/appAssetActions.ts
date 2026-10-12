"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { toStorageBlob, sniffImageMime } from "./lib/imageBytes";
import {
  MAX_APP_ASSET_BYTES,
  MAX_APP_ASSET_DIMENSION,
} from "../shared/appAssets";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const DIMENSION_STEPS = [1024, 896, 768, 640, 512] as const;
const JPEG_QUALITY_STEPS = [82, 72, 62, 52, 42] as const;

type NormalizedImage = {
  storageId: Id<"_storage">;
  mimeType: "image/jpeg" | "image/webp";
  sizeBytes: number;
  width: number;
  height: number;
};

export const normalizeStoredImage = internalAction({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }): Promise<NormalizedImage | null> => {
    let keepSource = false;
    try {
      const blob = await ctx.storage.get(storageId);
      if (!blob) return null;
      const source = new Uint8Array(await blob.arrayBuffer());
      if (source.byteLength === 0 || source.byteLength > MAX_SOURCE_BYTES) {
        return null;
      }

      const photon = await import("@cf-wasm/photon/node");
      const image = photon.PhotonImage.new_from_byteslice(source);
      try {
        const sourceWidth = image.get_width();
        const sourceHeight = image.get_height();
        const sourceMime = sniffImageMime(source);
        if (
          (sourceMime === "image/jpeg" || sourceMime === "image/webp") &&
          source.byteLength <= MAX_APP_ASSET_BYTES &&
          sourceWidth <= MAX_APP_ASSET_DIMENSION &&
          sourceHeight <= MAX_APP_ASSET_DIMENSION
        ) {
          keepSource = true;
          return {
            storageId,
            mimeType: sourceMime,
            sizeBytes: source.byteLength,
            width: sourceWidth,
            height: sourceHeight,
          };
        }

        const dimensionSteps = [
          ...new Set([
            Math.min(
              MAX_APP_ASSET_DIMENSION,
              Math.max(sourceWidth, sourceHeight),
            ),
            ...DIMENSION_STEPS,
          ]),
        ].filter((dimension) => dimension <= MAX_APP_ASSET_DIMENSION);

        for (const maxDimension of dimensionSteps) {
          const scale = Math.min(
            maxDimension / sourceWidth,
            maxDimension / sourceHeight,
            1,
          );
          const fitted =
            scale < 1
              ? photon.resize(
                  image,
                  Math.max(1, Math.round(sourceWidth * scale)),
                  Math.max(1, Math.round(sourceHeight * scale)),
                  photon.SamplingFilter.Lanczos3,
                )
              : image;
          try {
            const width = fitted.get_width();
            const height = fitted.get_height();
            const webp = fitted.get_bytes_webp();
            if (webp.byteLength <= MAX_APP_ASSET_BYTES) {
              const normalizedStorageId = await ctx.storage.store(
                toStorageBlob(webp, "image/webp"),
              );
              return {
                storageId: normalizedStorageId,
                mimeType: "image/webp",
                sizeBytes: webp.byteLength,
                width,
                height,
              };
            }
            for (const quality of JPEG_QUALITY_STEPS) {
              const jpeg = fitted.get_bytes_jpeg(quality);
              if (jpeg.byteLength <= MAX_APP_ASSET_BYTES) {
                const normalizedStorageId = await ctx.storage.store(
                  toStorageBlob(jpeg, "image/jpeg"),
                );
                return {
                  storageId: normalizedStorageId,
                  mimeType: "image/jpeg",
                  sizeBytes: jpeg.byteLength,
                  width,
                  height,
                };
              }
            }
          } finally {
            if (fitted !== image) fitted.free();
          }
        }
        return null;
      } finally {
        image.free();
      }
    } catch (error) {
      console.error("[appAssets] image normalization failed", error);
      return null;
    } finally {
      if (!keepSource) {
        try {
          await ctx.storage.delete(storageId);
        } catch {
          // The temporary source may already have been reclaimed.
        }
      }
    }
  },
});
