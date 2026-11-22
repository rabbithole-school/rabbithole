// Live talks: a scholar presents (slides, or their own app's Present mode)
// from a BunnyPad while a second device at the back of the room — a
// classmate's or a teacher's — records the room. The presenter's device owns
// the talk and its takes; the back device finds the talk through its school's
// audience list, links as the listener, follows start/stop with its camera,
// and uploads one video per take for the presenter's review screen.
//
// Tables: `liveTalks` (one presenting session, many takes) and
// `talkRecordings` (one back-row video per take). See schema.ts.
//
// Tenancy: every talk carries its presenter's school, and the audience list,
// join and listener reads are confined to the caller's own school
// (`callerSchoolId`). Reading a take's video back is the presenter's own read
// or a teaching read of that scholar's work (`canUserReadScholarWork`).
//
// Liveness: both devices heart-beat. Each presenter heartbeat schedules
// `expireIfStale`, which ends a talk not heard from in TALK_STALE_MS; each
// listener join or heartbeat schedules `expireListenerIfStale`, which unlinks
// a back device not heard from in LISTENER_STALE_MS. A take's row left
// "uploading" for UPLOAD_EXPIRY_MS fails (`expireUpload`). Queries never read
// the clock (T11).

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { canUserReadScholarWork, resolveActiveMembership } from "./lib/access";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { ROLES } from "./lib/roles";
import { scholarInstitutionId } from "./lib/scholarEnrollment";

/** A talk not heard from (begin/heartbeat) for this long is ended. */
export const TALK_STALE_MS = 60_000;
/** A listener not heard from (join/listenerHeartbeat) for this long is unlinked. */
export const LISTENER_STALE_MS = 60_000;
/** A stopped take whose video hasn't arrived within this long fails. */
export const UPLOAD_EXPIRY_MS = 20 * 60_000;

const TITLE_MAX = 200;
const TAKE_ID_MAX = 100;
const MIME_TYPE_MAX = 100;
/** Cap on the opaque encoded loudness trace a back device uploads. */
export const LEVELS_MAX_CHARS = 200_000;
/** The head-direction trace: about an hour at four readings a second. */
export const FACING_MAX_CHARS = 200_000;
/** Upper bound on slide numbers, to keep them sane rather than to limit decks. */
const SLIDE_MAX = 10_000;
/** How many live talks the audience list reads per state. */
const AUDIENCE_LIST_LIMIT = 50;

const kindValidator = v.union(v.literal("slides"), v.literal("app"));
const modeValidator = v.union(v.literal("present"), v.literal("rehearse"));

type Ctx = QueryCtx | MutationCtx;
type TalkState = Doc<"liveTalks">["state"];
type EndedReason = NonNullable<Doc<"liveTalks">["endedReason"]>;

const stateValidator = v.union(
  v.literal("waiting"),
  v.literal("recording"),
  v.literal("ended"),
);
const endedReasonValidator = v.union(
  v.literal("left"),
  v.literal("stale"),
  v.literal("replaced"),
);

function fail(kind: string, message: string): never {
  throw new ConvexError({ kind, message });
}

// ── The caller's school ────────────────────────────────────────────────

/**
 * The school the caller presents or listens at, or null when they have none.
 * Scholars (and lifelong learners) take their enrollment; staff take their
 * active membership. Parents and anyone without a live school get null. Never
 * falls back to the primary institution.
 */
export async function callerSchoolId(
  ctx: Ctx,
  user: Doc<"users">,
): Promise<Id<"institutions"> | null> {
  if (user.role === ROLES.PARENT) return null;
  let institutionId: Id<"institutions"> | undefined;
  if (user.role === ROLES.SCHOLAR || user.role === ROLES.LIFELONG_LEARNER) {
    institutionId = await scholarInstitutionId(ctx, user._id);
  } else {
    const membership = await resolveActiveMembership(ctx, user);
    if (membership && membership.role !== ROLES.PARENT) {
      institutionId = membership.institutionId;
    }
  }
  if (!institutionId) return null;
  const institution = await ctx.db.get(institutionId);
  if (!institution || institution.disabledAt !== undefined) return null;
  return institutionId;
}

