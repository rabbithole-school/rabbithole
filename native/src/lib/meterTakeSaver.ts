/**
 * Saves every take the Decibel meter films with nobody linked
 * (convex/decibelMeter.ts): the video, a poster still, the take's sound as a
 * small file for transcribing, and the meter's traces. It lives outside the
 * meter screen so a take still saves when the meter is closed straight after
 * Stop.
 *
 * Each upload is reserved first and reported once it lands, so the server
 * knows it is this BunnyPad's own. Uploads that landed are kept across a
 * failed save, so trying again doesn't send the video twice.
 *
 * A save that fails keeps its video here and tries again in the background,
 * screen or no screen; the video leaves this BunnyPad only once the take is
 * saved (or the server has refused it, or the retries are spent) and the
 * meter has let go of it.
 *
 * The meter screen reads each take's state with `useMeterTakeSaves`, names the
 * speaker with `setSpeaker` (sent with the save, or straight away once saved)
 * and discards with `discard`.
 */

import { useSyncExternalStore } from "react";
import { ConvexError } from "convex/values";
import * as FileSystem from "expo-file-system/legacy";
import * as VideoThumbnails from "expo-video-thumbnails";

import { extractAudio, type HeadPoseTrack } from "../../modules/facing-room";
import { api, convex, type Id } from "@/lib/convex";
import { encodeLevels } from "@/lib/backRowVoice";
import { encodeFacing, FACING_UPLOAD_MAX_CHARS, type FacingZone } from "@/lib/facingRoom";

export type MeterTakeSave =
  | { state: "saving"; pct: number | null }
  | { state: "saved"; portfolioItemId: Id<"portfolioItems"> }
  /** `final`: the server refused this take, so trying again won't help. */
  | { state: "failed"; message: string | null; final: boolean }
  | { state: "discarded" };

export type MeterTakeJob = {
  /** The meter's own id for the take. */
  takeId: string;
  uri: string;
  durationMs: number;
  /** dBFS, one per `frameMs`, on the video's clock. */
  levels: readonly number[];
  frameMs: number;
  roomDbfs: number;
  thresholdDb: number;
  /** The head-direction read the meter started after the take. */
  pose: Promise<HeadPoseTrack | null>;
  /** Where the meter counted facing the room, read once the pose is in. */
  zone: () => FacingZone;
};

/** A take's save as the meter shows it, with a speaker named before it landed. */
export type MeterTakeView = MeterTakeSave & { pendingSpeaker?: Speaker | null };

export type Speaker = { id: Id<"users">; name: string };

type UploadKind = "video" | "poster" | "audio";

/** Retries of one upload inside a save. */
const RETRY_MS = [2_000, 5_000, 15_000];
/** Whole-save retries in the background after a save fails. */
const BACKGROUND_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const AUDIO_TIMEOUT_MS = 60_000;
/** decibelMeter.ts VIDEO_MAX_BYTES: about 13 minutes at the meter's bitrate. */
const VIDEO_MAX_BYTES = 250 * 1024 * 1024;
const TOO_LONG = "This take is too long to save.";

