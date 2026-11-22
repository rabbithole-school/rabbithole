import { build } from "esbuild";
import path from "node:path";
import { describe, expect, test } from "vitest";

// Convex bundles convex/schema.ts on its own (one entry point, code splitting
// on) and refuses the deploy if that bundle imports any chunk:
// "NoImportModuleInSchema: Can't import _deps/….js while evaluating schema".
// With a single entry point, esbuild only emits a chunk for a DYNAMIC import(),
// so this fails exactly when something reachable from the schema lazy-loads a
// module. The production deploy of PR #4401 failed this way: assignments.ts
// (reachable via masterSchedule.ts) imported a helper from
// lib/scholarReadTools.ts, which lazy-loads the Anthropic SDK. Keep modules the
// schema reaches free of dynamic imports — put pure helpers in their own file
// (lib/nameMatch.ts is the worked example).
describe("convex/schema.ts bundle", () => {
  test("is a single module with no split chunks", async () => {
    const root = path.resolve(__dirname, "../..");
    const result = await build({
      entryPoints: [path.join(root, "convex/schema.ts")],
      absWorkingDir: root,
      bundle: true,
      format: "esm",
      platform: "browser",
      splitting: true,
      outdir: path.join(root, ".schema-bundle-probe"),
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const chunks = Object.keys(result.metafile.outputs).filter(
      (file) => file.endsWith(".js") && !file.endsWith("schema.js"),
    );
    expect(
      chunks,
      "Something reachable from convex/schema.ts uses a dynamic import(); Convex will refuse the deploy (NoImportModuleInSchema).",
    ).toEqual([]);
  }, 60_000);
});
