import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { MAX_PROFILE_IMAGE_BYTES } from "../lib/profileImage";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "school_admin"
  | "staff"
  | "curriculum_designer"
  | "parent";

async function seedInstitutions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    moli: await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
      emoji: "🏫",
    }),
    nuni: await ctx.db.insert("institutions", {
      name: "Nuni School",
      slug: "nuni",
      kind: "school",
      isPrimary: false,
      emoji: "🌋",
    }),
  }));
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  institutionId?: Id<"institutions">,
) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      ...(institutionId && role === "scholar" ? { institutionId } : {}),
    }),
  );
  if (institutionId && role !== "scholar") {
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { userId, role, institutionId }),
    );
  }
  return userId;
}

// A base `staff` fixture + `school:operations` capability grant — the
// successor to the retired `registrar` role (scholar-admin access without a
// scholar-admin role). Used wherever this file previously seeded a registrar.
async function seedOperationsStaffLocal(
  t: ReturnType<typeof convexTest>,
  username: string,
  institutionId: Id<"institutions">,
) {
  const userId = await seedUser(t, "staff", username, institutionId);
  await t.run(async (ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "school:operations",
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
  return userId;
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

/** Store a blob and return its storageId (convex-test preserves the type). */
async function storeBlob(
  t: ReturnType<typeof convexTest>,
  type: string,
  size = 8,
) {
  return await t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array(size)], { type })),
  );
}

async function institutionRow(
  t: ReturnType<typeof convexTest>,
  id: Id<"institutions">,
) {
  return await t.run(async (ctx) => ctx.db.get(id));
}

async function blobExists(
  t: ReturnType<typeof convexTest>,
  storageId: Id<"_storage">,
) {
  return (
    (await t.run(async (ctx) => ctx.db.system.get("_storage", storageId))) !==
    null
  );
}

async function membershipsFor(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("memberships")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect(),
  );
}

async function seedParent(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role: "parent",
      email: `${username}@example.com`,
    }),
  );
}

async function linkGuardian(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"users">,
  scholarId: Id<"users">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId: parentId,
      scholarUserId: scholarId,
      createdBy: parentId,
    }),
  );
}

