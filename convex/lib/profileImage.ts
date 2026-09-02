// Shared validation for scholar/parent profile-photo uploads.
//
// One allow-list, one code path. The accepted image MIME set is DERIVED from
// the scanner-inbox allow-list in ./ingestMimes (the single source of truth for
// "MIME types this app is willing to accept") by keeping only its image types.
// Do NOT hand-maintain a second list here — if ingest gains/loses an image
// type, this subset follows automatically.
//
// Why we validate `metadata.contentType` (not the raw bytes): a profile photo
// is set from a *mutation* (updateProfile / adminUpdateScholarProfile /
// setChildPhoto), and mutations cannot read blob bytes — `ctx.storage.get()`
// (which returns the Blob) is action-only. The mutation-available signal is the
// stored content-type, which is ALSO the type Convex serves the file with, so
// gating it to a safe raster set is exactly what protects the `<img>` that
// renders the avatar (an SVG/HTML upload carries a non-image content-type and
// is rejected). This mirrors the existing `activityResources.registerFile`
// validation, which likewise trusts `metadata.contentType` in a mutation.
//
// Callers (users.updateProfile self, users.adminUpdateScholarProfile for
// staff/operations staff, parents.setChildPhoto for guardians) all funnel their
// `imageStorageId` handling through resolveValidatedProfileImageUrl so the MIME
// + size contract is identical no matter who sets the avatar.

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { INGESTIBLE_MIMES } from "./ingestMimes";

/**
 * The image subset of the ingest allow-list (jpeg/png/webp/gif) — the MIME
 * types allowed for a profile photo. Derived, never independently authored.
 */
export const PROFILE_IMAGE_MIMES: ReadonlySet<string> = new Set(
  [...INGESTIBLE_MIMES].filter((mime) => mime.startsWith("image/")),
);

/** Hard cap on a profile-photo upload: 5 MB. */
export const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Pure validation predicate for a profile-photo upload's storage metadata.
 * Throws when the declared content-type isn't an allowed image type, or the
 * file exceeds the size cap. Returns the validated content-type. Kept pure (no
 * ctx) so the MIME + size contract is unit-testable without a storage backend —
 * convex-test's storage mock records only size + sha256, never a content-type.
 */
export function assertAllowedProfileImage(
  contentType: string | undefined | null,
  size: number,
): string {
  const type = contentType ?? "";
  if (!PROFILE_IMAGE_MIMES.has(type)) {
    throw new Error(
      `Unsupported image type${type ? ` (${type})` : ""}. ` +
        "Allowed: JPEG, PNG, WebP, GIF.",
    );
  }
  if (size > MAX_PROFILE_IMAGE_BYTES) {
    throw new Error("Image is too large (max 5 MB).");
  }
  return type;
}

/**
 * Validate a freshly-uploaded storage blob as a profile photo and return its
 * serving URL. Throws (never returns a bad URL) when the blob is missing, isn't
 * an allowed image type, or exceeds the size cap. Shared by every surface that
 * writes `users.image` from an upload.
 */
export async function resolveValidatedProfileImageUrl(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<string> {
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (!metadata) {
    throw new Error("Uploaded image is unavailable");
  }

  assertAllowedProfileImage(metadata.contentType, metadata.size);

  const url = await ctx.storage.getUrl(storageId);
  if (!url) {
    throw new Error("Uploaded image is unavailable");
  }
  return url;
}
