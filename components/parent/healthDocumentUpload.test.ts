import { describe, expect, test } from "vitest";
import { PDFDocument } from "pdf-lib";

import { prepareHealthDocumentUpload } from "./healthDocumentUpload";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=";

function pngFile(name: string): File {
  const bytes = Uint8Array.from(atob(ONE_PIXEL_PNG), (character) =>
    character.charCodeAt(0),
  );
  return new File([bytes], name, { type: "image/png" });
}

describe("health document upload preparation", () => {
  test("does not mutate a selected PDF", async () => {
    const pdf = new File(["%PDF-1.4\nfictional"], "record.pdf", {
      type: "application/pdf",
    });
    await expect(prepareHealthDocumentUpload([pdf])).resolves.toBe(pdf);
  });

  test("combines image pages into one ordered PDF", async () => {
    const prepared = await prepareHealthDocumentUpload([
      pngFile("page-1.png"),
      pngFile("page-2.png"),
    ]);

    expect(prepared.name).toBe("document-pages.pdf");
    expect(prepared.type).toBe("application/pdf");
    const pdf = await PDFDocument.load(await prepared.arrayBuffer());
    expect(pdf.getPageCount()).toBe(2);
  });
});
