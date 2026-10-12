import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_SANDBOX_CSP,
  appSandboxCsp,
  prepareCustomAppSandbox,
} from "./customAppSandbox";
import { APP_KIT_V2_FILES } from "./appKit";

describe("custom app sandbox", () => {
  it("keeps the app host CSP stable", () => {
    expect(APP_SANDBOX_CSP).toMatchInlineSnapshot(
      `"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"`,
    );
  });

  it("keeps zero-asset CSP byte-identical to the default", () => {
    expect(appSandboxCsp([])).toBe(APP_SANDBOX_CSP);
  });

  it("keeps the generated sources behind a web dynamic import", () => {
    const source = readFileSync(
      path.resolve(__dirname, "customAppSandbox.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /import\s+[^;]*from\s+["']\.\/appKitSources\.generated["']/,
    );
    expect(source).toContain('await import("./appKitSources.generated")');
  });

  it("injects the CSP before app markup and applies the shared bridge", async () => {
    expect(
      await prepareCustomAppSandbox(
        "<!doctype html><html><head></head><body>App</body></html>",
        (html) => `bridged:${html}`,
      ),
    ).toEqual({
      csp: APP_SANDBOX_CSP,
      srcDoc: `bridged:<!doctype html>\n<meta http-equiv="Content-Security-Policy" content="${APP_SANDBOX_CSP}"><html><head></head><body>App</body></html>`,
    });
  });

  it("replaces an app-authored CSP with the host policy", async () => {
    const { srcDoc } = await prepareCustomAppSandbox(
      '<meta http-equiv="Content-Security-Policy" content="default-src *"><script>window.booted = true</script>',
      (html) => html,
    );

    expect(srcDoc).toContain(`content="${APP_SANDBOX_CSP}"`);
    expect(srcDoc).not.toContain("default-src *");
    expect(srcDoc.indexOf(APP_SANDBOX_CSP)).toBeLessThan(
      srcDoc.indexOf("window.booted"),
    );
  });

  it("inlines only requested first-party kit files under the closed CSP", async () => {
    const html =
      '<html><head><link rel="stylesheet" href="/app-kit/v2/katex.inline.css"><script src="/app-kit/v2/katex.min.js"></script></head><body></body></html>';
    const sandbox = await prepareCustomAppSandbox(
      html,
      (value) => `bridged:${value}`,
    );

    expect(sandbox.csp).toBe(APP_SANDBOX_CSP);
    expect(sandbox.csp).not.toContain("'self'");
    expect(sandbox.srcDoc).not.toContain('src="/app-kit/');
    expect(sandbox.srcDoc).not.toContain('href="/app-kit/');
    expect(sandbox.srcDoc).toContain("KaTeX");
  });

  it("allows one image and connection source for a shared storage path", async () => {
    const sandbox = await prepareCustomAppSandbox(
      '<img id="fish" src="/app-assets/fish"><img id="reef" src="/app-assets/reef">',
      (html) => html,
      (id) =>
        id === "fish"
          ? "https://assets.example/api/storage/fish-id"
          : "https://assets.example/api/storage/reef-id",
    );

    expect(sandbox.csp).toContain(
      "img-src data: blob: https://assets.example/api/storage/;",
    );
    expect(sandbox.csp).toContain(
      "connect-src https://assets.example/api/storage/;",
    );
    expect(
      sandbox.csp.match(/https:\/\/assets\.example\/api\/storage\//g),
    ).toHaveLength(2);
    expect(
      sandbox.csp.match(
        /img-src data: blob: https:\/\/assets\.example\/api\/storage\//g,
      ),
    ).toHaveLength(1);
    expect(
      sandbox.csp.match(
        /connect-src https:\/\/assets\.example\/api\/storage\//g,
      ),
    ).toHaveLength(1);
    expect(sandbox.csp).not.toContain(
      "connect-src https://assets.example;",
    );
    expect(sandbox.srcDoc).not.toContain("/app-assets/");
    expect(sandbox.srcDoc).toContain(
      "https://assets.example/api/storage/fish-id",
    );
    expect(sandbox.srcDoc).toContain(
      "https://assets.example/api/storage/reef-id",
    );
    expect(sandbox.srcDoc).toContain(`content="${sandbox.csp}"`);
  });

  it("fails closed when an app asset URL is unresolved", async () => {
    await expect(
      prepareCustomAppSandbox(
        '<img src="/app-assets/missing">',
        (html) => html,
      ),
    ).rejects.toThrow("Missing app asset URL: missing");
  });

  it("ships only the approved v2 files", () => {
    expect(APP_KIT_V2_FILES).toEqual([
      "p5.min.js",
      "fraction.min.js",
      "katex.min.js",
      "katex.inline.css",
      "jsxgraph.min.js",
      "jsxgraph.min.css",
      "math.min.js",
      "three.iife.min.js",
      "rh-expression-editor.js",
      "rh-expression-editor.css",
    ]);
  });

  it("fails closed without a network request for unknown kit files", async () => {
    const { srcDoc } = await prepareCustomAppSandbox(
      '<script src="/app-kit/v1/unreviewed.min.js"></script>',
      (html) => html,
    );

    expect(srcDoc).not.toContain('src="/app-kit/');
    expect(srcDoc).toContain(
      'console.error("Unsupported app-kit script: /app-kit/v1/unreviewed.min.js")',
    );
  });

  it("fails closed for unknown kit stylesheets", async () => {
    const { srcDoc } = await prepareCustomAppSandbox(
      '<link rel="stylesheet" href="/app-kit/v2/unreviewed.css">',
      (html) => html,
    );

    expect(srcDoc).not.toContain('href="/app-kit/');
    expect(srcDoc).toContain(
      'console.error("Unsupported app-kit stylesheet: /app-kit/v2/unreviewed.css")',
    );
  });
});