describe("school settings", () => {
  test("school_admin edits only their own institution name and emoji", async () => {
    const t = convexTest(schema, modules);
    const { moli, nuni } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    const result = await asHoku.mutation(api.institutions.updateSettings, {
      name: "Moli Learning Lab",
      emoji: "🌀",
      timeZone: "America/New_York",
    });

    expect(result.name).toBe("Moli Learning Lab");
    expect(result.emoji).toBe("🌀");
    expect(result.timeZone).toBe("America/New_York");
    const rows = await t.run(async (ctx) => ({
      moli: await ctx.db.get(moli),
      nuni: await ctx.db.get(nuni),
    }));
    expect(rows.moli?.name).toBe("Moli Learning Lab");
    expect(rows.moli?.emoji).toBe("🌀");
    expect(rows.moli?.timeZone).toBe("America/New_York");
    expect(rows.moli?.slug).toBe("moli");
    expect(rows.moli?.kind).toBe("school");
    expect(rows.nuni?.name).toBe("Nuni School");
    expect(rows.nuni?.emoji).toBe("🌋");
  });

  test("rejects an invalid IANA time zone", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    await expect(
      asHoku.mutation(api.institutions.updateSettings, {
        name: "Moli School",
        timeZone: "Pacific/Atlantis",
      }),
    ).rejects.toThrow("valid IANA time zone");
  });

  test("operations staff cannot edit school settings", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaffLocal(t, "reg", moli);
    const asReg = await withUser(t, reg);

    await expect(
      asReg.mutation(api.institutions.updateSettings, {
        name: "Registrar Rename",
        emoji: "📝",
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("slug, kind, and primary flag are not editable through settings", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    await expect(
      asHoku.mutation(api.institutions.updateSettings, {
        name: "Spoofed School",
        emoji: "🏴",
        slug: "spoofed",
        kind: "guest",
        isPrimary: false,
      } as unknown as { name: string; emoji: string }),
    ).rejects.toThrow();

    const row = await t.run(async (ctx) => ctx.db.get(moli));
    expect(row?.name).toBe("Moli School");
    expect(row?.emoji).toBe("🏫");
    expect(row?.slug).toBe("moli");
    expect(row?.kind).toBe("school");
    expect(row?.isPrimary).toBe(true);
  });
});

describe("removeStaffFromInstitution", () => {
  test("school_admin removes a teacher membership without deleting the user", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asHoku = await withUser(t, hoku);
    const grantId = await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: teacher,
        institutionId: moli,
        capability: "curriculum:edit",
        grantedBy: hoku,
        grantedAt: Date.now(),
      }),
    );

    const result = await asHoku.mutation(api.users.removeStaffFromInstitution, {
      userId: teacher,
    });

    expect(result.removed).toBe(1);
    const user = await t.run(async (ctx) => ctx.db.get(teacher));
    expect(user?.username).toBe("teach");
    const memberships = await membershipsFor(t, teacher);
    expect(memberships.some((m) => m.institutionId === moli)).toBe(false);
    const grant = await t.run((ctx) => ctx.db.get(grantId));
    expect(grant?.revokedAt).toEqual(expect.any(Number));
    expect(grant?.revokedBy).toBe(hoku);
  });

  test("school_admin cannot remove themselves", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    await expect(
      asHoku.mutation(api.users.removeStaffFromInstitution, { userId: hoku }),
    ).rejects.toThrow("Cannot remove yourself");
  });

  test("school_admin cannot remove a platform_admin target", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const platform = await seedUser(t, "platform_admin", "avery");
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: platform,
        role: "teacher",
        institutionId: moli,
      }),
    );
    const asHoku = await withUser(t, hoku);

    await expect(
      asHoku.mutation(api.users.removeStaffFromInstitution, { userId: platform }),
    ).rejects.toThrow("Cannot remove school or platform admins");
    expect((await membershipsFor(t, platform)).some((m) => m.institutionId === moli)).toBe(true);
  });

  test("school_admin cannot remove another school_admin target", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const otherAdmin = await seedUser(t, "school_admin", "other-admin", moli);
    const asHoku = await withUser(t, hoku);

    await expect(
      asHoku.mutation(api.users.removeStaffFromInstitution, { userId: otherAdmin }),
    ).rejects.toThrow("Cannot remove school or platform admins");
    expect((await membershipsFor(t, otherAdmin)).some((m) => m.institutionId === moli)).toBe(true);
  });

  test("school_admin cannot remove a cross-institution staffer", async () => {
    const t = convexTest(schema, modules);
    const { moli, nuni } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const nuniTeacher = await seedUser(t, "teacher", "teach-nuni", nuni);
    const asHoku = await withUser(t, hoku);

    await expect(
      asHoku.mutation(api.users.removeStaffFromInstitution, {
        userId: nuniTeacher,
      }),
    ).rejects.toThrow("Staff account not found in your institution");
    expect((await membershipsFor(t, nuniTeacher)).some((m) => m.institutionId === nuni)).toBe(true);
  });

  test("a multi-institution school_admin CAN remove staff in a non-home institution", async () => {
    const t = convexTest(schema, modules);
    const { moli, nuni } = await seedInstitutions(t);
    // Hoku leads BOTH schools — home resolves to moli (primary), but nuni is
    // also in his allowedInstitutionIds. Remove must work for nuni staff too
    // (matches what listInstitutionStaff shows + issueStaffEnrollLink allows).
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { userId: hoku, role: "school_admin", institutionId: nuni }),
    );
    const nuniTeacher = await seedUser(t, "teacher", "teach-nuni", nuni);
    const asHoku = await withUser(t, hoku);

    const res = await asHoku.mutation(api.users.removeStaffFromInstitution, {
      userId: nuniTeacher,
    });
    expect(res.removed).toBe(1);
    // Membership gone, but the user account remains.
    expect((await membershipsFor(t, nuniTeacher)).length).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(nuniTeacher))).not.toBeNull();
  });

  test("operations staff cannot remove staff", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaffLocal(t, "reg", moli);
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asReg = await withUser(t, reg);

    await expect(
      asReg.mutation(api.users.removeStaffFromInstitution, { userId: teacher }),
    ).rejects.toThrow("Forbidden");
    expect((await membershipsFor(t, teacher)).some((m) => m.institutionId === moli)).toBe(true);
  });
});

