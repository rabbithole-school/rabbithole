// A scan filed to a scholar with NO activity never materializes into a
// session/deliverable — these tests cover the path that gives it a learning
// record anyway: the gating + scheduling around convex/portfolioAssess.ts, its
// write path, and the widened session-less masteryObservations.record.
//
// The model call itself (portfolioAssess.assess's Anthropic round-trip) is out
// of reach at this layer — convex-test can't run the SDK — so it is left to
// types + the deterministic query/mutation seams either side of it, exactly as
// granuleAssessment.test.ts does for the artifact assessor.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { reconcilePortfolioMaterialization } from "../portfolioMaterialize";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const { reportObservations } = vi.hoisted(() => ({
  reportObservations: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: reportObservations };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  reportObservations.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── Fixtures (copied verbatim per rabbithole-testing.md convention) ──────
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  const userId =
    role === "teacher"
      ? await seedStaffWithMembership(t, {
          institutionId,
          name: overrides.name ?? `Test ${role}`,
          username: overrides.username ?? `test-${role}-${Math.floor(role.length)}`,
        })
      : await seedScholarInInstitution(t, {
          institutionId,
          name: overrides.name ?? `Test ${role}`,
          username: overrides.username ?? `test-${role}-${Math.floor(role.length)}`,
        });
  await t.run((ctx) =>
    ctx.db.patch(userId, {
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );
  return userId;
}

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

/** A ready, scholar-attributed scan with a stored file and no activity tag. */
async function seedScan(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users"> | null,
  overrides: Partial<Doc<"portfolioItems">> = {},
) {
  return await t.run(async (ctx) => {
    const fileStorageId = await ctx.storage.store(
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xdb])], {
        type: "image/jpeg",
      }),
    );
    const itemId = await ctx.db.insert("portfolioItems", {
      ...(scholarId ? { scholarId } : {}),
      title: "onboarding_worksheet.pdf",
      source: "google_drive",
      fileStorageId,
      fileMimeType: "image/jpeg",
      matchStatus: scholarId ? "matched" : "unmatched",
      assignmentStatus: "none",
      processingStatus: "ready",
      aiCaption: "A page of two-digit multiplication worked with area models.",
      extractedText: "43 x 6 = 258",
      ...overrides,
    } as Doc<"portfolioItems">);
    if (scholarId) {
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: itemId,
        scholarId,
        attributedAt: Date.now(),
      });
    }
    return itemId;
  });
}

async function scheduledAssessJobs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
      (job as { name?: string }).name?.includes("portfolioAssess:assess"),
    ),
  );
}

async function reconcile(
  t: ReturnType<typeof convexTest>,
  itemId: Id<"portfolioItems">,
) {
  await t.run((ctx) => reconcilePortfolioMaterialization(ctx, itemId));
}

// ── (a) + (b) the scheduling gate ────────────────────────────────────────

