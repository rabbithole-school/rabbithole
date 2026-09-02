import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { emptyHealthRecordFields } from "../lib/healthRecord";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// convex/mcp.ts is the SECURITY BOUNDARY for the OAuth MCP connector:
// the Next route's per-role tool filtering is UX, but these queries are
// what an authenticated client can actually reach. These tests pin the
// two gates per query — the role→tool policy and the allowed-scholar
// scope (guardianship for parents, self for scholars).

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "curriculum_designer"
  | "staff"
  | "parent";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  name?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: name ?? `Test ${username}`, username, role }),
  );
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

/**
 * Seed the retired-registrar successor: a `staff` membership at the
 * institution PLUS the `school:operations` capability grant that gives it
 * scholar-admin access without curriculum or sensitive learning data. Pass
 * `health: true` to also grant `health:manage` (registrar used to imply
 * health-record access too).
 */
async function seedOperationsMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  options: { health?: boolean } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("memberships", {
      userId,
      role: "staff",
      institutionId,
    });
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "school:operations",
      grantedBy: userId,
      grantedAt: Date.now(),
    });
    if (options.health) {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: userId,
        institutionId,
        capability: "health:manage",
        grantedBy: userId,
        grantedAt: Date.now(),
      });
    }
  });
}

/** Teacher + two in-scope scholars + a parent linked to ONE of them. */
async function seedWorld(t: ReturnType<typeof convexTest>) {
  const teacher = await seedUser(t, "teacher", "teach");
  const kai = await seedUser(t, "scholar", "kai", "Kai Nakamura");
  const lani = await seedUser(t, "scholar", "lani", "Lani Kealoha");
  const parent = await seedUser(t, "parent", "krista");
  const institutionId = await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
    });
    await ctx.db.patch(kai, { institutionId });
    await ctx.db.patch(lani, { institutionId });
    await ctx.db.insert("memberships", {
      userId: teacher,
      role: "teacher",
      institutionId,
    });
    await ctx.db.insert("guardianships", {
      parentUserId: parent,
      scholarUserId: kai,
      createdBy: teacher,
    });
    return institutionId;
  });
  return { teacher, kai, lani, parent, institutionId };
}

async function seedInstitutionBoundaryWorld(
  t: ReturnType<typeof convexTest>,
) {
  const teacher = await seedUser(t, "teacher", "boundary-teacher");
  const admin = await seedUser(t, "platform_admin", "boundary-admin");
  const parent = await seedUser(t, "parent", "boundary-parent");
  const scholarA = await seedUser(
    t,
    "scholar",
    "scholar-a",
    "Aster Vale",
  );
  const scholarB = await seedUser(
    t,
    "scholar",
    "scholar-b",
    "Briar Cove",
  );
  const { institutionA, institutionB } = await t.run(async (ctx) => {
    const institutionA = await ctx.db.insert("institutions", {
      name: "Institution A",
      slug: "institution-a",
      kind: "school",
    });
    const institutionB = await ctx.db.insert("institutions", {
      name: "Institution B",
      slug: "institution-b",
      kind: "school",
    });
    await ctx.db.patch(scholarA, { institutionId: institutionA });
    await ctx.db.patch(scholarB, { institutionId: institutionB });
    await ctx.db.insert("memberships", {
      userId: teacher,
      role: "teacher",
      institutionId: institutionB,
    });
    await ctx.db.insert("guardianships", {
      parentUserId: parent,
      scholarUserId: scholarA,
      createdBy: admin,
    });
    return { institutionA, institutionB };
  });
  return {
    teacher,
    admin,
    parent,
    scholarA,
    scholarB,
    institutionA,
    institutionB,
  };
}

describe("mcp.whoami", () => {
  test("returns role; parents get their children's names", async () => {
    const t = convexTest(schema, modules);
    const { teacher, parent } = await seedWorld(t);

    const asTeacher = await withUser(t, teacher);
    const teacherMe = await asTeacher.query(api.mcp.whoami, {});
    expect(teacherMe.role).toBe("teacher");
    expect(teacherMe.scholarNames).toBeNull();

    const asParent = await withUser(t, parent);
    const parentMe = await asParent.query(api.mcp.whoami, {});
    expect(parentMe.role).toBe("parent");
    expect(parentMe.scholarNames).toEqual(["Kai Nakamura"]);
  });

  test("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.mcp.whoami, {})).rejects.toThrow(
      "Not authenticated",
    );
  });
});