type Entry = {
  job: MeterTakeJob;
  save: MeterTakeSave;
  /** The speaker decided before the save finished (null: left for a teacher); undefined = not decided. */
  speaker: Speaker | null | undefined;
  /** Uploads that landed and were recorded, kept across a failed save. */
  uploaded: Partial<Record<UploadKind, Id<"decibelMeterUploads">>>;
  /** The meter no longer shows this take, so its video may go once it's saved or given up. */
  released: boolean;
  uploading: boolean;
  backgroundRetries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** A discard made while the save was running, answered when it lands. */
  pendingDiscard: { resolve: () => void; reject: (error: unknown) => void } | null;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, MeterTakeView> = new Map();

function publish() {
  snapshot = new Map(
    [...entries].map(([id, entry]) => [id, { ...entry.save, pendingSpeaker: entry.speaker }]),
  );
  for (const listener of listeners) listener();
}

function update(takeId: string, save: MeterTakeSave) {
  const entry = entries.get(takeId);
  if (!entry) return;
  entry.save = save;
  publish();
}

/** Each take's save, keyed by the meter's take id. */
export function useMeterTakeSaves(): ReadonlyMap<string, MeterTakeView> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

/** Start saving a take. Returns at once; the save carries on in the background. */
export function saveTake(job: MeterTakeJob) {
  if (entries.has(job.takeId)) return;
  entries.set(job.takeId, {
    job,
    save: { state: "saving", pct: null },
    speaker: undefined,
    uploaded: {},
    released: false,
    uploading: false,
    backgroundRetries: 0,
    retryTimer: null,
    pendingDiscard: null,
  });
  publish();
  void run(job.takeId);
}

/** Try a failed save again now. */
export function retry(takeId: string) {
  const entry = entries.get(takeId);
  if (!entry || entry.save.state !== "failed" || entry.save.final || entry.uploading) return;
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
  update(takeId, { state: "saving", pct: null });
  void run(takeId);
}

/** Name the speaker, or leave it for a teacher (null): sent with the save, or now if it's done. */
export async function setSpeaker(takeId: string, speaker: Speaker | null): Promise<void> {
  const entry = entries.get(takeId);
  if (!entry) return;
  if (entry.save.state === "saved") {
    await convex.mutation(api.decibelMeter.setSpeaker, {
      portfolioItemId: entry.save.portfolioItemId,
      scholarId: speaker?.id ?? null,
    });
    return;
  }
  entry.speaker = speaker;
  publish();
}

/**
 * Delete a take here and, once saved, from the inbox too. Rejects with the
 * server's refusal (a teacher has filed it) when the saved take stays. A save
 * still running is discarded when it lands, and this answers then.
 */
export async function discard(takeId: string): Promise<void> {
  const entry = entries.get(takeId);
  if (!entry) return;
  const save = entry.save;
  entry.save = { state: "discarded" };
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
  publish();
  try {
    if (save.state === "saved") {
      await convex.mutation(api.decibelMeter.discardTake, { portfolioItemId: save.portfolioItemId });
    } else if (entry.uploading) {
      await new Promise<void>((resolve, reject) => {
        entry.pendingDiscard = { resolve, reject };
      });
    }
    // A save that failed left only uploads, which the server sweeps.
  } finally {
    release(takeId);
  }
}

/** The meter has let go of this take: its video goes once the take is saved or given up. */
export function release(takeId: string) {
  const entry = entries.get(takeId);
  if (!entry) return;
  entry.released = true;
  maybeForget(takeId);
}

/** Drop a take, and its video, once nothing more can happen to it. */
function maybeForget(takeId: string) {
  const entry = entries.get(takeId);
  if (!entry || !entry.released || entry.uploading) return;
  const { save } = entry;
  const done =
    save.state === "saved" ||
    save.state === "discarded" ||
    (save.state === "failed" && (save.final || entry.retryTimer === null));
  if (done) void forget(takeId);
}

async function forget(takeId: string) {
  const entry = entries.get(takeId);
  if (!entry) return;
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  entries.delete(takeId);
  publish();
  await deleteQuietly(entry.job.uri);
}

/** After a failed save, try again later, whether or not the meter is open. */
function scheduleBackgroundRetry(takeId: string) {
  const entry = entries.get(takeId);
  if (!entry || entry.backgroundRetries >= BACKGROUND_RETRY_MS.length) return;
  const delay = BACKGROUND_RETRY_MS[entry.backgroundRetries];
  entry.backgroundRetries += 1;
  entry.retryTimer = setTimeout(() => {
    const now = entries.get(takeId);
    if (!now) return;
    now.retryTimer = null;
    if (now.save.state !== "failed" || now.save.final || now.uploading) return;
    update(takeId, { state: "saving", pct: null });
    void run(takeId);
  }, delay);
}

async function run(takeId: string) {
  const entry = entries.get(takeId);
  if (!entry || entry.uploading) return;
  entry.uploading = true;
  const { job } = entry;
  const local: string[] = [];
  let failedForGood = false;
  try {
    const info = await FileSystem.getInfoAsync(job.uri);
    if (info.exists && info.size > VIDEO_MAX_BYTES) {
      failedForGood = true;
      update(takeId, { state: "failed", message: TOO_LONG, final: true });
      return;
    }
    const video =
      entry.uploaded.video ??
      (entry.uploaded.video = await uploadWithRetry(job.uri, videoMimeType(job.uri), "video", (pct) => {
        if (entries.get(takeId)?.save.state === "saving") update(takeId, { state: "saving", pct });
      }));
    // The poster and the sound are extras: a take saves without either, but
    // each gets the same retries as the video.
    if (!entry.uploaded.poster) {
      const posterUri = await poster(job.uri, job.durationMs);
      if (posterUri) {
        local.push(posterUri);
        entry.uploaded.poster =
          (await uploadWithRetry(posterUri, "image/jpeg", "poster").catch(() => null)) ?? undefined;
      }
    }
    if (!entry.uploaded.audio) {
      const audioUri = await extractAudio(job.uri, AUDIO_TIMEOUT_MS);
      if (audioUri) {
        local.push(audioUri);
        entry.uploaded.audio =
          (await uploadWithRetry(audioUri, "audio/mp4", "audio").catch(() => null)) ?? undefined;
      }
    }

    const pose = await job.pose;
    const trace = pose ? encodeFacing(pose.frames) : null;
    const speaker = entries.get(takeId)?.speaker;
    const result = await convex.mutation(api.decibelMeter.saveTake, {
      videoUploadId: video,
      ...(entry.uploaded.poster ? { posterUploadId: entry.uploaded.poster } : {}),
      ...(entry.uploaded.audio ? { audioUploadId: entry.uploaded.audio } : {}),
      durationMs: Math.round(job.durationMs),
      levels: encodeLevels(job.levels),
      frameMs: job.frameMs,
      roomDbfs: job.roomDbfs,
      thresholdDb: job.thresholdDb,
      // An overlong trace would sink the save: send the take without it.
      ...(pose && trace !== null && trace.length <= FACING_UPLOAD_MAX_CHARS
        ? { facing: trace, facingFrameMs: pose.frameMs, facingZone: job.zone() }
        : {}),
      // Named, or explicitly left for a teacher (null); omitted if undecided.
      ...(speaker !== undefined ? { scholarId: speaker?.id ?? null } : {}),
    });
    // Read both fields rather than narrowing with `in`: the inferred type of
    // the two answers gives each the other's field as optional.
    const refused = "refused" in result ? result.refused : undefined;
    const portfolioItemId = "portfolioItemId" in result ? result.portfolioItemId : undefined;
    if (refused !== undefined || portfolioItemId === undefined) {
      // The server deleted those uploads with its refusal.
      entry.uploaded = {};
      failedForGood = true;
      if (entries.get(takeId)?.save.state !== "discarded") {
        update(takeId, {
          state: "failed",
          message: refused ?? "This take couldn't be saved.",
          final: true,
        });
      }
      return;
    }
    const now = entries.get(takeId);
    if (!now) return;
    if (now.save.state === "discarded") {
      try {
        await convex.mutation(api.decibelMeter.discardTake, { portfolioItemId });
        now.pendingDiscard?.resolve();
      } catch (error) {
        console.warn("[decibel meter] discarding a just-saved take failed", error);
        now.pendingDiscard?.reject(error);
      }
      now.pendingDiscard = null;
      return;
    }
    update(takeId, { state: "saved", portfolioItemId });
    // Decided (or changed) while the save was on its way: send it now.
    if (now.speaker !== speaker && now.speaker !== undefined) {
      await convex
        .mutation(api.decibelMeter.setSpeaker, {
          portfolioItemId,
          scholarId: now.speaker?.id ?? null,
        })
        .catch((error) => console.warn("[decibel meter] naming the speaker failed", error));
    }
  } catch (error) {
    console.warn("[decibel meter] saving a take failed", error);
    const message = refusal(error);
    // A refusal (the daily limit, no school, uploads that aren't this
    // account's) won't change on a retry.
    failedForGood = message !== null;
    const now = entries.get(takeId);
    if (now?.save.state === "discarded") {
      now.pendingDiscard?.resolve(); // nothing reached the inbox
      now.pendingDiscard = null;
    } else {
      update(takeId, { state: "failed", message, final: failedForGood });
    }
  } finally {
    // Done with this save before the cleanup awaits, so a retry can start a new one.
    const after = entries.get(takeId);
    if (after) {
      after.uploading = false;
      after.pendingDiscard?.resolve();
      after.pendingDiscard = null;
      if (after.save.state === "failed" && !failedForGood) scheduleBackgroundRetry(takeId);
      maybeForget(takeId);
    }
    for (const uri of local) await deleteQuietly(uri);
  }
}

async function uploadWithRetry(
  uri: string,
  mimeType: string,
  kind: UploadKind,
  onProgress?: (pct: number) => void,
): Promise<Id<"decibelMeterUploads">> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await uploadOnce(uri, mimeType, kind, onProgress);
    } catch (error) {
      // A refusal (the daily limit, no school) won't change on a retry.
      if (error instanceof ConvexError || attempt >= RETRY_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS[attempt]));
    }
  }
}

