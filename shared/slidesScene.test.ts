import { describe, expect, it } from "vitest";

import {
  CANVAS_H,
  CANVAS_W,
  MAX_OPS_PER_BATCH,
  MIN_ELEMENT_SIZE,
  applySlideOps,
  emptyDeck,
  isBlankSlideText,
  NEW_ELEMENT_PRESETS,
  nextInsertFrame,
  normalizeElement,
  normalizeFrame,
  PLACEHOLDER_CASCADE_STEP,
  summarizeDeckForModel,
  textCommitOps,
  validateDeck,
  validateDeckLenient,
  makeDeckIdFactory,
  invertOps,
  createHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  DEFAULT_HISTORY_LIMIT,
  type Deck,
  type SlideOp,
} from "./slidesScene";

/** Deterministic ids so assertions can name them. */
function idFactory() {
  let n = 0;
  return () => `gen${++n}`;
}

function deckWith(...elements: unknown[]): Deck {
  const d = emptyDeck("Test", "s1");
  const r = applySlideOps(
    d,
    elements.map((element) => ({ op: "addElement", slideId: "s1", element }) as SlideOp),
    idFactory(),
  );
  if (!r.ok) throw new Error(r.error);
  return r.deck;
}

const TEXT = { type: "text", frame: { x: 10, y: 20, w: 200, h: 80 }, text: "hi" };
const RECT = { type: "rect", frame: { x: 0, y: 0, w: 100, h: 100, rotation: 30 } };

describe("emptyDeck", () => {
  it("uses the product-wide untitled name for blank titles", () => {
    expect(emptyDeck("   ", "s1").title).toBe("Untitled slides");
  });
});

describe("nextInsertFrame", () => {
  const preset = NEW_ELEMENT_PRESETS.rect().frame;

  it("uses the preset frame on an empty slide", () => {
    expect(nextInsertFrame(emptyDeck("D", "s1").slides[0], preset)).toEqual(preset);
  });

  it("cascades past a slot an element already occupies", () => {
    const deck = deckWith({ ...RECT, frame: { ...preset } });
    expect(nextInsertFrame(deck.slides[0], preset)).toMatchObject({
      x: preset.x + PLACEHOLDER_CASCADE_STEP,
      y: preset.y + PLACEHOLDER_CASCADE_STEP,
      w: preset.w,
      h: preset.h,
    });
  });

  it("skips only the slots that are taken, of any element type", () => {
    // A text box sitting on slot 0 blocks it for a rectangle too — what matters
    // is that the new element is visibly separate, not what kind it is.
    const deck = deckWith(
      { ...TEXT, frame: { ...preset } },
      { ...RECT, frame: { ...preset, x: preset.x + 2 * PLACEHOLDER_CASCADE_STEP, y: preset.y + 2 * PLACEHOLDER_CASCADE_STEP } },
    );
    expect(nextInsertFrame(deck.slides[0], preset)).toMatchObject({
      x: preset.x + PLACEHOLDER_CASCADE_STEP,
      y: preset.y + PLACEHOLDER_CASCADE_STEP,
    });
  });

  it("clamps inside the canvas rather than marching off the edge", () => {
    const corner = { x: CANVAS_W - preset.w, y: CANVAS_H - preset.h };
    const deck = deckWith({ ...RECT, frame: { ...preset, ...corner } });
    // Every slot from the clamped corner onward is the same point, so a taken
    // corner terminates the search there instead of looping forever.
    const frame = nextInsertFrame(deck.slides[0], { ...preset, ...corner });
    expect(frame).toMatchObject(corner);
    expect(frame.x + frame.w).toBeLessThanOrEqual(CANVAS_W);
    expect(frame.y + frame.h).toBeLessThanOrEqual(CANVAS_H);
  });
});

describe("textCommitOps", () => {
  it("patches a box that has words in it", () => {
    expect(textCommitOps("s1", "el1", "Volcanoes")).toEqual([
      { op: "patchElement", slideId: "s1", id: "el1", text: "Volcanoes" },
    ]);
  });

  it.each(["", "   ", "\n\t "])(
    "removes a box committed with only whitespace (%j)",
    (text) => {
      expect(textCommitOps("s1", "el1", text)).toEqual([
        { op: "removeElement", slideId: "s1", id: "el1" },
      ]);
      expect(isBlankSlideText(text)).toBe(true);
    },
  );

  it("is invertible, so removing a blank box is undoable", () => {
    const deck = deckWith(TEXT);
    const id = deck.slides[0].elementIds[0];
    const inverse = invertOps(deck, textCommitOps("s1", id, "  "), []);
    expect(inverse?.[0]).toMatchObject({ op: "addElement", slideId: "s1", id });
  });
});

