import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role = "scholar" | "teacher";

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  slug: string,
): Promise<Id<"institutions">> {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", { name: slug, slug, kind: "school" }),
  );
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  institutionId?: Id<"institutions">,
): Promise<Id<"users">> {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `${role} ${Math.random().toString(36).slice(2, 8)}`,
      username: `${role}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      ...(institutionId ? { institutionId } : {}),
    }),
  );
}

async function asUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function grantTeacherMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run((ctx) =>
    ctx.db.insert("memberships", { userId, role: "teacher", institutionId }),
  );
}

const client = {
  deviceId: "heartbeat-device-001",
  channel: "stable" as const,
  appVersion: "1.2.3",
  buildNumber: "45",
  gitSha: "abcdef1",
};

describe("native client heartbeat", () => {
  test("upserts a build report and derives managed status from the server claim", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const scholarId = await seedUser(t, "scholar", institutionId);
    const managedDeviceId = await t.run((ctx) =>
      ctx.db.insert("managedDeviceClaims", {
        institutionId,
        serial: "HEARTBEAT001",
        scholarId,
        claimTokenHash: "not-a-real-token",
        claimState: "claimed",
        createdBy: scholarId,
        createdAt: 1,
        updatedAt: 1,
        claimIssuedAt: 1,
        rotationCount: 0,
        claimCount: 1,
        lastDeviceId: client.deviceId,
      }),
    );
    const scholar = await asUser(t, scholarId);

    await expect(
      scholar.mutation(api.nativeClientHeartbeat.record, client),
    ).resolves.toMatchObject({ managed: true });
    await scholar.mutation(api.nativeClientHeartbeat.record, {
      ...client,
      channel: "canary",
      appVersion: "1.2.4",
      buildNumber: "46",
      gitSha: "abcdef2",
    });

    const rows = await t.run((ctx) =>
      ctx.db.query("nativeClientHeartbeats").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: scholarId,
      institutionId,
      deviceId: client.deviceId,
      channel: "canary",
      appVersion: "1.2.4",
      buildNumber: "46",
      gitSha: "abcdef2",
      managedDeviceId,
    });

    const teacherId = await seedUser(t, "teacher");
    await grantTeacherMembership(t, teacherId, institutionId);
    const teacher = await asUser(t, teacherId);
    await expect(
      teacher.query(api.nativeClientHeartbeat.listForInstitution, {}),
    ).resolves.toMatchObject([{ managed: true }]);

    await t.run((ctx) =>
      ctx.db.patch(managedDeviceId, { claimState: "revoked" }),
    );
    await expect(
      teacher.query(api.nativeClientHeartbeat.listForInstitution, {}),
    ).resolves.toMatchObject([{ managed: false }]);
  });

  test("does not let a user classify an unclaimed personal client as managed", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const scholarId = await seedUser(t, "scholar", institutionId);
    const scholar = await asUser(t, scholarId);

    await expect(
      scholar.mutation(api.nativeClientHeartbeat.record, client),
    ).resolves.toMatchObject({ managed: false });

    const row = await t.run((ctx) =>
      ctx.db.query("nativeClientHeartbeats").unique(),
    );
    expect(row?.managedDeviceId).toBeUndefined();
  });

  test("lists only heartbeats in the caller's permitted institution lens", async () => {
    const t = convexTest(schema, modules);
    const moli = await seedInstitution(t, "moli");
    const guests = await seedInstitution(t, "guests");
    const teacherId = await seedUser(t, "teacher");
    await grantTeacherMembership(t, teacherId, moli);
    const moliScholar = await seedUser(t, "scholar", moli);
    const guestScholar = await seedUser(t, "scholar", guests);
    const asMoliScholar = await asUser(t, moliScholar);
    const asGuestScholar = await asUser(t, guestScholar);
    const teacher = await asUser(t, teacherId);

    await asMoliScholar.mutation(api.nativeClientHeartbeat.record, client);
    await asGuestScholar.mutation(api.nativeClientHeartbeat.record, {
      ...client,
      deviceId: "heartbeat-device-002",
    });

    await expect(
      teacher.query(api.nativeClientHeartbeat.listForInstitution, {
        institutionScope: "guests",
      }),
    ).resolves.toMatchObject([
      {
        userId: moliScholar,
        deviceId: client.deviceId,
        managed: false,
      },
    ]);
  });
});
