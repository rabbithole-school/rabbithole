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

// ── Fixtures (copied verbatim from rabbithole-testing.md) ────────────────────

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: {
    name?: string;
    username?: string;
    readingLevel?: string;
    image?: string;
  } = {},
) {
  const name = overrides.name ?? `Test ${role}`;
  const username = overrides.username ?? `test${role}`;
  if (role === "parent") {
    return t.run((ctx) => ctx.db.insert("users", { name, username, role }));
  }
  const institutionId = await seedTestInstitution(t);
  const userId = role === "scholar"
    ? await seedScholarInInstitution(t, { institutionId, name, username })
    : await seedStaffWithMembership(t, { institutionId, name, username });
  await t.run((ctx) => ctx.db.patch(userId, {
    readingLevel: overrides.readingLevel,
    image: overrides.image,
  }));
  return userId;
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

// A scholar-owned session to hang teach-backs off.
async function seedSession(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Test Session",
      isArchived: false,
    }),
  );
}

const RUBRIC = {
  completeness: 2,
  causalChain: 3,
  example: 1,
  handledProbes: 2,
  summary: "Solid causal account; example was thin.",
};

// ── start ────────────────────────────────────────────────────────────────────

describe("teachBacks.start", () => {
  test("creates exactly one active row for the session", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);

    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "why the moon has phases",
      }),
    );

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("teachBacks")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(id);
    expect(rows[0].status).toBe("active");
    expect(rows[0].conceptLabel).toBe("why the moon has phases");
    expect(rows[0].rubric).toBeUndefined();
  });

  test("a second start REUSES the active row — never a second active teach-back", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);

    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "first concept",
      }),
    );
    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "second concept",
      }),
    );

    // Same row reused, repointed at the new concept — one active, no orphan.
    expect(second).toBe(first);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("teachBacks")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].conceptLabel).toBe("second concept");

    // finish resolves deterministically to that single active row.
    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.finish, { sessionId }),
    );
    expect(result.ok && result.teachBackId).toBe(first);
  });

  test("deletes stray pre-existing active rows, keeping exactly one", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);

    // Two stray active rows (e.g. from an older bug) inserted directly.
    await t.run(async (ctx) => {
      await ctx.db.insert("teachBacks", {
        sessionId,
        scholarId: scholar,
        conceptLabel: "stray one",
        status: "active",
        createdAt: 1,
      });
      await ctx.db.insert("teachBacks", {
        sessionId,
        scholarId: scholar,
        conceptLabel: "stray two",
        status: "active",
        createdAt: 2,
      });
    });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "the real one",
      }),
    );

    const active = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("teachBacks")
          .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
          .collect()
      ).filter((r) => r.status === "active"),
    );
    expect(active).toHaveLength(1);
    expect(active[0].conceptLabel).toBe("the real one");
  });
});

// ── finish (schedules grading; infers the active one) ────────────────────────

describe("teachBacks.finish", () => {
  test("schedules the grading action for the session's active teach-back", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "regrouping",
      }),
    );

    // No explicit id → infers the active one.
    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.finish, { sessionId }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.teachBackId).toBe(id);

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("gradeTeachBack");
  });

  test("no active teach-back → ok:false, nothing scheduled", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);

    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.finish, { sessionId }),
    );
    expect(result.ok).toBe(false);
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });
});

// ── recordGrade (active → graded, writes the rubric) ─────────────────────────

describe("teachBacks.recordGrade", () => {
  test("transitions active → graded and writes the rubric", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "c",
      }),
    );

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.recordGrade, {
        teachBackId: id,
        rubric: RUBRIC,
      }),
    );

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("graded");
    expect(row?.rubric).toEqual(RUBRIC);
    expect(row?.gradedAt).toBeTypeOf("number");
  });

  test("is idempotent — a second recordGrade does not overwrite", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "c",
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.recordGrade, { teachBackId: id, rubric: RUBRIC }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.recordGrade, {
        teachBackId: id,
        rubric: { ...RUBRIC, completeness: 0, summary: "different" },
      }),
    );
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.rubric).toEqual(RUBRIC);
  });
});

// ── Teacher-gated reads (the rubric is TEACHER-ONLY) ─────────────────────────

