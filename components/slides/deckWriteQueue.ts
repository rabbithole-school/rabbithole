/**
 * Reconciliation for the ONE funnel every teacher deck write goes through
 * (`TeacherDeckEditor`'s `onChange`).
 *
 * Two writers hand decks to that funnel and neither can see the other's
 * in-flight work:
 *
 *  • `SlidesEditor` computes each edit from its OWN synchronous working copy,
 *    which it adopts from the `deck` prop only once a higher revision arrives.
 *  • the top bar's title field computes a `setTitle` from the deck of the
 *    render it was last drawn with.
 *
 * So a slide edit started around a rename carries the PRE-rename title, and
 * writing it verbatim silently undoes the rename — the deck is saved whole, so
 * a stale field in it is a lost field, not a no-op. Both writers can also land
 * on the same revision number, which defeats the save's compare-and-set guard:
 * equal revisions look "not stale" to the server, so the second write
 * overwrites the first instead of being refused.
 *
 * This keeps both invariants in one pure place: a committed title survives
 * every later write until the save carrying it lands, and queued revisions
 * strictly increase.
 */

import { MAX_REVISION, type Deck } from "@/shared/slidesScene";

export interface DeckWriteState {
  /** The last deck handed to the save chain, or null if nothing is queued. */
  lastQueued: Deck | null;
  /**
   * A title the teacher committed whose save has not landed yet. Null once the
   * server has it (or when the teacher never renamed anything).
   */
  pendingTitle: string | null;
}

/**
 * The deck to actually queue for `next`, given what's already in flight.
 *
 * Returns `next` unchanged when it is already coherent, so the common case
 * allocates nothing new.
 */
export function reconcileDeckWrite(next: Deck, state: DeckWriteState): Deck {
  let deck = next;

  // A rename the writer of `next` could not have seen yet wins: it is the
  // teacher's latest explicit intent, and this write would otherwise persist
  // the older title.
  if (state.pendingTitle !== null && deck.title !== state.pendingTitle) {
    deck = { ...deck, title: state.pendingTitle };
  }

  // Keep queued revisions strictly increasing. A write computed from a deck the
  // queue has already moved past reuses a revision, which reads as "not stale"
  // to the compare-and-set save and lets it clobber the earlier write.
  const floor = state.lastQueued?.revision;
  if (floor !== undefined && deck.revision <= floor) {
    deck = { ...deck, revision: (floor + 1) % MAX_REVISION };
  }

  return deck;
}

/**
 * The deck a title edit should be applied to: whichever of the rendered deck
 * and the last queued deck is further ahead. Within a single tick either one
 * can be the stale view of the other, and applying `setTitle` to a superseded
 * deck would drop the slide edit that superseded it.
 */
export function titleEditBase(
  rendered: Deck | null,
  lastQueued: Deck | null,
): Deck | null {
  if (!lastQueued) return rendered;
  if (!rendered) return lastQueued;
  return lastQueued.revision > rendered.revision ? lastQueued : rendered;
}
