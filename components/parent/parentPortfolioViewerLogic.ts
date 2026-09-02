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
