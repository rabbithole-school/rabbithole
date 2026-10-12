// @vitest-environment node

import { APP_SNAPSHOT_MAX_BYTES } from "@/convex/lib/appSnapshot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveCustomAppByToken } from "../customAppData";
import { GET } from "./route";

vi.mock("../customAppData", () => ({
  resolveCustomAppByToken: vi.fn(),
}));

const resolveMock = vi.mocked(resolveCustomAppByToken);
const realFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();

describe("custom app OG route", () => {
  beforeEach(() => {
    resolveMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(realFetch);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("returns a PNG card for a live token without a stored thumbnail", async () => {
    resolveMock.mockResolvedValue({
      kind: "static",
      name: "Fraction Forge",
      status: "live",
      html: "<!doctype html>",
      origin: null,
      thumbnailUrl: null,
      appAssets: [],
    });

    const response = await GET(
      new Request("https://rabbithole.test/custom-apps/og?token=live-token"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600",
    );
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("passes through a stored PNG thumbnail within the byte limit", async () => {
    const thumbnailUrl = "https://storage.test/thumbnail.png";
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    resolveMock.mockResolvedValue({
      kind: "static",
      name: "Fraction Forge",
      status: "live",
      html: "<!doctype html>",
      origin: "starter",
      thumbnailUrl,
      appAssets: [],
    });
    fetchMock.mockImplementation((input, init) =>
      input === thumbnailUrl
        ? Promise.resolve(
            new Response(pngBytes, {
              headers: {
                "Content-Length": String(pngBytes.byteLength),
                "Content-Type": "image/png",
              },
            }),
          )
        : realFetch(input, init),
    );

    const response = await GET(
      new Request("https://rabbithole.test/custom-apps/og?token=live-token"),
    );

    expect(fetchMock).toHaveBeenCalledWith(thumbnailUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
  });

  test("returns a generated card when the stored thumbnail is HTML", async () => {
    const thumbnailUrl = "https://storage.test/thumbnail.png";
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveMock.mockResolvedValue({
      kind: "static",
      name: "Fraction Forge",
      status: "live",
      html: "<!doctype html>",
      origin: "starter",
      thumbnailUrl,
      appAssets: [],
    });
    fetchMock.mockImplementation((input, init) =>
      input === thumbnailUrl
        ? Promise.resolve(
            new Response("<!doctype html>", {
              headers: { "Content-Type": "text/html" },
            }),
          )
        : realFetch(input, init),
    );

    const response = await GET(
      new Request("https://rabbithole.test/custom-apps/og?token=live-token"),
    );

    expect(fetchMock).toHaveBeenCalledWith(thumbnailUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600",
    );
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(
      "<!doctype html>".length,
    );
    expect(warnMock).toHaveBeenCalledOnce();
  });

  test("returns a generated card when the stored thumbnail exceeds the byte limit", async () => {
    const thumbnailUrl = "https://storage.test/thumbnail.png";
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveMock.mockResolvedValue({
      kind: "static",
      name: "Fraction Forge",
      status: "live",
      html: "<!doctype html>",
      origin: "starter",
      thumbnailUrl,
      appAssets: [],
    });
    fetchMock.mockImplementation((input, init) =>
      input === thumbnailUrl
        ? Promise.resolve(
            new Response(new Uint8Array(APP_SNAPSHOT_MAX_BYTES + 1), {
              headers: { "Content-Type": "image/png" },
            }),
          )
        : realFetch(input, init),
    );

    const response = await GET(
      new Request("https://rabbithole.test/custom-apps/og?token=live-token"),
    );

    expect(fetchMock).toHaveBeenCalledWith(thumbnailUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect((await response.arrayBuffer()).byteLength).toBeLessThan(
      APP_SNAPSHOT_MAX_BYTES,
    );
    expect(warnMock).toHaveBeenCalledOnce();
  });

  test("returns the generic PNG fallback for an unknown token", async () => {
    resolveMock.mockResolvedValue(null);

    const response = await GET(
      new Request("https://rabbithole.test/custom-apps/og?token=unknown"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600",
    );
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
