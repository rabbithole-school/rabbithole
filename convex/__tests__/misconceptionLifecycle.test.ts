import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
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
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const name = overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`);
  const username =
    overrides.username ?? (role === "scholar" ? "testscholar" : `test${role}`);
  const institutionId = await seedTestInstitution(t);
  if (role === "teacher") {
    return seedStaffWithMembership(t, { institutionId, name, username });
  }
  if (role === "scholar") {
    const userId = await seedScholarInInstitution(t, { institutionId, name, username });
    await t.run((ctx) =>
      ctx.db.patch(userId, {
        readingLevel: overrides.readingLevel,
        image: overrides.image,
      }),
    );
    return userId;
  }
  return t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      username,
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedObservation(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  evidenceType: string,
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Test Project",
      isArchived: false,
    });
    return await ctx.db.insert("masteryObservations", {
      scholarId,
      conceptLabel: "Misconception: heavier objects fall faster",
      domain: "Physics",
      observedAt: Date.now(),
      sessionId,
      transcriptExcerpt: "heavy falls faster, thats how it works",
      masteryLevel: 1.0,
      confidenceScore: 0.9,
      evidenceSummary: "Student holds a confident wrong belief about gravity.",
      evidenceType,
      attemptContext: "conversation",
      studentInitiated: false,
      isSuperseded: false,
    });
  });
}

describe("misconception lifecycle", () => {
  test("teacher marks a misconception addressed (stamps who/when/note)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const obsId = await seedObservation(t, scholarId, "misconception_signal");

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.masteryObservations.setMisconceptionStatus, {
      observationId: obsId,
      status: "addressed",
      note: "Re-taught with the bowling-ball + feather demo.",
    });

    const row = await t.run(async (ctx) => ctx.db.get(obsId));
    expect(row?.misconceptionStatus).toBe("addressed");
    expect(row?.misconceptionAddressedBy).toBe(teacherId);
    expect(typeof row?.misconceptionAddressedAt).toBe("number");
    expect(row?.misconceptionNote).toContain("bowling-ball");
  });

  test("reopening clears the addressed stamps", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const obsId = await seedObservation(t, scholarId, "misconception_signal");
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.masteryObservations.setMisconceptionStatus, {
      observationId: obsId,
      status: "addressed",
      note: "addressed",
    });
    await asTeacher.mutation(api.masteryObservations.setMisconceptionStatus, {
      observationId: obsId,
      status: "open",
    });

    const row = await t.run(async (ctx) => ctx.db.get(obsId));
    expect(row?.misconceptionStatus).toBe("open");
    expect(row?.misconceptionAddressedAt).toBeUndefined();
    expect(row?.misconceptionAddressedBy).toBeUndefined();
  });

  test("rejects non-misconception observations", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const obsId = await seedObservation(t, scholarId, "direct_demonstration");
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.masteryObservations.setMisconceptionStatus, {
        observationId: obsId,
        status: "addressed",
      }),
    ).rejects.toThrow(/only applies to misconception/i);
  });

  test("non-teachers cannot set status", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const obsId = await seedObservation(t, scholarId, "misconception_signal");
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.masteryObservations.setMisconceptionStatus, {
        observationId: obsId,
        status: "addressed",
      }),
    ).rejects.toThrow();
  });
});

// ── flagMisconception (Wave 3 §9 — teacher-facing create path) ─────────────
describe("flagMisconception", () => {
  test("creates an OPEN misconception observation anchored to the scholar's latest session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", { userId: scholarId, title: "Older session", isArchived: false }),
    );
    const latestSessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", { userId: scholarId, title: "Newer session", isArchived: false }),
    );
    const asTeacher = await withUser(t, teacherId);

    const obsId = await asTeacher.mutation(api.masteryObservations.flagMisconception, {
      scholarId,
      conceptLabel: "Thinks −2 − (−7) = 9",
      domain: "Whole Number Arithmetic",
    });

    const row = await t.run(async (ctx) => ctx.db.get(obsId));
    expect(row?.scholarId).toBe(scholarId);
    expect(row?.conceptLabel).toBe("Thinks −2 − (−7) = 9");
    expect(row?.domain).toBe("Whole Number Arithmetic");
    expect(row?.evidenceType).toBe("misconception_signal");
    expect(row?.misconceptionStatus).toBe("open");
    expect(row?.masteryLevel).toBeLessThanOrEqual(1);
    expect(row?.attemptContext).toBe("teacher-flagged");
    expect(row?.studentInitiated).toBe(false);
    // Anchored to a real session (required FK) — the scholar's most recent one.
    expect(row?.sessionId).toBe(latestSessionId);
  });

  test("trims the concept label and rejects a blank one", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    await t.run(async (ctx) => ctx.db.insert("sessions", { userId: scholarId, title: "S", isArchived: false }));
    const asTeacher = await withUser(t, teacherId);

    const obsId = await asTeacher.mutation(api.masteryObservations.flagMisconception, {
      scholarId,
      conceptLabel: "  drops the remainder  ",
    });
    const row = await t.run(async (ctx) => ctx.db.get(obsId));
    expect(row?.conceptLabel).toBe("drops the remainder");

    await expect(
      asTeacher.mutation(api.masteryObservations.flagMisconception, {
        scholarId,
        conceptLabel: "   ",
      }),
    ).rejects.toThrow(/conceptLabel is required/i);
  });

  test("throws when the scholar has no session to anchor to", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.masteryObservations.flagMisconception, {
        scholarId,
        conceptLabel: "Any concept",
      }),
    ).rejects.toThrow(/no session/i);
  });

  test("non-teachers cannot flag a misconception", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    await t.run(async (ctx) => ctx.db.insert("sessions", { userId: scholarId, title: "S", isArchived: false }));
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.masteryObservations.flagMisconception, {
        scholarId,
        conceptLabel: "Any concept",
      }),
    ).rejects.toThrow();
  });
});
