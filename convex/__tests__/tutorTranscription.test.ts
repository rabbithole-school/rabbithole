import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// The producer was retired in #3883; these tests protect historical rows.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function markTutorTranscription(
  t: ReturnType<typeof convexTest>,
  artifactId: Id<"artifacts">,
  content: string,
  excerpt = content,
) {
  await t.run(async (ctx) => {
    await ctx.db.patch(artifactId, {
      content,
      hasTutorTranscription: true,
      tutorTranscribedExcerpts: [excerpt],
      lastEditedBy: "ai",
      revision: 1,
    });
  });
}

async function seedWritingActivity(t: ReturnType<typeof convexTest>) {
  const scholarId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Writer",
      username: "transcribe-writer",
      role: "scholar",
    }),
  );
  const authSessionId = await t.run(async (ctx) => {
    const authSession: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: scholarId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", authSession);
  });
  const asScholar = t.withIdentity({
    subject: `${scholarId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
  const ids = await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "Teacher",
      username: "transcribe-teacher",
      role: "teacher",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "U",
      isActive: true,
    } as Doc<"units">);
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "L",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Write your prediction",
      kind: "online",
      systemPrompt: "Coach the scholar to record a prediction.",
      order: 0,
      deliverable: {
        kind: "text",
        prompt: "Write what you think will happen.",
        mode: "manual",
        criteria: [
          {
            id: "c1",
            label: "A reasoned prediction",
            description: "States what they think will happen, and why.",
          },
        ],
      },
    } as Doc<"activities">);
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Bacteria",
      isArchived: false,
      activityId,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Notes",
      content: "Sum is green and orange and black",
      lastEditedBy: "scholar",
      revision: 0,
    });
    return { activityId, sessionId, artifactId };
  });
  return { asScholar, ...ids };
}

/**
 * The provenance has to survive the trip from the live artifact into the
 * durable, graded deliverable — that snapshot is what a teacher reads weeks
 * later, long after the artifact has moved on.
 */
describe("provenance reaches the graded submission", () => {
  test("a submission of purely self-typed writing carries no marker", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, activityId, sessionId, artifactId } =
      await seedWritingActivity(t);

    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    // Written explicitly rather than omitted: the marker has to be able to go
    // back down when a resubmission carries none of the tutor's typing.
    expect(row!.hasTutorTranscription).toBe(false);
  });

  test("a submission containing transcribed words is marked as such", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, activityId, sessionId, artifactId } =
      await seedWritingActivity(t);

    const spoken =
      "i thnk the algee is what maks it go dark becuse it grew alot";
    await markTutorTranscription(t, artifactId, spoken);
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row!.hasTutorTranscription).toBe(true);
    expect(row!.textContent).toContain(
      "i thnk the algee is what maks it go dark becuse it grew alot",
    );
  });

  // The tool-scored path is how most submissions are actually graded — the
  // tutor calls the rubric check itself — so the marker has to survive here
  // too, not just on the explicit scholar-pressed submit above.
  test("a tool-scored submission records the marker on the new row", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await seedWritingActivity(t);

    const spoken =
      "i thnk the algee is what maks it go dark becuse it grew alot";
    await markTutorTranscription(t, artifactId, spoken);
    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId,
      artifactId,
      verdicts: [{ criterionId: "c1", level: "full" }],
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("deliverables")
        .filter((q) => q.eq(q.field("sessionId"), sessionId))
        .first(),
    );
    expect(row!.hasTutorTranscription).toBe(true);
  });

  test("a preserved snapshot is not marked for a transcription that came after it", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, activityId, sessionId, artifactId } =
      await seedWritingActivity(t);

    // Submitted purely self-typed writing…
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });
    // …then the tutor transcribed something into the live artifact afterwards.
    const spoken =
      "i thnk the algee is what maks it go dark becuse it grew alot";
    await markTutorTranscription(t, artifactId, spoken);
    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId,
      artifactId,
      preserveSubmittedSnapshot: true,
      verdicts: [{ criterionId: "c1", level: "half" }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    // The frozen snapshot predates those words, so marking it would understate
    // how much of the graded text the scholar wrote themselves.
    expect(row!.textContent).not.toContain("algee is what maks it go dark");
    expect(row!.hasTutorTranscription ?? false).toBe(false);
  });

  test("a re-score that refreshes the snapshot picks the marker up", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, activityId, sessionId, artifactId } =
      await seedWritingActivity(t);

    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });
    const spoken =
      "i thnk the algee is what maks it go dark becuse it grew alot";
    await markTutorTranscription(t, artifactId, spoken);
    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId,
      artifactId,
      verdicts: [{ criterionId: "c1", level: "half" }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row!.textContent).toContain("algee is what maks it go dark");
    expect(row!.hasTutorTranscription).toBe(true);
  });
});

describe("the marker describes the text, not the document's history", () => {
  test("a scholar who rewrites the transcribed passage clears the marker", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, artifactId } = await seedWritingActivity(t);
    const spoken =
      "i thnk the algee is what maks it go dark becuse it grew alot";

    await markTutorTranscription(t, artifactId, spoken);
    expect(
      (await t.run(async (ctx) => ctx.db.get(artifactId)))!
        .hasTutorTranscription,
    ).toBe(true);

    // She takes it back over in her own words. None of the tutor's typing
    // survives, so claiming she had help would understate her authorship.
    const edit = await asScholar.mutation(api.artifacts.scholarUpdate, {
      artifactId,
      content: "The algae grew a lot and that is why the water looks dark.",
      baseRevision: 1,
    });
    expect(edit).toMatchObject({ ok: true });

    const after = await t.run(async (ctx) => ctx.db.get(artifactId));
    expect(after!.hasTutorTranscription).toBe(false);
    expect(after!.tutorTranscribedExcerpts).toEqual([]);
  });

  test("editing around the transcribed passage keeps the marker", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, artifactId } = await seedWritingActivity(t);
    const spoken =
      "i thnk the algee is what maks it go dark becuse it grew alot";

    await markTutorTranscription(t, artifactId, spoken);
    // The tutor's words are still on the page; she only added to them.
    const edit = await asScholar.mutation(api.artifacts.scholarUpdate, {
      artifactId,
      content: `${spoken}\nAlso the jar was in the sun.`,
      baseRevision: 1,
    });
    expect(edit).toMatchObject({ ok: true });

    const after = await t.run(async (ctx) => ctx.db.get(artifactId));
    expect(after!.hasTutorTranscription).toBe(true);
    expect(after!.tutorTranscribedExcerpts).toEqual([spoken]);
  });

  test("resubmitting after a rewrite clears the graded snapshot's marker", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, activityId, sessionId, artifactId } =
      await seedWritingActivity(t);
    const spoken =
      "i thnk the algee is what maks it go dark becuse it grew alot";

    await markTutorTranscription(t, artifactId, spoken);
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(deliverableId)))!
        .hasTutorTranscription,
    ).toBe(true);

    const edit = await asScholar.mutation(api.artifacts.scholarUpdate, {
      artifactId,
      content: "The algae grew a lot and that is why the water looks dark.",
      baseRevision: 1,
    });
    expect(edit).toMatchObject({ ok: true });
    await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });

    // Not a one-way set: the resubmitted text carries none of the tutor's
    // typing, so the marker has to follow it back down.
    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row!.hasTutorTranscription).toBe(false);
  });
});
