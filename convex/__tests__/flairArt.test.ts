import { convexTest } from "convex-test";
import { PNG } from "pngjs";
import { afterEach, describe, expect, test, vi } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ensureFlairArtForActivity, flairArtKey } from "../flairArt";
import { buildFlairArtPrompt } from "../lib/themeIconArt";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedCurriculum(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Lehua Torres",
      username: "lehua_torres",
      role: "teacher",
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: "hoku_makani",
      role: "scholar",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: teacherId,
      role: "teacher",
      institutionId,
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Field notes",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Observe",
      order: 0,
    });
    return { institutionId, teacherId, scholarId, lessonId };
  });
}

async function drainScheduled(t: ReturnType<typeof convexTest>) {
  // runAfter(0) otherwise fires after this test and can consume the next
  // test's image-model fetch mock.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.finishInProgressScheduledFunctions();
}

/** What the image model now returns: an opaque icon on real transparency. */
function generatedFlairPngBase64(): string {
  const png = new PNG({ width: 32, height: 32 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const isIcon = x >= 10 && x < 22 && y >= 10 && y < 22;
      png.data[offset] = 255;
      png.data[offset + 1] = isIcon ? 198 : 0;
      png.data[offset + 2] = isIcon ? 77 : 0;
      png.data[offset + 3] = isIcon ? 255 : 0;
    }
  }
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

/** A transient `server_error`, the shape the Images API returned during the
 *  2026-09-15 outage — every request failed for minutes, then recovered. */
function imagesApiServerError() {
  return {
    ok: false,
    status: 500,
    text: async () =>
      JSON.stringify({ error: { type: "server_error", message: "The server had an error." } }),
  };
}

/**
 * Run an action whose provider call backs off, WITHOUT sleeping for real.
 *
 * The retry delays are seconds long on purpose (a 429 names a ~12s cooldown).
 * Burning that wall clock in a unit test is not just slow — the merge gate runs
 * four vitest shards on a shared, load-starved host, where a test that takes
 * seconds of real time is exactly the kind that trips the 5s timeout and
 * durably excludes a candidate. Fake timers make the backoff instant and
 * deterministic instead.
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

describe("flair art key and prompt", () => {
  test("uses a short versioned semantic key", () => {
    const first = flairArtKey({
      label: "  Record observations ",
      description: "Capture what changed.",
    });
    const same = flairArtKey({
      label: "record   OBSERVATIONS",
      description: " capture what changed. ",
    });
    const changed = flairArtKey({
      label: "Record observations",
      description: "Explain what changed.",
    });

    expect(first).toBe(same);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^bold-v1:/);
    expect(first.length).toBeLessThan(40);
  });

  test("carries the chip size and the caller's label", () => {
    const prompt = buildFlairArtPrompt(
      "Record observations",
      "Capture evidence from the experiment",
    );
    // The render size is load-bearing: it is what makes the model draw a
    // silhouette legible in the 36px chip rather than a detailed illustration.
    expect(prompt).toContain("exactly 36 × 36 pixels");
    // Dynamic interpolation: the caller's label actually reaches the prompt.
    expect(prompt).toContain("Record observations");
    // The art is composited over a chip, so it must never carry a backdrop.
    expect(prompt).toContain("transparent");
  });
});

describe("flair art scheduling and reads", () => {
  test("activity authoring warms one institution-scoped asset per criterion", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, lessonId } = await seedCurriculum(t);
    const deliverable = {
      kind: "text" as const,
      prompt: "Write field notes",
      mode: "manual" as const,
      criteria: [
        {
          id: "record",
          label: "Record observations",
          description: "Capture what changed.",
        },
        {
          id: "explain",
          label: "Explain trade-offs",
          description: "Name one cost and one benefit.",
        },
      ],
    };

    const created = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Field notes" },
      title: "Field notes",
      deliverable,
    });
    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Field notes" },
      title: "Field notes",
      deliverable,
    });

    const rows = await t.run((ctx) => ctx.db.query("flairArt").collect());
    expect(created.existed).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.institutionId === institutionId)).toBe(true);
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.map((row) => row.sourceLabel).sort()).toEqual([
      "Explain trade-offs",
      "Record observations",
    ]);
    await drainScheduled(t);
  });

  test("the same criterion warms separate assets for separate institutions", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, lessonId } = await seedCurriculum(t);
    const otherInstitutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Harbor School",
        slug: "harbor",
        kind: "school",
      }),
    );
    const otherLessonId = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Malia Kealoha",
        username: "malia_kealoha",
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        institutionId: otherInstitutionId,
        title: "Field notes",
        isActive: true,
      });
      return await ctx.db.insert("lessons", {
        unitId,
        title: "Observe",
        order: 0,
      });
    });
    const deliverable = {
      kind: "text" as const,
      prompt: "Write field notes",
      mode: "manual" as const,
      criteria: [{ id: "record", label: "Record observations" }],
    };

    for (const targetLessonId of [lessonId, otherLessonId]) {
      await t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId: targetLessonId },
        match: { byTitle: "Field notes" },
        title: "Field notes",
        deliverable,
      });
    }

    const rows = await t.run((ctx) => ctx.db.query("flairArt").collect());
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.institutionId))).toEqual(
      new Set([institutionId, otherInstitutionId]),
    );
    await drainScheduled(t);
  });

  test("a large rubric still persists while Flair warm-up stays bounded", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const { lessonId } = await seedCurriculum(t);
    const criteria = Array.from({ length: 25 }, (_, index) => ({
      id: `criterion-${index}`,
      label: `Criterion ${index}`,
    }));

    await expect(
      t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId },
        match: { byTitle: "Large rubric" },
        title: "Large rubric",
        deliverable: {
          kind: "text",
          prompt: "Complete the rubric",
          mode: "manual",
          criteria,
        },
      }),
    ).resolves.toMatchObject({ existed: false });

    const rows = await t.run((ctx) => ctx.db.query("flairArt").collect());
    expect(rows).toHaveLength(24);
    expect(warning).toHaveBeenCalledWith(
      "[flairArt] preparing the first 24 of 25 criteria",
    );
    await drainScheduled(t);
  });

  test("the session query returns earned flair only with an immediate initial", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, lessonId } = await seedCurriculum(t);
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Field notes",
        kind: "online",
        order: 0,
        deliverable: {
          kind: "text",
          prompt: "Write field notes",
          mode: "manual",
          criteria: [
            { id: "record", label: "Record observations" },
            { id: "explain", label: "Explain trade-offs" },
          ],
        },
      }),
    );
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Field notes",
        isArchived: false,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("deliverables", {
        activityId,
        scholarId,
        sessionId,
        submittedAt: Date.now(),
        flairEarned: [{ criterionId: "record", earnedAt: 123 }],
      }),
    );

    const asScholar = await withUser(t, scholarId);
    expect(
      await asScholar.query(api.flairArt.forSession, { sessionId }),
    ).toEqual([
      {
        criterionId: "record",
        label: "Record observations",
        initial: "R",
        earnedAt: 123,
        artId: null,
        imageUrl: null,
      },
    ]);
  });

  test("deliverable reads never borrow Flair earned by another artifact", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, lessonId } = await seedCurriculum(t);
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Field notes",
        kind: "online",
        order: 0,
        deliverable: {
          kind: "text",
          prompt: "Write field notes",
          mode: "manual",
          criteria: [
            {
              id: "record",
              label: "Record observations",
              description: "Capture what changed.",
            },
            {
              id: "explain",
              label: "Explain trade-offs",
              description: "Name one cost and one benefit.",
            },
          ],
        },
      }),
    );
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Field notes",
        isArchived: false,
      }),
    );
    const [recordDeliverableId, explainDeliverableId] = await t.run(
      async (ctx) => {
        const recordArtifactId = await ctx.db.insert("artifacts", {
          sessionId,
          title: "Observation draft",
          content: "The water level changed.",
          lastEditedBy: "scholar",
        });
        const explainArtifactId = await ctx.db.insert("artifacts", {
          sessionId,
          title: "Trade-off draft",
          content: "The faster option costs more.",
          lastEditedBy: "scholar",
        });
        return await Promise.all([
          ctx.db.insert("deliverables", {
            activityId,
            scholarId,
            sessionId,
            artifactId: recordArtifactId,
            submittedAt: Date.now(),
            flairEarned: [
              {
                criterionId: "record",
                earnedAt: 123,
                note: "You wrote down the level before and after.",
              },
            ],
          }),
          ctx.db.insert("deliverables", {
            activityId,
            scholarId,
            sessionId,
            artifactId: explainArtifactId,
            submittedAt: Date.now(),
            flairEarned: [{ criterionId: "explain", earnedAt: 456 }],
          }),
        ]);
      },
    );

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.flairArt.forDeliverable, {
        deliverableId: recordDeliverableId,
      }),
    ).resolves.toEqual([
      {
        criterionId: "record",
        label: "Record observations",
        // The scholar sees the note the grader wrote about THEIR work — never
        // the criterion's `description`, which is grader-facing rubric text.
        note: "You wrote down the level before and after.",
        initial: "R",
        earnedAt: 123,
        artId: null,
        imageUrl: null,
      },
    ]);
    await expect(
      asScholar.query(api.flairArt.forDeliverable, {
        deliverableId: explainDeliverableId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        criterionId: "explain",
        label: "Explain trade-offs",
      }),
    ]);
    // Flair awarded before notes were persisted carries none, and must still
    // withhold the grader-facing description rather than fall back to it.
    const [explainFlair] = await asScholar.query(api.flairArt.forDeliverable, {
      deliverableId: explainDeliverableId,
    });
    expect(explainFlair).not.toHaveProperty("note");
    expect(explainFlair).not.toHaveProperty("description");
  });

  test("the session query does not expose another scholar's flair", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, lessonId } = await seedCurriculum(t);
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Field notes",
        kind: "online",
        order: 0,
        deliverable: {
          kind: "text",
          prompt: "Write field notes",
          mode: "manual",
          criteria: [{ id: "record", label: "Record observations" }],
        },
      }),
    );
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Field notes",
        isArchived: false,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("deliverables", {
        activityId,
        scholarId,
        sessionId,
        submittedAt: Date.now(),
        flairEarned: [{ criterionId: "record", earnedAt: 123 }],
      }),
    );
    const outsiderId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Nohea Vale",
        username: "nohea_vale",
        role: "scholar",
      }),
    );

    const asOutsider = await withUser(t, outsiderId);
    await expect(
      asOutsider.query(api.flairArt.forSession, { sessionId }),
    ).resolves.toEqual([]);
  });

  test("manual Flair resolves through the curriculum institution", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, scholarId, lessonId } = await seedCurriculum(t);
    const otherInstitutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Harbor School",
        slug: "harbor",
        kind: "school",
      }),
    );
    await t.run((ctx) =>
      ctx.db.patch(scholarId, { institutionId: otherInstitutionId }),
    );
    const criterion = { id: "record", label: "Record observations" };
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Field notes",
        kind: "online",
        order: 0,
        deliverable: {
          kind: "text",
          prompt: "Write field notes",
          mode: "manual",
          criteria: [criterion],
        },
      }),
    );
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Field notes",
        isArchived: false,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("deliverables", {
        activityId,
        scholarId,
        sessionId,
        submittedAt: Date.now(),
        flairEarned: [{ criterionId: criterion.id, earnedAt: 123 }],
      });
      await ctx.db.insert("flairArt", {
        institutionId,
        artKey: flairArtKey(criterion),
        sourceLabel: criterion.label,
        status: "ready",
        attemptCount: 1,
        lastAttemptAt: Date.now(),
        createdAt: Date.now(),
      });
    });

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.flairArt.forSession, { sessionId }),
    ).resolves.toEqual([
      expect.objectContaining({
        criterionId: criterion.id,
        artId: expect.any(String),
      }),
    ]);
  });

  test("persisting generated auto criteria starts the same async warmup", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, lessonId } = await seedCurriculum(t);
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Volcano study",
        kind: "online",
        order: 0,
        deliverable: {
          kind: "text",
          prompt: "Explain the eruption",
          mode: "auto",
          criteria: [],
        },
      }),
    );
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Volcano study",
        isArchived: false,
      }),
    );

    await t.mutation(internal.deliverables.persistGeneratedCriteria, {
      sessionId,
      criteria: [
        {
          id: "mechanism",
          label: "Explain the mechanism",
          description: "Connect pressure to the eruption.",
        },
      ],
    });

    const rows = await t.run((ctx) => ctx.db.query("flairArt").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceLabel).toBe("Explain the mechanism");
    expect(rows[0]?.status).toBe("pending");
    await drainScheduled(t);
  });

  test("late generation results cannot replace a terminal cache row", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedCurriculum(t);
    const { id, firstImageStorageId, secondImageStorageId } = await t.run(
      async (ctx) => {
        const firstImageStorageId = await ctx.storage.store(
          new Blob(["first Flair image"]),
        );
        const secondImageStorageId = await ctx.storage.store(
          new Blob(["late Flair image"]),
        );
        const id = await ctx.db.insert("flairArt", {
          institutionId,
          artKey: "bold-v1:race",
          sourceLabel: "Record observations",
          status: "pending",
          attemptCount: 1,
          lastAttemptAt: Date.now(),
          createdAt: Date.now(),
        });
        return { id, firstImageStorageId, secondImageStorageId };
      },
    );

    await expect(
      t.mutation(internal.flairArtInternal.markReady, {
        id,
        imageStorageId: firstImageStorageId,
        prompt: "first prompt",
        generationModel: "first-model",
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(internal.flairArtInternal.markFailed, { id }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.flairArtInternal.markReady, {
        id,
        imageStorageId: secondImageStorageId,
        prompt: "late prompt",
        generationModel: "late-model",
      }),
    ).resolves.toBe(false);

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({
      status: "ready",
      imageStorageId: firstImageStorageId,
      prompt: "first prompt",
      generationModel: "first-model",
    });
  });

  test("an undecodable image never publishes", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedCurriculum(t);
    const id = await t.run((ctx) =>
      ctx.db.insert("flairArt", {
        institutionId,
        artKey: "bold-v1:test",
        sourceLabel: "Record observations",
        status: "pending",
        attemptCount: 1,
        lastAttemptAt: Date.now(),
        createdAt: Date.now(),
      }),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    // A truncated PNG: the downscale throws, and the row must stay unpublished
    // rather than storing bytes no surface can render.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imagesApiOk("iVBORw0KGgo=")));

    await expect(
      t.action(internal.flairArtActions.generateFlairArt, { id }),
    ).resolves.toEqual({ status: "failed" });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("failed");
    expect(row?.imageStorageId).toBeUndefined();
  });

  test("waits out a rate limit and publishes on the retry", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedCurriculum(t);
    const id = await t.run((ctx) =>
      ctx.db.insert("flairArt", {
        institutionId,
        artKey: "bold-v1:fallback",
        sourceLabel: "Record observations",
        status: "pending",
        attemptCount: 1,
        lastAttemptAt: Date.now(),
        createdAt: Date.now(),
      }),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(imagesApiRateLimited())
        .mockResolvedValueOnce(imagesApiOk(generatedFlairPngBase64())),
    );

    // The org's images-per-minute allowance is small, so a 429 is an ordinary
    // event on a backfill, not a failure: the call waits out the cooldown the
    // response names rather than leaving the chip on its fallback glyph.
    await expect(
      withoutWaiting(() =>
        t.action(internal.flairArtActions.generateFlairArt, { id }),
      ),
    ).resolves.toEqual({
      status: "ready",
      model: "gpt-image-2.5-flare",
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.generationModel).toBe("gpt-image-2.5-flare");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("rides out a transient provider outage rather than failing the row", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedCurriculum(t);
    const id = await t.run((ctx) =>
      ctx.db.insert("flairArt", {
        institutionId,
        artKey: "bold-v1:outage",
        sourceLabel: "Record observations",
        status: "pending",
        attemptCount: 1,
        lastAttemptAt: Date.now(),
        createdAt: Date.now(),
      }),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(imagesApiServerError())
        .mockResolvedValueOnce(imagesApiOk(generatedFlairPngBase64())),
    );

    // A 5xx says nothing about the request, so treating it as a permanent
    // failure would strand the chip on its fallback glyph for no reason.
    await expect(
      withoutWaiting(() =>
        t.action(internal.flairArtActions.generateFlairArt, { id }),
      ),
    ).resolves.toEqual({ status: "ready", model: "gpt-image-2.5-flare" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("re-drives a row left pending by a killed generation", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, lessonId } = await seedCurriculum(t);
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Map the creek",
        kind: "online",
        systemPrompt: "...",
        order: 0,
      }),
    );
    const criterion = { label: "Careful observer" };
    const first = await t.run((ctx) =>
      ensureFlairArtForActivity(ctx, activityId, [criterion], undefined, {
        scheduleGeneration: false,
      }),
    );
    expect(first.created).toBe(1);

    // Its action never reached ready or markFailed. Inside the retry delay it
    // may still be running, so it is left alone…
    const inFlight = await t.run((ctx) =>
      ensureFlairArtForActivity(ctx, activityId, [criterion], undefined, {
        scheduleGeneration: false,
      }),
    );
    expect(inFlight).toEqual({ created: 0, existing: 1, retried: 0 });

    // …but past it, the run can only have been killed.
    await t.run(async (ctx) => {
      const row = (await ctx.db
        .query("flairArt")
        .withIndex("by_institution_key", (q) => q.eq("institutionId", institutionId))
        .unique())!;
      await ctx.db.patch(row._id, { lastAttemptAt: Date.now() - 16 * 60 * 1000 });
    });
    const stale = await t.run((ctx) =>
      ensureFlairArtForActivity(ctx, activityId, [criterion], undefined, {
        scheduleGeneration: false,
      }),
    );
    expect(stale).toEqual({ created: 0, existing: 0, retried: 1 });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("flairArt")
        .withIndex("by_institution_key", (q) => q.eq("institutionId", institutionId))
        .unique(),
    );
    expect(row?.status).toBe("pending");
    expect(row?.attemptCount).toBe(2);
  });

  test("the scheduled watchdog re-drives a stalled row and leaves a finished one", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedCurriculum(t);
    const stalledAt = Date.now() - 16 * 60 * 1000;
    const [stalled, fresh, ready] = await t.run(async (ctx) =>
      Promise.all(
        [
          { status: "pending" as const, lastAttemptAt: stalledAt },
          { status: "pending" as const, lastAttemptAt: Date.now() },
          { status: "ready" as const, lastAttemptAt: stalledAt },
        ].map((row, index) =>
          ctx.db.insert("flairArt", {
            institutionId,
            artKey: `bold-v1:watchdog-${index}`,
            sourceLabel: `Criterion ${index}`,
            attemptCount: 1,
            createdAt: stalledAt,
            ...row,
          }),
        ),
      ),
    );
    const retry = (id: Id<"flairArt">) =>
      t.mutation(internal.flairArtInternal.retryIfStalled, { id });
    expect(await retry(stalled)).toBe(true);
    expect(await retry(fresh)).toBe(false);
    expect(await retry(ready)).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(stalled));
    expect(row?.attemptCount).toBe(2);
    expect(row?.status).toBe("pending");
    await drainScheduled(t);
  });

  test("recovery continues after one row fails", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedCurriculum(t);
    const ids = await t.run(async (ctx) =>
      await Promise.all(
        ["First criterion", "Second criterion"].map((sourceLabel, index) =>
          ctx.db.insert("flairArt", {
            institutionId,
            artKey: `bold-v1:recovery-${index}`,
            sourceLabel,
            status: "failed",
            attemptCount: 1,
            lastAttemptAt: Date.now(),
            failedAt: Date.now(),
            createdAt: Date.now(),
          }),
        ),
      ),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(imagesApiBadRequest())
        .mockResolvedValueOnce(imagesApiOk(generatedFlairPngBase64())),
    );

    const result = await t.action(internal.flairArtActions.regenerateIds, {
      ids,
    });

    expect(result).toEqual([
      { id: ids[0], status: "failed" },
      { id: ids[1], status: "ready", model: "gpt-image-2.5-flare" },
    ]);
    const rows = await t.run((ctx) =>
      Promise.all(ids.map((id) => ctx.db.get(id))),
    );
    expect(rows[0]?.status).toBe("failed");
    expect(rows[1]?.status).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(fetch).mock.calls.every(([url]) =>
        String(url).includes("api.openai.com/v1/images/generations"),
      ),
    ).toBe(true);
  });
});
