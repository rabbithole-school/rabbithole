"use node";

/**
 * Rebuild a PDF with some pages REPLACED by a generated image — the in-place
 * substitution behind multi-page Magic Annotations. A scanned student
 * submission is a multi-page PDF; any page carrying a Magic Corners marker gets
 * its page swapped for the AI redraw, while the rest of the pages are copied
 * through untouched. Page count and order are preserved.
 *
 * pdf-lib is CommonJS, so under Convex's esbuild the named exports land on
 * `.default` — loadPdfLib() unwraps that (same pattern as portfolioActions).
 */

async function loadPdfLib(): Promise<typeof import("pdf-lib")> {
  const mod = await import("pdf-lib");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((mod as any).default ?? mod) as typeof import("pdf-lib");
}

export type PageImage = { bytes: Uint8Array; mime: string };

/**
 * Return a new PDF where each page index in `replacements` is replaced by a
 * full-page rendering of that image (sized to the original page, centered),
 * and every other page is copied verbatim. `replacements` keys are 0-based
 * page indices.
 */
export async function substitutePdfPages(
  originalBytes: Uint8Array,
  replacements: Map<number, PageImage>,
): Promise<Uint8Array> {
  const { PDFDocument } = await loadPdfLib();
  const src = await PDFDocument.load(originalBytes);
  const out = await PDFDocument.create();

  const pageCount = src.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    const rep = replacements.get(i);
    if (!rep) {
      // Keep the original page exactly.
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
      continue;
    }
    // Replace: a fresh page the same size as the original, with the redraw
    // drawn "contain"-fit and centered.
    const { width, height } = src.getPage(i).getSize();
    const page = out.addPage([width, height]);
    const img =
      rep.mime === "image/png"
        ? await out.embedPng(rep.bytes)
        : await out.embedJpg(rep.bytes);
    const scale = Math.min(width / img.width, height / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
  }

  return await out.save();
}
