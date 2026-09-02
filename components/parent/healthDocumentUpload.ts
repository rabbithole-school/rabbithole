import {
  selectHealthDocumentFiles,
  validateHealthDocumentFile,
} from "@/shared/healthDocuments";

export async function prepareHealthDocumentUpload(
  files: readonly File[],
): Promise<File> {
  const selection = selectHealthDocumentFiles([], files, "file");
  if (selection.error) throw new Error(selection.error);
  if (selection.files.length === 0) {
    throw new Error("Choose a document to upload.");
  }
  if (selection.files.length === 1) return selection.files[0];

  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  for (const file of selection.files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image =
      file.type === "image/jpeg"
        ? await pdf.embedJpg(bytes)
        : await pdf.embedPng(bytes);
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
  }

  const bytes = await pdf.save();
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const document = new File([buffer], "document-pages.pdf", {
    type: "application/pdf",
  });
  const validationError = validateHealthDocumentFile(document);
  if (validationError) throw new Error(validationError);
  return document;
}
