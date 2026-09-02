export type AideUploadKind =
  | "image"
  | "pdf"
  | "docx"
  | "rtf"
  | "text"
  | "other";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
]);

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv"]);
const DOCX_EXTENSIONS = new Set(["docx", "doc"]);

const PDF_MIMES = new Set(["application/pdf"]);
const DOCX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);
const RTF_MIMES = new Set([
  "application/rtf",
  "application/x-rtf",
  "text/rtf",
  "text/richtext",
]);
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
  "application/x-markdown",
  // CSV is just delimited text — decoding it directly is both cheaper and more
  // faithful than routing it through the Claude-vision extraction fallback.
  // (True spreadsheets — .xlsx/.ods — are NOT text and stay unsupported.)
  "text/csv",
  "application/csv",
]);

function normalizeMime(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";")[0].trim().toLowerCase();
}

function extensionFromFileName(fileName: string): string {
  const cleanName = fileName.split(/[?#]/)[0]?.trim().toLowerCase() ?? "";
  const lastDot = cleanName.lastIndexOf(".");
  if (lastDot < 0 || lastDot === cleanName.length - 1) return "";
  return cleanName.slice(lastDot + 1);
}

export function classifyAideUpload(
  mimeType: string | null | undefined,
  fileName: string,
): AideUploadKind {
  const mime = normalizeMime(mimeType);
  const ext = extensionFromFileName(fileName);

  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (PDF_MIMES.has(mime) || ext === "pdf") return "pdf";
  if (DOCX_MIMES.has(mime) || DOCX_EXTENSIONS.has(ext)) return "docx";
  if (RTF_MIMES.has(mime) || ext === "rtf") return "rtf";
  if (TEXT_MIMES.has(mime) || TEXT_EXTENSIONS.has(ext)) return "text";
  return "other";
}
