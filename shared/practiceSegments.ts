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
 * THE LAUNCHPAD IS NOT IN THAT SUM. An instructional Launchpad is an ungraded
 * beat that sits in the run but is deliberately NOT a member of `items` (which
 * is the graded array — keeping it out is what makes `masteryEffect: "none"`
 * structural rather than a trusted flag). So the server's `segments` keeps its
 * sum-to-`items.length` invariant untouched, and each client derives a DISPLAY
 * list with the launchpad spliced in via `withLaunchpadSegment` below. The
 * scholar sees it as a real, labelled beat in the playlist; the server contract
 * that existing tests pin does not move.
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
 *   • "launchpad"    — an ungraded instructional beat introducing the strand the
 *                      run is about to enter. Display-only (see the file header):
 *                      never emitted by the server's run-length pass, always
 *                      spliced client-side by `withLaunchpadSegment`.
 */

import { FAST_MATH_NAME } from "./fastMathName";

export type SegmentKind =
  | "core_drill"
  | "manipulative"
  | "choice"
  | "stretch"
  | "mapping"
  | "sweep"
  | "fact_sprint"
  | "launchpad";

export type Segment = {
  kind: SegmentKind;
  /** How many of the immediately-following flat `items` belong to this segment.
   *  Counts always sum to `items.length` on the wire. A spliced "launchpad"
   *  display segment is the one exception and always has `count: 1`. */
  count: number;
};

/**
 * Kid-respecting, no-rewards-framing copy per segment kind (visual-design rules:
 * no "streak"/score framing). A REPEATED core_drill segment later in a session
 * (rare — only when the anti-slog fix can't find a different-kind item to lead
 * with) reads "Keep going" rather than re-using "Warm-up", which belongs to the
 * leading due-reviews beat.
 *
 * "First look" for the launchpad names what the beat IS — a look at the idea
 * before any question is asked — without promising a reward or implying the
 * practice that follows is a test of it.
 */
export function segmentBeatLabel(kind: SegmentKind, isFirstOfKind: boolean = false): string {
  if (kind === "launchpad") return "First look";
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
 *
 * A "launchpad" segment is ALWAYS announced, even in a single-segment run: it is
 * the one beat whose whole purpose is to name what the scholar is stepping into,
 * so suppressing it would defeat the point.
 */
export function segmentBeatVisibleForKind(
  segmentCount: number,
  currentSegmentKind: string | undefined,
): boolean {
  if (currentSegmentKind === "launchpad") return true;
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

/**
 * Derive the DISPLAY segment list: the server's run-length `segments` with the
 * ungraded launchpad beat spliced in as its own single-item segment at item
 * index `at`.
 *
 * Splicing (rather than asking the server to emit it) is what lets the wire
 * invariant "counts sum to `items.length`" stay true while the scholar still
 * sees the Launchpad as a first-class beat in the playlist. Positional maths in
 * the clients (`segmentStartIdx`) treats the launchpad as occupying the slot
 * immediately BEFORE `items[at]`.
 *
 * `at` is clamped defensively: an out-of-range index (a stale snapshot, a
 * recomposed run) appends rather than corrupting the list, and a run-length list
 * whose counts don't reach `at` is returned untouched rather than silently
 * mis-grouped.
 */
export function withLaunchpadSegment(segments: Segment[], at: number | undefined): Segment[] {
  if (at == null || at < 0) return segments;
  const out: Segment[] = [];
  let offset = 0;
  let inserted = false;
  for (const seg of segments) {
    if (!inserted && at === offset) {
      out.push({ kind: "launchpad", count: 1 });
      inserted = true;
    }
    if (!inserted && at > offset && at < offset + seg.count) {
      // The launchpad lands INSIDE an existing run — split it so the beat sits
      // exactly before the item it introduces.
      out.push({ kind: seg.kind, count: at - offset });
      out.push({ kind: "launchpad", count: 1 });
      out.push({ kind: seg.kind, count: seg.count - (at - offset) });
      inserted = true;
      offset += seg.count;
      continue;
    }
    out.push(seg);
    offset += seg.count;
  }
  if (!inserted) {
    if (at !== offset) return segments; // out of range — leave the list alone
    out.push({ kind: "launchpad", count: 1 });
  }
  return out;
}

/**
 * Splice the Launchpad into a HOME-PREVIEW row list (the playlist card's
 * receipt of what Start will serve), returning a new list.
 *
 * The in-run twin of this is `withLaunchpadSegment` above; this one operates on
 * whatever row shape a client already renders, via the `make` factory, so
 * neither surface has to grow a parallel row type. It lives here — beside the
 * in-run splice — for one reason: the preview and the run must not drift. They
 * are two renderings of the SAME server decision (`playlistForScholar.launchpad`
 * and `practiceSession.launchpad` are both resolved by `resolveRunLaunchpad`),
 * so the ordering rule belongs in one place with one test.
 *
 * The dot rule: the doorway is genuinely served BEFORE the item it introduces,
 * so when it lands ahead of everything still to do it takes the "next" dot and
 * DEMOTES the skill that would otherwise have read as next. Showing the skill
 * as next while a beat precedes it would misstate the order — the specific
 * dishonesty this whole change exists to remove.
 *
 * Demotion swaps the row's TAG as well as its dot, which is why every row must
 * carry `queuedTag` (what it reads once it is no longer next). Rewriting only
 * the dot would leave the demoted skill still captioned "Next up" beneath a
 * doorway ALSO marked next -- a receipt claiming two next things, i.e. the same
 * contradiction in different paint. Requiring the queued caption up front makes
 * that state unrepresentable rather than merely remembered.
 *
 * `insertAt` is the index into the rendered rows (a caller that prepends an
 * off-set next-up row must offset it), clamped defensively.
 */
export function withLaunchpadRow<R extends { kind: string; tag: string; queuedTag: string }>(
  rows: R[],
  insertAt: number,
  make: (kind: "next" | "queued") => R,
): R[] {
  const at = Math.max(0, Math.min(insertAt, rows.length));
  // Rows already finished this block don't hold the "next" slot, so a doorway
  // behind only ✓ rows is still the next thing the scholar will actually see.
  const takesNext = rows.slice(0, at).every((r) => r.kind === "done");
  const out: R[] = [...rows.slice(0, at), make(takesNext ? "next" : "queued"), ...rows.slice(at)];
  if (takesNext) {
    for (let i = at + 1; i < out.length; i += 1) {
      if (out[i].kind === "next") {
        out[i] = { ...out[i], kind: "queued", tag: out[i].queuedTag } as R;
        break;
      }
    }
  }
  return out;
}