describe("reconcile → scan observer scheduling", () => {
  test("schedules assess exactly once and stamps pending", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s1" });
    const itemId = await seedScan(t, scholarId);

    await reconcile(t, itemId);

    expect(await scheduledAssessJobs(t)).toHaveLength(1);
    let item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("pending");

    // Every later mutation on the item reconciles again — the pending stamp is
    // the dedupe, so no second job.
    await reconcile(t, itemId);
    await reconcile(t, itemId);
    expect(await scheduledAssessJobs(t)).toHaveLength(1);
    item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("pending");
  });

  test("does NOT schedule when the scan is tagged to an activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t2" });
    const scholarId = await seedUser(t, "scholar", { username: "s2" });
    const activityId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Test Unit",
        isActive: true,
      } as Doc<"units">);
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Test Lesson",
        order: 0,
      });
      return await ctx.db.insert("activities", {
        lessonId,
        title: "Fractions Worksheet",
        kind: "offline",
        order: 0,
      } as Doc<"activities">);
    });
    const itemId = await seedScan(t, scholarId, { activityId });

    await reconcile(t, itemId);

    // It materialized a deliverable instead — that path does the assessing.
    expect(await scheduledAssessJobs(t)).toHaveLength(0);
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBeUndefined();
  });

  test("does NOT schedule when no scholar is resolved, or processing isn't ready", async () => {
    const t = convexTest(schema, modules);
    const unresolved = await seedScan(t, null);
    const stillProcessing = await seedScan(
      t,
      await seedUser(t, "scholar", { username: "s3" }),
      { processingStatus: "extracting" },
    );

    await reconcile(t, unresolved);
    await reconcile(t, stillProcessing);

    expect(await scheduledAssessJobs(t)).toHaveLength(0);
    for (const id of [unresolved, stillProcessing]) {
      const item = await t.run((ctx) => ctx.db.get(id));
      expect(item?.observationStatus).toBeUndefined();
    }
  });

  test("does NOT re-schedule an item that already has a stamp", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s4" });
    for (const status of ["ready", "skipped", "error"] as const) {
      const itemId = await seedScan(t, scholarId, {
        observationStatus: status,
      });
      await reconcile(t, itemId);
    }
    expect(await scheduledAssessJobs(t)).toHaveLength(0);
  });

  test("known self-report forms are scheduled for learner-statement extraction", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "self-report" });
    const itemId = await seedScan(t, scholarId, {
      title: "Social skills self-assessment checklist",
      aiCaption: "A learner-completed social skills rating survey.",
      extractedText: "I can ask for help when I need it.",
    });

    await reconcile(t, itemId);

    expect(await scheduledAssessJobs(t)).toHaveLength(1);
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("pending");
  });

  test("onboarding strength surveys are treated as self-reports", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "onboarding-survey" });
    const itemId = await seedScan(t, scholarId, {
      title: "Onboarding worksheet",
      documentHeading: "STRENGTH AND INTERESTS",
      aiCaption: "An onboarding packet covering academic strengths and preferred learning styles.",
    });

    await reconcile(t, itemId);

    expect(await scheduledAssessJobs(t)).toHaveLength(1);
    expect(
      (await t.run((ctx) => ctx.db.get(itemId)))?.observationStatus,
    ).toBe("pending");
  });

  test("the ingest hand-off schedules it with no teacher touch", async () => {
    // aiPatchProcessingStatus("ready") is where extractAndMatch finishes; before
    // this wiring nothing on the ingest path ever reached reconcile for an
    // activity-less scan.
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s5" });
    const itemId = await seedScan(t, scholarId, {
      processingStatus: "extracting",
    });

    await t.run((ctx) =>
      ctx.runMutation(internal.portfolio.aiPatchProcessingStatus, {
        itemId,
        status: "ready",
      }),
    );

    expect(await scheduledAssessJobs(t)).toHaveLength(1);
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("pending");
  });
});

// ── (c) the widened record ───────────────────────────────────────────────

describe("masteryObservations.record — session-less scan evidence", () => {
  test("accepts a portfolioItemId with no sessionId", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s6" });
    const itemId = await seedScan(t, scholarId);

    const obsId = await t.run((ctx) =>
      ctx.runMutation(internal.masteryObservations.record, {
        scholarId,
        conceptLabel: "Area model for multiplication",
        domain: "Mathematics",
        portfolioItemId: itemId,
        transcriptExcerpt: "43 x 6 drawn as 40 + 3 with both products labelled",
        masteryLevel: 3,
        confidenceScore: 0.5,
        evidenceSummary: "Solved six two-digit products with an area model.",
        evidenceType: "direct_demonstration",
        attemptContext: "portfolio_scan",
        studentInitiated: false,
      }),
    );

    const row = await t.run((ctx) => ctx.db.get(obsId));
    expect(row?.sessionId).toBeUndefined();
    expect(row?.portfolioItemId).toBe(itemId);
    expect(row?.isSuperseded).toBe(false);
  });

  test("the existing session-ful write still works", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s7" });
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Autorotation",
        isArchived: false,
      }),
    );

    const obsId = await t.run((ctx) =>
      ctx.runMutation(internal.masteryObservations.record, {
        scholarId,
        conceptLabel: "Energy storage in a spinning rotor",
        domain: "Physics",
        sessionId,
        transcriptExcerpt: "the descent powers the rotor",
        masteryLevel: 3.5,
        confidenceScore: 0.7,
        evidenceSummary: "Explained where the rotor's energy comes from.",
        evidenceType: "direct_demonstration",
        attemptContext: "conversation",
        studentInitiated: true,
      }),
    );

    const row = await t.run((ctx) => ctx.db.get(obsId));
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.portfolioItemId).toBeUndefined();
  });
});

