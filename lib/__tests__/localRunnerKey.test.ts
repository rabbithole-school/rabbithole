// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  checkAnthropicKey,
  localRunnerKeySetup,
  loopbackHost,
  plausibleAnthropicKey,
  sameOriginPost,
  webServerOnLocalRunner,
} from "../localRunnerKey";

const LOCAL_ENV = {
  CONVEX_DEPLOYMENT: "anonymous:anonymous-agent",
  NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
};

describe("webServerOnLocalRunner", () => {
  test("only the anonymous local backend on loopback counts", () => {
    expect(webServerOnLocalRunner(LOCAL_ENV)).toBe(true);
    expect(
      webServerOnLocalRunner({ ...LOCAL_ENV, CONVEX_DEPLOYMENT: "dev:some-slug-123" }),
    ).toBe(false);
    expect(
      webServerOnLocalRunner({
        ...LOCAL_ENV,
        NEXT_PUBLIC_CONVEX_URL: "https://some-slug-123.convex.cloud",
      }),
    ).toBe(false);
    expect(
      webServerOnLocalRunner({ ...LOCAL_ENV, CONVEX_DEPLOY_KEY: "prod:anything" }),
    ).toBe(false);
  });

  test("off the local runner the setup is unavailable without asking Convex", async () => {
    await expect(
      localRunnerKeySetup({ CONVEX_DEPLOYMENT: "dev:some-slug-123" }),
    ).resolves.toEqual({ available: false });
  });
});

describe("request checks", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  test("the Host must be this computer's loopback name", () => {
    expect(loopbackHost(h({ host: "localhost:3000" }))).toBe(true);
    expect(loopbackHost(h({ host: "127.0.0.1:3000" }))).toBe(true);
    expect(loopbackHost(h({ host: "rebind.example:3000" }))).toBe(false);
    expect(loopbackHost(h({}))).toBe(false);
  });

  test("a POST must come from the page's own origin", () => {
    expect(
      sameOriginPost(h({ host: "localhost:3000", origin: "http://localhost:3000" })),
    ).toBe(true);
    expect(
      sameOriginPost(
        h({
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBe(true);
    expect(sameOriginPost(h({ host: "localhost:3000" }))).toBe(false);
    expect(
      sameOriginPost(h({ host: "localhost:3000", origin: "http://evil.example" })),
    ).toBe(false);
    expect(
      sameOriginPost(h({ host: "localhost:3000", origin: "http://localhost:3001" })),
    ).toBe(false);
    expect(
      sameOriginPost(
        h({
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toBe(false);
  });

  test("a key must be one token that can't break out of a stdin line", () => {
    expect(plausibleAnthropicKey("fake-anthropic-key-abcdefghijklmnopqrstuv_wx")).toBe(true);
    expect(plausibleAnthropicKey("")).toBe(false);
    expect(plausibleAnthropicKey("sk-ant-api03-abc\nOTHER=1xxxxxxxxxx")).toBe(false);
    expect(plausibleAnthropicKey("short")).toBe(false);
  });
});

describe("checkAnthropicKey", () => {
  const reply = (status: number) =>
    vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status }));

  test("sends the key as x-api-key to the models list", async () => {
    const fetchImpl = reply(200);
    await expect(checkAnthropicKey("sk-ant-test", fetchImpl)).resolves.toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
  });

  test("tells a refused key apart from an unreachable Anthropic", async () => {
    await expect(checkAnthropicKey("k", reply(401))).resolves.toBe("rejected");
    await expect(checkAnthropicKey("k", reply(529))).resolves.toBe("unreachable");
    await expect(
      checkAnthropicKey("k", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))),
    ).resolves.toBe("unreachable");
  });
});
