// Takes filmed on the Decibel meter with nobody linked: a BunnyPad at the back
// of the room films a scholar practising a talk, and every take is saved.
//
// A take is a portfolio item (source "decibel_meter") plus a
// `decibelMeterTakes` row for what the item has no place for (see schema.ts).
// The meter may name the speaker; otherwise the take lands in the scanner
// inbox untagged and staff file it the way they file a scan. When the take
// arrives with its sound as a separate small file, it is transcribed; a
// speaker who says their name ("Hi, I'm Hoku") is matched against the school
// the way a scan's written name is, and the transcript's opening words become
// the item's caption so a teacher can tell whose talk it is at a glance.
//
// Uploads are reserved before they're made and bound once they land
// (`generateUploadUrl`, `recordUpload`), and a take adopts only its own
// recorder's reservations; anything never adopted is swept (`expireUpload`).
// So a storage id seen elsewhere can't be adopted or deleted through here.
//
// The meter is often signed in as someone other than the speaker (a
// classmate's free BunnyPad, or a teacher's), so `recordedBy` is not an
// owner. The recorder may name or change the speaker, and discard the take,
// for RECORDER_WINDOW_MS after recording it, while still at that school and
// until staff touch the take at all; after that it is staff's, through the
// inbox.
//
// Tenancy: every take carries the recorder's school (`callerSchoolId`, the
// same rule live talks use), a named speaker must be a current scholar there,
// and the speaker list is that school's. Staff reads go through the
// portfolio's own access checks; nothing here reads another school.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { callerSchoolId, FACING_MAX_CHARS, LEVELS_MAX_CHARS } from "./liveTalks";
import { ROLES } from "./lib/roles";
import { isCurrentScholar } from "./lib/enrollmentStanding";
import {
  scholarIdsForInstitution,
  scholarInstitutionId,
} from "./lib/scholarEnrollment";
import { storageReferencedByAnotherOwner } from "./lib/storageReferences";
import { timeZoneForInstitution } from "./lib/institutionTime";
import { matchScholar } from "./lib/scholarMatch";
import { reconcilePortfolioMaterialization } from "./portfolioMaterialize";

/** How long the meter's own user may name the speaker or discard a take. */
export const RECORDER_WINDOW_MS = 12 * 60 * 60_000;
/** Uploads a recorder may reserve in any 24 hours (three a take), so one BunnyPad can't flood storage. */
export const DAILY_UPLOAD_LIMIT = 180;
/** About 13 minutes at the meter's 2.5 Mbps. */
export const VIDEO_MAX_BYTES = 250 * 1024 * 1024;
const POSTER_MAX_BYTES = 5 * 1024 * 1024;
/** Whisper's own limit; a bigger sound file is saved without a transcript. */
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
/**
 * How long a reserved upload waits to be adopted by a take before the sweep
 * deletes it (and how long a claimed one's receipt is kept).
 */
export const UPLOAD_HOLD_MS = 3 * 60 * 60_000;
/** The opening words of the transcript shown as the inbox caption. */
const CAPTION_WORDS = 18;

const DAY_MS = 24 * 60 * 60_000;

const zoneValidator = v.object({
  centerYaw: v.number(),
  centerPitch: v.number(),
  turnDeg: v.number(),
  tiltDeg: v.number(),
});

const uploadKindValidator = v.union(v.literal("video"), v.literal("poster"), v.literal("audio"));

function fail(kind: string, message: string): never {
  throw new ConvexError({ kind, message });
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) fail("invalid", `${label} isn't a number.`);
  return value;
}

async function requireSchool(
  ctx: MutationCtx,
  user: Doc<"users">,
): Promise<Id<"institutions">> {
  const institutionId = await callerSchoolId(ctx, user);
  if (!institutionId) fail("no_school", "Saving takes needs a school account.");
  return institutionId;
}

