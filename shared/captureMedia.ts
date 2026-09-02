// Capture-media vocabulary shared by every surface that renders a capture
// row: the native kiosk gallery, the staff uploads queue, and the Run page's
// Submissions panel. One duration format and one mime→kind mapping — do not
// fork these per surface (see review/program-portfolio-review-plan.html).

export type CaptureMediaKind = "photo" | "video";

/** A capture is a video iff its mime type says so; everything else renders as
 *  a photo/still (the capture pipeline only admits image/* and video/*). */
export function captureMediaKind(
  mimeType: string | null | undefined,
): CaptureMediaKind {
  return mimeType?.toLowerCase().startsWith("video/") ? "video" : "photo";
}

/** Formats a video duration in milliseconds as "m:ss" (e.g. 58000 → "0:58"). */
export function formatCaptureDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
