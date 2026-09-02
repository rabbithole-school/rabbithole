// Shared file-text extraction for DOCX / RTF / plain-text uploads.
//
// This is the single home for the format parsers that were previously inlined
// in lib/aideAttachments.ts. Callers that need the plain text of a
// non-image / non-PDF upload go through extractDirectText; the aide
// attachment builder is the first consumer. PDFs and images are handled by
// Claude (lib/claudeFileExtraction.ts), not here.

import type { AideUploadKind } from "./aideUploadMimes";
import { inflateRaw } from "./inflateRaw";

const DOCX_DOCUMENT_XML = "word/document.xml";
const RTF_DESTINATIONS_TO_SKIP = new Set([
  "colortbl",
  "colorschememapping",
  "datastore",
  "filetbl",
  "fonttbl",
  "footer",
  "footerf",
  "footerl",
  "footerr",
  "generator",
  "header",
  "headerf",
  "headerl",
  "headerr",
  "info",
  "listoverridetable",
  "listtable",
  "object",
  "pict",
  "revtbl",
  "stylesheet",
  "themedata",
  "xmlnstbl",
]);

// The upload kinds whose text we can read directly (no LLM): DOCX (a ZIP of
// XML), RTF (control-word markup), and plain text.
export type DirectTextFileKind = Extract<
  AideUploadKind,
  "docx" | "rtf" | "text"
>;

export function extractDirectText(
  bytes: Uint8Array,
  kind: DirectTextFileKind,
): string {
  if (kind === "docx") return extractDocxText(bytes);
  const decoded = new TextDecoder().decode(bytes);
  return kind === "rtf" ? stripRtfToText(decoded) : decoded;
}

export function extractDocxText(bytes: Uint8Array): string {
  const entry = readZipEntry(bytes, DOCX_DOCUMENT_XML);
  const xmlBytes =
    entry.method === 0
      ? entry.compressedData
      : inflateRaw(entry.compressedData, entry.uncompressedSize);
  return stripDocxXml(new TextDecoder().decode(xmlBytes));
}

// Read a single entry out of a ZIP (a .docx is a ZIP) via the central
// directory — the authoritative source of each entry's sizes and location,
// correct even when local headers use streaming data descriptors (size = 0).
function readZipEntry(
  bytes: Uint8Array,
  targetName: string,
): { method: number; compressedData: Uint8Array; uncompressedSize: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // Locate the End Of Central Directory record (scan backwards — it may be
  // trailed by a variable-length comment).
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  const scanFrom = Math.max(0, bytes.length - (0xffff + 22));
  for (let position = bytes.length - 22; position >= scanFrom; position -= 1) {
    if (view.getUint32(position, true) === eocdSignature) {
      eocd = position;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP: end-of-central-directory not found");

  let centralDirectoryOffset = view.getUint32(eocd + 16, true);
  const centralDirectoryCount = view.getUint16(eocd + 10, true);
  const centralDirectorySignature = 0x02014b50;

  for (let index = 0; index < centralDirectoryCount; index += 1) {
    if (
      centralDirectoryOffset + 46 > bytes.length ||
      view.getUint32(centralDirectoryOffset, true) !==
        centralDirectorySignature
    ) {
      break;
    }
    const method = view.getUint16(centralDirectoryOffset + 10, true);
    const compressedSize = view.getUint32(centralDirectoryOffset + 20, true);
    const uncompressedSize = view.getUint32(
      centralDirectoryOffset + 24,
      true,
    );
    const nameLength = view.getUint16(centralDirectoryOffset + 28, true);
    const extraLength = view.getUint16(centralDirectoryOffset + 30, true);
    const commentLength = view.getUint16(centralDirectoryOffset + 32, true);
    const localOffset = view.getUint32(centralDirectoryOffset + 42, true);
    const nameStart = centralDirectoryOffset + 46;
    const name = decoder.decode(
      bytes.subarray(nameStart, nameStart + nameLength),
    );

    if (name === targetName) {
      if (method !== 0 && method !== 8) {
        throw new Error(`ZIP: unsupported compression method ${method}`);
      }
      // The local header repeats name/extra lengths (which can differ from the
      // central record's), so read them to find where the data actually starts.
      if (view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error("ZIP: bad local file header");
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart =
        localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > bytes.length) {
        throw new Error("ZIP: entry extends past end of file");
      }
      return {
        method,
        compressedData: bytes.subarray(dataStart, dataStart + compressedSize),
        uncompressedSize,
      };
    }

    centralDirectoryOffset =
      nameStart + nameLength + extraLength + commentLength;
  }

  throw new Error(`${targetName} not found in DOCX`);
}

function stripDocxXml(xml: string): string {
  const text = xml
    .replace(/<w:br\b[^>]*\/?>/gi, "\n")
    .replace(/<w:tab\b[^>]*\/?>/gi, "\t")
    .replace(/<\/w:p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return normalizeExtractedText(decodeXmlEntities(text));
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(parseInt(decimal, 10)),
    )
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return _;
      }
    });
}

