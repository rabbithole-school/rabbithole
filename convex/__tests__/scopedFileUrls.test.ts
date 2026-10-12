// Serving URLs come from the query that authorizes the row, never from a bare
// storage id (TRA-389). `_storage` is shared with health documents and
// portfolio scans, so each scoped read must resolve only media its parent
// actually holds, and refuse a caller who cannot read that parent.
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { emptyDeck, type Deck } from "../../shared/slidesScene";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function withUser(t: T, userId: Id<"users">) {
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

async function seedWorld(t: T) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Test School",
      slug: "test-school",
      kind: "school",
      isPrimary: true,
    });
    const user = async (username: string, role: "teacher" | "scholar") => {
      const id = await ctx.db.insert("users", {
        name: username,
        username,
        role,
        institutionId,
      });
      await ctx.db.insert("memberships", { userId: id, role, institutionId });
      return id;
    };
    const teacherId = await user("url-teacher", "teacher");
    const scholarId = await user("url-scholar", "scholar");
    const otherScholarId = await user("url-other", "scholar");
    const unitId = await ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Activity",
      kind: "online",
      order: 0,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      unitId,
      lessonId,
      activityId,
      title: "Session",
      isArchived: false,
    });
    // Someone else's file the scholar might learn the id of.
    const foreignStorageId = await ctx.storage.store(new Blob(["health form"]));
    return {
      teacherId,
      scholarId,
      otherScholarId,
      activityId,
      sessionId,
      foreignStorageId,
    };
  });
}

function deckWithImage(assetId: Id<"_storage">): Deck {
  const deck = emptyDeck("Deck", "sl1");
  deck.slides[0].elements.el1 = {
    id: "el1",
    type: "image",
    assetId,
    alt: "photo",
    frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
  };
  deck.slides[0].elementIds.push("el1");
  return deck;
}

