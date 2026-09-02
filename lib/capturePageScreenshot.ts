/**
 * One-frame page screenshot for the "Report a bug" flow (web).
 *
 * Uses the browser Screen Capture API (`getDisplayMedia`) to grab a single
 * frame of the current tab, encode it as a SIZE-BOUNDED JPEG, and — critically
 * — stop the capture track immediately so no screen-share indicator lingers
 * (the blocker-class defect this helper is written around; same class as the
 * mic-left-live bug fixed in #1709).
 *
 * Must be called from within a user gesture (the account-menu click), AFTER the
 * caller has waited for the menu to leave the DOM (the single paint-settle lives
 * in AccountMenu's `waitForAccountMenuGone`, not here).
 *
 * Robustness contract:
 * - Frame acquisition is bounded by a timeout AND the caller's `AbortSignal`;
 *   acquisition is raced against cancellation so a stalled `grabFrame()` /
 *   `toBlob()` can never wedge the flow with a live track.
 * - Exactly one idempotent `stopStream()` stops every track on every path
 *   (success, no-frame, timeout, abort, error).
 * - The encoded JPEG is bounded well under the 8 MB server cap (long edge
 *   ≤ 2560 px, quality/scale ladder); if it can't get safely under, the helper
 *   degrades to `null` (no automatic screenshot) rather than a report-blocking
 *   oversized file.
 *
 * Never throws: any failure resolves to `null`, so the report flow degrades to a
 * screenshot-less dialog with the manual attach fallback.
 */

// Bound the whole frame-acquisition step (grabFrame / video-decode / toBlob).
const FRAME_TIMEOUT_MS = 4000;
// Long edge cap: high enough that triage text stays legible (do NOT drop to
// 1568 as the first move), low enough that a normal tab encodes tiny.
const MAX_LONG_EDGE = 2560;
// Safe client-side bound — comfortably under the 8 MB server cap.
const CLIENT_SAFE_BYTES = 6 * 1024 * 1024;
const QUALITY_LADDER = [0.85, 0.7, 0.55];
const SCALE_LADDER = [1, 0.75, 0.5];

type ImageCaptureLike = { grabFrame(): Promise<ImageBitmap> };

export interface CaptureOptions {
  signal?: AbortSignal;
}

export async function capturePageScreenshot(
  options: CaptureOptions = {},
): Promise<File | null> {
  const { signal } = options;
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getDisplayMedia !== "function" ||
    signal?.aborted
  ) {
    return null;
  }

  let stream: MediaStream | null = null;
  // Idempotent: stops every track exactly once; safe to call repeatedly.
  const stopStream = () => {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  };

  try {
    // `preferCurrentTab` + `displaySurface: "browser"` are Chrome hints that
    // skip the source picker for the current tab; other browsers ignore them
    // and show a normal picker, which is still fine.
    const displayOptions = {
      video: { displaySurface: "browser" },
      preferCurrentTab: true,
      audio: false,
    } as unknown as DisplayMediaStreamOptions;

    stream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
    // The permission prompt can outlast an unmount; bail (and stop the track
    // via finally) if we were cancelled while it was up.
    if (signal?.aborted) return null;

    const activeStream = stream;
    const blob = await withDeadline(
      (innerSignal) => grabBoundedJpeg(activeStream, innerSignal),
      FRAME_TIMEOUT_MS,
      signal,
    );
    if (!blob) return null;
    return new File([blob], "page-screenshot.jpg", { type: "image/jpeg" });
  } catch {
    return null;
  } finally {
    stopStream();
  }
}

/**
 * Resolve when `run` settles, OR when `timeoutMs` elapses, OR when `external`
 * aborts — whichever is first. On timeout/abort we return `null` and abort the
 * inner signal so downstream steps bail; the still-pending `run` promise is
 * harmlessly orphaned (the caller stops the track in `finally`, which settles
 * any wedged `grabFrame`).
 */
function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  external: AbortSignal | undefined,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const inner = new AbortController();
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
      resolve(value);
    };
    const onExternalAbort = () => {
      inner.abort();
      finish(null);
    };
    const timer = setTimeout(() => {
      inner.abort();
      finish(null);
    }, timeoutMs);
    if (external) {
      if (external.aborted) {
        inner.abort();
        finish(null);
        return;
      }
      external.addEventListener("abort", onExternalAbort);
    }
    run(inner.signal).then(
      (value) => finish(value),
      () => finish(null),
    );
  });
}

async function grabBoundedJpeg(
  stream: MediaStream,
  signal: AbortSignal,
): Promise<Blob | null> {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;

  // Prefer ImageCapture.grabFrame() where available (Chrome); fall back to
  // painting a <video> element (Safari/Firefox).
  let bitmap: ImageBitmap | null = null;
  const ImageCaptureCtor = (
    window as unknown as {
      ImageCapture?: new (track: MediaStreamTrack) => ImageCaptureLike;
    }
  ).ImageCapture;
  if (typeof ImageCaptureCtor === "function") {
    try {
      bitmap = await new ImageCaptureCtor(track).grabFrame();
    } catch {
      bitmap = null;
    }
  }
  if (signal.aborted) {
    bitmap?.close();
    return null;
  }

  let video: HTMLVideoElement | null = null;
  let source: CanvasImageSource;
  let width: number;
  let height: number;

  if (bitmap) {
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } else {
    video = await videoFromStream(stream, signal);
    if (!video) return null;
    source = video;
    width = video.videoWidth;
    height = video.videoHeight;
  }

  try {
    if (signal.aborted || !width || !height) return null;
    return await encodeBoundedJpeg(source, width, height, signal);
  } finally {
    bitmap?.close();
    cleanupVideo(video);
  }
}

/**
 * Draw + encode with a scale/quality ladder so the result stays under
 * CLIENT_SAFE_BYTES. Returns `null` (degrade to no screenshot) if even the most
 * aggressive step can't get safely under the bound.
 */
async function encodeBoundedJpeg(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  signal: AbortSignal,
): Promise<Blob | null> {
  const longEdge = Math.max(srcWidth, srcHeight);
  const cap = Math.min(1, MAX_LONG_EDGE / longEdge);
  for (const scaleStep of SCALE_LADDER) {
    if (signal.aborted) return null;
    const scale = cap * scaleStep;
    const w = Math.max(1, Math.round(srcWidth * scale));
    const h = Math.max(1, Math.round(srcHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    for (const quality of QUALITY_LADDER) {
      if (signal.aborted) return null;
      const blob = await toJpegBlob(canvas, quality);
      if (blob && blob.size <= CLIENT_SAFE_BYTES) return blob;
    }
  }
  return null;
}

function toJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
  });
}

function videoFromStream(
  stream: MediaStream,
  signal: AbortSignal,
): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    let settled = false;
    const finish = (result: HTMLVideoElement | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish(null);
    if (signal.aborted) {
      finish(null);
      return;
    }
    signal.addEventListener("abort", onAbort);
    video.onloadeddata = () => {
      // One more frame so a pixel is actually decoded before we draw.
      requestAnimationFrame(() => finish(video));
    };
    video.onerror = () => finish(null);
    void video.play().catch(() => {});
  });
}

function cleanupVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.pause();
  video.srcObject = null;
}
