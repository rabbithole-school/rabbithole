// Client-side clip recording for the composer's Capture Video / Record Audio
// dialogs. The PURE parts here (mime negotiation, file naming, contact-sheet
// frame timing) are unit-tested; the browser parts (MediaRecorder wrapper,
// contact-sheet extraction via an offscreen <video> + canvas) are exercised by
// hand. Kept out of the dialog components so the arithmetic is testable and the
// two dialogs share one recorder.

export type ClipKind = "audio" | "video";

// Preference order, most-capable container first. VP9 is smaller for the same
// quality; Safari records only mp4. Mirrors useVoiceDictation's audio ladder.
const VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
] as const;

const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

/** First container the platform can record for this kind, or null if none. */
export function negotiateRecorderMimeType(
  kind: ClipKind,
  isTypeSupported: (mime: string) => boolean,
): string | null {
  const candidates =
    kind === "video" ? VIDEO_MIME_CANDIDATES : AUDIO_MIME_CANDIDATES;
  for (const mime of candidates) {
    if (isTypeSupported(mime)) return mime;
  }
  return null;
}

/** audio → webm|m4a, video → webm|mp4 (mp4-family containers get the friendly
 *  per-kind extension; everything else is webm). */
export function clipFileExtension(kind: ClipKind, mimeType: string): string {
  const isMp4 = mimeType.toLowerCase().includes("mp4");
  if (kind === "audio") return isMp4 ? "m4a" : "webm";
  return isMp4 ? "mp4" : "webm";
}

/**
 * The bare container mime type, with the codecs (and any other) parameters
 * stripped: 'video/webm;codecs=vp9,opus' → 'video/webm'. The recorded File's
 * `type` becomes the upload's Content-Type header, and a codecs list contains a
 * comma — invalid in an HTTP header, which Convex storage rejects with a 400
 * BadHeader. Keep the FULL negotiated mime for the MediaRecorder itself (it
 * needs the codecs); use this only for the File/header.
 */
export function containerMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim();
}

/** `audio-<ts>.webm`, `video-<ts>.mp4`, matching the camera dialog's naming. */
export function clipFileName(
  kind: ClipKind,
  mimeType: string,
  ts: number = Date.now(),
): string {
  return `${kind}-${ts}.${clipFileExtension(kind, mimeType)}`;
}

/**
 * Sample times (ms) for an N-frame contact sheet: the midpoint of each of N
 * equal segments, so we skip the usually-black very first/last frame and keep
 * the frames evenly spread across the clip.
 */
export function contactSheetFrameTimes(
  durationMs: number,
  frameCount = 4,
): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || frameCount <= 0) {
    return [];
  }
  const times: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    times.push((durationMs * (i + 0.5)) / frameCount);
  }
  return times;
}

// ── Browser-only recorder wrapper ──────────────────────────────────────────

export type ClipRecorder = {
  mimeType: string;
  /** Begin recording. Returns false if the underlying recorder threw
   *  synchronously (surfaced via onError as well). */
  start: () => boolean;
  /** Stop and keep the recording (fires onStop with the blob). */
  stop: () => void;
  /** Stop and discard the recording (fires onStop with null). */
  cancel: () => void;
  state: () => RecordingState;
};

/**
 * Wraps a MediaRecorder over an existing stream. Returns null when the platform
 * has no MediaRecorder or no supported container for this kind — the caller
 * shows the secure-context / unsupported message instead.
 */
export function createClipRecorder(
  stream: MediaStream,
  opts: {
    kind: ClipKind;
    bitsPerSecond: number;
    onStop: (blob: Blob | null) => void;
    onError?: (err: unknown) => void;
  },
): ClipRecorder | null {
  if (typeof MediaRecorder === "undefined") return null;
  const mimeType = negotiateRecorderMimeType(opts.kind, (m) =>
    MediaRecorder.isTypeSupported(m),
  );
  if (mimeType === null) return null;

  const recorderOptions: MediaRecorderOptions = { mimeType };
  if (opts.kind === "video") {
    recorderOptions.videoBitsPerSecond = opts.bitsPerSecond;
  } else {
    recorderOptions.audioBitsPerSecond = opts.bitsPerSecond;
  }

  // `new MediaRecorder` can throw synchronously (NotSupportedError) even after
  // isTypeSupported said yes — e.g. the bitrate/container combo is refused.
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, recorderOptions);
  } catch (err) {
    opts.onError?.(err);
    return null;
  }
  const chunks: Blob[] = [];
  let cancelled = false;

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    opts.onStop(cancelled ? null : new Blob(chunks, { type: mimeType }));
  };
  recorder.onerror = (e) => opts.onError?.(e);

  return {
    mimeType,
    start: () => {
      // start() can also throw synchronously (e.g. an already-inactive stream);
      // report it instead of leaving a dead Record button.
      try {
        recorder.start();
        return true;
      } catch (err) {
        opts.onError?.(err);
        return false;
      }
    },
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
    cancel: () => {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
    },
    state: () => recorder.state,
  };
}