describe("scoped file URLs (TRA-389)", () => {
  test("a slides artifact resolves only its own media, for readers of its session", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const { artifactId, inDeck, freshUpload } = await t.run(async (ctx) => {
      const inDeck = await ctx.storage.store(new Blob(["in deck"]));
      const freshUpload = await ctx.storage.store(new Blob(["just added"]));
      await ctx.db.insert("slideAssets", {
        storageId: freshUpload,
        uploaderId: world.scholarId,
      });
      const artifactId = await ctx.db.insert("artifacts", {
        sessionId: world.sessionId,
        title: "Deck",
        content: JSON.stringify(deckWithImage(inDeck)),
        type: "slides",
        lastEditedBy: "scholar",
      });
      return { artifactId, inDeck, freshUpload };
    });

    const scholar = await withUser(t, world.scholarId);
    const urls = await scholar.query(api.artifacts.slideAssetUrls, {
      artifactId,
      storageIds: [inDeck, freshUpload, world.foreignStorageId],
    });
    expect(urls).toEqual([
      { storageId: inDeck, url: expect.any(String) },
      { storageId: freshUpload, url: expect.any(String) },
      { storageId: world.foreignStorageId, url: null },
    ]);

    const other = await withUser(t, world.otherScholarId);
    expect(
      await other.query(api.artifacts.slideAssetUrls, {
        artifactId,
        storageIds: [inDeck],
      }),
    ).toEqual([]);
  });

  test("slide media resolves only for its own uploader, and only fresh uploads register", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const world = await seedWorld(t);
      const { artifactId, othersUpload, stale } = await t.run(async (ctx) => {
        const othersUpload = await ctx.storage.store(new Blob(["theirs"]));
        await ctx.db.insert("slideAssets", {
          storageId: othersUpload,
          uploaderId: world.otherScholarId,
        });
        const stale = await ctx.storage.store(new Blob(["old scan"]));
        const artifactId = await ctx.db.insert("artifacts", {
          sessionId: world.sessionId,
          title: "Deck",
          content: JSON.stringify(emptyDeck("Deck", "sl1")),
          type: "slides",
          lastEditedBy: "scholar",
        });
        return { artifactId, othersUpload, stale };
      });
      const scholar = await withUser(t, world.scholarId);
      expect(
        await scholar.query(api.artifacts.slideAssetUrls, {
          artifactId,
          storageIds: [othersUpload],
        }),
      ).toEqual([{ storageId: othersUpload, url: null }]);

      // An unclaimed blob the scholar merely learned the id of cannot be
      // claimed as their slide media once it is no longer a fresh upload.
      vi.advanceTimersByTime(11 * 60 * 1000);
      await expect(
        scholar.mutation(api.artifacts.registerSlideAsset, { storageId: stale }),
      ).rejects.toThrow(/expired/i);
      expect(
        await scholar.query(api.artifacts.slideAssetUrls, {
          artifactId,
          storageIds: [stale],
        }),
      ).toEqual([{ storageId: stale, url: null }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an activity's Rabbit Slides media resolves only for its editors", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const inDeck = await t.run(async (ctx) => {
      const inDeck = await ctx.storage.store(new Blob(["teacher photo"]));
      await ctx.db.insert("activityResources", {
        activityId: world.activityId,
        title: "Teacher deck",
        source: {
          kind: "rabbit_slides",
          deck: JSON.stringify(deckWithImage(inDeck)),
        },
        order: 0,
        uploadedBy: world.teacherId,
      });
      return inDeck;
    });

    const teacher = await withUser(t, world.teacherId);
    expect(
      await teacher.query(api.activityResources.presentationAssetUrls, {
        activityId: world.activityId,
        storageIds: [inDeck, world.foreignStorageId],
      }),
    ).toEqual([
      { storageId: inDeck, url: expect.any(String) },
      { storageId: world.foreignStorageId, url: null },
    ]);

    const scholar = await withUser(t, world.scholarId);
    await expect(
      scholar.query(api.activityResources.presentationAssetUrls, {
        activityId: world.activityId,
        storageIds: [inDeck],
      }),
    ).rejects.toThrow();
  });

  test("message, photo-task, and deliverable reads carry their own URLs", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const { taskId } = await t.run(async (ctx) => {
      const imageId = await ctx.storage.store(new Blob(["chat photo"]));
      const appSnapshotStorageId = await ctx.storage.store(new Blob(["frame"]));
      await ctx.db.insert("messages", {
        sessionId: world.sessionId,
        role: "user",
        content: "look",
        flagged: false,
        imageId,
        appSnapshotStorageId,
      });
      const photoStorageId = await ctx.storage.store(new Blob(["task photo"]));
      const taskId = await ctx.db.insert("physicalTasks", {
        sessionId: world.sessionId,
        scholarId: world.scholarId,
        equipmentName: "Microscope",
        prompt: "Look at a leaf",
        status: "completed",
        suggestedAt: Date.now(),
        photoStorageId,
      });
      await ctx.db.insert("deliverables", {
        activityId: world.activityId,
        scholarId: world.scholarId,
        sessionId: world.sessionId,
        fileStorageId: await ctx.storage.store(new Blob(["deliverable"])),
        submittedAt: Date.now(),
      });
      return { taskId };
    });

    const scholar = await withUser(t, world.scholarId);
    const data = await scholar.query(api.sessions.getWithMessages, {
      id: world.sessionId,
    });
    const [message] = data!.messages;
    expect(message.imageUrl).toEqual(expect.any(String));
    expect(message.appSnapshotUrl).toEqual(expect.any(String));

    const task = await scholar.query(api.physicalTasks.getForCard, {
      id: taskId,
    });
    expect(task?.photoUrl).toEqual(expect.any(String));

    const deliverable = await scholar.query(
      api.deliverables.getForSessionActivity,
      { sessionId: world.sessionId, activityId: world.activityId },
    );
    expect(deliverable?.fileUrl).toEqual(expect.any(String));

    const other = await withUser(t, world.otherScholarId);
    await expect(
      other.query(api.physicalTasks.getForCard, { id: taskId }),
    ).rejects.toThrow();
    expect(
      await other.query(api.deliverables.getForSessionActivity, {
        sessionId: world.sessionId,
        activityId: world.activityId,
      }),
    ).toBeNull();
  });
});

