/**
 * The slide clipboard: copy slides out of one deck and paste them into another,
 * on web and on the BunnyPad.
 *
 * Each night of a multi-night unit gets its own deck in its own session, so a
 * scholar asked to put the whole project together on the last night had no way
 * to bring the earlier slides over. Copy/paste is the general fix.
 *
 * Why an in-app store and not the system clipboard: iPadOS can ask "Allow
 * Paste?" every time an app reads the system pasteboard, and a slide is
 * structured data no other app could use. One JavaScript runtime per app means
 * this module-level value survives moving between sessions, which is the whole
 * job; it does not survive a reload, which is fine for copy-then-paste.
 *
 * The clipboard belongs to ONE signed-in user. On a shared computer, a sibling
 * who signs in without a reload must never be offered the first scholar's
 * slides, so every read takes the current user's id and an owner mismatch reads
 * as empty.
 *
 * Images ride along by `assetId`. The server refuses new media that isn't
 * registered to the deck's owner (`rejectForeignAssets`). Every write to a
 * scholar's deck, the scholar's own or the tutor's, already passes that check,
 * so slides moved between one scholar's decks always paste. That is why only
 * scholar decks offer the clipboard for now: a teacher's activity deck can
 * hold a colleague's images, the save of a deck that pastes them is refused,
 * and the web editor keeps the refused slides in its working copy, so every
 * later save is refused too.
 *
 * Framework-agnostic like `slidesScene.ts` (vendored to native): editors read it
 * through React's `useSyncExternalStore(subscribeSlideClipboard,
 * getSlideClipboardSnapshot)`.
 */

import {
  MAX_OPS_PER_BATCH,
  MAX_SLIDES_PER_DECK,
  type Deck,
  type Slide,
  type SlideOp,
} from "./slidesScene";

export type SlideClipboard = {
  ownerId: string;
  slides: readonly Slide[];
};

let clipboard: SlideClipboard | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Subscribe to clipboard changes. Returns the unsubscribe function. */
export function subscribeSlideClipboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current clipboard. A stable reference until the next copy or clear. */
export function getSlideClipboardSnapshot(): SlideClipboard | null {
  return clipboard;
}

/**
 * The slides `ownerId` may paste: empty when nothing is copied, when someone
 * else copied it, or when no one is signed in.
 */
export function slidesOnClipboard(
  snapshot: SlideClipboard | null,
  ownerId: string | null | undefined,
): readonly Slide[] {
  if (!snapshot || !ownerId || snapshot.ownerId !== ownerId) return [];
  return snapshot.slides;
}

/**
 * Copy `slides` for `ownerId`, replacing whatever was copied before. Slides are
 * snapshotted, so later edits to the source deck don't change what pastes.
 * Returns how many slides were copied.
 */
export function copySlidesToClipboard(ownerId: string, slides: readonly Slide[]): number {
  if (!ownerId || slides.length === 0) return 0;
  clipboard = {
    ownerId,
    slides: JSON.parse(JSON.stringify(slides)) as Slide[],
  };
  emit();
  return slides.length;
}

/** Forget the copied slides (sign-out, tests). */
export function clearSlideClipboard(): void {
  if (clipboard === null) return;
  clipboard = null;
  emit();
}

export type SlidePastePlan =
  | { ok: true; ops: SlideOp[]; count: number }
  | { ok: false; reason: "empty" | "noRoom" };

/**
 * The op batch that pastes `slides` into `target`, in their copied order,
 * directly after `afterSlideId` (`null` = at the very front, `undefined` = at
 * the end), as ONE batch so a single undo removes the whole paste.
 *
 * Each slide goes in through `addSlide` with its content and
 * `uniqueElementIds`: the engine mints the new slide ids and gives a new id to
 * any element id the deck already uses, so pasting into the deck the slides
 * came from is safe too. Inserting every slide
 * "right after the anchor" lands them in reverse, so anchored pastes are
 * emitted back to front; appends go front to back.
 */
export function planSlidePaste(
  target: Deck,
  slides: readonly Slide[],
  afterSlideId: string | null | undefined,
): SlidePastePlan {
  if (slides.length === 0) return { ok: false, reason: "empty" };
  if (
    slides.length > MAX_OPS_PER_BATCH ||
    target.slides.length + slides.length > MAX_SLIDES_PER_DECK
  ) {
    return { ok: false, reason: "noRoom" };
  }
  const ordered = afterSlideId === undefined ? slides : [...slides].reverse();
  const ops: SlideOp[] = ordered.map((slide) => ({
    op: "addSlide",
    afterSlideId,
    slide,
    uniqueElementIds: true,
  }));
  return { ok: true, ops, count: slides.length };
}
