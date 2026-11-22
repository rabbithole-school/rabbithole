import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSlideClipboard,
  copySlidesToClipboard,
  getSlideClipboardSnapshot,
  planSlidePaste,
  slidesOnClipboard,
  subscribeSlideClipboard,
} from "./slideClipboard";
import {
  MAX_OPS_PER_BATCH,
  MAX_SLIDES_PER_DECK,
  applySlideOps,
  createHistory,
  emptyDeck,
  invertOps,
  makeDeckIdFactory,
  pushHistory,
  redo,
  undo,
  type Deck,
  type SlideOp,
  type TextElement,
} from "./slidesScene";

function applyOk(deck: Deck, ops: SlideOp[]) {
  const r = applySlideOps(deck, ops, makeDeckIdFactory(deck));
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** A deck whose slides each hold one text box saying `label`. */
function deckOf(firstSlideId: string, ...labels: string[]): Deck {
  let deck = emptyDeck("Deck", firstSlideId);
  labels.forEach((text, i) => {
    if (i > 0) deck = applyOk(deck, [{ op: "addSlide" }]).deck;
    const slideId = deck.slides[i].id;
    deck = applyOk(deck, [
      {
        op: "addElement",
        slideId,
        element: { type: "text", frame: { x: 10, y: 10, w: 300, h: 80 }, text },
      },
    ]).deck;
  });
  return deck;
}

function labels(deck: Deck): string[] {
  return deck.slides.map((s) =>
    s.elementIds.map((id) => (s.elements[id] as TextElement).text).join("+"),
  );
}

function allElementIds(deck: Deck): string[] {
  return deck.slides.flatMap((s) => s.elementIds);
}

afterEach(() => clearSlideClipboard());

describe("slide clipboard ownership", () => {
  it("offers copied slides only to the person who copied them", () => {
    copySlidesToClipboard("scholarA", deckOf("s1", "one").slides);
    const snapshot = getSlideClipboardSnapshot();
    expect(slidesOnClipboard(snapshot, "scholarA")).toHaveLength(1);
    expect(slidesOnClipboard(snapshot, "scholarB")).toEqual([]);
    expect(slidesOnClipboard(snapshot, null)).toEqual([]);
    expect(slidesOnClipboard(null, "scholarA")).toEqual([]);
  });

  it("snapshots the slides, so later edits to the source don't change the paste", () => {
    const source = deckOf("s1", "before");
    copySlidesToClipboard("scholarA", source.slides);
    const el = source.slides[0].elements[source.slides[0].elementIds[0]] as TextElement;
    el.text = "after";
    const [copied] = slidesOnClipboard(getSlideClipboardSnapshot(), "scholarA");
    expect((copied.elements[copied.elementIds[0]] as TextElement).text).toBe("before");
  });

  it("notifies subscribers on copy and clear, and keeps a stable snapshot between", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSlideClipboard(listener);
    copySlidesToClipboard("scholarA", deckOf("s1", "one").slides);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSlideClipboardSnapshot()).toBe(getSlideClipboardSnapshot());
    clearSlideClipboard();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSlideClipboardSnapshot()).toBeNull();
    unsubscribe();
    copySlidesToClipboard("scholarA", deckOf("s1", "one").slides);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores an empty copy or a missing owner", () => {
    expect(copySlidesToClipboard("scholarA", [])).toBe(0);
    expect(copySlidesToClipboard("", deckOf("s1", "one").slides)).toBe(0);
    expect(getSlideClipboardSnapshot()).toBeNull();
  });
});