// ── the write path ───────────────────────────────────────────────────────

describe("portfolioAssess.applyScanAssessment", () => {
  test("writes scan-anchored rows and stamps ready", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s8" });
    const itemId = await seedScan(t, scholarId);

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "demonstrated_work",
        observations: [
          {
            conceptLabel: "Area model for multiplication",
            domain: "Mathematics",
            masteryLevel: 3,
            confidenceScore: 0.5,
            evidenceType: "direct_demonstration",
            evidenceSummary: "Six two-digit products worked with area models.",
            transcriptExcerpt: "40 + 3, both partial products labelled",
          },
        ],
        learnerStatements: [],
      }),
    );

    expect(result.written).toBe(1);
    const rows = await t.run((ctx) =>
      ctx.db
        .query("masteryObservations")
        .withIndex("by_portfolioItem", (q) => q.eq("portfolioItemId", itemId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scholarId).toBe(scholarId);
    expect(rows[0].attemptContext).toBe("portfolio_scan");
    expect(rows[0].sessionId).toBeUndefined();
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("ready");
  });

  test("zero observations is a valid outcome — ready, no rows", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s9" });
    const itemId = await seedScan(t, scholarId);

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "no_evidence",
        observations: [],
        learnerStatements: [],
      }),
    );

    expect(result.written).toBe(0);
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("ready");
    const rows = await t.run((ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("a re-run replaces this scan's rows instead of piling on", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s10" });
    const itemId = await seedScan(t, scholarId);
    const write = (conceptLabel: string) =>
      t.run((ctx) =>
        ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
          itemId,
          evidenceKind: "demonstrated_work",
          observations: [
            {
              conceptLabel,
              domain: "Mathematics",
              masteryLevel: 2,
              confidenceScore: 0.4,
              evidenceType: "indirect_inference",
              evidenceSummary: "summary",
              transcriptExcerpt: "excerpt",
            },
          ],
          learnerStatements: [],
        }),
      );

    await write("Area model for multiplication");
    await write("Regrouping in multi-digit subtraction");

    const rows = await t.run((ctx) =>
      ctx.db
        .query("masteryObservations")
        .withIndex("by_portfolioItem", (q) => q.eq("portfolioItemId", itemId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].conceptLabel).toBe("Regrouping in multi-digit subtraction");
  });

  test("writes nothing when the item became ineligible mid-flight", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s11" });
    const itemId = await seedScan(t, scholarId);
    // A teacher un-files it while the model call is in flight.
    await t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("portfolioAttributions")
        .withIndex("by_item", (q) => q.eq("portfolioItemId", itemId))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.patch(itemId, { scholarId: undefined });
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "demonstrated_work",
        observations: [
          {
            conceptLabel: "Area model for multiplication",
            domain: "Mathematics",
            masteryLevel: 3,
            confidenceScore: 0.5,
            evidenceType: "direct_demonstration",
            evidenceSummary: "summary",
            transcriptExcerpt: "excerpt",
          },
        ],
        learnerStatements: [],
      }),
    );

    expect(result.written).toBe(0);
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("skipped");
  });

  test("self-report verdict writes learner voice, never mastery", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "self-report-write" });
    const itemId = await seedScan(t, scholarId, {
      title: "Student survey",
      aiCaption: "A learner describes preferred subjects.",
    });
    await t.run((ctx) =>
      ctx.runMutation(internal.masteryObservations.record, {
        scholarId,
        conceptLabel: "Mathematical reasoning",
        domain: "Mathematics",
        portfolioItemId: itemId,
        transcriptExcerpt: "I am good at math.",
        masteryLevel: 2,
        confidenceScore: 0.4,
        evidenceSummary: "The learner reported math as a strength.",
        evidenceType: "indirect_inference",
        attemptContext: "portfolio_scan",
        studentInitiated: false,
      }),
    );

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "self_report",
        observations: [
          {
            conceptLabel: "Mathematical reasoning",
            domain: "Mathematics",
            masteryLevel: 2,
            confidenceScore: 0.4,
            evidenceType: "indirect_inference",
            evidenceSummary: "The learner reported math as a strength.",
            transcriptExcerpt: "I am good at math.",
          },
        ],
        learnerStatements: [
          {
            kind: "interest",
            text: "Enjoys exploring math problems.",
          },
          {
            kind: "self_reflection",
            facet: "confidence",
            text: "Feels confident asking for help.",
          },
        ],
      }),
    );

    expect(result.written).toBe(0);
    const rows = await t.run((ctx) =>
      ctx.db
        .query("masteryObservations")
        .withIndex("by_portfolioItem", (q) => q.eq("portfolioItemId", itemId))
        .collect(),
    );
    expect(rows).toHaveLength(0);
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.learnerStatements).toEqual([
      {
        kind: "interest",
        text: "Enjoys exploring math problems.",
      },
      {
        kind: "self_reflection",
        facet: "confidence",
        text: "Feels confident asking for help.",
      },
    ]);

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.dossier.learnerStatementsForTeacher, { scholarId }),
    ).resolves.toEqual([
      {
        sourceItemId: itemId,
        sourceLabel: "Student survey",
        statements: item?.learnerStatements,
      },
    ]);
  });

  test("self-report text is omitted when a source is shared by multiple learners", async () => {
    const t = convexTest(schema, modules);
    const firstScholarId = await seedUser(t, "scholar", { username: "shared-first" });
    const secondScholarId = await seedUser(t, "scholar", { username: "shared-second" });
    const itemId = await seedScan(t, firstScholarId, {
      title: "Learning profile",
    });
    await t.run((ctx) =>
      ctx.db.insert("portfolioAttributions", {
        portfolioItemId: itemId,
        scholarId: secondScholarId,
        attributedAt: Date.now(),
      }),
    );

    await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "self_report",
        observations: [],
        learnerStatements: [
          { kind: "self_reflection", text: "Prefers to solve problems alone." },
        ],
      }),
    );

    expect((await t.run((ctx) => ctx.db.get(itemId)))?.learnerStatements).toEqual([]);
    const asFirstScholar = await withUser(t, firstScholarId);
    await expect(
      asFirstScholar.query(api.dossier.learnerStatementsForTeacher, {
        scholarId: firstScholarId,
      }),
    ).resolves.toEqual([]);
  });

  test("retagging a self-report clears learner voice and rejects a stale scan write", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "retag-teacher" });
    const firstScholarId = await seedUser(t, "scholar", { username: "retag-first" });
    const secondScholarId = await seedUser(t, "scholar", { username: "retag-second" });
    const itemId = await seedScan(t, firstScholarId, { title: "Learning profile" });

    await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "self_report",
        observations: [],
        learnerStatements: [{ kind: "interest", text: "Enjoys astronomy." }],
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setAttributions, {
      itemId,
      scholarIds: [secondScholarId],
    });

    let item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("pending");
    expect(item?.learnerStatements).toBeUndefined();
    const asSecondScholar = await withUser(t, secondScholarId);
    await expect(
      asSecondScholar.query(api.dossier.learnerStatementsForTeacher, {
        scholarId: secondScholarId,
      }),
    ).resolves.toEqual([]);

    // The old queued action must not apply its read to the new attribution.
    await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        expectedScholarIds: [firstScholarId],
        evidenceKind: "self_report",
        observations: [],
        learnerStatements: [{ kind: "interest", text: "Enjoys dinosaurs." }],
      }),
    );
    item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("pending");
    expect(item?.learnerStatements).toBeUndefined();

    await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        expectedScholarIds: [secondScholarId],
        evidenceKind: "self_report",
        observations: [],
        learnerStatements: [{ kind: "interest", text: "Enjoys astronomy." }],
      }),
    );
    await expect(
      asSecondScholar.query(api.dossier.learnerStatementsForTeacher, {
        scholarId: secondScholarId,
      }),
    ).resolves.toEqual([
      {
        sourceItemId: itemId,
        sourceLabel: "Learning profile",
        statements: [{ kind: "interest", text: "Enjoys astronomy." }],
      },
    ]);
  });
});

