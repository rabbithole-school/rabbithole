import { convexTest } from "convex-test";
import { PNG } from "pngjs";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  appCharmThemeLabel,
  buildThemeIconPrompt,
  isAppCharmThemeLabel,
  parseSimulatorSpeciesLabel,
} from "../lib/themeIconArt";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  username = `test${role}`,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${role}`, username, role }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** A 1x1 fully transparent PNG — a real, decodable image, which the pipeline
 *  now requires: an undecodable response must fail the row rather than publish
 *  bytes no surface can render. */
function tinyTransparentPngBase64(): string {
  const png = new PNG({ width: 1, height: 1 });
  png.data[0] = 0;
  png.data[1] = 0;
  png.data[2] = 0;
  png.data[3] = 0;
  return PNG.sync.write(png).toString("base64");
}

/** A non-retryable client error — the way to make ONE row fail fast. */
function imagesApiBadRequest() {
  return {
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { message: "invalid prompt" } }),
  };
}

/** One successful Images-API response carrying `png`. */
function imagesApiOk(png: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ b64_json: png }] }),
    text: async () => "",
  };
}

/**
 * Run an action whose provider call backs off, WITHOUT sleeping for real — the
 * merge gate runs four vitest shards on a shared, load-starved host, where a
 * test that burns seconds of wall clock is exactly the kind that trips the 5s
 * timeout and durably excludes a candidate.
 */
async function withoutWaiting<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = start();
    await vi.advanceTimersByTimeAsync(120_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** A 429 that names its own cooldown, the way the Images API does. */
function imagesApiRateLimited(retryAfter = "10ms") {
  return {
    ok: false,
    status: 429,
    text: async () =>
      JSON.stringify({
        error: {
          message: `Rate limit reached for gpt-image-2.5-flare on input-images per min: Limit 5, Used 5, Requested 1. Please try again in ${retryAfter}.`,
        },
      }),
  };
}

// ── buildThemeIconPrompt: pure, deterministic ────────────────────────────────

describe("buildThemeIconPrompt", () => {
  test("embeds the label and forces a wordless, small-legible, backdrop-free icon", () => {
    const p = buildThemeIconPrompt("rocket ship");
    expect(p).toContain("rocket ship");
    expect(p).toContain("NO text");
    // The sprite is composited into a grid cell, so a painted backdrop or a
    // baked-in contact shadow would read as dirt on the grid.
    expect(p).toContain("TRANSPARENT");
    expect(p).toContain("no drop shadow");
    expect(p.toLowerCase()).toContain("silhouette");
  });

  test("a plain manipulative label stays the FACE-ON icon, no charm camera", () => {
    const p = buildThemeIconPrompt("pig");
    expect(p).toContain("Face-on");
    expect(p.toLowerCase()).not.toContain("facing left");
    expect(p.toLowerCase()).not.toContain("isometric");
  });

  test("a world species label gets the CHARM CAMERA (iso, facing left, grounded)", () => {
    const p = buildThemeIconPrompt("world:coral reef ecosystem:grazers");
    expect(p).toContain("grazers"); // the drawable species (last segment)
    expect(p).toContain("coral reef ecosystem"); // setting-phrase referent steer
    expect(p).toContain("FACING LEFT");
    expect(p.toLowerCase()).toContain("isometric");
    expect(p.toLowerCase()).toContain("three-quarter");
    // Same guards as the icon: single-subject, wordless, no backdrop.
    expect(p).toContain("NO text");
    expect(p).toContain("TRANSPARENT");
    // But NOT the flat face-on manipulative framing.
    expect(p).not.toContain("Face-on");
    // The setting is context, never drawn as a background.
    expect(p).toContain("do NOT draw coral reef ecosystem as a background");
  });
});

describe("parseSimulatorSpeciesLabel", () => {
  test("splits world:<setting>:<species>", () => {
    expect(parseSimulatorSpeciesLabel("world:coral reef ecosystem:grazers")).toEqual({
      settingPhrase: "coral reef ecosystem",
      species: "grazers",
    });
  });

  test("returns null for a plain manipulative label", () => {
    expect(parseSimulatorSpeciesLabel("pig")).toBeNull();
    expect(parseSimulatorSpeciesLabel("rocket ship")).toBeNull();
  });

  test("tolerates a missing setting phrase", () => {
    expect(parseSimulatorSpeciesLabel("world:fish")).toEqual({
      settingPhrase: "",
      species: "fish",
    });
  });

  describe("app charm cache keys", () => {
    test("selects the flat or isometric prompt branch", () => {
      const flat = appCharmThemeLabel("Parrotfish", "flat");
      const isometric = appCharmThemeLabel("Parrotfish", "isometric");
      expect(flat).toBe("app:flat:Parrotfish");
      expect(isometric).toBe("world:app asset:Parrotfish");
      expect(isAppCharmThemeLabel(flat)).toBe(true);
      expect(isAppCharmThemeLabel(isometric)).toBe(true);
      expect(buildThemeIconPrompt(flat)).toContain("Face-on");
      expect(buildThemeIconPrompt(isometric)).toContain("FACING LEFT");
    });
  });
});

// ── resolver: getByLabel + ensure ────────────────────────────────────────────

describe("theme icon resolver", () => {
  test("getByLabel returns null before anything is cached", async () => {
    const t = convexTest(schema, modules);
    const asUser = await withUser(t, await seedUser(t));
    expect(
      await asUser.query(api.manipulativeThemeIcons.getByLabel, {
        label: "pig",
      }),
    ).toBeNull();
  });

  test("ensure inserts one pending row and is idempotent (normalized)", async () => {
    const t = convexTest(schema, modules);
    const asUser = await withUser(t, await seedUser(t));

    const id1 = await asUser.mutation(api.manipulativeThemeIcons.ensure, {
      label: "Rocket Ship",
    });
    // A different casing/spacing of the SAME label must not make a 2nd row.
    const id2 = await asUser.mutation(api.manipulativeThemeIcons.ensure, {
      label: "rocket  ship",
    });
    expect(id2).toEqual(id1);

    const rows = await t.run((ctx) =>
      ctx.db.query("manipulativeThemeIcons").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("rocket ship"); // normalized key
    expect(rows[0].displayLabel).toBe("Rocket Ship"); // original casing kept
    expect(rows[0].status).toBe("pending");

    // getByLabel resolves the pending row but yields no URL yet.
    const resolved = await asUser.query(api.manipulativeThemeIcons.getByLabel, {
      label: "ROCKET SHIP",
    });
    expect(resolved?.status).toBe("pending");
    expect(resolved?.url).toBeNull();
  });

  test("a ready row yields a URL; hidden suppresses it", async () => {
    const t = convexTest(schema, modules);
    const asUser = await withUser(t, await seedUser(t));
    await asUser.mutation(api.manipulativeThemeIcons.ensure, { label: "acorn" });

    // Simulate generation completing: store a blob + flip to ready.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("manipulativeThemeIcons")
        .withIndex("by_label", (q) => q.eq("label", "acorn"))
        .first();
      const storageId = await ctx.storage.store(new Blob(["png"]));
      await ctx.db.patch(row!._id, { status: "ready", imageStorageId: storageId });
    });

    const ready = await asUser.query(api.manipulativeThemeIcons.getByLabel, {
      label: "acorn",
    });
    expect(ready?.status).toBe("ready");
    expect(ready?.url).toBeTruthy();

    // A teacher hides it → renderers fall back to the plain shape (url null).
    const asTeacher = await withUser(t, await seedUser(t, "teacher"));
    await asTeacher.mutation(api.manipulativeThemeIcons.setHidden, {
      label: "acorn",
      hidden: true,
    });
    const hidden = await asUser.query(api.manipulativeThemeIcons.getByLabel, {
      label: "acorn",
    });
    expect(hidden?.hidden).toBe(true);
    expect(hidden?.url).toBeNull();
  });

  test("app-only charm keys stay out of the curator cache list", async () => {
    const t = convexTest(schema, modules);
    const asUser = await withUser(t, await seedUser(t));
    await asUser.mutation(api.manipulativeThemeIcons.ensure, { label: "acorn" });
    await t.run((ctx) =>
      ctx.db.insert("manipulativeThemeIcons", {
        label: "app:flat:parrotfish",
        displayLabel: "parrotfish",
        status: "pending",
        createdAt: Date.now(),
      }),
    );

    const list = await asUser.query(api.manipulativeThemeIcons.listAll, {});
    expect(list.map((row) => row.label)).toEqual(["acorn"]);
  });
});

// ── staff-only override gates ────────────────────────────────────────────────

describe("override mutations are teacher-gated", () => {
  test("a scholar cannot regenerate / hide / clear / list", async () => {
    const t = convexTest(schema, modules);
    const asScholar = await withUser(t, await seedUser(t));
    await asScholar.mutation(api.manipulativeThemeIcons.ensure, { label: "pig" });

    await expect(
      asScholar.mutation(api.manipulativeThemeIcons.regenerate, { label: "pig" }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.manipulativeThemeIcons.setHidden, {
        label: "pig",
        hidden: true,
      }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.manipulativeThemeIcons.clear, { label: "pig" }),
    ).rejects.toThrow();
    // listAll is a plain authed read (non-sensitive) — a scholar CAN list.
    expect(
      await asScholar.query(api.manipulativeThemeIcons.listAll, {}),
    ).toHaveLength(1);
  });

  test("a teacher can list + clear", async () => {
    const t = convexTest(schema, modules);
    const asScholar = await withUser(t, await seedUser(t));
    await asScholar.mutation(api.manipulativeThemeIcons.ensure, { label: "pig" });

    const asTeacher = await withUser(t, await seedUser(t, "teacher"));
    const list = await asTeacher.query(api.manipulativeThemeIcons.listAll, {});
    expect(list).toHaveLength(1);
    expect(list[0].displayLabel).toBe("pig");

    await asTeacher.mutation(api.manipulativeThemeIcons.clear, { label: "pig" });
    const after = await t.run((ctx) =>
      ctx.db.query("manipulativeThemeIcons").collect(),
    );
    expect(after).toHaveLength(0);
  });

  test.each(["teacher", "school_admin", "platform_admin"])(
    "%s can use the curator overrides",
    async (role) => {
      const t = convexTest(schema, modules);
      const asScholar = await withUser(t, await seedUser(t));
      await asScholar.mutation(api.manipulativeThemeIcons.ensure, { label: "pig" });

      const asCurator = await withUser(t, await seedUser(t, role));
      await expect(
        asCurator.mutation(api.manipulativeThemeIcons.setHidden, {
          label: "pig",
          hidden: true,
        }),
      ).resolves.toBeTruthy();
    },
  );

  test.each(["curriculum_designer", "staff", "scholar", "parent"])(
    "%s cannot use the curator overrides",
    async (role) => {
      const t = convexTest(schema, modules);
      const asScholar = await withUser(t, await seedUser(t));
      await asScholar.mutation(api.manipulativeThemeIcons.ensure, { label: "pig" });

      const asNonCurator = await withUser(t, await seedUser(t, role));
      await expect(
        asNonCurator.mutation(api.manipulativeThemeIcons.setHidden, {
          label: "pig",
          hidden: true,
        }),
      ).rejects.toThrow();
    },
  );
});

describe("species-icon generation routing (action layer)", () => {
  // The camera directive must reach the actual generation REQUEST end-to-end:
  // generateThemeIcon builds the prompt from the row and sends it to the model,
  // then PERSISTS the exact prompt on the row (setArt). We stub fetch to return
  // a trivial image and read the stored `row.prompt` — keyed by row id, so this
  // is immune to any cross-test global-stub ordering (unlike capturing the
  // in-flight request via a shared closure).
  async function generatedPromptFor(row: {
    label: string;
    displayLabel: string;
  }): Promise<string> {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("manipulativeThemeIcons", {
        ...row,
        status: "pending",
        createdAt: Date.now(),
      }),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    // A minimal image. The downscale rejects these few bytes and the action
    // falls back to storing them raw — either way it reaches setArt(prompt),
    // which is all this test asserts on.
    vi.stubGlobal("fetch", vi.fn(async () => imagesApiOk(tinyTransparentPngBase64())));
    await t.action(internal.manipulativeThemeIconActions.generateThemeIcon, {
      id,
    });
    const stored = await t.run((ctx) => ctx.db.get(id));
    return stored?.prompt ?? "";
  }

  test("a species row's request carries the isometric three-quarter charm camera", async () => {
    const prompt = await generatedPromptFor({
      // The workbench stamps this `world:` namespace on the cache key.
      label: "world:coral reef ecosystem:grazers",
      displayLabel: "grazers",
    });
    expect(prompt).toContain("grazers"); // the drawable species
    expect(prompt).toContain("coral reef ecosystem"); // setting-phrase referent steer
    expect(prompt).toContain("FACING LEFT");
    expect(prompt.toLowerCase()).toContain("isometric");
    expect(prompt.toLowerCase()).toContain("three-quarter");
    // NOT the flat face-on manipulative framing.
    expect(prompt).not.toContain("Face-on");
  });

  test("a manipulative row's request stays the flat face-on icon (unchanged)", async () => {
    const prompt = await generatedPromptFor({
      label: "pig",
      displayLabel: "pig",
    });
    expect(prompt).toContain("pig");
    expect(prompt).toContain("Face-on");
    expect(prompt).not.toContain("FACING LEFT");
    expect(prompt.toLowerCase()).not.toContain("isometric");
  });
});

describe("theme icon generation failures", () => {
  test("re-mint batches continue after one label throws", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(imagesApiBadRequest())
        .mockResolvedValueOnce(imagesApiOk(tinyTransparentPngBase64())),
    );

    const result = await t.action(
      internal.manipulativeThemeIconActions.regenerateLabels,
      {
        labels: [
          "world:coral reef ecosystem:fish",
          "world:coral reef ecosystem:shark",
        ],
      },
    );

    expect(result).toEqual([
      {
        label: "world:coral reef ecosystem:fish",
        status: "failed",
      },
      {
        label: "world:coral reef ecosystem:shark",
        status: "ready",
        model: "gpt-image-2.5-flare",
      },
    ]);
    const rows = await t.run((ctx) =>
      ctx.db.query("manipulativeThemeIcons").collect(),
    );
    expect(rows.find((row) => row.label.endsWith(":fish"))?.status).toBe("failed");
    expect(rows.find((row) => row.label.endsWith(":shark"))?.status).toBe("ready");
  });

  test("waits out a rate limit and publishes on the retry", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("manipulativeThemeIcons", {
        label: "world:coral reef ecosystem:fish",
        displayLabel: "fish",
        status: "pending",
        createdAt: Date.now(),
      }),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(imagesApiRateLimited())
        .mockResolvedValueOnce(imagesApiOk(tinyTransparentPngBase64())),
    );

    // The org's images-per-minute allowance is small, so a 429 is an ordinary
    // event when several new labels resolve at once — the call waits out the
    // cooldown the response names instead of leaving the cell on a plain shape.
    const result = await withoutWaiting(() =>
      t.action(internal.manipulativeThemeIconActions.generateThemeIcon, { id }),
    );

    expect(result).toEqual({ status: "ready", model: "gpt-image-2.5-flare" });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("ready");
    expect(row?.generationModel).toBe("gpt-image-2.5-flare");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("marks the row failed when the provider rejects the request", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("manipulativeThemeIcons", {
        label: "pig",
        displayLabel: "pig",
        status: "pending",
        createdAt: Date.now(),
      }),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imagesApiBadRequest()));

    await expect(
      t.action(internal.manipulativeThemeIconActions.generateThemeIcon, { id }),
    ).resolves.toEqual({ status: "failed" });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("failed");
  });
});
