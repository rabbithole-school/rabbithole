/**
 * Pins the vitest.setup.ts env strip: no real AI provider key may reach a
 * unit test. Without the strip, hermeticity is an accident of the invoking
 * shell — the AI clients fail soft when their key is absent, so a shell that
 * exports real keys would silently turn the suite into billed network calls.
 * If someone removes setupFiles from vitest.config.ts, this fails in any
 * shell that carries a key (and documents the invariant everywhere else).
 */
import { describe, expect, test } from "vitest";

describe("hermetic test environment", () => {
  test("AI provider keys are stripped before any suite runs", () => {
    for (const key of [
      "GEMINI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ] as const) {
      expect(
        process.env[key],
        `${key} must not leak into unit tests — see vitest.setup.ts`,
      ).toBeUndefined();
    }
  });
});