describe("teachBacks.listForSession — teacher-gated", () => {
  test("a scholar (owner) CANNOT read teach-backs (rubric is teacher-only)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "c",
      }),
    );

    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.query(api.teachBacks.listForSession, { sessionId }),
    ).rejects.toThrow();
  });

  test("a parent WITH guardianship still CANNOT read teach-backs (rubric is teacher-only)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const parent = await seedUser(t, "parent", { username: "parent1" });
    const sessionId = await seedSession(t, scholar);
    // A real guardian link — proving even a legit guardian is gated out.
    await t.run(async (ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: parent,
        scholarUserId: scholar,
        createdBy: parent,
      }),
    );
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "c",
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.recordGrade, { teachBackId: id, rubric: RUBRIC }),
    );

    const asParent = await withUser(t, parent);
    await expect(
      asParent.query(api.teachBacks.listForSession, { sessionId }),
    ).rejects.toThrow();
  });

  test("a teacher reads teach-backs WITH the rubric", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const teacher = await seedUser(t, "teacher", { username: "teacher1" });
    const sessionId = await seedSession(t, scholar);
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "why the moon has phases",
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.recordGrade, { teachBackId: id, rubric: RUBRIC }),
    );

    const asTeacher = await withUser(t, teacher);
    const list = await asTeacher.query(api.teachBacks.listForSession, {
      sessionId,
    });
    expect(list).toHaveLength(1);
    expect(list[0].conceptLabel).toBe("why the moon has phases");
    expect(list[0].status).toBe("graded");
    expect(list[0].rubric).toEqual(RUBRIC);
    expect(list[0].teacherReviewed).toBe(false);
  });
});

describe("teachBacks.setReviewed — teacher-gated", () => {
  test("a scholar cannot toggle reviewed", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "c",
      }),
    );
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.teachBacks.setReviewed, { id, reviewed: true }),
    ).rejects.toThrow();
  });

  test("a parent WITH guardianship cannot toggle reviewed", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const parent = await seedUser(t, "parent", { username: "parent1" });
    const sessionId = await seedSession(t, scholar);
    await t.run(async (ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: parent,
        scholarUserId: scholar,
        createdBy: parent,
      }),
    );
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "c",
      }),
    );
    const asParent = await withUser(t, parent);
    await expect(
      asParent.mutation(api.teachBacks.setReviewed, { id, reviewed: true }),
    ).rejects.toThrow();
  });

  test("a teacher toggles reviewed on and off", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const teacher = await seedUser(t, "teacher", { username: "teacher1" });
    const sessionId = await seedSession(t, scholar);
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "c",
      }),
    );
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.teachBacks.setReviewed, { id, reviewed: true });
    expect(await t.run(async (ctx) => (await ctx.db.get(id))?.teacherReviewed)).toBe(
      true,
    );
    await asTeacher.mutation(api.teachBacks.setReviewed, { id, reviewed: false });
    expect(await t.run(async (ctx) => (await ctx.db.get(id))?.teacherReviewed)).toBe(
      false,
    );
  });
});

// ── Redaction: rubric-derived scores never reach scholar/parent mastery ──────
// The BLOCKER guard. Grading writes the rubric ONLY to the teacher-only
// teachBacks row — it must NOT create any masteryObservations row, because those
// carry masteryLevel/confidenceScore that scholar- and parent-facing reads
// return (masteryObservations.listForScholar, parents.childMastery).

describe("teach-back grading writes NO scholar/parent-readable mastery", () => {
  test("recordGrade touches only teachBacks — no masteryObservations row is created", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "why the moon has phases",
        nodeKey: "moon_phases",
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.recordGrade, { teachBackId: id, rubric: RUBRIC }),
    );

    // No mastery observation anywhere for this scholar.
    const masteryRows = await t.run(async (ctx) =>
      ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(masteryRows).toHaveLength(0);
  });

  test("the scholar's OWN mastery read surfaces nothing from a graded teach-back", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const sessionId = await seedSession(t, scholar);
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "why the moon has phases",
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.recordGrade, { teachBackId: id, rubric: RUBRIC }),
    );

    const asScholar = await withUser(t, scholar);
    const mastery = await asScholar.query(api.masteryObservations.listForScholar, {
      scholarId: scholar,
    });
    expect(mastery).toHaveLength(0);
    expect(
      mastery.some((m) => m.evidenceType === "teach_back"),
    ).toBe(false);
  });

  test("a parent's childMastery read exposes nothing from a graded teach-back", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const parent = await seedUser(t, "parent", { username: "parent1" });
    const sessionId = await seedSession(t, scholar);
    await t.run(async (ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: parent,
        scholarUserId: scholar,
        createdBy: parent,
      }),
    );
    const id = await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.start, {
        sessionId,
        scholarId: scholar,
        conceptLabel: "why the moon has phases",
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.teachBacks.recordGrade, { teachBackId: id, rubric: RUBRIC }),
    );

    const asParent = await withUser(t, parent);
    const childMastery = await asParent.query(api.parents.childMastery, {
      scholarId: scholar,
    });
    // No domain narrative mentions the teach-back concept (nothing leaked in).
    const blob = JSON.stringify(childMastery).toLowerCase();
    expect(blob).not.toContain("moon");
  });
});
