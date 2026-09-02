"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  validateDeck,
  type Deck,
} from "../shared/slidesScene";
import {
  PDF_HEIGHT_PT,
  PDF_WIDTH_PT,
  PPTX_HEIGHT_IN,
  PPTX_WIDTH_IN,
  pdfLinePoints,
  pdfPlacement,
  renderDeckInstructions,
  type DrawInstruction,
  type RenderColor,
  type RenderDeck,
  type TextInstruction,
} from "./lib/slidesRender";
import { detectSlideImageMime, detectSlideVideoMime } from "./lib/slidesMedia";

type PptxConstructor = typeof import("pptxgenjs")["default"];

async function loadPptxGen(): Promise<PptxConstructor> {
  const mod = await import("pptxgenjs");
  const defaultExport = (mod as unknown as { default?: unknown }).default;
  const candidate = defaultExport ?? mod;
  if (typeof candidate !== "function") {
    throw new Error("pptxgenjs did not expose a constructor");
  }
  return candidate as PptxConstructor;
}

async function loadPdfLib(): Promise<typeof import("pdf-lib")> {
  const mod = await import("pdf-lib");
  const defaultExport = (
    mod as unknown as { default?: typeof import("pdf-lib") }
  ).default;
  return defaultExport ?? mod;
}

type StoredAsset = {
  bytes: Uint8Array;
  mime: string;
};

function videoExtension(mime: string): string {
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/x-m4v") return "m4v";
  if (mime === "video/mpeg") return "mpg";
  return "mp4";
}

async function loadDeckAssets(
  ctx: ActionCtx,
  deck: Deck,
): Promise<Map<string, StoredAsset>> {
  const assetTypes = new Map<string, "image" | "video">();
  for (const slide of deck.slides) {
    for (const elementId of slide.elementIds) {
      const element = slide.elements[elementId];
      if (element?.type === "image" || element?.type === "video") {
        assetTypes.set(element.assetId, element.type);
      }
    }
  }

  const assets = new Map<string, StoredAsset>();
  // SEQUENTIAL, with a running byte budget. The concurrent Promise.all
  // materialised every blob AND its base64 copy at once, so a deck of large
  // photos could demand multiple GB before generation began. Keep only raw
  // bytes here; each encoded representation is created only while it is emitted.
  let totalBytes = 0;
  for (const [assetId, assetType] of assetTypes) {
    // validateDeck guarantees a non-empty string; storage is the authority on
    // whether it is a real, readable _storage id.
    const blob = await ctx.storage.get(assetId as Id<"_storage">);
    if (!blob) throw new Error(`Slide media asset not found: ${assetId}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_EXPORT_ASSET_BYTES) {
      throw new Error(
        "This deck has too much media to export. Remove a few photos or videos and try again.",
      );
    }
    const mime =
      assetType === "video"
        ? detectSlideVideoMime(bytes, blob.type)
        : detectSlideImageMime(bytes, blob.type);
    assets.set(assetId, {
      bytes,
      mime,
    });
  }
  return assets;
}

function colorOptions(color: RenderColor | null): { color: string } | undefined {
  return color ? { color: color.hex } : undefined;
}

async function normalizePptxOutput(
  output: string | ArrayBuffer | Blob | Uint8Array,
): Promise<Uint8Array> {
  if (output instanceof Uint8Array) return output;
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
  throw new Error("pptxgenjs returned an unexpected string output");
}

async function renderPptx(
  deck: RenderDeck,
  assets: Map<string, StoredAsset>,
): Promise<Uint8Array> {
  const PptxGenJS = await loadPptxGen();
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: "RABBITHOLE_16_9",
    width: PPTX_WIDTH_IN,
    height: PPTX_HEIGHT_IN,
  });
  pptx.layout = "RABBITHOLE_16_9";
  pptx.author = "Rabbithole";
  pptx.company = "Rabbithole";
  pptx.subject = "Rabbithole slide deck";
  pptx.title = deck.title;

  for (const renderSlide of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: renderSlide.background.hex };
    for (const instruction of renderSlide.instructions) {
      const { x, y, w, h, rotation: rotate } = instruction.frame;
      if (instruction.kind === "text") {
        slide.addText(instruction.text, {
          x,
          y,
          w,
          h,
          rotate,
          fontFace: "Hanken Grotesk",
          fontSize: instruction.fontSize,
          bold: instruction.bold,
          italic: instruction.italic,
          color: instruction.color.hex,
          align: instruction.align,
          valign: instruction.verticalAlign,
          margin: 0,
          breakLine: false,
          fit: "shrink",
        });
      } else if (instruction.kind === "image") {
        const image = assets.get(instruction.assetId);
        if (!image) throw new Error(`Slide image was not loaded: ${instruction.assetId}`);
        slide.addImage({
          data: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`,
          x,
          y,
          w,
          h,
          rotate,
          altText: instruction.alt,
        });
      } else if (instruction.kind === "video") {
        const video = assets.get(instruction.assetId);
        if (!video) throw new Error(`Slide video was not loaded: ${instruction.assetId}`);
        slide.addMedia({
          type: "video",
          data: `${video.mime};base64,${Buffer.from(video.bytes).toString("base64")}`,
          extn: videoExtension(video.mime),
          x,
          y,
          w,
          h,
        });
      } else {
        slide.addShape(pptx.ShapeType[instruction.kind], {
          x,
          y,
          w,
          h,
          rotate,
          ...(instruction.fill ? { fill: colorOptions(instruction.fill) } : {}),
          line: instruction.stroke
            ? {
                color: instruction.stroke.hex,
                width: instruction.strokeWidth,
              }
            : { color: "FFFFFF", transparency: 100, width: 0 },
        });
      }
    }
    if (renderSlide.speakerNotes) slide.addNotes(renderSlide.speakerNotes);
  }

  return await normalizePptxOutput(
    await pptx.write({ outputType: "arraybuffer", compression: true }),
  );
}

