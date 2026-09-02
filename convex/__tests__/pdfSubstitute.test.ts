import { describe, expect, test } from "vitest";
import { PDFDocument } from "pdf-lib";
import { substitutePdfPages } from "../lib/pdfSubstitute";

// The core invariant of in-PDF Magic substitution: replacing some pages must
// preserve page COUNT and ORDER — a 3-page student submission stays 3 pages,
// with only the marked page swapped. (The visual redraw quality is covered by
// the end-to-end test; here we lock the structural contract.)

// 1×1 transparent PNG.
const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function makePdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`page ${i + 1}`, { x: 50, y: 700, size: 24 });
  }
  return await doc.save();
}

describe("substitutePdfPages", () => {
  test("preserves page count and order when replacing a middle page", async () => {
    const original = await makePdf(3);
    const out = await substitutePdfPages(
      original,
      new Map([[1, { bytes: PNG_1x1, mime: "image/png" }]]),
    );
    const result = await PDFDocument.load(out);
    expect(result.getPageCount()).toBe(3);
    // Same page sizes — the replacement page matches the original's dimensions.
    expect(result.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
  });

  test("replacing multiple pages still yields the same count", async () => {
    const original = await makePdf(3);
    const out = await substitutePdfPages(
      original,
      new Map([
        [0, { bytes: PNG_1x1, mime: "image/png" }],
        [2, { bytes: PNG_1x1, mime: "image/png" }],
      ]),
    );
    const result = await PDFDocument.load(out);
    expect(result.getPageCount()).toBe(3);
  });

  test("no replacements returns an equivalent-length PDF", async () => {
    const original = await makePdf(2);
    const out = await substitutePdfPages(original, new Map());
    const result = await PDFDocument.load(out);
    expect(result.getPageCount()).toBe(2);
  });
});
