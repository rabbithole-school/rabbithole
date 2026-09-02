"use node";

// Thumbnail rendering for portfolio files — runs inside the Convex node runtime
// (called from the "use node" action in portfolioThumbs.ts). This module is
// itself "use node" because PDFium's emscripten glue imports node:module /
// node:fs at load; without the directive Convex's analysis pass walks those in
// the default runtime and rejects the push. The heavy WASM libs are still
// dynamic-imported so they only load when renderThumbnailJpeg actually runs.
//
// Convex File Storage is blob-only (no native transforms), so the idiomatic
// pattern is: action reads bytes -> we derive a JPEG -> action stores it. We
// use two WASM libs that bundle + run in the Convex node runtime (proven):
//
//   - @cf-wasm/photon   -> image decode + resize + JPEG encode (inlined wasm)
//   - @hyzyla/pdfium    -> rasterize PDF pages (wasm fed in via
//                          getPdfiumWasmBinary; MIT wrapper over BSD-3 PDFium)
//
// Both are pure-WASM, so files never leave our infra. No sharp / node-canvas
// (native) — those don't deploy on Convex.

import type { PDFiumDocument } from "@hyzyla/pdfium";
import { PNG } from "pngjs";

/** Longest edge of the generated thumbnail, in px. Covers the 140px card. */
const MAX_EDGE = 512;
/** JPEG quality for the thumbnail. */
const JPEG_QUALITY = 78;
/** DPI to rasterize a PDF page at before downscaling. 110 keeps text legible
 *  at 512px without rendering a needlessly huge pixmap. */
const PDF_RASTER_DPI = 110;

/** Resize a decoded photon image to fit MAX_EDGE and JPEG-encode it. */
function resizeToJpeg(
  photon: typeof import("@cf-wasm/photon"),
  img: InstanceType<typeof import("@cf-wasm/photon").PhotonImage>,
): Uint8Array {
  const w = img.get_width();
  const h = img.get_height();
  const scale = Math.min(MAX_EDGE / w, MAX_EDGE / h, 1);
  if (scale >= 1) {
    // Already small enough — just re-encode as JPEG.
    return img.get_bytes_jpeg(JPEG_QUALITY);
  }
  const resized = photon.resize(
    img,
    Math.max(1, Math.round(w * scale)),
    Math.max(1, Math.round(h * scale)),
    photon.SamplingFilter.Lanczos3,
  );
  try {
    return resized.get_bytes_jpeg(JPEG_QUALITY);
  } finally {
    resized.free();
  }
}

/** Image path: decode -> resize -> JPEG, all in photon. */
async function imageThumb(bytes: Uint8Array): Promise<Uint8Array> {
  // /node subpath = inlined-wasm build (the bare specifier resolves to the
  // workerd build under Convex's esbuild and traps at runtime).
  const photon = await import("@cf-wasm/photon/node");
  const img = photon.PhotonImage.new_from_byteslice(bytes);
  try {
    return resizeToJpeg(photon, img);
  } finally {
    img.free();
  }
}

/**
 * Open a PDF with PDFium and hand the document to `fn`, tearing both the
 * document and the library down afterwards.
 *
 * A fresh library per call is deliberate: init costs ~10ms (the wasm bytes are
 * already decoded and cached by the generated module), while a long-lived
 * instance would carry an emscripten heap that only ever grows across the many
 * files one warm Convex container processes.
 */
async function withPdfDocument<T>(
  bytes: Uint8Array,
  fn: (doc: PDFiumDocument) => Promise<T>,
): Promise<T> {
  // Feed PDFium its wasm bytes so it never reads from disk (Convex ships no
  // .wasm asset). With `wasmBinary` set the loader short-circuits its
  // `new URL("pdfium.wasm", import.meta.url)` + fs.readFileSync path entirely.
  const { getPdfiumWasmBinary } = await import("./pdfiumWasm.generated");
  const wasm = getPdfiumWasmBinary();
  const { PDFiumLibrary } = await import("@hyzyla/pdfium");
  const library = await PDFiumLibrary.init({
    wasmBinary: wasm.buffer.slice(
      wasm.byteOffset,
      wasm.byteOffset + wasm.byteLength,
    ) as ArrayBuffer,
  });
  try {
    const doc = await library.loadDocument(bytes);
    try {
      return await fn(doc);
    } finally {
      doc.destroy();
    }
  } finally {
    library.destroy();
  }
}

