// @vitest-environment node
import { describe, expect, test } from "vitest";
import jpeg from "jpeg-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderThumbnailJpeg } from "../thumbnail";

/**
 * A one-page fillable form whose only ink is a single text field, filled with
 * `value` (or left empty). Everything dark in its thumbnail is therefore the
 * field's value.
 */
async function formPdf(value: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const field = doc.getForm().createTextField("name");
  field.addToPage(page, { x: 56, y: 600, width: 500, height: 120, borderWidth: 0 });
  if (value) field.setText(value);
  field.setFontSize(72);
  field.updateAppearances(await doc.embedFont(StandardFonts.HelveticaBold));
  return await doc.save();
}

function darkPixels(jpegBytes: Uint8Array): number {
  const { data } = jpeg.decode(jpegBytes, { useTArray: true });
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] + data[i + 1] + data[i + 2] < 300) dark++;
  }
  return dark;
}

describe("renderThumbnailJpeg on a fillable PDF", () => {
  // TRA-138: PDFium skipped form fields by default, so a filled-in form's
  // thumbnail showed every field empty.
  test("draws the filled-in values", async () => {
    const filled = await renderThumbnailJpeg(await formPdf("WWWWWW"), "application/pdf");
    const empty = await renderThumbnailJpeg(await formPdf(""), "application/pdf");
    expect(filled).not.toBeNull();
    expect(empty).not.toBeNull();
    expect(darkPixels(empty!)).toBeLessThan(50);
    expect(darkPixels(filled!)).toBeGreaterThan(1000);
  });
});
