/**
 * keyMoments.forScholarDayInternal — the no-identity counterpart of
 * forScholarDay that the Special Delivery generator calls from a cron (an
 * internal action with no user to gate on). It must return the SAME
 * gather/day-filter/score/sort result as the authed read, including the
 * print-safety redaction boundary (scholarVerbatim vs. observerAnalysis in
 * separate fields), with NO auth applied. Unlike a scholar's SELF call to
 * `forScholarDay` (which strips `observerAnalysis` entirely), this internal
 * read always returns the full row — it is reachable only from trusted
 * server code, never a client.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedTestInstitution,
  seedScholarInInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const NY_TZ = "America/New_York";

async function seedInstitutionWithTz(
  t: ReturnType<typeof convexTest>,
  timeZone: string,
) {
  const institutionId = await seedTestInstitution(t, { slug: "tz-internal" });
  await t.run((ctx) => ctx.db.patch(institutionId, { timeZone }));
  return institutionId;
}

async function seedMastery(
  t: ReturnType<typeof convexTest>,
  args: {
    scholarId: Id<"users">;
    observedAt: number;
    transcriptExcerpt?: string;
    evidenceSummary?: string;
    isSuperseded?: boolean;
    sessionId?: Id<"sessions">;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("masteryObservations", {
      scholarId: args.scholarId,
      conceptLabel: "Gravity",
      domain: "Physics",
      observedAt: args.observedAt,
      sessionId: args.sessionId,
      transcriptExcerpt: args.transcriptExcerpt ?? "heavy falls faster",
      masteryLevel: 1,
      confidenceScore: 0.9,
      evidenceSummary: args.evidenceSummary ?? "Observer analysis.",
      evidenceType: "direct_demonstration",
      attemptContext: "conversation",
      studentInitiated: false,
      isSuperseded: args.isSuperseded ?? false,
    }),
  );
}

describe("keyMoments.forScholarDayInternal", () => {
  test("returns the scored day with NO identity (cron path)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });

    // 2026-01-14 13:00 NY → day 2026-01-14; keep-and-exclude fixtures.
    const observedAt = Date.UTC(2026, 0, 14, 18, 0, 0);
    const keptId = await seedMastery(t, {
      scholarId: scholar,
      observedAt,
      transcriptExcerpt: "I bet heavier things fall faster.",
      evidenceSummary: "Holds the Aristotelian misconception; re-teach.",
    });
    // Superseded → excluded even for the internal caller.
    await seedMastery(t, {
      scholarId: scholar,
      observedAt,
      isSuperseded: true,
    });

    // No withIdentity: an internalQuery is reachable from trusted server code
    // with no user, which is exactly what the generator does.
    const moments = await t.query(
      internal.keyMoments.forScholarDayInternal,
      { scholarId: scholar, dayKey: "2026-01-14" },
    );

    expect(moments).toHaveLength(1);
    expect(moments[0].sourceId).toBe(keptId);
    // Redaction boundary preserved: verbatim vs. analysis stay in distinct
    // fields, and nothing is merged into an "excerpt". The internal (cron)
    // read is a trusted server-to-server call, so it keeps the FULL row —
    // only the self-facing `forScholarDay` strips `observerAnalysis`.
    expect(moments[0].scholarVerbatim).toBe("I bet heavier things fall faster.");
    expect(moments[0].observerAnalysis).toBe(
      "Holds the Aristotelian misconception; re-teach.",
    );
    expect(moments[0]).not.toHaveProperty("excerpt");
  });

  test("honors the limit", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const observedAt = Date.UTC(2026, 0, 14, 18, 0, 0);
    for (let i = 0; i < 4; i++) {
      await seedMastery(t, { scholarId: scholar, observedAt });
    }

    const moments = await t.query(
      internal.keyMoments.forScholarDayInternal,
      { scholarId: scholar, dayKey: "2026-01-14", limit: 2 },
    );
    expect(moments).toHaveLength(2);
  });

  test("day-scoped by_scholar_observedAt index range excludes an OLD day even across a full history of rows", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });

    // A spread of old rows on many prior days, plus one on the target day —
    // the internal (no-identity) read must range-scope on `observedAt` via
    // by_scholar_observedAt, never collect the scholar's whole history.
    for (let daysAgo = 20; daysAgo >= 2; daysAgo -= 1) {
      await seedMastery(t, {
        scholarId: scholar,
        observedAt: Date.UTC(2026, 0, 14, 18, 0, 0) - daysAgo * 24 * 60 * 60 * 1000,
      });
    }
    const targetId = await seedMastery(t, {
      scholarId: scholar,
      observedAt: Date.UTC(2026, 0, 14, 18, 0, 0),
    });

    const moments = await t.query(
      internal.keyMoments.forScholarDayInternal,
      { scholarId: scholar, dayKey: "2026-01-14" },
    );

    expect(moments).toHaveLength(1);
    expect(moments[0].sourceId).toBe(targetId);
  });
});
