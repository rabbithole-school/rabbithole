import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// Phase 1 (deliverable-kinds plan §5) — the real PHOTO submission path.
//
// Covers the backend contract the new web + native photo surfaces rely on:
//   1. deliverables.submit with a fileStorageId (its FIRST call site) creates a
//      real deliverables row carrying the storage id.
//   2. deliverables.getAssessFile resolves that submitted photo's file (so the
//      multimodal assess can read it) — and still resolves a scanned
//      deliverable via its portfolioItem backlink.
//   3. Re-submitting a photo overwrites the same row (retake/replace) while the
//      prior rubric verdict remains durable until the replacement check lands.
//   4. Auth: submit is owner-gated; assessSubmittedDeliverable rejects a
//      non-owner, non-teacher caller before any model call.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar" }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const authSession: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", authSession);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** Unit → lesson → an ONLINE activity with a photo deliverable, + a session. */
async function seedPhotoActivity(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "Teacher",
      username: "photo-teacher",
      role: "teacher",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "U",
      isActive: true,
    } as Doc<"units">);
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Photograph your folded paper",
      kind: "online",
      systemPrompt: "Coach the scholar to photograph their work.",
      order: 0,
      deliverable: {
        kind: "photo",
        prompt: "Take a photo of your folded fraction strip.",
        mode: "manual",
        criteria: [
          { id: "c1", label: "Shows the fold", description: "The fold is visible." },
        ],
      },
    } as Doc<"activities">);
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Fractions",
      isArchived: false,
      activityId,
    });
    return { teacherId, activityId, sessionId };
  });
}

