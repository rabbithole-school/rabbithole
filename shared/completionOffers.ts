/**
 * completionOffers — the pure priority arbiter for the practice done screen's
 * offer stack. Both frontends (`PracticeSession.tsx` / `practice.tsx`) accreted
 * their own ad-hoc conditionals for re-probe / tune-up / challenge / more-of-
 * your-pick / the Moments story reveal card, with no single owner deciding
 * WHICH offer gets top billing and whether the whole offer layer should even
 * render — this module is that single owner. Both frontends MUST consume this
 * SAME function for ordering; each may still render its own visual treatment,
 * but neither may reimplement the priority logic.
 *
 * Priority (highest first):
 *   1. An in-progress CONTINUATION the scholar already entered (they accepted
 *      a tune-up / challenge / re-probe run and this done-screen IS that run's
 *      own completion) — NEVER interrupted by a new offer. No primary, no
 *      alternatives; the caller's own exit affordance (Done / Practice again)
 *      is unaffected — this module has no opinion on it.
 *   2. The one-time Moments story reveal, as PRIMARY, exactly once per
 *      done-screen. A museum-label moment, not a bonus a scholar opts into —
 *      it always outranks the ordinary practice offers when live.
 *   3. Re-probe / tune-up, when due (an EARNED offer — the engine detected a
 *      likely under-placement or a due retention check).
 *   4. Stretch / challenge / more-of-your-pick — opt-in bonus rounds. Stretch
 *      and challenge share one tail slot, so only one of those siblings renders.
 *
 * EXCLUSIVE RENDERING (P4 — "primary means alone"). This module arbitrates
 * ORDER, but the story primary is also EXCLUSIVE at the pixel layer: when
 * `phase === "offer"`, both frontends render ONLY the story announcement + Done
 * — no reprobe offer, no "Keep going?" chooser, no Continue. The alternatives it
 * still returns under a story primary are the eligibility that PERSISTS to the
 * next story-less close (a delay, not a loss), never a second thing to draw
 * beside the story. Reprobe/tune-up/chooser surface only when the story slot is
 * empty. See `PracticeSession.tsx` / `practice.tsx` (`storyCardVisible`).
 *
 * Import-free (framework-agnostic) — vendored verbatim into `native/vendor/`
 * (see `native/scripts/sync-vendor.js`) so both frontends run the identical
 * decision, never a hand-maintained drift copy.
 *
 * Semantics worth calling out (the audit's actual asks):
 *   - The story renders as `primary` only once per edge — the CALLER stops the
 *     `story` candidate (passing `undefined`) once the scholar has followed the
 *     thread or started the story's OWN linked application (recorded "tried").
 *     Walking away records nothing (announcement mode): the star is already
 *     minted and the story stands in the scholar-home "New stories" section, so
 *     there is no dismissed-on-walk-away outcome to settle.
 *   - Starting a bonus run still enters a continuation (`inContinuation: true`),
 *     and the pure function drops `primary`/`alternatives` UNCONDITIONALLY in
 *     that branch. Under exclusive rendering the two no longer collide on screen
 *     — a live story hides the bonus offers entirely — but the unconditional
 *     drop stays as defence in depth, so a stale story candidate can never
 *     resurface once a continuation has begun.
 */

export type CompletionOfferKind =
  | "story"
  | "reprobe"
  | "tuneup"
  | "stretch"
  | "challenge"
  | "moreOfPick";

export interface CompletionOffer<TPayload = unknown> {
  readonly kind: CompletionOfferKind;
  readonly payload: TPayload;
}

/**
 * `active`   — a continuation is in progress; no offer layer at all.
 * `offer`    — the one-time story moment is live and is the `primary`.
 * `settled`  — no primary (no story, or it's already been settled this
 *              done-screen); `alternatives` is the ordinary practice menu.
 */
export type CompletionPhase = "active" | "offer" | "settled";

export interface CompletionState<TPayload = unknown> {
  readonly phase: CompletionPhase;
  readonly primary?: CompletionOffer<TPayload>;
  readonly alternatives: ReadonlyArray<CompletionOffer<TPayload>>;
}

export interface CompletionOfferCandidates<TPayload = unknown> {
  /** True while THIS done-screen render is itself the continuation of a
   *  tune-up / challenge / re-probe run the scholar already accepted. */
  inContinuation: boolean;
  /** The live, not-yet-settled Moments story moment, if any — `undefined`
   *  once the scholar has acted on it (or it never applied). */
  story?: TPayload;
  reprobe?: TPayload;
  tuneup?: TPayload;
  stretch?: TPayload;
  challenge?: TPayload;
  moreOfPick?: TPayload;
}

/** Fixed slots for the ordinary practice-continuation menu. Stretch and
 *  challenge are depth/forward siblings in one slot; when both are available,
 *  the curated depth offer wins and challenge remains the fallback. */
const ALTERNATIVE_SLOTS: ReadonlyArray<
  ReadonlyArray<Exclude<CompletionOfferKind, "story">>
> = [
  ["reprobe"],
  ["tuneup"],
  ["stretch", "challenge"],
  ["moreOfPick"],
];

export function resolveCompletionOffers<TPayload>(
  candidates: CompletionOfferCandidates<TPayload>,
): CompletionState<TPayload> {
  // Priority 1 — an in-progress continuation is never interrupted. This
  // branch drops EVERYTHING unconditionally (even a still-set `story`), so a
  // caller that forgets to also clear the story candidate can't accidentally
  // resurrect it once a bonus run has started.
  if (candidates.inContinuation) {
    return { phase: "active", alternatives: [] };
  }

  const alternatives: CompletionOffer<TPayload>[] = [];
  for (const slot of ALTERNATIVE_SLOTS) {
    for (const kind of slot) {
      const payload = candidates[kind];
      if (payload === undefined) continue;
      alternatives.push({ kind, payload });
      break;
    }
  }

  // Priority 2 — the one-time story moment, as primary, exactly once.
  if (candidates.story !== undefined) {
    return {
      phase: "offer",
      primary: { kind: "story", payload: candidates.story },
      alternatives,
    };
  }

  // Priorities 3-4 live entirely in `alternatives`'s fixed order above;
  // there is no primary once the story is absent/settled.
  return { phase: "settled", alternatives };
}
