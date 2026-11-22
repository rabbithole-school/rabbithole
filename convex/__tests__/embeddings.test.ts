/**
 * The shared embedding helper (lib/embeddings.ts): a failed request throws
 * the status only, never the provider's body or the key, since an auth error
 * can echo the request and errors reach logs; and a slow provider is cut off
 * after EMBED_TIMEOUT_MS with a fixed message.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  embedBatch,
  embedTexts,
  EMBED_DIMS,
  EMBED_MODEL,
  EMBED_NETWORK_MESSAGE,
  EMBED_TIMEOUT_MESSAGE,
  EMBED_TIMEOUT_MS,
} from "../lib/embeddings";

const FAKE_KEY = "sk-test-not-a-real-key-0123456789";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A transport that answers only when aborted, as a stalled provider does. */
function stalledFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException(`aborted while sending ${FAKE_KEY}`, "AbortError")),
        );
      }),
  );
}

describe("embedBatch timeouts", () => {
  test("a provider that never answers is cut off after the timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stalledFetch());
    const pending = embedBatch(["a question"], FAKE_KEY).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = (await pending) as Error;
    expect(error.message).toBe(EMBED_TIMEOUT_MESSAGE);
    expect(error.message).not.toContain(FAKE_KEY);
  });

  test("a body that stalls after the headers is cut off too", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        });
        return new Response(body, { status: 200 });
      }),
    );
    const pending = embedBatch(["a question"], FAKE_KEY).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS);
    expect(((await pending) as Error).message).toBe(EMBED_TIMEOUT_MESSAGE);
  });

  test("a network failure carries a fixed message, not the transport's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed for Bearer ${FAKE_KEY}`);
      }),
    );
    const error = (await embedBatch(["a question"], FAKE_KEY).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(EMBED_NETWORK_MESSAGE);
  });
});

describe("embedBatch", () => {
  test("an error carries the status and nothing from the body or the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } }),
            { status: 401 },
          ),
      ),
    );
    const error = await embedBatch(["a question"], FAKE_KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("401");
    expect(message).not.toContain(FAKE_KEY);
    expect(message).not.toContain("Incorrect");
  });

  test("asks for the shared model and size, one vector per text", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await embedTexts(["one", "two"], FAKE_KEY)).toEqual([
      [1, 0],
      [0, 1],
    ]);
    const init = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init[1].body as string)).toMatchObject({
      model: EMBED_MODEL,
      dimensions: EMBED_DIMS,
      input: ["one", "two"],
    });
  });
});