describe("portfolioAssess.assess tool boundary", () => {
  test("normalizes malformed learner statements before its strict write", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "action-normalize" });
    const itemId = await seedScan(t, scholarId, { title: "Learning profile" });
    reportObservations.mockResolvedValue({
      usage: { input_tokens: 20, output_tokens: 30 },
      content: [
        {
          type: "tool_use",
          input: {
            evidenceKind: "self_report",
            observations: [],
            learnerStatements: [
              { kind: "interest", text: "Enjoys sketching.", facet: null },
              {
                kind: "self_reflection",
                text: "Notices that smaller steps help.",
                facet: "insight",
                extra: "discarded",
              },
              { kind: "invalid", text: "Discarded." },
              { kind: "interest", text: 42 },
              null,
            ],
          },
        },
      ],
    });

    await expect(
      t.action(internal.portfolioAssess.assess, {
        itemId,
        expectedScholarIds: [scholarId],
      }),
    ).resolves.toMatchObject({ ok: true, written: 0, evidenceKind: "self_report" });

    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("ready");
    expect(item?.learnerStatements).toEqual([
      { kind: "interest", text: "Enjoys sketching." },
      {
        kind: "self_reflection",
        facet: "insight",
        text: "Notices that smaller steps help.",
      },
    ]);
    expect(
      await t.run((ctx) => ctx.db.query("masteryObservations").collect()),
    ).toEqual([]);
  });

  test("marks the scan retryable when malformed tool output fails its strict write", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "action-write-failure" });
    const itemId = await seedScan(t, scholarId);
    reportObservations.mockResolvedValue({
      usage: { input_tokens: 20, output_tokens: 30 },
      content: [
        {
          type: "tool_use",
          input: {
            evidenceKind: "demonstrated_work",
            // The model contract says each observation has seven fields. Omit
            // one to make Convex reject the mutation arguments at the action
            // boundary, where the status must become retryable rather than pending.
            observations: [{ conceptLabel: "Fraction reasoning" }],
            learnerStatements: [],
          },
        },
      ],
    });

    await expect(
      t.action(internal.portfolioAssess.assess, {
        itemId,
        expectedScholarIds: [scholarId],
      }),
    ).resolves.toEqual({ ok: false });

    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBe("error");
    expect(
      await t.run((ctx) => ctx.db.query("masteryObservations").collect()),
    ).toEqual([]);
  });
});

