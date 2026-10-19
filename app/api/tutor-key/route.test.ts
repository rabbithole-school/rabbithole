// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { POST } from "./route";

const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function post(host: string) {
  return POST(
    new Request(`http://${host}/api/tutor-key`, {
      method: "POST",
      headers: {
        host,
        origin: `http://${host}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ key: "fake-anthropic-key-abcdefghijklmnopqrstuvwx" }),
    }),
  );
}

describe("POST /api/tutor-key", () => {
  test("is a 404 on a deployment that isn't the local runner", async () => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONVEX_DEPLOYMENT", "dev:some-slug-123");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://some-slug-123.convex.cloud");

    const res = await post("localhost:3000");

    expect(res.status).toBe(404);
    // Refused before the key went anywhere: not to Anthropic, not to Convex.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("is a 404 for a request addressed to a non-loopback name", async () => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONVEX_DEPLOYMENT", "anonymous:anonymous-agent");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "http://127.0.0.1:3210");

    const res = await post("rebind.example:3000");

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
