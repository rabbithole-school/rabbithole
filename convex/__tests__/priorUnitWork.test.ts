import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import {
  PRIOR_UNIT_WORK_CHAR_CAP,
  PRIOR_UNIT_WORK_HEADER,
  buildPriorUnitWorkSection,
  loadPriorUnitWork,
  type PriorUnitWorkItem,
} from "../lib/priorUnitWork";
import { TUTOR_TURN_SYSTEM_SECTIONS } from "../prompts";
import { buildTutorSystemPromptParts } from "../sessionStreamHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

/** A unit with an online activity (prior work) and a vibecode activity. */
async function seedWorld(t: T) {
  const institutionId = await seedTestInstitution(t);
  const teacherId = await seedStaffWithMembership(t, { institutionId });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Hoku Makani",
  });
  const otherScholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Lehua Torres",
  });
  const ids = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Outbreak",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "How cholera spreads",
      order: 0,
    });
    const onlineActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Explain the mechanism",
      kind: "online",
      systemPrompt: "Explain how it spreads.",
      order: 0,
    });
    const vibecodeActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build the outbreak sim",
      kind: "vibecode",
      systemPrompt: "Build the spread model.",
      order: 1,
    });
    return { unitId, lessonId, onlineActivityId, vibecodeActivityId };
  });
  return { ...ids, teacherId, scholarId, otherScholarId };
}

async function seedSession(
  t: T,
  w: Awaited<ReturnType<typeof seedWorld>>,
  userId: Id<"users">,
  activityId: Id<"activities">,
  extra: { sessionMode?: "vibecode"; isTestDrive?: boolean } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId,
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId,
      title: "Session",
      isArchived: false,
      ...extra,
    }),
  );
}

async function seedDeliverable(
  t: T,
  w: Awaited<ReturnType<typeof seedWorld>>,
  scholarId: Id<"users">,
  sessionId: Id<"sessions">,
  activityId: Id<"activities">,
  textContent: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("deliverables", {
      activityId,
      scholarId,
      sessionId,
      textContent,
      submittedAt: Date.UTC(2026, 9, 3),
    }),
  );
}

async function contextFor(t: T, sessionId: Id<"sessions">) {
  const c = await t.query(internal.sessionHelpers.getSessionContext, {
    sessionId,
  });
  expect(c).not.toBeNull();
  return c!;
}

