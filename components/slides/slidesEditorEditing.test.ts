/**
 * Three things the web editor gets wrong the moment it reads a stale source.
 *
 *  1. A tab hidden mid-edit took the scholar's typed text with it. The only
 *     commit path is the textarea's blur, and hiding a tab fires no blur; the
 *     draft lives INSIDE the textarea, so the editor reaches it only through
 *     the handle `SlideCanvas` publishes.
 *  2. Two quick toolbar clicks stacked, because the cascade measured the
 *     controlled `deck` prop — a render behind the optimistic `workingDeck`.
 *  3. A blank box the scholar typed into and emptied again survived, because
 *     "untouched" was inferred from `text === el.text` rather than tracked.
 *
 * All three are about which copy of the truth a callback reads, so all three
 * are pinned here against the REAL editor rendered in jsdom.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

import { system } from "@/lib/theme";
import {
  applySlideOps,
  emptyDeck,
  makeDeckIdFactory,
  type Deck,
} from "@/shared/slidesScene";
import { SlidesEditor } from "./SlidesEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lays nothing out, so the canvas would measure 0x0 and render nothing.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Captured once so afterEach can put the globals back exactly as jsdom made
// them — these stubs are prototype-level and would otherwise leak into every
// later test file in the same worker.
const originalResizeObserver = (globalThis as { ResizeObserver?: unknown })
  .ResizeObserver;
const originalLayoutDescriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
};
const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

function stubLayout() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => 800,
    });
  }
}

function restoreGlobals() {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    const original = originalLayoutDescriptors[prop];
    if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
  if (originalVisibilityDescriptor) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
}

/** Where the seeded text box sits — `boxAt` addresses it by these coordinates. */
const BOX_FRAME = { x: 100, y: 100, w: 400, h: 120, rotation: 0 };

function deckWithText(text: string): { deck: Deck; id: string } {
  const base = emptyDeck("Test deck", "slide-1");
  const result = applySlideOps(
    base,
    [
      {
        op: "addElement",
        slideId: "slide-1",
        element: { type: "text", frame: BOX_FRAME, text },
      },
    ],
    makeDeckIdFactory(base),
  );
  if (!result.ok) throw new Error(result.error);
  return { deck: result.deck, id: result.createdIds[0] };
}

/** Type into a controlled textarea the way a browser does. */
function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function hideTab() {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  restoreGlobals();
});

async function renderEditor(deck: Deck) {
  stubLayout();
  const decks: Deck[] = [];

  function Harness() {
    const [current, setCurrent] = useState(deck);
    // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
    return createElement(ChakraProvider, {
      value: system,
      children: createElement(SlidesEditor, {
        deck: current,
        onChange: (next: Deck) => {
          decks.push(next);
          setCurrent(next);
        },
      }),
    });
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Harness));
  });
  return { decks };
}

/**
 * The seeded element box, addressed by the inline left/top `boxTransform`
 * writes. Matching on rendered text cannot find a BLANK box, which is exactly
 * the case one of these tests needs.
 */
function boxAt(frame: { x: number; y: number }) {
  // The slide-list thumbnail draws the same element at the same frame through
  // the same read-only SlideCanvas, so take the LAST match — the editing
  // canvas renders after the rail, and only its box carries onDoubleClick.
  const boxes = Array.from(
    container?.querySelectorAll<HTMLElement>(
      `div[style*="left: ${frame.x}px"][style*="top: ${frame.y}px"]`,
    ) ?? [],
  );
  expect(boxes.length, "the text element should render at its frame").toBeGreaterThan(0);
  return boxes[boxes.length - 1];
}

/** The editing overlay's textarea — the speaker-notes one is labelled. */
function editorTextarea() {
  return container?.querySelector<HTMLTextAreaElement>("textarea:not([aria-label])") ?? null;
}

