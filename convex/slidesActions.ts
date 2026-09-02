// Read-only Google Slides / Drive actions called from the activity editor.
// Teachers can attach and inspect metadata for existing Google decks. Rabbit
// Slides authoring remains separate from this Google metadata path.

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireCurriculumAccessAction } from "./lib/auth";
import {
  getValidAccessToken,
  getValidAccessTokenForCredential,
} from "./lib/googleTokens";
import { INSTITUTION_WORKSPACE_BOT_SCOPES } from "./lib/google";
import {
  presentationPrincipalForActingUser,
} from "./lib/activityPresentationResources";

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  thumbnailLink?: string;
}

const DRIVE_FIELDS = "id,name,mimeType,webViewLink,thumbnailLink";

/**
 * Fetch Drive metadata for a presentation, including a thumbnail URL.
 * Drive's thumbnailLink is a googleusercontent.com URL that the browser
 * can render in an <img> tag without re-auth — long-lived enough to
 * cache on the activity row.
 */
async function fetchDriveMetadata(
  accessToken: string,
  fileId: string
): Promise<DriveFile> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=${DRIVE_FIELDS}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(
      `Drive metadata fetch failed (${res.status}): ${await res.text()}`
    );
  }
  return (await res.json()) as DriveFile;
}

/**
 * Confirm the OAuth user can read the deck the picker handed back.
 * Returns metadata if reachable; throws otherwise. The frontend uses
 * this to fail loudly before persisting an unreadable presentationId.
 */
export const verifyDeckAccess = action({
  args: { presentationId: v.string() },
  handler: async (ctx, args): Promise<DriveFile> => {
    const userId = await requireCurriculumAccessAction(ctx);
    const accessToken = await getValidAccessToken(ctx, userId);
    return await fetchDriveMetadata(accessToken, args.presentationId);
  },
});

/**
 * Re-fetch name + thumbnail for the activity's attached deck and
 * persist them. Used by the "refresh" button in the UI when the cached
 * metadata is stale (deck renamed in Google Slides, thumbnail
 * generated after the initial create, etc.).
 */
export const refreshDeckMetadata = action({
  args: { activityId: v.id("activities") },
  handler: async (
    ctx,
    args
  ): Promise<{ name?: string; thumbnailUrl?: string }> => {
    const userId = await requireCurriculumAccessAction(ctx);
    const activity = await ctx.runQuery(
      internal.activities.getForExportInternal,
      { id: args.activityId, userId },
    );
    if (!activity) throw new Error("Activity not found");
    if (!activity.googleSlidesPresentationId) {
      throw new Error("Activity has no Google Slides deck attached");
    }
    if (!activity.googleSlidesPrincipal) {
      throw new Error(
        "This deck's Google credential is unknown. Reattach it from Drive before refreshing metadata.",
      );
    }
    const principal = presentationPrincipalForActingUser(
      activity.googleSlidesPrincipal,
      userId,
    );
    const accessToken =
      principal.kind === "personal_oauth"
        ? await getValidAccessToken(ctx, userId)
        : await getValidAccessTokenForCredential(
            ctx,
            principal.credentialId,
            INSTITUTION_WORKSPACE_BOT_SCOPES,
          );
    const meta = await fetchDriveMetadata(
      accessToken,
      activity.googleSlidesPresentationId
    );
    await ctx.runMutation(internal.activities.attachGoogleSlidesDeckInternal, {
      id: args.activityId,
      presentationId: activity.googleSlidesPresentationId,
      url:
        meta.webViewLink ??
        activity.googleSlidesUrl ??
        `https://docs.google.com/presentation/d/${activity.googleSlidesPresentationId}/edit`,
      name: meta.name,
      thumbnailUrl: meta.thumbnailLink,
      principal,
    });
    return { name: meta.name, thumbnailUrl: meta.thumbnailLink };
  },
});
