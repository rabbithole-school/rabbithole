import { describe, expect, test } from "vitest";
import { resolveWebTarget } from "../lib/webActivityTarget";
import type { Doc, Id } from "../_generated/dataModel";

const appId = "app123" as Id<"externalApps">;
const app = {
  _id: appId,
  name: "Acme Practice",
  webUrl: "https://www.acmepractice.com/",
  webAllowedHosts: ["acmepractice.com"],
  color: "#1f7fd0",
} as Pick<
  Doc<"externalApps">,
  "_id" | "name" | "webUrl" | "webAllowedHosts" | "color"
>;

describe("resolveWebTarget", () => {
  test("no catalog app → uses the activity's own freehand fields", () => {
    const r = resolveWebTarget(
      {
        webUrl: "https://example.com/x",
        webAllowedHosts: ["example.com"],
        externalAppId: undefined,
      },
      null,
      null,
    );
    expect(r.webUrl).toBe("https://example.com/x");
    expect(r.webAllowedHosts).toEqual(["example.com"]);
    expect(r.externalAppId).toBeNull();
    expect(r.appName).toBeNull();
    expect(r.appIconUrl).toBeNull();
  });

  test("catalog app, no activity overrides → app supplies url + allowlist + identity", () => {
    const r = resolveWebTarget(
      { webUrl: undefined, webAllowedHosts: undefined, externalAppId: appId },
      app,
      "https://cdn/ma.png",
    );
    expect(r.webUrl).toBe("https://www.acmepractice.com/");
    expect(r.webAllowedHosts).toEqual(["acmepractice.com"]);
    expect(r.externalAppId).toBe(appId);
    expect(r.appName).toBe("Acme Practice");
    expect(r.appIconUrl).toBe("https://cdn/ma.png");
    expect(r.appColor).toBe("#1f7fd0");
  });

  test("catalog app + deep-link URL override (same allowlist) → deep link wins, catalog allowlist applies", () => {
    const r = resolveWebTarget(
      {
        webUrl: "https://www.acmepractice.com/learn/fractions",
        webAllowedHosts: undefined,
        externalAppId: appId,
      },
      app,
      null,
    );
    // The in-allowlist deep link wins for the start URL…
    expect(r.webUrl).toBe("https://www.acmepractice.com/learn/fractions");
    // …and the security allowlist still comes from the catalog (DRY).
    expect(r.webAllowedHosts).toEqual(["acmepractice.com"]);
  });

  test("catalog app + FOREIGN-host deep link → ignored, falls back to the app's URL (no lockout)", () => {
    const r = resolveWebTarget(
      {
        // A different host than the catalog allowlist — the watchdog would
        // block it on load, so the resolver must not hand it to the launch.
        webUrl: "https://help.khanacademy.org/article",
        webAllowedHosts: undefined,
        externalAppId: appId,
      },
      app,
      null,
    );
    expect(r.webUrl).toBe("https://www.acmepractice.com/");
    expect(r.webAllowedHosts).toEqual(["acmepractice.com"]);
  });

  test("catalog app ALWAYS owns the allowlist — a stale per-activity allowlist is ignored", () => {
    const r = resolveWebTarget(
      {
        webUrl: undefined,
        // Stale leftover from a pre-link custom URL; must NOT win (the
        // editor hides this field once an app is linked).
        webAllowedHosts: ["khanacademy.org"],
        externalAppId: appId,
      },
      app,
      null,
    );
    expect(r.webUrl).toBe("https://www.acmepractice.com/");
    expect(r.webAllowedHosts).toEqual(["acmepractice.com"]);
  });

  test("blank/whitespace overrides are ignored (fall back to the app)", () => {
    const r = resolveWebTarget(
      { webUrl: "  ", webAllowedHosts: ["  ", ""], externalAppId: appId },
      app,
      null,
    );
    expect(r.webUrl).toBe("https://www.acmepractice.com/");
    expect(r.webAllowedHosts).toEqual(["acmepractice.com"]);
  });
});