async function openTextEditor(box: HTMLElement) {
  await act(async () => {
    box.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const textarea = editorTextarea();
  expect(textarea, "double-clicking a text box opens the editor").toBeTruthy();
  return textarea as HTMLTextAreaElement;
}

/** Click a toolbar button by its visible label. */
function toolbarButton(label: string) {
  const button = Array.from(container?.querySelectorAll("button") ?? []).find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button, `toolbar should offer "${label}"`).toBeTruthy();
  return button as HTMLButtonElement;
}

async function renderEditorMidEdit(initial: string) {
  const { deck, id } = deckWithText(initial);
  const { decks } = await renderEditor(deck);
  return { textarea: await openTextEditor(boxAt(BOX_FRAME)), decks, id };
}

describe("SlidesEditor — flushing an in-flight draft when the tab is hidden", () => {
  it("writes the typed draft through and leaves the edit session open", async () => {
    const { textarea, decks, id } = await renderEditorMidEdit("Volcanoes");

    await act(async () => typeInto(textarea, "Volcanoes erupt"));
    // No blur — exactly the state a tab switch interrupts.
    expect(decks).toHaveLength(0);

    await act(async () => hideTab());

    expect(decks.at(-1)?.slides[0].elements[id]).toMatchObject({
      text: "Volcanoes erupt",
    });
    // The scholar is still in the box; a flush must not close it under them.
    expect(editorTextarea()).toBeTruthy();
  });

  it("leaves a blank draft alone so the eventual blur can remove the box", async () => {
    const { textarea, decks, id } = await renderEditorMidEdit("Volcanoes");

    await act(async () => typeInto(textarea, "   "));
    await act(async () => hideTab());
    expect(decks).toHaveLength(0);

    // React listens for the bubbling `focusout`, which is what a real blur emits.
    await act(async () => textarea.blur());
    const slide = decks.at(-1)?.slides[0];
    expect(slide?.elements[id]).toBeUndefined();
    expect(slide?.elementIds).not.toContain(id);
  });
});

describe("SlidesEditor — inserting two elements before a re-render", () => {
  it("cascades the second insert instead of stacking it on the first", async () => {
    const { decks } = await renderEditor(emptyDeck("Test deck", "slide-1"));

    // BOTH clicks inside ONE act, so React never re-renders between them and
    // the controlled `deck` prop still describes the empty slide for the
    // second one. Reading occupancy from that prop put both rectangles on the
    // identical frame; only the optimistic working copy knows about the first.
    await act(async () => {
      const rectangle = toolbarButton("Rectangle");
      rectangle.click();
      rectangle.click();
    });

    const slide = decks.at(-1)?.slides[0];
    expect(slide?.elementIds).toHaveLength(2);
    const [first, second] = slide!.elementIds.map((eid) => slide!.elements[eid].frame);
    expect({ x: second.x, y: second.y }).not.toEqual({ x: first.x, y: first.y });
  });
});

describe("SlidesEditor — committing a blank text box", () => {
  it("removes a pre-existing blank box the scholar typed into and emptied again", async () => {
    // Reverting to blank leaves `text === el.text`, so inferring "untouched"
    // from equality kept this invisible box while native removed it.
    const { deck, id } = deckWithText("");
    const { decks } = await renderEditor(deck);
    const textarea = await openTextEditor(boxAt(BOX_FRAME));

    await act(async () => typeInto(textarea, "Lava"));
    await act(async () => typeInto(textarea, ""));
    await act(async () => textarea.blur());

    const slide = decks.at(-1)?.slides[0];
    expect(slide?.elements[id]).toBeUndefined();
    expect(slide?.elementIds).not.toContain(id);
  });

  it("leaves a blank box that was opened and closed untouched exactly as it was", async () => {
    const { deck, id } = deckWithText("");
    const { decks } = await renderEditor(deck);
    const textarea = await openTextEditor(boxAt(BOX_FRAME));

    await act(async () => textarea.blur());

    expect(decks).toHaveLength(0);
    expect(editorTextarea()).toBeNull();
    // Nothing was emitted, so the box is still the one the deck came with.
    expect(deck.slides[0].elementIds).toContain(id);
  });
});
