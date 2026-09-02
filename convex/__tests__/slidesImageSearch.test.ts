import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { signState, verifyState } from "../lib/google";
import { emptyDeck, FIND_IMAGE_COPY } from "../../shared/slidesScene";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TEN_MB = 10 * 1024 * 1024;
// The signing secret readStateSecret() falls back to; set in every test that
// issues or verifies a pick token.
const SIGNING_SECRET = "test-signing-secret";

/** A valid pick token, as searchWebImages would have minted for these URLs. */
async function pickTokenFor(imageUrl: string, proxyUrl?: string) {
  return await signState({ imageUrl, proxyUrl }, SIGNING_SECRET);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Scholar ${username}`,
      username,
      role: "scholar",
    })
  );
}

async function seedDeck(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Web image deck",
      isArchived: false,
    });
    return await ctx.db.insert("artifacts", {
      sessionId,
      title: "Web image deck",
      content: JSON.stringify(emptyDeck("Web image deck", "slide-1")),
      lastEditedBy: "scholar",
      type: "slides",
    });
  });
}

const IMAGE_URL = "https://images.example.com/original.png";
const PROXY_URL = "https://imgs.search.brave.com/proxy.png";

/** A grid result as the client echoes it back, including a valid pick token. */
async function makeImageResult(overrides?: {
  imageUrl?: string;
  proxyUrl?: string;
  pickToken?: string;
}) {
  const imageUrl = overrides?.imageUrl ?? IMAGE_URL;
  // Honor an EXPLICIT `proxyUrl: undefined` (no fallback), which `?? PROXY_URL`
  // would silently replace.
  const proxyUrl =
    overrides && "proxyUrl" in overrides ? overrides.proxyUrl : PROXY_URL;
  return {
    resultId: "brave-0",
    thumbnailUrl: PROXY_URL,
    imageUrl,
    proxyUrl,
    width: 1200,
    height: 800,
    title: "Saturn V launch",
    sourceHost: "example.com",
    pickToken: overrides?.pickToken ?? (await pickTokenFor(imageUrl, proxyUrl)),
  };
}

describe("slide web image search", () => {
  test("refuses unauthenticated searches", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "unauthenticated-owner");
    const artifactId = await seedDeck(t, ownerId);

    const result = await t.action(api.slidesImageSearch.searchWebImages, {
      artifactId,
      query: "Saturn V",
    });

    expect(result).toMatchObject({ status: "error" });
  });

  test("refuses a non-owner artifact before calling Brave", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "deck-owner");
    const otherId = await seedScholar(t, "other-scholar");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t
      .withIdentity({ subject: otherId })
      .action(api.slidesImageSearch.searchWebImages, {
        artifactId,
        query: "Saturn V",
      });

    expect(result).toMatchObject({ status: "error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns capped after 60 searches in the hourly window", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "rate-capped");
    const artifactId = await seedDeck(t, ownerId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("slideImageSearchAttempts", {
          uploaderId: ownerId,
        });
      }
    });
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.searchWebImages, {
        artifactId,
        query: "one more",
      });

    expect(result).toEqual({ status: "capped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns unavailable when the Brave key is missing", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "missing-key");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.searchWebImages, {
        artifactId,
        query: "Saturn V",
      });

    expect(result).toEqual({ status: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("maps Brave image results and skips malformed rows", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "brave-results");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    vi.stubEnv("JWT_PRIVATE_KEY", SIGNING_SECRET);
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({
        results: [
          {
            title: "Saturn V launch",
            url: "https://www.nasa.gov/history/saturn-v",
            source: "NASA",
            thumbnail: {
              src: "https://imgs.search.brave.com/saturn-v.jpg",
            },
            properties: {
              url: "https://images.nasa.gov/saturn-v-original.jpg",
              width: 2048,
              height: 1365,
            },
          },
          {
            title: "Missing image URLs",
            url: "https://example.com/broken",
            thumbnail: {},
            properties: {},
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.searchWebImages, {
        artifactId,
        query: "  Saturn V launch  ",
      });

    expect(result.status).toBe("results");
    if (result.status !== "results") throw new Error("expected results");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      resultId: "brave-0",
      thumbnailUrl: "https://imgs.search.brave.com/saturn-v.jpg",
      imageUrl: "https://images.nasa.gov/saturn-v-original.jpg",
      proxyUrl: "https://imgs.search.brave.com/saturn-v.jpg",
      width: 2048,
      height: 1365,
      title: "Saturn V launch",
      sourceHost: "www.nasa.gov",
      pickToken: expect.any(String),
    });
    // The token seals the real downloadable URLs, so a pick can only fetch them.
    const sealed = await verifyState<{ imageUrl: string; proxyUrl?: string }>(
      result.results[0].pickToken,
      SIGNING_SECRET,
    );
    expect(sealed).toMatchObject({
      imageUrl: "https://images.nasa.gov/saturn-v-original.jpg",
      proxyUrl: "https://imgs.search.brave.com/saturn-v.jpg",
    });
    const [requestUrl, requestInit] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const url = new URL(String(requestUrl));
    expect(url.searchParams.get("q")).toBe("Saturn V launch");
    expect(url.searchParams.get("safesearch")).toBe("strict");
    expect(url.searchParams.get("count")).toBe("100");
    expect(requestInit).toMatchObject({
      method: "GET",
      headers: {
        "X-Subscription-Token": "test-key",
        Accept: "application/json",
      },
    });
  });
});

describe("picking a web image", () => {
  test("stores the image and registers web-search provenance", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "image-picker");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("JWT_PRIVATE_KEY", SIGNING_SECRET);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "4",
        },
      })
    ));

    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.pickWebImage, {
        artifactId,
        query: "  Saturn V launch  ",
        image: await makeImageResult(),
      });

    expect(result).toEqual({
      status: "inserted",
      storageId: expect.any(String),
      width: 1200,
      height: 800,
    });
    if (result.status !== "inserted") throw new Error("expected inserted image");
    const asset = await t.run((ctx) =>
      ctx.db
        .query("slideAssets")
        .withIndex("by_storage", (q) => q.eq("storageId", result.storageId))
        .unique()
    );
    expect(asset).toMatchObject({
      storageId: result.storageId,
      uploaderId: ownerId,
      source: "webSearch",
      searchQuery: "Saturn V launch",
      sourceUrl: IMAGE_URL,
    });
    const storedType = await t.run(async (ctx) =>
      (await ctx.storage.get(result.storageId))?.type
    );
    expect(storedType).toBe("image/png");
  });

  test("falls back to the Brave proxy when the original returns HTML", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "proxy-fallback");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("JWT_PRIVATE_KEY", SIGNING_SECRET);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === IMAGE_URL) {
        return new Response("<html>blocked</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response(new Uint8Array([255, 216, 255]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.pickWebImage, {
        artifactId,
        query: "Saturn V launch",
        image: await makeImageResult(),
      });

    expect(result).toMatchObject({ status: "inserted" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(IMAGE_URL);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(PROXY_URL);
  });

  test("does NOT follow a redirect on the original (SSRF via 3xx)", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "redirect-image");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("JWT_PRIVATE_KEY", SIGNING_SECRET);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === IMAGE_URL) {
        // A public URL that 302s toward an internal host. With redirect:"manual"
        // this surfaces as a 3xx and must NOT be followed.
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response(new Uint8Array([255, 216, 255]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.pickWebImage, {
        artifactId,
        query: "redirect",
        image: await makeImageResult(),
      });

    // The original 302s → treated as failure → falls back to the brave proxy.
    expect(result).toMatchObject({ status: "inserted" });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(IMAGE_URL);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(PROXY_URL);
    // The internal metadata host was never fetched.
    expect(
      fetchSpy.mock.calls.some((c) =>
        String(c[0]).includes("169.254.169.254")
      )
    ).toBe(false);
  });

  test("refuses a tampered pick token without fetching anything", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "tampered-token");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("JWT_PRIVATE_KEY", SIGNING_SECRET);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // Client swaps in an internal URL but the token was never signed for it.
    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.pickWebImage, {
        artifactId,
        query: "ssrf",
        image: await makeImageResult({
          imageUrl: "http://169.254.169.254/latest/meta-data/",
          pickToken: "forged.token",
        }),
      });

    expect(result).toEqual({
      status: "error",
      error: FIND_IMAGE_COPY.insertErrorFallback,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const assets = await t.run((ctx) => ctx.db.query("slideAssets").collect());
    expect(assets).toHaveLength(0);
  });

  test("refuses even a validly-signed private-network URL", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "signed-internal");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("JWT_PRIVATE_KEY", SIGNING_SECRET);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // Defense in depth: even a token we did sign is refused if it points inside
    // the private network (no proxy fallback → hard error, nothing fetched).
    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.pickWebImage, {
        artifactId,
        query: "ssrf",
        image: await makeImageResult({
          imageUrl: "http://10.0.0.5:6379/",
          proxyUrl: undefined,
        }),
      });

    expect(result).toMatchObject({ status: "error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects an image whose actual body exceeds 10 MB", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "oversize-image");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("JWT_PRIVATE_KEY", SIGNING_SECRET);
    // No Content-Length header → the streaming byte-ceiling must still catch it.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(new Uint8Array(TEN_MB + 1), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    ));

    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.pickWebImage, {
        artifactId,
        query: "huge image",
        image: await makeImageResult({ proxyUrl: undefined }),
      });

    expect(result).toEqual({
      status: "error",
      error: FIND_IMAGE_COPY.insertErrorFallback,
    });
    const assets = await t.run((ctx) => ctx.db.query("slideAssets").collect());
    expect(assets).toHaveLength(0);
  });

  test("picks consume the hourly rate budget", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "pick-capped");
    const artifactId = await seedDeck(t, ownerId);
    vi.stubEnv("JWT_PRIVATE_KEY", SIGNING_SECRET);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("slideImageSearchAttempts", { uploaderId: ownerId });
      }
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t
      .withIdentity({ subject: ownerId })
      .action(api.slidesImageSearch.pickWebImage, {
        artifactId,
        query: "over budget",
        image: await makeImageResult(),
      });

    expect(result).toMatchObject({ status: "error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
