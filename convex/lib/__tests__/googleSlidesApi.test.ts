import { afterEach, describe, expect, test } from "vitest";
import {
  GoogleSlidesApiError,
  StalePresentationRevisionError,
  batchUpdatePresentation,
  getPresentation,
} from "../googleSlidesApi";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init));
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = realFetch; };
  return calls;
}

describe("Google Slides API client", () => {
  test("gets presentations and sends required revision control on batch updates", async () => {
    const calls = stubFetch((url, init) => {
      if (url.endsWith("/presentations/deck-1")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
        return json({ presentationId: "deck-1", revisionId: "r1" });
      }
      expect(url).toBe("https://slides.googleapis.com/v1/presentations/deck-1:batchUpdate");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        requests: [{ insertText: { objectId: "shape-1", insertionIndex: 0, text: "Hi" } }],
        writeControl: { requiredRevisionId: "r1" },
      });
      return json({ writeControl: { requiredRevisionId: "r2" } });
    });

    await expect(getPresentation("token", "deck-1")).resolves.toMatchObject({ revisionId: "r1" });
    await expect(
      batchUpdatePresentation("token", "deck-1", [
        { insertText: { objectId: "shape-1", insertionIndex: 0, text: "Hi" } },
      ], "r1"),
    ).resolves.toMatchObject({ writeControl: { requiredRevisionId: "r2" } });
    expect(calls).toHaveLength(2);
  });

  test("classifies Google failed-precondition revision errors as stale", async () => {
    stubFetch(() => json({
      error: { code: 400, status: "FAILED_PRECONDITION", message: "stale revision" },
    }, 400));
    await expect(batchUpdatePresentation("token", "deck-1", [], "r1"))
      .rejects.toBeInstanceOf(StalePresentationRevisionError);
  });

  test("keeps other Google failures as typed API errors", async () => {
    stubFetch(() => json({
      error: { code: 403, status: "PERMISSION_DENIED", message: "no access" },
    }, 403));
    await expect(getPresentation("token", "deck-1")).rejects.toMatchObject({
      name: "GoogleSlidesApiError",
      status: 403,
    } satisfies Partial<GoogleSlidesApiError>);
  });
});
