import { describe, expect, it } from "vitest";

import appConfig from "../../../../app.json";
import {
  isUnlockManagedApp,
  MANAGED_APP_BUNDLE_IDS,
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
    expect(isUnlockManagedScheme("stopmotionstudiox://")).toBe(false);
  });
});

describe("isUnlockManagedApp: a managed app need not have a scheme", () => {
  // Mentava Reading registers no custom URL scheme and no associated domains,
  // so it is identified by bundle id alone. Gating the launcher on the scheme
  // would drop it onto the web-view path, which would open a marketing page
  // instead of doing the readiness + ASAM work the tile exists for.
  it("accepts a scheme-bearing app", () => {
    expect(isUnlockManagedApp({ nativeUrlScheme: "googlesheets://" })).toBe(true);
  });

  it("accepts a scheme-less app by bundle id", () => {
    expect(isUnlockManagedApp({ nativeBundleId: "com.mentava.learn2read" })).toBe(
      true,
    );
  });

  it("is case- and whitespace-insensitive, like the backend", () => {
    expect(
      isUnlockManagedApp({ nativeBundleId: "  COM.Mentava.Learn2Read  " }),
    ).toBe(true);
  });

  it("rejects an app naming neither, and an unknown bundle id", () => {
    expect(isUnlockManagedApp({})).toBe(false);
    expect(isUnlockManagedApp({ nativeUrlScheme: null, nativeBundleId: null })).toBe(
      false,
    );
    expect(isUnlockManagedApp({ nativeBundleId: "com.example.unknown" })).toBe(
      false,
    );
  });
});

describe("bundle ids stay OUT of LSApplicationQueriesSchemes", () => {
  // The plist allowlist is about canOpenURL, which a bundle id can never
  // answer. Listing one there would be silently meaningless — the kind of
  // entry that looks like coverage and is not.
  const declared = appConfig.expo.ios.infoPlist.LSApplicationQueriesSchemes;

  it("declares no bundle id as a query scheme", () => {
    for (const bundleId of MANAGED_APP_BUNDLE_IDS) {
      expect(declared).not.toContain(bundleId);
    }
  });

  it("keeps the two lists disjoint", () => {
    for (const bundleId of MANAGED_APP_BUNDLE_IDS) {
      expect(MANAGED_APP_URL_SCHEMES).not.toContain(bundleId);
    }
  });
});