// The /school surface honors the active institution lens (?inst=<slug>). The
// resolver only honors an institution the caller may act on, so scope is a
// safe control: a platform admin can pick any school, a school-scoped staffer
// always falls back to their own. These cover the read + write scoping AND the
// fail-safe (a school_admin cannot use scope to reach another school).
describe("school settings — institution lens", () => {
  test("platform admin + scope reads and writes the scoped institution", async () => {
    const t = convexTest(schema, modules);
    const { moli, nuni } = await seedInstitutions(t);
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);

    // Read: scope=nuni lands on Nuni, not the home/primary (Moli).
    const school = await asAvery.query(api.institutions.getMySchool, {
      scope: "nuni",
    });
    expect(school.slug).toBe("nuni");

    // Write: scope=nuni edits Nuni only; Moli untouched.
    const saved = await asAvery.mutation(api.institutions.updateSettings, {
      name: "Nuni Learning Lab",
      emoji: "🌀",
      scope: "nuni",
    });
    expect(saved.slug).toBe("nuni");
    const rows = await t.run(async (ctx) => ({
      moli: await ctx.db.get(moli),
      nuni: await ctx.db.get(nuni),
    }));
    expect(rows.nuni?.name).toBe("Nuni Learning Lab");
    expect(rows.nuni?.emoji).toBe("🌀");
    expect(rows.moli?.name).toBe("Moli School");
  });

  test("platform admin with no scope resolves to the home institution (today's behavior)", async () => {
    const t = convexTest(schema, modules);
    await seedInstitutions(t);
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);

    const school = await asAvery.query(api.institutions.getMySchool, {});
    expect(school.slug).toBe("moli");
    expect(school.timeZone).toBe("Pacific/Honolulu");
  });

  test("school_admin cannot use scope to read or edit another school", async () => {
    const t = convexTest(schema, modules);
    const { moli, nuni } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    // Read: a Nuni scope is NOT honored — falls back to Hoku's own school.
    const school = await asHoku.query(api.institutions.getMySchool, {
      scope: "nuni",
    });
    expect(school.slug).toBe("moli");

    // Write: the same fail-safe — the patch lands on Moli, never Nuni.
    const saved = await asHoku.mutation(api.institutions.updateSettings, {
      name: "Sneaky Rename",
      emoji: "🏴",
      scope: "nuni",
    });
    expect(saved.slug).toBe("moli");
    const rows = await t.run(async (ctx) => ({
      moli: await ctx.db.get(moli),
      nuni: await ctx.db.get(nuni),
    }));
    expect(rows.moli?.name).toBe("Sneaky Rename");
    expect(rows.nuni?.name).toBe("Nuni School");
    expect(rows.nuni?.emoji).toBe("🌋");
  });
});

describe("listInstitutionStaff — institution lens", () => {
  async function seedStaffAcrossSchools(t: ReturnType<typeof convexTest>) {
    const { moli, nuni } = await seedInstitutions(t);
    await seedUser(t, "teacher", "teach-moli", moli);
    await seedUser(t, "teacher", "teach-nuni", nuni);
    return { moli, nuni };
  }

  test("platform admin + no scope lists every institution's staff (today's behavior)", async () => {
    const t = convexTest(schema, modules);
    await seedStaffAcrossSchools(t);
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);

    const staff = await asAvery.query(api.users.listInstitutionStaff, {});
    const usernames = staff.map((s) => s.username).sort();
    expect(usernames).toEqual(["teach-moli", "teach-nuni"]);
  });

  test("platform admin + scope narrows to the lensed institution", async () => {
    const t = convexTest(schema, modules);
    await seedStaffAcrossSchools(t);
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);

    const nuniStaff = await asAvery.query(api.users.listInstitutionStaff, {
      scope: "nuni",
    });
    expect(nuniStaff.map((s) => s.username)).toEqual(["teach-nuni"]);

    const moliStaff = await asAvery.query(api.users.listInstitutionStaff, {
      scope: "moli",
    });
    expect(moliStaff.map((s) => s.username)).toEqual(["teach-moli"]);
  });

  test("school_admin cannot use scope to see another school's staff", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedStaffAcrossSchools(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    // A Nuni scope is not honored — Hoku only ever sees his own school's staff
    // (himself + the Moli teacher), never the Nuni teacher.
    const staff = await asHoku.query(api.users.listInstitutionStaff, {
      scope: "nuni",
    });
    const usernames = staff.map((s) => s.username).sort();
    expect(usernames).toEqual(["hoku", "teach-moli"]);
  });
});

