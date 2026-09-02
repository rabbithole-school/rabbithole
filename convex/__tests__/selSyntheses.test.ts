import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedOperationsStaff,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const { modelCreate } = vi.hoisted(() => ({
  modelCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: modelCreate };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    } as Omit<Doc<"authSessions">, "_id" | "_creationTime">),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function insertSignal(
  t: T,
  scholarId: Id<"users">,
  description: string,
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Fixture session",
      isArchived: false,
    });
    return await ctx.db.insert("sessionSignals", {
      scholarId,
      sessionId,
      signalType: "task_commitment",
      description,
      intensity: "high",
    });
  });
}

function structuredReply(input: Record<string, unknown>) {
  return {
    content: [
      {
        type: "tool_use",
        name: "record_sel_synthesis",
        input,
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  modelCreate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("SEL synthesis read model", () => {
  test("writes an honest quiet row without calling the model", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const startMs = Date.parse("2026-08-17T00:00:00.000Z");
    const endMs = Date.parse("2026-08-24T00:00:00.000Z");

    const result = await t.action(
      internal.selSynthesisActions.generateSelSynthesisForScholar,
      { scholarId, weekKey: "2026-08-20", window: { startMs, endMs } },
    );

    expect(result).toMatchObject({ quiet: true, strengthCount: 0, watchCount: 0 });
    expect(modelCreate).not.toHaveBeenCalled();
    const rows = await t.run((ctx) => ctx.db.query("selSyntheses").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scholarId,
      institutionId,
      weekKey: "2026-08-20",
      quiet: true,
      strengths: [],
      watch: [],
    });
  });

  test("drops claims whose citations are absent from the collected input", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const signalId = await insertSignal(
      t,
      scholarId,
      "Stayed with a difficult construction until it worked.",
    );
    modelCreate.mockResolvedValue(
      structuredReply({
        strengths: [
          {
            text: "Stayed with a difficult construction until it worked.",
            cites: [{ kind: "sessionSignal", id: String(signalId) }],
          },
          {
            text: "Made the whole group feel welcome.",
            cites: [{ kind: "sessionSignal", id: "invented-id" }],
          },
          { text: "Asked unusually deep questions.", cites: [] },
        ],
        watch: [],
      }),
    );

    await t.action(
      internal.selSynthesisActions.generateSelSynthesisForScholar,
      {
        scholarId,
        weekKey: "2026-08-20",
        window: {
          startMs: Date.parse("2026-08-17T00:00:00.000Z"),
          endMs: Date.parse("2026-08-24T00:00:00.000Z"),
        },
      },
    );

    const row = await t.run((ctx) =>
      ctx.db
        .query("selSyntheses")
        .withIndex("by_scholar_week", (q) =>
          q.eq("scholarId", scholarId).eq("weekKey", "2026-08-20"),
        )
        .unique(),
    );
    expect(row?.strengths).toEqual([
      {
        text: "Stayed with a difficult construction until it worked.",
        cites: [
          expect.objectContaining({
            kind: "sessionSignal",
            id: String(signalId),
            label: "task_commitment",
          }),
        ],
      },
    ]);
  });

  test("regeneration replaces the existing scholar-week row", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const signalId = await insertSignal(t, scholarId, "Returned to the problem.");
    modelCreate
      .mockResolvedValueOnce(
        structuredReply({
          strengths: [
            {
              text: "Returned to the problem.",
              cites: [{ kind: "sessionSignal", id: String(signalId) }],
            },
          ],
          watch: [],
        }),
      )
      .mockResolvedValueOnce(
        structuredReply({
          strengths: [
            {
              text: "Returned to the problem and tested a second approach.",
              cites: [{ kind: "sessionSignal", id: String(signalId) }],
            },
          ],
          watch: [],
        }),
      );
    const args = {
      scholarId,
      weekKey: "2026-08-20",
      window: {
        startMs: Date.parse("2026-08-17T00:00:00.000Z"),
        endMs: Date.parse("2026-08-24T00:00:00.000Z"),
      },
    };

    await t.action(
      internal.selSynthesisActions.generateSelSynthesisForScholar,
      args,
    );
    await t.action(
      internal.selSynthesisActions.generateSelSynthesisForScholar,
      args,
    );

    const rows = await t.run((ctx) => ctx.db.query("selSyntheses").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.strengths[0]?.text).toBe(
      "Returned to the problem and tested a second approach.",
    );
  });

  test("never admits a signal outside the requested window as a citation", async () => {
    vi.useRealTimers();
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const oldSignalId = await insertSignal(t, scholarId, "Old evidence.");
    const oldSignal = await t.run((ctx) => ctx.db.get(oldSignalId));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const currentSignalId = await insertSignal(t, scholarId, "Current evidence.");
    const currentSignal = await t.run((ctx) => ctx.db.get(currentSignalId));
    if (!oldSignal || !currentSignal) throw new Error("Fixture signal missing");
    modelCreate.mockResolvedValue(
      structuredReply({
        strengths: [
          {
            text: "Old evidence.",
            cites: [{ kind: "sessionSignal", id: String(oldSignalId) }],
          },
          {
            text: "Current evidence.",
            cites: [{ kind: "sessionSignal", id: String(currentSignalId) }],
          },
        ],
        watch: [],
      }),
    );

    await t.action(
      internal.selSynthesisActions.generateSelSynthesisForScholar,
      {
        scholarId,
        weekKey: "2026-08-20",
        window: {
          startMs: oldSignal._creationTime + 1,
          endMs: currentSignal._creationTime + 1,
        },
      },
    );

    const row = await t.run((ctx) =>
      ctx.db.query("selSyntheses").first(),
    );
    expect(row?.strengths.map((claim) => claim.text)).toEqual([
      "Current evidence.",
    ]);
    expect(JSON.stringify(modelCreate.mock.calls[0]?.[0])).not.toContain(
      String(oldSignalId),
    );
  });

  test("refuses the staff read to a non-staff caller", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.selSyntheses.forScholarWeek, {
        scholarId,
        weekKey: "2026-08-20",
      }),
    ).rejects.toThrow("teacher or admin role required");
  });

  test("refuses operations staff and curriculum designers access to the synthesis", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const operationsStaffId = await seedOperationsStaff(t, { institutionId });
    const curriculumDesignerId = await seedStaffWithMembership(t, {
      institutionId,
      role: "curriculum_designer",
      name: "Curriculum Designer",
    });

    for (const userId of [operationsStaffId, curriculumDesignerId]) {
      const asUser = await withUser(t, userId);
      await expect(
        asUser.query(api.selSyntheses.forScholarWeek, {
          scholarId,
          weekKey: "2026-08-20",
        }),
      ).rejects.toThrow("teacher or admin role required");
    }
  });

  test("caps each evidence kind at 20 rows and truncates long free text", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, { institutionId });
    const longText = "x".repeat(700);
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Evidence cap fixture",
        isArchived: false,
      });
      for (let index = 0; index < 25; index += 1) {
        await ctx.db.insert("sessionSignals", {
          scholarId,
          sessionId,
          signalType: `signal-${index}`,
          description: longText,
          intensity: "high",
          transcriptExcerpt: longText,
        });
        await ctx.db.insert("observations", {
          teacherId: scholarId,
          scholarId,
          note: longText,
          type: "note",
          category: "socialEmotional",
        });
        await ctx.db.insert("alerts", {
          kind: "fixture",
          severity: "warning",
          title: `Alert ${index}`,
          body: longText,
          source: "test",
          scholarId,
          status: "open",
          createdAt: Date.now(),
        });
        await ctx.db.insert("analyses", {
          sessionId,
          concernFlags: ["frustration"],
          summary: longText,
          suggestedIntervention: longText,
        });
      }
    });

    const collected = await t.run((ctx) =>
      ctx.runQuery(internal.selSyntheses.collectEvidenceForScholar, {
        scholarId,
        window: {
          startMs: Date.parse("2026-08-17T00:00:00.000Z"),
          endMs: Date.parse("2026-08-24T00:00:00.000Z"),
        },
      }),
    );
    const byKind = new Map<string, typeof collected.evidence>();
    for (const evidence of collected.evidence) {
      const rows = byKind.get(evidence.citation.kind) ?? [];
      rows.push(evidence);
      byKind.set(evidence.citation.kind, rows);
    }

    for (const kind of [
      "sessionSignal",
      "analysis",
      "alert",
      "observation",
    ]) {
      expect(byKind.get(kind)).toHaveLength(20);
    }
    for (const evidence of collected.evidence) {
      for (const field of [
        "description",
        "transcriptExcerpt",
        "note",
        "body",
        "summary",
        "suggestedIntervention",
      ]) {
        const value = evidence.details[field];
        if (typeof value === "string") expect(value.length).toBe(500);
      }
    }
  });

  test("the batch driver covers exactly enrolled scholars in the institution", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      slug: "moli",
      name: "Moli School",
    });
    const otherInstitutionId = await seedTestInstitution(t, {
      slug: "other-school",
      name: "Other School",
    });
    const includedA = await seedScholarInInstitution(t, {
      institutionId,
      name: "Ala Scholar",
    });
    const includedB = await seedScholarInInstitution(t, {
      institutionId,
      name: "Bela Scholar",
    });
    const guest = await seedScholarInInstitution(t, {
      institutionId,
      name: "Guest Scholar",
    });
    await t.run((ctx) =>
      ctx.db.patch(guest, { enrollmentStanding: "program_guest" }),
    );
    const otherScholar = await seedScholarInInstitution(t, {
      institutionId: otherInstitutionId,
      name: "Other Scholar",
    });
    await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
      name: "Lehua Torres",
    });
    const signalIds = new Map<Id<"users">, Id<"sessionSignals">>();
    for (const scholarId of [includedA, includedB, guest, otherScholar]) {
      signalIds.set(
        scholarId,
        await insertSignal(t, scholarId, `Evidence for ${scholarId}`),
      );
    }
    modelCreate.mockImplementation(async (request: unknown) => {
      const requestText = JSON.stringify(request);
      const matchingId = [...signalIds.values()].find((id) =>
        requestText.includes(String(id)),
      );
      return structuredReply({
        strengths: matchingId
          ? [
              {
                text: "Worked persistently on the session task.",
                cites: [{ kind: "sessionSignal", id: String(matchingId) }],
              },
            ]
          : [],
        watch: [],
      });
    });

    const result = await t.action(
      internal.selSynthesisActions.generateSelSynthesesForWeek,
      {
        institutionId,
        weekKey: "2026-08-20",
        window: {
          startMs: Date.parse("2026-08-17T00:00:00.000Z"),
          endMs: Date.parse("2026-08-24T00:00:00.000Z"),
        },
      },
    );

    expect(result).toMatchObject({
      eligibleScholarCount: 2,
      generatedCount: 2,
      quietCount: 0,
      failedCount: 0,
      failedScholarIds: [],
    });
    expect(modelCreate).toHaveBeenCalledTimes(2);
    const rows = await t.run((ctx) => ctx.db.query("selSyntheses").collect());
    expect(rows.map((row) => row.scholarId).sort()).toEqual(
      [includedA, includedB].sort(),
    );
  });

  test("continues the batch and reports a scholar whose generation fails", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const includedA = await seedScholarInInstitution(t, {
      institutionId,
      name: "Ala Scholar",
    });
    const failing = await seedScholarInInstitution(t, {
      institutionId,
      name: "Bela Scholar",
    });
    const includedC = await seedScholarInInstitution(t, {
      institutionId,
      name: "Cora Scholar",
    });
    const signalIds = new Map<Id<"users">, Id<"sessionSignals">>();
    for (const scholarId of [includedA, failing, includedC]) {
      signalIds.set(
        scholarId,
        await insertSignal(t, scholarId, `Evidence for ${scholarId}`),
      );
    }
    modelCreate.mockImplementation(async (request: unknown) => {
      const requestText = JSON.stringify(request);
      if (requestText.includes(String(signalIds.get(failing)))) {
        throw new Error("Anthropic overloaded");
      }
      const matchingId = [...signalIds.values()].find((id) =>
        requestText.includes(String(id)),
      );
      return structuredReply({
        strengths: matchingId
          ? [
              {
                text: "Stayed with the work.",
                cites: [{ kind: "sessionSignal", id: String(matchingId) }],
              },
            ]
          : [],
        watch: [],
      });
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await t.action(
      internal.selSynthesisActions.generateSelSynthesesForWeek,
      {
        institutionId,
        weekKey: "2026-08-20",
        window: {
          startMs: Date.parse("2026-08-17T00:00:00.000Z"),
          endMs: Date.parse("2026-08-24T00:00:00.000Z"),
        },
      },
    );

    expect(result).toMatchObject({
      eligibleScholarCount: 3,
      generatedCount: 2,
      quietCount: 0,
      failedCount: 1,
      failedScholarIds: [failing],
    });
    expect(modelCreate).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(String(failing)),
      "Anthropic overloaded",
    );
    const rows = await t.run((ctx) => ctx.db.query("selSyntheses").collect());
    expect(rows.map((row) => row.scholarId).sort()).toEqual(
      [includedA, includedC].sort(),
    );
  });
});

