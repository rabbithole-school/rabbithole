import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
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
  role: "scholar" | "teacher" | "platform_admin" | "curriculum_designer" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const name = overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`);
  const username = overrides.username ?? (role === "scholar" ? "testscholar" : `test${role}`);
  if (role === "platform_admin" || role === "curriculum_designer") {
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

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

describe("standingPractice.create", () => {
  test("inserts a standing assignment with no unitId and shaped config", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      title: "Daily math",
      dailyGoalMinutes: 15,
      pinnedStrands: ["multiplication"],
    });

    const row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row).not.toBeNull();
    expect(row!.unitId).toBeUndefined();
    expect(row!.practiceMode).toBe("standing");
    expect(row!.activitySchedule).toEqual([]);
    expect(row!.practiceConfig?.domain).toBe(WHOLE_NUMBER_ARITHMETIC_DOMAIN);
    expect(row!.practiceConfig?.dailyGoalMinutes).toBe(15);
    expect(row!.practiceConfig?.pinnedStrands).toEqual(["multiplication"]);
  });

  test("defaults to the whole-number-arithmetic domain when omitted", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
    });
    const row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row!.practiceConfig?.domain).toBe(WHOLE_NUMBER_ARITHMETIC_DOMAIN);
  });

  test("persists a MIXED-domain set (≥2) and keeps `domain` = the primary", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      domains: ["fraction-arithmetic", "probability", "fraction-arithmetic"], // dupe on purpose
    });
    const row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    // Deduped, primary-first; `domain` mirrors the first for back-compat.
    expect(row!.practiceConfig?.domains).toEqual(["fraction-arithmetic", "probability"]);
    expect(row!.practiceConfig?.domain).toBe("fraction-arithmetic");
  });

  test("a MIXED-domain create DROPS pinned/excluded strands (single-domain notion, would leak)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      domains: ["fraction-arithmetic", "probability"],
      pinnedStrands: ["multiplication"],
      excludedStrands: ["long-division"],
    });
    const row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    // A strand names a strand within ONE graph; a blend spans several, so the
    // strand would wrongly filter every blended domain. It must not be stored.
    expect(row!.practiceConfig?.domains).toEqual(["fraction-arithmetic", "probability"]);
    expect(row!.practiceConfig?.pinnedStrands).toBeUndefined();
    expect(row!.practiceConfig?.excludedStrands).toBeUndefined();
  });

  test("a length-1 `domains` array is NOT persisted as a blend (stays single-domain shaped)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      domains: ["probability"],
    });
    const row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    // A single-domain assignment stays shaped exactly as before — no `domains`.
    expect(row!.practiceConfig?.domains).toBeUndefined();
    expect(row!.practiceConfig?.domain).toBe("probability");
  });

  test("rejects an empty roster", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.mutation(api.standingPractice.create, { scholarIds: [] }),
    ).rejects.toThrow();
  });

  test("blocks non-teachers (scholar-gated mutation)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const otherScholarId = await seedUser(t, "scholar", { username: "other" });
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.standingPractice.create, {
        scholarIds: [otherScholarId],
      }),
    ).rejects.toThrow();
  });
});

describe("standingPractice.updateConfig", () => {
  test("patches config fields and scopes to the owning teacher", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    const scholarId = await seedUser(t, "scholar");
    const asA = await withUser(t, teacherA);
    const asB = await withUser(t, teacherB);

    const assignmentId = await asA.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      dailyGoalMinutes: 10,
    });

    await asA.mutation(api.standingPractice.updateConfig, {
      assignmentId,
      dailyGoalMinutes: 20,
    });
    const row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row!.practiceConfig?.dailyGoalMinutes).toBe(20);

    await expect(
      asB.mutation(api.standingPractice.updateConfig, {
        assignmentId,
        dailyGoalMinutes: 99,
      }),
    ).rejects.toThrow();
  });

  test("switches a single-domain assignment INTO a mixed blend and back", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      domain: "whole-number-arithmetic",
    });

    // → mixed blend
    await asTeacher.mutation(api.standingPractice.updateConfig, {
      assignmentId,
      domains: ["whole-number-arithmetic", "fraction-arithmetic"],
    });
    let row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row!.practiceConfig?.domains).toEqual([
      "whole-number-arithmetic",
      "fraction-arithmetic",
    ]);
    expect(row!.practiceConfig?.domain).toBe("whole-number-arithmetic");

    // → back to a single domain (blend cleared)
    await asTeacher.mutation(api.standingPractice.updateConfig, {
      assignmentId,
      domain: "fraction-arithmetic",
    });
    row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row!.practiceConfig?.domains).toBeUndefined();
    expect(row!.practiceConfig?.domain).toBe("fraction-arithmetic");
  });

  test("switching a single-domain assignment INTO a blend CLEARS leftover strands (C1: no strand leak)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    // A single-domain assignment with a pinned + an excluded strand.
    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      domain: "whole-number-arithmetic",
      pinnedStrands: ["multiplication"],
      excludedStrands: ["long-division"],
    });
    let row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row!.practiceConfig?.pinnedStrands).toEqual(["multiplication"]);

    // Switch it into a blend WITHOUT resending strands — the leftover single-domain
    // strands must be dropped so they don't filter every blended domain.
    await asTeacher.mutation(api.standingPractice.updateConfig, {
      assignmentId,
      domains: ["whole-number-arithmetic", "fraction-arithmetic"],
    });
    row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row!.practiceConfig?.domains).toEqual([
      "whole-number-arithmetic",
      "fraction-arithmetic",
    ]);
    expect(row!.practiceConfig?.pinnedStrands).toBeUndefined();
    expect(row!.practiceConfig?.excludedStrands).toBeUndefined();

    // …and the scholar-facing read (which the practice page threads into the
    // session) reports NO strands to filter by for the blend.
    const asScholar = await withUser(t, scholarId);
    const standing = await asScholar.query(api.standingPractice.myActiveStanding, {});
    expect(standing!.domains).toEqual([
      "whole-number-arithmetic",
      "fraction-arithmetic",
    ]);
    expect(standing!.pinnedStrands).toEqual([]);
    expect(standing!.excludedStrands).toEqual([]);
  });

  test("a genuine single-domain assignment STILL honors its strand across a goal-only edit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      domain: "whole-number-arithmetic",
      pinnedStrands: ["multiplication"],
      excludedStrands: ["long-division"],
    });
    // An unrelated edit (daily goal) must not disturb the single-domain strands.
    await asTeacher.mutation(api.standingPractice.updateConfig, {
      assignmentId,
      dailyGoalMinutes: 20,
    });
    const row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row!.practiceConfig?.domains).toBeUndefined();
    expect(row!.practiceConfig?.pinnedStrands).toEqual(["multiplication"]);
    expect(row!.practiceConfig?.excludedStrands).toEqual(["long-division"]);

    const asScholar = await withUser(t, scholarId);
    const standing = await asScholar.query(api.standingPractice.myActiveStanding, {});
    expect(standing!.pinnedStrands).toEqual(["multiplication"]);
    expect(standing!.excludedStrands).toEqual(["long-division"]);
  });

  test("leaves the domain set untouched when neither domain nor domains is sent", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      domains: ["fraction-arithmetic", "probability"],
    });
    // A goal-only edit must not collapse the existing blend.
    await asTeacher.mutation(api.standingPractice.updateConfig, {
      assignmentId,
      dailyGoalMinutes: 25,
    });
    const row = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(row!.practiceConfig?.domains).toEqual(["fraction-arithmetic", "probability"]);
    expect(row!.practiceConfig?.dailyGoalMinutes).toBe(25);
  });
});

describe("standingPractice.listForTeacher / get", () => {
  test("lists only this teacher's standing assignments, excluding unit-mode ones", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const otherTeacherId = await seedUser(t, "teacher", { username: "other" });
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);
    const asOther = await withUser(t, otherTeacherId);

    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", { teacherId, title: "Unit", isActive: true }),
    );
    await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const standingId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      title: "Daily math",
    });
    await asOther.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
    });

    const rows = await asTeacher.query(api.standingPractice.listForTeacher, {});
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(String(standingId));
    expect(rows[0].title).toBe("Daily math");

    const single = await asTeacher.query(api.standingPractice.get, {
      assignmentId: standingId,
    });
    expect(single).not.toBeNull();
    expect(single!.scholars).toHaveLength(1);

    // Another teacher can't read it.
    const forbidden = await asOther.query(api.standingPractice.get, {
      assignmentId: standingId,
    });
    expect(forbidden).toBeNull();
  });

  test("excludes archived assignments unless includeArchived is set", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.archive, { assignmentId });

    const active = await asTeacher.query(api.standingPractice.listForTeacher, {});
    expect(active).toHaveLength(0);

    const all = await asTeacher.query(api.standingPractice.listForTeacher, {
      includeArchived: true,
    });
    expect(all).toHaveLength(1);
    expect(all[0].archivedAt).not.toBeNull();
  });
});

describe("standingPractice.myActiveStanding", () => {
  test("returns null when the scholar has no standing assignment", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.standingPractice.myActiveStanding, {});
    expect(result).toBeNull();
  });

  test("returns the scholar's own active standing assignment (self-serve)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      dailyGoalMinutes: 15,
      pinnedStrands: ["multiplication"],
    });

    const result = await asScholar.query(api.standingPractice.myActiveStanding, {});
    expect(result).not.toBeNull();
    expect(result!.dailyGoalMinutes).toBe(15);
    expect(result!.pinnedStrands).toEqual(["multiplication"]);
    expect(result!.domain).toBe(WHOLE_NUMBER_ARITHMETIC_DOMAIN);
    // A single-domain assignment still reports a one-element set for a uniform
    // reader shape (the mixed-playlist resolver reads `domains`).
    expect(result!.domains).toEqual([WHOLE_NUMBER_ARITHMETIC_DOMAIN]);
  });

  test("reports the full blended domain set for a mixed standing assignment", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      domains: ["fraction-arithmetic", "probability"],
    });

    const result = await asScholar.query(api.standingPractice.myActiveStanding, {});
    expect(result!.domains).toEqual(["fraction-arithmetic", "probability"]);
    expect(result!.domain).toBe("fraction-arithmetic");
  });

  test("a teacher may look up another scholar's standing assignment", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
    });

    const result = await asTeacher.query(api.standingPractice.myActiveStanding, {
      scholarId,
    });
    expect(result).not.toBeNull();
  });

  test("a scholar cannot look up another scholar's standing assignment", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const otherScholarId = await seedUser(t, "scholar", { username: "other" });
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, otherScholarId);

    await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
    });

    await expect(
      asScholar.query(api.standingPractice.myActiveStanding, { scholarId }),
    ).rejects.toThrow();
  });

  test("ignores an archived standing assignment", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.archive, { assignmentId });

    const result = await asScholar.query(api.standingPractice.myActiveStanding, {});
    expect(result).toBeNull();
  });
});

describe("standing rows flow through the shared assignments.* readers", () => {
  // A standing assignment (no unitId, practiceMode "standing") must pass
  // through every reader that historically assumed a unitId was present,
  // without crashing on the removed `a.unitId!` dereference and shaped right
  // (excluded from unit-only lists; unit fields null on per-assignment reads).
  test("does not crash the teacher-facing readers and is shaped correctly", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    // A real unit-mode assignment coexists so the "unit-only" lists have
    // something to keep while the standing row is filtered out.
    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", { teacherId, title: "Unit", isActive: true }),
    );
    await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const standingId = await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      title: "Daily math",
    });

    // Unit-only lists: standing row excluded, unit row kept, no crash.
    const teacherList = await asTeacher.query(api.assignments.listForTeacher, {});
    expect(teacherList.every((a) => String(a._id) !== String(standingId))).toBe(true);
    expect(teacherList).toHaveLength(1);

    const listForUnit = await asTeacher.query(api.assignments.listForUnit, { unitId });
    expect(listForUnit.every((a) => String(a._id) !== String(standingId))).toBe(true);

    const activePushes = await asTeacher.query(api.assignments.activePushesForTeacher, {});
    // Standing rows have no activitySchedule, so they contribute no pushes.
    expect(activePushes.every((p) => String(p.assignmentId) !== String(standingId))).toBe(true);

    const scheduleFeed = await asTeacher.query(api.assignments.scheduleForTeacher, {});
    expect(scheduleFeed.every((p) => String(p.assignmentId) !== String(standingId))).toBe(true);

    const recentlyArchived = await asTeacher.query(
      api.assignments.recentlyArchivedForTeacher,
      {},
    );
    expect(Array.isArray(recentlyArchived)).toBe(true);

    // Per-assignment reads on the standing row itself: no crash, unit null.
    const single = await asTeacher.query(api.assignments.get, {
      assignmentId: standingId,
    });
    expect(single).not.toBeNull();
    expect(single!.unitId ?? null).toBeNull();
    expect(single!.unitTitle).toBeNull();

    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId: standingId,
    });
    expect(progress).not.toBeNull();
    expect(progress!.lessons).toEqual([]);

    const forReview = await asTeacher.query(api.assignments.getForReview, {
      assignmentId: standingId,
    });
    expect(forReview).not.toBeNull();
    expect(forReview!.unitId ?? null).toBeNull();
  });

  test("does not crash the scholar-facing assignment lists", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await asTeacher.mutation(api.standingPractice.create, {
      scholarIds: [scholarId],
      title: "Daily math",
    });

    // A standing row targets the scholar but pushes no activities, so these
    // schedule-driven lists are empty rather than throwing on unitId.
    const classFocus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(classFocus).toEqual([]);

    const homework = await asScholar.query(api.assignments.homeworkForMe, {});
    expect(homework).toEqual([]);
  });
});

describe("standingPractice.domainStrands", () => {
  // Powers the teacher dialog's pinned/excluded strand pickers: distinct
  // strands present in a domain, in curriculum (`order`) order, deduped,
  // ignoring nodes with no strand.
  test("returns distinct strands in order, deduped, skipping strand-less nodes", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacherId);

    await t.run(async (ctx) => {
      const D = WHOLE_NUMBER_ARITHMETIC_DOMAIN;
      // Deliberately inserted out of `order` and with duplicate strands.
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "b1", label: "B1", domain: D, strand: "beta", order: 20,
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "a1", label: "A1", domain: D, strand: "alpha", order: 10,
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "a2", label: "A2", domain: D, strand: "alpha", order: 5,
      });
      // No strand → ignored.
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "n1", label: "N1", domain: D, order: 1,
      });
      // Different domain → ignored.
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "x1", label: "X1", domain: "other", strand: "zeta", order: 1,
      });
    });

    const result = await asTeacher.query(api.standingPractice.domainStrands, {});
    expect(result.domain).toBe(WHOLE_NUMBER_ARITHMETIC_DOMAIN);
    // alpha (min order 5) before beta (20); each strand once.
    expect(result.strands).toEqual(["alpha", "beta"]);
  });

  test("is teacher-gated", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.standingPractice.domainStrands, {}),
    ).rejects.toThrow();
  });
});
