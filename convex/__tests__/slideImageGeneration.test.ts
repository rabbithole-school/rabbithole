import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { emptyDeck } from "../../shared/slidesScene";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedScholars(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const firstId = await ctx.db.insert("users", {
      name: "Kai Kahale",
      username: "kai-generated-slide-image",
      role: "scholar",
    });
    const secondId = await ctx.db.insert("users", {
      name: "Lani Kahale",
      username: "lani-generated-slide-image",
      role: "scholar",
    });
    const firstSessionId = await ctx.db.insert("sessions", {
      userId: firstId,
      title: "Volcano deck",
      isArchived: false,
    });
    const firstArtifactId = await ctx.db.insert("artifacts", {
      sessionId: firstSessionId,
      title: "Volcano deck",
      content: JSON.stringify(emptyDeck("Volcano deck", "sl1")),
      lastEditedBy: "scholar",
      type: "slides",
    });
    const secondSessionId = await ctx.db.insert("sessions", {
      userId: secondId,
      title: "Ocean deck",
      isArchived: false,
    });
    return { firstId, firstArtifactId, secondId, secondSessionId };
  });
}

async function seedDeck(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  activityId?: Id<"activities">,
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      activityId,
      title: "Generated image deck",
      isArchived: false,
    });
    return await ctx.db.insert("artifacts", {
      sessionId,
      title: "Generated image deck",
      content: JSON.stringify(emptyDeck("Generated image deck", "sl1")),
      lastEditedBy: "scholar",
      type: "slides",
    });
  });
}