async function requireCallerSchoolId(
  ctx: Ctx,
  user: Doc<"users">,
): Promise<Id<"institutions">> {
  const institutionId = await callerSchoolId(ctx, user);
  if (!institutionId) {
    fail("no_school", "Live talks need a school account.");
  }
  return institutionId;
}

// ── Names ──────────────────────────────────────────────────────────────

/**
 * A person's first name, as peer-facing surfaces show a classmate or teacher
 * (the same order parentSms.scholarFirstName uses; trophyCase and the entryway screen take
 * the first word of `name` the same way).
 */
function shortName(user: Doc<"users"> | null): string {
  return (
    user?.firstName?.trim() ||
    user?.name?.trim().split(/\s+/)[0] ||
    user?.username?.trim() ||
    "Someone"
  );
}

// ── Validation ─────────────────────────────────────────────────────────

function cleanTitle(raw: string): string {
  const title = raw.trim();
  if (title.length > TITLE_MAX) fail("invalid", "That title is too long.");
  return title;
}

function cleanTakeId(raw: string): string {
  const takeId = raw.trim();
  if (!takeId || takeId.length > TAKE_ID_MAX) {
    fail("invalid", "That take id isn't valid.");
  }
  return takeId;
}

function isSlideNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= SLIDE_MAX;
}

/** Slides talks need a real deck position; app talks send 0 / 0. */
function checkSlides(
  kind: Doc<"liveTalks">["kind"],
  slideCount: number,
  slideIndex: number,
): void {
  if (!isSlideNumber(slideCount) || !isSlideNumber(slideIndex)) {
    fail("invalid", "Slide numbers must be whole numbers from 0.");
  }
  if (kind === "slides" && (slideCount < 1 || slideIndex >= slideCount)) {
    fail("invalid", "That slide isn't in the deck.");
  }
}

function finiteNumber(n: number, label: string): number {
  if (!Number.isFinite(n)) fail("invalid", `${label} must be a number.`);
  return n;
}

// ── Talk transitions (shared by presenter, listener and expiry paths) ──

/** Fail the caller's still-recording rows on a talk they are leaving. */
async function failRecordingRows(
  ctx: MutationCtx,
  talkId: Id<"liveTalks">,
  listenerId: Id<"users">,
): Promise<void> {
  const rows = await ctx.db
    .query("talkRecordings")
    .withIndex("by_talk", (q) => q.eq("talkId", talkId))
    .collect();
  for (const row of rows) {
    if (row.listenerId === listenerId && row.status === "recording") {
      await ctx.db.patch(row._id, { status: "failed" });
    }
  }
}

async function unlinkListener(
  ctx: MutationCtx,
  talk: Doc<"liveTalks">,
): Promise<void> {
  if (!talk.listenerId) return;
  await failRecordingRows(ctx, talk._id, talk.listenerId);
  await ctx.db.patch(talk._id, {
    listenerId: undefined,
    listenerSeenAt: undefined,
  });
}

/**
 * The current take's back-row row moves from recording to uploading, with a
 * deadline for the video to arrive.
 */
async function stopTake(
  ctx: MutationCtx,
  talk: Doc<"liveTalks">,
): Promise<void> {
  if (talk.state !== "recording") return;
  if (talk.takeId) {
    const rows = await ctx.db
      .query("talkRecordings")
      .withIndex("by_presenter_take", (q) =>
        q.eq("presenterId", talk.presenterId).eq("takeId", talk.takeId!),
      )
      .collect();
    for (const row of rows) {
      if (row.talkId === talk._id && row.status === "recording") {
        await ctx.db.patch(row._id, { status: "uploading" });
        await ctx.scheduler.runAfter(
          UPLOAD_EXPIRY_MS,
          internal.liveTalks.expireUpload,
          { recordingId: row._id },
        );
      }
    }
  }
  await ctx.db.patch(talk._id, { state: "waiting", presenterTalking: undefined });
}