describe("photo deliverable submission", () => {
  test("submit with fileStorageId creates a row carrying the storage id", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "photo-scholar");
    const asScholar = await withUser(t, scholarId);
    const { activityId, sessionId } = await seedPhotoActivity(t, scholarId);

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], { type: "image/jpeg" })),
    );

    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: storageId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row).not.toBeNull();
    expect(row!.fileStorageId).toBe(storageId);
    expect(row!.scholarId).toBe(scholarId);
    expect(row!.sessionId).toBe(sessionId);
    expect(row!.activityId).toBe(activityId);
    // A fresh photo submission has no rubric verdict yet.
    expect(row!.rubricCheckedAt).toBeUndefined();
  });

  test("getAssessFile resolves the SUBMITTED photo's stored file", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "photo-scholar-2");
    const asScholar = await withUser(t, scholarId);
    const { activityId, sessionId } = await seedPhotoActivity(t, scholarId);

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" })),
    );
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: storageId,
    });

    const resolved = await t.run(async (ctx) =>
      // internalQuery — call it the same way the assess action does.
      ctx.runQuery(internal.deliverables.getAssessFile, { deliverableId }),
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("submission");
    expect(resolved!.storageId).toBe(storageId);
    // A submitted photo has no stored mime — the assess action sniffs it.
    expect(resolved!.mimeType).toBeNull();

    // The resolved file is actually fetchable (the assess action reads it).
    const byteLength = await t.run(async (ctx) => {
      const blob = await ctx.storage.get(resolved!.storageId);
      if (!blob) return -1;
      return (await blob.arrayBuffer()).byteLength;
    });
    expect(byteLength).toBe(4);
  });

  test("getAssessFile still resolves a SCANNED deliverable via its portfolioItem", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "scan-scholar");
    const { activityId, sessionId } = await seedPhotoActivity(t, scholarId);

    const { deliverableId, fileId } = await t.run(async (ctx) => {
      const fileId = await ctx.storage.store(
        new Blob(["%PDF-scan"], { type: "application/pdf" }),
      );
      const itemId = await ctx.db.insert("portfolioItems", {
        title: "scan",
        source: "upload",
        fileStorageId: fileId,
        fileMimeType: "application/pdf",
        aiCaption: "A worksheet",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
      });
      const deliverableId = await ctx.db.insert("deliverables", {
        activityId,
        scholarId,
        sessionId,
        portfolioItemId: itemId,
        submittedAt: 0,
      });
      return { deliverableId, fileId };
    });

    const resolved = await t.run(async (ctx) =>
      ctx.runQuery(internal.deliverables.getAssessFile, { deliverableId }),
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("scan");
    expect(resolved!.storageId).toBe(fileId);
    expect(resolved!.mimeType).toBe("application/pdf");
    expect(resolved!.aiCaption).toBe("A worksheet");
  });

  test("re-submitting a photo preserves the prior verdict until the replacement score lands", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "retake-scholar");
    const asScholar = await withUser(t, scholarId);
    const { activityId, sessionId } = await seedPhotoActivity(t, scholarId);

    const first = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["a"], { type: "image/jpeg" })),
    );
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: first,
    });
    // Simulate a prior rubric check having landed on this row.
    await t.run(async (ctx) =>
      ctx.db.patch(deliverableId, {
        rubricPassed: true,
        rubricCheckedAt: Date.now(),
        overall: "full",
      }),
    );

    const second = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["b"], { type: "image/jpeg" })),
    );
    const reId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: second,
    });

    expect(reId).toBe(deliverableId); // same row (dedupe on session+activity)
    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row!.fileStorageId).toBe(second);
    expect(row!.rubricPassed).toBe(true);
    expect(row!.rubricCheckedAt).toBeDefined();
    expect(row!.overall).toBe("full");
  });

  test("re-submissions share one pending Slack digest entry", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "digest-scholar");
    const asScholar = await withUser(t, scholarId);
    const { teacherId, activityId, sessionId } = await seedPhotoActivity(
      t,
      scholarId,
    );
    await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Geckos",
        scholarIds: [scholarId],
        slackChannelId: "C-GECKOS",
      }),
    );

    const first = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["first"], { type: "image/jpeg" })),
    );
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: first,
    });
    const second = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["second"], { type: "image/jpeg" })),
    );
    await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: second,
    });

    const queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].dedupeKey).toBe(`deliverable:${deliverableId}`);
    expect(queued[0].sent).toBe(false);
  });

  test("re-checking unchanged content does not create a new submission", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "recheck-scholar");
    const asScholar = await withUser(t, scholarId);
    const { activityId, sessionId } = await seedPhotoActivity(t, scholarId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["same"], { type: "image/jpeg" })),
    );
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: storageId,
    });
    await t.run(async (ctx) =>
      ctx.db.patch(deliverableId, {
        submittedAt: 123,
        rubricPassed: true,
        rubricCheckedAt: 456,
        overall: "full",
      }),
    );

    await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: storageId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row?.submittedAt).toBe(123);
    expect(row?.rubricPassed).toBe(true);
    expect(row?.rubricCheckedAt).toBe(456);
    expect(row?.overall).toBe("full");
  });

  test("text artifact re-checks compare the submitted content snapshot", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "text-recheck-scholar");
    const asScholar = await withUser(t, scholarId);
    const { activityId, sessionId } = await seedPhotoActivity(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.patch(activityId, {
        deliverable: {
          kind: "text",
          prompt: "Explain your prediction.",
          mode: "manual",
          criteria: [{ id: "c1", label: "Explains why" }],
        },
      });
    });
    const artifactId = await t.run(async (ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "Prediction",
        content: "The light removes the silhouette.",
        lastEditedBy: "scholar",
      }),
    );
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });
    await t.run(async (ctx) =>
      ctx.db.patch(deliverableId, {
        submittedAt: 123,
        rubricPassed: true,
        rubricCheckedAt: 456,
        overall: "full",
      }),
    );

    await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });
    const unchanged = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(unchanged?.submittedAt).toBe(123);
    expect(unchanged?.rubricPassed).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.patch(artifactId, {
        content: "Matching the background light removes the contrast.",
      });
    });
    await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });
    const changed = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(changed?.submittedAt).toBeGreaterThan(123);
    expect(changed?.textContent).toBe(
      "Matching the background light removes the contrast.",
    );
    expect(changed?.rubricPassed).toBe(true);
    expect(changed?.rubricCheckedAt).toBe(456);
  });

  test("a rubric result stays attached to the submitted text snapshot", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "snapshot-scholar");
    const asScholar = await withUser(t, scholarId);
    const { activityId, sessionId } = await seedPhotoActivity(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.patch(activityId, {
        deliverable: {
          kind: "text",
          prompt: "Explain your prediction.",
          mode: "manual",
          criteria: [{ id: "c1", label: "Explains why" }],
        },
      });
    });
    const artifactId = await t.run(async (ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "Prediction",
        content: "Submitted version",
        lastEditedBy: "scholar",
      }),
    );
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(artifactId, { content: "Edited while checking" });
      await ctx.runMutation(internal.deliverables.applyRubricScoreFromTool, {
        sessionId,
        artifactId,
        verdicts: [{ criterionId: "c1", level: "full" }],
        preserveSubmittedSnapshot: true,
      });
    });

    const deliverable = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(deliverable?.textContent).toBe("Submitted version");
    expect(deliverable?.rubricPassed).toBe(true);
  });

  test("an autonomous tutor score snapshots the current live artifact", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "autonomous-score-scholar");
    const asScholar = await withUser(t, scholarId);
    const { activityId, sessionId } = await seedPhotoActivity(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.patch(activityId, {
        deliverable: {
          kind: "text",
          prompt: "Explain your prediction.",
          mode: "manual",
          criteria: [{ id: "c1", label: "Explains why" }],
        },
      });
    });
    const artifactId = await t.run(async (ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "Prediction",
        content: "First draft",
        lastEditedBy: "scholar",
      }),
    );
    await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(artifactId, { content: "Current revised draft" });
      await ctx.runMutation(internal.deliverables.applyRubricScoreFromTool, {
        sessionId,
        artifactId,
        verdicts: [{ criterionId: "c1", level: "half" }],
      });
    });

    const deliverable = await t.run(async (ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .first(),
    );
    expect(deliverable?.textContent).toBe("Current revised draft");
    expect(deliverable?.overall).toBe("half");
  });

  test("submit rejects an activity that is not the session's own activity", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "linkage-scholar");
    const asScholar = await withUser(t, scholarId);
    const { sessionId } = await seedPhotoActivity(t, scholarId);

    // A SECOND, unrelated deliverable-bearing activity the scholar was never
    // assigned (its own lesson; no session points at it).
    const otherActivityId = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "T2",
        username: "other-teacher",
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U2",
        isActive: true,
      } as Doc<"units">);
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L2", order: 0 });
      return ctx.db.insert("activities", {
        lessonId,
        title: "Some OTHER activity",
        kind: "online",
        systemPrompt: "x",
        order: 0,
        deliverable: {
          kind: "photo",
          prompt: "Unrelated photo.",
          mode: "manual",
          criteria: [{ id: "z", label: "z" }],
        },
      } as Doc<"activities">);
    });

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "image/jpeg" })),
    );
    // Submitting against an activity the session doesn't belong to must be
    // rejected — otherwise a scholar could mint completion/mastery for an
    // arbitrary activity through their own owned session.
    await expect(
      asScholar.mutation(api.deliverables.submit, {
        activityId: otherActivityId,
        sessionId,
        fileStorageId: storageId,
      }),
    ).rejects.toThrow(/not part of this session/);

    // No deliverable row leaked into existence for that activity.
    const leaked = await t.run(async (ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_activity", (q) => q.eq("activityId", otherActivityId))
        .collect(),
    );
    expect(leaked.length).toBe(0);
  });

  test("submit rejects a non-owner scholar", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "owner-x");
    const otherId = await seedScholar(t, "intruder-x");
    const asOther = await withUser(t, otherId);
    const { activityId, sessionId } = await seedPhotoActivity(t, ownerId);

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "image/jpeg" })),
    );
    await expect(
      asOther.mutation(api.deliverables.submit, {
        activityId,
        sessionId,
        fileStorageId: storageId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("assessSubmittedDeliverable rejects a non-owner, non-teacher caller", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "owner-y");
    const otherId = await seedScholar(t, "intruder-y");
    const asOwner = await withUser(t, ownerId);
    const asOther = await withUser(t, otherId);
    const { activityId, sessionId } = await seedPhotoActivity(t, ownerId);

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["y"], { type: "image/jpeg" })),
    );
    const deliverableId = await asOwner.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      fileStorageId: storageId,
    });

    // A different scholar cannot assess someone else's photo. The gate throws
    // before any model call, so this is a pure auth assertion.
    await expect(
      asOther.action(api.deliverableAssess.assessSubmittedDeliverable, {
        deliverableId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});
