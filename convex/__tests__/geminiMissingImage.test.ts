import { afterEach, describe, expect, it, vi } from "vitest";
import { describeMissingImage, geminiGenerateImage } from "../lib/gemini";

describe("describeMissingImage", () => {
  it("names a safety block on the prompt", () => {
    expect(
      describeMissingImage({ promptFeedback: { blockReason: "SAFETY" } }),
    ).toBe("blockReason=SAFETY, no candidates");
  });

  it("names the finish reason and the text the model sent instead", () => {
    expect(
      describeMissingImage({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "I can't edit this photo." }] },
          },
        ],
      }),
    ).toBe('finishReason=STOP, text="I can\'t edit this photo."');
  });

  it("survives a malformed body", () => {
    expect(describeMissingImage(null)).toBe("no candidates");
    expect(describeMissingImage({ candidates: [{}] })).toBe("empty response");
    expect(
      describeMissingImage({
        candidates: [
          { finishReason: "SAFETY", finishMessage: 42, content: { parts: [null, 7] } },
        ],
      }),
    ).toBe("finishReason=SAFETY");
  });
});

describe("geminiGenerateImage onFailure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reports why a 200 carried no image", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ candidates: [{ finishReason: "IMAGE_SAFETY" }] }),
          { status: 200 },
        ),
      ),
    );
    const reasons: string[] = [];
    const result = await geminiGenerateImage([{ text: "paint" }], {
      onFailure: (r) => reasons.push(r),
    });
    expect(result).toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("returned no image: finishReason=IMAGE_SAFETY");
  });

  it("reports an HTTP error with its status", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("overloaded", { status: 503 })),
    );
    const reasons: string[] = [];
    await geminiGenerateImage([{ text: "paint" }], {
      onFailure: (r) => reasons.push(r),
    });
    expect(reasons[0]).toContain("HTTP 503: overloaded");
  });
});
