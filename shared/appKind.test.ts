import { describe, expect, test } from "vitest";
import { customAppPath } from "./appKind";
import { externalAppKind, isCustomAppUrl } from "./appKind";

describe("externalAppKind", () => {
  test("a native iPad app (nativeUrlScheme set) is native", () => {
    expect(
      externalAppKind({
        webUrl: "https://docs.google.com/spreadsheets",
        nativeUrlScheme: "googlesheets://",
      }),
    ).toBe("native");
  });

  test("nativeUrlScheme wins even when the launch URL is a custom-app path", () => {
    // Presence of the scheme is the only native signal, checked first.
    expect(
      externalAppKind({
        webUrl: "/custom-apps?token=abc123",
        nativeUrlScheme: "someapp://",
      }),
    ).toBe("native");
  });

  test("a token-gated /custom-apps launch URL is custom", () => {
    // Classify the GENERATOR's output, not a hand-typed literal, so a route
    // change to customAppPath can't silently reclassify custom apps as web.
    expect(externalAppKind({ webUrl: customAppPath("abc123") })).toBe("custom");
  });

  test("a plain external website is web", () => {
    expect(externalAppKind({ webUrl: "https://typingclub.com" })).toBe("web");
    expect(
      externalAppKind({ webUrl: "https://typingclub.com", nativeUrlScheme: null }),
    ).toBe("web");
  });

  test("isCustomAppUrl matches only the token path prefix", () => {
    expect(isCustomAppUrl(customAppPath("xyz"))).toBe(true);
    expect(isCustomAppUrl("https://example.com/custom-apps?token=xyz")).toBe(
      false,
    );
    expect(isCustomAppUrl("https://example.com")).toBe(false);
  });
});

describe("a managed native app with no URL scheme", () => {
  // Reading the scheme alone classified Mentava Reading as "web": it showed
  // under the teacher's Web filter and vanished from Native iPad, while the
  // launcher treated the same row as native. One row, two answers.
  test("is native when identified by bundle id alone", () => {
    expect(
      externalAppKind({
        webUrl: "https://www.mentava.com",
        nativeBundleId: "com.mentava.learn2read",
      }),
    ).toBe("native");
  });

  test("is still web when it names neither", () => {
    expect(
      externalAppKind({
        webUrl: "https://www.mentava.com",
        nativeUrlScheme: null,
        nativeBundleId: null,
      }),
    ).toBe("web");
  });
});
