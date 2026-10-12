import { describe, expect, test } from "vitest";
import { appPreviewTarget } from "./appPreview";

describe("appPreviewTarget", () => {
  test("a custom app (token path) is always previewable at its own url", () => {
    expect(
      appPreviewTarget({ webUrl: "/custom-apps?token=abc123" }),
    ).toEqual({ href: "/custom-apps?token=abc123", disabledReason: null });
  });

  test("an https web app opens its web url — a login wall is still an honest preview", () => {
    // credentialSource is not an input: landing on the app's own sign-in page
    // is exactly what the scholar sees.
    expect(
      appPreviewTarget({ webUrl: "https://mathacademy.com" }),
    ).toEqual({ href: "https://mathacademy.com", disabledReason: null });
  });

  test("a native iPad app with an https fallback opens that web page", () => {
    // The web launcher opens webUrl; the native scheme is irrelevant on the web.
    expect(
      appPreviewTarget({
        webUrl: "https://spike.legoeducation.com",
        nativeUrlScheme: "spike://",
      }),
    ).toEqual({
      href: "https://spike.legoeducation.com",
      disabledReason: null,
    });
  });

  test("a native iPad app with no https web page is disabled with an iPad reason", () => {
    const result = appPreviewTarget({
      webUrl: "",
      nativeUrlScheme: "spike://",
    });
    expect(result.href).toBeNull();
    expect(result.disabledReason).toMatch(/iPad app/i);
  });

  test("an app with no launch url is disabled with a reason", () => {
    const result = appPreviewTarget({ webUrl: "  " });
    expect(result.href).toBeNull();
    expect(result.disabledReason).toMatch(/nothing to preview/i);
  });

  test("a non-https launch url is refused, not opened", () => {
    for (const webUrl of [
      "http://insecure.example.com",
      "data:text/html,<h1>hi</h1>",
      "javascript:alert(1)",
      "ftp://files.example.com",
      "not a url",
    ]) {
      const result = appPreviewTarget({ webUrl });
      expect(result.href).toBeNull();
      expect(result.disabledReason).toMatch(/isn't a web address/i);
    }
  });
});
