"use node";

/**
 * Normalize generated charm illustrations for reliable printing.
 *
 * Image models can ignore even explicit "pure white background" instructions
 * and return a gray/cream paper field or vignette. The letter must not depend
 * on prompt compliance for its white-paper contract, so this final shared
 * image step converts every illustration to neutral black ink,
 * deterministically lifts near-white background pixels to pure white, and
 * expands the contrast of darker linework.
 */
export function normalizeSketchPixels(raw: Uint8Array): Uint8Array {
  const normalized = raw.slice();
  for (let i = 0; i + 3 < normalized.length; i += 4) {
    const luminance = Math.round(
      normalized[i] * 0.2126 +
        normalized[i + 1] * 0.7152 +
        normalized[i + 2] * 0.0722,
    );
    // Everything at or above this level is paper/background. Below it, use a
    // nonlinear curve that keeps anti-aliased edges but darkens intentional
    // marks into crisp, high-contrast ink for ordinary school/home printers.
    const ink =
      luminance >= 205
        ? 255
        : Math.round(190 * Math.pow(luminance / 205, 1.5));
    normalized[i] = ink;
    normalized[i + 1] = ink;
    normalized[i + 2] = ink;
    normalized[i + 3] = 255;
  }
  return normalized;
}

export async function normalizeSketchImage(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const photon = await import("@cf-wasm/photon/node");
  const source = photon.PhotonImage.new_from_byteslice(bytes);
  try {
    const normalized = new photon.PhotonImage(
      normalizeSketchPixels(source.get_raw_pixels()),
      source.get_width(),
      source.get_height(),
    );
    try {
      return normalized.get_bytes_jpeg(92);
    } finally {
      normalized.free();
    }
  } finally {
    source.free();
  }
}