describe("prior unit work in a vibecode session", () => {
  test("absent when the scholar has no prior work in the unit", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const sessionId = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });
    const c = await contextFor(t, sessionId);
    expect(c.priorUnitWork).toBeNull();
  });

  test("carries the scholar's deliverable from another activity into the prompt", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const prior = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    const mechanism = "Sewage gets into the well water and people drink it.";
    await seedDeliverable(t, w, w.scholarId, prior, w.onlineActivityId, mechanism);
    const sessionId = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });

    const c = await contextFor(t, sessionId);
    expect(c.priorUnitWork).toContain(PRIOR_UNIT_WORK_HEADER);
    expect(c.priorUnitWork).toContain(mechanism);
    expect(c.priorUnitWork).toContain("Explain the mechanism");

    // Plumbed into the assembled prompt, in the per-turn session state.
    const parts = buildTutorSystemPromptParts({
      ...c,
      playMode: false,
    });
    expect(parts.turnSystem).toContain(c.priorUnitWork!.trim());
    expect(parts.stable).not.toContain(PRIOR_UNIT_WORK_HEADER);
    expect(TUTOR_TURN_SYSTEM_SECTIONS).toContain("priorUnitWork");
  });

  test("falls back to the scholar's own typed turns when a session left no deliverable", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const prior = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    const question = "Why do some people get sick and others don't?";
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId: prior,
        role: "user",
        content: question,
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId: prior,
        role: "assistant",
        content: "TUTOR-WORDS-NEVER-REPLAYED",
        flagged: false,
      });
    });
    const sessionId = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });
    const c = await contextFor(t, sessionId);
    expect(c.priorUnitWork).toContain(question);
    expect(c.priorUnitWork).not.toContain("TUTOR-WORDS-NEVER-REPLAYED");
  });

  test("carries an unsubmitted writing-box draft, labelled, ahead of chat turns", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const prior = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    await t.run(async (ctx) => {
      await ctx.db.insert("artifacts", {
        sessionId: prior,
        title: "Game design",
        content: "Rise: 6 Run: 3 Slope: 2",
        lastEditedBy: "scholar",
      });
      await ctx.db.insert("artifacts", {
        sessionId: prior,
        title: "Tutor notes",
        content: "AI-WRITTEN-DRAFT",
        lastEditedBy: "ai",
      });
      await ctx.db.insert("artifacts", {
        sessionId: prior,
        title: "App",
        content: "<!doctype html><p>CODE-APP</p>",
        lastEditedBy: "scholar",
        type: "code",
        language: "html",
      });
      await ctx.db.insert("messages", {
        sessionId: prior,
        role: "user",
        content: "CHAT-TURN-NOT-NEEDED-WHEN-DRAFTED",
        flagged: false,
      });
    });
    const sessionId = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });
    const items = await t.run((ctx) =>
      loadPriorUnitWork(ctx, {
        scholarId: w.scholarId,
        unitId: w.unitId,
        currentSessionId: sessionId,
        currentActivityId: w.vibecodeActivityId,
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].lines).toEqual([
      { kind: "drafted", text: "Rise: 6 Run: 3 Slope: 2" },
    ]);
    const c = await contextFor(t, sessionId);
    expect(c.priorUnitWork).toContain("Rise: 6 Run: 3 Slope: 2");
  });

  test("never carries another scholar's work", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const theirs = await seedSession(t, w, w.otherScholarId, w.onlineActivityId);
    await seedDeliverable(t, w, w.otherScholarId, theirs, w.onlineActivityId, "OTHER-SCHOLAR-WORK");
    const sessionId = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });
    const c = await contextFor(t, sessionId);
    expect(c.priorUnitWork).toBeNull();
  });

  test("skips a deliverable for the current activity, a rehearsal, and a non-vibecode session", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // Earlier session of the SAME vibecode activity with a deliverable.
    const sameActivity = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });
    await seedDeliverable(t, w, w.scholarId, sameActivity, w.vibecodeActivityId, "SAME-ACTIVITY");
    const prior = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    await seedDeliverable(t, w, w.scholarId, prior, w.onlineActivityId, "Real prior work in the unit.");

    // A teacher rehearsal of the vibecode activity gets nothing.
    const rehearsal = await seedSession(t, w, w.teacherId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
      isTestDrive: true,
    });
    expect((await contextFor(t, rehearsal)).priorUnitWork).toBeNull();

    // A plain conversation session with no app gets nothing (builder
    // features only; sessionAppContext.test.ts covers a chat with an app).
    const chat = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    expect((await contextFor(t, chat)).priorUnitWork).toBeNull();

    const sessionId = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });
    const section = (await contextFor(t, sessionId)).priorUnitWork;
    expect(section).toContain("Real prior work in the unit.");
    expect(section).not.toContain("SAME-ACTIVITY");
  });
});

describe("buildPriorUnitWorkSection", () => {
  const item = (label: string, at: number, text: string): PriorUnitWorkItem => ({
    label,
    at,
    lines: [{ kind: "wrote", text }],
  });

  test("null for no items", () => {
    expect(buildPriorUnitWorkSection([], "Pacific/Honolulu")).toBeNull();
    expect(buildPriorUnitWorkSection(null, "Pacific/Honolulu")).toBeNull();
  });

  test("stays within the character cap and keeps the newest item first", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item(`Activity ${i}`, Date.UTC(2026, 9, 1 + i), "x".repeat(400)),
    ).sort((a, b) => b.at - a.at);
    const section = buildPriorUnitWorkSection(items, "Pacific/Honolulu")!;
    const body = section.slice(section.indexOf(PRIOR_UNIT_WORK_HEADER) + PRIOR_UNIT_WORK_HEADER.length);
    expect(body.length).toBeLessThanOrEqual(PRIOR_UNIT_WORK_CHAR_CAP);
    expect(body.indexOf("Activity 19")).toBeGreaterThanOrEqual(0);
    expect(body).not.toContain("Activity 0 ");
  });
});

