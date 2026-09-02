import path from "node:path";
import { defineConfig } from "vitest/config";

// Native unit-test config. Most tests are pure logic; the GameHost smoke test
// uses react-test-renderer with focused platform mocks, never a simulator.
// Uses the repo-root vitest (symlinked node_modules) so native doesn't need
// its own vitest install.
export default defineConfig({
  resolve: {
    alias: {
      // Match native/tsconfig.json "@/*" → src/*
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
