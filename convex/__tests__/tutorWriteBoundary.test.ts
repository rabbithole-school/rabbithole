import { describe, expect, test } from "vitest";
import {
  checkSlideDeckLayoutOnly,
  checkSlideOpsLayoutOnly,
} from "../lib/tutorWriteBoundary";

const frame = { x: 10, y: 20, w: 300, h: 100 };

describe("checkSlideOpsLayoutOnly", () => {
  test.each([
    { op: "patchElement", slideId: "sl1", id: "el1", frame, style: { bold: true } },
    { op: "addElement", slideId: "sl1", element: { type: "rect", frame } },
    { op: "addElement", slideId: "sl1", element: { type: "image", frame, assetId: "asset" } },
    { op: "removeElement", slideId: "sl1", id: "el1" },
    { op: "moveElement", slideId: "sl1", id: "el1", afterId: "el2" },
    { op: "addSlide", afterSlideId: "sl1" },
    { op: "removeSlide", slideId: "sl2" },
    { op: "setBackground", slideId: "sl1", color: "#ffffff" },
  ])("allows layout operation %#", (op) => {
    expect(checkSlideOpsLayoutOnly([op], [])).toEqual({ ok: true });
  });

  test.each([
    { op: "setSpeakerNotes", slideId: "sl1", notes: "Say this" },
    { op: "setTitle", title: "Tutor title" },
    { op: "patchElement", slideId: "sl1", id: "el1", text: "" },
  ])("refuses writing operation %#", (op) => {
    expect(checkSlideOpsLayoutOnly([op], []).ok).toBe(false);
  });

  test("allows an empty or whitespace-only text box", () => {
    expect(
      checkSlideOpsLayoutOnly(
        [
          { op: "addElement", slideId: "sl1", element: { type: "text", text: "" } },
          { op: "addElement", slideId: "sl1", element: { type: "text", text: " \n " } },
        ],
        [],
      ),
    ).toEqual({ ok: true });
  });

  test("allows moving the scholar's existing words into a new text element", () => {
    expect(
      checkSlideOpsLayoutOnly(
        [
          {
            op: "addElement",
            slideId: "sl4",
            element: { type: "text", text: "  My existing words  " },
          },
        ],
        ["My existing words"],
      ),
    ).toEqual({ ok: true });
  });

  test("refuses new text", () => {
    expect(
      checkSlideOpsLayoutOnly(
        [
          {
            op: "addElement",
            slideId: "sl1",
            element: { type: "text", text: "Tutor-written words" },
          },
        ],
        ["Scholar-written words"],
      ).ok,
    ).toBe(false);
  });

  test("refuses words hidden in an addSlide restore payload", () => {
    expect(
      checkSlideOpsLayoutOnly(
        [
          {
            op: "addSlide",
            slide: {
              elements: {
                el1: { type: "text", text: "Tutor-written words" },
              },
            },
          },
        ],
        [],
      ).ok,
    ).toBe(false);
  });
});

describe("checkSlideDeckLayoutOnly", () => {
  test("allows a layout scaffold with empty text and non-text elements", () => {
    expect(
      checkSlideDeckLayoutOnly({
        slides: [
          {
            elements: {
              el1: { type: "text", text: " \n " },
              el2: { type: "rect", frame },
            },
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  test("refuses a scaffold containing words", () => {
    expect(
      checkSlideDeckLayoutOnly({
        slides: [
          {
            elements: {
              el1: { type: "text", text: "Tutor-written words" },
            },
          },
        ],
      }).ok,
    ).toBe(false);
  });

  test("refuses a scaffold containing speaker notes", () => {
    expect(
      checkSlideDeckLayoutOnly({
        slides: [{ elements: {}, speakerNotes: "Tutor notes" }],
      }).ok,
    ).toBe(false);
  });
});

describe("prose channels beyond text elements", () => {
  test("refuses a tutor-written deck title on create", () => {
    expect(checkSlideDeckLayoutOnly({ title: "Why Recycling Matters", slides: [] }).ok).toBe(false);
  });
  test("refuses new alt text but lets an existing picture move with its alt", () => {
    const image = (alt: string) => ({
      op: "addElement",
      slideId: "s1",
      element: { type: "image", frame: { x: 0, y: 0, w: 10, h: 10 }, assetId: "a", alt },
    });
    expect(checkSlideOpsLayoutOnly([image("a paragraph of tutor prose")], []).ok).toBe(false);
    expect(checkSlideOpsLayoutOnly([image("my dog")], ["my dog"]).ok).toBe(true);
    expect(
      checkSlideDeckLayoutOnly({
        slides: [{ elements: { e1: { type: "image", assetId: "a", alt: "prose" } } }],
      }).ok,
    ).toBe(false);
  });
});
