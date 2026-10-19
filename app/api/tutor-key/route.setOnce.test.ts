// @vitest-environment node
// Set-once under concurrency: two POSTs racing on a keyless local runner save
// exactly one key; the second is refused like any later request.
import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ hasKey: false, saves: 0 }));

vi.mock("@/lib/localRunnerKey", () => ({
  loopbackHost: () => true,
  sameOriginPost: () => true,
  plausibleAnthropicKey: () => true,
  localRunnerKeySetup: async () => ({ available: !state.hasKey }),
  // A real round trip to Anthropic: long enough for the racing request to
  // pass its own first check if requests were not serialized.
  checkAnthropicKey: async () => {
    await new Promise((r) => setTimeout(r, 5));
    return "ok" as const;
  },
  // Saving takes a round trip too (an env write to the backend), so an
  // unserialized racer could pass its pre-save re-check before this lands.
  saveKeyToLocalBackend: async () => {
    await new Promise((r) => setTimeout(r, 5));
    state.saves += 1;
    state.hasKey = true;
    return true;
  },
}));

const { POST } = await import("./route");

function post() {
  return POST(
    new Request("http://localhost:3500/api/tutor-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "fake-anthropic-key-abcdefghijklmnopqrstuvwx" }),
    }),
  );
}

beforeEach(() => {
  state.hasKey = false;
  state.saves = 0;
});

describe("POST /api/tutor-key set-once", () => {
  test("concurrent requests save one key; the other gets 404", async () => {
    const [a, b] = await Promise.all([post(), post()]);

    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(state.saves).toBe(1);
  });

  test("a failed request does not wedge the next one", async () => {
    state.hasKey = true;
    expect((await post()).status).toBe(404);
    state.hasKey = false;
    expect((await post()).status).toBe(200);
  });
});