describe("self-report mastery repair", () => {
  test("dry-runs, rejects non-self-reports, and deletes only selected survey rows", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "repair" });
    const selfReportId = await seedScan(t, scholarId, {
      title: "Learning profile",
      extractedText: "I enjoy science and drawing.",
    });

    const workSampleId = await seedScan(t, scholarId, {
      title: "Fractions worksheet",
      extractedText: "3/4 + 1/4 = 1",
    });
    for (const [itemId, conceptLabel] of [
      [selfReportId, "Scientific curiosity"],
      [workSampleId, "Adding fractions"],
    ] as const) {
      await t.run((ctx) =>
        ctx.runMutation(internal.masteryObservations.record, {
          scholarId,
          conceptLabel,
          domain: "General",
          portfolioItemId: itemId,
          transcriptExcerpt: "evidence",
          masteryLevel: 2,
          confidenceScore: 0.4,
          evidenceSummary: "summary",
          evidenceType: "indirect_inference",
          attemptContext: "portfolio_scan",
          studentInitiated: false,
        }),
      );
    }

    const plan = await t.run((ctx) =>
      ctx.runQuery(internal.portfolioAssess.selfReportMasteryRepairPlan, {}),
    );
    expect(plan).toEqual({
      candidates: [{ itemId: selfReportId, observationCount: 1 }],
      observationCount: 1,
    });

    const dryRun = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.repairSelfReportMastery, {
        itemIds: [selfReportId, workSampleId],
        dryRun: true,
      }),
    );
    expect(dryRun.deletedObservations).toBe(1);
    expect(dryRun.rejectedItemIds).toEqual([workSampleId]);
    expect(
      await t.run((ctx) => ctx.db.query("masteryObservations").collect()),
    ).toHaveLength(2);

    const repaired = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.repairSelfReportMastery, {
        itemIds: [selfReportId],
        dryRun: false,
      }),
    );
    expect(repaired.deletedObservations).toBe(1);
    const remaining = await t.run((ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].portfolioItemId).toBe(workSampleId);
  });
});

