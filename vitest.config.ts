import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Every project inherits this block (`extends: true`); the projects only
// differ in which files they own and how those files are isolated.
const shared = {
  reporters: ["default"],
  environment: "edge-runtime",
  setupFiles: ["./vitest.setup.ts"],
  env: {
    SITE_URL: "https://rabbithole.test",
    AUTH_EMAIL_FROM: "Rabbithole <no-reply@rabbithole.test>",
  },
  server: { deps: { inline: ["convex-test"] } },
  testTimeout: 20_000,
};

// ---------------------------------------------------------------------------
// Convex tests: shared workers, except for files that reach outside their
// own module.
//
// Re-importing the ~1,000-module backend graph in a fresh process per file
// cost as much CPU as the tests themselves (measured 2026-09-01: 180 s import
// vs 178 s tests across 675 files). Running them in threads with
// `isolate: false` cut the directory's wall time 106 s → 85 s.
//
// That only holds for files that share nothing but module code. A file that
// `vi.mock`s a module rewrites the worker's module registry for every file
// that runs after it on the same thread (calculatorLicense's gemini mock
// broke aideAttachments that way); a file that swaps `globalThis.fetch`,
// writes `process.env`, or installs fake timers (a failed assertion skips the
// `useRealTimers` on the way out) leaks the same way. Those files are
// detected by content below and keep the default one-process-per-file
// isolation, so a new test that reaches for `vi.mock` is isolated
// automatically — nobody has to remember a list.
// ---------------------------------------------------------------------------
const ISOLATION_HAZARD =
  /\bvi\.(mock|doMock|stubGlobal|stubEnv|useFakeTimers|setSystemTime|resetModules)\(|spyOn\(\s*globalThis|globalThis\.\w+\s*=|process\.env(\.[A-Z_]+|\[[^\]]+\])\s*=|delete\s+process\.env|Object\.assign\(\s*process\.env/;

function convexTestFiles(dir = "convex", out: string[] = []): string[] {
  for (const entry of readdirSync(path.resolve(__dirname, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "_generated" && entry.name !== "node_modules") convexTestFiles(rel, out);
    } else if (entry.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

const convexIsolated = convexTestFiles().filter((f) =>
  ISOLATION_HAZARD.test(readFileSync(path.resolve(__dirname, f), "utf8")),
);

export default defineConfig({
  resolve: {
    // Match tsconfig's "@/*" → repo root so app-code imports work in tests.
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    ...shared,
    projects: [
      {
        extends: true,
        // convex-test runs scheduled functions on real timers, so one a file
        // leaves behind fires, or is still running, during the next file. The
        // tracked wrapper + setup file drain every instance's jobs at the end
        // of every file.
        resolve: {
          alias: [{ find: /^convex-test$/, replacement: path.resolve(__dirname, "vitest/convexTestTracked.ts") }],
        },
        test: {
          name: "convex",
          include: ["convex/**/*.test.ts"],
          exclude: convexIsolated,
          setupFiles: [...shared.setupFiles, "./vitest.convexShared.setup.ts"],
          pool: "threads",
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          name: "convex-isolated",
          include: convexIsolated,
        },
      },
      {
        extends: true,
        test: {
          name: "root",
          // `app/**` is included for PURE logic colocated with a route (e.g. the
          // /school shell's per-role nav filtering) — React component behavior is
          // still verified in a browser, not here.
          include: [
            "lib/**/*.test.ts",
            "shared/**/*.test.ts",
            "components/**/*.test.ts",
            "hooks/**/*.test.ts",
            "app/**/*.test.ts",
            "evals/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
