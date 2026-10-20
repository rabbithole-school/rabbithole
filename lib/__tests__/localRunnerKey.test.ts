// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const KEY = "fake-anthropic-key-secretsecretsecret";
  const reply = (status: number, body: unknown = {}) =>
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const anthropicError = (type: string, message: string) => ({
    type: "error",
    error: { type, message },
  });
  const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  test("sends the key as x-api-key to the models list", async () => {
    quietWarn();
    const fetchImpl = reply(200);
    await expect(checkAnthropicKey(KEY, fetchImpl)).resolves.toEqual({ kind: "ok" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
  });

  test("any HTTP error carries Anthropic's own message", async () => {
    quietWarn();
    const workspace =
      "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.";
    await expect(
      checkAnthropicKey(KEY, reply(400, anthropicError("invalid_request_error", workspace))),
    ).resolves.toEqual({ kind: "rejected", message: workspace });
    await expect(
      checkAnthropicKey(KEY, reply(401, anthropicError("authentication_error", "invalid x-api-key"))),
    ).resolves.toEqual({ kind: "rejected", message: "invalid x-api-key" });
    // A body that isn't Anthropic's error shape still names the status.
    await expect(checkAnthropicKey(KEY, reply(403, "nope"))).resolves.toEqual({
      kind: "rejected",
      message: "HTTP 403",
    });
  });

  test("rate limits and overload are busy, not a rejected key", async () => {
    quietWarn();
    await expect(
      checkAnthropicKey(KEY, reply(529, anthropicError("overloaded_error", "Overloaded"))),
    ).resolves.toEqual({ kind: "busy", message: "Overloaded" });
    await expect(
      checkAnthropicKey(KEY, reply(429, anthropicError("rate_limit_error", "Rate limited"))),
    ).resolves.toEqual({ kind: "busy", message: "Rate limited" });
    await expect(checkAnthropicKey(KEY, reply(500, "nope"))).resolves.toEqual({
      kind: "busy",
      message: "HTTP 500",
    });
  });

  test("the message is one bounded line of plain text", async () => {
    quietWarn();
    const result = await checkAnthropicKey(
      KEY,
      reply(400, anthropicError("invalid_request_error", `line one\nline two\u0007 ${"x".repeat(1000)}`)),
    );
    expect(result.kind).toBe("rejected");
    const message = result.kind === "rejected" ? result.message : "";
    expect(message.startsWith("line one line two ")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message).not.toMatch(/[\n\u0007]/);
  });

  test("only a failure to get any answer is unreachable", async () => {
    quietWarn();
    const offline = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), {
        code: "ENOTFOUND",
      }),
    });
    await expect(
      checkAnthropicKey(KEY, vi.fn<typeof fetch>().mockRejectedValue(offline)),
    ).resolves.toEqual({ kind: "unreachable", reason: "ENOTFOUND" });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    await expect(
      checkAnthropicKey(KEY, vi.fn<typeof fetch>().mockRejectedValue(timeout)),
    ).resolves.toEqual({ kind: "unreachable", reason: "no answer within 15 seconds" });
  });

  test("logs the status and Anthropic's error, never the key", async () => {
    const warn = quietWarn();
    await checkAnthropicKey(
      KEY,
      reply(400, anthropicError("invalid_request_error", "not scoped to a workspace")),
    );
    await checkAnthropicKey(KEY, reply(200));
    await checkAnthropicKey(KEY, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    const lines = warn.mock.calls.map((args) => args.join(" "));
    expect(lines[0]).toBe(
      "[tutor-key] key check: Anthropic answered HTTP 400 invalid_request_error: not scoped to a workspace",
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).not.toContain(KEY);
  });
});
