import { describe, expect, it } from "vitest";
import {
  earlierThreadPin,
  resolveThreadWindow,
  type ThreadWindowPin,
} from "./threadWindow";

type Row = { id: string };
const rows = (n: number, from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${from + i}` }));
const keyOf = (row: Row) => row.id;

describe("resolveThreadWindow", () => {
  it("opens a long thread on its newest page and pins the oldest drawn", () => {
    const items = rows(100);
    const window = resolveThreadWindow(items, keyOf, null, "edit", 20);
    expect(window.start).toBe(80);
    expect(window.pin).toEqual({ scope: "edit", key: "m80" });
  });

  it("draws a short thread whole", () => {
    const window = resolveThreadWindow(rows(5), keyOf, null, "edit", 20);
    expect(window.start).toBe(0);
    expect(window.pin).toEqual({ scope: "edit", key: "m0" });
  });

  it("has nothing to pin in an empty thread", () => {
    expect(resolveThreadWindow([], keyOf, null, "edit", 20)).toEqual({
      start: 0,
      pin: null,
    });
  });

  it("keeps the oldest drawn message in place as new turns arrive", () => {
    const pin: ThreadWindowPin = { scope: "edit", key: "m80" };
    const grown = rows(103);
    const window = resolveThreadWindow(grown, keyOf, pin, "edit", 20);
    expect(window.start).toBe(80);
    // Same object back, so storing it on change cannot loop.
    expect(window.pin).toBe(pin);
  });

  it("starts another thread at its own newest page", () => {
    const pin: ThreadWindowPin = { scope: "edit", key: "m80" };
    const window = resolveThreadWindow(rows(30), keyOf, pin, "play", 20);
    expect(window.start).toBe(10);
    expect(window.pin).toEqual({ scope: "play", key: "m10" });
  });

  it("re-pins at the newest page when the pinned message is gone", () => {
    const pin: ThreadWindowPin = { scope: "edit", key: "gone" };
    const window = resolveThreadWindow(rows(50), keyOf, pin, "edit", 20);
    expect(window.start).toBe(30);
    expect(window.pin).toEqual({ scope: "edit", key: "m30" });
  });
});

describe("earlierThreadPin", () => {
  it("reaches one page further back", () => {
    expect(earlierThreadPin(rows(100), keyOf, 80, "edit", 20)).toEqual({
      scope: "edit",
      key: "m60",
    });
  });

  it("stops at the first message", () => {
    expect(earlierThreadPin(rows(100), keyOf, 7, "edit", 20)).toEqual({
      scope: "edit",
      key: "m0",
    });
  });

  it("draws the whole thread once revealed back to the start", () => {
    const items = rows(45);
    let window = resolveThreadWindow(items, keyOf, null, "edit", 20);
    while (window.start > 0) {
      const pin = earlierThreadPin(items, keyOf, window.start, "edit", 20);
      window = resolveThreadWindow(items, keyOf, pin, "edit", 20);
    }
    expect(window.start).toBe(0);
  });
});