/** A current scholar at this school, or a refusal. */
async function requireSpeakerAt(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  institutionId: Id<"institutions">,
): Promise<Doc<"users">> {
  const scholar = await ctx.db.get(scholarId);
  if (
    !scholar ||
    (scholar.role !== ROLES.SCHOLAR && scholar.role !== ROLES.LIFELONG_LEARNER) ||
    !isCurrentScholar(scholar) ||
    (await scholarInstitutionId(ctx, scholarId)) !== institutionId
  ) {
    fail("invalid", "That scholar isn't at your school.");
  }
  return scholar;
}

/**
 * One of the caller's own reserved uploads, landed and not yet adopted.
 * Anything else is refused outright and left alone.
 */
async function requireOwnUpload(
  ctx: MutationCtx,
  user: Doc<"users">,
  uploadId: Id<"decibelMeterUploads">,
  kind: Doc<"decibelMeterUploads">["kind"],
) {
  const upload = await ctx.db.get(uploadId);
  if (!upload || upload.uploaderId !== user._id || upload.kind !== kind || !upload.storageId) {
    fail("invalid", "That upload wasn't found.");
  }
  const stored = await ctx.db.system.get(upload.storageId);
  if (!stored) fail("invalid", "That upload wasn't found.");
  return { upload, storageId: upload.storageId, stored };
}

/** The right kind of file, and not too big. */
function checkBlob(
  stored: { size: number; contentType?: string },
  kind: "video" | "image" | "audio",
  maxBytes: number,
  tooBig: string,
) {
  if (stored.size <= 0 || stored.size > maxBytes) fail("too_large", tooBig);
  const type = stored.contentType?.toLowerCase() ?? "";
  if (type && !type.startsWith(`${kind}/`)) fail("invalid", "That file isn't the right kind.");
}

function takeDate(now: number, timeZone: string): string {
  return new Date(now).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
}

/**
 * Replace the item's speakers with `scholarId` (or none), as the recorder,
 * and record that the recorder decided, so the transcript never overrides it.
 */
async function setRecorderSpeaker(
  ctx: MutationCtx,
  item: Doc<"portfolioItems">,
  take: Doc<"decibelMeterTakes">,
  recorderId: Id<"users">,
  scholarId: Id<"users"> | null,
) {
  const attributions = await ctx.db
    .query("portfolioAttributions")
    .withIndex("by_item", (q) => q.eq("portfolioItemId", item._id))
    .collect();
  for (const row of attributions) await ctx.db.delete(row._id);
  const now = Date.now();
  if (scholarId) {
    await ctx.db.insert("portfolioAttributions", {
      portfolioItemId: item._id,
      scholarId,
      attributedAt: now,
      attributedBy: recorderId,
    });
  }
  // A take is never for an assignment, so naming the speaker files it. The
  // sticky filed stamp (firstFiledAt) is left for staff to set: the recorder
  // may still take a mis-pick back to the inbox, where operations staff can
  // see it again.
  await ctx.db.patch(item._id, {
    scholarId: scholarId ?? undefined,
    matchStatus: scholarId ? "matched" : "unmatched",
    matchConfidence: undefined,
  });
  await ctx.db.patch(take._id, { speakerChosenAt: now });
  await reconcilePortfolioMaterialization(ctx, item._id);
}

/**
 * Whether staff have taken a take over from the BunnyPad that recorded it.
 * Every staff edit stamps the take (markStaffTookOver), so the hold never
 * comes back when staff undo a change; the item's own fields are checked
 * too, for anything that reached it another way: staff filing
 * (firstFiledAt), confirmed scholars, an assignment or activity, sharing with
 * families, or a scholar named by someone other than the recorder. A name
 * the transcript matched (no attributedBy) doesn't count: the recorder may
 * correct it.
 */