/**
 * Rasterize one page to raw RGBA at `dpi`.
 *
 * `colorSpace` and `transparent` are passed EXPLICITLY even though they match
 * the library's current defaults: both are load-bearing here, so a future
 * default change upstream must break the build rather than silently corrupt
 * every thumbnail. `colorSpace: "BGRA"` sets FPDF_REVERSE_BYTE_ORDER, so the
 * bytes actually come back RGBA — exactly what photon's raw-pixel constructor
 * and pngjs both want; flipping it would swap red and blue in every render.
 * `transparent: false` fills the bitmap white first, so scans get a white
 * background rather than a transparent halo.
 *
 * Size: the wrapper computes `floor(floor(width) * scale)`, so we pass the
 * already-rounded pixel size with `scale: 1` and do the DPI arithmetic in one
 * expression — `(points * dpi) / 72` is exact for the common page sizes, where
 * `points * (dpi / 72)` drifts by an ulp and pushes ceil() a pixel too far.
 */
async function renderPageRgba(
  doc: PDFiumDocument,
  pageIndex: number,
  dpi: number,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const page = doc.getPage(pageIndex);
  const { originalWidth, originalHeight } = page.getOriginalSize();
  const render = await page.render({
    scale: 1,
    width: Math.ceil((originalWidth * dpi) / 72),
    height: Math.ceil((originalHeight * dpi) / 72),
    render: "bitmap",
    colorSpace: "BGRA",
    transparent: false,
  });
  return { data: render.data, width: render.width, height: render.height };
}

/** Encode raw RGBA as a PNG, dropping the (always-opaque) alpha channel. */
function rgbaToPng(data: Uint8Array, width: number, height: number): Uint8Array {
  const png = new PNG({ width, height, colorType: 2, inputColorType: 6 });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(
    PNG.sync.write(png, { colorType: 2, inputColorType: 6 }),
  );
}

/** PDF path: rasterize page 1 with PDFium -> resize/encode with photon. */
async function pdfThumb(bytes: Uint8Array): Promise<Uint8Array> {
  return withPdfDocument(bytes, async (doc) => {
    if (doc.getPageCount() < 1) throw new Error("PDF has no pages");
    const raster = await renderPageRgba(doc, 0, PDF_RASTER_DPI);

    const photon = await import("@cf-wasm/photon/node");
    const img = new photon.PhotonImage(
      raster.data,
      raster.width,
      raster.height,
    );
    try {
      return resizeToJpeg(photon, img);
    } finally {
      img.free();
    }
  });
}

/**
 * Render a ~512px JPEG thumbnail for a portfolio file. Returns the JPEG bytes,
 * or null if the mime type isn't thumbnailable (caller treats null as "no
 * thumb — fall back to the icon"). Throws only on genuine processing failure.
 */
export async function renderThumbnailJpeg(
  bytes: Uint8Array,
  mime: string,
): Promise<Uint8Array | null> {
  if (mime.startsWith("image/")) return imageThumb(bytes);
  if (mime === "application/pdf") return pdfThumb(bytes);
  return null;
}

/** DPI for a full-page raster handed to an image model — bigger than the
 *  thumbnail DPI so the model has real detail to read/redraw. 150 DPI ≈
 *  1275×1650 for US Letter, a good input size without being wasteful. */
const PDF_MODEL_DPI = 150;

/** Upper bound on pages we rasterize for Magic detection on a single item, so a
 *  pathologically long submission can't blow up an action. A per-student
 *  segment is normally a handful of pages; the cap only bites on outliers
 *  (caller logs when it truncates). */
const MAGIC_MAX_PAGES = 30;

/**
 * Rasterize each page of a PDF to a full-resolution PNG (no thumbnail
 * downscale) so the pages can be handed to an image model — Magic Annotations
 * needs images, not a PDF, and has to look at EVERY page (a marker can be on
 * any page of a multi-page submission). Opens the document once. Returns the
 * page PNGs plus the true total so the caller can tell when the cap truncated.
 */
export async function rasterizePdfPages(
  bytes: Uint8Array,
  dpi = PDF_MODEL_DPI,
  maxPages = MAGIC_MAX_PAGES,
): Promise<{ pages: Uint8Array[]; total: number }> {
  return withPdfDocument(bytes, async (doc) => {
    const total = doc.getPageCount();
    const n = Math.min(total, maxPages);
    const pages: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const raster = await renderPageRgba(doc, i, dpi);
      pages.push(rgbaToPng(raster.data, raster.width, raster.height));
    }
    return { pages, total };
  });
}
