import { describe, expect, it } from "vitest";
import { pickNextIncompleteAfter } from "./nextIncompleteActivity";

/** A minimal ordered item — an id plus its done-ness. */
type Item = { id: string; done: boolean };
const item = (id: string, done: boolean): Item => ({ id, done });
const isDone = (t: Item) => t.done;

describe("pickNextIncompleteAfter", () => {
  it("mid-unit: returns the first incomplete activity AFTER the current one", () => {
    const list = [item("a", true), item("b", true), item("c", false), item("d", false)];
    // current = index 1 (b); next incomplete after it is c.
    expect(pickNextIncompleteAfter(list, 1, isDone)).toEqual(item("c", false));
  });

  it("skips completed items after the current one", () => {
    const list = [item("a", false), item("b", true), item("c", true), item("d", false)];
    // current = index 0 (a); b and c are done, so d is next.
    expect(pickNextIncompleteAfter(list, 0, isDone)).toEqual(item("d", false));
  });

  it("REGRESSION: current is last, an EARLIER item incomplete → null, never the earlier item", () => {
    const list = [item("a", false), item("b", true), item("c", true)];
    // current = index 2 (last). "a" is incomplete but BEHIND us — must not wrap.
    expect(pickNextIncompleteAfter(list, 2, isDone)).toBeNull();
  });

  it("all complete → null", () => {
    const list = [item("a", true), item("b", true), item("c", true)];
    expect(pickNextIncompleteAfter(list, 0, isDone)).toBeNull();
    expect(pickNextIncompleteAfter(list, 2, isDone)).toBeNull();
  });

  it("empty list → null", () => {
    expect(pickNextIncompleteAfter([], 0, isDone)).toBeNull();
    expect(pickNextIncompleteAfter([], -1, isDone)).toBeNull();
  });

  it("currentIndex -1 → whole-list scan from the beginning", () => {
    const list = [item("a", true), item("b", false), item("c", false)];
    // current not in list; scan from 0 → first incomplete is b.
    expect(pickNextIncompleteAfter(list, -1, isDone)).toEqual(item("b", false));
  });

  it("never returns an item at or before a non-negative currentIndex", () => {
    const list = [item("a", false), item("b", false), item("c", false)];
    // Even though index 0 and 1 are incomplete, from index 1 the answer is c.
    expect(pickNextIncompleteAfter(list, 1, isDone)).toEqual(item("c", false));
  });
});
