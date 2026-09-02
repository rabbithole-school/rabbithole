import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  grantStaffCapability,
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
  role: "scholar" | "teacher" | "staff" = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  const institutionId = await seedTestInstitution(t);
  const options = {
    institutionId,
    name: overrides.name ?? `Test ${role}`,
    username: overrides.username ?? `test${role}`,
  };
  if (role === "scholar") return seedScholarInInstitution(t, options);
  const userId = await seedStaffWithMembership(t, { ...options, role });
  if (role === "staff") {
    // Operations staff (the retired registrar role's successor): a base
    // `staff` user needs the `school:operations` capability grant to
    // satisfy `requireScholarAdmin`'s capability check.
    await grantStaffCapability(t, userId, institutionId, "school:operations");
  }
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

async function seedPasskey(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  return await t.run(async (ctx) =>
    ctx.db.insert("passkeys", {
      userId,
      credentialId: `cred-${String(userId)}`,
      publicKey: "publickey-base64url",
      counter: 0,
      createdAt: Date.now(),
    }),
  );
}

describe("passkeys.resetForScholar", () => {
  test("teacher removes all of a scholar's passkeys", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    await seedPasskey(t, scholarId);
    await seedPasskey(t, scholarId);

    const asTeacher = await withUser(t, teacherId);
    const res = await asTeacher.mutation(api.passkeys.resetForScholar, { scholarId });
    expect(res.removed).toBe(2);

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("passkeys")
        .withIndex("by_user", (q) => q.eq("userId", scholarId))
        .collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  test("operations staff can reset (scholar-account admin; the retired registrar role's successor)", async () => {
    const t = convexTest(schema, modules);
    const registrarId = await seedUser(t, "staff");
    const scholarId = await seedUser(t, "scholar");
    await seedPasskey(t, scholarId);

    const asRegistrar = await withUser(t, registrarId);
    const res = await asRegistrar.mutation(api.passkeys.resetForScholar, { scholarId });
    expect(res.removed).toBe(1);
  });

  test("a scholar cannot reset anyone's passkeys", async () => {
    const t = convexTest(schema, modules);
    const scholarA = await seedUser(t, "scholar", { username: "kidA" });
    const scholarB = await seedUser(t, "scholar", { username: "kidB" });
    await seedPasskey(t, scholarB);

    const asScholar = await withUser(t, scholarA);
    await expect(
      asScholar.mutation(api.passkeys.resetForScholar, { scholarId: scholarB }),
    ).rejects.toThrow();
  });

  test("cannot target a staff account (staff recovery uses enrollment.adminResetPasskeys)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "t1" });
    const otherTeacherId = await seedUser(t, "teacher", { username: "t2" });
    await seedPasskey(t, otherTeacherId);

    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.mutation(api.passkeys.resetForScholar, { scholarId: otherTeacherId }),
    ).rejects.toThrow(/Forbidden|only reset scholar/i);
  });
});

describe("passkeys.countForScholar", () => {
  test("teacher sees the count; scholar callers are rejected", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    await seedPasskey(t, scholarId);

    const asTeacher = await withUser(t, teacherId);
    expect(
      await asTeacher.query(api.passkeys.countForScholar, { scholarId }),
    ).toBe(1);

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.passkeys.countForScholar, { scholarId }),
    ).rejects.toThrow();
  });
});
