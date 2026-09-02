import { describe, expect, test } from "vitest";
import {
  fetchMessageLinkPreview,
  isPublicInternetAddress,
  validatePreviewUrl,
} from "../messageLinkPreview";

const publicLookup = async () => [{ address: "8.8.8.8", family: 4 as const }];
const html = `<!doctype html><html><head>
  <title> A safe title </title>
  <meta name="description" content="A short description.">
</head></html>`;
type CapturedRequestInit = RequestInit & { dispatcher?: unknown };

describe("message link preview URL and address validation", () => {
  test("rejects non-HTTPS URLs, credentials, literals, and local hosts", () => {
    for (const value of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://printer.local",
    ]) {
      expect(() => validatePreviewUrl(value)).toThrow();
    }
  });

  test("rejects loopback, private, link-local, ULA, multicast, and reserved DNS answers", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::a00:1",
      "2002:a00:1::",
    ]) {
      expect(isPublicInternetAddress(address), address).toBe(false);
    }
    expect(isPublicInternetAddress("8.8.8.8")).toBe(true);
    expect(isPublicInternetAddress("2606:4700:4700::1111")).toBe(true);
  });
});

describe("fetchMessageLinkPreview", () => {
  test("pins a validated public DNS address, manually follows a canonical redirect, bounds time, and sanitizes metadata", async () => {
    let init: CapturedRequestInit | undefined;
    let calls = 0;
    const preview = await fetchMessageLinkPreview("https://example.com/a", {
      lookup: publicLookup,
      fetch: (async (_url: unknown, requestInit?: CapturedRequestInit) => {
        init = requestInit;
        calls += 1;
        if (calls === 1) {
          return new Response(null, {
            status: 301,
            headers: { location: "https://www.example.com/a" },
          });
        }
        return new Response(html, {
          headers: { "content-type": "text/html" },
        });
      }) as never,
    });

    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.dispatcher).toBeDefined();
    expect(preview).toEqual({
      url: "https://www.example.com/a",
      hostname: "www.example.com",
      title: "A safe title",
      description: "A short description.",
    });
  });

  test("fails closed for off-site and authentication redirects, plus non-HTML responses", async () => {
    const reject = async (response: Response) =>
      fetchMessageLinkPreview("https://example.com/a", {
        lookup: publicLookup,
        fetch: (async () => response) as never,
      });

    await expect(
      reject(new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } })),
    ).rejects.toThrow(/redirect target/i);
    await expect(
      reject(
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/login" },
        }),
      ),
    ).rejects.toThrow(/redirect target/i);
    await expect(
      reject(new Response("not html", { headers: { "content-type": "image/png" } })),
    ).rejects.toThrow(/HTML/i);
  });

  test("parses metadata from a bounded HTML prefix even when the declared page is larger", async () => {
    await expect(
      fetchMessageLinkPreview("https://example.com/a", {
        lookup: publicLookup,
        fetch: (async () =>
          new Response(`${html}${"x".repeat(300 * 1024)}`, {
            headers: {
              "content-type": "text/html",
              "content-length": String(300 * 1024),
            },
          })) as never,
      }),
    ).resolves.toMatchObject({
      title: "A safe title",
      description: "A short description.",
    });
  });

  test("stops reading after the bounded HTML prefix", async () => {
    await expect(
      fetchMessageLinkPreview("https://example.com/a", {
        lookup: publicLookup,
        fetch: (async () =>
          new Response("<html><head><title>A safe title</title></head>".padEnd(300 * 1024, "x"), {
            headers: {
              "content-type": "text/html",
            },
          })) as never,
      }),
    ).resolves.toMatchObject({
      title: "A safe title",
    });
  });

  test("omits a card when metadata has no safe title", async () => {
    await expect(
      fetchMessageLinkPreview("https://example.com/a", {
        lookup: publicLookup,
        fetch: (async () =>
          new Response("<html><head></head><body>Nothing</body></html>", {
            headers: { "content-type": "text/html" },
          })) as never,
      }),
    ).resolves.toBeNull();
  });
});