// ── Browser-only contact sheet ─────────────────────────────────────────────

function waitForEvent(el: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`media ${event} failed`));
    };
    const cleanup = () => {
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
    };
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

function seekTo(
  video: HTMLVideoElement,
  timeSeconds: number,
  timeoutMs = 800,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      resolve(ok);
    };
    const onSeeked = () => finish(true);
    // A 'seeked' event that never fires (a bad keyframe, a stalled decode) must
    // not hang the whole sheet — skip this frame and keep the ones we have.
    const timer = setTimeout(() => finish(false), timeoutMs);
    video.addEventListener("seeked", onSeeked, { once: true });
    try {
      video.currentTime = Math.max(0, timeSeconds);
    } catch {
      finish(false);
    }
  });
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(dw / vw, dh / vh);
  const sw = dw / scale;
  const sh = dh / scale;
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;
  ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.82);
  });
}

/**
 * A MediaRecorder webm blob (Chrome, Firefox) carries no duration in its
 * header, so the element reports `duration = Infinity` and seeks stall. The
 * standard fix is to seek far past the end: the browser scans the whole blob,
 * fires `durationchange` with the real length, and seeking works from then on.
 */
async function resolveDuration(
  video: HTMLVideoElement,
  knownDurationMs: number | undefined,
  timeoutMs = 1500,
): Promise<number | undefined> {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }
  const settled = await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("durationchange", onChange);
      resolve(ok);
    };
    const onChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) finish(true);
    };
    // Bound the wait: if `durationchange` never fires with a finite length,
    // fall through to the recorder's measured length instead of hanging until
    // the outer buildContactSheet timeout (which would abandon the poster).
    const timer = setTimeout(() => finish(false), timeoutMs);
    video.addEventListener("durationchange", onChange);
    try {
      video.currentTime = 1e101;
    } catch {
      finish(false);
    }
  });
  if (settled) return video.duration;
  return knownDurationMs && knownDurationMs > 0
    ? knownDurationMs / 1000
    : undefined;
}

async function extractContactSheet(
  video: HTMLVideoElement,
  frameCount: number,
  tileSize: number,
  knownDurationMs: number | undefined,
): Promise<File | undefined> {
  await waitForEvent(video, "loadedmetadata");
  const durationSeconds = await resolveDuration(video, knownDurationMs);
  if (durationSeconds === undefined) return undefined;

  const times = contactSheetFrameTimes(durationSeconds * 1000, frameCount).map(
    (ms) => ms / 1000,
  );
  const cols = Math.min(2, frameCount);
  const rows = Math.ceil(frameCount / cols);

  const canvas = document.createElement("canvas");
  canvas.width = cols * tileSize;
  canvas.height = rows * tileSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let drawn = 0;
  for (let i = 0; i < times.length; i++) {
    const ok = await seekTo(video, times[i]);
    if (!ok || video.videoWidth === 0) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    drawCover(ctx, video, col * tileSize, row * tileSize, tileSize, tileSize);
    drawn++;
  }
  if (drawn === 0) return undefined;

  const blob = await canvasToJpeg(canvas);
  if (!blob) return undefined;
  return new File([blob], `poster-${Date.now()}.jpg`, { type: "image/jpeg" });
}

function withTimeout<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Render up to `frameCount` evenly spaced frames from a recorded video blob
 * into a single 2×2 JPEG contact sheet, so the model gets one glance at what
 * the camera saw. Returns undefined (never throws) if extraction fails or does
 * not finish within `timeoutMs` — the caller then attaches the clip with no
 * poster.
 */
export async function buildContactSheet(
  blob: Blob,
  opts: {
    frameCount?: number;
    timeoutMs?: number;
    tileSize?: number;
    /** The recorder's measured length — the fallback when the blob's own
     *  header has none (see resolveDuration). */
    durationMs?: number;
  } = {},
): Promise<File | undefined> {
  const frameCount = opts.frameCount ?? 4;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const tileSize = opts.tileSize ?? 320;
  if (typeof document === "undefined") return undefined;

  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    return await withTimeout(
      timeoutMs,
      extractContactSheet(video, frameCount, tileSize, opts.durationMs),
    );
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}