describe("planSlidePaste", () => {
  it("pastes in copied order directly after the anchor slide, as one batch", () => {
    const night1 = deckOf("s1", "question", "background");
    const night4 = deckOf("s1", "table", "graph", "wonder");
    const plan = planSlidePaste(night4, night1.slides, night4.slides[0].id);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.count).toBe(2);
    const pasted = applyOk(night4, plan.ops).deck;
    expect(labels(pasted)).toEqual(["table", "question", "background", "graph", "wonder"]);
  });

  it("pastes at the front with a null anchor and at the end with no anchor", () => {
    const source = deckOf("s1", "a", "b");
    const target = deckOf("s1", "x");
    const front = planSlidePaste(target, source.slides, null);
    const end = planSlidePaste(target, source.slides, undefined);
    if (!front.ok || !end.ok) throw new Error("plan failed");
    expect(labels(applyOk(target, front.ops).deck)).toEqual(["a", "b", "x"]);
    expect(labels(applyOk(target, end.ops).deck)).toEqual(["x", "a", "b"]);
  });

  it("keeps every element id unique when pasting a deck's slides back into itself", () => {
    const deck = deckOf("s1", "one", "two");
    const plan = planSlidePaste(deck, deck.slides, deck.slides[1].id);
    if (!plan.ok) throw new Error(plan.reason);
    const pasted = applyOk(deck, plan.ops).deck;
    expect(labels(pasted)).toEqual(["one", "two", "one", "two"]);
    const ids = allElementIds(pasted);
    expect(new Set(ids).size).toBe(ids.length);
    const slideIds = pasted.slides.map((s) => s.id);
    expect(new Set(slideIds).size).toBe(slideIds.length);
    for (const slide of pasted.slides) {
      for (const id of slide.elementIds) expect(slide.elements[id].id).toBe(id);
    }
  });

  it("re-mints element ids that collide with the target deck, and keeps free ones", () => {
    // Both decks were built the same way, so their element ids collide.
    const source = deckOf("s1", "mine");
    const target = deckOf("s1", "theirs");
    expect(source.slides[0].elementIds).toEqual(target.slides[0].elementIds);
    const plan = planSlidePaste(target, source.slides, target.slides[0].id);
    if (!plan.ok) throw new Error(plan.reason);
    const pasted = applyOk(target, plan.ops).deck;
    const ids = allElementIds(pasted);
    expect(new Set(ids).size).toBe(ids.length);

    const roomy = emptyDeck("Empty", "start");
    const keep = planSlidePaste(roomy, source.slides, "start");
    if (!keep.ok) throw new Error(keep.reason);
    expect(applyOk(roomy, keep.ops).deck.slides[1].elementIds).toEqual(
      source.slides[0].elementIds,
    );
  });

  it("builds the editors' undo and redo for a paste whose ids collide", () => {
    // The editors record every edit with pushHistory, which replays the batch
    // through invertOps. A colliding paste once spun forever right there.
    const source = deckOf("s1", "a", "b");
    const target = deckOf("s1", "x", "y");
    const plan = planSlidePaste(target, source.slides, target.slides[0].id);
    if (!plan.ok) throw new Error(plan.reason);
    const forward = applyOk(target, plan.ops);
    const history = pushHistory(createHistory(), target, plan.ops, forward.createdIds);
    const undoStep = undo(history);
    if (!undoStep) throw new Error("nothing to undo");
    const undone = applyOk(forward.deck, undoStep.ops).deck;
    expect(labels(undone)).toEqual(["x", "y"]);

    // Redo lands the same slides with the same ids the paste first made.
    const redoStep = redo(undoStep.history);
    if (!redoStep) throw new Error("nothing to redo");
    const redone = applyOk(undone, redoStep.ops).deck;
    expect(labels(redone)).toEqual(labels(forward.deck));
    expect(allElementIds(redone)).toEqual(allElementIds(forward.deck));
  });

  it("is undone in one step", () => {
    const source = deckOf("s1", "a", "b", "c");
    const target = deckOf("s1", "x", "y");
    const plan = planSlidePaste(target, source.slides, target.slides[0].id);
    if (!plan.ok) throw new Error(plan.reason);
    const forward = applyOk(target, plan.ops);
    const inverse = invertOps(target, plan.ops, forward.createdIds);
    if (!inverse) throw new Error("no inverse");
    const back = applyOk(forward.deck, inverse).deck;
    expect(labels(back)).toEqual(["x", "y"]);
  });

  it("refuses a paste the deck has no room for, before sending anything", () => {
    const empty = planSlidePaste(deckOf("s1", "x"), [], "s1");
    expect(empty).toEqual({ ok: false, reason: "empty" });

    const big = deckOf("s1", "x");
    const tooMany = Array.from({ length: MAX_OPS_PER_BATCH + 1 }, () => big.slides[0]);
    expect(planSlidePaste(big, tooMany, "s1")).toEqual({ ok: false, reason: "noRoom" });

    let nearlyFull = deckOf("s1", "x");
    while (nearlyFull.slides.length < MAX_SLIDES_PER_DECK - 1) {
      nearlyFull = applyOk(nearlyFull, [{ op: "addSlide" }]).deck;
    }
    const two = deckOf("s1", "a", "b").slides;
    expect(planSlidePaste(nearlyFull, two, "s1")).toEqual({ ok: false, reason: "noRoom" });
    expect(planSlidePaste(nearlyFull, two.slice(0, 1), "s1").ok).toBe(true);
  });
});