describe("learner-statement backfill", () => {
  test("schedules only unprocessed known self-reports", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "profile-backfill" });
    const retaggedScholarId = await seedUser(t, "scholar", {
      username: "profile-backfill-retagged",
    });
    const selfReportId = await seedScan(t, scholarId, {
      title: "Learning profile",
      extractedText: "I enjoy science and drawing.",
      observationStatus: "ready",
    });
    const completeId = await seedScan(t, scholarId, {
      title: "Strengths and interests",
      learnerStatements: [{ kind: "interest", text: "Enjoys drawing." }],
      observationStatus: "ready",
    });
    const workSampleId = await seedScan(t, scholarId, {
      title: "Fractions worksheet",
      observationStatus: "ready",
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.backfillLearnerStatements, {
        limit: 10,
      }),
    );

    expect(result.scheduled).toBe(1);
    expect(
      (await t.run((ctx) => ctx.db.get(selfReportId)))?.observationStatus,
    ).toBe("pending");
    expect(
      (await t.run((ctx) => ctx.db.get(completeId)))?.observationStatus,
    ).toBe("ready");
    expect(
      (await t.run((ctx) => ctx.db.get(workSampleId)))?.observationStatus,
    ).toBe("ready");
    const jobs = await scheduledAssessJobs(t);
    expect(jobs).toHaveLength(1);
    const scheduledArgs = jobs[0]?.args[0] as {
      itemId: Id<"portfolioItems">;
      force: boolean;
      expectedScholarIds: Id<"users">[];
    };
    expect(scheduledArgs).toEqual({
      itemId: selfReportId,
      force: true,
      expectedScholarIds: [scholarId],
    });

    // A backfill job may wait behind other work. If the source is retagged in
    // the meantime, it must not apply the prior learner's statement to the new
    // attribution.
    await t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("portfolioAttributions")
        .withIndex("by_item", (q) => q.eq("portfolioItemId", selfReportId))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: selfReportId,
        scholarId: retaggedScholarId,
        attributedAt: Date.now(),
      });
      await ctx.db.patch(selfReportId, { scholarId: retaggedScholarId });
    });
    await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId: selfReportId,
        expectedScholarIds: scheduledArgs.expectedScholarIds,
        evidenceKind: "self_report",
        observations: [],
        learnerStatements: [{ kind: "interest", text: "Stale statement." }],
      }),
    );
    const afterStaleWrite = await t.run((ctx) => ctx.db.get(selfReportId));
    expect(afterStaleWrite?.observationStatus).toBe("pending");
    expect(afterStaleWrite?.learnerStatements).toBeUndefined();
  });
});

