import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  classSubjectKey,
  linkedAssignmentIdsForClass,
  formatMeetingSummary,
} from "../lib/classResolver";

/**
 * The CLASS resolver (convex/lib/classResolver.ts + convex/classResolver.ts) —
 * the primitive behind class-scoped schedule surfaces (listGroupClasses).
 * Pure match/dedupe is unit-tested directly; resolveClass + listGroupClasses
 * are exercised through convex-test. (The class-scoped Class Digest engine leg
 * was retired; only the resolver + its schedule surfaces remain.)
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 86_400_000;

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "teacher",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username:
        overrides.username ??
        `test-${role}-${Math.random().toString(36).slice(2)}`,
      role,
    }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedPeriod(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: Date.now(),
      endsAt: Date.now() + 90 * DAY,
      status: "open",
    }),
  );
}

async function seedBlock(
  t: ReturnType<typeof convexTest>,
  periodId: Id<"reportingPeriods">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "blockA",
      label: "Block A",
      startLocal: "08:30",
      endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
      kind: "class",
    }),
  );
}

async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  scholarIds: Id<"users">[] = [],
) {
  const unitId = await t.run(async (ctx) =>
    ctx.db.insert("units", { teacherId, title: "U", isActive: true }),
  );
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds,
      startedAt: Date.now(),
      activitySchedule: [],
    }),
  );
}

// ── Pure helpers ─────────────────────────────────────────────────────────

describe("classResolver pure helpers", () => {
  test("classSubjectKey trims + lowercases", () => {
    expect(classSubjectKey("Humanities")).toBe("humanities");
    expect(classSubjectKey("  Humanities ")).toBe("humanities");
    expect(classSubjectKey("MATH Workshop")).toBe("math workshop");
  });

  test("linkedAssignmentIdsForClass dedupes, matches subject case-insensitively, filters group", () => {
    const ids = linkedAssignmentIdsForClass({
      placements: [
        { groupId: "g1", subject: "Humanities", assignmentId: "a1" },
        // same class, different casing/whitespace → same key, dedupe a1
        { groupId: "g1", subject: "humanities ", assignmentId: "a1" },
        // same class, a second assignment
        { groupId: "g1", subject: "Humanities", assignmentId: "a2" },
        // no assignment → skipped
        { groupId: "g1", subject: "Humanities", assignmentId: null },
        // different subject → excluded
        { groupId: "g1", subject: "Math", assignmentId: "a3" },
        // different group → excluded
        { groupId: "g2", subject: "Humanities", assignmentId: "a4" },
      ],
      groupId: "g1",
      subject: "Humanities",
    });
    // first-seen order, deduped
    expect(ids).toEqual(["a1", "a2"]);
  });

  test("formatMeetingSummary joins weekday short names", () => {
    expect(formatMeetingSummary([1, 3, 5])).toBe("Mon · Wed · Fri");
    expect(formatMeetingSummary([2])).toBe("Tue");
    expect(formatMeetingSummary([])).toBe("");
  });
});

// ── resolveClass (DB) ──────────────────────────────────────────────────────

describe("resolveClass", () => {
  test("returns the group roster + distinct linked assignments, most-recent first", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const s1 = await seedUser(t, "scholar");
    const s2 = await seedUser(t, "scholar");
    const otherGroupScholar = await seedUser(t, "scholar");
    const periodId = await seedPeriod(t);
    const blockId = await seedBlock(t, periodId);

    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Kōlea",
        emoji: "🐦",
        scholarIds: [s1, s2],
      }),
    );
    const otherGroupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Other",
        scholarIds: [otherGroupScholar],
      }),
    );

    // A created first, then B — so recency order is [B, A].
    const assignmentA = await seedAssignment(t, teacher, [s1, s2]);
    const assignmentB = await seedAssignment(t, teacher, [s1, s2]);
    const assignmentC = await seedAssignment(t, teacher, []);
    const assignmentD = await seedAssignment(t, teacher, []);

    await t.run(async (ctx) => {
      // Two recurring Humanities meetings → both link A.
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "Humanities",
        assignmentId: assignmentA,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 3,
        blockId,
        subject: "Humanities",
        assignmentId: assignmentA,
      });
      // A concrete week-stamped Humanities row (different case) → links B.
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "humanities ",
        assignmentId: assignmentB,
        weekStartMs: Date.now(),
      });
      // Different subject → excluded from Humanities.
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 2,
        blockId,
        subject: "Math Workshop",
        assignmentId: assignmentC,
      });
      // Different group, same subject → excluded.
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: otherGroupId,
        weekday: 1,
        blockId,
        subject: "Humanities",
        assignmentId: assignmentD,
      });
    });

    const resolved = await t.run((ctx) =>
      ctx.runQuery(internal.classResolver.resolveClassInternal, {
        groupId,
        subject: "Humanities",
        periodId,
      }),
    );
    expect(resolved.scholarIds.map(String).sort()).toEqual(
      [s1, s2].map(String).sort(),
    );
    expect(resolved.assignmentIds).toEqual([assignmentB, assignmentA]);
  });

  test("empty group / no linked work → empty sets", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const blockId = await seedBlock(t, periodId);
    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Empty",
        scholarIds: [],
      }),
    );
    // A bare recurring class row (no linked assignment).
    await t.run(async (ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "Art",
      }),
    );
    const resolved = await t.run((ctx) =>
      ctx.runQuery(internal.classResolver.resolveClassInternal, {
        groupId,
        subject: "Art",
        periodId,
      }),
    );
    expect(resolved.scholarIds).toEqual([]);
    expect(resolved.assignmentIds).toEqual([]);
  });
});

// ── listGroupClasses ───────────────────────────────────────────────────────

describe("listGroupClasses", () => {
  test("lists the group's distinct classes with meeting-pattern summary", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const blockId = await seedBlock(t, periodId);
    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Kōlea",
        emoji: "🐦",
        scholarIds: [],
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "Humanities",
        teacherId: teacher,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 3,
        blockId,
        subject: "Humanities",
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 2,
        blockId,
        subject: "Math Workshop",
      });
      // A shelf row (no day) is NOT a recurring meeting → not its own class.
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Guest speaker",
      });
    });

    const asTeacher = await asUser(t, teacher);
    const res = await asTeacher.query(api.classResolver.listGroupClasses, {
      groupId,
      periodId,
    });
    expect(res.periodId).toBe(periodId);
    const humanities = res.classes.find((c) => c.subjectKey === "humanities");
    const math = res.classes.find((c) => c.subjectKey === "math workshop");
    expect(humanities).toBeTruthy();
    expect(humanities!.subject).toBe("Humanities");
    expect(humanities!.weekdays).toEqual([1, 3]);
    expect(humanities!.meetingSummary).toBe("Mon · Wed");
    expect(humanities!.teacherName).toBe("Test teacher");
    expect(math!.weekdays).toEqual([2]);
    // A dayless (shelf) subject is not surfaced as a class.
    expect(res.classes.some((c) => c.subjectKey === "guest speaker")).toBe(
      false,
    );
  });
});

// ── Fix 1: institution access boundary ─────────────────────────────────────
// listGroupClasses is a GROUP-keyed staff surface with no owning assignment to
// gate on. It must enforce the same institution boundary the cohort/roster
// reads do: a teacher from institution A must never enumerate institution B's
// classes via a bare groupId.

describe("listGroupClasses institution boundary", () => {
  async function seedInstitution(
    t: ReturnType<typeof convexTest>,
    slug: string,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("institutions", { name: slug, slug, kind: "school" }),
    );
  }

  async function seedScholarIn(
    t: ReturnType<typeof convexTest>,
    institutionId: Id<"institutions">,
    username: string,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: username,
        username,
        role: "scholar",
        institutionId,
      }),
    );
  }

  // A teacher whose STAFF MEMBERSHIP is in `institutionId` (the boundary reads
  // the membership's institution, not users.institutionId).
  async function seedTeacherIn(
    t: ReturnType<typeof convexTest>,
    institutionId: Id<"institutions">,
    username: string,
  ) {
    const teacher = await seedUser(t, "teacher", { username });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: teacher,
        role: "teacher",
        institutionId,
      }),
    );
    return teacher;
  }

  // Institution B owns a group (its own scholars) with one class linking an
  // assignment, so all three surfaces have something to (wrongly) return.
  async function seedForeignClass(t: ReturnType<typeof convexTest>) {
    const instB = await seedInstitution(t, "school-b");
    const teacherB = await seedTeacherIn(
      t,
      instB,
      `teacherB-${Math.random().toString(36).slice(2)}`,
    );
    const s1 = await seedScholarIn(t, instB, `b1-${Math.random().toString(36).slice(2)}`);
    const s2 = await seedScholarIn(t, instB, `b2-${Math.random().toString(36).slice(2)}`);
    const periodId = await seedPeriod(t);
    const blockId = await seedBlock(t, periodId);
    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacherB,
        name: "B-group",
        scholarIds: [s1, s2],
      }),
    );
    const assignmentId = await seedAssignment(t, teacherB, [s1, s2]);
    await t.run(async (ctx) => {
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "Humanities",
        assignmentId,
      });
      await ctx.db.insert("sessions", {
        userId: s1,
        assignmentId,
        title: "S1",
        isArchived: false,
        isOffline: false,
        lastMessageAt: Date.now(),
      });
    });
    return { instB, teacherB, s1, s2, periodId, blockId, groupId, assignmentId };
  }

  test("a foreign teacher is REJECTED from listGroupClasses", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const teacherA = await seedTeacherIn(t, instA, "teacherA");
    const foreign = await seedForeignClass(t);
    const asA = await asUser(t, teacherA);

    await expect(
      asA.query(api.classResolver.listGroupClasses, {
        groupId: foreign.groupId,
        periodId: foreign.periodId,
      }),
    ).rejects.toThrow(/context|forbidden/i);
  });

  test("a same-institution teacher CAN use listGroupClasses", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const teacherA = await seedTeacherIn(t, instA, "teacherA");
    const s1 = await seedScholarIn(t, instA, "a1");
    const periodId = await seedPeriod(t);
    const blockId = await seedBlock(t, periodId);
    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacherA,
        name: "A-group",
        scholarIds: [s1],
      }),
    );
    const assignmentId = await seedAssignment(t, teacherA, [s1]);
    await t.run(async (ctx) => {
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "Humanities",
        assignmentId,
      });
      await ctx.db.insert("sessions", {
        userId: s1,
        assignmentId,
        title: "S1",
        isArchived: false,
        isOffline: false,
        lastMessageAt: Date.now(),
      });
    });
    const asA = await asUser(t, teacherA);

    const list = await asA.query(api.classResolver.listGroupClasses, {
      groupId,
      periodId,
    });
    expect(list.classes.some((c) => c.subjectKey === "humanities")).toBe(true);
  });
});
