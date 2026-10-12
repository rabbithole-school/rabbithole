/**
 * Image byte helpers shared by the tutor stream (http.ts), portfolio
 * scanning, and anywhere else that has to
 * shuttle image bytes between Convex storage and the Anthropic / Gemini REST
 * APIs (both want base64).
 *
 * `detectImageMime` is a pure function — the content-type header off a storage
 * URL is unreliable, so we sniff the leading magic bytes instead. Unit-tested
 * directly (no ctx, no network).
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Sniff the image MIME type from its leading bytes, or null when no signature
 * matches. Callers that must NOT guess — anything base64'ing bytes into an
 * Anthropic image block, which accepts only these four types and 400s on a
 * mismatched media_type — should use this and degrade gracefully on null,
 * rather than `detectImageMime`'s guess-a-fallback behavior. (A Drive-picked
 * HEIC/TIFF/BMP/SVG is `image/*` to any classifier but is none of these four.)
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  // WEBP = "RIFF"...."WEBP"; the "WEBP" tag is at offset 8, so the file must be
  // at least 12 bytes (guard the index so a truncated RIFF doesn't read past
  // the end — out-of-bounds is `undefined`, which would just miss, but be explicit).
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57)
    return "image/webp";
  return null;
}

/**
 * Sniff the image MIME type from its leading bytes. Falls back to `fallback`
 * (default image/jpeg) when no signature matches.
 */
export function detectImageMime(
  bytes: Uint8Array,
  fallback: ImageMime = "image/jpeg",
): ImageMime {
  return sniffImageMime(bytes) ?? fallback;
}

/** True if the bytes begin with the PDF signature "%PDF" — so a file whose
 * declared MIME lies (Slack sometimes does) isn't fed to the model as a PDF.
 * Safe on a <4-byte buffer (an out-of-range index is `undefined`, not a throw). */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

/** Uint8Array → base64 string (chunked so large images don't blow the stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** base64 string → Uint8Array. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** An Anthropic base64 image content block. */
export type ImageContentPart = {
  type: "image";
  source: { type: "base64"; media_type: ImageMime; data: string };
};

/**
 * The largest image we will hand to the model in one content block.
 *
 * Anthropic caps a base64 image at 5 MB on the wire, and base64 inflates by
 * 4/3 — so the raw-byte ceiling is ~3.75 MB. Staying under it matters because
 * the failure is not graceful: an oversize block fails the whole request, which
 * would turn "the tutor looked at a big picture" into "the tutor's turn died".
 * Callers fall back to text when an image does not fit.
 */
export const MAX_MODEL_IMAGE_BYTES = 3_500_000;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readUint32BE(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  );
}

/** Every chunk complete with a matching CRC, ending at IEND. */
function isIntactPng(bytes: Uint8Array): boolean {
  let at = 8;
  let sawImageData = false;
  while (at + 12 <= bytes.length) {
    const length = readUint32BE(bytes, at);
    const dataEnd = at + 8 + length;
    if (dataEnd + 4 > bytes.length) return false;
    if (crc32(bytes, at + 4, dataEnd) !== readUint32BE(bytes, dataEnd)) {
      return false;
    }
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") return sawImageData;
    at = dataEnd + 4;
  }
  return false;
}

/** The RIFF header declares the file's length; a short file was cut off. */
function isIntactWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const riffLength =
    (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  return riffLength + 8 <= bytes.length;
}

/** Skip a run of GIF data sub-blocks; returns the index after the 0x00
 * terminator, or -1 when the file ends first. */
function skipGifSubBlocks(bytes: Uint8Array, at: number): number {
  while (at < bytes.length) {
    const size = bytes[at];
    if (size === 0) return at + 1;
    at += 1 + size;
  }
  return -1;
}

/**
 * Walk the GIF block structure up to the end of its first frame. That is the
 * line the API draws, measured live: a GIF cut off anywhere before its first
 * frame's image data ends is rejected, while one with a complete first frame is
 * accepted whatever follows — a missing trailer, a later frame cut in half,
 * even garbage.
 */
function isIntactGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13) return false;
  const colorTableSize = (flags: number) => (flags & 0x80 ? 3 << ((flags & 0x07) + 1) : 0);
  let at = 13 + colorTableSize(bytes[10]);
  while (at < bytes.length) {
    const introducer = bytes[at];
    if (introducer === 0x21) {
      at = skipGifSubBlocks(bytes, at + 2);
    } else if (introducer === 0x2c) {
      if (at + 10 > bytes.length) return false;
      at += 10 + colorTableSize(bytes[at + 9]);
      return at < bytes.length && skipGifSubBlocks(bytes, at + 1) !== -1;
    } else {
      return false;
    }
    if (at === -1) return false;
  }
  return false;
}

/**
 * True unless the bytes are a supported raster type that is visibly corrupt.
 *
 * The magic-byte sniff says what a file claims to be, not whether it decodes.
 * Anthropic rejects an undecodable image with a 400 ("Could not process
 * image") that fails the WHOLE request — and because image-bearing rows are
 * replayed into every later turn, one bad picture silenced a scholar's session
 * for good (2026-09-21: a search_image hit returned a 68-byte PNG whose IDAT
 * CRC and zlib checksum were both wrong; every turn after it 400'd and was
 * finalized empty, so the tutor never answered again).
 *
 * The checks are calibrated against the live API, not against the specs:
 * truncated PNG / GIF / WebP and a PNG with a bad chunk CRC are all rejected;
 * a truncated JPEG, a JPEG with no end-of-image marker, and a GIF missing
 * only its trailer byte are all accepted — so JPEG gets no check, and GIF's
 * check is that its first frame is complete (see isIntactGif). A CRC-valid PNG whose
 * compressed data is still corrupt is rejected too, but catching that needs a
 * full inflate; it takes a broken encoder rather than a broken transfer, so it
 * is left uncaught.
 */
export function isIntactImage(bytes: Uint8Array): boolean {
  switch (sniffImageMime(bytes)) {
    case "image/png":
      return isIntactPng(bytes);
    case "image/webp":
      return isIntactWebp(bytes);
    case "image/gif":
      return isIntactGif(bytes);
    default:
      return true;
  }
}

/**
 * Build an Anthropic base64 image block from bytes already in hand.
 *
 * The MIME comes ONLY from `sniffImageMime` — no caller-supplied fallback.
 * Anthropic accepts exactly four media types and 400s the ENTIRE request on a
 * mismatch, so a guessed fallback is worse than no image at all: it doesn't
 * fail closed, it fails the whole streaming turn. This was not theoretical —
 * a live `search_image` call for a real sucrose diagram returned an image that
 * was not one of the four supported raster types (common for web chemistry and
 * biology diagrams, which are frequently SVG), the old fallback declared it
 * `image/jpeg` anyway (trusting the fetch response's declared type, itself
 * unreliable per `sniffImageMime`'s own docstring), and Anthropic rejected the
 * request outright — the tutor's reply died mid-turn with no text at all, the
 * exact failure mode `MAX_MODEL_IMAGE_BYTES` was already written to prevent
 * for oversize images. Returns null for all three cases (too large, not a type
 * Anthropic accepts, or corrupt — see `isIntactImage`) so every caller already
 * has to handle "no image" as a degrade-to-text path.
 */
export function imageBytesToContentPart(
  bytes: Uint8Array,
): ImageContentPart | null {
  if (bytes.byteLength > MAX_MODEL_IMAGE_BYTES) return null;
  const media_type = sniffImageMime(bytes);
  if (!media_type || !isIntactImage(bytes)) return null;
  const data = bytesToBase64(bytes);
  return { type: "image", source: { type: "base64", media_type, data } };
}