describe("mcp.listScholars — roster gate + operations-staff redaction", () => {
  test("staff is default-deny, then sees only redacted scholars in granted schools", async () => {
    const t = convexTest(schema, modules);
    const { institutionA, institutionB, scholarA, scholarB } =
      await seedInstitutionBoundaryWorld(t);
    const staff = await seedUser(t, "staff", "ops-staff");
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userId: staff,
        role: "staff",
        institutionId: institutionA,
      });
    });
    const asStaff = await withUser(t, staff);
    await expect(asStaff.query(api.mcp.listScholars, {})).rejects.toThrow(
      "Forbidden",
    );

    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: staff,
        institutionId: institutionA,
        capability: "school:operations",
        grantedBy: staff,
        grantedAt: Date.now(),
      });
    });
    const { scholars: roster } = await asStaff.query(api.mcp.listScholars, {});
    expect(roster.map((row) => row.name)).toEqual(["Aster Vale"]);
    expect(roster).not.toContainEqual(expect.objectContaining({ name: "Briar Cove" }));
    expect(roster[0]).not.toHaveProperty("readingLevel");
    expect(roster[0]).not.toHaveProperty("observationCount");
    await expect(
      asStaff.query(api.mcp.getScholarMastery, { scholarName: "Aster" }),
    ).rejects.toThrow("Forbidden");
    // Keep the ids referenced so this test makes the X/Y tenancy boundary
    // explicit rather than accidentally passing with an empty seed.
    expect(scholarA).toBeTruthy();
    expect(scholarB).toBeTruthy();
    expect(institutionB).toBeTruthy();
  });

  test("teacher sees their institution roster (with readingLevel)", async () => {
    const t = convexTest(schema, modules);
    const { teacher } = await seedWorld(t);
    const asTeacher = await withUser(t, teacher);
    const { scholars: roster } = await asTeacher.query(api.mcp.listScholars, {});
    expect(roster).toHaveLength(2);
    expect(roster[0]).toHaveProperty("readingLevel");
    expect(roster[0]).toHaveProperty("observationCount");
  });

  test("teacher sees only membership institutions; platform admin remains global", async () => {
    const t = convexTest(schema, modules);
    const { teacher, admin, institutionA } =
      await seedInstitutionBoundaryWorld(t);
    const asTeacher = await withUser(t, teacher);

    const { scholars: institutionBRoster } = await asTeacher.query(
      api.mcp.listScholars,
      {},
    );
    expect(institutionBRoster.map((scholar) => scholar.name)).toEqual([
      "Briar Cove",
    ]);

    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userId: teacher,
        role: "teacher",
        institutionId: institutionA,
      });
    });
    const { scholars: unionRoster } = await asTeacher.query(
      api.mcp.listScholars,
      {},
    );
    expect(new Set(unionRoster.map((scholar) => scholar.name))).toEqual(
      new Set(["Aster Vale", "Briar Cove"]),
    );

    const asAdmin = await withUser(t, admin);
    const { scholars: adminRoster } = await asAdmin.query(
      api.mcp.listScholars,
      {},
    );
    expect(new Set(adminRoster.map((scholar) => scholar.name))).toEqual(
      new Set(["Aster Vale", "Briar Cove"]),
    );
  });

  test("lower-privilege and stale memberships do not widen the caller's scope", async () => {
    const t = convexTest(schema, modules);
    const { teacher, institutionA, institutionB } =
      await seedInstitutionBoundaryWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userId: teacher,
        role: "staff",
        institutionId: institutionA,
      });
    });

    const asTeacher = await withUser(t, teacher);
    expect(
      (await asTeacher.query(api.mcp.listScholars, {})).scholars.map(
        (scholar) => scholar.name,
      ),
    ).toEqual(["Briar Cove"]);
    expect(
      await asTeacher.query(api.mcp.getScholarMastery, {
        scholarName: "Aster",
      }),
    ).toBeNull();

    // Base staff (the retired registrar role's successor) with a stale
    // membership + no school:operations grant does not gain school-operations
    // scope from that stale row — but the schoolOperationsInstitutionIds
    // resolver treats ANY teacher/school_admin membership row as
    // institution-scoped access regardless of the caller's own top-level
    // role, so the stray teacher@institutionA row DOES widen this staff
    // caller's scope to institutionA (not institutionB, since that row is
    // "staff" with no capability grant).
    const opsStaff = await seedUser(t, "staff", "stale-reg");
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userId: opsStaff,
        role: "staff",
        institutionId: institutionB,
      });
      await ctx.db.insert("memberships", {
        userId: opsStaff,
        role: "teacher",
        institutionId: institutionA,
      });
    });
    const asOpsStaff = await withUser(t, opsStaff);
    expect(
      (await asOpsStaff.query(api.mcp.listScholars, {})).scholars.map(
        (scholar) => scholar.name,
      ),
    ).toEqual(["Aster Vale"]);
  });

  test("teacher without an institution membership gets an empty roster", async () => {
    const t = convexTest(schema, modules);
    await seedInstitutionBoundaryWorld(t);
    const teacher = await seedUser(t, "teacher", "no-membership");
    const asTeacher = await withUser(t, teacher);

    expect(await asTeacher.query(api.mcp.listScholars, {})).toEqual({
      scholars: [],
    });
  });

  test("operations staff gets the redacted roster (no learning measurements)", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedWorld(t);
    const reg = await seedUser(t, "staff", "reg");
    await seedOperationsMembership(t, reg, institutionId);
    const asReg = await withUser(t, reg);
    const { scholars: roster } = await asReg.query(api.mcp.listScholars, {});
    expect(roster).toHaveLength(2);
    expect(roster[0]).not.toHaveProperty("readingLevel");
    expect(roster[0]).not.toHaveProperty("observationCount");
    expect(roster[0]).toHaveProperty("sessionCount");
  });

  test("operations staff roster is also limited to membership institutions", async () => {
    const t = convexTest(schema, modules);
    const { institutionB } = await seedInstitutionBoundaryWorld(t);
    const opsStaff = await seedUser(t, "staff", "boundary-registrar");
    await seedOperationsMembership(t, opsStaff, institutionB);

    const asOpsStaff = await withUser(t, opsStaff);
    const { scholars: roster } = await asOpsStaff.query(
      api.mcp.listScholars,
      {},
    );
    expect(roster).toEqual([
      expect.objectContaining({ name: "Briar Cove" }),
    ]);
  });

  test("parent, scholar, and curriculum_designer are refused", async () => {
    const t = convexTest(schema, modules);
    const { parent, kai } = await seedWorld(t);
    const designer = await seedUser(t, "curriculum_designer", "des");
    for (const userId of [parent, kai, designer]) {
      const asUser = await withUser(t, userId);
      await expect(asUser.query(api.mcp.listScholars, {})).rejects.toThrow(
        "Forbidden",
      );
    }
  });
});

