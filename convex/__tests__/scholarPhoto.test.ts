import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  assertAllowedProfileImage,
  MAX_PROFILE_IMAGE_BYTES,
} from "../lib/profileImage";
import { seedScholarInInstitution, seedStaffWithMembership, seedOperationsStaff, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: a scholar's avatar (users.image) may be set by the scholar
// themselves, by a scholar-admin (teacher/admin/staff-with-school:operations,
// the retired registrar role's successor) via
// users.adminUpdateScholarProfile, OR by a linked GUARDIAN via
// parents.setChildPhoto. Every path funnels through the shared profile-image
// validator (allowed image MIME + ≤5 MB). Coverage is split deliberately:
//
//  1. The MIME + size CONTRACT is proven directly against the pure
//     `assertAllowedProfileImage` predicate. It has to be a unit test:
//     convex-test's storage mock records only `size` + `sha256` and NEVER a
//     content-type (verified against convex-test 0.0.54's DatabaseFake), so a
//     mutation reading `metadata.contentType` always sees `undefined` there —
//     the accept path can't be exercised through the mock.
//  2. The AUTHORIZATION + shape are proven through the real mutations:
//     the guardianship gate (own child only), the scholar-role check, and that
//     listAllParents exposes `image`. A stored-blob call reaches validation and
//     is rejected as "unsupported image type" (no content-type in the mock),
//     which also confirms the caller cleared the gate + role checks.

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "curriculum_designer"
  | "parent";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  email?: string,
) {
  const name = `Test ${username}`;
  if (role === "parent" || role === "platform_admin" || role === "curriculum_designer") {
    return t.run((ctx) => ctx.db.insert("users", { name, username, role, email }));
  }
  const institutionId = await seedTestInstitution(t);
  const userId = role === "scholar"
    ? await seedScholarInInstitution(t, { institutionId, name, username })
    : await seedStaffWithMembership(t, { institutionId, name, username, role });
  if (email) await t.run((ctx) => ctx.db.patch(userId, { email }));
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

// ── Local helpers ─────────────────────────────────────────────────────

async function linkGuardian(
  t: ReturnType<typeof convexTest>,
  parentUserId: Id<"users">,
  scholarUserId: Id<"users">,
  createdBy: Id<"users">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId,
      scholarUserId,
      createdBy,
    }),
  );
}

/** Store a blob and return its storageId. (convex-test records size+sha256.) */
async function storeBlob(
  t: ReturnType<typeof convexTest>,
  type: string,
  size = 8,
) {
  return await t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array(size)], { type })),
  );
}

async function getUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  return await t.run(async (ctx) => ctx.db.get(userId));
}

// ── The validation contract (pure predicate) ─────────────────────────

describe("assertAllowedProfileImage", () => {
  test("accepts every allowed image type", () => {
    for (const mime of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]) {
      expect(assertAllowedProfileImage(mime, 1024)).toBe(mime);
    }
  });

  test("rejects a non-image content type (application/pdf)", () => {
    expect(() => assertAllowedProfileImage("application/pdf", 1024)).toThrow(
      /unsupported image type/i,
    );
  });

  test("rejects SVG (the XSS-shaped type) even though it is image/*", () => {
    expect(() =>
      assertAllowedProfileImage("image/svg+xml", 1024),
    ).toThrow(/unsupported image type/i);
  });

  test("rejects a missing / empty content type", () => {
    expect(() => assertAllowedProfileImage(undefined, 1024)).toThrow(
      /unsupported image type/i,
    );
    expect(() => assertAllowedProfileImage("", 1024)).toThrow(
      /unsupported image type/i,
    );
  });

  test("rejects a file over the 5 MB cap", () => {
    expect(() =>
      assertAllowedProfileImage("image/png", MAX_PROFILE_IMAGE_BYTES + 1),
    ).toThrow(/too large/i);
  });

  test("accepts a file exactly at the cap", () => {
    expect(
      assertAllowedProfileImage("image/png", MAX_PROFILE_IMAGE_BYTES),
    ).toBe("image/png");
  });
});

// ── parents.setChildPhoto — guardian-gated ────────────────────────────