function stubGeneratedImage() {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  const fetch = vi.fn(async (
    input: string | URL | Request,
    _init?: RequestInit,
  ) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.includes("api.anthropic.com")) {
      // The Haiku authorship classifier that once sat before generation was
      // deleted (13/13 false positives in production). A reappearing Anthropic
      // call here means a model-in-the-middle came back — fail loudly.
      throw new Error(
        "slide image generation must not call Anthropic — the authorship classifier was removed",
      );
    }
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
            },
          }],
        },
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("scholar slide image generation", () => {
  test("stores the generated image and registers it to the caller", async () => {
    const t = convexTest(schema, modules);
    const { firstId, firstArtifactId } = await seedScholars(t);
    const fetch = stubGeneratedImage();

    const result = await t
      .withIdentity({ subject: firstId })
      .action(api.artifacts.scholarGenerateSlideImage, {
        artifactId: firstArtifactId,
        prompt: "  A cutaway drawing of a volcano  ",
      });

    expect(result).toEqual({
      status: "generated",
      storageId: expect.any(String),
    });
    if (result.status !== "generated") throw new Error("expected an image storage id");
    const asset = await t.run(async (ctx) =>
      ctx.db
        .query("slideAssets")
        .withIndex("by_storage", (q) => q.eq("storageId", result.storageId!))
        .unique(),
    );
    expect(asset).toMatchObject({
      storageId: result.storageId,
      uploaderId: firstId,
    });
    const storedType = await t.run(async (ctx) =>
      (await ctx.storage.get(result.storageId!))?.type ?? null,
    );
    expect(storedType).toBe("image/png");

    const [, requestInit] = vi.mocked(fetch).mock.calls[0] as unknown as [
      string,
      { body?: unknown },
    ];
    const request = JSON.parse(String(requestInit?.body));
    expect(request.contents[0].parts[0].text).toContain(
      "A cutaway drawing of a volcano",
    );
    expect(request.contents[0].parts[0].text).toContain(
      "Do not correct, normalize, improve, replace, or add conceptual content.",
    );
    expect(request.generationConfig).toEqual({
      responseModalities: ["IMAGE", "TEXT"],
    });
  });

  test("returns a friendly error when Gemini returns no image", async () => {
    const t = convexTest(schema, modules);
    const { firstId, firstArtifactId } = await seedScholars(t);
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "no image" }] } }] }),
      text: async () => "",
    })));

    await expect(
      t.withIdentity({ subject: firstId }).action(
        api.artifacts.scholarGenerateSlideImage,
        { artifactId: firstArtifactId, prompt: "A friendly moon rover" },
      ),
    ).resolves.toEqual({
      status: "error",
      error: "I couldn't make that picture. Try changing the description.",
    });
    expect(await t.run((ctx) => ctx.db.query("slideAssets").collect())).toEqual([]);
  });

  test("distinguishes an unavailable service without calling Gemini", async () => {
    const t = convexTest(schema, modules);
    const { firstId, firstArtifactId } = await seedScholars(t);
    vi.stubEnv("GEMINI_API_KEY", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      t.withIdentity({ subject: firstId }).action(
        api.artifacts.scholarGenerateSlideImage,
        { artifactId: firstArtifactId, prompt: "A crystal cave" },
      ),
    ).resolves.toEqual({
      status: "error",
      error: "Picture making is not available right now.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a generated asset cannot be placed on another scholar's deck", async () => {
    const t = convexTest(schema, modules);
    const { firstId, firstArtifactId, secondId, secondSessionId } =
      await seedScholars(t);
    stubGeneratedImage();
    const generated = await t
      .withIdentity({ subject: firstId })
      .action(api.artifacts.scholarGenerateSlideImage, {
        artifactId: firstArtifactId,
        prompt: "A deep-sea submarine",
      });
    if (generated.status !== "generated") {
      throw new Error("expected an image storage id");
    }

    const deck = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId: secondSessionId,
      deckJson: JSON.stringify(emptyDeck("Ocean", "sl1")),
    });
    if (!("artifactId" in deck)) throw new Error("expected a deck");

    await expect(
      t.withIdentity({ subject: secondId }).mutation(
        api.artifacts.scholarApplySlideOps,
        {
          artifactId: deck.artifactId!,
          ops: JSON.stringify([{
            op: "addElement",
            slideId: "sl1",
            element: {
              type: "image",
              assetId: generated.storageId,
              frame: { x: 80, y: 60, w: 480, h: 320, rotation: 0 },
              alt: "A deep-sea submarine",
            },
          }]),
        },
      ),
    ).rejects.toThrow("That media isn't available to this deck.");
  });

  test("rejects oversized prompts before spending on generation", async () => {
    const t = convexTest(schema, modules);
    const { firstId, firstArtifactId } = await seedScholars(t);
    const fetch = stubGeneratedImage();

    await expect(
      t.withIdentity({ subject: firstId }).action(
        api.artifacts.scholarGenerateSlideImage,
        { artifactId: firstArtifactId, prompt: "x".repeat(501) },
      ),
    ).resolves.toEqual({
      status: "error",
      error: "Please use 500 characters or fewer.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("binds generation to a deck owned by the caller", async () => {
    const t = convexTest(schema, modules);
    const { firstArtifactId, secondId } = await seedScholars(t);
    const fetch = stubGeneratedImage();

    await expect(
      t.withIdentity({ subject: secondId }).action(
        api.artifacts.scholarGenerateSlideImage,
        { artifactId: firstArtifactId, prompt: "A borrowed volcano deck" },
      ),
    ).resolves.toEqual({
      status: "error",
      error: "That slide deck isn't available to make a picture.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("gives pre-update clients a legible error without generating", async () => {
    const t = convexTest(schema, modules);
    const { firstId } = await seedScholars(t);
    const fetch = stubGeneratedImage();

    await expect(
      t.withIdentity({ subject: firstId }).action(
        api.artifacts.scholarGenerateSlideImage,
        { prompt: "A volcano" },
      ),
    ).resolves.toEqual({
      status: "error",
      error: "This version needs an update before it can make pictures.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sends the faithful prompt straight to Gemini — no classifier, no alert", async () => {
    const t = convexTest(schema, modules);
    const { firstId } = await seedScholars(t);
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        title: "Food web model",
        kind: "online",
        order: 0,
        deliverable: {
          kind: "slides",
          prompt: "Create a food web that shows how energy moves.",
          mode: "manual",
          criteria: [{
            id: "roles",
            label: "Roles",
            description: "Label the organisms and show predator relationships.",
          }],
        },
      })
    );
    const artifactId = await seedDeck(t, firstId, activityId);
    const fetch = stubGeneratedImage();
    // A misconception a classifier would have been tempted to touch: it must
    // reach Gemini verbatim, wrapped in the preserve-the-learner-model
    // instruction, with no model call in between and no alert row behind it.
    const learnerBrief =
      "A food web with the gazelle at the top as the apex predator above the lions.";

    const result = await t
      .withIdentity({ subject: firstId })
      .action(api.artifacts.scholarGenerateSlideImage, {
        artifactId,
        prompt: learnerBrief,
      });

    expect(result.status).toBe("generated");
    // Exactly one outbound call: Gemini. The stub throws on any Anthropic URL,
    // and the count pins that generation is a single-model path.
    expect(fetch).toHaveBeenCalledTimes(1);
    const geminiBody = JSON.parse(
      String((vi.mocked(fetch).mock.calls[0][1] as RequestInit | undefined)?.body),
    );
    const promptText = geminiBody.contents[0].parts[0].text;
    expect(promptText).toContain(learnerBrief);
    expect(promptText).toContain("Do not substitute a canonical textbook version.");
    expect(await t.run((ctx) => ctx.db.query("alerts").collect())).toHaveLength(0);
  });
});

describe("generation rate limit", () => {
  test("refuses a scholar who has already made the hourly maximum", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Rate Limited",
        username: "ratelimited",
        role: "scholar",
        externalId: "rate-limited",
      }),
    );
    const artifactId = await seedDeck(t, userId);
    // 30 picture requests inside the window. The cap must count these and
    // refuse BEFORE any money is spent — the llmBudget breaker is inert in
    // production, so this is the only thing standing between a bored child
    // holding the button and unbounded image spend.
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("slideImageGenerationAttempts", {
          uploaderId: userId,
        });
      }
    });

    // Stub the network so the assertion below is meaningful: if the cap leaks,
    // this spy records the call the child should never have been able to make.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await t
      .withIdentity({ subject: userId })
      .action(api.artifacts.scholarGenerateSlideImage, {
        artifactId,
        prompt: "one more",
      });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected a rate-limit error");
    expect(result.error).toBeTruthy();
    // The real property: it never reached the image model.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("uploaded photos never count against the request cap", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Photo Uploader",
        username: "uploader",
        role: "scholar",
        externalId: "photo-uploader",
      }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        const storageId = await ctx.storage.store(
          new Blob([new Uint8Array([i])], { type: "image/png" }),
        );
        await ctx.db.insert("slideAssets", {
          storageId,
          uploaderId: userId,
          source: "upload",
        });
      }
    });

    const attempts = await t.run((ctx) =>
      ctx.db
        .query("slideImageGenerationAttempts")
        .withIndex("by_uploader", (q) => q.eq("uploaderId", userId))
        .collect()
    );
    expect(attempts).toHaveLength(0);
  });

  test("atomically claims the final slot across concurrent requests", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Concurrent Scholar",
        username: "concurrent",
        role: "scholar",
        externalId: "concurrent-scholar",
      }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 29; i++) {
        await ctx.db.insert("slideImageGenerationAttempts", {
          uploaderId: userId,
        });
      }
    });

    const [first, second] = await Promise.all([
      t.mutation(internal.artifacts.claimSlideImageGenerationAttempt, {
        uploaderId: userId,
        since: 0,
      }),
      t.mutation(internal.artifacts.claimSlideImageGenerationAttempt, {
        uploaderId: userId,
        since: 0,
      }),
    ]);

    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
    const attempts = await t.run((ctx) =>
      ctx.db
        .query("slideImageGenerationAttempts")
        .withIndex("by_uploader", (q) => q.eq("uploaderId", userId))
        .collect()
    );
    expect(attempts).toHaveLength(30);
  });
});