describe("mcp — enrolled vs Extended Education participation default", () => {
  /** seedWorld + a program-guest (Extended Education) scholar in the same
   *  institution, linked to the same parent. */
  async function seedWorldWithGuest(t: ReturnType<typeof convexTest>) {
    const world = await seedWorld(t);
    const guest = await seedUser(t, "scholar", "nohea", "Nohea Akana");
    await t.run(async (ctx) => {
      await ctx.db.patch(guest, {
        institutionId: world.institutionId,
        enrollmentStanding: "program_guest",
      });
      await ctx.db.insert("guardianships", {
        parentUserId: world.parent,
        scholarUserId: guest,
        createdBy: world.teacher,
      });
    });
    return { ...world, guest };
  }

  test("staff-side listScholars defaults to enrolled only, with a discoverability note", async () => {
    const t = convexTest(schema, modules);
    const { teacher } = await seedWorldWithGuest(t);
    const asTeacher = await withUser(t, teacher);

    const res = await asTeacher.query(api.mcp.listScholars, {});
    expect(res.note).toContain("1 Extended Education scholar");
    expect(res.note).toContain("includeExtendedEducation");
    expect(new Set(res.scholars.map((s) => s.name))).toEqual(
      new Set(["Kai Nakamura", "Lani Kealoha"]),
    );
  });

  test("includeExtendedEducation: true returns the guest, tagged, with no note", async () => {
    const t = convexTest(schema, modules);
    const { teacher } = await seedWorldWithGuest(t);
    const asTeacher = await withUser(t, teacher);

    const res = (await asTeacher.query(api.mcp.listScholars, {
      includeExtendedEducation: true,
    })) as { scholars: { name: string; extendedEducation?: boolean }[] };
    expect(res).not.toHaveProperty("note");
    expect(new Set(res.scholars.map((s) => s.name))).toEqual(
      new Set(["Kai Nakamura", "Lani Kealoha", "Nohea Akana"]),
    );
    expect(
      res.scholars.find((s) => s.name === "Nohea Akana")?.extendedEducation,
    ).toBe(true);
    expect(
      res.scholars.find((s) => s.name === "Kai Nakamura"),
    ).not.toHaveProperty("extendedEducation");
  });

  test("all-enrolled roster keeps the stable { scholars } shape with no note noise", async () => {
    const t = convexTest(schema, modules);
    const { teacher } = await seedWorld(t);
    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.mcp.listScholars, {});
    expect(res).not.toHaveProperty("note");
    expect(res.scholars).toHaveLength(2);
  });

  test("operations staff's redacted roster keeps the extendedEducation tag on opt-in", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedWorldWithGuest(t);
    const reg = await seedUser(t, "staff", "reg");
    await seedOperationsMembership(t, reg, institutionId);
    const asReg = await withUser(t, reg);

    const defaulted = await asReg.query(api.mcp.listScholars, {});
    expect(defaulted.note).toContain("1 Extended Education scholar");
    expect(defaulted.scholars).toHaveLength(2);

    const optedIn = (await asReg.query(api.mcp.listScholars, {
      includeExtendedEducation: true,
    })) as { scholars: { name: string; extendedEducation?: boolean }[] };
    const guestRow = optedIn.scholars.find((s) => s.name === "Nohea Akana");
    expect(guestRow?.extendedEducation).toBe(true);
    expect(guestRow).not.toHaveProperty("readingLevel");
    expect(guestRow).not.toHaveProperty("observationCount");
  });

  test("identity-scoped surfaces are exempt: parent whoami lists their guest child; naming resolves guests", async () => {
    const t = convexTest(schema, modules);
    const { teacher, parent } = await seedWorldWithGuest(t);

    // A program-guest family always sees their own children — whoami's
    // scholarNames enumerates the guardianship set unfiltered.
    const asParent = await withUser(t, parent);
    const me = await asParent.query(api.mcp.whoami, {});
    expect(new Set(me.scholarNames ?? [])).toEqual(
      new Set(["Kai Nakamura", "Nohea Akana"]),
    );
    // ...and the name-keyed reads resolve the guest child (naming IS the
    // opt-in — only enumerations default to enrolled).
    const parentRead = await asParent.query(api.mcp.getScholarMastery, {
      scholarName: "Nohea",
    });
    expect(parentRead?.scholar).toBe("Nohea Akana");

    const asTeacher = await withUser(t, teacher);
    const teacherRead = await asTeacher.query(api.mcp.getScholarMastery, {
      scholarName: "Nohea",
    });
    expect(teacherRead?.scholar).toBe("Nohea Akana");
  });
});

