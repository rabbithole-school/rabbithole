/**
 * PLAYLIST SEGMENTS v1 (raise-the-ceiling §11 "Playlists" / practice-
 * unification-choice-geometry-plan §5 C-4) — grouping the flat served items
 * of a practice session into scholar-facing SEGMENTS ("Warm-up" / "Build it" /
 * "Your pick") with the anti-slog rule: no two identical segment KINDS sit
 * back-to-back.
 *
 * Composed AFTER `serveItems` (serve.ts) returns, from `practiceSession`
 * (practiceSkills.ts) — deliberately NOT inside `serveItems` itself, whose
 * signature the golden-equivalence test in `convex/lib/__tests__/serve.test.ts`
 * pins byte-for-byte. Keeping segmentation one layer up means that test (and
 * every other direct caller of `serveItems`) is completely untouched by this
 * change — no policy knob was needed.
 *
 * THE WIRE SHAPE: `segments` is a run-length encoding over `items` —
 * `{ kind, count }[]` where the counts sum to `items.length` and slicing
 * `items` by each segment's `count` in order reconstructs it exactly. This
 * keeps `items` the SINGLE source of truth for `shared/practiceLoop.ts`'s
 * idx/total state machine: a client that ignores `segments` entirely sees the
 * exact same flat practice loop as before, and a client that reads `segments`
 * never needs a second copy of item data or a fragile id-based join.
 *
 * SEGMENT KINDS (v1 + stretch extension):
 *   • "manipulative" — a manipulative-answer-type item (the toolbox).
 *   • "choice"       — a NEW-lane item whose skill's strand matches the
 *                      scholar's `choiceHint` (the bounded-choice pick).
 *                      Reviews are never "choice" — retention is never
 *                      optional (raise-the-ceiling §8/§11).
 *   • "stretch"      — a CHALLENGE-lane item (an above-band frontier node the
 *                      grade band withheld) or a STRETCH-lane insight problem
 *                      on a fluent node. Both are deliberately harder work and
 *                      share the scholar-facing "Go deeper" beat.
 *   • "core_drill"   — everything else (plain template/stored drill items,
 *                      including reviews).
 *
 * The union also carries "launchpad" (an ungraded instructional beat), which
 * this composer NEVER emits: a Launchpad is not a member of `items`, so it
 * cannot take part in a run-length pass over them. The clients splice it into a
 * DISPLAY list via `withLaunchpadSegment`, which is exactly what lets the
 * counts-sum-to-`items.length` invariant above stay true. See
 * `shared/practiceSegments.ts`.
 *
 * WHAT THE ANTI-SLOG RULE CAN GUARANTEE AT SIZE 6 (documented, not
 * aspirational):
 *   • Within one priority band (the review band, or the frontier/"other"
 *     band), adjacent same-kind items always MERGE into a single segment by
 *     construction (a run-length pass never emits two adjacent same-kind
 *     entries) — so a same-kind clash between two DISTINCT segments can only
 *     ever arise at the review→frontier BOUNDARY.
 *   • At that boundary, the composer may reorder items WITHIN the frontier
 *     band only — moving the nearest differently-kinded frontier item to the
 *     front of the frontier band — to resolve the clash. It never moves a
 *     frontier item ahead of a review, or a review behind a frontier item:
 *     the review/frontier priority boundary is never crossed.
 *   • It CANNOT guarantee a fix when the frontier band is kind-homogeneous
 *     (e.g. every frontier item is a plain drill — no manipulative/choice
 *     item was served this session) and that one kind matches the review
 *     band's trailing kind: there is nothing to swap in. The composer leaves
 *     the clash in place rather than papering over it (see
 *     `composeSegments`'s doc comment). Same for a session with only one band
 *     at all (an all-review session with an empty frontier floor, or a
 *     first-post-placement block with no reviews yet) — no boundary, no
 *     reordering, and nothing to guarantee beyond the trivial single band.
 *   • PRIORITY PRESERVATION: the review band's relative order is NEVER
 *     touched (its SR due-order is exactly the engine's), and at most ONE
 *     frontier item changes position (moved to the front of the frontier
 *     band) — so the composed order is always "the engine's review prefix,
 *     unchanged, followed by the engine's frontier order with at most one
 *     single-element rotation-to-front".
 */

import type { ServedItem } from "./session";
import { MANIPULATIVE_ANSWER_TYPE } from "../../../lib/manipulative/practiceContract";

// The kind union + `Segment` shape live in `shared/practiceSegments.ts` — ONE
// owner across server, web, and native. They used to be hand-mirrored here and
// in both clients, and had already drifted (this file could emit "stretch";
// neither client declared it). Re-exported so existing importers of
// `./segments` are unaffected.
export type { SegmentKind, Segment } from "../../../shared/practiceSegments";
import type { SegmentKind, Segment } from "../../../shared/practiceSegments";

export type ComposeSegmentsOptions = {
  /** The scholar's active bounded-choice pick (C-2), if any. Its strand's
   *  NEW-lane items become the "choice" segment kind. Pass `undefined` when
   *  no choice was made, OR when the session is scoped (`skillKeys`) —
   *  `choiceHint` is already ignored for scoped sessions upstream
   *  (practiceSession's doc comment), so the composer should never invent a
   *  choice segment there either. */
  choiceHint?: { domain: string; strand: string };
  /** skillKey → strand, for resolving `choiceHint` matches. A skill absent
   *  here (an unstranded domain, or outside the loaded domain) never matches;
   *  same for a skill whose strand is `undefined` (an unstranded domain's
   *  `skills` map often carries this). */
  strandByKey: Map<string, string | undefined>;
  /** True on a domain-tagged mixed blend, where `item.domain` is meaningful
   *  and must also match `choiceHint.domain` (a strand name can collide
   *  across domains). False on an untagged single-domain session, where the
   *  caller has already scoped `choiceHint` to the session's one domain. */
  stampDomain: boolean;
  /** Focus mode only: number of leading due-review items in the cross-domain
   * sweep. They emit as one segment regardless of item modality. Undefined
   * preserves the legacy composer byte-for-byte. */
  sweepCount?: number;
};

