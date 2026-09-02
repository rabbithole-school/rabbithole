import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedOperationsStaff,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: "operations staff" (base `staff` role + the
// `school:operations` capability grant — the retired `registrar` role's
// successor) exists to have EXACTLY the scholar-admin powers
// (create/administer accounts, manage portfolios) and nothing else — no
// sensitive learning data, no curriculum, no admin. The capability split is
// enforced by which custom-function gate each handler uses
// (scholarAdminQuery/Mutation vs teacherQuery vs curriculumMutation vs
// platformAdminMutation). These tests pin both halves: what operations staff
// CAN reach, and — more importantly — what they CANNOT.
// A silent gate regression here would either lock operations staff out of
// their job or leak a scholar's assessments to them.

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "curriculum_designer"
  | "staff"
  | "operations_staff";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
) {
  if (role === "platform_admin" || role === "curriculum_designer") {
    return t.run((ctx) => ctx.db.insert("users", { name: `Test ${username}`, username, role }));
  }
  const institutionId = await seedTestInstitution(t);
  if (role === "scholar") {
    return seedScholarInInstitution(t, { institutionId, name: `Test ${username}`, username });
  }
  if (role === "operations_staff") {
    return seedOperationsStaff(t, { institutionId, name: `Test ${username}`, username });
  }
  return seedStaffWithMembership(t, { institutionId, name: `Test ${username}`, username, role });
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

// ── What operations staff CAN do (account admin + portfolio) ─────────

describe("operations staff — allowed: account administration", () => {
  test("can create a scholar", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const asReg = await withUser(t, reg);
    const { userId } = await asReg.mutation(api.users.createScholar, {
      name: "New Kid",
    });
    const created = await t.run(async (ctx) => ctx.db.get(userId));
    expect(created?.role).toBe("scholar");
  });

  test("can list the scholar roster", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    const roster = await asReg.query(api.users.listScholars, {});
    expect(roster.length).toBe(1);
    // Learning data must be stripped from operations staff's roster view.
    expect(roster[0].pulseScore).toBeNull();
    expect(roster[0].statusSummary).toBeNull();
    expect(roster[0].lastMessage).toBeNull();
    expect(roster[0].readingLevel).toBeNull();
  });

  test("can edit a scholar's basic profile", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await asReg.mutation(api.users.adminUpdateScholarProfile, {
      scholarId: kai,
      name: "Kai Renamed",
    });
    const updated = await t.run(async (ctx) => ctx.db.get(kai));
    expect(updated?.name).toBe("Kai Renamed");
  });

  test("can read a scholar's (non-sensitive) profile", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    const profile = await asReg.query(api.scholars.getProfile, {
      scholarId: kai,
    });
    expect(profile.scholar.id).toBe(kai);
  });

  test("can list a scholar's portfolio", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    const items = await asReg.query(api.portfolio.listForScholar, {
      scholarId: kai,
    });
    expect(items).toEqual([]);
  });

  // The roster page (ScholarHome -> useScholarRoster) loads these on mount;
  // they must NOT 403 for operations staff or the whole Scholars tab dies.
  test("can read scholar groups (roster org data)", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const asReg = await withUser(t, reg);
    const groups = await asReg.query(api.scholarGroups.list, {});
    expect(Array.isArray(groups)).toBe(true);
  });

  test("can read + toggle own scholar affinities", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    const mine = await asReg.query(api.teacherAffinities.getMine, {});
    expect(mine).toHaveProperty("scholarIds");
    // toggle must not throw for operations staff
    await asReg.mutation(api.teacherAffinities.toggleScholar, { scholarId: kai });
  });

  // The chat surface (CurriculumAssistant) loads listSessions on mount.
  test("can list assistant chat sessions (chat surface loads)", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const asReg = await withUser(t, reg);
    const sessions = await asReg.query(api.curriculumAssistant.listSessions, {});
    expect(Array.isArray(sessions)).toBe(true);
  });
});

