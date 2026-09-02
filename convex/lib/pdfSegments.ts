// Pure normalization for the LLM's stack-segmentation output.
//
// A scanned PDF can be a stack: e.g. 12 pages = 4 students × a 3-page
// assignment. We ask Claude to return the page ranges that form each separate
// submission. The model's raw output can't be trusted to be clean (overlaps,
// out-of-range pages, missing rotation), so this function sanitizes it into
// ordered, non-overlapping, in-range 1-indexed segments — kept PURE so the
// messy edge cases are cheap to unit-test without pdf-lib or a deployment.
//
// Gaps are allowed (a blank separator page between submissions simply belongs
// to no segment). Empty/garbage input falls back to a single whole-file
// segment, so the single-document case (and any model failure) degrades to
// "one item, unchanged" rather than dropping the scan.

export interface RawSegment {
  startPage?: number;
  endPage?: number;
  detectedName?: string | null;
  documentHeading?: string | null;
  caption?: string | null;
  extractedText?: string | null;
  /** Clockwise correction for each page in the segment, in segment order. */
  rotationDegreesByPage?: number[] | null;
  /** Legacy contract: one correction applied to every page. Also accepts the
   * transitional array form used by some synthetic responses. */
  rotationDegrees?: number | number[] | null;
  /** Unvalidated assignment id the model guessed (cross-checked downstream). */
  assignmentId?: string | null;
}
export interface NormalizedSegment {
  startPage: number; // 1-indexed inclusive
  endPage: number; // 1-indexed inclusive
  detectedName: string | null;
  documentHeading: string;
  caption: string;
  extractedText: string;
  rotationDegreesByPage: (0 | 90 | 180 | 270)[];
  /** @deprecated Use rotationDegreesByPage. Kept for callers of the old contract. */
  rotationDegrees: 0 | 90 | 180 | 270;
  /** Raw assignment guess from the model — still needs validation + enrollment check. */
  assignmentGuess: string | null;
}

/** Snap any number to the nearest valid clockwise rotation. */
export function normalizeRotation(deg: number | null | undefined): 0 | 90 | 180 | 270 {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return 0;
  const snapped = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return snapped as 0 | 90 | 180 | 270;
}

export interface RotationRepairPlan {
  currentRotations: (0 | 90 | 180 | 270)[];
  proposedCorrections: (0 | 90 | 180 | 270)[];
  reportedPageCount: number;
  valid: boolean;
}

/** Parse the deliberately narrow response used by the rotation-repair action. */
export function normalizeRotationRepair(
  raw: unknown,
  pageCount: number,
  currentRotations: number[] = [],
): RotationRepairPlan {
  const value =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
          } catch {
            return null;
          }
        })()
      : raw;
  const source =
    value && typeof value === "object"
      ? (value as { rotationDegreesByPage?: unknown; rotations?: unknown })
      : null;
  const proposed = Array.isArray(source?.rotationDegreesByPage)
    ? source.rotationDegreesByPage
    : Array.isArray(source?.rotations)
      ? source.rotations
      : [];
  return {
    currentRotations: Array.from({ length: Math.max(0, pageCount) }, (_, i) =>
      normalizeRotation(currentRotations[i]),
    ),
    proposedCorrections: Array.from({ length: Math.max(0, pageCount) }, (_, i) =>
      normalizeRotation(proposed[i] as number | null | undefined),
    ),
    reportedPageCount: proposed.length,
    valid: proposed.length === pageCount,
  };
}

export function normalizeDocumentHeading(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

export function normalizeSegments(
  raw: RawSegment[] | null | undefined,
  pageCount: number,
): NormalizedSegment[] {
  const fullFile = (): NormalizedSegment[] => [
    {
      startPage: 1,
      endPage: Math.max(1, pageCount),
      detectedName: null,
      documentHeading: "",
      caption: "",
      extractedText: "",
      rotationDegreesByPage: Array.from({ length: Math.max(1, pageCount) }, () => 0),
      rotationDegrees: 0,
      assignmentGuess: null,
    },
  ];

  if (pageCount < 1) return [];
  if (!Array.isArray(raw) || raw.length === 0) return fullFile();

  // Clamp + validate each candidate.
  const candidates = raw
    .map((s) => {
      const start = Math.round(Number(s.startPage));
      const end = Math.round(Number(s.endPage));
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const clampedStart = Math.min(Math.max(start, 1), pageCount);
      const clampedEnd = Math.min(Math.max(end, 1), pageCount);
      if (clampedEnd < clampedStart) return null;
      return {
        startPage: clampedStart,
        endPage: clampedEnd,
        detectedName: s.detectedName?.trim() || null,
        documentHeading: normalizeDocumentHeading(s.documentHeading),
        caption: s.caption?.trim() || "",
        extractedText: s.extractedText?.trim() || "",
        rotationDegreesByPage: (() => {
          const pageTotal = clampedEnd - clampedStart + 1;
          const legacy = normalizeRotation(
            typeof s.rotationDegrees === "number" ? s.rotationDegrees : null,
          );
          const supplied = Array.isArray(s.rotationDegreesByPage)
            ? s.rotationDegreesByPage
            : Array.isArray(s.rotationDegrees)
              ? s.rotationDegrees
              : null;
          return Array.from({ length: pageTotal }, (_, i) =>
            normalizeRotation(supplied?.[i] ?? legacy),
          );
        })(),
        rotationDegrees: normalizeRotation(
          typeof s.rotationDegrees === "number" ? s.rotationDegrees : null,
        ),
        assignmentGuess: s.assignmentId?.trim() || null,
      };
    })
    .filter((s): s is NormalizedSegment => s !== null)
    .sort((a, b) => a.startPage - b.startPage);

  // Resolve overlaps: a later segment can't start before the previous ended.
  const out: NormalizedSegment[] = [];
  let lastEnd = 0;
  for (const seg of candidates) {
    const start = Math.max(seg.startPage, lastEnd + 1);
    if (start > seg.endPage || start > pageCount) continue; // swallowed by overlap
    const skipped = start - seg.startPage;
    out.push({
      ...seg,
      startPage: start,
      rotationDegreesByPage: seg.rotationDegreesByPage.slice(skipped),
    });
    lastEnd = seg.endPage;
  }

  return out.length > 0 ? out : fullFile();
}

/** Apply one page's clockwise correction, preserving any existing PDF /Rotate. */
export function applyPageRotation<T, R>(
  page: T & {
    getRotation(): { angle: number };
    setRotation(rotation: R): void;
  },
  correction: number | null | undefined,
  degrees: (angle: number) => R,
): T {
  const normalized = normalizeRotation(correction);
  if (normalized !== 0) {
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + normalized) % 360));
  }
  return page;
}
