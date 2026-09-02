import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  ACTIVITY_RESOURCE_AI_MAX_BYTES,
  ACTIVITY_RESOURCE_MAX_BYTES,
  validateActivityResourceFile,
  validateResourceUrl,
} from "../activityResources";
import { ACTIVITY_RESOURCE_STORED_TEXT_CHARS } from "../activityResourceActions";
import {
  ACTIVITY_RESOURCE_PER_FILE_CHARS,
  ACTIVITY_RESOURCE_TOTAL_TEXT_CHARS,
  buildActivityResourcesSection,
  buildSystemPromptParts,
  type ActivityResourceContext,
} from "../sessionHelpers";
import { emptyDeck } from "../../shared/slidesScene";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

async function seedWorld(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Test School",
      slug: "test-school",
      kind: "school",
      isPrimary: true,
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Test Teacher",
      username: "testteacher",
      role: "teacher",
      institutionId,
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Test Scholar",
      username: "testscholar",
      role: "scholar",
      institutionId,
    });
    const otherScholarId = await ctx.db.insert("users", {
      name: "Other Scholar",
      username: "otherscholar",
      role: "scholar",
      institutionId,
    });
    // Operations staff: base `staff` role + a `school:operations` capability
    // grant (the retired registrar role's successor) — scholar-admin access,
    // but no curriculum grant.
    const opsStaffId = await ctx.db.insert("users", {
      name: "Test Ops Staff",
      username: "testopsstaff",
      role: "staff",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: teacherId,
      role: "teacher",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: scholarId,
      role: "scholar",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: otherScholarId,
      role: "scholar",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: opsStaffId,
      role: "staff",
      institutionId,
    });
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: opsStaffId,
      institutionId,
      capability: "school:operations",
      grantedBy: teacherId,
      grantedAt: Date.now(),
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Resource Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Resource Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Resource Activity",
      kind: "online",
      systemPrompt: "Use the source material.",
      order: 0,
    });
    const otherActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Other Activity",
      kind: "online",
      order: 1,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      unitId,
      lessonId,
      activityId,
      title: "Resource Session",
      isArchived: false,
    });
    return {
      teacherId,
      scholarId,
      otherScholarId,
      opsStaffId,
      unitId,
      lessonId,
      activityId,
      otherActivityId,
      sessionId,
    };
  });
}

describe("activity resource validation", () => {
  test("normalizes http(s) URLs and rejects other protocols", () => {
    expect(validateResourceUrl(" https://example.com/article ")).toBe(
      "https://example.com/article",
    );
    expect(() => validateResourceUrl("file:///tmp/lesson.pdf")).toThrow(
      /http:\/\/ or https:\/\//i,
    );
    expect(() => validateResourceUrl("not a url")).toThrow(/including https/i);
    expect(() => validateResourceUrl("example.com")).toThrow(/including https/i);
  });

  test("accepts v1 file kinds and rejects legacy DOC and oversize files", () => {
    expect(
      validateActivityResourceFile({
        fileName: "lesson.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 100,
      }),
    ).toBe("docx");
    expect(() =>
      validateActivityResourceFile({
        fileName: "legacy.doc",
        mimeType: "application/msword",
        sizeBytes: 100,
      }),
    ).toThrow(/DOCX/i);
    expect(() =>
      validateActivityResourceFile({
        fileName: "huge.pdf",
        mimeType: "application/pdf",
        sizeBytes: ACTIVITY_RESOURCE_MAX_BYTES + 1,
      }),
    ).toThrow(/25 MB/i);
    expect(() =>
      validateActivityResourceFile({
        fileName: "large-image.png",
        mimeType: "image/png",
        sizeBytes: ACTIVITY_RESOURCE_AI_MAX_BYTES + 1,
      }),
    ).toThrow(/20 MB/i);
  });
});