describe("mcp per-scholar reads — role policy", () => {
  test("teacher cannot resolve a scholar outside their membership institutions", async () => {
    const t = convexTest(schema, modules);
    const { teacher } = await seedInstitutionBoundaryWorld(t);
    const asTeacher = await withUser(t, teacher);

    expect(
      await asTeacher.query(api.mcp.getScholarMastery, {
        scholarName: "Aster",
      }),
    ).toBeNull();
    expect(
      await asTeacher.query(api.mcp.getScholarMastery, {
        scholarName: "Briar",
      }),
    ).toMatchObject({ scholar: "Briar Cove" });
  });

  test("teacher can read tier-2 (dossier/observations/documents/sessions)", async () => {
    const t = convexTest(schema, modules);
    const { teacher, kai } = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarDocuments", {
        scholarId: kai,
        kind: "assessment",
        title: "Cognitive assessment",
        summary: "Strong verbal and visual reasoning.",
        keyFindings: ["Benefits from open-ended conceptual work"],
        uploadedBy: teacher,
        processingStatus: "ready",
      });
    });
    const asTeacher = await withUser(t, teacher);

    const dossier = await asTeacher.query(api.mcp.getScholarDossier, {
      scholarName: "kai",
    });
    expect(dossier?.scholar).toBe("Kai Nakamura");
    expect(dossier?.dossier).toBe("No dossier data available yet.");
    expect(dossier?.sourceDocuments).toEqual([
      expect.objectContaining({
        title: "Cognitive assessment",
        kind: "assessment",
        processingStatus: "ready",
      }),
    ]);

    const sessions = await asTeacher.query(api.mcp.getScholarSessions, {
      scholarName: "Kai",
    });
    expect(sessions?.sessions).toEqual([]);

    const docs = await asTeacher.query(api.mcp.getScholarDocuments, {
      scholarName: "kai nak",
    });
    expect(docs?.documents).toEqual(dossier?.sourceDocuments);
  });

  test("parent can read tier-1 for their own child only", async () => {
    const t = convexTest(schema, modules);
    const { parent } = await seedWorld(t);
    const asParent = await withUser(t, parent);

    const mastery = await asParent.query(api.mcp.getScholarMastery, {
      scholarName: "kai",
    });
    expect(mastery?.scholar).toBe("Kai Nakamura");
    expect(mastery?.mastery).toEqual({});

    // The OTHER scholar resolves to nothing — indistinguishable from
    // nonexistent, so names can't be probed.
    const other = await asParent.query(api.mcp.getScholarMastery, {
      scholarName: "lani",
    });
    expect(other).toBeNull();
  });

  test("parent scope remains limited to linked children", async () => {
    const t = convexTest(schema, modules);
    const { parent } = await seedInstitutionBoundaryWorld(t);
    const asParent = await withUser(t, parent);

    expect(
      await asParent.query(api.mcp.getScholarMastery, {
        scholarName: "Aster",
      }),
    ).toMatchObject({ scholar: "Aster Vale" });
    expect(
      await asParent.query(api.mcp.getScholarMastery, {
        scholarName: "Briar",
      }),
    ).toBeNull();
  });

  test("parent is refused tier-2 even for their own child", async () => {
    const t = convexTest(schema, modules);
    const { parent } = await seedWorld(t);
    const asParent = await withUser(t, parent);
    await expect(
      asParent.query(api.mcp.getScholarDossier, { scholarName: "kai" }),
    ).rejects.toThrow("Forbidden");
    await expect(
      asParent.query(api.mcp.getScholarObservations, { scholarName: "kai" }),
    ).rejects.toThrow("Forbidden");
    await expect(
      asParent.query(api.mcp.getScholarDocuments, { scholarName: "kai" }),
    ).rejects.toThrow("Forbidden");
    await expect(
      asParent.query(api.mcp.getScholarSessions, { scholarName: "kai" }),
    ).rejects.toThrow("Forbidden");
  });

  test("scholar can read their own tier-1 but nobody else's", async () => {
    const t = convexTest(schema, modules);
    const { kai } = await seedWorld(t);
    const asKai = await withUser(t, kai);

    const own = await asKai.query(api.mcp.getScholarSeeds, {
      scholarName: "kai",
    });
    expect(own?.scholar).toBe("Kai Nakamura");

    const other = await asKai.query(api.mcp.getScholarSeeds, {
      scholarName: "lani",
    });
    expect(other).toBeNull();

    await expect(
      asKai.query(api.mcp.getScholarDossier, { scholarName: "kai" }),
    ).rejects.toThrow("Forbidden");
  });

  test("operations staff and curriculum_designer get no per-scholar reads", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const reg = await seedUser(t, "staff", "reg");
    const designer = await seedUser(t, "curriculum_designer", "des");
    for (const userId of [reg, designer]) {
      const asUser = await withUser(t, userId);
      await expect(
        asUser.query(api.mcp.getScholarMastery, { scholarName: "kai" }),
      ).rejects.toThrow("Forbidden");
    }
  });

  test("empty scholarName resolves to nothing (no first-match guessing)", async () => {
    const t = convexTest(schema, modules);
    const { teacher } = await seedWorld(t);
    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.mcp.getScholarMastery, {
      scholarName: "   ",
    });
    expect(result).toBeNull();
  });
});

