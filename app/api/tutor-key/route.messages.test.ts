// @vitest-environment node
// What the page says when the key check fails: Anthropic's own words for a
// key it answered about, and a plain "couldn't reach" only when it didn't answer.
import { describe, expect, test, vi } from "vitest";
import type { KeyCheck } from "@/lib/localRunnerKey";

const state = vi.hoisted(() => ({
  check: { kind: "ok" } as KeyCheck,
  saves: 0,
}));

vi.mock("@/lib/localRunnerKey", () => ({
  loopbackHost: () => true,
  sameOriginPost: () => true,
  plausibleAnthropicKey: () => true,
  localRunnerKeySetup: async () => ({ available: true }),
  checkAnthropicKey: async () => state.check,
  saveKeyToLocalBackend: async () => {
    state.saves += 1;
    return true;
  },
}));

const { POST } = await import("./route");

async function postWith(check: KeyCheck) {
  state.check = check;
  const res = await POST(
    new Request("http://localhost:3500/api/tutor-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "fake-anthropic-key-abcdefghijklmnopqrstuvwx" }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

describe("POST /api/tutor-key failure messages", () => {
  test("a key Anthropic refused shows Anthropic's message", async () => {
    const message =
      "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.";
    await expect(postWith({ kind: "rejected", message })).resolves.toEqual({
      status: 400,
      body: { error: `Anthropic didn't accept that key: ${message}` },
    });
    expect(state.saves).toBe(0);
  });

  test("no answer from Anthropic says this computer couldn't reach it", async () => {
    const { status, body } = await postWith({ kind: "unreachable", reason: "ENOTFOUND" });
    expect(status).toBe(502);
    expect(body.error).toBe(
      "This computer's Rabbithole couldn't reach Anthropic: ENOTFOUND. Try again in a moment.",
    );
    expect(state.saves).toBe(0);
  });
});
