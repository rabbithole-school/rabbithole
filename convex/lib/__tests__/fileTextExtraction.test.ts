import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  extractDirectText,
  extractDocxText,
  stripRtfToText,
} from "../fileTextExtraction";

function makeDocx(documentXml: string): Uint8Array {
  const name = Buffer.from("word/document.xml", "ascii");
  const uncompressed = Buffer.from(documentXml, "utf-8");
  const compressed = deflateRawSync(uncompressed);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(uncompressed.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([localHeader, name, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(uncompressed.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  const central = Buffer.concat([centralHeader, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, central, end]));
}

describe("fileTextExtraction", () => {
  test("extracts DOCX XML through the shared parser", () => {
    const bytes = makeDocx(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
        `<w:p><w:r><w:t>Resource text &amp; evidence</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    );
    expect(extractDocxText(bytes)).toBe("Resource text & evidence");
    expect(extractDirectText(bytes, "docx")).toBe(
      "Resource text & evidence",
    );
  });

  test("strips RTF controls and decodes plain text", () => {
    expect(
      stripRtfToText(String.raw`{\rtf1\ansi Lesson \b evidence\b0\par Next}`),
    ).toContain("Lesson evidence\nNext");
    expect(
      extractDirectText(new TextEncoder().encode("plain notes"), "text"),
    ).toBe("plain notes");
  });

  test("fails loudly for malformed DOCX", () => {
    expect(() => extractDocxText(new Uint8Array([1, 2, 3]))).toThrow(
      /end-of-central-directory/i,
    );
  });
});