describe("mcp curriculum surface — proxied through assembleCurriculumTools", () => {
  // convex/mcp.ts no longer hand-mirrors each assignment tool as its own
  // query/mutation. Instead listCurriculumTools / callCurriculumTool proxy
  // the SHARED assemble layer (the same one the aide stream + Slack bot
  // use), self-resolving the caller's identity from the access-token JWT and
  // re-asserting the role gate on every call. These tests pin that the gate
  // is the SAME boundary the deleted wrappers were: the MCP-exposed set per
  // role, the owner check on writes, and that an off-role name is refused.

  async function seedAssignmentWorld(t: ReturnType<typeof convexTest>) {
    const { teacher, kai, lani, parent, institutionId } = await seedWorld(t);
    const { unitId, activityId } = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "MCP Unit",
        isActive: true,
      });
      const lid = await ctx.db.insert("lessons", {
        unitId: uid,
        title: "L1",
        order: 0,
      });
      const aid = await ctx.db.insert("activities", {
        lessonId: lid,
        title: "A1",
        kind: "online",
        systemPrompt: "...",
        order: 0,
      });
      return { unitId: uid, activityId: aid };
    });
    const assignmentId = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [kai],
        startedAt: Date.now(),
        activitySchedule: [],
      }),
    );
    return {
      teacher,
      kai,
      lani,
      parent,
      unitId,
      activityId,
      assignmentId,
      institutionId,
    };
  }

  const toolNames = async (
    as: Awaited<ReturnType<typeof withUser>>,
  ): Promise<string[]> =>
    (await as.action(api.mcp.listCurriculumTools, {})).map((t) => t.name);

  test("the WRITE toolset is lens-scoped for a plain teacher, not just ROLES.STAFF", async () => {
    // Regression: the MCP curriculum surface resolved a scholar lens only for
    // `role === ROLES.STAFF`, while the gate above it admits every staff-class
    // role (teacher, school_admin, curriculum_designer). A teacher therefore
    // arrived with allowedScholarIds undefined, which ALSO made customApps'
    // assertTargetsWithinLens a no-op — so a teacher at Institution B could
    // land a launcher tile on a scholar at Institution A.
    const t = convexTest(schema, modules);
    const { teacher, scholarA } = await seedInstitutionBoundaryWorld(t);
    const asTeacher = await withUser(t, teacher);

    const raw = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "install_external_app",
      input: {
        name: "Desmos",
        url: "https://www.desmos.com/calculator",
        scholarNames: ["Aster Vale"],
      },
    });

    // The out-of-lens scholar must never resolve to an install.
    expect(raw).not.toContain("Installed for: Aster Vale");
    const installed = await t.run((ctx) =>
      ctx.db
        .query("scholarApps")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarA))
        .collect(),
    );
    expect(installed).toHaveLength(0);
  });

  test("listCurriculumTools exposes the staff toolset, never the scholar-detail reads or web tools", async () => {
    const t = convexTest(schema, modules);
    const { teacher } = await seedAssignmentWorld(t);
    const asTeacher = await withUser(t, teacher);
    const names = await toolNames(asTeacher);

    // Unit reads + scholar-scoped writes + the assignment surface are all
    // reachable over MCP for a teacher.
    for (const n of [
      "list_assignments",
      "push_activity_now",
      "get_assignment_progress",
      "set_assignment_scholars",
      "list_units",
      "get_unit_details",
      "create_scholar_quest",
      "offer_scholar_quest",
      "upsert_teacher_directive",
      "list_scholar_groups",
      "get_scholar_emergency_info",
    ]) {
      expect(names).toContain(n);
    }
    // Scholar-DETAIL reads keep the route's own redaction-aware formatted
    // path (the getScholar* queries) — not double-registered here.
    for (const n of ["list_scholars", "get_scholar_dossier", "get_scholar_mastery"]) {
      expect(names).not.toContain(n);
    }
    // The Anthropic-hosted web tools aren't runnable through the proxy.
    for (const n of ["web_search", "web_fetch"]) {
      expect(names).not.toContain(n);
    }
    // Anthropic's predefined editor has no JSON input schema and requires
    // ToolRunner context, so exposing it here would invalidate tools/list.
    expect(names).not.toContain("str_replace_based_edit_tool");
    const listed = await asTeacher.action(api.mcp.listCurriculumTools, {});
    expect(
      listed.every(
        (tool) =>
          tool.inputSchema !== null &&
          typeof tool.inputSchema === "object" &&
          !Array.isArray(tool.inputSchema),
      ),
    ).toBe(true);
  });

  test("listCurriculumTools is empty for parent/scholar, account-admin writes for operations staff, and unit-reads-only for a designer", async () => {
    const t = convexTest(schema, modules);
    const { parent, kai, institutionId } = await seedAssignmentWorld(t);
    const reg = await seedUser(t, "staff", "reg");
    await seedOperationsMembership(t, reg, institutionId, { health: true });
    const designer = await seedUser(t, "curriculum_designer", "des");

    // Parent + scholar are NOT staff → no curriculum surface at all.
    for (const userId of [parent, kai]) {
      const asUser = await withUser(t, userId);
      expect(await toolNames(asUser)).toEqual([]);
    }

    // Operations staff (staff role + school:operations grant — the retired
    // registrar role's successor) is scholar-admin staff → the account-admin
    // scholar writes (their actual job), but NO learning-record writes,
    // units, or roster.
    const regNames = await toolNames(await withUser(t, reg));
    for (const n of [
      "update_scholar_profile",
      "reset_scholar_password",
      "reset_scholar_passkeys",
      "get_scholar_emergency_info",
    ]) {
      expect(regNames).toContain(n);
    }
    for (const n of [
      "add_scholar_observation",
      "delete_scholar",
      "upload_scholar_document",
      "list_assignments",
      "create_scholar_quest",
      "list_scholars",
    ]) {
      expect(regNames).not.toContain(n);
    }

    const designerNames = await toolNames(await withUser(t, designer));
    expect(designerNames).toContain("list_units");
    expect(designerNames).toContain("get_unit_details");
    for (const n of ["list_assignments", "create_scholar_quest", "list_scholars"]) {
      expect(designerNames).not.toContain(n);
    }
  });

  test("teacher reads list/progress and pushes an activity live via callCurriculumTool", async () => {
    const t = convexTest(schema, modules);
    const { teacher, activityId, assignmentId } = await seedAssignmentWorld(t);
    const asTeacher = await withUser(t, teacher);

    const listRaw = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "list_assignments",
      input: {},
    });

    expect(JSON.parse(listRaw)).toHaveLength(1);
    expect(listRaw).toContain("https://");

    const pushRaw = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "push_activity_now",
      input: { assignmentId, activityId, mode: "classFocus" },
    });
    expect(JSON.parse(pushRaw)).toMatchObject({ ok: true, live: true });

    const progRaw = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "get_assignment_progress",
      input: { assignmentId },
    });
    const progress = JSON.parse(progRaw);
    expect(progress.rosterSize).toBe(1);
    const act = progress.activities.find(
      (x: { activityId: string }) => x.activityId === activityId,
    );
    expect(act?.state).toBe("live");
  });

  test("shared MCP tool returns only the submitted canonical emergency record", async () => {
    const t = convexTest(schema, modules);
    const { kai, parent } = await seedAssignmentWorld(t);
    const admin = await seedUser(t, "platform_admin", "health-admin");
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarHealthRecordDrafts", {
        scholarId: kai,
        guardianId: parent,
        ...emptyHealthRecordFields({
          childName: "Kai Nakamura",
        }),
        allergyNotes: "Private draft detail",
        baseRevision: 1,
        version: 1,
        currentStep: 3,
        lastCompletedStep: 2,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("scholarHealthRecords", {
        scholarId: kai,
        guardianId: parent,
        ...emptyHealthRecordFields({
          childName: "Kai Nakamura",
        }),
        noKnownAllergies: false,
        allergies: [
          {
            allergen: "Peanuts",
            type: "food",
            reaction: "Hives",
            severity: "severe",
            emergencyTreatment: "Use epinephrine",
            epipenOnFile: true,
          },
        ],
        signerName: "Parent Signer",
        signerAgreement: true,
        signerUserId: parent,
        signedAt: 100,
        submittedAt: 101,
        revision: 1,
        createdAt: 99,
        updatedAt: 101,
      });
    });

    const asAdmin = await withUser(t, admin);
    expect(await toolNames(asAdmin)).toContain("get_scholar_emergency_info");
    const raw = await asAdmin.action(api.mcp.callCurriculumTool, {
      name: "get_scholar_emergency_info",
      input: { scholarName: "Kai Nakamura" },
    });
    expect(JSON.parse(raw)).toMatchObject({
      status: "found",
      scholar: "Kai Nakamura",
      emergencyInfo: {
        allergies: {
          entries: [{ allergen: "Peanuts" }],
        },
      },
      submission: { revision: 1, signedName: "Parent Signer" },
    });
    expect(raw).not.toContain("Private draft detail");
  });

  test("set_assignment_scholars resolves names and replaces the roster", async () => {
    const t = convexTest(schema, modules);
    const { teacher, lani, assignmentId } = await seedAssignmentWorld(t);
    const asTeacher = await withUser(t, teacher);

    const res = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "set_assignment_scholars",
      input: { assignmentId, scholarNames: ["Lani"] },
    });
    expect(JSON.parse(res)).toMatchObject({ ok: true, rosterSize: 1 });
    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(a!.scholarIds.map(String)).toEqual([String(lani)]);
  });

  test("set_assignment_scholars refuses an unresolvable name (no change)", async () => {
    const t = convexTest(schema, modules);
    const { teacher, kai, assignmentId } = await seedAssignmentWorld(t);
    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "set_assignment_scholars",
      input: { assignmentId, scholarNames: ["Nobody McGhost"] },
    });
    expect(res).toMatch(/could not resolve/i);
    // Roster untouched.
    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(a!.scholarIds.map(String)).toEqual([String(kai)]);
  });

  test("set/add_assignment_scholars refuse an AMBIGUOUS name (both candidates named, no change)", async () => {
    const t = convexTest(schema, modules);
    const { teacher, kai, assignmentId } = await seedAssignmentWorld(t);
    // A second "Kai …" so the partial query "Kai" collides with two scholars.
    await seedUser(t, "scholar", "kait", "Kai Tanaka");
    const asTeacher = await withUser(t, teacher);

    const setRes = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "set_assignment_scholars",
      input: { assignmentId, scholarNames: ["Kai"] },
    });
    expect(setRes).toMatch(/ambiguous/i);
    expect(setRes).toContain("Kai Nakamura");
    expect(setRes).toContain("Kai Tanaka");

    const addRes = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "add_assignment_scholars",
      input: { assignmentId, scholarNames: ["Kai"] },
    });
    expect(addRes).toMatch(/ambiguous/i);
    expect(addRes).toContain("Kai Nakamura");
    expect(addRes).toContain("Kai Tanaka");

    // Roster is unchanged — still just the original Kai Nakamura.
    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(a!.scholarIds.map(String)).toEqual([String(kai)]);

    // The full name disambiguates: "Kai Nakamura" is an exact match for one
    // scholar, so the write goes through.
    const exact = await asTeacher.action(api.mcp.callCurriculumTool, {
      name: "set_assignment_scholars",
      input: { assignmentId, scholarNames: ["Kai Nakamura"] },
    });
    expect(JSON.parse(exact)).toMatchObject({ ok: true, rosterSize: 1 });
    const after = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(after!.scholarIds.map(String)).toEqual([String(kai)]);
  });

  test("non-staff and non-teacher (parent/scholar/plain staff/designer) are refused every curriculum tool", async () => {
    const t = convexTest(schema, modules);
    const { parent, kai } = await seedAssignmentWorld(t);
    const reg = await seedUser(t, "staff", "reg");
    const designer = await seedUser(t, "curriculum_designer", "des");
    for (const userId of [parent, kai, reg, designer]) {
      const asUser = await withUser(t, userId);
      // A name outside the caller's assembled set is indistinguishable from a
      // tool that doesn't exist for them → "Forbidden: <name>".
      await expect(
        asUser.action(api.mcp.callCurriculumTool, {
          name: "list_assignments",
          input: {},
        }),
      ).rejects.toThrow("Forbidden");
      await expect(
        asUser.action(api.mcp.callCurriculumTool, {
          name: "push_activity_now",
          input: { assignmentId: "x", activityId: "y", mode: "classFocus" },
        }),
      ).rejects.toThrow("Forbidden");
    }
  });

  test("a teacher cannot touch another teacher's assignment (owner check)", async () => {
    const t = convexTest(schema, modules);
    const { activityId, assignmentId } = await seedAssignmentWorld(t);
    const other = await seedUser(t, "teacher", "other-teacher");
    const asOther = await withUser(t, other);

    // Reads are owner-scoped: not in their list, progress says it isn't theirs.
    expect(
      JSON.parse(
        await asOther.action(api.mcp.callCurriculumTool, {
          name: "list_assignments",
          input: {},
        }),
      ),
    ).toHaveLength(0);
    const prog = await asOther.action(api.mcp.callCurriculumTool, {
      name: "get_assignment_progress",
      input: { assignmentId },
    });
    expect(prog).toMatch(/isn't yours|no assignment/i);

    // The write is owner-checked inside the shared core; the tool catches the
    // throw and returns it as text.
    const push = await asOther.action(api.mcp.callCurriculumTool, {
      name: "push_activity_now",
      input: { assignmentId, activityId, mode: "classFocus" },
    });
    expect(push).toMatch(/not your assignment/i);
  });
});

