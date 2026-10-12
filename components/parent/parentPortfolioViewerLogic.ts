export function viewerIndexForKey(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount === 0) return null;
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, currentIndex - 1);
    case "ArrowRight":
      return Math.min(itemCount - 1, currentIndex + 1);
    case "Home":
      return 0;
    case "End":
      return itemCount - 1;
    default:
      return null;
  }
}

export function isVideoMedia(mimeType?: string): boolean {
  return mimeType?.startsWith("video/") ?? false;
}

export function pageCountForRange(
  pageRange?: { start: number; end: number },
): number | null {
  if (
    !pageRange ||
    !Number.isInteger(pageRange.start) ||
    !Number.isInteger(pageRange.end) ||
    pageRange.start < 1 ||
    pageRange.end < pageRange.start
  ) {
    return null;
  }
  return pageRange.end - pageRange.start + 1;
}

/**
 * A capture-station video's length, for the duration pill on its card:
 * "0:42", "12:05", "1:01:01". Returns null for a missing or nonsensical
 * duration so the pill simply doesn't render.
 */
export function formatVideoDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
