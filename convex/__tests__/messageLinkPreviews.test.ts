import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("messageLinkPreviews cache and rate bounds", () => {
  test("caches failures, keeps one in-flight claim, and rate-limits uncached URLs", async () => {
    const t = convexTest(schema, modules);
    const viewerId = await t.run((ctx) =>
      ctx.db.insert("users", { role: "parent", username: "preview-parent" }),
    );
    const url = "https://example.com/a";

    expect(
      await t.mutation(internal.messageLinkPreviewCache.claim, {
        url,
        viewerId,
        claimId: "first",
      }),
    ).toEqual({ kind: "fetch" });
    const pending = await t.mutation(internal.messageLinkPreviewCache.claim, {
      url,
      viewerId,
      claimId: "second",
    });
    expect(pending).toMatchObject({ kind: "pending" });
    if (pending.kind !== "pending") throw new Error("Expected an in-flight preview");
    // The client must keep polling after the old three-second retry window;
    // this claim can legitimately run for almost the full ten-second lease.
    expect(pending.retryAfterMs).toBeGreaterThan(3_000);
    expect(pending.retryAfterMs).toBeLessThanOrEqual(10_000);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 4_000);
    try {
      await t.mutation(internal.messageLinkPreviewCache.store, {
        url,
        claimId: "first",
        preview: {
          url,
          hostname: "example.com",
          title: "Example",
          description: null,
        },
      });
      expect(
        await t.mutation(internal.messageLinkPreviewCache.claim, {
          url,
          viewerId,
          claimId: "third",
        }),
      ).toMatchObject({ kind: "ready", preview: { title: "Example" } });
    } finally {
      vi.restoreAllMocks();
    }

    for (let count = 1; count < 6; count++) {
      expect(
        await t.mutation(internal.messageLinkPreviewCache.claim, {
          url: `https://example.com/${count}`,
          viewerId,
          claimId: `rate-${count}`,
        }),
      ).toEqual({ kind: "fetch" });
    }
    expect(
      await t.mutation(internal.messageLinkPreviewCache.claim, {
        url: "https://example.com/rate-limited",
        viewerId,
        claimId: "rate-limited",
      }),
    ).toEqual({ kind: "unavailable" });
  });
});