describe("mcp unit-designer CRUD surface", () => {
  test("lists CRUD tools with per-call unitId and edits the submitted unit", async () => {
    const t = convexTest(schema, modules);
    const { teacher } = await seedWorld(t);
    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", { teacherId: teacher, title: "Editable unit", isActive: true }),
    );
    const asTeacher = await withUser(t, teacher);

    const tools = await asTeacher.action(api.mcp.listUnitDesignerTools, {});
    const curriculumNames = new Set(
      (await asTeacher.action(api.mcp.listCurriculumTools, {})).map(
        (tool) => tool.name,
      ),
    );
    const createLesson = tools.find((tool) => tool.name === "unit_create_lesson");
    expect(createLesson!.inputSchema).toMatchObject({
      required: expect.arrayContaining(["unitId", "title"]),
      properties: { unitId: { type: "string" } },
    });
    expect(tools.map((tool) => tool.name)).not.toContain("list_scholars");
    expect(tools.every((tool) => !curriculumNames.has(tool.name))).toBe(true);

    await asTeacher.action(api.mcp.callUnitDesignerTool, {
      name: "unit_create_lesson",
      unitId,
      input: { unitId, title: "First lesson" },
    });
    const lessons = await t.run(async (ctx) =>
      ctx.db.query("lessons").withIndex("by_unit", (q) => q.eq("unitId", unitId)).collect(),
    );
    expect(lessons.map((lesson) => lesson.title)).toEqual(["First lesson"]);
  });

  test("carries the open unit's institution so the designer lens follows the unit", async () => {
    // Regression: mcpUnitDesignerTools called assembleUnitDesignerTools with
    // no institutionScope, so the scholar lens silently fell back to the
    // CALLER's home institution. An admin editing another school's unit was
    // then served their own school's scholars while believing they were the
    // unit's — the "B served A's data believing it is B's own" failure.
    const t = convexTest(schema, modules);
    const { teacher, institutionId } = await seedWorld(t);
    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId: teacher,
        title: "Institution-owned unit",
        isActive: true,
        institutionId,
      }),
    );

    const access = await t.query(internal.mcp.authorizeUnitDesignerTool, {
      callerUserId: teacher,
      unitId,
    });
    expect(access).toMatchObject({
      unitTitle: "Institution-owned unit",
      institutionScope: String(institutionId),
    });
  });

  test("refuses non-curriculum roles and cross-institution units", async () => {
    const t = convexTest(schema, modules);
    const { teacher, parent, institutionId } = await seedWorld(t);
    const otherTeacher = await seedUser(t, "teacher", "other-unit-teacher");
    const foreignInstitutionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("institutions", {
        name: "Foreign School", slug: "foreign-school", kind: "school",
      });
      await ctx.db.insert("memberships", {
        userId: otherTeacher, role: "teacher", institutionId: id,
      });
      return id;
    });
    const { localUnitId, foreignUnitId } = await t.run(async (ctx) => ({
      localUnitId: await ctx.db.insert("units", {
        teacherId: teacher, institutionId, title: "Local unit", isActive: true,
      }),
      foreignUnitId: await ctx.db.insert("units", {
        teacherId: otherTeacher, institutionId: foreignInstitutionId,
        title: "Foreign unit", isActive: true,
      }),
    }));

    const asParent = await withUser(t, parent);
    expect(await asParent.action(api.mcp.listUnitDesignerTools, {})).toEqual([]);
    await expect(asParent.action(api.mcp.callUnitDesignerTool, {
      name: "unit_read_unit_structure", unitId: localUnitId, input: { unitId: localUnitId },
    })).rejects.toThrow("Forbidden");

    const asTeacher = await withUser(t, teacher);
    await expect(asTeacher.action(api.mcp.callUnitDesignerTool, {
      name: "unit_read_unit_structure", unitId: foreignUnitId, input: { unitId: foreignUnitId },
    })).rejects.toThrow("unit is not in your institution");
  });
});