async function endTalk(
  ctx: MutationCtx,
  talk: Doc<"liveTalks">,
  endedReason: EndedReason,
): Promise<void> {
  if (talk.state === "ended") return;
  await stopTake(ctx, talk);
  await ctx.db.patch(talk._id, {
    state: "ended",
    endedAt: Date.now(),
    endedReason,
  });
}

async function scheduleExpiryCheck(
  ctx: MutationCtx,
  talkId: Id<"liveTalks">,
): Promise<void> {
  await ctx.scheduler.runAfter(TALK_STALE_MS, internal.liveTalks.expireIfStale, {
    talkId,
  });
}

async function scheduleListenerExpiryCheck(
  ctx: MutationCtx,
  talkId: Id<"liveTalks">,
): Promise<void> {
  await ctx.scheduler.runAfter(
    LISTENER_STALE_MS,
    internal.liveTalks.expireListenerIfStale,
    { talkId },
  );
}

async function presenterTalk(
  ctx: Ctx,
  user: Doc<"users">,
  talkId: Id<"liveTalks">,
): Promise<Doc<"liveTalks">> {
  const talk = await ctx.db.get(talkId);
  if (!talk || talk.presenterId !== user._id) {
    fail("not_found", "That talk isn't yours.");
  }
  return talk;
}

async function liveTalksForPresenter(
  ctx: Ctx,
  presenterId: Id<"users">,
): Promise<Doc<"liveTalks">[]> {
  const rows: Doc<"liveTalks">[] = [];
  for (const state of ["waiting", "recording"] as const) {
    rows.push(
      ...(await ctx.db
        .query("liveTalks")
        .withIndex("by_presenter_state", (q) =>
          q.eq("presenterId", presenterId).eq("state", state),
        )
        .collect()),
    );
  }
  return rows;
}

// ── Presenter ──────────────────────────────────────────────────────────

/** Start a presenting session. Ends this presenter's other live talks. */
export const begin = authedMutation({
  args: {
    kind: kindValidator,
    mode: modeValidator,
    title: v.string(),
    slideCount: v.number(),
    slideIndex: v.number(),
  },
  returns: v.id("liveTalks"),
  handler: async (ctx, args) => {
    const institutionId = await requireCallerSchoolId(ctx, ctx.user);
    const title = cleanTitle(args.title);
    checkSlides(args.kind, args.slideCount, args.slideIndex);

    for (const talk of await liveTalksForPresenter(ctx, ctx.user._id)) {
      await endTalk(ctx, talk, "replaced");
    }

    const talkId = await ctx.db.insert("liveTalks", {
      presenterId: ctx.user._id,
      institutionId,
      kind: args.kind,
      mode: args.mode,
      title,
      slideIndex: args.slideIndex,
      slideCount: args.slideCount,
      state: "waiting",
      lastSeenAt: Date.now(),
    });
    await scheduleExpiryCheck(ctx, talkId);
    return talkId;
  },
});

/**
 * Keep a talk alive (the app calls this every ~20 s). Returns the talk's
 * state and, once ended, why. Only a "stale" end means the app should
 * `begin` again; "replaced" means this account began a talk on another
 * device, and beginning again would end that one in turn.
 */
export const heartbeat = authedMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.object({
    state: stateValidator,
    endedReason: v.union(endedReasonValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    const talk = await presenterTalk(ctx, ctx.user, args.talkId);
    if (talk.state === "ended") {
      return { state: talk.state, endedReason: talk.endedReason ?? null };
    }
    await ctx.db.patch(talk._id, { lastSeenAt: Date.now() });
    await scheduleExpiryCheck(ctx, talk._id);
    return { state: talk.state, endedReason: null };
  },
});

export const showSlide = authedMutation({
  args: { talkId: v.id("liveTalks"), slideIndex: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const talk = await presenterTalk(ctx, ctx.user, args.talkId);
    if (talk.state === "ended") return null;
    checkSlides(talk.kind, talk.slideCount, args.slideIndex);
    await ctx.db.patch(talk._id, { slideIndex: args.slideIndex });
    return null;
  },
});