// ── teardown ─────────────────────────────────────────────────────────────

describe("scan evidence teardown", () => {
  test("tagging an activity retires the scan evidence and clears the stamp", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t15" });
    const scholarId = await seedUser(t, "scholar", { username: "s15" });
    const { unitId, activityId } = await t.run(async (ctx) => {
      const unit = await ctx.db.insert("units", {
        teacherId,
        title: "Test Unit",
        isActive: true,
      } as Doc<"units">);
      const lessonId = await ctx.db.insert("lessons", {
        unitId: unit,
        title: "Test Lesson",
        order: 0,
      });
      const activity = await ctx.db.insert("activities", {
        lessonId,
        title: "Fractions Worksheet",
        kind: "offline",
        order: 0,
      } as Doc<"activities">);
      return { unitId: unit, activityId: activity };
    });
    const assignmentId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        title: "Cohort A",
        startedAt: Date.now(),
      }),
    );
    const itemId = await seedScan(t, scholarId, {
      assignmentId,
      assignmentStatus: "confirmed",
    });

    // It was assessed as a standalone scan first…
    await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "demonstrated_work",
        observations: [
          {
            conceptLabel: "Area model for multiplication",
            domain: "Mathematics",
            masteryLevel: 3,
            confidenceScore: 0.5,
            evidenceType: "direct_demonstration",
            evidenceSummary: "summary",
            transcriptExcerpt: "excerpt",
          },
        ],
        learnerStatements: [],
      }),
    );
    expect(
      await t.run((ctx) => ctx.db.query("masteryObservations").collect()),
    ).toHaveLength(1);

    // …then a teacher tags it, handing it to the rubric-grounded path.
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.setActivity, { itemId, activityId });

    expect(
      await t.run((ctx) => ctx.db.query("masteryObservations").collect()),
    ).toHaveLength(0);
    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.observationStatus).toBeUndefined();
    expect(
      await t.run((ctx) => ctx.db.query("deliverables").collect()),
    ).toHaveLength(1);
  });

  test("deleting scan evidence cleans up its overrides and granule pointers", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t16" });
    const scholarId = await seedUser(t, "scholar", { username: "s16" });
    const itemId = await seedScan(t, scholarId);
    await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "demonstrated_work",
        observations: [
          {
            conceptLabel: "Subtracting the smaller digit regardless of place",
            domain: "Mathematics",
            masteryLevel: 1,
            confidenceScore: 0.7,
            evidenceType: "misconception_signal",
            evidenceSummary: "summary",
            transcriptExcerpt: "excerpt",
          },
        ],
        learnerStatements: [],
      }),
    );
    const observationId = await t.run(async (ctx) => {
      const row = await ctx.db.query("masteryObservations").first();
      return row!._id;
    });
    // A teacher corrected it, and a granule evidence row cites it.
    const { overrideId, evidenceId } = await t.run(async (ctx) => {
      const override = await ctx.db.insert("teacherMasteryOverrides", {
        observationId,
        teacherId,
        scholarId,
        masteryLevel: 2,
        notes: "Read the page again — the regrouping is there.",
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Some session",
        isArchived: false,
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Test Unit",
        isActive: true,
      } as Doc<"units">);
      const evidence = await ctx.db.insert("granuleEvidence", {
        scholarId,
        unitId,
        granuleKey: "eq:a1",
        sessionId,
        outcome: "probed",
        transcriptExcerpt: "excerpt",
        evidenceSummary: "summary",
        observedAt: Date.now(),
        misconceptionObservationId: observationId,
      } as Doc<"granuleEvidence">);
      return { overrideId: override, evidenceId: evidence };
    });

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.deleteItem, { itemId });

    const after = await t.run(async (ctx) => ({
      observations: await ctx.db.query("masteryObservations").collect(),
      override: await ctx.db.get(overrideId),
      evidence: await ctx.db.get(evidenceId),
    }));
    expect(after.observations).toHaveLength(0);
    expect(after.override).toBeNull();
    expect(after.evidence?.misconceptionObservationId).toBeUndefined();
  });

  test("deleting the item drops the observations it produced", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t12" });
    const scholarId = await seedUser(t, "scholar", { username: "s12" });
    const itemId = await seedScan(t, scholarId);
    await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.applyScanAssessment, {
        itemId,
        evidenceKind: "demonstrated_work",
        observations: [
          {
            conceptLabel: "Area model for multiplication",
            domain: "Mathematics",
            masteryLevel: 3,
            confidenceScore: 0.5,
            evidenceType: "direct_demonstration",
            evidenceSummary: "summary",
            transcriptExcerpt: "excerpt",
          },
        ],
        learnerStatements: [],
      }),
    );
    expect(
      await t.run((ctx) => ctx.db.query("masteryObservations").collect()),
    ).toHaveLength(1);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.portfolio.deleteItem, { itemId });

    expect(
      await t.run((ctx) => ctx.db.query("masteryObservations").collect()),
    ).toHaveLength(0);
  });
});