/** Classify one served item's segment kind. Pure; depends only on the item
 *  and the composer's options (never on position). */
function kindOf(item: ServedItem, opts: ComposeSegmentsOptions): SegmentKind {
  // A fact-sprint item is its OWN beat regardless of lane/modality — the
  // "Fast math" block is a contiguous run of marked bare facts, and marking
  // (not position) is its identity, so it survives every recompose/reorder path
  // as one segment without threading a count option through the composer.
  if (item.isFactSprint) return "fact_sprint";
  // A mapping item (Option D placement-probe-as-playlist-item) is its OWN
  // segment kind regardless of modality — the "· mapping" band reads as one
  // contiguous seam between reviews and new frontier work, and a mapping probe
  // that happens to be a manipulative must not be miscounted as the toolbox.
  if (item.lane === "mapping") return "mapping";
  if (item.answerType === MANIPULATIVE_ANSWER_TYPE) return "manipulative";
  if (item.lane === "challenge" || item.lane === "stretch") return "stretch";
  if (opts.choiceHint && item.lane === "new") {
    const strand = opts.strandByKey.get(item.skillKey);
    if (
      strand &&
      strand === opts.choiceHint.strand &&
      (!opts.stampDomain || item.domain === opts.choiceHint.domain)
    ) {
      return "choice";
    }
  }
  return "core_drill";
}

/** Run-length-encode `items` by kind — adjacent same-kind items merge into one
 *  segment. Never reorders; a pure grouping pass. */
function runLengthSegments(items: ServedItem[], opts: ComposeSegmentsOptions): Segment[] {
  const segments: Segment[] = [];
  for (const item of items) {
    const kind = kindOf(item, opts);
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.count += 1;
    else segments.push({ kind, count: 1 });
  }
  return segments;
}

/**
 * Compose `items` (the flat `serveItems` output, already in the engine's
 * priority order — due reviews first, then frontier) into scholar-facing
 * segments, applying the anti-slog rule. See the file header for exactly what
 * this can and cannot guarantee at a 6-item core.
 *
 * Returns a (possibly reordered) `items` copy alongside the `segments` that
 * describe it — `items` is still the flat array a client's existing idx/total
 * state machine consumes unmodified; `segments` is purely additive metadata.
 */
export function composeSegments(
  items: ServedItem[],
  opts: ComposeSegmentsOptions,
): { items: ServedItem[]; segments: Segment[] } {
  if (opts.sweepCount !== undefined) {
    const sweepCount = Math.max(
      0,
      Math.min(items.length, Math.floor(opts.sweepCount)),
    );
    const sweepItems = items.slice(0, sweepCount);
    const rest = composeOrdinarySegments(items.slice(sweepCount), opts);
    return {
      items: [...sweepItems, ...rest.items],
      segments: [
        ...(sweepItems.length > 0
          ? [{ kind: "sweep" as const, count: sweepItems.length }]
          : []),
        ...rest.segments,
      ],
    };
  }
  return composeOrdinarySegments(items, opts);
}

function composeOrdinarySegments(
  items: ServedItem[],
  opts: ComposeSegmentsOptions,
): { items: ServedItem[]; segments: Segment[] } {
  const reviewBand = items.filter((it) => it.lane === "review");
  const otherBand = items.filter((it) => it.lane !== "review");

  // The ONE reorder this composer ever performs: if the frontier band's first
  // item's kind clashes with the review band's trailing kind, pull the
  // nearest differently-kinded frontier item to the front of the frontier
  // band. Never touches the review band, and never moves anything across the
  // review/frontier boundary — only within the frontier band itself.
  if (reviewBand.length > 0 && otherBand.length > 0) {
    const reviewLastKind = kindOf(reviewBand[reviewBand.length - 1], opts);
    if (kindOf(otherBand[0], opts) === reviewLastKind) {
      const swapIdx = otherBand.findIndex((it) => kindOf(it, opts) !== reviewLastKind);
      if (swapIdx > 0) {
        const [moved] = otherBand.splice(swapIdx, 1);
        otherBand.unshift(moved);
      }
      // swapIdx === -1 (or 0, already impossible here): the frontier band is
      // kind-homogeneous and matches the review band's kind — no fix is
      // possible. Documented limitation (file header); left as-is rather than
      // reordering across the boundary.
    }
  }

  // Segments are run-length-encoded WITHIN each band separately, then
  // concatenated — never across the review/frontier boundary. Provenance (not
  // just modality) is part of a segment's identity (raise-the-ceiling §11:
  // reviews are their own segment), so a review-band run and a frontier-band
  // run of the same kind stay two adjacent segments when the fix above
  // couldn't resolve the clash — the documented limitation, not silently
  // merged away.
  const composed = [...reviewBand, ...otherBand];
  const segments = [...runLengthSegments(reviewBand, opts), ...runLengthSegments(otherBand, opts)];
  return { items: composed, segments };
}