/**
 * Start a take. With a listener linked, opens that take's back-row
 * recording row. Calling it again for the same take is a no-op; a new take
 * while one is recording stops the old one first.
 */
export const startRecording = authedMutation({
  args: { talkId: v.id("liveTalks"), takeId: v.string() },
  returns: v.object({ withListener: v.boolean() }),
  handler: async (ctx, args) => {
    const talk = await presenterTalk(ctx, ctx.user, args.talkId);
    if (talk.state === "ended") fail("ended", "This talk has ended.");
    const takeId = cleanTakeId(args.takeId);

    const existing = await ctx.db
      .query("talkRecordings")
      .withIndex("by_presenter_take", (q) =>
        q.eq("presenterId", ctx.user._id).eq("takeId", takeId),
      )
      .collect();
    if (talk.state === "recording" && talk.takeId === takeId) {
      return { withListener: existing.some((row) => row.talkId === talk._id) };
    }
    // A take id names one take: reusing one that already has a back-row row
    // would hand the back device a row that is uploading or ready.
    if (existing.length > 0) fail("invalid", "That take id was already used.");
    await stopTake(ctx, talk);

    await ctx.db.patch(talk._id, { state: "recording", takeId });
    if (!talk.listenerId) return { withListener: false };
    await ctx.db.insert("talkRecordings", {
      talkId: talk._id,
      presenterId: talk.presenterId,
      institutionId: talk.institutionId,
      takeId,
      listenerId: talk.listenerId,
      status: "recording",
      startedAt: Date.now(),
    });
    return { withListener: true };
  },
});

/**
 * The presenter's close mic hears them talking (or not), sent live during a
 * take so the back screen can tell quiet speech from a pause. Ignored unless
 * the talk is recording; an unchanged value writes nothing.
 */
export const setTalking = authedMutation({
  args: { talkId: v.id("liveTalks"), talking: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const talk = await presenterTalk(ctx, ctx.user, args.talkId);
    if (talk.state !== "recording") return null;
    if ((talk.presenterTalking ?? false) === args.talking) return null;
    await ctx.db.patch(talk._id, { presenterTalking: args.talking });
    return null;
  },
});

/** Stop the current take; its back-row row moves on to uploading. */
export const stopRecording = authedMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const talk = await presenterTalk(ctx, ctx.user, args.talkId);
    await stopTake(ctx, talk);
    return null;
  },
});

/** End the talk (stopping a take in progress). Idempotent. */
export const end = authedMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const talk = await presenterTalk(ctx, ctx.user, args.talkId);
    await endTalk(ctx, talk, "left");
    return null;
  },
});

/** Unlink the back device; a take it was still recording fails. */
export const dropListener = authedMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const talk = await presenterTalk(ctx, ctx.user, args.talkId);
    await unlinkListener(ctx, talk);
    return null;
  },
});

/**
 * The presenter's view of their talk; null for a talk that isn't theirs.
 * `endedReason` is null until the talk ends.
 */
export const forPresenter = authedQuery({
  args: { talkId: v.id("liveTalks") },
  handler: async (ctx, args) => {
    const talk = await ctx.db.get(args.talkId);
    if (!talk || talk.presenterId !== ctx.user._id) return null;
    const listener = talk.listenerId ? await ctx.db.get(talk.listenerId) : null;
    return {
      state: talk.state,
      endedReason: talk.endedReason ?? null,
      listener: talk.listenerId ? { name: shortName(listener) } : null,
    };
  },
});

/**
 * The back-row video for one of a presenter's takes. Readable by the
 * presenter and by staff who may read that scholar's work; null for anyone
 * else, and while no recording exists for the take.
 */
