import { build } from "esbuild";
import { afterEach, describe, expect, test, vi } from "vitest";
import { requireAnthropicApiKey } from "../lib/anthropic";

describe("@anthropic-ai/sdk isolate compatibility", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("requires a non-empty API key before constructing a client", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "  test-key  ");
    expect(requireAnthropicApiKey()).toBe("test-key");

    vi.stubEnv("ANTHROPIC_API_KEY", " ");
    expect(requireAnthropicApiKey).toThrow(
      "ANTHROPIC_API_KEY must be set for Anthropic requests",
    );
  });

  test("bundles a value import for Convex's browser isolate", async () => {
    await expect(
      build({
        stdin: {
          contents: 'import Anthropic from "@anthropic-ai/sdk"; void Anthropic;',
          resolveDir: process.cwd(),
          sourcefile: "anthropic-sdk-isolate-probe.ts",
        },
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
      }),
    ).resolves.toMatchObject({ errors: [] });
  });
});