describe("Staff school-operations capability", () => {
  test("denies base Staff and preserves the operations-staff redaction boundary when granted", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const staff = await seedStaffWithMembership(t, {
      institutionId,
      role: "staff",
      username: "operations-staff",
    });
    await seedScholarInInstitution(t, {
      institutionId,
      name: "Kai",
      username: "kai",
    });
    const asStaff = await withUser(t, staff);

    await expect(asStaff.query(api.users.listScholars, {})).rejects.toThrow(
      /scholar-admin/i,
    );

    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: staff,
        institutionId,
        capability: "school:operations",
        grantedBy: staff,
        grantedAt: Date.now(),
      });
    });
    const roster = await asStaff.query(api.users.listScholars, {});
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      readingLevel: null,
      pulseScore: null,
      statusSummary: null,
      lastMessage: null,
    });
    await expect(
      asStaff.query(api.masteryObservations.listForScholar, {
        scholarId: roster[0].id,
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("an operations grant never crosses institutions", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedTestInstitution(t, {
      name: "School A",
      slug: "school-a",
      isPrimary: true,
    });
    const schoolB = await seedTestInstitution(t, {
      name: "School B",
      slug: "school-b",
    });
    const staff = await seedStaffWithMembership(t, {
      institutionId: schoolA,
      role: "staff",
      username: "multi-school-staff",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userId: staff,
        institutionId: schoolB,
        role: "staff",
      });
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: staff,
        institutionId: schoolA,
        capability: "school:operations",
        grantedBy: staff,
        grantedAt: Date.now(),
      });
    });
    const scholarA = await seedScholarInInstitution(t, {
      institutionId: schoolA,
      name: "Scholar A",
      username: "scholar-a",
    });
    const scholarB = await seedScholarInInstitution(t, {
      institutionId: schoolB,
      name: "Scholar B",
      username: "scholar-b",
    });
    const { assignmentA } = await t.run(async (ctx) => {
      const groupA = await ctx.db.insert("scholarGroups", {
        teacherId: staff,
        institutionId: schoolA,
        name: "School A group",
        scholarIds: [scholarA],
      });
      const groupB = await ctx.db.insert("scholarGroups", {
        teacherId: staff,
        institutionId: schoolB,
        name: "School B group",
        scholarIds: [scholarB],
      });
      const assignmentA = await ctx.db.insert("assignments", {
        teacherId: staff,
        scholarIds: [scholarA],
        scholarGroupId: groupA,
        title: "School A assignment",
        startedAt: Date.now(),
      });
      await ctx.db.insert("assignments", {
        teacherId: staff,
        scholarIds: [scholarB],
        scholarGroupId: groupB,
        title: "School B assignment",
        startedAt: Date.now(),
      });
      return { assignmentA };
    });

    const asStaff = await withUser(t, staff);
    const roster = await asStaff.query(api.users.listScholars, {
      institutionScope: "all",
    });
    expect(roster.map((scholar) => scholar.username)).toEqual(["scholar-a"]);
    const assignments = await asStaff.query(
      api.portfolio.listAssignmentsForPicker,
      {},
    );
    expect(assignments.map((assignment) => assignment.id)).toEqual([
      assignmentA,
    ]);
    await expect(
      asStaff.mutation(api.curriculumAssistant.createChat, {
        scholarId: scholarB,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      asStaff.mutation(api.curriculumAssistant.createChat, {
        scholarId: scholarA,
      }),
    ).resolves.toBeTruthy();
  });
});

// ── What operations staff CANNOT do (sensitive data) ─────────────────

describe("operations staff — denied: sensitive scholar data", () => {
  test("CANNOT read sensitive documents (assessments/IEPs)", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.query(api.scholarDocuments.listForScholar, { scholarId: kai }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT read mastery observations", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.query(api.masteryObservations.listForScholar, { scholarId: kai }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT read a scholar's dossier", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.query(api.dossier.getForTeacher, { scholarId: kai }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT read teacher observations", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.query(api.observations.listByScholar, { scholarId: kai }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT change a scholar's reading level (a measurement)", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.scholars.updateReadingLevel, {
        scholarId: kai,
        readingLevel: "5",
      }),
    ).rejects.toThrow("Forbidden");
  });
});