// A row that stores a caller-supplied storage id serves that blob back through
// the reads above, so each write accepts only a fresh upload (TRA-394). The
// world's `foreignStorageId` stands in for an old scan the scholar learned.
describe("caller-supplied storage ids must be fresh uploads (TRA-394)", () => {
  const PAST_WINDOW_MS = 61 * 60 * 1000;

  test("sendMessage refuses a stale image and accepts a fresh one", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const world = await seedWorld(t);
      const scholar = await withUser(t, world.scholarId);
      vi.advanceTimersByTime(PAST_WINDOW_MS);

      await expect(
        scholar.mutation(api.sessions.sendMessage, {
          sessionId: world.sessionId,
          message: "look at this",
          imageId: world.foreignStorageId,
        }),
      ).rejects.toThrow(/expired/i);

      const fresh = await t.run(async (ctx) =>
        ctx.storage.store(new Blob(["my photo"])),
      );
      await scholar.mutation(api.sessions.sendMessage, {
        sessionId: world.sessionId,
        message: "look at this",
        imageId: fresh,
      });
      const imageIds = await t.run(async (ctx) =>
        (
          await ctx.db
            .query("messages")
            .withIndex("by_session", (q) => q.eq("sessionId", world.sessionId))
            .collect()
        ).flatMap((m) => (m.imageId ? [m.imageId] : [])),
      );
      expect(imageIds).toEqual([fresh]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("attachPhoto refuses a stale photo and accepts a fresh one", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const world = await seedWorld(t);
      const taskId = await t.run(async (ctx) =>
        ctx.db.insert("physicalTasks", {
          sessionId: world.sessionId,
          scholarId: world.scholarId,
          equipmentName: "Microscope",
          prompt: "Look at a leaf",
          status: "suggested",
          suggestedAt: Date.now(),
        }),
      );
      const scholar = await withUser(t, world.scholarId);
      vi.advanceTimersByTime(PAST_WINDOW_MS);

      await expect(
        scholar.mutation(api.physicalTasks.attachPhoto, {
          id: taskId,
          photoStorageId: world.foreignStorageId,
        }),
      ).rejects.toThrow(/expired/i);
      expect(
        (await t.run(async (ctx) => ctx.db.get(taskId)))?.photoStorageId,
      ).toBeUndefined();

      const fresh = await t.run(async (ctx) =>
        ctx.storage.store(new Blob(["leaf photo"])),
      );
      await scholar.mutation(api.physicalTasks.attachPhoto, {
        id: taskId,
        photoStorageId: fresh,
      });
      expect(
        (await t.run(async (ctx) => ctx.db.get(taskId)))?.photoStorageId,
      ).toBe(fresh);
    } finally {
      vi.useRealTimers();
    }
  });

  test("deliverables.submit refuses a stale new file but re-checks the file it already holds", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const world = await seedWorld(t);
      const onRow = await t.run(async (ctx) => {
        await ctx.db.patch(world.activityId, {
          deliverable: {
            kind: "photo",
            prompt: "Photograph your work.",
            mode: "manual",
            criteria: [],
          },
        });
        const onRow = await ctx.storage.store(new Blob(["submitted earlier"]));
        await ctx.db.insert("deliverables", {
          activityId: world.activityId,
          scholarId: world.scholarId,
          sessionId: world.sessionId,
          fileStorageId: onRow,
          submittedAt: Date.now(),
        });
        return onRow;
      });
      const scholar = await withUser(t, world.scholarId);
      vi.advanceTimersByTime(PAST_WINDOW_MS);
      const submit = (fileStorageId: Id<"_storage">) =>
        scholar.mutation(api.deliverables.submit, {
          activityId: world.activityId,
          sessionId: world.sessionId,
          fileStorageId,
        });
      const heldFile = async () =>
        (
          await t.run(async (ctx) =>
            ctx.db
              .query("deliverables")
              .withIndex("by_session", (q) =>
                q.eq("sessionId", world.sessionId),
              )
              .unique(),
          )
        )?.fileStorageId;

      // The file already on the row is not a new claim, however old it is.
      await submit(onRow);
      expect(await heldFile()).toBe(onRow);

      await expect(submit(world.foreignStorageId)).rejects.toThrow(/expired/i);
      expect(await heldFile()).toBe(onRow);

      const fresh = await t.run(async (ctx) =>
        ctx.storage.store(new Blob(["retake"])),
      );
      await submit(fresh);
      expect(await heldFile()).toBe(fresh);
    } finally {
      vi.useRealTimers();
    }
  });
});