describe("buildActivityResourcesSection", () => {
  test("preserves order, includes extracted file text and honest link/video framing", () => {
    const section = buildActivityResourcesSection([
      {
        id: "resource-file",
        title: "Article packet",
        kind: "file",
        url: null,
        extractedText: "A unique sentence about lava viscosity.",
      },
      {
        id: "resource-link",
        title: "Field guide",
        kind: "link",
        url: "https://example.com/guide",
        extractedText: null,
      },
      {
        id: "resource-video",
        title: "Eruption footage",
        kind: "video",
        url: "https://example.com/video",
        extractedText: null,
      },
    ])!;
    expect(section.indexOf("Article packet")).toBeLessThan(
      section.indexOf("Field guide"),
    );
    expect(section.indexOf("Field guide")).toBeLessThan(
      section.indexOf("Eruption footage"),
    );
    expect(section).toContain("A unique sentence about lava viscosity.");
    expect(section).toContain("https://example.com/guide");
    expect(section).toContain("https://example.com/video");
    expect(section).toContain("you have not read or watched it");
    expect(section).toContain("[resource_id: resource-file]");
    expect(section).toContain("share_resource(resource_id)");
    expect(section).toContain("Never dump all resources at the start");
  });

  test("enforces per-file and total extracted-text budgets", () => {
    const section = buildActivityResourcesSection(
      Array.from({ length: 6 }, (_, index) => ({
        id: `resource-${index}`,
        title: `File ${index}`,
        kind: "file" as const,
        url: null,
        extractedText: String(index).repeat(
          ACTIVITY_RESOURCE_PER_FILE_CHARS + 500,
        ),
      })),
    )!;
    // Every file overflows its per-file cap, so each included excerpt renders
    // under the TRUNCATED header variant.
    const extracted = section
      .split(/ {2}Extracted text[^\n]*:\n/)
      .slice(1)
      .map((part) => part.split("\n- ")[0].split("\n  Extracted text omitted")[0]);
    expect(extracted.every((text) => text.length <= ACTIVITY_RESOURCE_PER_FILE_CHARS)).toBe(true);
    expect(extracted.reduce((sum, text) => sum + text.length, 0)).toBe(
      ACTIVITY_RESOURCE_TOTAL_TEXT_CHARS,
    );
  });

  test("truncated files are labeled, and the honesty line scopes the claim to what was shown", () => {
    const fullText = "y".repeat(1_000);
    const overflowText = "z".repeat(ACTIVITY_RESOURCE_PER_FILE_CHARS + 250);
    const section = buildActivityResourcesSection([
      {
        id: "resource-full",
        title: "Short handout",
        kind: "file",
        url: null,
        extractedText: fullText,
      },
      {
        id: "resource-cut",
        title: "Long packet",
        kind: "file",
        url: null,
        extractedText: overflowText,
      },
    ])!;
    // The untruncated file keeps the plain header; the overflowing one is
    // explicitly labeled with how much of it the tutor actually saw.
    expect(section).toContain("Extracted text:\n" + fullText);
    expect(section).toContain(
      `Extracted text (TRUNCATED — first ${ACTIVITY_RESOURCE_PER_FILE_CHARS} of ${overflowText.length} characters; you have NOT read the rest):`,
    );
    // The blanket claim scopes itself: only-what-is-shown, never the full file.
    expect(section).toContain("You have read ONLY the extracted text shown above");
    expect(section).toContain("never imply you know the rest of the file");
  });

  test("a file starved by the total budget is called out as unread, not silently textless", () => {
    // Four max-size files exhaust the 80K total; the fifth gets zero chars.
    const section = buildActivityResourcesSection(
      Array.from({ length: 5 }, (_, index) => ({
        id: `resource-${index}`,
        title: `File ${index}`,
        kind: "file" as const,
        url: null,
        extractedText: "w".repeat(ACTIVITY_RESOURCE_PER_FILE_CHARS),
      })),
    )!;
    expect(section).toContain(
      "Extracted text omitted (shared budget exhausted) — you have NOT read this file.",
    );
  });
});

