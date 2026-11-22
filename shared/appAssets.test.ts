import { describe, expect, it } from "vitest";

import {
  appAssetRef,
  appAssetScriptUrl,
  appAssetSources,
  inlineAppAssetScripts,
  requestedAppAssetIds,
  resolveAppAssetRefs,
  rewriteAppAssetRefs,
} from "./appAssets";

describe("app asset references", () => {
  it("finds unique references across HTML, CSS, and script strings", () => {
    const html = `
      <img src="/app-assets/one">
      <div style="background-image:url('/app-assets/two')"></div>
      <script>const again = "/app-assets/one";</script>
    `;
    expect(requestedAppAssetIds(html)).toEqual(["one", "two"]);
  });

  it("resolves every exact reference as an absolute URL", () => {
    const html =
      '<img src="/app-assets/one"><style>.x{background:url(/app-assets/two)}</style>';
    const urls = new Map([
      ["one", "https://assets.example/one"],
      ["two", "https://assets.example/two"],
    ]);
    const resolved = resolveAppAssetRefs(html, (id) => urls.get(id));
    expect(resolved).not.toContain("/app-assets/");
    expect(resolved).toContain("https://assets.example/one");
    expect(resolved).toContain("https://assets.example/two");
  });

  it("fails closed when the host did not authorize a referenced asset", () => {
    expect(() =>
      resolveAppAssetRefs(
        '<img src="/app-assets/foreign">',
        () => undefined,
      ),
    ).toThrow("Missing app asset URL: foreign");
  });

  it("returns sorted unique path-prefix sources for resolved URLs", () => {
    expect(
      appAssetSources([
        "https://z.example/api/storage/three",
        "https://a.example/api/storage/one",
        "https://a.example/api/storage/two",
      ]),
    ).toEqual([
      "https://a.example/api/storage/",
      "https://z.example/api/storage/",
    ]);
  });

  it("rejects non-absolute asset URLs", () => {
    expect(() => appAssetSources(["/api/storage/one"])).toThrow();
  });

  it("rewrites promotion references without touching unrelated paths", () => {
    const rewritten = rewriteAppAssetRefs(
      '<img src="/app-assets/source"><a href="/elsewhere/source">x</a>',
      new Map([["source", "copy"]]),
    );
    expect(rewritten).toContain(`src="${appAssetRef("copy")}"`);
    expect(rewritten).toContain('href="/elsewhere/source"');
  });
});

describe("script app assets (charm models)", () => {
  const script = 'window.charmModels = { crate: function () {} }; // </script> inside';
  const urls = new Map([
    ["model", appAssetScriptUrl(script)],
    ["photo", "https://example.convex.cloud/api/storage/photo"],
  ]);

  it("inlines a script asset and leaves image assets to URL rewriting", () => {
    const html =
      '<script src="/app-assets/model"></script><img src="/app-assets/photo">';
    const inlined = inlineAppAssetScripts(html, (id) => urls.get(id));
    expect(inlined).toBe(
      `<script>${script.replace("</script", "<\\/script")}</script><img src="/app-assets/photo">`,
    );
  });

  it("does not inline an image asset named in a script tag", () => {
    const html = '<script src="/app-assets/photo"></script>';
    expect(inlineAppAssetScripts(html, (id) => urls.get(id))).toBe(html);
  });

  it("adds no CSP origin for an inline script asset", () => {
    expect(appAssetSources(urls.values())).toEqual([
      "https://example.convex.cloud/api/storage/",
    ]);
  });
});
