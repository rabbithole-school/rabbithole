"use node";

// Downscale an oversized Slack image so the Slack bot can actually SEE it —
// instead of going blind on it. Runs in the Convex NODE runtime because it uses
// the `@cf-wasm/photon` WASM build via its `/node` subpath; the bare/workerd
// build imports a `.wasm` module the default Convex runtime can't bundle (the
// exact reason convex/lib/thumbnail.ts is also "use node").
//
// Why this exists (real incident, 2026-07-23): Anthropic caps a single vision
// image at 5 MB of raw bytes. A modern phone screenshot/photo routinely exceeds
// that, so the Slack image collector used to simply DROP any file over 5 MB —
// the bot then only saw the filename and, in the wild, sometimes hallucinated
// about a screenshot it never actually received. Anthropic already downsamples
// anything past ~1568px on the long edge before the model sees it, so a full-res
// photo is pure waste; re-fitting it into that box and re-encoding as JPEG
// brings essentially every real screenshot/photo comfortably under the limit
// with no meaningful loss of legibility.
//
// Contract: hand it a Slack `url_private_download` + the bot token; it fetches,
// shrinks, and returns a base64 JPEG under the per-image ceiling — or `null` if
// the file can't be fetched, decoded, or squeezed under the limit (the caller
// then leaves the attachment as a text descriptor). Args + return stay tiny (a
// URL in, a small JPEG out), so this never approaches Convex's function size
// limits — the multi-MB source never crosses the action boundary.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { downloadSlackFile } from "./lib/slackApi";
import { bytesToBase64 } from "./lib/imageBytes";

/** Anthropic's per-image ceiling (raw bytes). Kept in step with the Slack
 *  collector's `MAX_IMAGE_BYTES`. */
const CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Anthropic resizes anything past this on the long edge before it ever reaches
 *  the model, so there's no reason to send a larger raster. */
const TARGET_LONG_EDGE = 1568;
/** Never pull an absurdly large "image" into the node action just to shrink it
 *  (bounds memory + runtime). 12 MB comfortably covers any real phone photo. */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
/** Progressive JPEG quality ladder — stop at the first that fits the ceiling. */
const QUALITY_LADDER = [82, 70, 55, 40] as const;

export const fetchAndDownscale = internalAction({
  args: { url: v.string(), token: v.string() },
  returns: v.union(
    v.object({ dataBase64: v.string(), mediaType: v.literal("image/jpeg") }),
    v.null(),
  ),
  handler: async (_ctx, { url, token }) => {
    try {
      const blob = await downloadSlackFile(token, url);
      if (!blob) return null;
      const source = new Uint8Array(await blob.arrayBuffer());
      if (source.byteLength === 0 || source.byteLength > MAX_SOURCE_BYTES) {
        return null;
      }

      // The `/node` subpath = inlined-wasm build (the bare specifier resolves to
      // the workerd build under Convex's esbuild and traps at runtime). Mirrors
      // convex/lib/thumbnail.ts.
      const photon = await import("@cf-wasm/photon/node");
      const img = photon.PhotonImage.new_from_byteslice(source);
      try {
        const w = img.get_width();
        const h = img.get_height();
        const scale = Math.min(TARGET_LONG_EDGE / w, TARGET_LONG_EDGE / h, 1);
        const fitted =
          scale < 1
            ? photon.resize(
                img,
                Math.max(1, Math.round(w * scale)),
                Math.max(1, Math.round(h * scale)),
                photon.SamplingFilter.Lanczos3,
              )
            : img;
        try {
          for (const quality of QUALITY_LADDER) {
            const jpeg = fitted.get_bytes_jpeg(quality);
            if (jpeg.byteLength <= CLAUDE_MAX_IMAGE_BYTES) {
              return {
                dataBase64: bytesToBase64(jpeg),
                mediaType: "image/jpeg" as const,
              };
            }
          }
          // Couldn't fit even at the lowest quality — leave it as a descriptor.
          return null;
        } finally {
          if (fitted !== img) fitted.free();
        }
      } finally {
        img.free();
      }
    } catch (err) {
      console.error("[slackImageResize] downscale failed:", err);
      return null;
    }
  },
});
