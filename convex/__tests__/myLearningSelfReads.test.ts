import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  const institutionId = await seedTestInstitution(t);
  const options = {
    institutionId,
    name: overrides.name ?? `Test ${role}`,
    username: overrides.username ?? `test${role}`,
  };
  return role === "teacher"
    ? seedStaffWithMembership(t, options)
    : seedScholarInInstitution(t, options);
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

const DAY = 24 * 60 * 60 * 1000;

async function seedMasteryPair(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Fractions exploration",
      isArchived: false,
    });
    const base = {
      scholarId,
      conceptLabel: "Equivalent fractions",
      domain: "Mathematics",
      sessionId,
      confidenceScore: 0.8,
      evidenceSummary: "worked examples",
      evidenceType: "direct_demonstration",
      attemptContext: "guided",
      studentInitiated: false,
    };
    await ctx.db.insert("masteryObservations", {
      ...base,
      observedAt: Date.now() - 14 * DAY,
      transcriptExcerpt: "I think 2/4 is different from 1/2",
      masteryLevel: 1.0,
      isSuperseded: true,
    });
    await ctx.db.insert("masteryObservations", {
      ...base,
      observedAt: Date.now(),
      transcriptExcerpt: "2/4 and 1/2 are the same amount of pizza",
      masteryLevel: 2.5,
      isSuperseded: false,
      studentInitiated: true,
    });
    return sessionId;
  });
}

describe("masteryObservations.growthForScholar", () => {
  test("scholar reads their own growth stories — derived, no levels in the payload", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    await seedMasteryPair(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const stories = await asScholar.query(api.masteryObservations.growthForScholar, {
      scholarId,
    });

    expect(stories).toHaveLength(1);
    expect(stories[0].conceptLabel).toBe("Equivalent fractions");
    expect(stories[0].studentInitiated).toBe(true);
    expect(stories[0].excerpt).toBe("2/4 and 1/2 are the same amount of pizza");
    // The kid-facing payload never carries the mastery float.
    expect(stories[0]).not.toHaveProperty("masteryLevel");
  });

  test("another scholar is forbidden; a teacher is allowed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "kid-a" });
    const otherId = await seedUser(t, "scholar", { username: "kid-b" });
    const teacherId = await seedUser(t, "teacher");
    await seedMasteryPair(t, scholarId);

    const asOther = await withUser(t, otherId);
    await expect(
      asOther.query(api.masteryObservations.growthForScholar, { scholarId }),
    ).rejects.toThrow();

    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.query(api.masteryObservations.growthForScholar, { scholarId }),
    ).resolves.toHaveLength(1);
  });
});