describe("activity resources land in the cached stable prefix", () => {
  // Positional call mirroring physicalEnvironmentSection.test.ts: only
  // scholarName + the trailing activityResourceContext are set.
  function parts(resources: ActivityResourceContext[] | null) {
    return buildSystemPromptParts(
      null, // teacherWhisper
      null, // readingLevel
      "Kai", // scholarName
      null, // unitContext
      null, // personaContext
      null, // perspectiveContext
      null, // processContext
      null, // processStateData
      null, // artifactData
      null, // dossierContent
      null, // seedsData
      null, // masteryContext
      null, // signalContext
      null, // timingContext
      null, // lessonContext
      null, // teacherDirectives
      null, // lessonActivityContext
      null, // priorActivityContext
      null, // activityContext
      null, // standaloneDeliverableContext
      null, // currentVerdictsContext
      false, // isFirstTurn
      false, // isFirstSession
      null, // lastSessionAt
      null, // webPracticeContext
      null, // granuleStatusContext
      null, // activityRecipe
      null, // baselineEvidenceContext
      null, // seedOriginContext
      null, // documentNotes
      null, // advanceRubricContext
      null, // practiceSkillsContext
      null, // physicalEnvironmentContext
      null, // goalsContext
      null, // conversationCompletionContext
      null, // weeklyGoalsContext
      resources, // activityResourceContext
    );
  }

  const sampleResources: ActivityResourceContext[] = [
    {
      id: "resource-file",
      title: "Article packet",
      kind: "file",
      url: null,
      extractedText: "A unique sentence about lava viscosity.",
    },
  ];

  test("the section is in `stable` (cached), not the per-turn `dynamic` tail", () => {
    const { stable, dynamic } = parts(sampleResources);
    expect(stable).toContain("ACTIVITY RESOURCES");
    expect(stable).toContain("A unique sentence about lava viscosity.");
    expect(dynamic).not.toContain("ACTIVITY RESOURCES");
  });

  test("no resources → byte-identical to omitting the section entirely", () => {
    const withNull = parts(null);
    const withEmpty = parts([]);
    expect(withNull.stable).toBe(withEmpty.stable);
    expect(withNull.dynamic).toBe(withEmpty.dynamic);
    expect(withNull.stable).not.toContain("ACTIVITY RESOURCES");
  });
});

