// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  isComposeChord,
  pressComposeKey,
  registerComposeTarget,
} from "../useComposeKey";

const chord = { key: "/", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };

function press(init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "/",
    metaKey: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

describe("compose key", () => {
  it("recognizes only ⌘/", () => {
    expect(isComposeChord(chord)).toBe(true);
    expect(isComposeChord({ ...chord, metaKey: false })).toBe(false);
    expect(isComposeChord({ ...chord, shiftKey: true })).toBe(false);
    expect(isComposeChord({ ...chord, ctrlKey: true })).toBe(false);
    expect(isComposeChord({ ...chord, altKey: true })).toBe(false);
    expect(isComposeChord({ ...chord, key: "?" })).toBe(false);
  });

  it("runs the newest registered surface and consumes the key", () => {
    const first = vi.fn();
    const second = vi.fn();
    const off1 = registerComposeTarget(() => first);
    const off2 = registerComposeTarget(() => second);
    const event = press();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    off2();
    press();
    expect(first).toHaveBeenCalledTimes(1);
    off1();
  });

  it("leaves the key alone when nothing is registered", () => {
    expect(pressComposeKey()).toBe(false);
    expect(press().defaultPrevented).toBe(false);
  });

  it("consumes held-key repeats without invoking the target again", () => {
    const compose = vi.fn();
    const unregister = registerComposeTarget(() => compose);
    try {
      expect(press().defaultPrevented).toBe(true);
      expect(press({ repeat: true }).defaultPrevented).toBe(true);
      expect(compose).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});