export const backRowForTake = authedQuery({
  args: { takeId: v.string(), presenterId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const presenterId = args.presenterId ?? ctx.user._id;
    if (
      presenterId !== ctx.user._id &&
      !(await canUserReadScholarWork(ctx, ctx.user, presenterId))
    ) {
      return null;
    }
    const row = await ctx.db
      .query("talkRecordings")
      .withIndex("by_presenter_take", (q) =>
        q.eq("presenterId", presenterId).eq("takeId", args.takeId),
      )
      .order("desc")
      .first();
    if (!row) return null;
    const url =
      row.status === "ready" && row.storageId
        ? await ctx.storage.getUrl(row.storageId)
        : null;
    return {
      status: row.status,
      url,
      levels: row.levels ?? null,
      frameMs: row.frameMs ?? null,
      roomDbfs: row.roomDbfs ?? null,
      thresholdDb: row.thresholdDb ?? null,
      durationMs: row.durationMs ?? null,
      cameraStartedAtClient: row.cameraStartedAtClient ?? null,
      facing: row.facing ?? null,
      facingFrameMs: row.facingFrameMs ?? null,
      facingZone: row.facingZone ?? null,
      startedAt: row.startedAt,
    };
  },
});

// ── Audience ───────────────────────────────────────────────────────────

/**
 * Talks live at the caller's school, newest first, excluding their own.
 * Null when the caller has no school (a parent, or an account with none).
 */
export const listForAudience = authedQuery({
  args: {},
  handler: async (ctx) => {
    const institutionId = await callerSchoolId(ctx, ctx.user);
    if (!institutionId) return null;
    const talks: Doc<"liveTalks">[] = [];
    for (const state of ["waiting", "recording"] as const) {
      talks.push(
        ...(await ctx.db
          .query("liveTalks")
          .withIndex("by_institution_state", (q) =>
            q.eq("institutionId", institutionId).eq("state", state),
          )
          .order("desc")
          .take(AUDIENCE_LIST_LIMIT)),
      );
    }
    talks.sort((a, b) => b._creationTime - a._creationTime);

    const rows = [];
    for (const talk of talks) {
      if (talk.presenterId === ctx.user._id) continue;
      const presenter = await ctx.db.get(talk.presenterId);
      const listening: "me" | "someone" | null = !talk.listenerId
        ? null
        : talk.listenerId === ctx.user._id
          ? "me"
          : "someone";
      rows.push({
        talkId: talk._id,
        presenterName: shortName(presenter),
        kind: talk.kind,
        title: talk.title,
        mode: talk.mode,
        state: talk.state as Exclude<TalkState, "ended">,
        listening,
      });
    }
    return rows;
  },
});

/**
 * Link the caller's device as this talk's listener. Leaves any other talk
 * the caller was listening to. Refuses a talk someone else is listening to.
 */
export const join = authedMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const institutionId = await requireCallerSchoolId(ctx, ctx.user);
    const talk = await ctx.db.get(args.talkId);
    if (!talk || talk.institutionId !== institutionId) {
      fail("not_found", "That talk isn't at your school.");
    }
    if (talk.presenterId === ctx.user._id) {
      fail("own_talk", "You can't be the audience for your own talk.");
    }
    if (talk.state === "ended") fail("ended", "This talk has ended.");
    if (talk.listenerId && talk.listenerId !== ctx.user._id) {
      fail("someone_listening", "Someone else is already listening");
    }

    const elsewhere = await ctx.db
      .query("liveTalks")
      .withIndex("by_listener", (q) => q.eq("listenerId", ctx.user._id))
      .collect();
    for (const other of elsewhere) {
      if (other._id !== talk._id) await unlinkListener(ctx, other);
    }
    await ctx.db.patch(talk._id, {
      listenerId: ctx.user._id,
      listenerSeenAt: Date.now(),
    });
    await scheduleListenerExpiryCheck(ctx, talk._id);
    return null;
  },
});

/**
 * Keep the back device linked (the app calls this every ~20 s while it is
 * the listener). `connected: false` means it was unlinked — it went quiet,
 * left, or the presenter dropped it — and should stop recording.
 */
export const listenerHeartbeat = authedMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.object({ connected: v.boolean() }),
  handler: async (ctx, args) => {
    const talk = await ctx.db.get(args.talkId);
    if (!talk || talk.listenerId !== ctx.user._id) return { connected: false };
    await ctx.db.patch(talk._id, { listenerSeenAt: Date.now() });
    await scheduleListenerExpiryCheck(ctx, talk._id);
    return { connected: true };
  },
});