async function insertSynthesisRow(
  t: T,
  args: {
    scholarId: Id<"users">;
    institutionId: Id<"institutions">;
    weekKey: string;
    quiet: boolean;
    strengthText?: string;
  },
) {
  await t.run((ctx) =>
    ctx.db.insert("selSyntheses", {
      scholarId: args.scholarId,
      institutionId: args.institutionId,
      weekKey: args.weekKey,
      strengths: args.strengthText
        ? [
            {
              text: args.strengthText,
              cites: [
                { kind: "sessionSignal", id: "s1", label: "persistence", at: 1 },
              ],
            },
          ]
        : [],
      watch: [],
      quiet: args.quiet,
      window: { startMs: 1, endMs: 2 },
      model: "test-model",
      promptVersion: "test-v1",
      generatedAt: 123,
    }),
  );
}

describe("SEL synthesis batched roster read (forScholarsWeek)", () => {
  test("returns one row per scholar with a synthesis this week, skipping the rest", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "T",
      username: "batch-teacher",
    });
    const written = await seedScholarInInstitution(t, {
      institutionId,
      name: "Ada",
      username: "batch-ada",
    });
    const quiet = await seedScholarInInstitution(t, {
      institutionId,
      name: "Bo",
      username: "batch-bo",
    });
    const none = await seedScholarInInstitution(t, {
      institutionId,
      name: "Cy",
      username: "batch-cy",
    });

    await insertSynthesisRow(t, {
      scholarId: written,
      institutionId,
      weekKey: "2026-08-20",
      quiet: false,
      strengthText: "Stayed with the problem",
    });
    await insertSynthesisRow(t, {
      scholarId: quiet,
      institutionId,
      weekKey: "2026-08-20",
      quiet: true,
    });
    // `none` has a synthesis for a DIFFERENT week — it must not leak in.
    await insertSynthesisRow(t, {
      scholarId: none,
      institutionId,
      weekKey: "2026-08-13",
      quiet: true,
    });

    const asTeacher = await withUser(t, teacher);
    const { rows } = await asTeacher.query(api.selSyntheses.forScholarsWeek, {
      scholarIds: [written, quiet, none],
      weekKey: "2026-08-20",
    });

    const byId = new Map(rows.map((r) => [r.scholarId, r]));
    expect(byId.size).toBe(2);
    expect(byId.get(String(written))?.quiet).toBe(false);
    expect(byId.get(String(written))?.strengths[0]?.text).toBe(
      "Stayed with the problem",
    );
    expect(byId.get(String(quiet))?.quiet).toBe(true);
    expect(byId.has(String(none))).toBe(false);
  });

  test("refuses a scholar outside the caller's institution", async () => {
    const t = convexTest(schema, modules);
    const home = await seedTestInstitution(t);
    const other = await seedTestInstitution(t, {
      slug: "other-fixture-school",
      name: "Other Fixture School",
    });
    const teacher = await seedStaffWithMembership(t, {
      institutionId: home,
      name: "T",
      username: "batch-home-teacher",
    });
    const outsider = await seedScholarInInstitution(t, {
      institutionId: other,
      name: "X",
      username: "batch-outsider",
    });

    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.query(api.selSyntheses.forScholarsWeek, {
        scholarIds: [outsider],
        weekKey: "2026-08-20",
      }),
    ).rejects.toThrow();
  });

  test("throws over the fan-out cap rather than truncating the roster", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "T",
      username: "batch-cap-teacher",
    });
    const asTeacher = await withUser(t, teacher);
    // 61 distinct real user ids — over the 60 fan-out bound. The cap is checked
    // before any access read, so these need not be accessible scholars.
    const tooMany = await t.run(async (ctx) => {
      const ids: Id<"users">[] = [];
      for (let i = 0; i < 61; i++) {
        ids.push(
          await ctx.db.insert("users", {
            name: `Cap ${i}`,
            username: `batch-cap-${i}`,
            role: "scholar",
          }),
        );
      }
      return ids;
    });
    await expect(
      asTeacher.query(api.selSyntheses.forScholarsWeek, {
        scholarIds: tooMany,
        weekKey: "2026-08-20",
      }),
    ).rejects.toThrow(/limit is 60/);
  });
});
