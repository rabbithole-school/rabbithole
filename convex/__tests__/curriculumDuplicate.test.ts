import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: TestConvex<typeof schema>,
  role: "teacher" | "scholar",
  username: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username,
      role,
    }),
  );
}

async function withUser(
  t: TestConvex<typeof schema>,
  userId: Id<"users">,
) {
  const sessionId = await t.run((ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function executionCounts(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => ({
    assignments: (await ctx.db.query("assignments").collect()).length,
    sessions: (await ctx.db.query("sessions").collect()).length,
    activityCompletions: (
      await ctx.db.query("activityCompletions").collect()
    ).length,
    deliverables: (await ctx.db.query("deliverables").collect()).length,
    unitReviews: (await ctx.db.query("unitReviews").collect()).length,
    testDriveFlags: (await ctx.db.query("testDriveFlags").collect()).length,
  }));
}

describe("curriculum node duplication", () => {
  test("activities.duplicate copies design fields immediately after the source", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "activity-teacher");
    const { lessonId, sourceId, trailingId, processId, resourceId } = await t.run(
      async (ctx) => {
        const processId = await ctx.db.insert("processes", {
          teacherId,
          title: "Notice and wonder",
          steps: [],
          isActive: true,
        });
        const unitId = await ctx.db.insert("units", {
          teacherId,
          title: "Flight",
          isActive: true,
        });
        const lessonId = await ctx.db.insert("lessons", {
          unitId,
          title: "Lift",
          order: 0,
        });
        const warmupId = await ctx.db.insert("activities", {
          lessonId,
          title: "Warm-up",
          kind: "offline",
          order: 0,
        });
        const resourceId = await ctx.db.insert("activityResources", {
          activityId: warmupId,
          title: "Wing reference",
          source: { kind: "link", url: "https://example.com/wing" },
          order: 0,
          uploadedBy: teacherId,
        });
        const sourceId = await ctx.db.insert("activities", {
          lessonId,
          title: "Wind tunnel",
          description: "Test wing shapes.",
          kind: "online",
          systemPrompt: "Ask for a prediction before each trial.",
          processId,
          durationMinutes: 35,
          hasScholarAngles: true,
          defaultMode: "classFocus",
          deliverable: {
            kind: "text",
            prompt: "Explain the strongest design.",
            mode: "manual",
            criteria: [{ id: "evidence", label: "Uses trial evidence" }],
          },
          advanceRubric: {
            criteria: [{ id: "reasoning", label: "Explains the mechanism" }],
          },
          recipe: "baseline",
          referencedResourceIds: [resourceId],
          order: 1,
          googleSlidesPresentationId: "generated-deck",
          googleSlidesUrl: "https://docs.google.com/presentation/d/generated-deck",
        });
        const trailingId = await ctx.db.insert("activities", {
          lessonId,
          title: "Debrief",
          kind: "offline",
          order: 2,
        });
        return { lessonId, sourceId, trailingId, processId, resourceId };
      },
    );

    const asTeacher = await withUser(t, teacherId);
    const copyId = await asTeacher.mutation(api.activities.duplicate, {
      activityId: sourceId,
    });

    const { rows, copy, trailing } = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
        .collect();
      rows.sort((a, b) => a.order - b.order);
      return {
        rows,
        copy: await ctx.db.get(copyId),
        trailing: await ctx.db.get(trailingId),
      };
    });

    expect(rows.map((row) => [row.title, row.order])).toEqual([
      ["Warm-up", 0],
      ["Wind tunnel", 1],
      ["Wind tunnel (copy)", 2],
      ["Debrief", 3],
    ]);
    expect(copy).toMatchObject({
      lessonId,
      title: "Wind tunnel (copy)",
      description: "Test wing shapes.",
      kind: "online",
      systemPrompt: "Ask for a prediction before each trial.",
      processId,
      durationMinutes: 35,
      hasScholarAngles: true,
      defaultMode: "classFocus",
      recipe: "baseline",
      order: 2,
    });
    expect(copy?.deliverable?.criteria).toEqual([
      { id: "evidence", label: "Uses trial evidence" },
    ]);
    expect(copy?.advanceRubric?.criteria).toEqual([
      { id: "reasoning", label: "Explains the mechanism" },
    ]);
    expect(copy?.googleSlidesPresentationId).toBeUndefined();
    expect(copy?.googleSlidesUrl).toBeUndefined();
    expect(copy?.referencedResourceIds).toEqual([resourceId]);
    expect(trailing?.order).toBe(3);
  });

  test("activities.forkToMyUnit creates independent curriculum and starter rows", async () => {
    const t = convexTest(schema, modules);
    const sourceTeacherId = await seedUser(
      t,
      "teacher",
      "source-activity-teacher",
    );
    const callerId = await seedUser(t, "teacher", "forking-activity-teacher");
    const fixture = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: sourceTeacherId,
        title: "Shared Physics",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Forces",
        order: 0,
      });
      const starterAppId = await ctx.db.insert("customApps", {
        token: "source-starter-token",
        name: "Force explorer",
        kind: "static",
        status: "live",
        html: "<!doctype html><p>Original app</p>",
        origin: "starter",
        createdBy: sourceTeacherId,
        updatedAt: 123,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Force explorer",
        description: "Explore how force changes motion.",
        kind: "vibecode",
        systemPrompt: "Ask for a prediction before each trial.",
        appRequest: "Build a cart simulator.",
        tutorModel: "fable",
        starterAppId,
        scholarsStartFrom: "starter",
        order: 0,
      });
      return { activityId, starterAppId };
    });
    const sourceBefore = await t.run((ctx) => ctx.db.get(fixture.activityId));
    const starterBefore = await t.run((ctx) =>
      ctx.db.get(fixture.starterAppId),
    );

    const result = await (
      await withUser(t, callerId)
    ).mutation(api.activities.forkToMyUnit, {
      activityId: fixture.activityId,
    });

    const state = await t.run(async (ctx) => {
      const activity = await ctx.db.get(result.activityId);
      return {
        unit: await ctx.db.get(result.unitId),
        lesson: await ctx.db.get(result.lessonId),
        activity,
        starter: activity?.starterAppId
          ? await ctx.db.get(activity.starterAppId)
          : null,
        source: await ctx.db.get(fixture.activityId),
        sourceStarter: await ctx.db.get(fixture.starterAppId),
      };
    });

    expect(state.unit).toMatchObject({
      teacherId: callerId,
      title: "Force explorer Lab",
      isActive: true,
    });
    expect(state.lesson).toMatchObject({
      unitId: result.unitId,
      title: "Explore Force explorer",
    });
    expect(state.activity).toMatchObject({
      lessonId: result.lessonId,
      title: "Force explorer",
      description: "Explore how force changes motion.",
      kind: "vibecode",
      systemPrompt: "Ask for a prediction before each trial.",
      appRequest: "Build a cart simulator.",
      tutorModel: "fable",
      scholarsStartFrom: "starter",
    });
    expect(state.activity?.starterAppId).not.toBe(fixture.starterAppId);
    expect(state.starter).toMatchObject({
      name: "Force explorer",
      kind: "static",
      status: "live",
      html: "<!doctype html><p>Original app</p>",
      origin: "starter",
      createdBy: callerId,
    });
    expect(state.starter?.token).not.toBe("source-starter-token");
    expect(state.source).toEqual(sourceBefore);
    expect(state.sourceStarter).toEqual(starterBefore);
  });

  test("activities.forkToMyUnit reuses the same-title activity in its Lab lesson", async () => {
    const t = convexTest(schema, modules);
    const sourceTeacherId = await seedUser(
      t,
      "teacher",
      "source-refork-teacher",
    );
    const callerId = await seedUser(t, "teacher", "reforking-teacher");
    const activityId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: sourceTeacherId,
        title: "Shared Circuits",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Current",
        order: 0,
      });
      const starterAppId = await ctx.db.insert("customApps", {
        token: "source-circuit-token",
        name: "Circuit explorer",
        kind: "static",
        status: "live",
        html: "<!doctype html><p>Circuits</p>",
        origin: "starter",
        createdBy: sourceTeacherId,
        updatedAt: 123,
      });
      return await ctx.db.insert("activities", {
        lessonId,
        title: "Circuit explorer",
        kind: "vibecode",
        starterAppId,
        order: 0,
      });
    });
    const asCaller = await withUser(t, callerId);

    const first = await asCaller.mutation(api.activities.forkToMyUnit, {
      activityId,
    });
    const second = await asCaller.mutation(api.activities.forkToMyUnit, {
      activityId,
    });

    const state = await t.run(async (ctx) => ({
      activities: await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", first.lessonId))
        .collect(),
      callerStarters: (await ctx.db.query("customApps").collect()).filter(
        (app) => app.createdBy === callerId,
      ),
    }));

    expect(second).toEqual(first);
    expect(state.activities.map((activity) => activity._id)).toEqual([
      first.activityId,
    ]);
    expect(state.callerStarters).toHaveLength(1);
  });

  test("activities.forkToMyUnit rejects a caller from another institution", async () => {
    const t = convexTest(schema, modules);
    const institutionA = await seedTestInstitution(t, {
      name: "Moli School",
      slug: "fork-source-school",
      isPrimary: true,
    });
    const institutionB = await seedTestInstitution(t, {
      name: "Kona Tutoring",
      slug: "fork-caller-school",
    });
    const sourceTeacherId = await seedStaffWithMembership(t, {
      institutionId: institutionA,
      name: "Lehua Torres",
      username: "fork-source-staff",
    });
    const callerId = await seedStaffWithMembership(t, {
      institutionId: institutionB,
      name: "Noe Alana",
      username: "fork-foreign-caller",
    });
    const activityId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: sourceTeacherId,
        institutionId: institutionA,
        title: "Institution A Physics",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Forces",
        order: 0,
      });
      return await ctx.db.insert("activities", {
        lessonId,
        title: "Force explorer",
        kind: "online",
        order: 0,
      });
    });

    await expect(
      (
        await withUser(t, callerId)
      ).mutation(api.activities.forkToMyUnit, { activityId }),
    ).rejects.toThrow(/forbidden|institution/i);
  });

  test("lessons.duplicate deep-copies activities and preserves sibling order", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "lesson-teacher");
    const { unitId, sourceLessonId, sourceActivityId, resourceId } = await t.run(
      async (ctx) => {
        const unitId = await ctx.db.insert("units", {
          teacherId,
          title: "Ecology",
          isActive: true,
        });
        await ctx.db.insert("lessons", {
          unitId,
          title: "Opening",
          order: 0,
        });
        const sourceLessonId = await ctx.db.insert("lessons", {
          unitId,
          title: "Field study",
          strand: "connections",
          systemPrompt: "Keep observations separate from inferences.",
          durationMinutes: 90,
          selectionMode: "choice",
          choicePickCount: 2,
          order: 1,
        });
        const sourceActivityId = await ctx.db.insert("activities", {
          lessonId: sourceLessonId,
          title: "Observe",
          kind: "online",
          order: 0,
          googleSlidesPresentationId: "source-deck",
        });
        const resourceId = await ctx.db.insert("activityResources", {
          activityId: sourceActivityId,
          title: "Observation guide",
          source: { kind: "link", url: "https://example.com/observe" },
          order: 0,
          uploadedBy: teacherId,
        });
        await ctx.db.insert("activities", {
          lessonId: sourceLessonId,
          title: "Share patterns",
          kind: "shareBack",
          shareBackRecipe: "galleryWalk",
          sourceActivityIds: [sourceActivityId],
          referencedResourceIds: [resourceId],
          facilitationFocus: "Compare evidence across habitats.",
          order: 1,
        });
        await ctx.db.insert("lessons", {
          unitId,
          title: "Closing",
          order: 2,
        });
        return { unitId, sourceLessonId, sourceActivityId, resourceId };
      },
    );

    const asTeacher = await withUser(t, teacherId);
    const copyId = await asTeacher.mutation(api.lessons.duplicate, {
      lessonId: sourceLessonId,
    });

    const { lessons, activities } = await t.run(async (ctx) => {
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect();
      lessons.sort((a, b) => a.order - b.order);
      const activities = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", copyId))
        .collect();
      activities.sort((a, b) => a.order - b.order);
      return { lessons, activities };
    });

    expect(lessons.map((lesson) => [lesson.title, lesson.order])).toEqual([
      ["Opening", 0],
      ["Field study", 1],
      ["Field study (copy)", 2],
      ["Closing", 3],
    ]);
    expect(lessons[2]).toMatchObject({
      strand: "connections",
      systemPrompt: "Keep observations separate from inferences.",
      durationMinutes: 90,
      selectionMode: "choice",
      choicePickCount: 2,
    });
    expect(activities.map((activity) => [activity.title, activity.order])).toEqual([
      ["Observe", 0],
      ["Share patterns", 1],
    ]);
    const copiedObserve = activities[0];
    const copiedShareBack = activities[1];
    expect(copiedObserve._id).not.toBe(sourceActivityId);
    expect(copiedObserve.googleSlidesPresentationId).toBeUndefined();
    expect(copiedShareBack.sourceActivityIds).toEqual([copiedObserve._id]);
    expect(copiedShareBack.sourceActivityIds).not.toContain(sourceActivityId);
    expect(copiedShareBack.referencedResourceIds).toEqual([resourceId]);
  });

  test("units.duplicate makes a fresh Draft with new granule keys and no execution data", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "unit-teacher");
    const scholarId = await seedUser(t, "scholar", "unit-scholar");
    const fixture = await t.run(async (ctx) => {
      const processId = await ctx.db.insert("processes", {
        teacherId,
        title: "Claim, evidence, reasoning",
        steps: [],
        isActive: true,
      });
      const personaId = await ctx.db.insert("personas", {
        teacherId,
        title: "Legacy expert",
        emoji: "🔬",
        isActive: true,
      });
      const perspectiveId = await ctx.db.insert("perspectives", {
        teacherId,
        title: "Systems",
        isActive: true,
      });
      const externalAppId = await ctx.db.insert("externalApps", {
        name: "Data Lab",
        webUrl: "https://data.example.test",
        createdBy: teacherId,
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Water systems",
        slug: "water-systems",
        emoji: "💧",
        description: "Trace movement through a watershed.",
        scholarDescription: "Follow water through your watershed.",
        systemPrompt: "Keep every claim tied to a system boundary.",
        rubric: "Uses evidence and models.",
        targetBloomLevel: "analyze",
        personaId,
        perspectiveId,
        processId,
        durationMinutes: 240,
        bigIdea: "Water connects living and engineered systems.",
        essentialQuestions: [
          { key: "eq:source", text: "Where does water go?" },
        ],
        enduringUnderstandings: [
          { key: "eu:source", text: "Water moves through linked systems." },
        ],
        subject: "Science",
        gradeLevel: "5",
        mathDomain: "measurement",
        isActive: false,
        badgeOnCompletion: {
          title: "Watershed mapper",
          description: "Mapped a connected water system.",
          icon: "🗺️",
        },
      });
      const lessonA = await ctx.db.insert("lessons", {
        unitId,
        title: "Collect data",
        processId,
        order: 0,
      });
      const webActivityId = await ctx.db.insert("activities", {
        lessonId: lessonA,
        title: "Read stream data",
        description: "Inspect the live dashboard.",
        kind: "web",
        webUrl: "https://data.example.test/streams",
        externalAppId,
        order: 0,
        googleSlidesPresentationId: "generated-source-deck",
      });
      const lessonB = await ctx.db.insert("lessons", {
        unitId,
        title: "Connect the system",
        strand: "connections",
        order: 1,
      });
      const resourceId = await ctx.db.insert("activityResources", {
        activityId: webActivityId,
        title: "Stream reference",
        source: { kind: "link", url: "https://example.com/reference" },
        order: 0,
        uploadedBy: teacherId,
      });
      const shareBackId = await ctx.db.insert("activities", {
        lessonId: lessonB,
        title: "Watershed synthesis",
        kind: "shareBack",
        shareBackRecipe: "reflection",
        sourceActivityIds: [webActivityId],
        referencedResourceIds: [resourceId],
        order: 0,
      });

      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: webActivityId, mode: "classFocus", setAt: Date.now() },
        ],
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: teacherId,
        unitId,
        lessonId: lessonA,
        activityId: webActivityId,
        assignmentId,
        title: "Rehearsal",
        isArchived: false,
        isTestDrive: true,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId: webActivityId,
        lessonId: lessonA,
        unitId,
        assignmentId,
        sessionId,
        completedAt: Date.now(),
      });
      await ctx.db.insert("deliverables", {
        activityId: webActivityId,
        scholarId,
        sessionId,
        assignmentId,
        textContent: "Source submission",
        submittedAt: Date.now(),
      });
      await ctx.db.insert("unitReviews", {
        unitId,
        reviewedBy: teacherId,
        reviewedAt: Date.now(),
        openGapCount: 0,
      });
      const messageId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Test response",
        flagged: false,
      });
      await ctx.db.insert("testDriveFlags", {
        sessionId,
        messageId,
        teacherId,
        kind: "good",
      });

      return {
        unitId,
        processId,
        personaId,
        perspectiveId,
        externalAppId,
        webActivityId,
        shareBackId,
      };
    });
    const beforeCounts = await executionCounts(t);

    const asTeacher = await withUser(t, teacherId);
    const copyId = await asTeacher.mutation(api.units.duplicate, {
      unitId: fixture.unitId,
    });

    const afterCounts = await executionCounts(t);
    expect(afterCounts).toEqual(beforeCounts);

    const copied = await t.run(async (ctx) => {
      const unit = await ctx.db.get(copyId);
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", copyId))
        .collect();
      lessons.sort((a, b) => a.order - b.order);
      const activities = (
        await Promise.all(
          lessons.map((lesson) =>
            ctx.db
              .query("activities")
              .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
              .collect(),
          ),
        )
      )
        .flat()
        .sort((a, b) => a.order - b.order);
      return {
        unit,
        lessons,
        activities,
        copiedAssignments: (
          await ctx.db
            .query("assignments")
            .withIndex("by_unit", (q) => q.eq("unitId", copyId))
            .collect()
        ).length,
        copiedSessions: (
          await ctx.db
            .query("sessions")
            .withIndex("by_unit", (q) => q.eq("unitId", copyId))
            .collect()
        ).length,
        copiedReviews: (
          await ctx.db
            .query("unitReviews")
            .withIndex("by_unit", (q) => q.eq("unitId", copyId))
            .collect()
        ).length,
      };
    });

    expect(copied.unit).toMatchObject({
      teacherId,
      title: "Water systems (copy)",
      emoji: "💧",
      description: "Trace movement through a watershed.",
      scholarDescription: "Follow water through your watershed.",
      systemPrompt: "Keep every claim tied to a system boundary.",
      rubric: "Uses evidence and models.",
      targetBloomLevel: "analyze",
      personaId: fixture.personaId,
      perspectiveId: fixture.perspectiveId,
      processId: fixture.processId,
      durationMinutes: 240,
      subject: "Science",
      gradeLevel: "5",
      mathDomain: "measurement",
      isActive: true,
    });
    expect(copied.unit?.slug).toBeUndefined();
    expect(copied.unit?.authorScholarId).toBeUndefined();
    expect(copied.unit?.bakedFromSeedId).toBeUndefined();
    expect(copied.unit?.essentialQuestions?.map((g) => g.text)).toEqual([
      "Where does water go?",
    ]);
    expect(copied.unit?.enduringUnderstandings?.map((g) => g.text)).toEqual([
      "Water moves through linked systems.",
    ]);
    expect(copied.unit?.essentialQuestions?.[0].key).not.toBe("eq:source");
    expect(copied.unit?.enduringUnderstandings?.[0].key).not.toBe("eu:source");

    expect(copied.lessons.map((lesson) => lesson.title)).toEqual([
      "Collect data",
      "Connect the system",
    ]);
    const copiedWeb = copied.activities.find(
      (activity) => activity.title === "Read stream data",
    );
    const copiedShareBack = copied.activities.find(
      (activity) => activity.title === "Watershed synthesis",
    );
    expect(copiedWeb).toMatchObject({
      externalAppId: fixture.externalAppId,
      webUrl: "https://data.example.test/streams",
    });
    expect(copiedWeb?._id).not.toBe(fixture.webActivityId);
    expect(copiedWeb?.googleSlidesPresentationId).toBeUndefined();
    expect(copiedShareBack?._id).not.toBe(fixture.shareBackId);
    expect(copiedShareBack?.sourceActivityIds).toEqual([copiedWeb?._id]);
    expect(copiedShareBack?.referencedResourceIds).toBeUndefined();
    expect(copiedAssignmentsAndState(copied)).toEqual({
      assignments: 0,
      sessions: 0,
      reviews: 0,
    });
  });

  test("all duplicate mutations enforce their create/edit auth gates", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "gate-teacher");
    const scholarId = await seedUser(t, "scholar", "gate-scholar");
    const { unitId, lessonId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Protected unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Protected lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Protected activity",
        kind: "offline",
        order: 0,
      });
      return { unitId, lessonId, activityId };
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.units.duplicate, { unitId }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asScholar.mutation(api.lessons.duplicate, { lessonId }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asScholar.mutation(api.activities.duplicate, { activityId }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asScholar.mutation(api.activities.forkToMyUnit, { activityId }),
    ).rejects.toThrow(/forbidden/i);
  });
});

function copiedAssignmentsAndState(copied: {
  copiedAssignments: number;
  copiedSessions: number;
  copiedReviews: number;
}) {
  return {
    assignments: copied.copiedAssignments,
    sessions: copied.copiedSessions,
    reviews: copied.copiedReviews,
  };
}