export function stripRtfToText(rtf: string): string {
  const out: string[] = [];
  const skipStack: boolean[] = [];
  let skipping = false;
  let unicodeFallbackChars = 1;
  let pendingUnicodeFallback = 0;

  for (let index = 0; index < rtf.length; index += 1) {
    if (pendingUnicodeFallback > 0) {
      if (rtf[index] === "\\" && rtf[index + 1] === "'") index += 3;
      pendingUnicodeFallback -= 1;
      continue;
    }

    const character = rtf[index];
    if (character === "{") {
      skipStack.push(skipping);
      skipping = skipping || isIgnorableRtfGroupStart(rtf, index);
      continue;
    }
    if (character === "}") {
      skipping = skipStack.pop() ?? false;
      continue;
    }
    if (character === "\\") {
      const next = rtf[index + 1];
      if (next === "'" && /^[0-9a-f]{2}$/i.test(rtf.slice(index + 2, index + 4))) {
        if (!skipping) {
          out.push(
            String.fromCharCode(parseInt(rtf.slice(index + 2, index + 4), 16)),
          );
        }
        index += 3;
        continue;
      }
      if (next === "\\" || next === "{" || next === "}") {
        if (!skipping) out.push(next);
        index += 1;
        continue;
      }
      if (/[a-zA-Z]/.test(next ?? "")) {
        let cursor = index + 1;
        while (/[a-zA-Z]/.test(rtf[cursor] ?? "")) cursor += 1;
        const word = rtf.slice(index + 1, cursor).toLowerCase();
        let sign = 1;
        if (rtf[cursor] === "-") {
          sign = -1;
          cursor += 1;
        }
        const numberStart = cursor;
        while (/\d/.test(rtf[cursor] ?? "")) cursor += 1;
        const number =
          cursor > numberStart
            ? sign * parseInt(rtf.slice(numberStart, cursor), 10)
            : undefined;
        if (rtf[cursor] === " ") cursor += 1;

        if (!skipping) {
          if (word === "par" || word === "line") out.push("\n");
          else if (word === "tab") out.push("\t");
          else if (word === "emdash") out.push("—");
          else if (word === "endash") out.push("–");
          else if (word === "bullet") out.push("•");
          else if (word === "uc" && number !== undefined) {
            unicodeFallbackChars = Math.max(0, number);
          } else if (word === "u" && number !== undefined) {
            const codePoint = number < 0 ? number + 65536 : number;
            if (codePoint >= 0 && codePoint <= 0x10ffff) {
              out.push(String.fromCodePoint(codePoint));
            }
            pendingUnicodeFallback = unicodeFallbackChars;
          }
        }
        index = cursor - 1;
        continue;
      }
      if (!skipping) {
        if (next === "~") out.push(" ");
        else if (next === "_") out.push("-");
      }
      index += 1;
      continue;
    }
    if (!skipping && character !== "\r" && character !== "\n") {
      out.push(character);
    }
  }

  return normalizeExtractedText(out.join(""));
}

function isIgnorableRtfGroupStart(
  rtf: string,
  openBraceIndex: number,
): boolean {
  const groupStart = rtf.slice(openBraceIndex + 1);
  if (groupStart.startsWith("\\*")) return true;
  const destination = /^\\([a-zA-Z]+)/.exec(groupStart)?.[1]?.toLowerCase();
  return destination ? RTF_DESTINATIONS_TO_SKIP.has(destination) : false;
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