describe("activityResources API", () => {
  test("curriculum editor can add, rename, reorder, and remove URL resources", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);

    const linkId = await teacher.mutation(api.activityResources.addLink, {
      activityId: world.activityId,
      title: "Article",
      url: "https://example.com/article",
    });

    const videoId = await teacher.mutation(api.activityResources.addVideo, {
      activityId: world.activityId,
      title: "Video",
      url: "https://example.com/video",
    });
    await teacher.mutation(api.activityResources.rename, {
      resourceId: linkId,
      title: "Primary article",
    });
    await teacher.mutation(api.activityResources.reorder, {
      activityId: world.activityId,
      resourceIds: [videoId, linkId],
    });

    const ordered = await teacher.query(
      api.activityResources.listForActivity,
      { activityId: world.activityId },
    );
    expect(ordered.map((row) => row.title)).toEqual([
      "Video",
      "Primary article",
    ]);

    await teacher.mutation(api.activityResources.remove, {
      resourceId: linkId,
    });
    expect(
      await t.run(async (ctx) => await ctx.db.get(linkId)),
    ).toBeNull();
  });

  test("same-unit references reach scholar lists, tutor context, sharing, and transcripts in owned-first order", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const scholar = await withUser(t, world.scholarId);
    const ownedId = await teacher.mutation(api.activityResources.addLink, {
      activityId: world.activityId,
      title: "Owned source",
      url: "https://example.com/owned",
    });
    const referencedId = await teacher.mutation(api.activityResources.addLink, {
      activityId: world.otherActivityId,
      title: "Referenced source",
      url: "https://example.com/referenced",
    });

    await teacher.mutation(api.activityResources.setReferencedResources, {
      activityId: world.activityId,
      resourceIds: [referencedId],
    });

    const options = await teacher.query(
      api.activityResources.referenceOptionsForActivity,
      { activityId: world.activityId },
    );
    expect(options.selectedResourceIds).toEqual([referencedId]);
    expect(options.options).toEqual([
      expect.objectContaining({
        resourceId: referencedId,
        ownerActivityTitle: "Other Activity",
      }),
    ]);
    const scholarRows = await scholar.query(
      api.activityResources.listForSession,
      { sessionId: world.sessionId },
    );
    expect(scholarRows.map((row) => row.title)).toEqual([
      "Owned source",
      "Referenced source",
    ]);
    expect(scholarRows.map((row) => row._id)).toEqual([ownedId, referencedId]);

    const context = await t.query(
      internal.sessionHelpers.getSessionContext,
      { sessionId: world.sessionId },
    );
    expect(context?.activityResourceContext?.map((row) => row.title)).toEqual([
      "Owned source",
      "Referenced source",
    ]);

    const placeholderId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId: world.sessionId,
        role: "assistant",
        content: "",
        streamId: "referenced-sharing",
        flagged: false,
      }),
    );
    await t.mutation(internal.activityResources.shareFromTutor, {
      currentMessageId: placeholderId,
      sessionId: world.sessionId,
      resourceId: referencedId,
      contentSoFar: "",
    });
    const transcript = await scholar.query(api.sessions.getWithMessages, {
      id: world.sessionId,
    });
    expect(
      transcript.messages.find(
        (message) => message.toolAction === "resource_share",
      )?.resourceShare,
    ).toMatchObject({
      resourceId: referencedId,
      title: "Referenced source",
    });

    const outline = await scholar.query(api.activities.listByUnitPublic, {
      unitId: world.unitId,
      includeResources: true,
    });
    expect(
      outline.find((activity) => activity._id === world.activityId)?.resources,
    ).toEqual([
      expect.objectContaining({ _id: ownedId }),
      expect.objectContaining({ _id: referencedId }),
    ]);
  });

  test("reference writes reject duplicates, self-owned, presentation, stale, and cross-institution resources", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const selfOwnedId = await teacher.mutation(api.activityResources.addLink, {
      activityId: world.activityId,
      title: "Self owned",
      url: "https://example.com/self",
    });
    const siblingId = await teacher.mutation(api.activityResources.addLink, {
      activityId: world.otherActivityId,
      title: "Sibling",
      url: "https://example.com/sibling",
    });
    const { presentationId, staleId, foreignId } = await t.run(async (ctx) => {
      const presentationId = await ctx.db.insert("activityResources", {
        activityId: world.otherActivityId,
        title: "Teacher deck",
        source: {
          kind: "rabbit_slides",
          deck: JSON.stringify(emptyDeck("Teacher deck", "slide-1")),
        },
        order: 1,
        uploadedBy: world.teacherId,
      });
      const staleId = await ctx.db.insert("activityResources", {
        activityId: world.otherActivityId,
        title: "Deleted",
        source: { kind: "link", url: "https://example.com/deleted" },
        order: 2,
        uploadedBy: world.teacherId,
      });
      await ctx.db.delete(staleId);

      const foreignInstitutionId = await ctx.db.insert("institutions", {
        name: "Foreign School",
        slug: "foreign-school",
        kind: "school",
        isPrimary: false,
      });
      const foreignUnitId = await ctx.db.insert("units", {
        teacherId: world.teacherId,
        institutionId: foreignInstitutionId,
        title: "Foreign Unit",
        isActive: true,
      });
      const foreignLessonId = await ctx.db.insert("lessons", {
        unitId: foreignUnitId,
        title: "Foreign Lesson",
        order: 0,
      });
      const foreignActivityId = await ctx.db.insert("activities", {
        lessonId: foreignLessonId,
        title: "Foreign Activity",
        kind: "online",
        order: 0,
      });
      const foreignId = await ctx.db.insert("activityResources", {
        activityId: foreignActivityId,
        title: "Foreign source",
        source: { kind: "link", url: "https://example.com/foreign" },
        order: 0,
        uploadedBy: world.teacherId,
      });
      return { presentationId, staleId, foreignId };
    });

    for (const resourceIds of [
      [siblingId, siblingId],
      [selfOwnedId],
      [presentationId],
      [staleId],
      [foreignId],
    ]) {
      await expect(
        teacher.mutation(api.activityResources.setReferencedResources, {
          activityId: world.activityId,
          resourceIds,
        }),
      ).rejects.toThrow();
    }
  });

  test("reads omit forged stale pointers and deletion prunes valid references", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const scholar = await withUser(t, world.scholarId);
    const referencedId = await teacher.mutation(api.activityResources.addLink, {
      activityId: world.otherActivityId,
      title: "Temporary source",
      url: "https://example.com/temporary",
    });
    await teacher.mutation(api.activityResources.setReferencedResources, {
      activityId: world.activityId,
      resourceIds: [referencedId],
    });

    await teacher.mutation(api.activityResources.remove, {
      resourceId: referencedId,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(world.activityId)))
        ?.referencedResourceIds,
    ).toBeUndefined();

    const staleId = await t.run(async (ctx) => {
      const resourceId = await ctx.db.insert("activityResources", {
        activityId: world.otherActivityId,
        title: "Stale source",
        source: { kind: "link", url: "https://example.com/stale" },
        order: 0,
        uploadedBy: world.teacherId,
      });
      await ctx.db.patch(world.activityId, {
        referencedResourceIds: [resourceId],
      });
      await ctx.db.delete(resourceId);
      return resourceId;
    });
    const rows = await scholar.query(api.activityResources.listForSession, {
      sessionId: world.sessionId,
    });
    expect(rows).toEqual([]);
    expect(
      (
        await t.query(internal.sessionHelpers.getSessionContext, {
          sessionId: world.sessionId,
        })
      )?.activityResourceContext,
    ).toBeNull();
    expect(
      (await t.run((ctx) => ctx.db.get(world.activityId)))
        ?.referencedResourceIds,
    ).toEqual([staleId]);
  });

  test("material APIs and scholar display exclude presentation resources", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const scholar = await withUser(t, world.scholarId);
    await teacher.mutation(api.activityResources.addLink, {
      activityId: world.activityId,
      title: "Article",
      url: "https://example.com/article",
    });
    await t.run((ctx) =>
      ctx.db.insert("activityResources", {
        activityId: world.activityId,
        title: "Private reference slides",
        source: {
          kind: "google_slides",
          presentationId: "private-google-id",
          url: "https://docs.google.com/presentation/d/private-google-id/edit",
          principal: { kind: "personal_oauth", userId: world.teacherId },
        },
        order: 1,
        uploadedBy: world.teacherId,
      }),
    );

    const materials = await teacher.query(api.activityResources.listForActivity, {
      activityId: world.activityId,
    });
    expect(materials.map((resource) => resource.source.kind)).toEqual(["link"]);
    const presentations = await teacher.query(
      api.activityResources.presentationsForActivity,
      { activityId: world.activityId },
    );
    expect(presentations).toHaveLength(1);
    expect(presentations[0].source).toMatchObject({
      kind: "google_slides",
      presentationId: "private-google-id",
    });
    expect(presentations[0]).toMatchObject({
      principalKind: "personal_oauth",
      canActAsPrincipal: true,
    });
    expect(JSON.stringify(presentations)).not.toContain('"principal"');
    const scholarRows = await scholar.query(api.activityResources.listForSession, {
      sessionId: world.sessionId,
    });
    expect(scholarRows.map((resource) => resource.title)).toEqual(["Article"]);
    expect(JSON.stringify(scholarRows)).not.toContain("private-google-id");
    expect(JSON.stringify(scholarRows)).not.toContain("docs.google.com");
  });


  test("another scholar cannot mutate or read a session's resources", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const other = await withUser(t, world.otherScholarId);
    await expect(
      other.mutation(api.activityResources.addLink, {
        activityId: world.activityId,
        title: "Nope",
        url: "https://example.com",
      }),
    ).rejects.toThrow(/Forbidden/i);
    await expect(
      other.query(api.activityResources.listForSession, {
        sessionId: world.sessionId,
      }),
    ).rejects.toThrow(/Forbidden/i);
  });

  test("non-curriculum staff cannot mutate activity resources", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const opsStaff = await withUser(t, world.opsStaffId);
    await expect(
      opsStaff.mutation(api.activityResources.addVideo, {
        activityId: world.activityId,
        title: "Nope",
        url: "https://example.com/video",
      }),
    ).rejects.toThrow(/Forbidden/i);
  });

  test("file registration uses storage metadata, extracts text, and scholar reads strip internals", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const scholar = await withUser(t, world.scholarId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new Blob(["The resource says basalt cools quickly."], {
          type: "text/plain",
        }),
      ),
    );

    vi.useFakeTimers();
    let resourceId: Id<"activityResources">;
    try {
      const result = await teacher.mutation(
        api.activityResources.registerFile,
        {
          activityId: world.activityId,
          title: "Basalt notes",
          fileName: "basalt.txt",
          storageId,
        },
      );
      if (!result.ok) throw new Error(result.error);
      resourceId = result.resourceId;
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const stored = await t.run(async (ctx) => await ctx.db.get(resourceId));
    expect(stored).toMatchObject({
      title: "Basalt notes",
      extractionStatus: "ready",
      extractedText: "The resource says basalt cools quickly.",
    });

    const scholarRows = await scholar.query(
      api.activityResources.listForSession,
      { sessionId: world.sessionId },
    );
    expect(scholarRows).toHaveLength(1);
    expect(scholarRows[0]).toMatchObject({
      title: "Basalt notes",
      kind: "file",
      fileName: "basalt.txt",
    });
    expect(scholarRows[0].url).toMatch(/^https?:/);
    expect("extractedText" in scholarRows[0]).toBe(false);
    expect("extractionError" in scholarRows[0]).toBe(false);
  });

  test("caps extracted text before storing it on the resource row", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const longText = "x".repeat(ACTIVITY_RESOURCE_STORED_TEXT_CHARS + 1_000);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([longText], { type: "text/plain" })),
    );

    vi.useFakeTimers();
    let resourceId: Id<"activityResources">;
    try {
      const result = await teacher.mutation(
        api.activityResources.registerFile,
        {
          activityId: world.activityId,
          title: "Long notes",
          fileName: "long.txt",
          storageId,
        },
      );
      if (!result.ok) throw new Error(result.error);
      resourceId = result.resourceId;
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const stored = await t.run(async (ctx) => ctx.db.get(resourceId));
    expect(stored?.extractedText?.startsWith("x".repeat(100))).toBe(true);
    expect(stored?.extractedText?.endsWith("[truncated]")).toBe(true);
    expect(stored?.extractedText?.length).toBeLessThan(
      ACTIVITY_RESOURCE_STORED_TEXT_CHARS + 20,
    );
  });

  test("normalizes extension-accepted PDF MIME before extraction", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new Blob(["%PDF-1.7"], { type: "application/octet-stream" }),
      ),
    );
    const result = await teacher.mutation(
      api.activityResources.registerFile,
      {
        activityId: world.activityId,
        title: "Generic PDF",
        fileName: "generic.pdf",
        storageId,
      },
    );
    if (!result.ok) throw new Error(result.error);
    const row = await t.run(async (ctx) => ctx.db.get(result.resourceId));
    expect(row?.source).toMatchObject({
      kind: "file",
      mimeType: "application/pdf",
    });
  });

  test("normalizes an extension-only supported image MIME", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new Blob(["png"], { type: "application/octet-stream" }),
      ),
    );
    const result = await teacher.mutation(
      api.activityResources.registerFile,
      {
        activityId: world.activityId,
        title: "Diagram",
        fileName: "diagram.png",
        storageId,
      },
    );
    if (!result.ok) throw new Error(result.error);
    const row = await t.run(async (ctx) => ctx.db.get(result.resourceId));
    expect(row?.source).toMatchObject({
      kind: "file",
      mimeType: "image/png",
    });
  });

  test("permitted teacher can read the scholar session resources", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    await teacher.mutation(api.activityResources.addLink, {
      activityId: world.activityId,
      title: "Teacher-visible link",
      url: "https://example.com",
    });
    const rows = await teacher.query(api.activityResources.listForSession, {
      sessionId: world.sessionId,
    });
    expect(rows.map((row) => row.title)).toEqual(["Teacher-visible link"]);
  });

  test("invalid uploaded file is rejected and its blob is deleted", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new Blob(["legacy"], { type: "application/msword" }),
      ),
    );
    const result = await teacher.mutation(
      api.activityResources.registerFile,
      {
        activityId: world.activityId,
        title: "Legacy",
        fileName: "legacy.doc",
        storageId,
      },
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/DOCX/i) });
    expect(
      await t.run(async (ctx) => ctx.db.system.get("_storage", storageId)),
    ).toBeNull();
  });

  test("oversize uploaded file is rejected and its blob is deleted", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new Blob([new Uint8Array(ACTIVITY_RESOURCE_MAX_BYTES + 1)], {
          type: "application/pdf",
        }),
      ),
    );
    const result = await teacher.mutation(
      api.activityResources.registerFile,
      {
        activityId: world.activityId,
        title: "Huge",
        fileName: "huge.pdf",
        storageId,
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/25 MB/i),
    });
    expect(
      await t.run(async (ctx) => ctx.db.system.get("_storage", storageId)),
    ).toBeNull();
  });

  test("session prompt context contains only the current activity's ordered resources", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("activityResources", {
        activityId: world.activityId,
        title: "Second",
        source: { kind: "video", url: "https://example.com/video" },
        order: 1,
        uploadedBy: world.teacherId,
      });
      await ctx.db.insert("activityResources", {
        activityId: world.activityId,
        title: "First",
        source: { kind: "link", url: "https://example.com/article" },
        order: 0,
        uploadedBy: world.teacherId,
      });
      await ctx.db.insert("activityResources", {
        activityId: world.otherActivityId,
        title: "Wrong activity",
        source: { kind: "link", url: "https://example.com/wrong" },
        order: 0,
        uploadedBy: world.teacherId,
      });
    });

    const context = await t.query(
      internal.sessionHelpers.getSessionContext,
      { sessionId: world.sessionId },
    );
    expect(context?.activityResourceContext?.map((row) => row.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(context?.activityResourceContext?.map((row) => row.id)).toHaveLength(
      2,
    );
  });

  test("share tool persists an inline event and resolves scholar-safe card data", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const scholar = await withUser(t, world.scholarId);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new Blob(["source"], { type: "application/pdf" }),
      ),
    );
    const resourceId = await t.run(async (ctx) =>
      ctx.db.insert("activityResources", {
        activityId: world.activityId,
        title: "Basalt field notes",
        source: {
          kind: "file",
          fileStorageId: storageId,
          fileName: "basalt.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
        },
        order: 0,
        uploadedBy: world.teacherId,
        extractionStatus: "ready",
        extractedText: "source",
      }),
    );
    const placeholderId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId: world.sessionId,
        role: "assistant",
        content: "",
        streamId: "sharing",
        promptVersion: "prompt-v1",
        flagged: false,
      }),
    );

    const result = await t.mutation(
      internal.activityResources.shareFromTutor,
      {
        currentMessageId: placeholderId,
        sessionId: world.sessionId,
        resourceId,
        contentSoFar: "Let’s look at one source.",
      },
    );
    expect(result).toMatchObject({
      title: "Basalt field notes",
      kind: "file",
    });

    const persisted = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (query) =>
          query.eq("sessionId", world.sessionId),
        )
        .collect(),
    );
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "Let’s look at one source.",
        }),
        expect.objectContaining({
          role: "tool",
          toolAction: "resource_share",
          content: String(resourceId),
        }),
        expect.objectContaining({
          _id: result.newAssistantMessageId,
          role: "assistant",
          content: "",
          promptVersion: "prompt-v1",
        }),
      ]),
    );

    const transcript = await scholar.query(api.sessions.getWithMessages, {
      id: world.sessionId,
    });
    const shareRow = transcript.messages.find(
      (message) => message.toolAction === "resource_share",
    );
    expect(shareRow?.resourceShare).toMatchObject({
      resourceId,
      title: "Basalt field notes",
      kind: "file",
      fileName: "basalt.pdf",
      mimeType: "application/pdf",
    });
    expect(shareRow?.resourceShare?.url).toMatch(/^https?:/);
    expect("extractedText" in (shareRow?.resourceShare ?? {})).toBe(false);
    expect("uploadedBy" in (shareRow?.resourceShare ?? {})).toBe(false);
  });

  test("share tool rejects resources from another activity without writing an event", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const wrongResourceId = await t.run(async (ctx) =>
      ctx.db.insert("activityResources", {
        activityId: world.otherActivityId,
        title: "Wrong source",
        source: { kind: "link", url: "https://example.com/wrong" },
        order: 0,
        uploadedBy: world.teacherId,
      }),
    );
    const placeholderId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId: world.sessionId,
        role: "assistant",
        content: "",
        streamId: "sharing",
        flagged: false,
      }),
    );

    await expect(
      t.mutation(internal.activityResources.shareFromTutor, {
        currentMessageId: placeholderId,
        sessionId: world.sessionId,
        resourceId: wrongResourceId,
        contentSoFar: "",
      }),
    ).rejects.toThrow(/not reachable/i);
    expect(await t.run(async (ctx) => ctx.db.get(placeholderId))).not.toBeNull();
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (query) =>
          query.eq("sessionId", world.sessionId),
        )
        .collect(),
    );
    expect(rows.some((row) => row.toolAction === "resource_share")).toBe(false);
  });

  test("resources remain teacher-manageable but inactive after leaving online kind", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const scholar = await withUser(t, world.scholarId);
    await teacher.mutation(api.activityResources.addLink, {
      activityId: world.activityId,
      title: "Online-only source",
      url: "https://example.com/source",
    });
    await teacher.mutation(api.activities.update, {
      id: world.activityId,
      kind: "offline",
    });

    expect(
      await teacher.query(api.activityResources.listForActivity, {
        activityId: world.activityId,
      }),
    ).toHaveLength(1);
    expect(
      await scholar.query(api.activityResources.listForSession, {
        sessionId: world.sessionId,
      }),
    ).toEqual([]);
    const context = await t.query(
      internal.sessionHelpers.getSessionContext,
      { sessionId: world.sessionId },
    );
    expect(context?.activityResourceContext).toBeNull();
  });

  test("scholar activity outlines include resources for non-online activities", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const teacher = await withUser(t, world.teacherId);
    const scholar = await withUser(t, world.scholarId);
    await teacher.mutation(api.activityResources.addVideo, {
      activityId: world.activityId,
      title: "Field demonstration",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    await teacher.mutation(api.activities.update, {
      id: world.activityId,
      kind: "offline",
    });

    const activities = await scholar.query(api.activities.listByUnitPublic, {
      unitId: world.unitId,
      includeResources: true,
    });

    expect(activities[0]?.resources).toEqual([
      expect.objectContaining({
        title: "Field demonstration",
        kind: "video",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      }),
    ]);

    const outsiderId = await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Other School",
        slug: "other-school",
        kind: "school",
      });
      const userId = await ctx.db.insert("users", {
        name: "Outside Scholar",
        username: "outsidescholar",
        role: "scholar",
        institutionId,
      });
      await ctx.db.insert("memberships", {
        userId,
        role: "scholar",
        institutionId,
      });
      return userId;
    });
    const outsider = await withUser(t, outsiderId);
    await expect(
      outsider.query(api.activities.listByUnitPublic, {
        unitId: world.unitId,
        includeResources: true,
      }),
    ).rejects.toThrow();
  });

  test.each(["activity", "lesson", "ai-lesson", "unit"] as const)(
    "%s deletion removes resource row and storage blob",
    async (scope) => {
      const t = convexTest(schema, modules);
      const world = await seedWorld(t);
      const teacher = await withUser(t, world.teacherId);
      const storageId = await t.run(async (ctx) =>
        ctx.storage.store(new Blob(["x"], { type: "text/plain" })),
      );
      const resourceId = await t.run(async (ctx) =>
        ctx.db.insert("activityResources", {
          activityId: world.activityId,
          title: "Disposable",
          source: {
            kind: "file",
            fileStorageId: storageId,
            fileName: "x.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
          },
          order: 0,
          uploadedBy: world.teacherId,
          extractionStatus: "ready",
          extractedText: "x",
        }),
      );

      // Every delete scope is refused when scholars have worked on the
      // activity (the execution guard, at activity/lesson/unit altitude).
      // These tests exercise resource cleanup, not the guard, so drop the
      // seeded session first.
      await t.run(async (ctx) => ctx.db.delete(world.sessionId));
      if (scope === "activity") {
        await teacher.mutation(api.activities.remove, {
          id: world.activityId,
        });
      } else if (scope === "lesson") {
        await teacher.mutation(api.lessons.remove, { id: world.lessonId });
      } else if (scope === "ai-lesson") {
        await t.mutation(internal.curriculumAssistant.deleteLessonInternal, {
          lessonId: world.lessonId,
        });
      } else {
        await teacher.mutation(api.units.remove, { id: world.unitId });
      }

      expect(await t.run(async (ctx) => ctx.db.get(resourceId))).toBeNull();
      expect(await t.run(async (ctx) => ctx.storage.get(storageId))).toBeNull();
    },
  );
});