/** Reserve an upload, send the file, and report where it landed. */
async function uploadOnce(
  uri: string,
  mimeType: string,
  kind: UploadKind,
  onProgress?: (pct: number) => void,
): Promise<Id<"decibelMeterUploads">> {
  const { uploadUrl, uploadId } = await convex.mutation(api.decibelMeter.generateUploadUrl, { kind });
  const task = FileSystem.createUploadTask(
    uploadUrl,
    uri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": mimeType },
    },
    onProgress
      ? ({ totalBytesSent, totalBytesExpectedToSend }) => {
          if (totalBytesExpectedToSend > 0) {
            onProgress(Math.min(99, Math.round((totalBytesSent / totalBytesExpectedToSend) * 100)));
          }
        }
      : undefined,
  );
  const response = await task.uploadAsync();
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`The upload answered ${response?.status ?? "nothing"}`);
  }
  const { storageId } = JSON.parse(response.body) as { storageId: Id<"_storage"> };
  await convex.mutation(api.decibelMeter.recordUpload, { uploadId, storageId });
  return uploadId;
}

async function poster(uri: string, durationMs: number): Promise<string | null> {
  try {
    const { uri: posterUri } = await VideoThumbnails.getThumbnailAsync(uri, {
      time: Math.max(0, Math.min(1500, durationMs / 2)),
      quality: 0.7,
    });
    return posterUri;
  } catch (error) {
    console.warn("[decibel meter] no poster for a take", error);
    return null;
  }
}

function videoMimeType(uri: string): string {
  return uri.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/quicktime";
}

/** The server's own words for a refusal it means (decibelMeter.ts `fail`). */
function refusal(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const message = (error.data as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : null;
}

// Files the camera and the extractor wrote, in the app's cache: deleting is
// allowed there, and one that won't go is left for iOS to reclaim.
async function deleteQuietly(uri: string) {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    console.warn("[decibel meter] could not delete a take's file", error);
  }
}