describe("masteryObservations session recap", () => {
  test("an incomplete conversational session can return its existing recap", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedMasteryPair(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const recap = await asScholar.query(
      api.masteryObservations.recapForSession,
      { sessionId, allowFallback: true },
    );

    expect(recap).toHaveLength(1);
    expect(recap[0].text).toBe(
      "You connected your own question to equivalent fractions.",
    );
  });

  test("requestRecap reuses existing data and rejects another scholar", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "kid-a" });
    const otherId = await seedUser(t, "scholar", { username: "kid-b" });
    const sessionId = await seedMasteryPair(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const asOther = await withUser(t, otherId);

    await expect(
      asScholar.action(api.masteryObservations.requestRecap, { sessionId }),
    ).resolves.toBe(true);
    const session = await asScholar.query(api.sessions.get, { id: sessionId });
    expect(session?.activityCompletedAt).toBeUndefined();
    await expect(
      asOther.action(api.masteryObservations.requestRecap, { sessionId }),
    ).rejects.toThrow("Forbidden");
  });

  test("returns a modest mirror when current session observations do not qualify as growth", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Money continuation",
        isArchived: false,
      });
      for (const [conceptLabel, observedAt] of [
        ["Decimal place value", 2],
        ["Adding money amounts", 1],
      ] as const) {
        await ctx.db.insert("masteryObservations", {
          scholarId,
          conceptLabel,
          domain: "Mathematics",
          sessionId: id,
          confidenceScore: 0.6,
          evidenceSummary: "Worked on the idea in conversation.",
          evidenceType: "indirect_inference",
          attemptContext: "problem_solving",
          studentInitiated: false,
          observedAt,
          transcriptExcerpt: "I am working this out.",
          masteryLevel: 1,
          isSuperseded: false,
        });
      }
      return id;
    });
    const asScholar = await withUser(t, scholarId);

    const recap = await asScholar.query(
      api.masteryObservations.recapForSession,
      { sessionId, allowFallback: true },
    );

    expect(recap).toEqual([
      expect.objectContaining({
        tier: "mirror",
        text: "Today you worked on decimal place value and adding money amounts.",
      }),
    ]);
    await expect(
      asScholar.query(api.masteryObservations.recapForSession, { sessionId }),
    ).resolves.toEqual([]);
  });

  test("returns a warm tiny close for a two-message session with no observations", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Short visit",
        isArchived: false,
      });
      await ctx.db.insert("messages", {
        sessionId: id,
        role: "user",
        content: "Hi.",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId: id,
        role: "assistant",
        content: "Hi — what are you curious about?",
        flagged: false,
      });
      return id;
    });
    const asScholar = await withUser(t, scholarId);

    const recap = await asScholar.query(
      api.masteryObservations.recapForSession,
      { sessionId, allowFallback: true },
    );

    expect(recap).toEqual([
      expect.objectContaining({
        tier: "tiny",
        text: "Short visit — this will be here when you want it.",
      }),
    ]);
    await expect(
      asScholar.query(api.masteryObservations.recapForSession, { sessionId }),
    ).resolves.toEqual([]);
  });

  test("requestRecap does not rerun the observer inside the cooldown window", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await t.run(async (ctx) => {
      return await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "A recent conversation",
        isArchived: false,
      });
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.masteryObservations.claimRecapRefresh, {
          sessionId,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.masteryObservations.claimRecapRefresh, {
          sessionId,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      asScholar.action(api.masteryObservations.requestRecap, { sessionId }),
    ).resolves.toBe(true);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.recapRequestedAt).toEqual(expect.any(Number));
    const analyses = await t.run((ctx) =>
      ctx.db
        .query("analyses")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(analyses).toHaveLength(0);
  });

  test("wrap-up is a soft close: later voluntary chat remains open", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const sessionId = await seedMasteryPair(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.action(api.masteryObservations.requestRecap, { sessionId }),
    ).resolves.toBe(true);
    const before = await asScholar.query(api.sessions.get, { id: sessionId });
    expect(before?.activityCompletedAt).toBeUndefined();

    await expect(
      asScholar.mutation(api.sessions.sendMessage, {
        sessionId,
        message: "One more thought.",
      }),
    ).resolves.toMatchObject({ sessionId });
    const after = await asScholar.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(after.messages.some((message) => message.content === "One more thought."))
      .toBe(true);
    expect(after.session.activityCompletedAt).toBeUndefined();
    await expect(
      asScholar.query(api.masteryObservations.recapForSession, {
        sessionId,
        allowFallback: true,
      }),
    ).resolves.toHaveLength(1);
  });
});