/** Unlink the caller from this talk; a take they were recording fails. */
export const leave = authedMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const talk = await ctx.db.get(args.talkId);
    if (!talk || talk.listenerId !== ctx.user._id) return null;
    await unlinkListener(ctx, talk);
    return null;
  },
});

/**
 * The back device's view of a talk: null unless the caller is (or was, by
 * having recorded a take of it) its listener. `recording` is the caller's
 * newest back-row row for this talk.
 */
export const forListener = authedQuery({
  args: { talkId: v.id("liveTalks") },
  handler: async (ctx, args) => {
    const talk = await ctx.db.get(args.talkId);
    if (!talk) return null;
    const rows = await ctx.db
      .query("talkRecordings")
      .withIndex("by_talk", (q) => q.eq("talkId", talk._id))
      .order("desc")
      .collect();
    const mine = rows.find((row) => row.listenerId === ctx.user._id) ?? null;
    const connected = talk.listenerId === ctx.user._id;
    if (!connected && !mine) return null;
    const presenter = await ctx.db.get(talk.presenterId);
    return {
      state: talk.state,
      presenterName: shortName(presenter),
      kind: talk.kind,
      title: talk.title,
      slideIndex: talk.slideIndex,
      slideCount: talk.slideCount,
      takeId: talk.takeId ?? null,
      presenterTalking: talk.presenterTalking ?? false,
      connected,
      recording: mine
        ? { recordingId: mine._id, takeId: mine.takeId, status: mine.status }
        : null,
    };
  },
});

async function listenerRecording(
  ctx: Ctx,
  user: Doc<"users">,
  recordingId: Id<"talkRecordings">,
): Promise<Doc<"talkRecordings">> {
  const row = await ctx.db.get(recordingId);
  if (!row || row.listenerId !== user._id) {
    fail("not_found", "That recording isn't yours.");
  }
  return row;
}

function isOpen(row: Doc<"talkRecordings">): boolean {
  return row.status === "recording" || row.status === "uploading";
}