describe("prior unit work keeps only the scholar's own words", () => {
  async function priorSection(
    t: T,
    w: Awaited<ReturnType<typeof seedWorld>>,
  ): Promise<string | null> {
    const sessionId = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });
    return (await contextFor(t, sessionId)).priorUnitWork;
  }

  test("skips an AI-edited artifact and code, keeps scholar-edited writing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const prior = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    await t.run(async (ctx) => {
      const aiArtifact = await ctx.db.insert("artifacts", {
        sessionId: prior,
        title: "Notes",
        content: "AI-WRITTEN-ARTIFACT",
        lastEditedBy: "ai",
      });
      const ownArtifact = await ctx.db.insert("artifacts", {
        sessionId: prior,
        title: "Notes",
        content: "SCHOLAR-EDITED-ARTIFACT",
        lastEditedBy: "scholar",
      });
      for (const [i, fields] of [
        { artifactId: aiArtifact },
        { artifactId: ownArtifact },
        { textContent: "const spread = () => { return 'CODE-DELIVERABLE'; };" },
        { textContent: "function CODE_FN() { return 1; }" },
        { textContent: "<!doctype html><html><body><p>HTML-WRITING</p></body></html>" },
      ].entries()) {
        await ctx.db.insert("deliverables", {
          activityId: w.onlineActivityId,
          scholarId: w.scholarId,
          sessionId: prior,
          submittedAt: Date.UTC(2026, 9, 3) + i,
          ...fields,
        });
      }
    });
    const section = await priorSection(t, w);
    expect(section).toContain("SCHOLAR-EDITED-ARTIFACT");
    expect(section).toContain("HTML-WRITING");
    expect(section).not.toContain("AI-WRITTEN-ARTIFACT");
    expect(section).not.toContain("CODE-DELIVERABLE");
    expect(section).not.toContain("CODE_FN");
  });

  test("a portfolio item contributes its extracted text, never its AI caption", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const prior = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    await t.run(async (ctx) => {
      const portfolioItemId = await ctx.db.insert("portfolioItems", {
        scholarId: w.scholarId,
        title: "scan.pdf",
        source: "upload",
        extractedText: "SCANNED-SCHOLAR-WRITING about the well",
        aiCaption: "AI-CAPTION-NEVER-REPLAYED",
        matchStatus: "confirmed",
        processingStatus: "ready",
      });
      await ctx.db.insert("deliverables", {
        activityId: w.onlineActivityId,
        scholarId: w.scholarId,
        sessionId: prior,
        portfolioItemId,
        submittedAt: Date.UTC(2026, 9, 3),
      });
    });
    const section = await priorSection(t, w);
    expect(section).toContain("SCANNED-SCHOLAR-WRITING");
    expect(section).not.toContain("AI-CAPTION-NEVER-REPLAYED");
  });

  test("tutor-transcribed writing is marked as such", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const prior = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    await t.run((ctx) =>
      ctx.db.insert("deliverables", {
        activityId: w.onlineActivityId,
        scholarId: w.scholarId,
        sessionId: prior,
        textContent: "Dictated answer about the pump handle.",
        hasTutorTranscription: true,
        submittedAt: Date.UTC(2026, 9, 3),
      }),
    );
    const sessionId = await seedSession(t, w, w.scholarId, w.vibecodeActivityId, {
      sessionMode: "vibecode",
    });
    const items = await t.run((ctx) =>
      loadPriorUnitWork(ctx, {
        scholarId: w.scholarId,
        unitId: w.unitId,
        currentSessionId: sessionId,
        currentActivityId: w.vibecodeActivityId,
      }),
    );
    const line = items[0].lines.find((l) => l.kind === "wrote");
    expect(line).toMatchObject({ kind: "wrote", transcribed: true });
    // The rendered label differs from a plain "wrote" line.
    const plain = buildPriorUnitWorkSection(
      [{ ...items[0], lines: [{ kind: "wrote", text: "same" }] }],
      "Pacific/Honolulu",
    );
    const marked = buildPriorUnitWorkSection(
      [{ ...items[0], lines: [{ kind: "wrote", text: "same", transcribed: true }] }],
      "Pacific/Honolulu",
    );
    expect(marked).not.toBe(plain);
  });

  test("app-button presses are not replayed as the scholar's words", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const prior = await seedSession(t, w, w.scholarId, w.onlineActivityId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId: prior,
        role: "user",
        content: "APP-BUTTON-PRESS ran the outbreak once",
        inputModality: "app",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId: prior,
        role: "user",
        content: "SCHOLAR-TYPED the water pump is the source",
        flagged: false,
      });
    });
    const section = await priorSection(t, w);
    expect(section).toContain("SCHOLAR-TYPED");
    expect(section).not.toContain("APP-BUTTON-PRESS");
  });
});
