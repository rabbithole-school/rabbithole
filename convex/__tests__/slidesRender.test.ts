import { describe, expect, test } from "vitest";
import type { Deck } from "../../shared/slidesScene";
import { TEXT_PADDING } from "../../shared/slidesRenderContract";
import {
  PDF_HEIGHT_PT,
  PDF_WIDTH_PT,
  PPTX_HEIGHT_IN,
  PPTX_WIDTH_IN,
  convertColor,
  pdfLinePoints,
  pdfPlacement,
  renderDeckInstructions,
  scaleFrame,
} from "../lib/slidesRender";

const deck: Deck = {
  schemaVersion: 1,
  title: "Export fixture",
  width: 1280,
  height: 720,
  revision: 3,
  slides: [{
    id: "slide-1",
    background: "#102030",
    elementIds: ["shape", "missing", "copy", "clip"],
    elements: {
      copy: {
        id: "copy",
        type: "text",
        frame: { x: 128, y: 72, w: 640, h: 144, rotation: 0 },
        text: "Centered",
        style: {
          fontSize: 32,
          bold: true,
          italic: false,
          color: "#abcdef",
          align: "center",
          verticalAlign: "middle",
        },
      },
      shape: {
        id: "shape",
        type: "rect",
        frame: { x: 0, y: 0, w: 320, h: 180, rotation: 45 },
        style: {
          fill: "#ff0000",
          stroke: "#00ff00",
          strokeWidth: 4,
        },
      },
      clip: {
        id: "clip",
        type: "video",
        frame: { x: 320, y: 180, w: 640, h: 360, rotation: 0 },
        assetId: "video-asset",
        alt: "Experiment clip",
      },
    },
    speakerNotes: "Present this first.",
  }],
};

describe("slide export unit conversion", () => {
  test("maps the logical canvas to PowerPoint inches", () => {
    expect(PPTX_WIDTH_IN).toBeCloseTo(13.333333, 5);
    expect(PPTX_HEIGHT_IN).toBe(7.5);
    expect(scaleFrame(
      { x: 128, y: 72, w: 640, h: 360, rotation: 30 },
      "pptx",
    )).toEqual({
      x: PPTX_WIDTH_IN / 10,
      y: 0.75,
      w: PPTX_WIDTH_IN / 2,
      h: 3.75,
      rotation: 30,
    });
  });

  test("maps the logical canvas to PDF points", () => {
    expect(PDF_WIDTH_PT).toBe(960);
    expect(PDF_HEIGHT_PT).toBe(540);
    expect(scaleFrame(
      { x: 128, y: 72, w: 640, h: 360, rotation: 30 },
      "pdf",
    )).toEqual({
      x: 96,
      y: 54,
      w: 480,
      h: 270,
      rotation: 30,
    });
  });
});

describe("slide export colors and instructions", () => {
  test("converts scene hex colors for both renderers", () => {
    expect(convertColor("#80ff00")).toEqual({
      hex: "80FF00",
      rgb: { r: 128 / 255, g: 1, b: 0 },
    });
    expect(() => convertColor("red")).toThrow("Invalid slide color");
  });

  test("preserves z-order, rotation, and alignments without drawing notes", () => {
    const rendered = renderDeckInstructions(deck, "pdf");
    expect(rendered.slides[0].instructions.map((item) => item.id)).toEqual([
      "shape",
      "copy",
      "clip",
    ]);
    expect(rendered.slides[0]).toMatchObject({
      background: { hex: "102030" },
    });
    // Notes are not visual scene elements and PDFs have no notes channel.
    expect(rendered.slides[0].speakerNotes).toBeUndefined();
    expect(JSON.stringify(rendered.slides[0].instructions)).not.toContain(
      "Present this first.",
    );
    expect(rendered.slides[0].instructions[0]).toMatchObject({
      kind: "rect",
      frame: { rotation: 45 },
      fill: { hex: "FF0000" },
      stroke: { hex: "00FF00" },
      strokeWidth: 3,
    });
    expect(rendered.slides[0].instructions[1]).toMatchObject({
      kind: "text",
      fontSize: 24,
      align: "center",
      verticalAlign: "middle",
      bold: true,
    });
    expect(rendered.slides[0].instructions[2]).toMatchObject({
      kind: "video",
      assetId: "video-asset",
      alt: "Experiment clip",
    });
  });

  test("keeps notes in PowerPoint's notes channel, not its visual instructions", () => {
    const rendered = renderDeckInstructions(deck, "pptx");
    expect(rendered.slides[0].speakerNotes).toBe("Present this first.");
    expect(JSON.stringify(rendered.slides[0].instructions)).not.toContain(
      "Present this first.",
    );
  });
});

