// Single source of truth for which file types the scanner-inbox pipeline can
// actually ingest. The pipeline only knows how to (a) segment PDFs and
// (b) hand raster images to Claude vision as an image block. Claude's image
// block supports exactly jpeg/png/webp/gif, so the ingestible set is those
// four image types plus PDF — nothing else.
//
// This list MUST stay in lockstep with what `imageMediaType` below can return.
// Previously three places disagreed (a 7-entry upload allow-list that included
// HEIC, a `startsWith("image/")` watch check that accepted any image, and this
// 4-entry image map), which let HEIC uploads and TIFF/BMP/HEIC watch files
// reach Claude mislabeled as PDFs and fail. Keep it one set.

/** MIME types the scanner pipeline can ingest (PDF + Claude-supported images). */
export const INGESTIBLE_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** True if the scanner pipeline can ingest this MIME type. */
export function isIngestibleMime(mime: string | undefined | null): boolean {
  return !!mime && INGESTIBLE_MIMES.has(mime);
}

/**
 * Map a MIME type to the media_type Claude's image block accepts, or null if
 * it isn't a supported raster image (PDFs and unsupported types return null —
 * PDFs go through the document/segmentation path instead).
 */
export function imageMediaType(
  mime: string,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  switch (mime) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
      return mime;
    default:
      return null;
  }
}