type TextMeasurer = {
  widthOfTextAtSize(text: string, size: number): number;
};

function breakLongWord(
  word: string,
  maxWidth: number,
  size: number,
  font: TextMeasurer,
): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of word) {
    const candidate = piece + char;
    if (piece && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      pieces.push(piece);
      piece = char;
    } else {
      piece = candidate;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  font: TextMeasurer,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const rawWord of paragraph.trim().split(/\s+/)) {
      const words =
        font.widthOfTextAtSize(rawWord, size) > maxWidth
          ? breakLongWord(rawWord, maxWidth, size, font)
          : [rawWord];
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

function textBlockBottom(
  instruction: TextInstruction,
  boxBottom: number,
  blockHeight: number,
): number {
  if (instruction.verticalAlign === "top") {
    return boxBottom + instruction.frame.h - blockHeight;
  }
  if (instruction.verticalAlign === "middle") {
    return boxBottom + (instruction.frame.h - blockHeight) / 2;
  }
  return boxBottom;
}

function pdfRgb(
  pdfLib: typeof import("pdf-lib"),
  color: RenderColor,
): ReturnType<typeof pdfLib.rgb> {
  return pdfLib.rgb(color.rgb.r, color.rgb.g, color.rgb.b);
}

async function renderPdf(
  deck: RenderDeck,
  assets: Map<string, StoredAsset>,
): Promise<Uint8Array> {
  const pdfLib = await loadPdfLib();
  const { PDFDocument, StandardFonts, degrees } = pdfLib;
  const pdf = await PDFDocument.create();
  pdf.setTitle(deck.title);
  pdf.setAuthor("Rabbithole");
  pdf.setCreator("Rabbithole");

  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const embeddedImages = new Map<string, Awaited<ReturnType<typeof pdf.embedPng>>>();

  for (const renderSlide of deck.slides) {
    const page = pdf.addPage([PDF_WIDTH_PT, PDF_HEIGHT_PT]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: PDF_WIDTH_PT,
      height: PDF_HEIGHT_PT,
      color: pdfRgb(pdfLib, renderSlide.background),
    });

    for (const instruction of renderSlide.instructions) {
      if (instruction.kind === "text") {
        const font = instruction.bold
          ? instruction.italic
            ? fonts.boldItalic
            : fonts.bold
          : instruction.italic
            ? fonts.italic
            : fonts.regular;
        const lineHeight = instruction.fontSize * 1.2;
        const maxLines = Math.max(1, Math.floor(instruction.frame.h / lineHeight));
        const lines = wrapText(
          instruction.text,
          instruction.frame.w,
          instruction.fontSize,
          font,
        ).slice(0, maxLines);
        const blockHeight = lines.length * lineHeight;
        const boxBottom = PDF_HEIGHT_PT - instruction.frame.y - instruction.frame.h;
        const blockBottom = textBlockBottom(instruction, boxBottom, blockHeight);
        lines.forEach((line, index) => {
          const lineWidth = font.widthOfTextAtSize(line, instruction.fontSize);
          const x =
            instruction.align === "center"
              ? instruction.frame.x + (instruction.frame.w - lineWidth) / 2
              : instruction.align === "right"
                ? instruction.frame.x + instruction.frame.w - lineWidth
                : instruction.frame.x;
          page.drawText(line, {
            x,
            y:
              blockBottom +
              blockHeight -
              instruction.fontSize -
              index * lineHeight,
            size: instruction.fontSize,
            font,
            color: pdfRgb(pdfLib, instruction.color),
          });
        });
        continue;
      }

      if (instruction.kind === "image") {
        const source = assets.get(instruction.assetId);
        if (!source) throw new Error(`Slide image was not loaded: ${instruction.assetId}`);
        let image = embeddedImages.get(instruction.assetId);
        if (!image) {
          if (source.mime === "image/png") image = await pdf.embedPng(source.bytes);
          else if (source.mime === "image/jpeg") image = await pdf.embedJpg(source.bytes);
          else {
            throw new Error(
              `PDF export supports PNG and JPEG slide images; received ${source.mime}`,
            );
          }
          embeddedImages.set(instruction.assetId, image);
        }
        const placement = pdfPlacement(instruction.frame);
        page.drawImage(image, {
          x: placement.x,
          y: placement.y,
          width: placement.w,
          height: placement.h,
          rotate: degrees(placement.rotation),
        });
        continue;
      }

      if (instruction.kind === "video") {
        const placement = pdfPlacement(instruction.frame);
        page.drawRectangle({
          x: placement.x,
          y: placement.y,
          width: placement.w,
          height: placement.h,
          rotate: degrees(placement.rotation),
          color: pdfLib.rgb(0.93, 0.93, 0.95),
          borderColor: pdfLib.rgb(0.45, 0.45, 0.5),
          borderWidth: 1,
        });
        page.drawText(instruction.alt || "Video", {
          x: instruction.frame.x + 12,
          y: PDF_HEIGHT_PT - instruction.frame.y - instruction.frame.h / 2,
          size: 16,
          font: fonts.bold,
          color: pdfLib.rgb(0.2, 0.2, 0.24),
        });
        continue;
      }

      drawPdfShape(page, instruction, pdfLib);
    }
  }

  return await pdf.save();
}

function drawPdfShape(
  page: import("pdf-lib").PDFPage,
  instruction: Extract<DrawInstruction, { kind: "rect" | "ellipse" | "line" }>,
  pdfLib: typeof import("pdf-lib"),
): void {
  const { degrees } = pdfLib;
  const fill = instruction.fill
    ? { color: pdfRgb(pdfLib, instruction.fill) }
    : {};
  const border = instruction.stroke
    ? {
        borderColor: pdfRgb(pdfLib, instruction.stroke),
        borderWidth: instruction.strokeWidth,
      }
    : { borderWidth: 0 };

  if (instruction.kind === "line") {
    if (!instruction.stroke) throw new Error(`Line ${instruction.id} has no stroke`);
    const points = pdfLinePoints(instruction.frame);
    page.drawLine({
      start: points.start,
      end: points.end,
      color: pdfRgb(pdfLib, instruction.stroke),
      thickness: instruction.strokeWidth,
    });
  } else if (instruction.kind === "ellipse") {
    page.drawEllipse({
      x: instruction.frame.x + instruction.frame.w / 2,
      y: PDF_HEIGHT_PT - instruction.frame.y - instruction.frame.h / 2,
      xScale: instruction.frame.w / 2,
      yScale: instruction.frame.h / 2,
      rotate: degrees(-instruction.frame.rotation),
      ...fill,
      ...border,
    });
  } else {
    const placement = pdfPlacement(instruction.frame);
    page.drawRectangle({
      x: placement.x,
      y: placement.y,
      width: placement.w,
      height: placement.h,
      rotate: degrees(placement.rotation),
      ...fill,
      ...border,
    });
  }
}

function parseDeckContent(content: string): Deck {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Slides artifact content is not valid JSON");
  }
  const result = validateDeck(raw);
  if (!result.ok) {
    throw new Error(`Slides artifact is invalid: ${result.errors.join("; ")}`);
  }
  return result.deck;
}