// ── What operations staff CANNOT do (curriculum + admin) ────────────

describe("operations staff — denied: curriculum + admin", () => {
  test("CANNOT create curriculum (a persona)", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.personas.create, { title: "X", emoji: "🤖" }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT change user roles", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.users.updateRole, { userId: kai, role: "teacher" }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT delete users", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.users.deleteUser, { userId: kai }),
    ).rejects.toThrow("Forbidden");
  });
});

// ── Regression: re-gating must NOT have locked teachers out ───────────

describe("teacher still has scholar-admin powers after re-gating", () => {
  test("teacher can still create a scholar + list the roster (with data)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    await seedUser(t, "scholar", "kai");
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.users.createScholar, { name: "Another Kid" });
    const roster = await asTeacher.query(api.users.listScholars, {});
    // Teacher sees the unredacted roster shape (fields present, not stripped).
    expect(roster.length).toBeGreaterThanOrEqual(1);
    expect(roster[0]).toHaveProperty("pulseScore");
  });
});

// ── Sensitive-data leak fixes (post-#70 security review) ──────────────
// #70 redacted sensitive scholar data at the roster surface + the UI but
// left several SERVER read paths open to operations staff making direct calls.
// These pin the data-layer redaction so the next reader can't re-leak.

async function seedScholarWithLearningData(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  const scholarId = await seedScholarInInstitution(t, {
    institutionId: await seedTestInstitution(t),
    name: `Test ${username}`,
    username,
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(scholarId, {
      readingLevel: "5",
      readingLevelSuggestion: "6",
    });
    await ctx.db.insert("scholarDossiers", {
      scholarId,
      content: "TOP SECRET dossier content",
    });
  });
  return scholarId;
}

describe("operations staff — reading level redacted on direct reads", () => {
  test("getProfile nulls readingLevel/suggestion for operations staff", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedScholarWithLearningData(t, "kai");
    const asReg = await withUser(t, reg);
    const profile = await asReg.query(api.scholars.getProfile, { scholarId: kai });
    expect(profile.scholar.readingLevel).toBeNull();
    expect(profile.scholar.readingLevelSuggestion).toBeNull();
  });

  test("getProfile still returns readingLevel for a teacher", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const kai = await seedScholarWithLearningData(t, "kai");
    const asTeacher = await withUser(t, teacher);
    const profile = await asTeacher.query(api.scholars.getProfile, { scholarId: kai });
    expect(profile.scholar.readingLevel).toBe("5");
  });
});

describe("operations staff — curriculum-aide context never pre-loads scholar data", () => {
  test("getContext returns null scholarContext for an operations-staff caller", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedScholarWithLearningData(t, "kai");
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getContext, {
        teacherId: reg,
        scholarId: kai,
      }),
    );
    expect(context.scholarContext).toBeNull();
  });

  test("getContext still loads scholarContext for a teacher caller", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const kai = await seedScholarWithLearningData(t, "kai");
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getContext, {
        teacherId: teacher,
        scholarId: kai,
      }),
    );
    expect(context.scholarContext?.dossier).toContain("TOP SECRET");
  });
});

