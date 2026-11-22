/**
 * PLAYLIST SEGMENTS — the ONE cross-surface definition of a practice run's
 * scholar-facing beat structure.
 *
 * Why this file exists: the segment KIND union used to be hand-mirrored in three
 * places — `convex/lib/practice/segments.ts`, `components/practice/
 * PracticeSession.tsx`, and `native/src/app/practice.tsx` — with nothing
 * cross-checking them, and it had already drifted: the server could emit
 * `"stretch"` (the challenge lane) while BOTH clients declared only four kinds
 * and would silently fall through to the default beat label. `segmentBeatLabel`
 * was likewise copy-pasted verbatim into both clients, which is a scholar-facing
 * copy drift waiting to happen. One owner, vendored for native, ends both.
 *
 *   • web    — imports `@/shared/practiceSegments`
 *   • native — imports the vendored copy (native/scripts/sync-vendor.js)
 *   • server — `convex/lib/practice/segments.ts` re-exports the types from here
 *
 * THE WIRE SHAPE (unchanged, and load-bearing): `segments` is a run-length
 * encoding over the flat `items` array — `{ kind, count }[]` where the counts
 * SUM TO `items.length`, so slicing `items` by each count in order reconstructs
 * it exactly. `items` stays the single source of truth for the idx/total state
 * machine in `shared/practiceLoop.ts`; a client that ignores `segments` sees the
 * same flat loop as before.
 *
 * Imports nothing, so it resolves standalone under Metro when vendored.
 */

/**
 * Every beat kind a practice run can show.
 *
 *   • "core_drill"   — plain template/stored drill items, including reviews.
 *   • "manipulative" — a manipulative-answer-type item (the toolbox).
 *   • "choice"       — a NEW-lane item in the strand the scholar picked.
 *                      Reviews are never "choice": retention is never optional.
 *   • "stretch"      — a CHALLENGE-lane item (an above-band frontier node the
 *                      grade band withheld). Optional, never mixed into the
 *                      required set.
 *   • "mapping"      — a placement probe served as a playlist item. Renders NO
 *                      beat header (see `segmentBeatVisibleForKind`); its
 *                      per-item marker carries the identity alone.
 *   • "sweep"        — the leading cross-domain due-review movement in focus
 *                      mode. Always one contiguous server-emitted segment.
 *   • "fact_sprint"  — a short contiguous block of bare single-digit facts
 *                      (+/−/×) targeted at the scholar's weakest facts in a
 *                      fact family the run is ALREADY exercising. The FastMath-
 *                      analog automaticity beat (the "Fast math" beat). Never gates,
 *                      never shows a clock; selection is silent.
 */

import { FAST_MATH_NAME } from "./fastMathName";

export type SegmentKind =
  | "core_drill"
  | "manipulative"
  | "choice"
  | "stretch"
  | "mapping"
  | "sweep"
  | "fact_sprint";

export type Segment = {
  kind: SegmentKind;
  /** How many of the immediately-following flat `items` belong to this segment.
   *  Counts always sum to `items.length` on the wire. */
  count: number;
};

/**
 * Kid-respecting, no-rewards-framing copy per segment kind (visual-design rules:
 * no "streak"/score framing). A REPEATED core_drill segment later in a session
 * (rare — only when the anti-slog fix can't find a different-kind item to lead
 * with) reads "Keep going" rather than re-using "Warm-up", which belongs to the
 * leading due-reviews beat.
 */
export function segmentBeatLabel(kind: SegmentKind, isFirstOfKind: boolean = false): string {
  if (kind === "sweep") return "Keep it sharp";
  if (kind === "fact_sprint") return FAST_MATH_NAME;
  if (kind === "manipulative") return "Build it";
  if (kind === "choice") return "Your pick";
  if (kind === "stretch") return "Go deeper";
  // A `· mapping` segment renders NO beat (founder amendment 2026-07-19 #2) —
  // the per-item header marker carries the mapping identity alone. Mapping is
  // guarded out by `segmentBeatVisibleForKind`, so that arm never reaches here.
  return isFirstOfKind ? "Warm-up" : "Keep going";
}

/**
 * Segment-beat visibility.
 *
 * The beat header shows on the FIRST item of a segment, only when there's more
 * than ONE segment to announce (a lone run-length segment has nothing to seam)
 * AND the current segment isn't a `· mapping` segment — mapping carries its
 * identity in the per-item marker and renders no beat (founder amendment
 * 2026-07-19 #2). A pure predicate so both clients stay in lockstep and it's
 * unit-testable without a render harness.
 */
export function segmentBeatVisibleForKind(
  segmentCount: number,
  currentSegmentKind: string | undefined,
): boolean {
  return segmentCount > 1 && currentSegmentKind !== "mapping";
}

/**
 * Founder amendment (2026-07-19) — ceremony header, not ceremony block.
 *
 * The per-item header marker on a mapping item reads `· mapping`, EXCEPT when
 * the whole run is the all-mapping "Math Check-In" ceremony sit, where it reads
 * `· math check-in`. Blended runs keep `· mapping`. Native mirrors the same swap
 * in its uppercase eyebrow idiom (`MAPPING` / `MATH CHECK-IN`).
 */
export function mappingHeaderLabel(allMapping: boolean): string {
  return allMapping ? "· math check-in" : "· mapping";
}