function toStorageBlob(bytes: Uint8Array, mime: string): Blob {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type: mime });
}

/**
 * Aggregate ceiling on embedded media bytes. Validation allows 100 slides x 60
 * elements. Raw media stays resident while exporting, and an individual
 * element's base64 payload is created only while that element is emitted.
 */
const MAX_EXPORT_ASSET_BYTES = 64 * 1024 * 1024;

export const exportDeck = action({
  args: {
    artifactId: v.id("artifacts"),
    format: v.union(v.literal("pptx"), v.literal("pdf")),
  },
  handler: async (ctx, args): Promise<Id<"_storage">> => {
    // getById is the canonical owner/staff access gate and runs with this
    // action's auth identity. Null intentionally does not reveal existence.
    const artifact = await ctx.runQuery(api.artifacts.getById, {
      artifactId: args.artifactId,
    });
    if (!artifact) throw new Error("Slides artifact not found or not accessible");
    const artifactType: string | undefined = artifact.type;
    if (artifactType !== "slides") {
      throw new Error("Artifact is not a slides deck");
    }

    const deck = parseDeckContent(artifact.content);
    const assets = await loadDeckAssets(ctx, deck);
    const instructions = renderDeckInstructions(deck, args.format);
    const bytes =
      args.format === "pptx"
        ? await renderPptx(instructions, assets)
        : await renderPdf(instructions, assets);
    const mime =
      args.format === "pptx"
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : "application/pdf";
    return await ctx.storage.store(toStorageBlob(bytes, mime));
  },
});