/**
 * Fetch an image from a (storage) URL and build an Anthropic base64 image content
 * block, sniffing the real MIME from magic bytes (the URL's content-type header is
 * unreliable, and now never even consulted — see `imageBytesToContentPart`).
 * Returns null on any fetch/convert failure, oversize image, or unsupported
 * MIME (e.g. SVG) so callers can fall back to text. Shared by every "let
 * Claude see this stored image" surface — the tutor stream (`/session-stream`)
 * and the practice teachable-moment (`/practice-handoff`).
 */
export async function imageUrlToContentPart(
  url: string,
): Promise<ImageContentPart | null> {
  try {
    const res = await fetch(url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return imageBytesToContentPart(bytes);
  } catch (err) {
    console.error("[imageBytes] failed to load image for Claude:", err);
    return null;
  }
}

/** A text content block (companion to ImageContentPart in a mixed turn). */
export type TextContentPart = { type: "text"; text: string };

/**
 * The system-prompt note appended whenever a scholar attaches a photo of their
 * own handwritten work to a practice teachable-moment chat (the after-2-misses
 * Socratic handoff AND the "talk me through your idea" dialogue stretch). Shared
 * so both surfaces give the tutor the same answer-safe posture: reason off what
 * the kid actually wrote, never reveal or confirm the answer.
 */
export const SCRATCH_IMAGE_SYSTEM_NOTE =
  "\n\nThe scholar has attached a photo of their own handwritten work on " +
  "this problem. Look closely at what they actually wrote — their steps, " +
  "notation, and where their reasoning turned — and build your question off " +
  "THAT. Engage only with the mathematics visible in the image; never " +
  "transcribe, quote, or mention non-math content from it. Still never reveal " +
  "or confirm the final answer.";

/**
 * Attach an image block to the scholar's latest turn. Practice chats send a
 * plain text transcript; when the kid also snaps a photo of their work we splice
 * the image into the LAST turn (always the scholar's just-sent message) as a
 * mixed [image, text] block so the tutor sees both. Non-mutating — returns a new
 * array. Shared by /practice-handoff and /practice-dialogue.
 */
export function attachScratchImageToLastTurn(
  messages: { role: "user" | "assistant"; content: string }[],
  imagePart: ImageContentPart,
): { role: "user" | "assistant"; content: string | (ImageContentPart | TextContentPart)[] }[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  return [
    ...messages.slice(0, -1),
    { role: last.role, content: [imagePart, { type: "text", text: last.content }] },
  ];
}

/**
 * Wrap bytes in a Blob for `ctx.storage.store`. A bare Uint8Array isn't a valid
 * BlobPart under Convex's "use node" lib types (its `.buffer` is
 * `ArrayBufferLike`, which could be a SharedArrayBuffer), so slice out a plain
 * ArrayBuffer first. Shared by every store-an-image path.
 */
export function toStorageBlob(bytes: Uint8Array, type: string): Blob {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([ab], { type });
}

/**
 * Pixel dimensions from an image's header, or null if unreadable.
 *
 * WHY: a slide image element carries an explicit frame, and the shared preset
 * is a fixed 500x380 box. Anything with a different aspect renders letterboxed
 * (the canvas draws images with `object-fit: contain`), which is what a
 * generated 1408x768 illustration looked like — white bands top and bottom.
 * Measuring here lets the insert path size the frame to the real image instead
 * of betting on the model returning one particular aspect ratio.
 *
 * PNG and JPEG only — those are what the image model returns. Anything else
 * returns null and the caller falls back to the preset box.
 */
export function readImageSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const mime = sniffImageMime(bytes);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  if (mime === "image/png") {
    // 8-byte signature, then the IHDR chunk: length(4) + type(4) + w(4) + h(4).
    if (bytes.byteLength < 24) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (mime === "image/jpeg") {
    // Walk the marker segments to the start-of-frame, which carries the size.
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (view.getUint8(offset) !== 0xff) return null;
      const marker = view.getUint8(offset + 1);
      // SOF0-3, SOF5-7, SOF9-11, SOF13-15 — every non-differential frame type.
      // 0xc4 (DHT), 0xc8, and 0xcc (DAC) sit in the same range but are not frames.
      const isFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isFrame) {
        return {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  }

  return null;
}