// ── (d) the backfill sweep ───────────────────────────────────────────────

describe("portfolioAssess.sweepUnassessed", () => {
  test("selects only eligible, unstamped, activity-less scans", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t13" });
    const scholarId = await seedUser(t, "scholar", { username: "s13" });
    const activityId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Test Unit",
        isActive: true,
      } as Doc<"units">);
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Test Lesson",
        order: 0,
      });
      return await ctx.db.insert("activities", {
        lessonId,
        title: "Fractions Worksheet",
        kind: "offline",
        order: 0,
      } as Doc<"activities">);
    });

    const eligible = await seedScan(t, scholarId);
    const tagged = await seedScan(t, scholarId, { activityId });
    const unresolved = await seedScan(t, null);
    const alreadyDone = await seedScan(t, scholarId, {
      observationStatus: "ready",
    });
    const stillProcessing = await seedScan(t, scholarId, {
      processingStatus: "matching",
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.sweepUnassessed, {}),
    );

    expect(result.scheduled).toBe(1);
    expect(await scheduledAssessJobs(t)).toHaveLength(1);
    const statuses = await t.run(async (ctx) => ({
      eligible: (await ctx.db.get(eligible))?.observationStatus,
      tagged: (await ctx.db.get(tagged))?.observationStatus,
      unresolved: (await ctx.db.get(unresolved))?.observationStatus,
      alreadyDone: (await ctx.db.get(alreadyDone))?.observationStatus,
      stillProcessing: (await ctx.db.get(stillProcessing))?.observationStatus,
    }));
    expect(statuses).toEqual({
      eligible: "pending",
      tagged: undefined,
      unresolved: undefined,
      alreadyDone: "ready",
      stillProcessing: undefined,
    });
  });

  test("leaves errored runs alone unless retryErrors is set", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s17" });
    const errored = await seedScan(t, scholarId, {
      observationStatus: "error",
    });

    const skipped = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.sweepUnassessed, {}),
    );
    expect(skipped.scheduled).toBe(0);

    const retried = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.sweepUnassessed, {
        retryErrors: true,
      }),
    );
    expect(retried.scheduled).toBe(1);
    const item = await t.run((ctx) => ctx.db.get(errored));
    expect(item?.observationStatus).toBe("pending");
  });

  test("honours the limit and claims what it schedules", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "s14" });
    for (let i = 0; i < 3; i++) await seedScan(t, scholarId);

    const first = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.sweepUnassessed, { limit: 2 }),
    );
    expect(first.scheduled).toBe(2);

    const second = await t.run((ctx) =>
      ctx.runMutation(internal.portfolioAssess.sweepUnassessed, { limit: 50 }),
    );
    expect(second.scheduled).toBe(1);
    expect(await scheduledAssessJobs(t)).toHaveLength(3);
  });
});