describe("parents.setChildPhoto", () => {
  test("a non-guardian parent is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent", "pat", "pat@home.com");
    const otherKid = await seedUser(t, "scholar", "lani");
    const storageId = await storeBlob(t, "image/png");

    const asParent = await withUser(t, parent);
    await expect(
      asParent.mutation(api.parents.setChildPhoto, {
        scholarId: otherKid,
        imageStorageId: storageId,
      }),
    ).rejects.toThrow(/not a guardian/i);
    // Nothing was written.
    expect((await getUser(t, otherKid))?.image).toBeUndefined();
  });

  test("a scholar cannot set their own photo via this mutation", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", "kai");
    const storageId = await storeBlob(t, "image/png");

    const asScholar = await withUser(t, kai);
    // No guardianship (a scholar is never their own guardian) → Forbidden.
    await expect(
      asScholar.mutation(api.parents.setChildPhoto, {
        scholarId: kai,
        imageStorageId: storageId,
      }),
    ).rejects.toThrow(/not a guardian/i);
  });

  test("a guardian of a non-scholar target is rejected (role check)", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent", "pat", "pat@home.com");
    // Link the guardian to a NON-scholar user (guardianships store any userId).
    const teacher = await seedUser(t, "teacher", "tt");
    await linkGuardian(t, parent, teacher, parent);
    const storageId = await storeBlob(t, "image/png");

    const asParent = await withUser(t, parent);
    await expect(
      asParent.mutation(api.parents.setChildPhoto, {
        scholarId: teacher,
        imageStorageId: storageId,
      }),
    ).rejects.toThrow(/Forbidden|scholar not found/i);
  });

  test("a linked guardian clears the gate + role and reaches image validation", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent", "pat", "pat@home.com");
    const kai = await seedUser(t, "scholar", "kai");
    await linkGuardian(t, parent, kai, parent);
    const storageId = await storeBlob(t, "application/pdf");

    const asParent = await withUser(t, parent);
    // The guardian passes requireGuardianOf + the scholar-role check; the only
    // thing that stops the write is the image validator (a non-image upload,
    // and — under the convex-test storage mock — an absent content-type). In
    // production a real image's content-type lands the URL; that accept path is
    // proven by the assertAllowedProfileImage unit tests above.
    await expect(
      asParent.mutation(api.parents.setChildPhoto, {
        scholarId: kai,
        imageStorageId: storageId,
      }),
    ).rejects.toThrow(/unsupported image type/i);
    expect((await getUser(t, kai))?.image).toBeUndefined();
  });
});

// ── Operations-staff path (users.adminUpdateScholarProfile) ───────────
// (the retired registrar role's successor: a staff user with the
// school:operations capability grant)

describe("users.adminUpdateScholarProfile — photo", () => {
  test("a non-scholar target is rejected before touching the image", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const reg = await seedOperationsStaff(t, { institutionId, username: "reg" });
    const otherTeacher = await seedUser(t, "teacher", "tt");
    const storageId = await storeBlob(t, "image/jpeg");

    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.users.adminUpdateScholarProfile, {
        scholarId: otherTeacher,
        imageStorageId: storageId,
      }),
    ).rejects.toThrow(/Forbidden|scholar not found/i);
  });

  test("operations staff reaches the SAME image validation for a scholar", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const reg = await seedOperationsStaff(t, { institutionId, username: "reg" });
    const kai = await seedScholarInInstitution(t, { institutionId, username: "kai" });
    const storageId = await storeBlob(t, "application/pdf");

    const asReg = await withUser(t, reg);
    // Operations staff is authorized (scholar-admin via the school:operations
    // capability grant) and hits the shared validator — same "unsupported
    // image type" rejection as the parent path, proving the MIME contract is
    // identical no matter who sets the avatar.
    await expect(
      asReg.mutation(api.users.adminUpdateScholarProfile, {
        scholarId: kai,
        imageStorageId: storageId,
      }),
    ).rejects.toThrow(/unsupported image type/i);
    expect((await getUser(t, kai))?.image).toBeUndefined();
  });
});

// ── listAllParents exposes `image` for the directory UI ───────────────

describe("parents.listAllParents", () => {
  test("scholar rows include `image`", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const parent = await seedUser(t, "parent", "pat", "pat@home.com");
    const kai = await seedUser(t, "scholar", "kai");
    await linkGuardian(t, parent, kai, admin);
    // Give the scholar a known avatar URL.
    await t.run(async (ctx) =>
      ctx.db.patch(kai, { image: "https://example.com/kai.png" }),
    );

    const asAdmin = await withUser(t, admin);
    const rows = await asAdmin.query(api.parents.listAllParents, {});
    const patRow = rows.find((r) => r._id === parent);
    expect(patRow).toBeDefined();
    const kaiRow = patRow!.children.find((c) => c._id === kai);
    expect(kaiRow).toBeDefined();
    expect(kaiRow).toHaveProperty("image", "https://example.com/kai.png");
  });

  test("scholar rows carry `image: null` when unset", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const parent = await seedUser(t, "parent", "pat", "pat@home.com");
    const kai = await seedUser(t, "scholar", "kai");
    await linkGuardian(t, parent, kai, admin);

    const asAdmin = await withUser(t, admin);
    const rows = await asAdmin.query(api.parents.listAllParents, {});
    const kaiRow = rows
      .find((r) => r._id === parent)!
      .children.find((c) => c._id === kai);
    expect(kaiRow).toHaveProperty("image", null);
  });
});