describe("normalizeFrame", () => {
  it("pins rotation to 0 for text — the v1 axis-aligned-text rule", () => {
    expect(normalizeFrame({ x: 0, y: 0, w: 100, h: 50, rotation: 45 }, true).rotation).toBe(0);
  });

  it("wraps rotation into [0,360) for non-text", () => {
    expect(normalizeFrame({ x: 0, y: 0, w: 10, h: 10, rotation: -12 }, false).rotation).toBe(348);
    expect(normalizeFrame({ x: 0, y: 0, w: 10, h: 10, rotation: 380 }, false).rotation).toBe(20);
  });

  it("clamps sub-minimum and non-finite sizes rather than rejecting", () => {
    const f = normalizeFrame({ x: NaN, y: 5, w: 1, h: Infinity }, false);
    expect(f.w).toBe(MIN_ELEMENT_SIZE);
    expect(f.x).toBe(0);
    expect(Number.isFinite(f.h)).toBe(true);
  });
});

describe("normalizeElement", () => {
  it("rejects media with no assetId — it would render as a hole", () => {
    expect(normalizeElement({ type: "image", frame: {}, assetId: "  " }, "e1")).toBeNull();
    expect(normalizeElement({ type: "video", frame: {}, assetId: "" }, "e1")).toBeNull();
  });

  it("rejects an unknown type", () => {
    expect(normalizeElement({ type: "audio", frame: {} }, "e1")).toBeNull();
  });

  it("normalizes a video as a referenced media element", () => {
    expect(normalizeElement(
      { type: "video", frame: { x: 10, y: 20, w: 640, h: 480 }, assetId: "vid123" },
      "e1",
    )).toMatchObject({
      id: "e1",
      type: "video",
      assetId: "vid123",
      alt: "",
      frame: { rotation: 0 },
    });
  });

  it("falls back to defaults for a malformed style instead of failing", () => {
    const el = normalizeElement(
      { type: "text", frame: {}, text: "x", style: { color: "not-a-color", fontSize: 9999 } },
      "e1",
    );
    expect(el?.type).toBe("text");
    if (el?.type !== "text") throw new Error("expected text");
    expect(el.style.color).toBe("#222656");
    expect(el.style.fontSize).toBe(200);
  });

  it("gives a line a visible stroke rather than a fill", () => {
    const el = normalizeElement({ type: "line", frame: {} }, "e1");
    if (el?.type !== "line") throw new Error("expected line");
    expect(el.style.fill).toBeNull();
    expect(el.style.stroke).not.toBeNull();
    expect(el.style.strokeWidth).toBeGreaterThan(0);
  });

  it("truncates absurd text rather than storing it", () => {
    const el = normalizeElement({ type: "text", frame: {}, text: "a".repeat(99999) }, "e1");
    if (el?.type !== "text") throw new Error("expected text");
    expect(el.text.length).toBeLessThanOrEqual(4000);
  });
});