export function staffHaveTakenOver(
  item: Pick<
    Doc<"portfolioItems">,
    "firstFiledAt" | "matchStatus" | "assignmentStatus" | "assignmentId" | "activityId" | "familyVisibility"
  >,
  take: Pick<Doc<"decibelMeterTakes">, "staffTookOverAt">,
  attributions: readonly Pick<Doc<"portfolioAttributions">, "attributedBy">[],
  recorderId: Id<"users">,
): boolean {
  return (
    take.staffTookOverAt !== undefined ||
    item.firstFiledAt !== undefined ||
    item.matchStatus === "confirmed" ||
    (item.assignmentStatus ?? "unresolved") !== "none" ||
    item.assignmentId !== undefined ||
    item.activityId !== undefined ||
    item.familyVisibility !== "staff_only" ||
    attributions.some((row) => row.attributedBy !== undefined && row.attributedBy !== recorderId)
  );
}

/**
 * The recorder's hold on a take: their own, at the school they're still at,
 * recent, and not yet taken over by staff. Returns the item and its take row.
 */
async function requireRecorderHold(
  ctx: MutationCtx,
  user: Doc<"users">,
  portfolioItemId: Id<"portfolioItems">,
) {
  const item = await ctx.db.get(portfolioItemId);
  const take = item
    ? await ctx.db
        .query("decibelMeterTakes")
        .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", item._id))
        .unique()
    : null;
  if (
    !item ||
    item.source !== "decibel_meter" ||
    !take ||
    take.recordedBy !== user._id ||
    (await callerSchoolId(ctx, user)) !== take.institutionId
  ) {
    fail("not_found", "That take wasn't found.");
  }
  if (take._creationTime < Date.now() - RECORDER_WINDOW_MS) {
    fail("closed", "This take is with your teachers now.");
  }
  const attributions = await ctx.db
    .query("portfolioAttributions")
    .withIndex("by_item", (q) => q.eq("portfolioItemId", item._id))
    .collect();
  if (staffHaveTakenOver(item, take, attributions, user._id)) {
    fail("closed", "A teacher has filed this take.");
  }
  return { item, take };
}

// ── Public ─────────────────────────────────────────────────────────────

/**
 * Reserve one upload (a take's video, poster or sound) and get its URL. A
 * reservation not adopted by a take within UPLOAD_HOLD_MS is swept, its blob
 * with it.
 */
