import { describe, it, expect } from "vitest";

import {
  isNativeManipulativeKind,
  NATIVE_MANIPULATIVE_KINDS,
} from "../nativeManipulativeKinds";

// The catalog kinds the native dispatcher CLAIMS to render inline. This mirrors
// the `ManipulativeKind` union in vendor/manipulative/types.ts; the module's
// compile-time `Exclude<…> extends never` assertion is the real guard that the
// two never drift, and this test pins the runtime shape (membership + the
// WebView-fallback branch for anything outside it).
const CLAIMED_CATALOG_KINDS = [
  "partition",
  "numberline",
  "array",
  "balance",
  "areaPerimeter",
  "distribute",
  "rekenrek",
  "distributor",
  "riemann",
  "functionMachine",
  "placeValue",
  "dice",
  "protractor",
  "coordinatePlane",
  "ruler",
  "clock",
  "liquid",
  "money",
] as const;

describe("native manipulative kind routing", () => {
  it("claims exactly the catalog kinds, with no duplicates", () => {
    expect([...NATIVE_MANIPULATIVE_KINDS].sort()).toEqual(
      [...CLAIMED_CATALOG_KINDS].sort(),
    );
    expect(new Set(NATIVE_MANIPULATIVE_KINDS).size).toBe(NATIVE_MANIPULATIVE_KINDS.length);
  });

  it("maps every claimed catalog kind to the inline native renderer (total)", () => {
    for (const kind of CLAIMED_CATALOG_KINDS) {
      expect(isNativeManipulativeKind(kind)).toBe(true);
    }
  });

  it("reports unsupported / unknown kinds as NOT native (WebView fallback)", () => {
    // A forward-compat spec kind with no native renderer, and plain garbage:
    // both must route to the WebView embed, never render an empty native stage.
    for (const kind of ["hologram", "geoboard", "", "PARTITION", "factorgame"]) {
      expect(isNativeManipulativeKind(kind)).toBe(false);
    }
  });
});
