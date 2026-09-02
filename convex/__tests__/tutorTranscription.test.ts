import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { buildSystemPrompt } from "../sessionHelpers";

/**
 * Tutor transcription: the tutor typing a scholar's own spoken words into
 * their document.
 *
 * This exists because chat and the document are two disconnected buckets and
 * only the document is graded — a young scholar who answers out loud believes
 * they are done, and re-asking them to "write it down" just repeats a wall
 * they can't see the far side of. The tutor may now offer to write their exact
 * words down instead.
 *
 * Three properties are load-bearing and are what these tests pin:
 *   1. Verbatim. The text lands exactly as the scholar said it, misspellings
 *      included — tidying it up would hand them a mechanics score they didn't
 *      earn and hide what they still need to learn.
 *   2. Provenance. The write is marked, so a teacher can tell "she wrote it"
 *      from "she said it and the tutor typed it."
 *   3. The prompt actually teaches the behavior. A tool nobody is told to
 *      reach for changes nothing.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function makeDoc(
  t: ReturnType<typeof convexTest>,
  content: string,
  revision = 0,
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Transcribe Scholar",
      username: `transcribe-${Math.random()}`,
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Transcribe Session",
      isArchived: false,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Notes",
      content,
      lastEditedBy: "scholar",
      revision,
    });
    return { userId, sessionId, artifactId };
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

describe("aiTranscribe — the scholar's words, unchanged", () => {
  test("appends verbatim and marks the document as tutor-transcribed", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeDoc(t, "Sum is green");
    // Deliberately misspelled: transcribing rough is the point, not a typo.
    const spoken = "i thnk the algee is what maks it go dark becuse it grew alot";

    const result = await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: spoken,
      baseRevision: 0,
    });

    expect(result).toMatchObject({
      kind: "success",
      artifact: { content: `Sum is green\n${spoken}`, revision: 1 },
    });
    const stored = await t.run(async (ctx) => ctx.db.get(artifactId));
    expect(stored?.content).toBe(`Sum is green\n${spoken}`);
    expect(stored?.hasTutorTranscription).toBe(true);
    // Honest about who performed the write; the flag says why.
    expect(stored?.lastEditedBy).toBe("ai");
  });

  test("an empty document takes the words without a leading blank line", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeDoc(t, "   ");

    const result = await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: "the frist colony will make it black",
      baseRevision: 0,
    });

    expect(result).toMatchObject({
      kind: "success",
      artifact: { content: "the frist colony will make it black" },
    });
  });

  test("refuses empty text rather than stamping a no-op write", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeDoc(t, "existing");

    expect(
      await t.mutation(internal.artifacts.aiTranscribe, {
        sessionId,
        artifactId,
        text: "   ",
        baseRevision: 0,
      }),
    ).toMatchObject({ kind: "refused" });
    const stored = await t.run(async (ctx) => ctx.db.get(artifactId));
    expect(stored?.content).toBe("existing");
    expect(stored?.hasTutorTranscription).toBeUndefined();
  });

  test("honors the same CAS contract as every other AI edit", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeDoc(t, "first");

    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: "second",
      baseRevision: 0,
    });
    expect(
      await t.mutation(internal.artifacts.aiTranscribe, {
        sessionId,
        artifactId,
        text: "stale",
        baseRevision: 0,
      }),
    ).toMatchObject({ kind: "conflict" });
  });

  test("refuses an artifact from another session", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await makeDoc(t, "mine");
    const { artifactId: otherId } = await makeDoc(t, "theirs");

    await expect(
      t.mutation(internal.artifacts.aiTranscribe, {
        sessionId,
        artifactId: otherId,
        text: "words",
      }),
    ).rejects.toThrow("Artifact does not belong to session");
  });

  test("the marker is sticky once a later scholar edit lands", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await makeDoc(t, "start");

    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: "my words",
      baseRevision: 0,
    });
    await t.mutation(internal.artifacts.aiStrReplace, {
      sessionId,
      artifactId,
      oldStr: "start",
      newStr: "restart",
      baseRevision: 1,
    });

    const stored = await t.run(async (ctx) => ctx.db.get(artifactId));
    // Un-setting it here would overstate how much of this the scholar typed.
    expect(stored?.hasTutorTranscription).toBe(true);
  });
});

describe("the document section teaches the behavior", () => {
  function promptWithDoc() {
    return buildSystemPrompt(
      null,
      null,
      "Kai",
      null,
      null,
      null,
      null,
      null,
      [
        {
          id: "a1",
          title: "Notes",
          content: "Sum is green",
          lastEditedBy: "scholar",
          revision: 3,
        },
      ],
    );
  }

  test("names the document as a box on screen without pinning it to a corner", () => {
    const prompt = promptWithDoc();
    expect(prompt).toContain("BOX ON THE SCHOLAR'S SCREEN");
    // "on the side" is the phrasing scholars actually use, and it survives the
    // portrait layout where the panel sits above the chat instead. A specific
    // corner would not, so the prompt rules those out by name.
    expect(prompt).toContain('"the box on the side"');
    expect(prompt).toContain('Do not name an exact corner ("on the right"');
  });

  test("explains that answering out loud is not the same as typing it", () => {
    const prompt = promptWithDoc();
    expect(prompt).toContain(
      "Talking to you and typing in the box are two different places",
    );
    expect(prompt).toContain("almost never lying");
  });

  test("requires the offer, the verbatim rule, and handing it back", () => {
    const prompt = promptWithDoc();
    expect(prompt).toContain(
      "Never ask a scholar to write down something they already told you without offering to do it for them",
    );
    expect(prompt).toContain("read it and tell me if I got it right");
    expect(prompt).toContain("Transcribe ROUGH");
    expect(prompt).toContain("steals credit they didn't earn");
    // Scaffolding the scholar into doing it themselves stays the goal.
    expect(prompt).toContain("Typing it themselves is still the better outcome");
  });

  test("stops arguing after a checked document-state mismatch", () => {
    const prompt = promptWithDoc();
    expect(prompt).toContain(
      "already told the scholar in this session that the fresh document looks empty",
    );
    expect(prompt).toContain("possible state mismatch on your side");
    expect(prompt).toContain("Do not declare the document empty again");
    expect(prompt).toContain("end that turn without opening a new topic");
    expect(prompt).toContain(
      "Continue the same task after the scholar responds",
    );
  });
});

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

    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: "i thnk the algee is what maks it go dark becuse it grew alot",
      baseRevision: 0,
    });
    const deliverableId = await asScholar.mutation(api.deliverables.submit, {
      activityId,
      sessionId,
      artifactId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row!.hasTutorTranscription).toBe(true);
    expect(row!.textContent).toContain("i thnk the algee is what maks it go dark becuse it grew alot");
  });

  // The tool-scored path is how most submissions are actually graded — the
  // tutor calls the rubric check itself — so the marker has to survive here
  // too, not just on the explicit scholar-pressed submit above.
  test("a tool-scored submission records the marker on the new row", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, artifactId } = await seedWritingActivity(t);

    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: "i thnk the algee is what maks it go dark becuse it grew alot",
      baseRevision: 0,
    });
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
    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: "i thnk the algee is what maks it go dark becuse it grew alot",
      baseRevision: 0,
    });
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
    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: "i thnk the algee is what maks it go dark becuse it grew alot",
      baseRevision: 0,
    });
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
    const { asScholar, sessionId, artifactId } = await seedWritingActivity(t);
    const spoken = "i thnk the algee is what maks it go dark becuse it grew alot";

    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: spoken,
      baseRevision: 0,
    });
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
    const { asScholar, sessionId, artifactId } = await seedWritingActivity(t);
    const spoken = "i thnk the algee is what maks it go dark becuse it grew alot";

    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: spoken,
      baseRevision: 0,
    });
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
    const spoken = "i thnk the algee is what maks it go dark becuse it grew alot";

    await t.mutation(internal.artifacts.aiTranscribe, {
      sessionId,
      artifactId,
      text: spoken,
      baseRevision: 0,
    });
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