export const generateUploadUrl = authedMutation({
  args: { kind: uploadKindValidator },
  returns: v.object({ uploadUrl: v.string(), uploadId: v.id("decibelMeterUploads") }),
  handler: async (ctx, args) => {
    const institutionId = await requireSchool(ctx, ctx.user);
    const now = Date.now();
    const recent = await ctx.db
      .query("decibelMeterUploads")
      .withIndex("by_uploader", (q) => q.eq("uploaderId", ctx.user._id).gt("createdAt", now - DAY_MS))
      .take(DAILY_UPLOAD_LIMIT);
    if (recent.length >= DAILY_UPLOAD_LIMIT) {
      fail("limit", "This BunnyPad has saved a lot of takes today. Try again tomorrow.");
    }
    const uploadId = await ctx.db.insert("decibelMeterUploads", {
      uploaderId: ctx.user._id,
      institutionId,
      kind: args.kind,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(UPLOAD_HOLD_MS, internal.decibelMeter.expireUpload, { uploadId });
    return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadId };
  },
});

/**
 * Bind a landed upload to its reservation. Only a blob made after the
 * reservation, held by nothing else, can be bound: a storage id seen
 * elsewhere can't be passed off as the caller's own.
 */
export const recordUpload = authedMutation({
  args: { uploadId: v.id("decibelMeterUploads"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.uploadId);
    if (!upload || upload.uploaderId !== ctx.user._id) fail("not_found", "That upload wasn't found.");
    if (upload.storageId === args.storageId) return null; // reported twice
    if (upload.storageId || upload.claimedItemId) fail("invalid", "That upload is already recorded.");
    const stored = await ctx.db.system.get(args.storageId);
    if (
      !stored ||
      stored._creationTime < upload.createdAt ||
      stored._creationTime > upload.createdAt + UPLOAD_HOLD_MS
    ) {
      fail("invalid", "That upload wasn't found.");
    }
    if (await storageReferencedByAnotherOwner(ctx, args.storageId, { table: "decibelMeterTakes" })) {
      fail("invalid", "That upload belongs to something else.");
    }
    await ctx.db.patch(upload._id, { storageId: args.storageId });
    return null;
  },
});

/**
 * Save a take from the caller's own uploads (the video, and its poster and
 * sound when the BunnyPad made them), the meter's traces, and the speaker if
 * the meter decided one: a scholar, or null for "Leave it for a teacher".
 * Saving the same uploads twice returns the first save.
 */
export const saveTake = authedMutation({
  args: {
    videoUploadId: v.id("decibelMeterUploads"),
    posterUploadId: v.optional(v.id("decibelMeterUploads")),
    audioUploadId: v.optional(v.id("decibelMeterUploads")),
    durationMs: v.number(),
    levels: v.string(),
    frameMs: v.number(),
    roomDbfs: v.number(),
    thresholdDb: v.number(),
    facing: v.optional(v.string()),
    facingFrameMs: v.optional(v.number()),
    facingZone: v.optional(zoneValidator),
    scholarId: v.optional(v.union(v.id("users"), v.null())),
  },
  // A take this BunnyPad can't save (too long, a speaker who isn't at the
  // school any more…) comes back as `refused`, its uploads deleted, rather
  // than as an error that would leave them behind.
  returns: v.union(
    v.object({ portfolioItemId: v.id("portfolioItems") }),
    v.object({ refused: v.string() }),
  ),
  handler: async (ctx, args) => {
    const institutionId = await requireSchool(ctx, ctx.user);

    // A retried save after a dropped answer: hand back the first one.
    const videoUpload = await ctx.db.get(args.videoUploadId);
    if (videoUpload?.uploaderId === ctx.user._id && videoUpload.claimedItemId) {
      if (await ctx.db.get(videoUpload.claimedItemId)) {
        return { portfolioItemId: videoUpload.claimedItemId };
      }
      fail("closed", "That take has been discarded.");
    }

    const video = await requireOwnUpload(ctx, ctx.user, args.videoUploadId, "video");
    const poster = args.posterUploadId
      ? await requireOwnUpload(ctx, ctx.user, args.posterUploadId, "poster")
      : null;
    const audio = args.audioUploadId
      ? await requireOwnUpload(ctx, ctx.user, args.audioUploadId, "audio")
      : null;
    const uploads = [video, poster, audio].filter((u): u is NonNullable<typeof u> => u !== null);
    if (uploads.some((u) => u.upload.claimedItemId)) fail("invalid", "That upload is already part of a take.");
    if (new Set(uploads.map((u) => u.storageId)).size !== uploads.length) {
      fail("invalid", "Each upload must be its own file.");
    }

    let checked: Awaited<ReturnType<typeof checkTake>>;
    try {
      checked = await checkTake(ctx, args, institutionId, {
        video: video.stored,
        poster: poster?.stored ?? null,
        audio: audio?.stored ?? null,
      });
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      // The caller's own uploads, and only theirs: delete them with their reservations.
      for (const u of uploads) {
        await ctx.db.delete(u.upload._id);
        await ctx.storage.delete(u.storageId);
      }
      const message = (error.data as { message?: unknown } | null)?.message;
      return { refused: typeof message === "string" ? message : "This take couldn't be saved." };
    }
    const { durationMs, frameMs, thresholdDb, facing, speaker } = checked;

    const now = Date.now();
    const timeZone = await timeZoneForInstitution(ctx, institutionId);
    const portfolioItemId = await ctx.db.insert("portfolioItems", {
      institutionId,
      title: `Talk practice · ${takeDate(now, timeZone)}`,
      source: "decibel_meter",
      fileStorageId: video.storageId,
      fileMimeType: video.stored.contentType?.toLowerCase() || "video/quicktime",
      fileSizeBytes: video.stored.size,
      ...(poster ? { thumbStorageId: poster.storageId, thumbStatus: "ready" as const } : {}),
      matchStatus: "unmatched",
      // A practice talk belongs to no assignment: naming the speaker files it.
      assignmentStatus: "none",
      processingStatus: "ready",
      familyVisibility: "staff_only",
      uploadedBy: ctx.user._id,
    });
    // Receipts now: the take owns the blobs.
    for (const u of uploads) await ctx.db.patch(u.upload._id, { claimedItemId: portfolioItemId });
    const takeId = await ctx.db.insert("decibelMeterTakes", {
      portfolioItemId,
      institutionId,
      recordedBy: ctx.user._id,
      durationMs,
      levels: args.levels,
      frameMs,
      roomDbfs: checked.roomDbfs,
      thresholdDb,
      ...facing,
      ...(audio ? { audioStorageId: audio.storageId, transcriptStatus: "pending" as const } : {}),
    });
    if (args.scholarId !== undefined) {
      const item = await ctx.db.get(portfolioItemId);
      const take = await ctx.db.get(takeId);
      if (item && take) await setRecorderSpeaker(ctx, item, take, ctx.user._id, speaker?._id ?? null);
    }
    if (audio) {
      await ctx.scheduler.runAfter(0, internal.audioActions.transcribeMeterTake, {
        portfolioItemId,
      });
    }
    return { portfolioItemId };
  },
});

/**
 * Sweep one reservation: an upload no take adopted is deleted with its blob;
 * a claimed one's receipt is dropped.
 */
export const expireUpload = internalMutation({
  args: { uploadId: v.id("decibelMeterUploads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.uploadId);
    if (!upload) return null;
    await ctx.db.delete(upload._id);
    if (
      !upload.claimedItemId &&
      upload.storageId &&
      !(await storageReferencedByAnotherOwner(ctx, upload.storageId, { table: "decibelMeterTakes" }))
    ) {
      await ctx.storage.delete(upload.storageId);
    }
    return null;
  },
});

/** Everything about a take but its uploads' ownership; refusals here come back as `refused`. */
async function checkTake(
  ctx: MutationCtx,
  args: {
    durationMs: number;
    levels: string;
    frameMs: number;
    roomDbfs: number;
    thresholdDb: number;
    facing?: string;
    facingFrameMs?: number;
    facingZone?: { centerYaw: number; centerPitch: number; turnDeg: number; tiltDeg: number };
    scholarId?: Id<"users"> | null;
  },
  institutionId: Id<"institutions">,
  blobs: {
    video: { size: number; contentType?: string };
    poster: { size: number; contentType?: string } | null;
    audio: { size: number; contentType?: string } | null;
  },
) {
  checkBlob(blobs.video, "video", VIDEO_MAX_BYTES, "This take is too long to save.");
  if (blobs.poster) checkBlob(blobs.poster, "image", POSTER_MAX_BYTES, "The take's picture is too large.");
  if (blobs.audio) checkBlob(blobs.audio, "audio", AUDIO_MAX_BYTES, "This take is too long to write out.");
  if (args.levels.length > LEVELS_MAX_CHARS) fail("invalid", "The loudness trace is too long.");
  const durationMs = finiteNumber(args.durationMs, "Duration");
  const frameMs = finiteNumber(args.frameMs, "Frame length");
  if (durationMs < 0 || frameMs <= 0) fail("invalid", "Duration and frame length must be positive.");
  const thresholdDb = finiteNumber(args.thresholdDb, "Threshold");
  if (thresholdDb < 0 || thresholdDb > 60) fail("invalid", "The threshold is out of range.");
  let facing: Pick<Doc<"decibelMeterTakes">, "facing" | "facingFrameMs" | "facingZone"> = {};
  if (args.facing !== undefined && args.facingFrameMs !== undefined) {
    if (args.facing.length > FACING_MAX_CHARS) fail("invalid", "The head-direction trace is too long.");
    const facingFrameMs = finiteNumber(args.facingFrameMs, "Head direction frame length");
    if (facingFrameMs <= 0) fail("invalid", "Head direction frame length must be positive.");
    facing = { facing: args.facing, facingFrameMs };
    if (args.facingZone) {
      const zone = args.facingZone;
      const inRange = (n: number, lo: number, hi: number) =>
        Number.isFinite(n) && n >= lo && n <= hi;
      if (
        !inRange(zone.centerYaw, -90, 90) ||
        !inRange(zone.centerPitch, -90, 90) ||
        !inRange(zone.turnDeg, 1, 90) ||
        !inRange(zone.tiltDeg, 1, 90)
      ) {
        fail("invalid", "The facing zone is out of range.");
      }
      facing.facingZone = zone;
    }
  }
  const speaker = args.scholarId
    ? await requireSpeakerAt(ctx, args.scholarId, institutionId)
    : null;
  const roomDbfs = finiteNumber(args.roomDbfs, "Room level");
  return { durationMs, frameMs, thresholdDb, facing, speaker, roomDbfs };
}

/** Name the speaker of a take this BunnyPad saved, or clear it (back to the inbox). */
export const setSpeaker = authedMutation({
  args: {
    portfolioItemId: v.id("portfolioItems"),
    scholarId: v.union(v.id("users"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { item, take } = await requireRecorderHold(ctx, ctx.user, args.portfolioItemId);
    if (args.scholarId) await requireSpeakerAt(ctx, args.scholarId, take.institutionId);
    await setRecorderSpeaker(ctx, item, take, ctx.user._id, args.scholarId);
    return null;
  },
});

/** Delete a take this BunnyPad saved: the video, its poster, sound and traces. */
export const discardTake = authedMutation({
  args: { portfolioItemId: v.id("portfolioItems") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.portfolioItemId);
    if (!item) return null; // already gone: discarding twice is fine
    const { take } = await requireRecorderHold(ctx, ctx.user, args.portfolioItemId);
    await deleteMeterTake(ctx, item, take);
    return null;
  },
});

/**
 * The meter's view of takes it saved: who it's filed to, and the transcript
 * once it's written. Only the caller's own takes; others are left out.
 */
export const takesForRecorder = authedQuery({
  args: { portfolioItemIds: v.array(v.id("portfolioItems")) },
  handler: async (ctx, args) => {
    // Someone who has left the school keeps no view of what they recorded there.
    const institutionId = await callerSchoolId(ctx, ctx.user);
    if (!institutionId) return [];
    const out = [];
    for (const portfolioItemId of args.portfolioItemIds.slice(0, 20)) {
      const take = await ctx.db
        .query("decibelMeterTakes")
        .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", portfolioItemId))
        .unique();
      if (!take || take.recordedBy !== ctx.user._id || take.institutionId !== institutionId) continue;
      const item = await ctx.db.get(portfolioItemId);
      if (!item) continue;
      const attributions = await ctx.db
        .query("portfolioAttributions")
        .withIndex("by_item", (q) => q.eq("portfolioItemId", portfolioItemId))
        .collect();
      const speaker = attributions[0] ? await ctx.db.get(attributions[0].scholarId) : null;
      out.push({
        portfolioItemId,
        speakerId: speaker?._id ?? null,
        speakerName: speaker ? peerName(speaker) : null,
        // Staff taking the take over ends this BunnyPad's say over it.
        filedByTeacher: staffHaveTakenOver(item, take, attributions, ctx.user._id),
        transcriptStatus: take.transcriptStatus ?? null,
        transcriptSegments: take.transcriptSegments ?? null,
        wordCount: take.wordCount ?? null,
        fillerCount: take.fillerCount ?? null,
      });
    }
    return out;
  },
});

/** The current scholars at the caller's school, for "Whose talk is this?". */
export const speakers = authedQuery({
  args: {},
  handler: async (ctx) => {
    const institutionId = await callerSchoolId(ctx, ctx.user);
    if (!institutionId) return [];
    const ids = await scholarIdsForInstitution(ctx, institutionId);
    const scholars = [];
    for (const id of ids) {
      const scholar = await ctx.db.get(id);
      if (scholar && isCurrentScholar(scholar)) scholars.push(scholar);
    }
    return pickerNames(scholars).sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Names for "Whose talk is this?": first name and last initial, except where
 * two scholars would read the same ("Koa M." twice), which show their whole
 * names so the right one can be picked.
 */
export function pickerNames(
  scholars: readonly Pick<Doc<"users">, "_id" | "firstName" | "lastName" | "name" | "username">[],
): { id: Id<"users">; name: string }[] {
  const short = scholars.map((scholar) => ({ scholar, name: peerName(scholar) }));
  const uses = new Map<string, number>();
  for (const { name } of short) uses.set(name, (uses.get(name) ?? 0) + 1);
  return short.map(({ scholar, name }) => ({
    id: scholar._id,
    name:
      (uses.get(name) ?? 0) > 1
        ? (scholar.name?.trim() ||
          [scholar.firstName, scholar.lastName].filter(Boolean).join(" ") ||
          name)
        : name,
  }));
}

/**
 * A classmate's name as a scholar account may see it: first name and last
 * initial ("Kai K."), enough to tell two Kais apart.
 */
export function peerName(user: Pick<Doc<"users">, "firstName" | "lastName" | "name" | "username">): string {
  const words = user.name?.trim().split(/\s+/) ?? [];
  const first = user.firstName?.trim() || words[0] || user.username?.trim() || "Scholar";
  const last = user.lastName?.trim() || (words.length > 1 ? words[words.length - 1] : "");
  return last ? `${first} ${last[0]}.` : first;
}

// ── Deleting ───────────────────────────────────────────────────────────

/**
 * Delete a take's item and everything it holds. The same steps
 * `portfolio.deletePortfolioItem` takes for any item, done here so a
 * recorder's discard needs no staff gate.
 */
async function deleteMeterTake(
  ctx: MutationCtx,
  item: Doc<"portfolioItems">,
  take: Doc<"decibelMeterTakes">,
) {
  const blobs = [item.fileStorageId, item.thumbStorageId, take.audioStorageId];
  const attributions = await ctx.db
    .query("portfolioAttributions")
    .withIndex("by_item", (q) => q.eq("portfolioItemId", item._id))
    .collect();
  for (const row of attributions) await ctx.db.delete(row._id);
  await ctx.db.delete(take._id);
  await ctx.db.delete(item._id);
  await reconcilePortfolioMaterialization(ctx, item._id);
  for (const id of new Set(blobs.filter((b): b is Id<"_storage"> => b !== undefined))) {
    if (!(await storageReferencedByAnotherOwner(ctx, id, { table: "decibelMeterTakes" }))) {
      await ctx.storage.delete(id);
    }
  }
}

// ── Transcribing (audioActions.transcribeMeterTake) ────────────────────

export const takeForTranscription = internalQuery({
  args: { portfolioItemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    const take = await ctx.db
      .query("decibelMeterTakes")
      .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", args.portfolioItemId))
      .unique();
    if (!take?.audioStorageId || take.transcriptStatus !== "pending") return null;
    return { audioStorageId: take.audioStorageId, durationMs: take.durationMs };
  },
});

/** The take's sound file, once its row has let go of it, unless something else holds it. */
async function deleteAudioIfUnowned(ctx: MutationCtx, audioStorageId: Id<"_storage"> | undefined) {
  if (
    audioStorageId &&
    !(await storageReferencedByAnotherOwner(ctx, audioStorageId, { table: "decibelMeterTakes" }))
  ) {
    await ctx.storage.delete(audioStorageId);
  }
}

/** Words worth counting as fillers. "Like" and "so" are left out: too often real words. */
const FILLER = /\b(?:u+m+|u+h+|e+r+m+|a+h+|h+m+)\b/gi;

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length;
}

export function countFillers(text: string): number {
  return text.match(FILLER)?.length ?? 0;
}

/**
 * A name the speaker gives for themselves near the start ("my name is Hoku",
 * "I'm Hoku"), for matching against the school. Null when there is none.
 */
export function selfIntroducedName(text: string): string | null {
  const opening = text.split(/\s+/).slice(0, 40).join(" ");
  const match = opening.match(
    // The lead-in in any case, the name capitalized (Whisper capitalizes
    // names, so "I'm going to…" doesn't read as a name). "This is …" is left
    // out: it as often introduces a partner or a picture.
    /\b(?:[Mm]y name is|[Mm]y name['’]s|I am|I['’]m)\s+([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)?)/,
  );
  return match?.[1] ?? null;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function meterCaption(text: string, durationMs: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const opening = words.slice(0, CAPTION_WORDS).join(" ");
  const quote = opening ? `“${opening}${words.length > CAPTION_WORDS ? "…" : ""}” · ` : "";
  const minutes = durationMs / 60_000;
  const pace =
    minutes >= 0.25 && words.length > 0
      ? ` · ${Math.round(countWords(text) / minutes)} words a minute`
      : "";
  return `${quote}${clock(durationMs)} talk${pace}`;
}

export const saveTranscript = internalMutation({
  args: {
    portfolioItemId: v.id("portfolioItems"),
    text: v.string(),
    // [[startMs, endMs, text], ...]
    segments: v.array(v.array(v.union(v.number(), v.string()))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const take = await ctx.db
      .query("decibelMeterTakes")
      .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", args.portfolioItemId))
      .unique();
    const item = await ctx.db.get(args.portfolioItemId);
    if (!take || !item) return null; // discarded while it was being written
    const text = args.text.trim();
    await ctx.db.patch(take._id, {
      transcriptStatus: "ready",
      transcriptSegments: JSON.stringify(args.segments),
      wordCount: countWords(text),
      fillerCount: countFillers(text),
      audioStorageId: undefined,
    });
    await deleteAudioIfUnowned(ctx, take.audioStorageId);

    const name = selfIntroducedName(text);
    await ctx.db.patch(item._id, {
      ...(text ? { extractedText: text } : {}),
      aiCaption: meterCaption(text, take.durationMs),
      ...(name ? { detectedName: name } : {}),
    });

    // Name the speaker from what they said, the way a scan's written name is
    // matched, but only while nobody has named one.
    // Only while nobody has decided: not the recorder (even "Leave it for a
    // teacher"), not staff.
    const untagged =
      take.speakerChosenAt === undefined &&
      take.staffTookOverAt === undefined &&
      item.matchStatus === "unmatched" &&
      (
        await ctx.db
          .query("portfolioAttributions")
          .withIndex("by_item", (q) => q.eq("portfolioItemId", item._id))
          .first()
      ) === null;
    if (name && untagged) {
      const roster = [];
      for (const id of await scholarIdsForInstitution(ctx, take.institutionId)) {
        const scholar = await ctx.db.get(id);
        if (scholar && isCurrentScholar(scholar)) {
          roster.push({ id: scholar._id, name: scholar.name ?? "", username: scholar.username });
        }
      }
      const result = matchScholar(name, roster);
      if (result.status === "matched" && result.scholarId) {
        await ctx.db.insert("portfolioAttributions", {
          portfolioItemId: item._id,
          scholarId: result.scholarId as Id<"users">,
          attributedAt: Date.now(),
        });
        await ctx.db.patch(item._id, {
          scholarId: result.scholarId as Id<"users">,
          matchStatus: "matched",
          matchConfidence: result.confidence,
        });
        await reconcilePortfolioMaterialization(ctx, item._id);
      } else if (result.status === "ambiguous") {
        await ctx.db.patch(item._id, {
          matchStatus: "ambiguous",
          matchConfidence: result.confidence,
        });
      }
    }
    return null;
  },
});

export const transcriptFailed = internalMutation({
  args: { portfolioItemId: v.id("portfolioItems") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const take = await ctx.db
      .query("decibelMeterTakes")
      .withIndex("by_portfolio_item", (q) => q.eq("portfolioItemId", args.portfolioItemId))
      .unique();
    if (!take) return null;
    await ctx.db.patch(take._id, { transcriptStatus: "error", audioStorageId: undefined });
    await deleteAudioIfUnowned(ctx, take.audioStorageId);
    return null;
  },
});