describe("portfolio self reads", () => {
  test("listForSelf returns only the caller's items", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "kid-a" });
    const otherId = await seedUser(t, "scholar", { username: "kid-b" });
    await t.run(async (ctx) => {
      await ctx.db.insert("portfolioItems", {
        scholarId,
        title: "My bridge sketch",
        source: "manual",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
      });
      await ctx.db.insert("portfolioItems", {
        scholarId: otherId,
        title: "Someone else's worksheet",
        source: "manual",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
      });
      // Unmatched scan — belongs to nobody yet, must not leak to anyone.
      await ctx.db.insert("portfolioItems", {
        title: "Unmatched scan",
        source: "google_drive",
        matchStatus: "unmatched",
        processingStatus: "ready",
      });
    });

    const asScholar = await withUser(t, scholarId);
    const items = await asScholar.query(api.portfolio.listForSelf, {});
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("My bridge sketch");
  });

  test("getFileUrlForSelf rejects another scholar's item", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "kid-a" });
    const otherId = await seedUser(t, "scholar", { username: "kid-b" });
    const itemId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["fake"]));
      return await ctx.db.insert("portfolioItems", {
        scholarId: otherId,
        title: "Not yours",
        source: "manual",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
        fileStorageId: storageId,
      });
    });

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.portfolio.getFileUrlForSelf, { itemId }),
    ).rejects.toThrow("Forbidden");
  });
});

describe("learningRecord.mySummary", () => {
  // A current + a superseded mastery observation, plus two signals. Only the
  // current observation and the signals count as "notes"; the superseded one
  // must be excluded from both the count and the earliest-note date.
  async function seedRecordFixture(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
  ) {
    const currentObservedAt = Date.now() - 30 * DAY;
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Fractions exploration",
        isArchived: false,
      });
      const base = {
        scholarId,
        conceptLabel: "Equivalent fractions",
        domain: "Mathematics",
        sessionId,
        confidenceScore: 0.8,
        evidenceSummary: "worked examples",
        evidenceType: "direct_demonstration",
        attemptContext: "guided",
        studentInitiated: false,
        transcriptExcerpt: "…",
      };
      await ctx.db.insert("masteryObservations", {
        ...base,
        observedAt: Date.now() - 40 * DAY, // older, but SUPERSEDED — must not count
        masteryLevel: 1.0,
        isSuperseded: true,
      });
      await ctx.db.insert("masteryObservations", {
        ...base,
        observedAt: currentObservedAt, // current → the earliest real note
        masteryLevel: 2.5,
        isSuperseded: false,
      });
      await ctx.db.insert("sessionSignals", {
        scholarId,
        sessionId,
        signalType: "task_commitment",
        description: "stuck with it",
        intensity: "high",
      });
      await ctx.db.insert("sessionSignals", {
        scholarId,
        sessionId,
        signalType: "metacognition",
        description: "named their confusion",
        intensity: "medium",
      });
    });
    return { currentObservedAt };
  }

  test("returns only learner-safe counts — no sensitive fields, superseded excluded", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { currentObservedAt } = await seedRecordFixture(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const summary = await asScholar.query(api.learningRecord.mySummary, {
      scholarId,
    });

    // 1 current mastery observation (the superseded one is excluded) + 2 signals.
    expect(summary.noteCount).toBe(3);
    // Earliest note is the current observation's observedAt — NOT the older
    // superseded one (which is excluded) and not the ~now signals.
    expect(summary.firstNoteAt).toBe(currentObservedAt);
    // The payload is a count + a date only — nothing score-bearing leaks.
    expect(Object.keys(summary).sort()).toEqual(["firstNoteAt", "noteCount"]);
  });

  test("empty record → zero notes, null date", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    const summary = await asScholar.query(api.learningRecord.mySummary, {
      scholarId,
    });
    expect(summary.noteCount).toBe(0);
    expect(summary.firstNoteAt).toBeNull();
  });

  test("another scholar is forbidden; a teacher is allowed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "kid-a" });
    const otherId = await seedUser(t, "scholar", { username: "kid-b" });
    const teacherId = await seedUser(t, "teacher");
    await seedRecordFixture(t, scholarId);

    const asOther = await withUser(t, otherId);
    await expect(
      asOther.query(api.learningRecord.mySummary, { scholarId }),
    ).rejects.toThrow();

    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.query(api.learningRecord.mySummary, { scholarId }),
    ).resolves.toMatchObject({ noteCount: 3 });
  });
});