export const generateUploadUrl = authedMutation({
  args: { recordingId: v.id("talkRecordings") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const row = await listenerRecording(ctx, ctx.user, args.recordingId);
    if (!isOpen(row)) fail("closed", "This recording can't take an upload.");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Attach the uploaded video and the loudness trace; the take is then ready
 * for the presenter's review screen. The stored size, not the client's
 * claim, is what's recorded.
 */
export const finishUpload = authedMutation({
  args: {
    recordingId: v.id("talkRecordings"),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    sizeBytes: v.number(),
    durationMs: v.number(),
    levels: v.string(),
    frameMs: v.number(),
    roomDbfs: v.number(),
    // Absent from a back device that predates sending its green threshold.
    thresholdDb: v.optional(v.number()),
    cameraStartedAtClient: v.number(),
    // Absent from a back device whose build can't read head direction.
    facing: v.optional(v.string()),
    facingFrameMs: v.optional(v.number()),
    facingZone: v.optional(
      v.object({
        centerYaw: v.number(),
        centerPitch: v.number(),
        turnDeg: v.number(),
        tiltDeg: v.number(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await listenerRecording(ctx, ctx.user, args.recordingId);
    if (row.status === "ready" && row.storageId === args.storageId) return null;
    if (!isOpen(row)) fail("closed", "This recording can't take an upload.");

    const stored = await ctx.db.system.get(args.storageId);
    // A storage id is not authorization (see slideAssets in schema.ts): only
    // a blob uploaded after this take began, and not already attached to
    // another take, can become this take's video.
    if (!stored || stored._creationTime < row.startedAt) {
      fail("invalid", "That upload wasn't found.");
    }
    const claimed = await ctx.db
      .query("talkRecordings")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    if (claimed && claimed._id !== row._id) {
      fail("invalid", "That upload belongs to another take.");
    }

    const mimeType = args.mimeType.trim();
    if (!mimeType || mimeType.length > MIME_TYPE_MAX) {
      fail("invalid", "That video type isn't valid.");
    }
    if (args.levels.length > LEVELS_MAX_CHARS) {
      fail("invalid", "The loudness trace is too long.");
    }
    const durationMs = finiteNumber(args.durationMs, "Duration");
    const frameMs = finiteNumber(args.frameMs, "Frame length");
    if (durationMs < 0 || frameMs <= 0) {
      fail("invalid", "Duration and frame length must be positive.");
    }
    finiteNumber(args.sizeBytes, "Size");
    let thresholdDb: number | undefined;
    if (args.thresholdDb !== undefined) {
      thresholdDb = finiteNumber(args.thresholdDb, "Threshold");
      if (thresholdDb < 0 || thresholdDb > 60) fail("invalid", "The threshold is out of range.");
    }
    let facing: {
      facing: string;
      facingFrameMs: number;
      facingZone?: { centerYaw: number; centerPitch: number; turnDeg: number; tiltDeg: number };
    } | null = null;
    if (args.facing !== undefined && args.facingFrameMs !== undefined) {
      if (args.facing.length > FACING_MAX_CHARS) {
        fail("invalid", "The head-direction trace is too long.");
      }
      const facingFrameMs = finiteNumber(args.facingFrameMs, "Head direction frame length");
      if (facingFrameMs <= 0) fail("invalid", "Head direction frame length must be positive.");
      facing = { facing: args.facing, facingFrameMs };
      if (args.facingZone) {
        const zone = args.facingZone;
        const inRange = (n: number, lo: number, hi: number, label: string) => {
          finiteNumber(n, label);
          if (n < lo || n > hi) fail("invalid", `${label} is out of range.`);
          return n;
        };
        facing.facingZone = {
          centerYaw: inRange(zone.centerYaw, -90, 90, "Facing zone centre"),
          centerPitch: inRange(zone.centerPitch, -90, 90, "Facing zone centre"),
          turnDeg: inRange(zone.turnDeg, 1, 90, "Facing zone width"),
          tiltDeg: inRange(zone.tiltDeg, 1, 90, "Facing zone height"),
        };
      }
    }

    await ctx.db.patch(row._id, {
      status: "ready",
      storageId: args.storageId,
      mimeType,
      sizeBytes: stored.size,
      durationMs,
      levels: args.levels,
      frameMs,
      roomDbfs: finiteNumber(args.roomDbfs, "Room level"),
      ...(thresholdDb !== undefined ? { thresholdDb } : {}),
      cameraStartedAtClient: finiteNumber(
        args.cameraStartedAtClient,
        "Camera start",
      ),
      ...(facing ?? {}),
    });
    return null;
  },
});

export const markUploadFailed = authedMutation({
  args: { recordingId: v.id("talkRecordings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await listenerRecording(ctx, ctx.user, args.recordingId);
    if (row.status === "ready") return null;
    await ctx.db.patch(row._id, { status: "failed" });
    return null;
  },
});

// ── Expiry ─────────────────────────────────────────────────────────────

/** Scheduled after begin and every heartbeat: end a talk gone quiet. */
export const expireIfStale = internalMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const talk = await ctx.db.get(args.talkId);
    if (!talk || talk.state === "ended") return null;
    if (Date.now() - talk.lastSeenAt < TALK_STALE_MS) return null;
    await endTalk(ctx, talk, "stale");
    return null;
  },
});

/**
 * Scheduled after join and every listener heartbeat: unlink a back device
 * gone quiet, failing a take it was still recording (the same as `leave`).
 */
export const expireListenerIfStale = internalMutation({
  args: { talkId: v.id("liveTalks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const talk = await ctx.db.get(args.talkId);
    if (!talk?.listenerId) return null;
    if (Date.now() - (talk.listenerSeenAt ?? 0) < LISTENER_STALE_MS) return null;
    await unlinkListener(ctx, talk);
    return null;
  },
});

/** Scheduled when a take stops: a video that never arrived fails the row. */
export const expireUpload = internalMutation({
  args: { recordingId: v.id("talkRecordings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.recordingId);
    if (row?.status !== "uploading") return null;
    await ctx.db.patch(row._id, { status: "failed" });
    return null;
  },
});