describe("shared render contract resolved before unit conversion (#slides-export-render-drift)", () => {
  function deckWith(elements: Deck["slides"][number]["elements"]): Deck {
    return {
      schemaVersion: 1,
      title: "Contract fixture",
      width: 1280,
      height: 720,
      revision: 1,
      slides: [{
        id: "slide-1",
        background: "#000000",
        elementIds: Object.keys(elements),
        elements,
      }],
    };
  }

  test("insets text by TEXT_PADDING logical units before scaling, matching web/native padding", () => {
    const deck = deckWith({
      copy: {
        id: "copy",
        type: "text",
        frame: { x: 100, y: 100, w: 400, h: 200, rotation: 0 },
        text: "Inset me",
        style: {
          fontSize: 32,
          bold: false,
          italic: false,
          color: "#ffffff",
          align: "left",
          verticalAlign: "top",
        },
      },
    });
    const expectedLogical = {
      x: 100 + TEXT_PADDING,
      y: 100 + TEXT_PADDING,
      w: 400 - 2 * TEXT_PADDING,
      h: 200 - 2 * TEXT_PADDING,
      rotation: 0,
    };

    const pdf = renderDeckInstructions(deck, "pdf");
    expect(pdf.slides[0].instructions[0].frame).toEqual(
      scaleFrame(expectedLogical, "pdf"),
    );

    const pptx = renderDeckInstructions(deck, "pptx");
    expect(pptx.slides[0].instructions[0].frame).toEqual(
      scaleFrame(expectedLogical, "pptx"),
    );
  });

  test("clamps a hairline logical strokeWidth to the same floor as the screen renderers", () => {
    const deck = deckWith({
      hairline: {
        id: "hairline",
        type: "line",
        frame: { x: 0, y: 0, w: 640, h: 2, rotation: 0 },
        style: { fill: null, stroke: "#ff0000", strokeWidth: 0.25 },
      },
    });

    const rendered = renderDeckInstructions(deck, "pdf");
    const instruction = rendered.slides[0].instructions[0];
    expect(instruction.kind).toBe("line");
    if (instruction.kind !== "line" && instruction.kind !== "rect" && instruction.kind !== "ellipse") {
      throw new Error("expected a shape instruction");
    }
    // Floored to the 1-logical-unit minimum (lineStrokeLogical), THEN
    // converted to points (* 0.75) — never the raw 0.25 * 0.75 = 0.1875pt,
    // which would round away to an invisible rule in the exported file.
    expect(instruction.strokeWidth).toBeCloseTo(0.75, 5);
  });

  test("does not floor a rect/ellipse strokeWidth the same way a line is floored", () => {
    const deck = deckWith({
      box: {
        id: "box",
        type: "rect",
        frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        style: { fill: null, stroke: "#ff0000", strokeWidth: 0.25 },
      },
    });
    const rendered = renderDeckInstructions(deck, "pdf");
    const instruction = rendered.slides[0].instructions[0];
    if (instruction.kind !== "rect") throw new Error("expected a rect");
    expect(instruction.strokeWidth).toBeCloseTo(0.25 * 0.75, 5);
  });

  test("insets a non-square ellipse's geometry by half its stroke width per axis, keeping the outer stroke edge on the frame box", () => {
    const deck = deckWith({
      oval: {
        id: "oval",
        type: "ellipse",
        frame: { x: 40, y: 40, w: 600, h: 120, rotation: 0 },
        style: { fill: "#123456", stroke: "#abcdef", strokeWidth: 24 },
      },
    });
    // Logical inset: half the stroke width (12) off each side.
    const expectedLogical = {
      x: 40 + 12,
      y: 40 + 12,
      w: 600 - 24,
      h: 120 - 24,
      rotation: 0,
    };

    const pdf = renderDeckInstructions(deck, "pdf");
    const pdfInstruction = pdf.slides[0].instructions[0];
    if (pdfInstruction.kind !== "ellipse") throw new Error("expected an ellipse");
    expect(pdfInstruction.frame).toEqual(scaleFrame(expectedLogical, "pdf"));
    // strokeWidth itself is unchanged by the geometry inset (only converted).
    expect(pdfInstruction.strokeWidth).toBeCloseTo(24 * 0.75, 5);

    const pptx = renderDeckInstructions(deck, "pptx");
    const pptxInstruction = pptx.slides[0].instructions[0];
    if (pptxInstruction.kind !== "ellipse") throw new Error("expected an ellipse");
    expect(pptxInstruction.frame).toEqual(scaleFrame(expectedLogical, "pptx"));
  });

  test("clamps an ellipse's inset frame to a non-negative size when the stroke exceeds the box", () => {
    const deck = deckWith({
      thickRing: {
        id: "thickRing",
        type: "ellipse",
        frame: { x: 0, y: 0, w: 10, h: 30, rotation: 0 },
        style: { fill: null, stroke: "#ffffff", strokeWidth: 40 },
      },
    });
    const rendered = renderDeckInstructions(deck, "pdf");
    const instruction = rendered.slides[0].instructions[0];
    if (instruction.kind !== "ellipse") throw new Error("expected an ellipse");
    expect(instruction.frame.w).toBe(0);
    expect(instruction.frame.h).toBe(0);
  });
});

describe("pdf-lib coordinate adaptation", () => {
  test("flips an unrotated top-left frame to a bottom-left origin", () => {
    expect(pdfPlacement({ x: 10, y: 20, w: 100, h: 50, rotation: 0 }))
      .toEqual({ x: 10, y: 470, w: 100, h: 50, rotation: 0 });
  });

  test("adjusts the origin so rotation remains centred", () => {
    const placement = pdfPlacement({
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      rotation: 90,
    });
    expect(placement.x).toBeCloseTo(35);
    expect(placement.y).toBeCloseTo(545);
    expect(placement.rotation).toBe(-90);
  });

  test("rotates line endpoints clockwise around the frame centre", () => {
    const points = pdfLinePoints({
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      rotation: 90,
    });
    expect(points.start.x).toBeCloseTo(75);
    expect(points.start.y).toBeCloseTo(565);
    expect(points.end.x).toBeCloseTo(25);
    expect(points.end.y).toBeCloseTo(465);
  });
});
