/**
 * Sizing rules for downscaling a scholar's photo before it is uploaded.
 *
 * Pure math, shared by the web canvas resizer (`lib/downscalePhoto.ts`) and the
 * native Skia resizer (`native/src/lib/downscalePhoto.ts`, via the vendored
 * copy) so both clients cap photos at the same size.
 */

/**
 * The longest edge, in pixels, a photo keeps after downscaling.
 *
 * 1568 px is Claude's own limit: the API resizes any image whose long edge is
 * past it before the model sees it, so extra pixels change nothing about what
 * the tutor can read. They still cost memory in every tutor turn that replays
 * the session's images, plus upload time and storage. A full-size iPad photo
 * (4032 × 3024, 2.5–4 MB) once ran the tutor stream out of memory, and photos
 * past the server's 3.5 MB per-image cap were silently dropped from the
 * tutor's view.
 */
export const MODEL_IMAGE_MAX_EDGE_PX = 1568;

/** JPEG quality (0–1) for a downscaled photo. */
export const DOWNSCALED_JPEG_QUALITY = 0.8;

export type ImageSize = { width: number; height: number };

/**
 * The size to downscale an image to, or null when it should be left alone:
 * the long edge already fits, or the dimensions are unusable. Never upscales.
 * Aspect ratio is kept, and neither edge rounds down to zero.
 */
export function downscaleTarget(
  size: ImageSize,
  maxEdge: number = MODEL_IMAGE_MAX_EDGE_PX,
): ImageSize | null {
  const { width, height } = size;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
    return null;
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return null;
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * True when a decoder returned the image a quarter turn away from how it is
 * displayed: portrait where the picker reported landscape, or the reverse.
 * Re-encoding such pixels would bake the photo in sideways, so a caller
 * should upload the original instead. Square images can't be told apart and
 * pass.
 */
export function decodedSideways(decoded: ImageSize, displayed: ImageSize): boolean {
  const decodedLandscape = decoded.width > decoded.height;
  const displayedLandscape = displayed.width > displayed.height;
  const decodedPortrait = decoded.width < decoded.height;
  const displayedPortrait = displayed.width < displayed.height;
  return (
    (decodedLandscape && displayedPortrait) || (decodedPortrait && displayedLandscape)
  );
}
