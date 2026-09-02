import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GenericActionCtx } from "convex/server";
import type { DataModel, Id } from "../../_generated/dataModel";
import {
  buildAideUserContent,
  type AideContextMessage,
} from "../aideAttachments";

vi.mock("../googleTokens", () => ({
  getValidAccessToken: vi.fn(async () => "fake-token"),
}));

const ctx = {} as GenericActionCtx<DataModel>;
const userId = "user1" as Id<"users">;

// Build a valid .docx (a ZIP with a central directory + EOCD, deflate-
// compressed) so the test exercises the real central-directory reader and the
// pure-JS inflate — the same paths production uses in the Convex isolate
// (which has no DecompressionStream/zlib). CRC fields are left 0 (the reader
// doesn't verify them).
function makeDocx(documentXml: string): Uint8Array {
  const name = Buffer.from("word/document.xml", "ascii");
  const uncompressed = Buffer.from(documentXml, "utf-8");
  const compressed = deflateRawSync(uncompressed);
  const method = 8;

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt32LE(compressed.length, 18);
  lfh.writeUInt32LE(uncompressed.length, 22);
  lfh.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([lfh, name, compressed]);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(method, 10);
  cdh.writeUInt32LE(compressed.length, 20);
  cdh.writeUInt32LE(uncompressed.length, 24);
  cdh.writeUInt16LE(name.length, 28);
  cdh.writeUInt32LE(0, 42); // local header offset
  const central = Buffer.concat([cdh, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length, 12); // central directory size
  eocd.writeUInt32LE(local.length, 16); // central directory offset

  return new Uint8Array(Buffer.concat([local, central, eocd]));
}

const DOCX = makeDocx(
  `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
    `<w:p><w:r><w:t>Hello, </w:t></w:r><w:r><w:t>curriculum bot!</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Second &amp; line</w:t></w:r></w:p>` +
    `</w:body></w:document>`,
);
const RTF = new TextEncoder().encode(
  String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}\f0 Hello \b bold\b0  world\par Line two\par}`,
);

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function stubFetch(map: Record<string, Uint8Array | string>) {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = map[url];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(body as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
}

function att(fileName: string, mimeType: string, url: string) {
  return {
    storageId: "s1" as Id<"_storage">,
    fileName,
    mimeType,
    sizeBytes: null,
    url,
  };
}

function drive(driveFileId: string, name: string, mimeType: string) {
  return {
    driveFileId,
    url: `https://drive/${driveFileId}`,
    name,
    mimeType,
  };
}

/** The ?alt=media download URL the Drive attachment path fetches for binaries. */
function driveMediaUrl(driveFileId: string) {
  return `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`;
}

describe("buildAideUserContent (real extraction)", () => {
  test("docx → text document block with real content", async () => {
    stubFetch({ "https://x/doc": new Uint8Array(DOCX) });
    const m: AideContextMessage = {
      role: "user",
      content: "please read this",
      attachments: [
        att(
          "plan.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "https://x/doc",
        ),
      ],
    };
    const out = await buildAideUserContent(ctx, userId, m);
    expect(Array.isArray(out)).toBe(true);
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { type: string; media_type: string; data: string };
      title: string;
    };
    expect(docBlock).toBeTruthy();
    expect(docBlock.source.type).toBe("text");
    expect(docBlock.title).toBe("plan.docx");
    expect(docBlock.source.data).toContain("Hello, curriculum bot!");
    expect(docBlock.source.data).toContain("Second & line");
  });

  test("large docx → inflate handles back-references + dynamic Huffman", async () => {
    // ~1500 paragraphs of varied text force real LZ77 matches and a dynamic
    // Huffman block, exercising the meaty parts of the pure-JS inflate. Kept
    // under the 100k extracted-text cap so the tail sentinel isn't truncated.
    const paras = Array.from(
      { length: 1500 },
      (_, i) =>
        `<w:p><w:r><w:t>Paragraph ${i}: mangroves, tide pools, and photosynthesis.</w:t></w:r></w:p>`,
    ).join("");
    const bigDocx = makeDocx(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
        `<w:p><w:r><w:t>START-SENTINEL-7</w:t></w:r></w:p>` +
        paras +
        `<w:p><w:r><w:t>END-SENTINEL-42</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    );
    stubFetch({ "https://x/big": new Uint8Array(bigDocx) });
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      attachments: [
        att(
          "big.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "https://x/big",
        ),
      ],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { data: string };
    };
    // Sentinels at both ends prove the full stream inflated, not just the head.
    expect(docBlock.source.data).toContain("START-SENTINEL-7");
    expect(docBlock.source.data).toContain("Paragraph 1400:");
    expect(docBlock.source.data).toContain("END-SENTINEL-42");
  });

  test("rtf → text document block, control words stripped", async () => {
    stubFetch({ "https://x/rtf": new Uint8Array(RTF) });
    const m: AideContextMessage = {
      role: "user",
      content: "",
      attachments: [att("notes.rtf", "application/rtf", "https://x/rtf")],
    };
    const out = await buildAideUserContent(ctx, userId, m);
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { data: string };
    };
    expect(docBlock.source.data).toContain("Hello");
    expect(docBlock.source.data).toContain("bold");
    expect(docBlock.source.data).toContain("world");
    expect(docBlock.source.data).toContain("Line two");
    expect(docBlock.source.data).not.toContain("fonttbl");
    expect(docBlock.source.data).not.toContain("\\rtf1");
  });

  test("txt → text document block verbatim", async () => {
    stubFetch({ "https://x/txt": "raw notes here" });
    const m: AideContextMessage = {
      role: "user",
      content: "",
      attachments: [att("n.txt", "text/plain", "https://x/txt")],
    };
    const out = await buildAideUserContent(ctx, userId, m);
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { data: string };
    };
    expect(docBlock.source.data).toContain("raw notes here");
  });

  test("image → url image block", async () => {
    const m: AideContextMessage = {
      role: "user",
      content: "look",
      attachments: [att("p.png", "image/png", "https://x/img.png")],
    };
    const out = await buildAideUserContent(ctx, userId, m);
    const blocks = out as unknown as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === "image")).toBe(true);
  });

  test("linked Drive doc → exported text block", async () => {
    stubFetch({
      "https://www.googleapis.com/drive/v3/files/abc123/export?mimeType=text%2Fplain":
        "drive doc body",
    });
    const m: AideContextMessage = {
      role: "user",
      content: "",
      driveAttachments: [
        {
          driveFileId: "abc123",
          url: "https://drive/abc123",
          name: "My Doc",
          mimeType: "application/vnd.google-apps.document",
        },
      ],
    };
    const out = await buildAideUserContent(ctx, userId, m);
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { data: string };
      title: string;
    };
    expect(docBlock.title).toBe("My Doc");
    expect(docBlock.source.data).toContain("drive doc body");
  });

  test("linked Drive Sheet → exported as CSV", async () => {
    stubFetch({
      "https://www.googleapis.com/drive/v3/files/sheet1/export?mimeType=text%2Fcsv":
        "name,score\nkai,7",
    });
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [
        drive("sheet1", "Scores", "application/vnd.google-apps.spreadsheet"),
      ],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { data: string };
      title: string;
    };
    expect(docBlock.title).toBe("Scores");
    expect(docBlock.source.data).toContain("name,score");
  });

  test("linked Drive PDF → base64 document block", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake pdf body");
    stubFetch({ [driveMediaUrl("pdf1")]: pdfBytes });
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("pdf1", "syllabus.pdf", "application/pdf")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { type: string; media_type: string; data: string };
      title: string;
    };
    expect(docBlock.source.type).toBe("base64");
    expect(docBlock.source.media_type).toBe("application/pdf");
    expect(docBlock.title).toBe("syllabus.pdf");
    expect(atob(docBlock.source.data)).toContain("fake pdf body");
  });

  test("linked Drive image → base64 image block with sniffed mime", async () => {
    // Minimal PNG signature so detectImageMime resolves image/png.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    stubFetch({ [driveMediaUrl("img1")]: png });
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("img1", "whiteboard.png", "image/png")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const imgBlock = blocks.find((b) => b.type === "image") as {
      source: { type: string; media_type: string; data: string };
    };
    expect(imgBlock.source.type).toBe("base64");
    expect(imgBlock.source.media_type).toBe("image/png");
    expect(imgBlock.source.data.length).toBeGreaterThan(0);
  });

  test("linked Drive .docx → extracted text block (same path as uploads)", async () => {
    stubFetch({ [driveMediaUrl("docx1")]: new Uint8Array(DOCX) });
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [
        drive(
          "docx1",
          "plan.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { type: string; data: string };
      title: string;
    };
    expect(docBlock.source.type).toBe("text");
    expect(docBlock.title).toBe("plan.docx");
    expect(docBlock.source.data).toContain("Hello, curriculum bot!");
  });

  test("linked Drive .txt → extracted text block", async () => {
    stubFetch({ [driveMediaUrl("txt1")]: "drive plain text" });
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("txt1", "notes.txt", "text/plain")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { type: string; data: string };
    };
    expect(docBlock.source.type).toBe("text");
    expect(docBlock.source.data).toContain("drive plain text");
  });

  test("linked Google Drawing → note, not a hard failure", async () => {
    stubFetch({});
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "what do you think?",
      driveAttachments: [
        drive("draw1", "Sketch", "application/vnd.google-apps.drawing"),
      ],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const text = blocks.find((b) => b.type === "text") as { text: string };
    expect(text.text).toContain("what do you think?");
    expect(text.text).toContain("Sketch");
    expect(text.text).toContain("can't be shown inline");
  });

  test("unreadable Drive file → generic 'Google Drive file' note", async () => {
    stubFetch({}); // every fetch 404s
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("gone", "Ghost.pdf", "application/pdf")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const text = blocks.find((b) => b.type === "text") as { text: string };
    expect(text.text).toContain('Could not read linked Google Drive file "Ghost.pdf"');
  });

  test("oversized Drive file → note, not a giant base64 blob", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": String(50 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch;
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("big", "huge.pdf", "application/pdf")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const text = blocks.find((b) => b.type === "text") as { text: string };
    expect(text.text).toContain("too large to read inline");
    expect(blocks.some((b) => b.type === "document")).toBe(false);
  });

  test("linked HEIC image → note, never a mislabeled jpeg block", async () => {
    // classifyAideUpload calls any image/* an "image", but the model only takes
    // jpeg/png/gif/webp — a HEIC must degrade to a note, not a 400'd turn.
    const heic = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    stubFetch({ [driveMediaUrl("heic1")]: heic });
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("heic1", "photo.heic", "image/heic")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    const text = blocks.find((b) => b.type === "text") as { text: string };
    expect(text.text).toContain("photo.heic");
    expect(text.text).toContain("can't be shown inline");
  });

  test("oversized Drive image → note (5 MB image cap, not the 20 MB one)", async () => {
    // 8 MB is under the generic 20 MB download cap but over Anthropic's 5 MB
    // base64-image limit, so it must be noted rather than sent and rejected.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": String(8 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch;
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("bigimg", "poster.png", "image/png")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    const text = blocks.find((b) => b.type === "text") as { text: string };
    expect(text.text).toContain("too large to read inline");
  });

  test("8 MB PDF still goes through — the image cap is image-only", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 body");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(pdf as unknown as BodyInit, {
          status: 200,
          headers: { "content-length": String(8 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch;
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("bigpdf", "big.pdf", "application/pdf")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const docBlock = blocks.find((b) => b.type === "document") as {
      source: { media_type: string };
    };
    expect(docBlock.source.media_type).toBe("application/pdf");
  });

  test("unsupported Drive binary → note without downloading it", async () => {
    const fetchSpy = vi.fn(async () => new Response("x", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "",
      driveAttachments: [drive("zip1", "bundle.zip", "application/zip")],
    });
    const blocks = out as unknown as Array<Record<string, unknown>>;
    const text = blocks.find((b) => b.type === "text") as { text: string };
    expect(text.text).toContain("bundle.zip");
    expect(text.text).toContain("can't be shown inline");
    // Classified as unreadable up front — no pointless megabyte download.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no files → returns plain string", async () => {
    const out = await buildAideUserContent(ctx, userId, {
      role: "user",
      content: "just text",
    });
    expect(out).toBe("just text");
  });
});
