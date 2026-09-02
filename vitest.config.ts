import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Match tsconfig's "@/*" → repo root so app-code imports work in tests.
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    reporters: ["default"],
    environment: "edge-runtime",
    setupFiles: ["./vitest.setup.ts"],
    env: {
      SITE_URL: "https://rabbithole.test",
      AUTH_EMAIL_FROM: "Rabbithole <no-reply@rabbithole.test>",
    },
    server: { deps: { inline: ["convex-test"] } },
    // `app/**` is included for PURE logic colocated with a route (e.g. the
    // /school shell's per-role nav filtering) — React component behavior is
    // still verified in a browser, not here.
    include: ["convex/**/*.test.ts", "lib/**/*.test.ts", "shared/**/*.test.ts", "components/**/*.test.ts", "hooks/**/*.test.ts", "app/**/*.test.ts", "evals/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