describe("listAllParents — institution lens", () => {
  async function seedFamiliesAcrossSchools(t: ReturnType<typeof convexTest>) {
    const { moli, nuni } = await seedInstitutions(t);
    const scholarMoli = await seedUser(t, "scholar", "s-moli", moli);
    const scholarNuni = await seedUser(t, "scholar", "s-nuni", nuni);
    const parentMoli = await seedParent(t, "p-moli");
    const parentNuni = await seedParent(t, "p-nuni");
    await linkGuardian(t, parentMoli, scholarMoli);
    await linkGuardian(t, parentNuni, scholarNuni);
    return { moli, nuni, scholarMoli, scholarNuni, parentMoli, parentNuni };
  }

  test("platform admin + no scope lists every parent (today's behavior)", async () => {
    const t = convexTest(schema, modules);
    await seedFamiliesAcrossSchools(t);
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);

    const parents = await asAvery.query(api.parents.listAllParents, {});
    expect(parents.map((p) => p.name).sort()).toEqual([
      "Test p-moli",
      "Test p-nuni",
    ]);
  });

  test("scope narrows to parents whose children are in the lens", async () => {
    const t = convexTest(schema, modules);
    await seedFamiliesAcrossSchools(t);
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);

    const moliParents = await asAvery.query(api.parents.listAllParents, {
      scope: "moli",
    });
    expect(moliParents.map((p) => p.name)).toEqual(["Test p-moli"]);

    const nuniParents = await asAvery.query(api.parents.listAllParents, {
      scope: "nuni",
    });
    expect(nuniParents.map((p) => p.name)).toEqual(["Test p-nuni"]);
  });

  test("operations staff cannot use scope to see another school's families", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedFamiliesAcrossSchools(t);
    const reg = await seedOperationsStaffLocal(t, "reg", moli);
    const asReg = await withUser(t, reg);

    // A Nuni scope is not honored — operations staff falls back to their own
    // (primary) school, so only the Moli family is visible.
    const parents = await asReg.query(api.parents.listAllParents, {
      scope: "nuni",
    });
    expect(parents.map((p) => p.name)).toEqual(["Test p-moli"]);
  });

  test("non-admin staff + no scope only sees home-institution families and children", async () => {
    const t = convexTest(schema, modules);
    const { moli, scholarNuni, parentMoli } = await seedFamiliesAcrossSchools(t);
    await linkGuardian(t, parentMoli, scholarNuni);
    const reg = await seedOperationsStaffLocal(t, "reg", moli);
    const asReg = await withUser(t, reg);

    const parents = await asReg.query(api.parents.listAllParents, {});

    expect(parents.map((p) => p.name)).toEqual(["Test p-moli"]);
    expect(parents[0]?.children.map((c) => c.name)).toEqual(["Test s-moli"]);
  });
});

