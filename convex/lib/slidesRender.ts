import {
  CANVAS_H,
  CANVAS_W,
  type Deck,
  type Frame,
  type TextAlign,
  type VerticalAlign,
} from "../../shared/slidesScene";
import {
  insetFrameLogical,
  lineStrokeLogical,
  TEXT_PADDING,
} from "../../shared/slidesRenderContract";

export const PPTX_WIDTH_IN = 40 / 3;
export const PPTX_HEIGHT_IN = 7.5;
export const PDF_WIDTH_PT = 960;
export const PDF_HEIGHT_PT = 540;

export type RenderTarget = "pptx" | "pdf";

export type RenderColor = {
  /** Six uppercase hexadecimal digits, without '#'. */
  hex: string;
  /** Normalized channels for renderers such as pdf-lib. */
  rgb: { r: number; g: number; b: number };
};

export type RenderFrame = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise degrees about the frame centre, matching the scene model. */
  rotation: number;
};

type BaseInstruction = {
  id: string;
  frame: RenderFrame;
};

export type TextInstruction = BaseInstruction & {
  kind: "text";
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: RenderColor;
  align: TextAlign;
  verticalAlign: VerticalAlign;
};

export type ImageInstruction = BaseInstruction & {
  kind: "image";
  assetId: string;
  alt: string;
};

export type VideoInstruction = BaseInstruction & {
  kind: "video";
  assetId: string;
  alt: string;
};

export type ShapeInstruction = BaseInstruction & {
  kind: "rect" | "ellipse" | "line";
  fill: RenderColor | null;
  stroke: RenderColor | null;
  /** Points in both export formats. */
  strokeWidth: number;
};

export type DrawInstruction =
  | TextInstruction
  | ImageInstruction
  | VideoInstruction
  | ShapeInstruction;

export type RenderSlide = {
  id: string;
  background: RenderColor;
  /** Back to front, in the scene's authoritative elementIds order. */
  instructions: DrawInstruction[];
  speakerNotes?: string;
};

export type RenderDeck = {
  target: RenderTarget;
  unit: "in" | "pt";
  width: number;
  height: number;
  title: string;
  slides: RenderSlide[];
};

export function convertColor(color: string): RenderColor {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new Error(`Invalid slide color: ${color}`);
  }
  const hex = color.slice(1).toUpperCase();
  return {
    hex,
    rgb: {
      r: Number.parseInt(hex.slice(0, 2), 16) / 255,
      g: Number.parseInt(hex.slice(2, 4), 16) / 255,
      b: Number.parseInt(hex.slice(4, 6), 16) / 255,
    },
  };
}

export function scaleFrame(frame: Frame, target: RenderTarget): RenderFrame {
  const width = target === "pptx" ? PPTX_WIDTH_IN : PDF_WIDTH_PT;
  const height = target === "pptx" ? PPTX_HEIGHT_IN : PDF_HEIGHT_PT;
  return {
    x: (frame.x / CANVAS_W) * width,
    y: (frame.y / CANVAS_H) * height,
    w: (frame.w / CANVAS_W) * width,
    h: (frame.h / CANVAS_H) * height,
    rotation: frame.rotation,
  };
}

/**
 * Convert a top-left frame into pdf-lib's bottom-left placement while keeping
 * rotation around the box centre. pdf-lib rotates around the supplied origin,
 * so a rotated rectangle/image needs an adjusted origin.
 */
export function pdfPlacement(
  frame: RenderFrame,
  pageHeight = PDF_HEIGHT_PT,
): RenderFrame {
  const unrotatedBottom = pageHeight - frame.y - frame.h;
  const centerX = frame.x + frame.w / 2;
  const centerY = unrotatedBottom + frame.h / 2;
  const radians = (-frame.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: centerX - (cos * frame.w) / 2 + (sin * frame.h) / 2,
    y: centerY - (sin * frame.w) / 2 - (cos * frame.h) / 2,
    w: frame.w,
    h: frame.h,
    rotation: frame.rotation === 0 ? 0 : -frame.rotation,
  };
}

