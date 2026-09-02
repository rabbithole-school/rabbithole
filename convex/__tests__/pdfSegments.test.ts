import { describe, expect, test } from "vitest";
import {
  normalizeDocumentHeading,
  normalizeSegments,
  normalizeRotation,
  applyPageRotation,
  normalizeRotationRepair,
  type RawSegment,
} from "../lib/pdfSegments";

// Pure tests for stack-segmentation normalization — the part of the
// split-a-scanned-stack feature that doesn't need pdf-lib or a deployment.
// The actual page extraction is exercised by the Convex proof + manual E2E.

describe("normalizeRotation", () => {
  test("passes through valid rotations", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
  });
  test("snaps to nearest 90 and wraps", () => {
    expect(normalizeRotation(85)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
  });
  test("garbage → 0", () => {
    expect(normalizeRotation(null)).toBe(0);
    expect(normalizeRotation(undefined)).toBe(0);
    expect(normalizeRotation(NaN)).toBe(0);
  });
});

describe("normalizeDocumentHeading", () => {
  test("trims and caps printed headings at 80 characters", () => {
    expect(normalizeDocumentHeading("  Learning Print  ")).toBe(
      "Learning Print",
    );
    expect(normalizeDocumentHeading(`  ${"x".repeat(90)}  `)).toBe(
      "x".repeat(80),
    );
    expect(normalizeDocumentHeading(null)).toBe("");
  });

  describe("normalizeRotationRepair", () => {
    test("returns sanitized page corrections and current rotations", () => {
      expect(
        normalizeRotationRepair(
          '{"rotationDegreesByPage":[90,275,-181,"bad"]}',
          4,
          [360, 90, 180, 270],
        ),
      ).toEqual({
        currentRotations: [0, 90, 180, 270],
        proposedCorrections: [90, 270, 180, 0],
        reportedPageCount: 4,
        valid: true,
      });
    });

    test("accepts the compact rotations key and pads malformed responses", () => {
      expect(normalizeRotationRepair({ rotations: [270] }, 3)).toEqual({
        currentRotations: [0, 0, 0],
        proposedCorrections: [270, 0, 0],
        reportedPageCount: 1,
        valid: false,
      });
      expect(normalizeRotationRepair("not json", 2)).toMatchObject({
        proposedCorrections: [0, 0],
        reportedPageCount: 0,
        valid: false,
      });
    });
  });
});

describe("normalizeSegments", () => {
  test("empty / null input → one whole-file segment", () => {
    expect(normalizeSegments(null, 5)).toEqual([
      { startPage: 1, endPage: 5, detectedName: null, documentHeading: "", caption: "", extractedText: "", rotationDegreesByPage: [0, 0, 0, 0, 0], rotationDegrees: 0, assignmentGuess: null },
    ]);
    expect(normalizeSegments([], 3)[0]).toMatchObject({ startPage: 1, endPage: 3 });
  });

  test("a clean 4×3 stack passes through, 1-indexed", () => {
    const raw: RawSegment[] = [
      { startPage: 1, endPage: 3, detectedName: "Oliver", rotationDegrees: 90 },
      { startPage: 4, endPage: 6, detectedName: "Kai", rotationDegrees: 0 },
      { startPage: 7, endPage: 9, detectedName: "Lani", rotationDegrees: 270 },
      { startPage: 10, endPage: 12, detectedName: "Noah", rotationDegrees: 0 },
    ];
    const out = normalizeSegments(raw, 12);
    expect(out).toHaveLength(4);
    expect(out.map((s) => [s.startPage, s.endPage])).toEqual([
      [1, 3], [4, 6], [7, 9], [10, 12],
    ]);
    expect(out[0]).toMatchObject({ detectedName: "Oliver", rotationDegrees: 90 });
    expect(out[2].rotationDegrees).toBe(270);
  });

  test("normalizes each segment's printed heading", () => {
    const [segment] = normalizeSegments(
      [
        {
          startPage: 1,
          endPage: 1,
          documentHeading: `  ${"Learning Print ".repeat(10)}  `,
        },
      ],
      1,
    );
    expect(segment.documentHeading).toBe(
      "Learning Print ".repeat(10).trim().slice(0, 80),
    );
  });

  test("overlaps are resolved (later start bumped past previous end)", () => {
    const out = normalizeSegments(
      [
        { startPage: 1, endPage: 3 },
        { startPage: 2, endPage: 5 },
      ],
      5
    );
    expect(out.map((s) => [s.startPage, s.endPage])).toEqual([[1, 3], [4, 5]]);
  });

  test("out-of-range pages are clamped", () => {
    const out = normalizeSegments(
      [
        { startPage: 0, endPage: 2 },
        { startPage: 8, endPage: 99 },
      ],
      9
    );
    expect(out.map((s) => [s.startPage, s.endPage])).toEqual([[1, 2], [8, 9]]);
  });

  test("garbage entries dropped; all-garbage → whole-file fallback", () => {
    const out = normalizeSegments(
      [
        { startPage: "x" as any, endPage: 2 },
        { startPage: 5, endPage: 1 }, // end < start
      ],
      6
    );
    expect(out).toEqual([
      { startPage: 1, endPage: 6, detectedName: null, documentHeading: "", caption: "", extractedText: "", rotationDegreesByPage: [0, 0, 0, 0, 0, 0], rotationDegrees: 0, assignmentGuess: null },
    ]);
  });

  test("normalizes mixed page orientations and falls back for legacy responses", () => {
    const [mixed] = normalizeSegments(
      [{ startPage: 2, endPage: 4, rotationDegreesByPage: [90, 275, -181] }],
      4,
    );
    expect(mixed.rotationDegreesByPage).toEqual([90, 270, 180]);

    const [legacy] = normalizeSegments(
      [{ startPage: 1, endPage: 3, rotationDegrees: 90 }],
      3,
    );
    expect(legacy.rotationDegreesByPage).toEqual([90, 90, 90]);

    const [transitional] = normalizeSegments(
      [{ startPage: 1, endPage: 2, rotationDegrees: [270, 0] }],
      2,
    );
    expect(transitional.rotationDegreesByPage).toEqual([270, 0]);
  });

  test("fills missing page rotations from the legacy fallback and clamps garbage", () => {
    const [segment] = normalizeSegments(
      [{ startPage: 1, endPage: 3, rotationDegrees: 180, rotationDegreesByPage: [90, NaN] }],
      3,
    );
    expect(segment.rotationDegreesByPage).toEqual([90, 0, 180]);
  });

  test("applies a page correction additively to existing PDF rotation", () => {
    const page = {
      angle: 270,
      getRotation() { return { angle: this.angle }; },
      setRotation(rotation: { angle: number }) { this.angle = rotation.angle; },
    };
    applyPageRotation(page, 180, (angle) => ({ angle }));
    expect(page.angle).toBe(90);
  });

  test("a fully-swallowed overlapping segment is dropped", () => {
    const out = normalizeSegments(
      [
        { startPage: 1, endPage: 5 },
        { startPage: 2, endPage: 4 }, // entirely inside the first
      ],
      5
    );
    expect(out.map((s) => [s.startPage, s.endPage])).toEqual([[1, 5]]);
  });
});