describe("slide-picture spend is metered", () => {
  test("a generated picture records one image row attributed to the caller", async () => {
    stubGeneratedImage();
    const t = convexTest(schema, modules);
    const institutionId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        name: "Metered School",
        slug: "metered",
        kind: "school",
        isPrimary: true,
      }),
    );
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Metered Scholar",
        username: "metered",
        role: "scholar",
        externalId: "metered-scholar",
        institutionId,
      }),
    );
    const artifactId = await seedDeck(t, userId);

    const result = await t
      .withIdentity({ subject: userId })
      .action(api.artifacts.scholarGenerateSlideImage, {
        artifactId,
        prompt: "a tide pool",
      });
    expect(result.status).toBe("generated");

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("usageEvents")
        .filter((q) => q.eq(q.field("source"), "slide-illustration"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    // The properties that make the cost report correct: one image, priced
    // against the model that actually answered, attributed to a real school.
    expect(rows[0].images).toBe(1);
    expect(rows[0].model).toBeTruthy();
    expect(rows[0].institutionId).toBe(institutionId);
    expect(rows[0].role).toBe("scholar");
  });

  test("a metering failure never costs the child their picture", async () => {
    stubGeneratedImage();
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Unmetered",
        username: "unmetered",
        role: "scholar",
        externalId: "unmetered-scholar",
      }),
    );
    const artifactId = await seedDeck(t, userId);
    // Bookkeeping is fire-and-forget; the picture is the product.
    const result = await t
      .withIdentity({ subject: userId })
      .action(api.artifacts.scholarGenerateSlideImage, {
        artifactId,
        prompt: "a starfish",
      });
    expect(result.status).toBe("generated");
  });
});