describe("validateDeck", () => {
  it("accepts legacy slides without speaker notes and preserves optional notes", () => {
    const legacy = validateDeck({
      title: "Legacy deck",
      slides: [{ id: "legacy", elementIds: [], elements: {} }],
    });
    if (!legacy.ok) throw new Error(legacy.errors.join(","));
    expect(legacy.deck.slides[0].speakerNotes).toBeUndefined();

    const withNotes = validateDeck({
      title: "Notes deck",
      slides: [{
        id: "notes",
        elementIds: [],
        elements: {},
        speakerNotes: "Pause for responses before advancing.",
      }],
    });
    if (!withNotes.ok) throw new Error(withNotes.errors.join(","));
    expect(withNotes.deck.slides[0].speakerNotes).toBe(
      "Pause for responses before advancing.",
    );
  });

  it("rejects a deck with no slides", () => {
    expect(validateDeck({ slides: [] }).ok).toBe(false);
    expect(validateDeck(null).ok).toBe(false);
  });

  it("treats elementIds as the z-order and appends orphaned elements", () => {
    const r = validateDeck({
      title: "T",
      slides: [
        {
          id: "s1",
          elementIds: ["b"],
          elements: {
            a: { type: "text", frame: {}, text: "a" },
            b: { type: "text", frame: {}, text: "b" },
          },
        },
      ],
    });
    if (!r.ok) throw new Error(r.errors.join(","));
    // "b" was ordered; "a" was present but unordered, so it lands on top.
    expect(r.deck.slides[0].elementIds).toEqual(["b", "a"]);
  });

  it("REFUSES a write whose content it had to drop", () => {
    // Returning ok:true here let aiCreateSlidesDeck persist a silently
    // truncated deck and report success to the caller.
    const r = validateDeck({
      slides: [
        {
          id: "s1",
          elementIds: ["good", "bad"],
          elements: {
            good: { type: "text", frame: {}, text: "ok" },
            bad: { type: "image", frame: {} },
          },
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("still SALVAGES the same deck for reading", () => {
    const deck = validateDeckLenient({
      slides: [
        {
          id: "s1",
          elementIds: ["good", "bad"],
          elements: {
            good: { type: "text", frame: {}, text: "ok" },
            bad: { type: "image", frame: {} },
          },
        },
      ],
    });
    // A mostly-good deck on screen beats an error page for a kid.
    expect(deck?.slides[0].elementIds).toEqual(["good"]);
  });

  it("drops a reserved element id instead of losing it silently to the prototype", () => {
    // A `__proto__` key on a normal object literal hits the legacy setter, so
    // the element survived elementIds but vanished from JSON.stringify.
    const deck = validateDeckLenient({
      slides: [
        {
          id: "s1",
          elementIds: ["__proto__", "ok"],
          elements: {
            __proto__: { type: "text", frame: {}, text: "evil" },
            ok: { type: "text", frame: {}, text: "fine" },
          },
        },
      ],
    });
    expect(deck?.slides[0].elementIds).toEqual(["ok"]);
    const round = JSON.parse(JSON.stringify(deck));
    expect(Object.keys(round.slides[0].elements)).toEqual(["ok"]);
  });

  it("de-duplicates elementIds so nothing renders or exports twice", () => {
    const deck = validateDeckLenient({
      slides: [
        {
          id: "s1",
          elementIds: ["a", "a"],
          elements: { a: { type: "text", frame: {}, text: "once" } },
        },
      ],
    });
    expect(deck?.slides[0].elementIds).toEqual(["a"]);
  });

  it("always normalizes the canvas to the fixed logical size", () => {
    const r = validateDeck({ width: 999, height: 5, slides: [{ id: "s1" }] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.deck.width).toBe(CANVAS_W);
    expect(r.deck.height).toBe(CANVAS_H);
  });
});

describe("id pinning (the undo door)", () => {
  it("honours a canonical, free id so undo can restore an element in place", () => {
    const r = applySlideOps(
      emptyDeck("D", "sl1"),
      [{ op: "addElement", slideId: "sl1", id: "el7", element: TEXT }] as SlideOp[],
      makeDeckIdFactory(emptyDeck("D", "sl1")),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.createdIds).toEqual(["el7"]);
  });

  it("MINTS instead when the pinned id is not syntactically safe", () => {
    // Shape is not the guard — `emptyDeck` takes a caller-supplied slide id, so
    // undo must be able to restore ids we did not mint. What must never get
    // through is a prototype key or anything that could collide.
    for (const bad of ["__proto__", "constructor", "has space", "a/b", "", "x".repeat(65)]) {
      const base = emptyDeck("D", "sl1");
      const r = applySlideOps(
        base,
        [{ op: "addElement", slideId: "sl1", id: bad, element: TEXT }] as SlideOp[],
        makeDeckIdFactory(base),
      );
      if (!r.ok) throw new Error(r.error);
      expect(r.createdIds[0]).toMatch(/^el[1-9][0-9]*$/);
      expect(r.createdIds[0]).not.toBe(bad);
    }
  });

  it("MINTS instead when the pinned id is already taken", () => {
    const base = deckWith(TEXT);
    const existing = base.slides[0].elementIds[0];
    const r = applySlideOps(
      base,
      [{ op: "addElement", slideId: "s1", id: existing, element: RECT }] as SlideOp[],
      makeDeckIdFactory(base),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.createdIds[0]).not.toBe(existing);
    expect(base.slides[0].elements[existing].type).toBe("text");
  });
});

describe("applySlideOps", () => {
  it("adds an element and returns its minted id", () => {
    const r = applySlideOps(
      emptyDeck("D", "s1"),
      [{ op: "addElement", slideId: "s1", element: TEXT }],
      idFactory(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.createdIds).toEqual(["gen1"]);
    expect(r.deck.slides[0].elementIds).toEqual(["gen1"]);
  });

  it("bumps revision exactly once per batch, not once per op", () => {
    const d = emptyDeck("D", "s1");
    const r = applySlideOps(
      d,
      [
        { op: "addElement", slideId: "s1", element: TEXT },
        { op: "addElement", slideId: "s1", element: RECT },
        { op: "setTitle", title: "New" },
      ],
      idFactory(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.deck.revision).toBe(d.revision + 1);
  });

  it("is all-or-nothing: a bad op leaves the input deck untouched", () => {
    const d = deckWith(TEXT);
    const before = JSON.stringify(d);
    const r = applySlideOps(
      d,
      [
        { op: "addElement", slideId: "s1", element: RECT },
        { op: "removeElement", slideId: "s1", id: "nope" },
      ],
      idFactory(),
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("keeps id and type fixed even when the patch payload carries them", () => {
    const d = deckWith(TEXT);
    const id = d.slides[0].elementIds[0];
    const r = applySlideOps(
      d,
      [
        {
          op: "patchElement",
          slideId: "s1",
          id,
          // A model could plausibly echo type/id back inside the style bag.
          // The merge forces `type: cur.type` and re-normalizes under the
          // ORIGINAL id, so neither can be repointed.
          style: { type: "rect", id: "hacked", color: "#000000" },
        } as SlideOp,
      ],
      idFactory(),
    );
    if (!r.ok) throw new Error(r.error);
    const el = r.deck.slides[0].elements[id];
    expect(el.id).toBe(id);
    expect(el.type).toBe("text");
    expect(r.deck.slides[0].elements.hacked).toBeUndefined();
  });

  it("re-normalizes a patched frame, so text cannot be rotated via patch", () => {
    const d = deckWith(TEXT);
    const id = d.slides[0].elementIds[0];
    const r = applySlideOps(
      d,
      [{ op: "patchElement", slideId: "s1", id, frame: { rotation: 90 } }],
      idFactory(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.deck.slides[0].elements[id].frame.rotation).toBe(0);
  });

  it("merges a partial frame patch onto the current geometry", () => {
    const d = deckWith(TEXT);
    const id = d.slides[0].elementIds[0];
    const r = applySlideOps(
      d,
      [{ op: "patchElement", slideId: "s1", id, frame: { x: 500 } }],
      idFactory(),
    );
    if (!r.ok) throw new Error(r.error);
    const f = r.deck.slides[0].elements[id].frame;
    expect(f.x).toBe(500);
    expect(f.y).toBe(20); // untouched
    expect(f.w).toBe(200);
  });

  it("moveElement with afterId=null sends it to the back", () => {
    const d = deckWith(TEXT, RECT);
    const [first, second] = d.slides[0].elementIds;
    const r = applySlideOps(
      d,
      [{ op: "moveElement", slideId: "s1", id: second, afterId: null }],
      idFactory(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.deck.slides[0].elementIds).toEqual([second, first]);
  });

  it.each([
    ["omitted", { op: "moveElement", slideId: "s1", id: "gen1" } as SlideOp],
    ["explicitly undefined", { op: "moveElement", slideId: "s1", id: "gen1", afterId: undefined } as SlideOp],
  ])("moveElement with afterId %s sends it to the front/top", (_label, op) => {
    const d = deckWith(TEXT, RECT, RECT);
    const [first, second, third] = d.slides[0].elementIds;
    const r = applySlideOps(d, [op], idFactory());
    if (!r.ok) throw new Error(r.error);
    expect(r.deck.slides[0].elementIds).toEqual([second, third, first]);
  });

  it("keeps elements and elementIds consistent on remove", () => {
    const d = deckWith(TEXT, RECT);
    const [first] = d.slides[0].elementIds;
    const r = applySlideOps(
      d,
      [{ op: "removeElement", slideId: "s1", id: first }],
      idFactory(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.deck.slides[0].elementIds).not.toContain(first);
    expect(r.deck.slides[0].elements[first]).toBeUndefined();
  });

  it("refuses to remove the last slide", () => {
    const r = applySlideOps(
      emptyDeck("D", "s1"),
      [{ op: "removeSlide", slideId: "s1" }],
      idFactory(),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects unknown slide, element, and afterId targets by name", () => {
    const d = deckWith(TEXT);
    for (const op of [
      { op: "addElement", slideId: "nope", element: TEXT },
      { op: "removeElement", slideId: "s1", id: "nope" },
      { op: "addElement", slideId: "s1", element: TEXT, afterId: "nope" },
    ] as SlideOp[]) {
      const r = applySlideOps(d, [op], idFactory());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("nope");
    }
  });

  it("rejects an oversized batch and an empty one", () => {
    const d = emptyDeck("D", "s1");
    const many = Array.from({ length: MAX_OPS_PER_BATCH + 1 }, () => ({
      op: "setTitle" as const,
      title: "x",
    }));
    expect(applySlideOps(d, many, idFactory()).ok).toBe(false);
    expect(applySlideOps(d, [], idFactory()).ok).toBe(false);
  });

  it("rejects an unknown operation instead of silently ignoring it", () => {
    const r = applySlideOps(
      emptyDeck("D", "s1"),
      [{ op: "explode" } as unknown as SlideOp],
      idFactory(),
    );
    expect(r.ok).toBe(false);
  });
});

describe("summarizeDeckForModel", () => {
  it("addresses every element by the id the model must patch", () => {
    const d = deckWith(
      {
        ...TEXT,
        style: { fontSize: 52, bold: true, italic: true },
      },
      RECT,
    );
    const out = summarizeDeckForModel(d);
    for (const id of d.slides[0].elementIds) expect(out).toContain(id);
    expect(out).toContain("revision 1");
    expect(out).toContain("fontSize=52 bold=true italic=true");
  });

  it("marks an empty slide rather than emitting a bare heading", () => {
    expect(summarizeDeckForModel(emptyDeck("D", "s1"))).toContain("(empty)");
  });

  it("normalizes media alt text and speaker-note whitespace before truncation", () => {
    const d = deckWith({
      type: "image",
      frame: { x: 0, y: 0, w: 100, h: 100 },
      assetId: "asset-1",
      alt: `${"a".repeat(35)}\n \t \nkept`,
    });
    d.slides[0].speakerNotes = `${"n".repeat(110)}\n\n\n\n\n\n\n\n\n\nkept`;

    const out = summarizeDeckForModel(d);

    expect(out).toContain(`alt="${"a".repeat(35)} kept"`);
    expect(out).toContain(`notes: ${"n".repeat(110)} kept`);
    expect(out.split("\n")).toHaveLength(5);
  });

  it("keeps image alt text beyond the old 40-character cap", () => {
    const alt = "A labeled cutaway diagram showing magma rising through a volcanic vent.";
    const out = summarizeDeckForModel(
      deckWith({
        type: "image",
        frame: { x: 0, y: 0, w: 100, h: 100 },
        assetId: "asset-1",
        alt,
      }),
    );
    expect(out).toContain(`alt="${alt}"`);
  });

  it("flags overlapping duplicate text boxes but not distinct adjacent boxes", () => {
    const duplicate = {
      type: "text",
      frame: { x: 100, y: 100, w: 300, h: 80 },
      text: "Same   teaching point",
      style: { fontSize: 36 },
    };
    const overlapping = {
      ...duplicate,
      frame: { x: 101, y: 101, w: 300, h: 80 },
      text: "Same teaching point",
    };
    const adjacent = {
      ...duplicate,
      frame: { x: 400, y: 100, w: 300, h: 80 },
    };

    expect(summarizeDeckForModel(deckWith(duplicate, overlapping))).toContain(
      "1 duplicate box pair",
    );
    expect(summarizeDeckForModel(deckWith(duplicate, adjacent))).toContain(
      "no duplicate boxes",
    );
  });

  it("flags a partial-copy box overlapping its original, but not a short label inside a paragraph", () => {
    // The prod incident's defect: a stray box holding a strict substring of the
    // box under it. Containment counts for substantial text...
    const original = {
      type: "text",
      frame: { x: 100, y: 100, w: 400, h: 120 },
      text: "Look-alike: Realistic fiction\nHow it is different: Humor has lots of laughs",
      style: { fontSize: 28 },
    };
    const partialCopy = {
      ...original,
      frame: { x: 102, y: 130, w: 320, h: 75 },
      text: "How it is different: Humor has lots of laughs",
    };
    expect(summarizeDeckForModel(deckWith(original, partialCopy))).toContain(
      "1 duplicate box pair",
    );

    // ...but a short label overlapping a paragraph that mentions it is layout,
    // not duplication.
    const label = {
      type: "text",
      frame: { x: 110, y: 110, w: 90, h: 40 },
      text: "Humor",
      style: { fontSize: 28 },
    };
    expect(summarizeDeckForModel(deckWith(original, label))).toContain(
      "no duplicate boxes",
    );
  });

  it("flags stacked shapes and images, not just stacked text", () => {
    // Only text was scanned before, so a pile of rectangles was invisible to
    // `read_deck` — the model could not see the very stack it was asked about.
    const rect = { type: "rect", frame: { x: 200, y: 200, w: 300, h: 200 } };
    expect(
      summarizeDeckForModel(deckWith(rect, { ...rect, frame: { x: 201, y: 200, w: 300, h: 200 } })),
    ).toContain("1 duplicate box pair");

    const image = {
      type: "image",
      frame: { x: 100, y: 100, w: 400, h: 300 },
      assetId: "asset-1",
      alt: "A volcano",
    };
    expect(summarizeDeckForModel(deckWith(image, { ...image, assetId: "asset-2" }))).toContain(
      "1 duplicate box pair",
    );
  });

  it("leaves shapes of different kinds, sizes, or positions alone", () => {
    const rect = { type: "rect", frame: { x: 200, y: 200, w: 300, h: 200 } };
    // Same frame, different kind: a rectangle behind an ellipse is composition.
    expect(
      summarizeDeckForModel(deckWith(rect, { ...rect, type: "ellipse" })),
    ).toContain("no duplicate boxes");
    // Same kind, overlapping but plainly a different box.
    expect(
      summarizeDeckForModel(deckWith(rect, { ...rect, frame: { x: 240, y: 200, w: 300, h: 200 } })),
    ).toContain("no duplicate boxes");
  });
});

// ─── Undo / redo ─────────────────────────────────────────────────────────

/** Apply with the canonical factory, throwing on failure. */
function applyOk(deck: Deck, ops: SlideOp[]): { deck: Deck; createdIds: string[] } {
  const r = applySlideOps(deck, ops, makeDeckIdFactory(deck));
  if (!r.ok) throw new Error(r.error);
  return { deck: r.deck, createdIds: r.createdIds };
}

/** Revision is server-owned and intentionally NOT restored by an inverse (it
 *  keeps climbing across undo/redo), so equality is asserted modulo revision. */
function sansRev(deck: Deck): Deck {
  return { ...deck, revision: 0 };
}

/** The core property: apply → invert → apply restores the deck exactly (every
 *  field but revision — including z-order and ids). */
function expectInverts(before: Deck, ops: SlideOp[]): void {
  const fwd = applySlideOps(before, ops, makeDeckIdFactory(before));
  if (!fwd.ok) throw new Error(`forward failed: ${fwd.error}`);
  const inv = invertOps(before, ops, fwd.createdIds);
  if (inv === null) throw new Error("invertOps returned null");
  const back = applySlideOps(fwd.deck, inv, makeDeckIdFactory(fwd.deck));
  if (!back.ok) throw new Error(`inverse failed: ${back.error}`);
  expect(sansRev(back.deck)).toEqual(sansRev(before));
}

/** A two-slide deck: slide "s1" has three ordered elements; slide "sl1" has an
 *  image plus a background and speaker notes — enough to exercise every op. */
function richDeck(): Deck {
  let d = emptyDeck("Deck", "s1");
  d = applyOk(d, [
    { op: "addElement", slideId: "s1", element: TEXT },
    { op: "addElement", slideId: "s1", element: RECT },
    { op: "addElement", slideId: "s1", element: { type: "ellipse", frame: { x: 100, y: 90, w: 120, h: 90 } } },
    { op: "addSlide", afterSlideId: "s1" },
  ]).deck;
  const s2 = d.slides[1].id;
  d = applyOk(d, [
    { op: "addElement", slideId: s2, element: { type: "image", frame: { x: 200, y: 120, w: 400, h: 300 }, assetId: "asset123", alt: "a picture" } },
    { op: "setBackground", slideId: s2, color: "#abcdef" },
    { op: "setSpeakerNotes", slideId: s2, notes: "say this out loud" },
  ]).deck;
  return d;
}

describe("invertOps — one representative op of every kind round-trips", () => {
  it("addElement (append)", () => {
    expectInverts(richDeck(), [{ op: "addElement", slideId: "s1", element: TEXT }]);
  });

  it("addElement (afterId — inserted mid-stack)", () => {
    const d = richDeck();
    const mid = d.slides[0].elementIds[0];
    expectInverts(d, [{ op: "addElement", slideId: "s1", afterId: mid, element: RECT }]);
  });

  it("addElement (afterId: null — inserted at the back)", () => {
    expectInverts(richDeck(), [{ op: "addElement", slideId: "s1", afterId: null, element: RECT }]);
  });

  it("removeElement (mid-stack — restores its z-index)", () => {
    const d = richDeck();
    const mid = d.slides[0].elementIds[1];
    expectInverts(d, [{ op: "removeElement", slideId: "s1", id: mid }]);
  });

  it("removeElement (back — index 0)", () => {
    const d = richDeck();
    const back = d.slides[0].elementIds[0];
    expectInverts(d, [{ op: "removeElement", slideId: "s1", id: back }]);
  });

  it("removeElement (front — top of stack)", () => {
    const d = richDeck();
    const front = d.slides[0].elementIds.at(-1)!;
    expectInverts(d, [{ op: "removeElement", slideId: "s1", id: front }]);
  });

  it("removeElement (an image — restores assetId and alt)", () => {
    const d = richDeck();
    const img = d.slides[1].elementIds[0];
    expectInverts(d, [{ op: "removeElement", slideId: d.slides[1].id, id: img }]);
  });

  it("patchElement (frame only)", () => {
    const d = richDeck();
    const id = d.slides[0].elementIds[0];
    expectInverts(d, [{ op: "patchElement", slideId: "s1", id, frame: { x: 640, y: 400 } }]);
  });

  it("patchElement (text + style on a text element)", () => {
    const d = richDeck();
    const id = d.slides[0].elementIds[0];
    expectInverts(d, [
      { op: "patchElement", slideId: "s1", id, text: "changed", style: { bold: true, color: "#010203" } },
    ]);
  });

  it("patchElement (style on a shape)", () => {
    const d = richDeck();
    const id = d.slides[0].elementIds[1];
    expectInverts(d, [{ op: "patchElement", slideId: "s1", id, style: { fill: "#00ff00" } }]);
  });

  it("patchElement (frame on an image — no text/style to restore)", () => {
    const d = richDeck();
    const img = d.slides[1].elementIds[0];
    expectInverts(d, [{ op: "patchElement", slideId: d.slides[1].id, id: img, frame: { x: 300, w: 500 } }]);
  });

  it("moveElement (to the back via afterId: null)", () => {
    const d = richDeck();
    const top = d.slides[0].elementIds.at(-1)!;
    expectInverts(d, [{ op: "moveElement", slideId: "s1", id: top, afterId: null }]);
  });

  it("moveElement (to a mid position)", () => {
    const d = richDeck();
    const [first, , third] = d.slides[0].elementIds;
    expectInverts(d, [{ op: "moveElement", slideId: "s1", id: third, afterId: first }]);
  });

  it("addSlide (append)", () => {
    expectInverts(richDeck(), [{ op: "addSlide", afterSlideId: "s1" }]);
  });

  it("addSlide (afterSlideId: null — at the front)", () => {
    expectInverts(richDeck(), [{ op: "addSlide", afterSlideId: null }]);
  });

  it("removeSlide (mid/last — restores position and full content)", () => {
    const d = richDeck();
    expectInverts(d, [{ op: "removeSlide", slideId: d.slides[1].id }]);
  });

  it("removeSlide (front — index 0)", () => {
    expectInverts(richDeck(), [{ op: "removeSlide", slideId: "s1" }]);
  });

  it("setBackground", () => {
    expectInverts(richDeck(), [{ op: "setBackground", slideId: "s1", color: "#101010" }]);
  });

  it("setSpeakerNotes (set on a slide that had none — undo drops the key)", () => {
    expectInverts(richDeck(), [{ op: "setSpeakerNotes", slideId: "s1", notes: "brand new note" }]);
  });

  it("setSpeakerNotes (clear a slide that had notes — undo restores them)", () => {
    const d = richDeck();
    expectInverts(d, [{ op: "setSpeakerNotes", slideId: d.slides[1].id, notes: "" }]);
  });

  it("setTitle", () => {
    expectInverts(richDeck(), [{ op: "setTitle", title: "A New Title" }]);
  });

  it("a mixed multi-op batch round-trips as a whole", () => {
    const d = richDeck();
    const [e1, e2, e3] = d.slides[0].elementIds;
    expectInverts(d, [
      { op: "setTitle", title: "Renamed" },
      { op: "setBackground", slideId: "s1", color: "#222222" },
      { op: "addElement", slideId: "s1", element: RECT },
      { op: "patchElement", slideId: "s1", id: e1, frame: { x: 800 }, text: "edited" },
      { op: "moveElement", slideId: "s1", id: e2, afterId: null },
      { op: "removeElement", slideId: "s1", id: e3 },
    ]);
  });
});

describe("invertOps — exactness and refusal", () => {
  it("restores a removed element under the SAME id at the SAME z-index", () => {
    const d = richDeck();
    const order = d.slides[0].elementIds; // [e1, e2, e3]
    const target = order[1];
    const ops: SlideOp[] = [{ op: "removeElement", slideId: "s1", id: target }];
    const fwd = applyOk(d, ops);
    expect(fwd.deck.slides[0].elements[target]).toBeUndefined();
    const inv = invertOps(d, ops, fwd.createdIds)!;
    const back = applyOk(fwd.deck, inv);
    // exact id, exact position, exact element.
    expect(back.deck.slides[0].elementIds).toEqual(order);
    expect(back.deck.slides[0].elements[target]).toEqual(d.slides[0].elements[target]);
  });

  it("restores a removed slide with content at its original index", () => {
    const d = richDeck();
    const removed = d.slides[1];
    const ops: SlideOp[] = [{ op: "removeSlide", slideId: removed.id }];
    const fwd = applyOk(d, ops);
    expect(fwd.deck.slides.length).toBe(1);
    const inv = invertOps(d, ops, fwd.createdIds)!;
    const back = applyOk(fwd.deck, inv);
    expect(back.deck.slides.map((s) => s.id)).toEqual(["s1", removed.id]);
    expect(sansRev(back.deck)).toEqual(sansRev(d));
  });

  it("returns null when createdIds don't line up with the add-ops", () => {
    const d = richDeck();
    // An addElement needs its minted id; an empty createdIds cannot name it.
    expect(invertOps(d, [{ op: "addElement", slideId: "s1", element: TEXT }], [])).toBeNull();
  });

  it("returns null for a batch that does not cleanly replay against the deck", () => {
    const d = richDeck();
    expect(invertOps(d, [{ op: "removeElement", slideId: "s1", id: "does-not-exist" }], [])).toBeNull();
  });

  it("returns null for an empty batch", () => {
    expect(invertOps(richDeck(), [], [])).toBeNull();
  });
});

describe("slide history reducer", () => {
  /** Apply an edit and record it, returning the new deck + history like an editor would. */
  function commit(deck: Deck, history: ReturnType<typeof createHistory>, ops: SlideOp[]) {
    const before = deck;
    const r = applyOk(deck, ops);
    return { deck: r.deck, history: pushHistory(history, before, ops, r.createdIds) };
  }

  it("starts empty", () => {
    const h = createHistory();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it("undo restores the prior deck; redo re-applies with identical ids", () => {
    let deck = richDeck();
    const original = deck;
    let history = createHistory();

    ({ deck, history } = commit(deck, history, [{ op: "addElement", slideId: "s1", element: TEXT }]));
    const afterEdit = deck;
    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);

    // Undo.
    const u = undo(history)!;
    history = u.history;
    deck = applyOk(deck, u.ops).deck;
    expect(sansRev(deck)).toEqual(sansRev(original));
    expect(canRedo(history)).toBe(true);

    // Redo — same content AND the same minted id as the first time.
    const re = redo(history)!;
    history = re.history;
    deck = applyOk(deck, re.ops).deck;
    expect(sansRev(deck)).toEqual(sansRev(afterEdit));
    expect(canRedo(history)).toBe(false);
  });

  it("a new edit clears the redo stack", () => {
    let deck = richDeck();
    let history = createHistory();
    ({ deck, history } = commit(deck, history, [{ op: "setTitle", title: "One" }]));
    const u = undo(history)!;
    history = u.history;
    deck = applyOk(deck, u.ops).deck;
    expect(canRedo(history)).toBe(true);
    ({ deck, history } = commit(deck, history, [{ op: "setTitle", title: "Two" }]));
    expect(canRedo(history)).toBe(false);
  });

  it("multi-step undo then redo returns to the exact same deck", () => {
    let deck = richDeck();
    const snapshots: Deck[] = [deck];
    let history = createHistory();
    const edits: SlideOp[][] = [
      [{ op: "setTitle", title: "T1" }],
      [{ op: "addElement", slideId: "s1", element: RECT }],
      [{ op: "setBackground", slideId: "s1", color: "#333333" }],
    ];
    for (const ops of edits) {
      ({ deck, history } = commit(deck, history, ops));
      snapshots.push(deck);
    }
    // Undo all the way down.
    for (let i = edits.length - 1; i >= 0; i--) {
      const u = undo(history)!;
      history = u.history;
      deck = applyOk(deck, u.ops).deck;
      expect(sansRev(deck)).toEqual(sansRev(snapshots[i]));
    }
    expect(canUndo(history)).toBe(false);
    // Redo all the way back up.
    for (let i = 0; i < edits.length; i++) {
      const re = redo(history)!;
      history = re.history;
      deck = applyOk(deck, re.ops).deck;
      expect(sansRev(deck)).toEqual(sansRev(snapshots[i + 1]));
    }
    expect(canRedo(history)).toBe(false);
  });

  it("is bounded: the oldest entry falls off past the limit", () => {
    let deck = richDeck();
    let history = createHistory(2);
    for (const title of ["a", "b", "c", "d"]) {
      ({ deck, history } = commit(deck, history, [{ op: "setTitle", title }]));
    }
    expect(history.past.length).toBe(2);
  });

  it("a non-invertible batch is an undo barrier: the whole history clears", () => {
    let deck = richDeck();
    let history = createHistory();
    ({ deck, history } = commit(deck, history, [{ op: "setTitle", title: "kept" }]));
    expect(canUndo(history)).toBe(true);
    // createdIds that can't name an addElement → invertOps null → history cleared.
    history = pushHistory(history, deck, [{ op: "addElement", slideId: "s1", element: TEXT }], []);
    expect(canUndo(history)).toBe(false);
  });

  it("undo / redo return null when there is nothing to do", () => {
    const h = createHistory();
    expect(undo(h)).toBeNull();
    expect(redo(h)).toBeNull();
  });

  it("the default depth is a sane, documented cap", () => {
    expect(DEFAULT_HISTORY_LIMIT).toBe(50);
    expect(createHistory().limit).toBe(50);
  });
});
