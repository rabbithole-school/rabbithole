import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

function obsArgs(
  scholarId: Id<"users">,
  sessionId: Id<"sessions">,
  conceptLabel: string,
  opts: { evidenceType?: string; misconceptionStatus?: "open" | "addressed" } = {},
) {
  return {
    scholarId,
    conceptLabel,
    domain: "Mathematics",
    observedAt: Date.now(),
    sessionId,
    transcriptExcerpt: "...",
    masteryLevel: 3,
    confidenceScore: 0.8,
    evidenceSummary: "...",
    evidenceType: opts.evidenceType ?? "direct_demonstration",
    attemptContext: "conversation",
    studentInitiated: true,
    isSuperseded: false,
    ...(opts.misconceptionStatus
      ? { misconceptionStatus: opts.misconceptionStatus }
      : {}),
  };
}

describe("masteryObservations.purgeScholar — cascade hard-delete", () => {
  test("dry-run reports the human-data-at-risk counts and deletes nothing", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, obsId } = await t.run(async (ctx) => {
      const scholarId = await ctx.db.insert("users", {
        username: "purge-dry",
        role: "scholar",
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "S",
        isArchived: false,
      });
      const obsId = await ctx.db.insert(
        "masteryObservations",
        obsArgs(scholarId, sessionId, "Fraction equivalence"),
      );
      const misId = await ctx.db.insert(
        "masteryObservations",
        obsArgs(scholarId, sessionId, "Counts pieces, ignores size", {
          evidenceType: "misconception_signal",
          misconceptionStatus: "addressed",
        }),
      );
      await ctx.db.insert("teacherMasteryOverrides", {
        scholarId,
        observationId: obsId,
        teacherId: scholarId, // any user id is fine for the test
        masteryLevel: 4,
        notes: "teacher correction",
      });
      await ctx.db.insert("granuleEvidence", {
        scholarId,
        unitId: await ctx.db.insert("units", { teacherId: scholarId, title: "U", isActive: true }),
        granuleKey: "EQ1",
        sessionId,
        observedAt: Date.now(),
        outcome: "probed",
        transcriptExcerpt: "...",
        evidenceSummary: "...",
        misconceptionObservationId: misId,
      });
      return { scholarId, obsId };
    });

    const report = await t.mutation(
      internal.masteryObservations.purgeScholar,
      { scholarId },
    );
    expect(report.dryRun).toBe(true);
    expect(report.deletedObservations).toBe(2);
    expect(report.misconceptions).toBe(1);
    expect(report.addressedMisconceptions).toBe(1);
    expect(report.teacherOverridesDeleted).toBe(1);
    expect(report.granuleEvidenceLinksNulled).toBe(1);

    // Nothing actually removed.
    const stillThere = await t.run(async (ctx) => ctx.db.get(obsId));
    expect(stillThere).not.toBeNull();
  });

  test("real run deletes observations + overrides and nulls granule misconception links", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, evidenceId } = await t.run(async (ctx) => {
      const scholarId = await ctx.db.insert("users", {
        username: "purge-real",
        role: "scholar",
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "S",
        isArchived: false,
      });
      const obsId = await ctx.db.insert(
        "masteryObservations",
        obsArgs(scholarId, sessionId, "Fraction equivalence"),
      );
      const misId = await ctx.db.insert(
        "masteryObservations",
        obsArgs(scholarId, sessionId, "Counts pieces", {
          evidenceType: "misconception_signal",
        }),
      );
      await ctx.db.insert("teacherMasteryOverrides", {
        scholarId,
        observationId: obsId,
        teacherId: scholarId,
        masteryLevel: 4,
        notes: "teacher correction",
      });
      const evidenceId = await ctx.db.insert("granuleEvidence", {
        scholarId,
        unitId: await ctx.db.insert("units", { teacherId: scholarId, title: "U", isActive: true }),
        granuleKey: "EQ1",
        sessionId,
        observedAt: Date.now(),
        outcome: "probed",
        transcriptExcerpt: "...",
        evidenceSummary: "...",
        misconceptionObservationId: misId,
      });
      return { scholarId, evidenceId };
    });

    const report = await t.mutation(
      internal.masteryObservations.purgeScholar,
      { scholarId, dryRun: false },
    );
    expect(report.deletedObservations).toBe(2);

    await t.run(async (ctx) => {
      const remaining = (await ctx.db.query("masteryObservations").collect()).filter(
        (o) => o.scholarId === scholarId,
      );
      expect(remaining).toHaveLength(0);
      const overrides = await ctx.db.query("teacherMasteryOverrides").collect();
      expect(overrides).toHaveLength(0);
      // The granuleEvidence row survives, but its dangling misconception link is nulled.
      const ev = await ctx.db.get(evidenceId);
      expect(ev).not.toBeNull();
      expect(ev?.misconceptionObservationId).toBeUndefined();
    });
  });
});

describe("sessions.analyzableSessionsForScholar", () => {
  test("returns non-test-drive sessions with ≥3 real messages, oldest→newest", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, oldId, newId } = await t.run(async (ctx) => {
      const scholarId = await ctx.db.insert("users", {
        username: "analyzable",
        role: "scholar",
      });
      const mk = async (title: string) =>
        ctx.db.insert("sessions", { userId: scholarId, title, isArchived: false });
      const addMsgs = async (sessionId: Id<"sessions">, n: number, includeStart = true) => {
        if (includeStart)
          await ctx.db.insert("messages", {
            sessionId,
            role: "user",
            content: "<start>",
            flagged: false,
          });
        for (let i = 0; i < n; i++)
          await ctx.db.insert("messages", {
            sessionId,
            role: i % 2 === 0 ? "user" : "assistant",
            content: `m${i}`,
            flagged: false,
          });
      };

      const oldId = await mk("old");
      await addMsgs(oldId, 4);
      const newId = await mk("new");
      await addMsgs(newId, 4);
      // Excluded: too few real messages (only the <start> sentinel + 1).
      const tiny = await mk("tiny");
      await addMsgs(tiny, 1);
      // Excluded: a test drive.
      const td = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "drive",
        isArchived: false,
        isTestDrive: true,
      });
      await addMsgs(td, 4);
      return { scholarId, oldId, newId };
    });

    const out = await t.query(
      internal.sessions.analyzableSessionsForScholar,
      { scholarId },
    );
    expect(out.map((s) => s.sessionId)).toEqual([oldId, newId]);
    expect(out[0].observedAt).toBeLessThanOrEqual(out[1].observedAt);
    expect(out.every((s) => s.messageCount >= 3)).toBe(true);
  });
});
