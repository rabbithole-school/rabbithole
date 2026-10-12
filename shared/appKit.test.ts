import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_KIT_FILES,
  APP_KIT_SCRIPT_FILES,
  APP_KIT_STYLESHEET_FILES,
  APP_KIT_V1_FILES,
  APP_KIT_V2_FILES,
  inlineAppKitScripts,
  requestedAppKitFiles,
} from "./appKit";
import { BUNDLED_APP_KIT_SOURCES } from "./appKitSources.generated";

type AppKitManifest = {
  version: string;
  libraries: Record<
    string,
    {
      bytes: number;
      integrity?: string;
      license: string;
      package?: string;
      sha256: string;
      version?: string;
    }
  >;
};

describe("app kit", () => {
  it("finds each requested file once and keeps unrelated resources unchanged", () => {
    const html = `
      <script src="/app-kit/v1/cytoscape.min.js"></script>
      <link rel="stylesheet" href="/app-kit/v2/katex.inline.css">
      <script src="/other.js"></script>
      <script src="/app-kit/v1/cytoscape.min.js"></script>
      <script src="/app-kit/v2/fraction.min.js"></script>
    `;

    expect(requestedAppKitFiles(html)).toEqual([
      "cytoscape.min.js",
      "fraction.min.js",
      "katex.inline.css",
    ]);
    expect(inlineAppKitScripts(html, (file) => `source:${file}`)).toContain(
      '<script src="/other.js"></script>',
    );
  });

  it("inlines scripts and styles through the same closed path", () => {
    const html =
      '<script data-purpose="math" src="/app-kit/v2/katex.min.js"></script>' +
      '<link media="screen" rel="stylesheet" href="/app-kit/v2/katex.inline.css">';

    expect(inlineAppKitScripts(html, (file) => `source:${file}`)).toBe(
      '<script data-purpose="math">source:katex.min.js</script>' +
        '<style media="screen">source:katex.inline.css</style>',
    );
  });

  it("strips inline-only execution attributes and rejects non-classic types", () => {
    const inlined = inlineAppKitScripts(
      '<script async defer type="" data-purpose="graph" src="/app-kit/v1/cytoscape.min.js"></script>',
      () => "window.cytoscape=true;",
    );
    expect(inlined).toBe(
      '<script data-purpose="graph">window.cytoscape=true;</script>',
    );

    const rejected = inlineAppKitScripts(
      '<script type="module" src="/app-kit/v2/math.min.js"></script>',
      () => "window.math=true;",
    );
    expect(rejected).not.toContain("window.math=true");
    expect(rejected).toContain(
      'console.error("Unsupported app-kit script type: module")',
    );
  });

  it("does not allow files to cross versioned kit paths", () => {
    const rejected = inlineAppKitScripts(
      '<script src="/app-kit/v1/p5.min.js"></script>' +
        '<link rel="stylesheet" href="/app-kit/v1/katex.inline.css">',
      () => "unreachable",
    );

    expect(rejected).not.toContain("unreachable");
    expect(rejected).not.toContain('src="/app-kit/');
    expect(rejected).not.toContain('href="/app-kit/');
  });

  it("keeps public files, generated sources, and manifests in lockstep", () => {
    const kits = [
      { files: APP_KIT_V1_FILES, version: "v1" },
      { files: APP_KIT_V2_FILES, version: "v2" },
    ] as const;

    expect(APP_KIT_FILES).toEqual([
      ...APP_KIT_SCRIPT_FILES.slice(0, APP_KIT_V1_FILES.length),
      ...APP_KIT_V2_FILES,
    ]);
    expect(APP_KIT_STYLESHEET_FILES).toEqual([
      "katex.inline.css",
      "jsxgraph.min.css",
      "rh-expression-editor.css",
    ]);

    for (const kit of kits) {
      const manifest = JSON.parse(
        readFileSync(
          path.resolve(
            __dirname,
            `../public/app-kit/${kit.version}/manifest.json`,
          ),
          "utf8",
        ),
      ) as AppKitManifest;

      expect(manifest.version).toBe(kit.version);
      expect(Object.keys(manifest.libraries)).toEqual(kit.files);

      for (const file of kit.files) {
        const source = readFileSync(
          path.resolve(__dirname, `../public/app-kit/${kit.version}`, file),
          "utf8",
        );
        expect(BUNDLED_APP_KIT_SOURCES[file]).toBe(source);
        expect(manifest.libraries[file]).toMatchObject({
          bytes: Buffer.byteLength(source),
          sha256: createHash("sha256").update(source).digest("hex"),
        });
      }
    }
  });

  it("preserves approved license headers and inlines all KaTeX fonts", () => {
    expect(BUNDLED_APP_KIT_SOURCES["p5.min.js"]).toMatch(
      /^\/\*! p5\.js v/,
    );
    expect(BUNDLED_APP_KIT_SOURCES["jsxgraph.min.js"]).toContain(
      "JSXGraph is free software dual licensed",
    );
    expect(BUNDLED_APP_KIT_SOURCES["three.iife.min.js"]).toContain(
      "SPDX-License-Identifier: MIT",
    );
    expect(
      BUNDLED_APP_KIT_SOURCES["katex.inline.css"].match(
        /data:font\/woff2;base64/g,
      ),
    ).toHaveLength(20);
    expect(BUNDLED_APP_KIT_SOURCES["katex.inline.css"]).not.toContain(
      "url(fonts/",
    );
  });

  it("pins only the approved v2 npm tarballs", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.resolve(__dirname, "../public/app-kit/v2/manifest.json"),
        "utf8",
      ),
    ) as AppKitManifest;
    const packages = new Map(
      Object.values(manifest.libraries)
        // First-party widgets (e.g. rh-expression-editor.*) are bundled from
        // repo source, not an npm tarball, so they carry no package/integrity.
        .filter((library) => library.package !== undefined)
        .map(({ integrity, package: packageName, version }) => [
          packageName,
          { integrity, version },
        ]),
    );

    expect(Object.fromEntries(packages)).toEqual({
      p5: {
        integrity:
          "sha512-+zVz5JFp3sCLpLscTMOLoA0UEHV0dsHxngKVfMmeW1J2/IXvfFqCjNYZeIOtG4Lhfnpm7cu6446P6Ho64ihXfA==",
        version: "2.3.3",
      },
      "fraction.js": {
        integrity:
          "sha512-1X1NTtiJphryn/uLQz3whtY6jK3fTqoE3ohKs0tT+Ujr1W59oopxmoEh7Lu5p6vBaPbgoM0bzveAW4Qi5RyWDQ==",
        version: "5.3.4",
      },
      katex: {
        integrity:
          "sha512-h+UCwkZ+4Jz8WQ7MLGfj7UVFrRCizGb912fwF4luGdYsC5paYG1vx+jy+KRcC/XkpjGva/P7nAWuxNnPzRvzHw==",
        version: "0.18.7",
      },
      jsxgraph: {
        integrity:
          "sha512-sUVTxB5mDPL5WIEeuo9nprymRymU1ojU2YDtpcK6JzcIe3DkxpQ/2uolGuJ3R0lH6tb3wCGY+1PgVhCVic6yjg==",
        version: "1.13.3",
      },
      mathjs: {
        integrity:
          "sha512-UAQzSVob9rNLdGpqcFMYmSu9dkuLYy7Lr2hBEQS5SHQdknA9VppJz3cy2KkpMzTODunad6V6cNv+5kOLsePLow==",
        version: "15.2.0",
      },
      three: {
        integrity:
          "sha512-cr/fIM2ddMSVbYVgkfD4jLJv7Fh/8ZTjvo+7gQeSVGUZHxpx9FDwoL5iC7hUz/LiRA8wMbqfnb90xKfm1/HHkQ==",
        version: "0.186.0",
      },
    });
  });
});