describe("getContextForChat — ownership + operations-staff redaction", () => {
  async function seedSession(
    t: ReturnType<typeof convexTest>,
    ownerId: Id<"users">,
    scholarId?: Id<"users">,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("chats", {
        teacherId: ownerId,
        title: "chat",
        scholarId,
        pinned: false,
        lastMessageAt: Date.now(),
      }),
    );
  }

  test("a non-owner non-admin caller gets null (no cross-staff disclosure)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher", "owner");
    const other = await seedUser(t, "teacher", "other");
    const kai = await seedScholarWithLearningData(t, "kai");
    const sessionId = await seedSession(t, owner, kai);
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getContextForChat, {
        sessionId,
        callerUserId: other,
      }),
    );
    expect(context).toBeNull();
  });

  test("the owning teacher gets the scholar context", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher", "owner");
    const kai = await seedScholarWithLearningData(t, "kai");
    const sessionId = await seedSession(t, owner, kai);
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getContextForChat, {
        sessionId,
        callerUserId: owner,
      }),
    );
    expect(context?.scholarContext?.dossier).toContain("TOP SECRET");
  });

  test("operations staff gets null scholarContext even on a session they own", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedScholarWithLearningData(t, "kai");
    const sessionId = await seedSession(t, reg, kai);
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getContextForChat, {
        sessionId,
        callerUserId: reg,
      }),
    );
    expect(context).not.toBeNull();
    expect(context?.scholarContext).toBeNull();
  });

  test("operations Staff gets null scholarContext even on a session they own", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const staff = await seedStaffWithMembership(t, {
      institutionId,
      role: "staff",
      username: "operations-staff",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: staff,
        institutionId,
        capability: "school:operations",
        grantedBy: staff,
        grantedAt: Date.now(),
      });
    });
    const kai = await seedScholarWithLearningData(t, "kai");
    const sessionId = await seedSession(t, staff, kai);
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getContextForChat, {
        sessionId,
        callerUserId: staff,
      }),
    );
    expect(context).not.toBeNull();
    expect(context?.scholarContext).toBeNull();
  });
});

describe("adminUpdateScholarProfile — name cannot be blanked", () => {
  test("an empty name is rejected (no accidental wipe)", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.users.adminUpdateScholarProfile, {
        scholarId: kai,
        name: "   ",
      }),
    ).rejects.toThrow("empty");
    const unchanged = await t.run(async (ctx) => ctx.db.get(kai));
    expect(unchanged?.name).toBe("Test kai");
  });
});

describe("scholar gradeLevel — the chronological-grade notch", () => {
  test("a scholar-admin can set, read back, and clear the grade", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);

    await asReg.mutation(api.users.adminUpdateScholarProfile, {
      scholarId: kai,
      gradeLevel: "3",
    });
    // Surfaced (un-redacted) on the profile read the UI uses.
    const profile = await asReg.query(api.scholars.getProfile, { scholarId: kai });
    expect(profile.scholar.gradeLevel).toBe("3");

    // null clears the notch.
    await asReg.mutation(api.users.adminUpdateScholarProfile, {
      scholarId: kai,
      gradeLevel: null,
    });
    const cleared = await t.run(async (ctx) => ctx.db.get(kai));
    expect(cleared?.gradeLevel).toBeUndefined();
  });

  test("an out-of-range grade is rejected (must match a notch column)", async () => {
    const t = convexTest(schema, modules);
    const reg = await seedUser(t, "operations_staff", "reg");
    const kai = await seedUser(t, "scholar", "kai");
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.users.adminUpdateScholarProfile, {
        scholarId: kai,
        gradeLevel: "13",
      }),
    ).rejects.toThrow("Invalid grade level");
  });

  test("the internal backfill setter sets and validates the grade", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    await t.mutation(internal.scholars.setGradeLevelInternal, {
      scholarId: kai,
      gradeLevel: "4",
    });
    const updated = await t.run(async (ctx) => ctx.db.get(kai));
    expect(updated?.gradeLevel).toBe("4");
    await expect(
      t.mutation(internal.scholars.setGradeLevelInternal, {
        scholarId: kai,
        gradeLevel: "nope",
      }),
    ).rejects.toThrow("Invalid grade level");
  });
});

// ── A plain scholar is still locked out of account administration ─────

describe("scholar cannot administer accounts", () => {
  test("scholar CANNOT list the roster", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const asKai = await withUser(t, kai);
    await expect(asKai.query(api.users.listScholars, {})).rejects.toThrow(
      "Forbidden",
    );
  });

  test("scholar CANNOT create a scholar", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const asKai = await withUser(t, kai);
    await expect(
      asKai.mutation(api.users.createScholar, { name: "Nope" }),
    ).rejects.toThrow("Forbidden");
  });
});
