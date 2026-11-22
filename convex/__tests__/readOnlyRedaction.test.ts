import { describe, expect, test } from "vitest";
import { redactCustomAppTokens, WITHHELD_CUSTOM_APP_TOKEN } from "../lib/readOnlyRedaction";
import { customAppPath } from "../../shared/appKind";

const TOKEN = "c0ffee1234567890abcdef";

describe("redactCustomAppTokens", () => {
  test("withholds the token in a launch path, a full URL, and an encoded nested URL", () => {
    expect(redactCustomAppTokens(customAppPath(TOKEN))).toBe(customAppPath(WITHHELD_CUSTOM_APP_TOKEN));
    expect(redactCustomAppTokens(`Open https://rabbithole.school${customAppPath(TOKEN)}&from=assignment now`)).toBe(
      `Open https://rabbithole.school${customAppPath(WITHHELD_CUSTOM_APP_TOKEN)}&from=assignment now`,
    );
    const nested = `https://x.test/?next=${encodeURIComponent(customAppPath(TOKEN))}`;
    expect(redactCustomAppTokens(nested)).not.toContain(TOKEN);
  });

  test("walks arrays and plain objects and leaves other values alone", () => {
    const input = {
      apps: [{ name: "Tide Chart", webUrl: customAppPath(TOKEN), count: 3, live: true, icon: null }],
      note: "https://www.pressreader.com/catalog?token=keep-me",
    };
    const out = redactCustomAppTokens(input);
    expect(out.apps[0]).toEqual({
      name: "Tide Chart",
      webUrl: customAppPath(WITHHELD_CUSTOM_APP_TOKEN),
      count: 3,
      live: true,
      icon: null,
    });
    // Only custom-app launch URLs are touched.
    expect(out.note).toBe(input.note);
    // A copy, not a mutation.
    expect(input.apps[0].webUrl).toBe(customAppPath(TOKEN));
  });
});