describe("institution logo", () => {
  test("school_admin uploads a logo for their own institution", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    const storageId = await storeBlob(t, "image/png");
    const result = await asHoku.mutation(api.institutions.setLogo, {
      storageId,
      contentType: "image/png",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.logoUrl).toBeTruthy();

    const row = await institutionRow(t, moli);
    expect(row?.logoStorageId).toBe(storageId);
    expect(await blobExists(t, storageId)).toBe(true);

    // getMySchool now serves the uploaded logo alongside the emoji fallback.
    const school = await asHoku.query(api.institutions.getMySchool, {});
    expect(school.logoUrl).toBeTruthy();
    expect(school.emoji).toBe("🏫");
  });

  test("rejects a non-image content type and frees the blob", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    const storageId = await storeBlob(t, "text/html");
    const result = await asHoku.mutation(api.institutions.setLogo, {
      storageId,
      contentType: "text/html",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/unsupported image type/i);

    // The rejected upload is freed, and no logo was attached.
    expect(await blobExists(t, storageId)).toBe(false);
    expect((await institutionRow(t, moli))?.logoStorageId).toBeUndefined();
  });

  test("rejects an oversize image and frees the blob", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    const storageId = await storeBlob(
      t,
      "image/png",
      MAX_PROFILE_IMAGE_BYTES + 1,
    );
    const result = await asHoku.mutation(api.institutions.setLogo, {
      storageId,
      contentType: "image/png",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/too large/i);

    expect(await blobExists(t, storageId)).toBe(false);
    expect((await institutionRow(t, moli))?.logoStorageId).toBeUndefined();
  });

  test("replacing a logo deletes an unreferenced previous blob", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    const first = await storeBlob(t, "image/png");
    await asHoku.mutation(api.institutions.setLogo, { storageId: first, contentType: "image/png" });
    const second = await storeBlob(t, "image/jpeg");
    await asHoku.mutation(api.institutions.setLogo, { storageId: second, contentType: "image/jpeg" });

    // The old blob is gone; the row points at the new one.
    expect(await blobExists(t, first)).toBe(false);
    expect(await blobExists(t, second)).toBe(true);
    expect((await institutionRow(t, moli))?.logoStorageId).toBe(second);
  });

  test("replacing a stale missing logo still assigns the new blob", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    const stale = await storeBlob(t, "image/png");
    await asHoku.mutation(api.institutions.setLogo, {
      storageId: stale,
      contentType: "image/png",
    });
    await t.run(async (ctx) => ctx.storage.delete(stale));

    const replacement = await storeBlob(t, "image/jpeg");
    await asHoku.mutation(api.institutions.setLogo, {
      storageId: replacement,
      contentType: "image/jpeg",
    });

    expect(await blobExists(t, replacement)).toBe(true);
    expect((await institutionRow(t, moli))?.logoStorageId).toBe(replacement);
  });

  test("replacing a shared logo preserves it until the final reference clears", async () => {
    const t = convexTest(schema, modules);
    const { moli, nuni } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const kimo = await seedUser(t, "school_admin", "kimo", nuni);
    const asHoku = await withUser(t, hoku);
    const asKimo = await withUser(t, kimo);

    const shared = await storeBlob(t, "image/png");
    await asHoku.mutation(api.institutions.setLogo, {
      storageId: shared,
      contentType: "image/png",
    });
    await asKimo.mutation(api.institutions.setLogo, {
      storageId: shared,
      contentType: "image/png",
    });

    const replacement = await storeBlob(t, "image/jpeg");
    await asHoku.mutation(api.institutions.setLogo, {
      storageId: replacement,
      contentType: "image/jpeg",
    });
    expect(await blobExists(t, shared)).toBe(true);
    expect(await blobExists(t, replacement)).toBe(true);
    expect((await institutionRow(t, moli))?.logoStorageId).toBe(replacement);
    expect((await institutionRow(t, nuni))?.logoStorageId).toBe(shared);

    await asKimo.mutation(api.institutions.removeLogo, {});
    expect(await blobExists(t, shared)).toBe(false);
  });

  test("removeLogo clears the field and deletes the blob", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    const storageId = await storeBlob(t, "image/webp");
    await asHoku.mutation(api.institutions.setLogo, { storageId, contentType: "image/webp" });
    await asHoku.mutation(api.institutions.removeLogo, {});

    expect(await blobExists(t, storageId)).toBe(false);
    expect((await institutionRow(t, moli))?.logoStorageId).toBeUndefined();
  });

  test("removeLogo clears a stale reference when its blob is already missing", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    const storageId = await storeBlob(t, "image/webp");
    await asHoku.mutation(api.institutions.setLogo, {
      storageId,
      contentType: "image/webp",
    });
    await t.run(async (ctx) => ctx.storage.delete(storageId));

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await asHoku.mutation(api.institutions.removeLogo, {});
    } finally {
      warning.mockRestore();
    }

    expect((await institutionRow(t, moli))?.logoStorageId).toBeUndefined();
  });

  test("discardLogoUpload frees an unattached blob but never an in-use one", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    // An orphaned upload (never attached) is reclaimed.
    const orphan = await storeBlob(t, "image/png");
    await asHoku.mutation(api.institutions.discardLogoUpload, {
      storageId: orphan,
    });
    expect(await blobExists(t, orphan)).toBe(false);

    // A blob that IS the institution's logo is protected from discard.
    const attached = await storeBlob(t, "image/png");
    await asHoku.mutation(api.institutions.setLogo, {
      storageId: attached,
      contentType: "image/png",
    });
    await asHoku.mutation(api.institutions.discardLogoUpload, {
      storageId: attached,
    });
    expect(await blobExists(t, attached)).toBe(true);
    expect((await institutionRow(t, moli))?.logoStorageId).toBe(attached);
  });

  test("a school_admin cannot set another school's logo (scope fail-safe)", async () => {
    const t = convexTest(schema, modules);
    const { moli, nuni } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);

    // An un-honored `nuni` scope falls back to Hoku's own school — the logo
    // lands on Moli, never Nuni.
    const storageId = await storeBlob(t, "image/png");
    await asHoku.mutation(api.institutions.setLogo, {
      storageId,
      contentType: "image/png",
      scope: "nuni",
    });

    expect((await institutionRow(t, moli))?.logoStorageId).toBe(storageId);
    expect((await institutionRow(t, nuni))?.logoStorageId).toBeUndefined();
  });

  test("operations staff cannot set a logo", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaffLocal(t, "reg", moli);
    const asReg = await withUser(t, reg);

    const storageId = await storeBlob(t, "image/png");
    await expect(
      asReg.mutation(api.institutions.setLogo, { storageId, contentType: "image/png" }),
    ).rejects.toThrow(/forbidden/i);
    expect((await institutionRow(t, moli))?.logoStorageId).toBeUndefined();
  });
});
