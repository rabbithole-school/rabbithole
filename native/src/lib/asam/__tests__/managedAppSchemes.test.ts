import { describe, expect, it } from "vitest";

import appConfig from "../../../../app.json";
import {
  isUnlockManagedScheme,
  MANAGED_APP_QUERY_SCHEMES,
  MANAGED_APP_URL_SCHEMES,
} from "../managedAppSchemes";

describe("LSApplicationQueriesSchemes", () => {
  const declared = appConfig.expo.ios.infoPlist.LSApplicationQueriesSchemes;

  it("covers every unlockable app, so a Release build can query them", () => {
    // Containment, not equality: iOS allows up to 50 entries and unrelated
    // features may add their own. What must hold is that no unlockable app is
    // missing — a missing entry makes canOpenURL silently answer false.
    for (const scheme of MANAGED_APP_QUERY_SCHEMES) {
      expect(declared).toContain(scheme);
    }
  });

  it("lists bare scheme names, the only form iOS accepts", () => {
    for (const scheme of declared) {
      expect(scheme).not.toContain(":");
      expect(scheme).not.toContain("/");
    }
  });

  it("stays inside the iOS 50-entry limit", () => {
    expect(declared.length).toBeLessThanOrEqual(50);
  });
});

describe("isUnlockManagedScheme", () => {
  it("recognises the apps the backend can unlock", () => {
    for (const scheme of MANAGED_APP_URL_SCHEMES) {
      expect(isUnlockManagedScheme(scheme)).toBe(true);
    }
  });

  it("normalises the way the backend does, so a staff typo still matches", () => {
    expect(isUnlockManagedScheme("  GoogleSheets://  ")).toBe(true);
  });

  it("leaves every other tile on the pre-existing plain launch path", () => {
    for (const scheme of ["otherapp://", "https://example.com", "", undefined, null]) {
      expect(isUnlockManagedScheme(scheme)).toBe(false);
    }
  });

  it("does not match a lookalike scheme", () => {
    expect(isUnlockManagedScheme("spike-extra://")).toBe(false);
    expect(isUnlockManagedScheme("googlesheetsx://")).toBe(false);
  });
});
