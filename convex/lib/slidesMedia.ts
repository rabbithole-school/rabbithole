const SUPPORTED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
]);

const UNSUPPORTED_SLIDE_IMAGE_ERROR =
  "Slide image has an unsupported or unrecognized file type";

function normalizedMime(declared: string) {
  return declared.toLowerCase().split(";")[0].trim();
}

function matchesBytes(bytes: Uint8Array, signature: number[], offset = 0) {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((byte, index) => bytes[offset + index] === byte)
  );
}

function hasIsoBaseMediaHeader(bytes: Uint8Array) {
  return (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

export function detectSlideVideoMime(bytes: Uint8Array, declared: string): string {
  const mime = normalizedMime(declared);
  if (!SUPPORTED_VIDEO_MIME_TYPES.has(mime) || !hasIsoBaseMediaHeader(bytes)) {
    throw new Error("Slide video has an unsupported or unrecognized file type");
  }
  return mime;
}

/**
 * Exporters receive arbitrary storage blobs. The declared content type is
 * metadata supplied by the upload client, so only recognized bytes can select
 * an image MIME for an exported slide.
 */
export function detectSlideImageMime(bytes: Uint8Array, _declared: string): string {
  if (matchesBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (matchesBytes(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    matchesBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    matchesBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    matchesBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    matchesBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  throw new Error(UNSUPPORTED_SLIDE_IMAGE_ERROR);
}