export function pdfLinePoints(
  frame: RenderFrame,
  pageHeight = PDF_HEIGHT_PT,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const start = { x: frame.x, y: pageHeight - frame.y };
  const end = {
    x: frame.x + frame.w,
    y: pageHeight - frame.y - frame.h,
  };
  if (frame.rotation === 0) return { start, end };

  const center = {
    x: frame.x + frame.w / 2,
    y: pageHeight - frame.y - frame.h / 2,
  };
  const radians = (-frame.rotation * Math.PI) / 180;
  const rotate = (point: { x: number; y: number }) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
      x: center.x + dx * Math.cos(radians) - dy * Math.sin(radians),
      y: center.y + dx * Math.sin(radians) + dy * Math.cos(radians),
    };
  };
  return { start: rotate(start), end: rotate(end) };
}

export function renderDeckInstructions(
  deck: Deck,
  target: RenderTarget,
): RenderDeck {
  const size =
    target === "pptx"
      ? { unit: "in" as const, width: PPTX_WIDTH_IN, height: PPTX_HEIGHT_IN }
      : { unit: "pt" as const, width: PDF_WIDTH_PT, height: PDF_HEIGHT_PT };

  return {
    target,
    ...size,
    title: deck.title,
    slides: deck.slides.map((slide) => ({
      id: slide.id,
      background: convertColor(slide.background),
      instructions: slide.elementIds.flatMap((elementId): DrawInstruction[] => {
        const element = slide.elements[elementId];
        if (!element) return [];
        if (element.type === "text") {
          // Resolve the text's logical inset from the shared contract BEFORE
          // converting to the target unit, so PPTX/PDF text sits at the same
          // inset from its box as the web/native renderers (which apply
          // TEXT_PADDING as CSS/RN padding).
          const frame = scaleFrame(
            insetFrameLogical(element.frame, TEXT_PADDING),
            target,
          );
          return [{
            id: element.id,
            kind: "text",
            frame,
            text: element.text,
            // Logical font pixels map to points at the scene's 96-units/in scale.
            fontSize: element.style.fontSize * 0.75,
            bold: element.style.bold,
            italic: element.style.italic,
            color: convertColor(element.style.color),
            align: element.style.align,
            verticalAlign: element.style.verticalAlign,
          }];
        }
        const frame = scaleFrame(element.frame, target);
        if (element.type === "image") {
          return [{
            id: element.id,
            kind: "image",
            frame,
            assetId: element.assetId,
            alt: element.alt,
          }];
        }
        if (element.type === "video") {
          return [{
            id: element.id,
            kind: "video",
            frame,
            assetId: element.assetId,
            alt: element.alt,
          }];
        }
        if (element.type === "ellipse") {
          // Non-square geometry: an ellipse's stroke is centred on a path
          // inset by half its stroke width, so the OUTER edge of the stroke
          // lands on the frame box (matching the web border-box div and the
          // native SVG rx/ry) — rather than the PDF/PPTX default of centring
          // the outline on the full frame box, which would let a fat stroke
          // spill unevenly past the box on whichever axis is narrower.
          const ellipseFrame = scaleFrame(
            insetFrameLogical(element.frame, element.style.strokeWidth / 2),
            target,
          );
          return [{
            id: element.id,
            kind: "ellipse",
            frame: ellipseFrame,
            fill: element.style.fill ? convertColor(element.style.fill) : null,
            stroke: element.style.stroke
              ? convertColor(element.style.stroke)
              : null,
            strokeWidth: element.style.strokeWidth * 0.75,
          }];
        }
        if (element.type === "line") {
          // Line-stroke floor: clamp in logical units BEFORE the target-unit
          // conversion, same as the screen renderers, so a hairline that
          // would round away in PPTX points / PDF points instead survives.
          return [{
            id: element.id,
            kind: "line",
            frame,
            fill: element.style.fill ? convertColor(element.style.fill) : null,
            stroke: element.style.stroke
              ? convertColor(element.style.stroke)
              : null,
            strokeWidth: lineStrokeLogical(element.style.strokeWidth) * 0.75,
          }];
        }
        return [{
          id: element.id,
          kind: element.type,
          frame,
          fill: element.style.fill ? convertColor(element.style.fill) : null,
          stroke: element.style.stroke
            ? convertColor(element.style.stroke)
            : null,
          strokeWidth: element.style.strokeWidth * 0.75,
        }];
      }),
      // PDF has no speaker-notes surface. Keep notes for PowerPoint's explicit
      // notes channel, never as a visual draw instruction.
      ...(target === "pptx" && slide.speakerNotes
        ? { speakerNotes: slide.speakerNotes }
        : {}),
    })),
  };
}
