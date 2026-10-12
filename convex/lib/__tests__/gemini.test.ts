/**
 * geminiGenerateImage (convex/lib/gemini.ts) is the single entry point every
 * image-generation caller shares (the tutor's generate_image tool, Magic
 * annotation, marketing art, …). Since PR #3962 a tutor turn heartbeats for
 * its whole life, so a hung Gemini fetch no longer surfaces as a Convex
 * action timeout — the composer just reads "pending" forever unless the
 * fetch itself gives up. This pins that: a fetch that never settles must
 * still resolve (to null, the documented failure contract) within
 * GEMINI_FETCH_TIMEOUT_MS.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { GEMINI_FETCH_TIMEOUT_MS, geminiGenerateImage } from "../gemini";

/**
 * Models a real hung `fetch`: the returned promise never settles on its own,
 * but rejects once the request's abort signal fires — exactly what the
 * platform does, not a hand-rolled stand-in.
 */
function stubHangingFetch() {
  const impl = vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

describe("geminiGenerateImage timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.GEMINI_API_KEY;
  });

  test("gives up within GEMINI_FETCH_TIMEOUT_MS instead of hanging forever", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.useFakeTimers();
    const fetchImpl = stubHangingFetch();

    const promise = geminiGenerateImage([{ text: "a fox reading a book" }]);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // Just under the timeout: the fetch is still hanging, so the helper must
    // not have resolved yet.
    await vi.advanceTimersByTimeAsync(GEMINI_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    // Crossing the timeout aborts the controller, which rejects the hanging
    // fetch — the same failure path as any other network error.
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result).toBeNull();
    expect(settled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("clears its timer once the response is read", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })),
    );

    expect(await geminiGenerateImage([{ text: "a fox" }])).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
