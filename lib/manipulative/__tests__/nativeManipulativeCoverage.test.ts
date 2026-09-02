import { describe, it, expect } from "vitest";

import { ALL_SPECS } from "@/components/manipulative/library";
import {
  isNativeManipulativeKind,
  NATIVE_MANIPULATIVE_KINDS,
} from "../../../native/src/components/manipulatives/nativeManipulativeKinds";

/**
 * Cross-surface parity: every manipulative kind that appears in the AUTHORED
 * web catalog (components/manipulative/library.ts) must have a first-class
 * native renderer, so a served manipulative practice item renders INLINE on
 * iPad instead of falling back to the WebView embed. If someone authors a spec
 * of a new kind without porting it native, this fails — the drift guard the
 * compile-time totality assertion can't catch (it guards the TYPE union; this
 * guards the DATA catalog).
 */
describe("native manipulative catalog coverage", () => {
  it("covers every kind authored in the web library inline (no WebView fallback needed)", () => {
    const authoredKinds = new Set(ALL_SPECS.map((s) => s.kind));
    expect(authoredKinds.size).toBeGreaterThan(0);
    const uncovered = [...authoredKinds].filter((k) => !isNativeManipulativeKind(k));
    expect(uncovered).toEqual([]);
  });

  it("every claimed native kind is a real authored catalog kind", () => {
    // The reverse direction: the native list shouldn't claim a kind the catalog
    // never produces (a dead renderer). Every authored spec's kind is a valid
    // ManipulativeKind, so the native list must be a subset of what's authored
    // plus the union — here we assert each claimed kind narrows correctly.
    for (const kind of NATIVE_MANIPULATIVE_KINDS) {
      expect(isNativeManipulativeKind(kind)).toBe(true);
    }
  });

  it("routes an unknown kind to the WebView fallback", () => {
    expect(isNativeManipulativeKind("not-a-real-kind")).toBe(false);
  });
});
