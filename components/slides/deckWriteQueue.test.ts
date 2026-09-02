import { describe, it, expect } from "vitest";
import { reconcileDeckWrite, titleEditBase } from "./deckWriteQueue";
import {
  applySlideOps,
  emptyDeck,
  makeDeckIdFactory,
  MAX_REVISION,
  type Deck,
} from "@/shared/slidesScene";

const apply = (deck: Deck, ops: Parameters<typeof applySlideOps>[1]): Deck => {
  const result = applySlideOps(deck, ops, makeDeckIdFactory(deck));
  if (!result.ok) throw new Error(result.error);
  return result.deck;
};

const rename = (deck: Deck, title: string) =>
  apply(deck, [{ op: "setTitle", title }]);

const addSlide = (deck: Deck) => apply(deck, [{ op: "addSlide" }]);

describe("reconcileDeckWrite", () => {
  it("leaves a coherent write untouched", () => {
    const base = emptyDeck("Deck", "sl1");
    const next = addSlide(base);
    expect(
      reconcileDeckWrite(next, { lastQueued: base, pendingTitle: null }),
    ).toBe(next);
  });

  // The reported bug: rename, then a slide edit computed from the pre-rename
  // deck. The deck is saved whole, so writing it verbatim un-renames it.
  it("keeps a committed title when a later write was computed before it", () => {
    const base = emptyDeck("New activity", "sl1");
    const renamed = rename(base, "Tide pools");
    const staleSlideEdit = addSlide(base); // still titled "New activity"

    const queued = reconcileDeckWrite(staleSlideEdit, {
      lastQueued: renamed,
      pendingTitle: "Tide pools",
    });

    expect(queued.title).toBe("Tide pools");
    expect(queued.slides).toHaveLength(staleSlideEdit.slides.length);
  });

  it("stops forcing the title once the rename has landed", () => {
    const base = emptyDeck("New activity", "sl1");
    const renamed = rename(base, "Tide pools");
    // pendingTitle cleared by the accepted save; the bot then renames it.
    const botRename = rename(renamed, "Tide pools, revised");

    const queued = reconcileDeckWrite(botRename, {
      lastQueued: renamed,
      pendingTitle: null,
    });

    expect(queued.title).toBe("Tide pools, revised");
  });

  it("bumps a reused revision so queued writes strictly increase", () => {
    const base = emptyDeck("Deck", "sl1");
    const renamed = rename(base, "Renamed"); // revision +1
    const staleSlideEdit = addSlide(base); // ALSO revision +1

    expect(staleSlideEdit.revision).toBe(renamed.revision);

    const queued = reconcileDeckWrite(staleSlideEdit, {
      lastQueued: renamed,
      pendingTitle: "Renamed",
    });

    expect(queued.revision).toBe(renamed.revision + 1);
  });

  it("does not rewrite a revision that is already ahead", () => {
    const base = emptyDeck("Deck", "sl1");
    const queuedDeck = addSlide(base);
    const next = addSlide(addSlide(queuedDeck));

    const queued = reconcileDeckWrite(next, {
      lastQueued: queuedDeck,
      pendingTitle: null,
    });

    expect(queued.revision).toBe(next.revision);
  });

  it("wraps the bumped revision like applySlideOps does", () => {
    const base: Deck = { ...emptyDeck("Deck", "sl1"), revision: MAX_REVISION - 1 };
    const next: Deck = { ...base, revision: MAX_REVISION - 1 };

    const queued = reconcileDeckWrite(next, {
      lastQueued: base,
      pendingTitle: null,
    });

    expect(queued.revision).toBe(0);
  });

  it("survives the full reported sequence: rename, stale slide edit, second rename", () => {
    const server = emptyDeck("New activity", "sl1");
    const state = { lastQueued: null as Deck | null, pendingTitle: null as string | null };

    // 1. Teacher renames.
    const renamed = rename(server, "Tide pools");
    state.pendingTitle = "Tide pools";
    state.lastQueued = reconcileDeckWrite(renamed, state);

    // 2. Toolbar click whose op was computed from the pre-rename deck.
    state.lastQueued = reconcileDeckWrite(addSlide(server), state);
    expect(state.lastQueued.title).toBe("Tide pools");

    // 3. Another stale-based edit, still before the save lands.
    state.lastQueued = reconcileDeckWrite(addSlide(server), state);
    expect(state.lastQueued.title).toBe("Tide pools");

    // Every queued revision was distinct and increasing.
    expect(state.lastQueued.revision).toBe(renamed.revision + 2);
  });
});

describe("titleEditBase", () => {
  it("prefers a queued deck the render hasn't caught up to", () => {
    const rendered = emptyDeck("Deck", "sl1");
    const queued = addSlide(rendered);
    expect(titleEditBase(rendered, queued)).toBe(queued);
  });

  it("prefers the rendered deck when the server has moved ahead", () => {
    const queued = emptyDeck("Deck", "sl1");
    const rendered = addSlide(queued);
    expect(titleEditBase(rendered, queued)).toBe(rendered);
  });

  it("handles either side being absent", () => {
    const deck = emptyDeck("Deck", "sl1");
    expect(titleEditBase(null, deck)).toBe(deck);
    expect(titleEditBase(deck, null)).toBe(deck);
    expect(titleEditBase(null, null)).toBeNull();
  });

  // Renaming the deck we rendered with would drop a slide edit emitted in the
  // same tick, because a deck is saved whole.
  it("keeps a same-tick slide edit when the title is committed right after it", () => {
    const rendered = emptyDeck("New activity", "sl1");
    const queued = addSlide(rendered);

    const base = titleEditBase(rendered, queued)!;
    const renamed = rename(base, "Tide pools");

    expect(renamed.title).toBe("Tide pools");
    expect(renamed.slides).toHaveLength(queued.slides.length);
  });
});
