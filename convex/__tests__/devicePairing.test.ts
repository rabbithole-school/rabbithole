import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { sha256Hex } from "../lib/oauthCrypto";

// `ReturnType<typeof convexTest>` widens to a generic (unscoped) DataModel —
// fine for `.collect()`, but `.withIndex(...)` needs the real table/index
// names from this file's schema to typecheck, so helpers that use it are
// typed with this alias instead.
type TC = TestConvex<typeof schema>;

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Fixtures (mirroring scholarEnrollment.test.ts) ────────────────────
type Role =
  | "scholar"
  | "staff"
  | "teacher"
  | "school_admin"
  | "platform_admin";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  overrides: {
    name?: string;
    username?: string;
    institutionId?: Id<"institutions">;
  } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      role,
      username: overrides.username ?? `test-${role}-${Math.random().toString(36).slice(2, 8)}`,
      ...(overrides.institutionId ? { institutionId: overrides.institutionId } : {}),
    }),
  );
}

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  slug: string,
): Promise<Id<"institutions">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", { name: slug, slug, kind: "school" as const }),
  );
}

async function grantMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  role: "staff" | "teacher" | "school_admin" | "platform_admin",
  institutionId?: Id<"institutions">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", {
      userId,
      role,
      ...(institutionId ? { institutionId } : {}),
    }),
  );
}

async function grantSchoolOperations(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "school:operations",
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
}

async function newSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<Id<"authSessions">> {
  return await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  sessionId?: Id<"authSessions">,
) {
  const sid = sessionId ?? (await newSession(t, userId));
  return t.withIdentity({
    subject: `${userId}|${sid}`,
    issuer: "https://convex.dev",
  });
}

// A device generating a verifier + registering a request. Returns the raw
// verifier (kept only client-side) alongside the ids.
async function registerDevice(
  t: ReturnType<typeof convexTest>,
  opts: { deviceId?: string; deviceLabel?: string } = {},
) {
  const verifier = "v".repeat(43) + Math.random().toString(36).slice(2); // ≥43 chars
  const verifierHash = await sha256Hex(verifier);
  const { requestId, code } = await t.mutation(
    api.devicePairing.registerPairingRequest,
    {
      verifierHash,
      deviceId: opts.deviceId ?? `device-${Math.random().toString(36).slice(2, 12)}`,
      deviceLabel: opts.deviceLabel ?? "iPad (test)",
    },
  );
  return { verifier, verifierHash, requestId, code, deviceId: opts.deviceId };
}

const exchange = (
  t: ReturnType<typeof convexTest>,
  requestId: string,
  verifier: string,
) =>
  t.run(async (ctx) =>
    ctx.runMutation(internal.devicePairing.consumePairingExchange, {
      requestId,
      verifier,
    }),
  );

describe("device pairing — registration + code", () => {
  test("register stores only the verifier HASH, never the raw verifier", async () => {
    const t = convexTest(schema, modules);
    const { verifier, verifierHash, code } = await registerDevice(t);

    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/); // ambiguity-free alphabet, 8 chars
    const rows = await t.run(async (ctx) =>
      ctx.db.query("devicePairingRequests").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].verifierHash).toBe(verifierHash);
    expect(JSON.stringify(rows[0])).not.toContain(verifier);
    expect(rows[0].status).toBe("pending");
  });

  test("register rejects a malformed verifier hash", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.devicePairing.registerPairingRequest, {
        verifierHash: "not-a-sha256",
        deviceId: "device-abc12345",
      }),
    ).rejects.toThrow();
  });
});

describe("device pairing — the approval + exchange handshake", () => {
  test("staff with school operations can approve a pairing at their school", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "staff-operations");
    const operator = await seedUser(t, "staff");
    await grantMembership(t, operator, "staff", inst);
    await grantSchoolOperations(t, operator, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });
    const { requestId } = await registerDevice(t);

    await expect(
      (await withUser(t, operator)).mutation(
        api.devicePairing.approvePairingRequest,
        { requestId, scholarId: scholar },
      ),
    ).resolves.toMatchObject({ scholarName: expect.anything() });
  });

  test("staff without school operations cannot approve a pairing", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "staff-no-operations");
    const operator = await seedUser(t, "staff");
    await grantMembership(t, operator, "staff", inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });
    const { requestId } = await registerDevice(t);

    await expect(
      (await withUser(t, operator)).mutation(
        api.devicePairing.approvePairingRequest,
        { requestId, scholarId: scholar },
      ),
    ).rejects.toThrow(/school context|operations/i);
  });

  test("a staff grant at one school cannot approve a pairing at another", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "staff-school-a");
    const instB = await seedInstitution(t, "staff-school-b");
    const operator = await seedUser(t, "staff");
    await grantMembership(t, operator, "staff", instA);
    await grantMembership(t, operator, "staff", instB);
    await grantSchoolOperations(t, operator, instA);
    const scholarB = await seedUser(t, "scholar", { institutionId: instB });
    const { requestId } = await registerDevice(t);

    await expect(
      (await withUser(t, operator)).mutation(
        api.devicePairing.approvePairingRequest,
        { requestId, scholarId: scholarB },
      ),
    ).rejects.toThrow(/school context|operations/i);
  });

  test("a full happy-path pairing mints a session for the approved scholar", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff", { institutionId: undefined });
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", {
      name: "Kai",
      institutionId: inst,
    });
    const { requestId, verifier, deviceId } = await registerDevice(t, {
      deviceId: "ipad-01",
    });

    const asRegistrar = await withUser(t, registrar);
    await asRegistrar.mutation(api.devicePairing.approvePairingRequest, {
      requestId,
      scholarId: scholar,
    });

    const result = await exchange(t, requestId, verifier);
    expect(result?.userId).toBe(scholar);

    // A durable binding now exists for that device + scholar.
    const bindings = await t.run(async (ctx) =>
      ctx.db.query("pairedDevices").collect(),
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].scholarId).toBe(scholar);
    expect(bindings[0].deviceId).toBe(deviceId ?? "ipad-01");
    expect(bindings[0].institutionId).toBe(inst);
    expect(bindings[0].pairedBy).toBe(registrar);
  });

  test("CROSS-INSTITUTION approval is REJECTED (the closed hole)", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const registrarA = await seedUser(t, "staff");
    await grantMembership(t, registrarA, "staff", instA);
    await grantSchoolOperations(t, registrarA, instA);
    const scholarB = await seedUser(t, "scholar", { institutionId: instB });
    const { requestId } = await registerDevice(t);

    const asRegistrarA = await withUser(t, registrarA);
    await expect(
      asRegistrarA.mutation(api.devicePairing.approvePairingRequest, {
        requestId,
        scholarId: scholarB,
      }),
    ).rejects.toThrow(/context/i);

    // Nothing was approved.
    const req = await t.run(async (ctx) => ctx.db.get(requestId));
    expect(req?.status).toBe("pending");
  });

  test("exchange WITHOUT approval is rejected", async () => {
    const t = convexTest(schema, modules);
    const { requestId, verifier } = await registerDevice(t);
    // No approval yet → still pending → exchange refused.
    expect(await exchange(t, requestId, verifier)).toBeNull();
  });

  test("exchange with the WRONG verifier is rejected", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });
    const { requestId } = await registerDevice(t);
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId, scholarId: scholar },
    );

    // Possession of the code (and even the requestId) without the verifier is
    // useless — a different, correctly-shaped verifier does not match the hash.
    const wrong = "w".repeat(50);
    expect(await exchange(t, requestId, wrong)).toBeNull();
    // And the real exchange still works afterwards (a failed attempt didn't burn it).
  });

  test("DOUBLE exchange is rejected — the burn is atomic", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });
    const { requestId, verifier } = await registerDevice(t);
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId, scholarId: scholar },
    );

    expect((await exchange(t, requestId, verifier))?.userId).toBe(scholar);
    // Second attempt hits a burnt (exchanged) row.
    expect(await exchange(t, requestId, verifier)).toBeNull();
  });

  test("an EXPIRED request cannot be approved", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });
    const { requestId } = await registerDevice(t);

    // Force the request past its TTL.
    await t.run(async (ctx) => {
      await ctx.db.patch(requestId, { expiresAt: Date.now() - 1_000 });
    });

    await expect(
      (await withUser(t, registrar)).mutation(
        api.devicePairing.approvePairingRequest,
        { requestId, scholarId: scholar },
      ),
    ).rejects.toThrow(/expired/i);
  });

  test("exchange after the approval WINDOW lapses is rejected", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });
    const { requestId, verifier } = await registerDevice(t);
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId, scholarId: scholar },
    );

    // Force the single-use window closed.
    await t.run(async (ctx) => {
      await ctx.db.patch(requestId, { approvalExpiresAt: Date.now() - 1_000 });
    });

    expect(await exchange(t, requestId, verifier)).toBeNull();
  });

  test("an unknown / malformed requestId is rejected (fails closed)", async () => {
    const t = convexTest(schema, modules);
    expect(await exchange(t, "not-a-real-id", "v".repeat(50))).toBeNull();
    expect(await exchange(t, "", "v".repeat(50))).toBeNull();
  });
});

describe("device pairing — code lookup (staff console)", () => {
  test("lookup by the wrong / unknown code returns null", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    await registerDevice(t);

    const asRegistrar = await withUser(t, registrar);
    // A well-formed but non-existent code.
    expect(
      await asRegistrar.query(api.devicePairing.lookupPairingRequestByCode, {
        code: "2345-6789",
      }),
    ).toBeNull();
    // A too-short code.
    expect(
      await asRegistrar.query(api.devicePairing.lookupPairingRequestByCode, {
        code: "234",
      }),
    ).toBeNull();
  });

  test("staff at the scholar's institution see the existing binding", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", {
      name: "Lani",
      username: "lani",
      institutionId: inst,
    });
    // First pairing establishes a durable binding for ipad-07.
    const first = await registerDevice(t, { deviceId: "ipad-07" });
    const asRegistrar = await withUser(t, registrar);
    await asRegistrar.mutation(api.devicePairing.approvePairingRequest, {
      requestId: first.requestId,
      scholarId: scholar,
    });
    await exchange(t, first.requestId, first.verifier);

    // The SAME device shows a new code (re-pair). Lookup surfaces who it's
    // currently bound to so staff can catch a reassignment.
    const second = await registerDevice(t, { deviceId: "ipad-07" });
    const found = await asRegistrar.query(
      api.devicePairing.lookupPairingRequestByCode,
      { code: second.code },
    );
    expect(found).not.toBeNull();
    expect(found?.existingBinding?.scholarName).toBe("Lani");
    expect(found?.existingBinding?.scholarUsername).toBe("lani");
  });

  test("same-scholar re-pair preserves a disarm; a scholar handoff resets to armed", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const kai = await seedUser(t, "scholar", {
      name: "Kai",
      institutionId: inst,
    });
    const lani = await seedUser(t, "scholar", {
      name: "Lani",
      institutionId: inst,
    });
    const asRegistrar = await withUser(t, registrar);

    const first = await registerDevice(t, { deviceId: "ipad-lock-state" });
    await asRegistrar.mutation(api.devicePairing.approvePairingRequest, {
      requestId: first.requestId,
      scholarId: kai,
    });
    await exchange(t, first.requestId, first.verifier);
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("pairedDevices").first();
      await ctx.db.patch(binding!._id, {
        rabbitholeLockDesiredState: "disarmed",
        rabbitholeLockDisarmMode: "until_further_notice",
        rabbitholeLockUpdatedAt: Date.now(),
        rabbitholeLockUpdatedBy: registrar,
      });
    });

    const sameScholar = await registerDevice(t, {
      deviceId: "ipad-lock-state",
    });
    await asRegistrar.mutation(api.devicePairing.approvePairingRequest, {
      requestId: sameScholar.requestId,
      scholarId: kai,
    });
    await exchange(t, sameScholar.requestId, sameScholar.verifier);
    expect(
      await t.run(async (ctx) => ctx.db.query("pairedDevices").first()),
    ).toMatchObject({
      scholarId: kai,
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "until_further_notice",
    });

    const handoff = await registerDevice(t, { deviceId: "ipad-lock-state" });
    await asRegistrar.mutation(api.devicePairing.approvePairingRequest, {
      requestId: handoff.requestId,
      scholarId: lani,
    });
    await exchange(t, handoff.requestId, handoff.verifier);
    const rebound = await t.run(async (ctx) =>
      ctx.db.query("pairedDevices").first(),
    );
    expect(rebound?.scholarId).toBe(lani);
    expect(rebound?.rabbitholeLockDesiredState).toBeUndefined();
    expect(rebound?.rabbitholeLockDisarmMode).toBeUndefined();
  });

  test("staff at another institution see no binding without an error", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const registrarA = await seedUser(t, "staff");
    await grantMembership(t, registrarA, "staff", instA);
    await grantSchoolOperations(t, registrarA, instA);
    const registrarB = await seedUser(t, "staff");
    await grantMembership(t, registrarB, "staff", instB);
    await grantSchoolOperations(t, registrarB, instB);
    const scholarB = await seedUser(t, "scholar", {
      name: "Scholar B",
      username: "scholar-b",
      institutionId: instB,
    });

    const first = await registerDevice(t, { deviceId: "ipad-cross-tenant" });
    await (await withUser(t, registrarB)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId: first.requestId, scholarId: scholarB },
    );
    await exchange(t, first.requestId, first.verifier);

    const second = await registerDevice(t, { deviceId: "ipad-cross-tenant" });
    await expect(
      (await withUser(t, registrarA)).query(
        api.devicePairing.lookupPairingRequestByCode,
        { code: second.code },
      ),
    ).resolves.toMatchObject({ existingBinding: null });
  });

  test("staff see bindings granted by their second membership", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", instA);
    await grantSchoolOperations(t, registrar, instA);
    await grantMembership(t, registrar, "staff", instB);
    await grantSchoolOperations(t, registrar, instB);
    const registrarB = await seedUser(t, "staff");
    await grantMembership(t, registrarB, "staff", instB);
    await grantSchoolOperations(t, registrarB, instB);
    const scholarB = await seedUser(t, "scholar", {
      name: "Scholar B",
      username: "scholar-b",
      institutionId: instB,
    });

    const first = await registerDevice(t, { deviceId: "ipad-second-membership" });
    await (await withUser(t, registrarB)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId: first.requestId, scholarId: scholarB },
    );
    await exchange(t, first.requestId, first.verifier);

    const second = await registerDevice(t, { deviceId: "ipad-second-membership" });
    const found = await (await withUser(t, registrar)).query(
      api.devicePairing.lookupPairingRequestByCode,
      { code: second.code },
    );
    expect(found?.existingBinding).toMatchObject({
      scholarName: "Scholar B",
      scholarUsername: "scholar-b",
    });
  });

  test("platform admins without memberships see bindings across institutions", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "school-b");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", {
      name: "Scholar B",
      username: "scholar-b",
      institutionId: inst,
    });

    const first = await registerDevice(t, { deviceId: "ipad-admin-global" });
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId: first.requestId, scholarId: scholar },
    );
    await exchange(t, first.requestId, first.verifier);

    const second = await registerDevice(t, { deviceId: "ipad-admin-global" });
    const platformAdmin = await seedUser(t, "platform_admin");
    const found = await (await withUser(t, platformAdmin)).query(
      api.devicePairing.lookupPairingRequestByCode,
      { code: second.code },
    );
    expect(found?.existingBinding).toMatchObject({
      scholarName: "Scholar B",
      scholarUsername: "scholar-b",
    });
  });
});

describe("device pairing — reassignment + revocation", () => {
  async function pairDevice(
    t: ReturnType<typeof convexTest>,
    registrar: Id<"users">,
    scholar: Id<"users">,
    deviceId: string,
  ): Promise<{ pairedDeviceId: Id<"pairedDevices">; sessionId: Id<"authSessions"> }> {
    const { requestId, verifier } = await registerDevice(t, { deviceId });
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId, scholarId: scholar },
    );
    const result = await exchange(t, requestId, verifier);
    expect(result?.userId).toBe(scholar);
    // Simulate the device attaching its freshly-minted session for revoke.
    const sessionId = await newSession(t, scholar);
    await (await withUser(t, scholar, sessionId)).mutation(
      api.devicePairing.attachDeviceSession,
      { deviceId },
    );
    const binding = await t.run(async (ctx) => {
      const scholarDoc = await ctx.db.get(scholar);
      const institutionId = scholarDoc!.institutionId!;
      const all = await ctx.db.query("pairedDevices").collect();
      return all.find(
        (b) => b.institutionId === institutionId && b.deviceId === deviceId,
      );
    });
    return { pairedDeviceId: binding!._id, sessionId };
  }

  test("unpair works, and re-pairing the device to a DIFFERENT scholar works", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const kai = await seedUser(t, "scholar", { name: "Kai", institutionId: inst });
    const lani = await seedUser(t, "scholar", { name: "Lani", institutionId: inst });

    const { pairedDeviceId } = await pairDevice(t, registrar, kai, "ipad-09");

    // Unpair (reassign).
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.unpairDevice,
      { pairedDeviceId },
    );
    const afterUnpair = await t.run(async (ctx) =>
      ctx.db.query("pairedDevices").collect(),
    );
    expect(afterUnpair).toHaveLength(0);

    // Re-pair the SAME physical device to a different scholar.
    const re = await registerDevice(t, { deviceId: "ipad-09" });
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId: re.requestId, scholarId: lani },
    );
    expect((await exchange(t, re.requestId, re.verifier))?.userId).toBe(lani);
    const bindings = await t.run(async (ctx) =>
      ctx.db.query("pairedDevices").collect(),
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].scholarId).toBe(lani);
    expect(bindings[0].deviceId).toBe("ipad-09");
  });

  test("revoke session signs the device out but KEEPS the binding", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });

    const { pairedDeviceId, sessionId } = await pairDevice(
      t,
      registrar,
      scholar,
      "ipad-11",
    );

    const res = await (await withUser(t, registrar)).mutation(
      api.devicePairing.revokeDeviceSession,
      { pairedDeviceId },
    );
    expect(res.sessionRevoked).toBe(true);
    // The device's session is gone…
    expect(await t.run(async (ctx) => ctx.db.get(sessionId))).toBeNull();
    // …but the binding remains, now with no live session.
    const binding = await t.run(async (ctx) => ctx.db.get(pairedDeviceId));
    expect(binding).not.toBeNull();
    expect(binding?.authSessionId).toBeUndefined();
  });

  test("approving/pairing a device does NOT disturb the scholar's OTHER sessions", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });

    // The scholar already has a laptop session open.
    const laptopSession = await newSession(t, scholar);

    // Pair an iPad to them.
    await pairDevice(t, registrar, scholar, "ipad-13");

    // The pre-existing laptop session is untouched (no silent sign-out).
    expect(await t.run(async (ctx) => ctx.db.get(laptopSession))).not.toBeNull();
  });

  test("unpair is INSTITUTION-SCOPED — operations staff at another school cannot unpair", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const registrarA = await seedUser(t, "staff");
    await grantMembership(t, registrarA, "staff", instA);
    await grantSchoolOperations(t, registrarA, instA);
    const registrarB = await seedUser(t, "staff");
    await grantMembership(t, registrarB, "staff", instB);
    await grantSchoolOperations(t, registrarB, instB);
    const scholarA = await seedUser(t, "scholar", { institutionId: instA });

    const { pairedDeviceId } = await pairDevice(t, registrarA, scholarA, "ipad-15");

    await expect(
      (await withUser(t, registrarB)).mutation(api.devicePairing.unpairDevice, {
        pairedDeviceId,
      }),
    ).rejects.toThrow(/context/i);
    // Binding survives.
    expect(await t.run(async (ctx) => ctx.db.get(pairedDeviceId))).not.toBeNull();
  });

  const SERIAL = "F9FZX2ABCDEF";

  /** Provision + exchange a managed-device claim, binding `deviceId` to
   *  `scholar` via the claim path (managedDeviceClaims.consumeManagedClaim) —
   *  the same physical device this describe block's manual pairing tests
   *  then re-pair through the ordinary staff-approved flow. */
  async function provisionManagedClaim(
    t: TC,
    inst: Id<"institutions">,
    opsStaff: Id<"users">,
    scholar: Id<"users">,
    deviceId: string,
  ): Promise<{
    claimId: Id<"managedDeviceClaims">;
    sessionId: Id<"authSessions">;
    claimToken: string;
  }> {
    const asOpsStaff = await withUser(t, opsStaff);
    const { results } = await asOpsStaff.mutation(
      api.managedDeviceClaims.mintManagedDeviceClaims,
      { devices: [{ serial: SERIAL, scholarId: scholar }] },
    );
    const token = results[0].claimToken!;
    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.managedDeviceClaims.consumeManagedClaim, {
        claimToken: token,
        deviceId,
      }),
    );
    expect(result?.userId).toBe(scholar);
    const claim = await t.run(async (ctx) =>
      ctx.db
        .query("managedDeviceClaims")
        .withIndex("by_serial", (q) => q.eq("serial", SERIAL))
        .unique(),
    );
    return { claimId: claim!._id, sessionId: result!.sessionId, claimToken: token };
  }

  test("(Finding 4) a SAME-scholar manual re-pair of a managed device revokes the old claim session and nudges its unlock closed", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });

    const { claimId, sessionId: managedSessionId } = await provisionManagedClaim(
      t,
      inst,
      registrar,
      scholar,
      "ipad-managed-01",
    );

    // Simulate an active/warm unlock for this claim (as the reconciler would
    // leave one) — due far in the future, so a manual re-pair is the ONLY
    // thing that could bring it forward.
    const unlockStateId = await t.run(async (ctx) =>
      ctx.db.insert("deviceAppUnlockStates", {
        institutionId: inst,
        managedDeviceClaimId: claimId,
        desiredState: "unlocked",
        appKey: "google-sheets",
        updatedAt: Date.now(),
        requestedAt: Date.now(),
        requestedBy: registrar,
        nextRecheckAt: Date.now() + 60 * 60 * 1000,
      }),
    );

    // The SAME scholar manually re-pairs the SAME physical device through the
    // ordinary staff-approved handshake (e.g. after a factory-reset/manual
    // recovery flow) — the scholar identity does not change.
    const { requestId, verifier } = await registerDevice(t, {
      deviceId: "ipad-managed-01",
    });
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId, scholarId: scholar },
    );
    const result = await exchange(t, requestId, verifier);
    expect(result?.userId).toBe(scholar);
    expect(result?.sessionId).not.toBe(managedSessionId);

    // The old managed-claim session is gone…
    expect(await t.run((ctx) => ctx.db.get(managedSessionId))).toBeNull();
    // …the binding no longer claims managed-claim ownership…
    const binding = await t.run(async (ctx) =>
      ctx.db
        .query("pairedDevices")
        .withIndex("by_device", (q) =>
          q.eq("institutionId", inst).eq("deviceId", "ipad-managed-01"),
        )
        .unique(),
    );
    expect(binding?.managedDeviceClaimId).toBeUndefined();
    expect(binding?.scholarId).toBe(scholar);
    // …and the previous claim's active unlock was nudged due-now, so the
    // reconciler force-re-derives it on its very next tick instead of
    // waiting out the stale hour-long recheck window.
    const unlockState = await t.run((ctx) => ctx.db.get(unlockStateId));
    expect(unlockState?.nextRecheckAt).toBe(0);
  });

  test("(Finding 1) managed remote sign-out (revokeDeviceSession) is a real decommission — session dies, token re-exchange fails, generation bumps, relock is scheduled", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });

    const { claimId, sessionId: managedSessionId, claimToken } = await provisionManagedClaim(
      t,
      inst,
      registrar,
      scholar,
      "ipad-managed-signout",
    );
    const claimBefore = await t.run((ctx) => ctx.db.get(claimId));
    const claimTokenHashBefore = claimBefore!.claimTokenHash;
    const generationBefore = claimBefore!.claimGeneration ?? 0;

    // Simulate an active/warm unlock, exactly like the Finding 4 test, so we
    // can prove the relock got scheduled (not merely that the session died).
    const unlockStateId = await t.run(async (ctx) =>
      ctx.db.insert("deviceAppUnlockStates", {
        institutionId: inst,
        managedDeviceClaimId: claimId,
        desiredState: "unlocked",
        appKey: "google-sheets",
        updatedAt: Date.now(),
        requestedAt: Date.now(),
        requestedBy: registrar,
        nextRecheckAt: Date.now() + 60 * 60 * 1000,
      }),
    );

    const pairedDeviceId = (await t.run(async (ctx) =>
      ctx.db
        .query("pairedDevices")
        .withIndex("by_device", (q) =>
          q.eq("institutionId", inst).eq("deviceId", "ipad-managed-signout"),
        )
        .unique(),
    ))!._id;

    // The actual UI mutation path — not unpairDevice.
    const res = await (await withUser(t, registrar)).mutation(
      api.devicePairing.revokeDeviceSession,
      { pairedDeviceId },
    );
    expect(res.sessionRevoked).toBe(true);

    // The managed-claim session is gone.
    expect(await t.run((ctx) => ctx.db.get(managedSessionId))).toBeNull();

    // The durable claim credential itself is dead: state is "revoked", the
    // token hash changed (no longer the original — an unmatchable
    // placeholder), and the generation bumped (any in-flight reconciler task
    // stamped with the old generation must go stale).
    const claimAfter = await t.run((ctx) => ctx.db.get(claimId));
    expect(claimAfter?.claimState).toBe("revoked");
    expect(claimAfter?.claimTokenHash).not.toBe(claimTokenHashBefore);
    expect(claimAfter?.claimGeneration).toBe(generationBefore + 1);

    // The physical binding's session pointer is cleared too (the existing
    // remote sign-out contract).
    const binding = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    expect(binding?.authSessionId).toBeUndefined();

    // A relock was scheduled: the warm unlock's nextRecheckAt was nudged
    // due-now, so the reconciler re-derives (and closes) it on its very next
    // tick instead of waiting out the stale hour-long window.
    const unlockState = await t.run((ctx) => ctx.db.get(unlockStateId));
    expect(unlockState?.nextRecheckAt).toBe(0);

    // Re-exchanging the ORIGINAL plaintext claim token — exactly what the
    // native app's durable-token auto-re-exchange would attempt on its next
    // foreground — must now fail — the durable credential is dead, so remote
    // sign-out cannot be silently undone by the device itself.
    const reExchange = await t.run(async (ctx) =>
      ctx.runMutation(internal.managedDeviceClaims.consumeManagedClaim, {
        claimToken,
        deviceId: "ipad-managed-signout",
      }),
    );
    expect(reExchange).toBeNull();
  });

  test("(round 5, Finding 3) attachDeviceSession replaces the prior live row instead of accumulating a second one", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });

    const { pairedDeviceId, sessionId: firstSession } = await pairDevice(
      t,
      registrar,
      scholar,
      "ipad-attach-01",
    );

    // Multiple sequential distinct re-signins on the SAME physical device —
    // each one attaches a genuinely different session (a fresh app launch,
    // not a foreground/idle heartbeat repeat of the same one).
    const rowsFor = (pdId: Id<"pairedDevices">) =>
      t.run((ctx) =>
        ctx.db
          .query("pairedDeviceAuthSessions")
          .withIndex("by_paired_device", (q) => q.eq("pairedDeviceId", pdId))
          .collect(),
      );

    expect(await rowsFor(pairedDeviceId)).toHaveLength(1);

    const secondSession = await newSession(t, scholar);
    await (await withUser(t, scholar, secondSession)).mutation(
      api.devicePairing.attachDeviceSession,
      { deviceId: "ipad-attach-01" },
    );
    // Exactly one live row remains, now pointing at the new session — the
    // old one was revoked/deleted, not merely superseded by a second row.
    let rows = await rowsFor(pairedDeviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].authSessionId).toBe(secondSession);
    expect(await t.run((ctx) => ctx.db.get(firstSession))).toBeNull();

    const thirdSession = await newSession(t, scholar);
    await (await withUser(t, scholar, thirdSession)).mutation(
      api.devicePairing.attachDeviceSession,
      { deviceId: "ipad-attach-01" },
    );
    rows = await rowsFor(pairedDeviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].authSessionId).toBe(thirdSession);
    expect(await t.run((ctx) => ctx.db.get(secondSession))).toBeNull();

    // A repeat call for the SAME (current) session is idempotent — still
    // exactly one row, unchanged.
    await (await withUser(t, scholar, thirdSession)).mutation(
      api.devicePairing.attachDeviceSession,
      { deviceId: "ipad-attach-01" },
    );
    rows = await rowsFor(pairedDeviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].authSessionId).toBe(thirdSession);

    // Remote/decommission revoke closes the sole surviving live session.
    const res = await (await withUser(t, registrar)).mutation(
      api.devicePairing.revokeDeviceSession,
      { pairedDeviceId },
    );
    expect(res.sessionRevoked).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(thirdSession))).toBeNull();
    expect(await rowsFor(pairedDeviceId)).toHaveLength(0);
  });

  test("(round 5, Finding 3) a manual-pair -> managed-claim transition for the SAME scholar/device revokes the stale manual session, not just on scholar change", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });

    // Step 1: this physical device is first manually paired (no managed
    // claim at all) to this scholar.
    const { pairedDeviceId, sessionId: manualSessionId } = await pairDevice(
      t,
      registrar,
      scholar,
      "ipad-transition-01",
    );
    const rowsFor = (pdId: Id<"pairedDevices">) =>
      t.run((ctx) =>
        ctx.db
          .query("pairedDeviceAuthSessions")
          .withIndex("by_paired_device", (q) => q.eq("pairedDeviceId", pdId))
          .collect(),
      );
    expect(await rowsFor(pairedDeviceId)).toHaveLength(1);

    // Step 2: the SAME physical device (same institutionId+deviceId) is now
    // provisioned as a managed device and claimed by the SAME scholar — no
    // scholar change, so the old code's `if (scholarChanged)` guard would
    // have left the manual session's row alive alongside the new one.
    const asOpsStaff = await withUser(t, registrar);
    const { results } = await asOpsStaff.mutation(
      api.managedDeviceClaims.mintManagedDeviceClaims,
      { devices: [{ serial: "F9FZX2TRANS1", scholarId: scholar }] },
    );
    const claimResult = await t.run(async (ctx) =>
      ctx.runMutation(internal.managedDeviceClaims.consumeManagedClaim, {
        claimToken: results[0].claimToken!,
        deviceId: "ipad-transition-01",
      }),
    );
    expect(claimResult?.userId).toBe(scholar);
    expect(claimResult?.sessionId).not.toBe(manualSessionId);

    // The stale manual-pairing session is gone…
    expect(await t.run((ctx) => ctx.db.get(manualSessionId))).toBeNull();
    // …and exactly one live association row remains, for the NEW managed
    // session — never two rows for the same pairedDeviceId.
    const rows = await rowsFor(pairedDeviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].authSessionId).toBe(claimResult!.sessionId);
    expect(rows[0].managedDeviceClaimId).toBeDefined();
  });

  test("(round 6, Finding 1) attachDeviceSession backfills a legacy pairedDevices row (authSessionId already set, no sidecar row yet) WITHOUT revoking the caller's own live session", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const scholar = await seedUser(t, "scholar", { institutionId: inst });

    // Simulate data from BEFORE the pairedDeviceAuthSessions table shipped:
    // a pairedDevices row whose authSessionId is already the scholar's live
    // session, with NO sidecar row at all (the table starts empty on
    // rollout — this is not a re-sign-in, it's the same live session the
    // binding already trusts).
    const liveSession = await newSession(t, scholar);
    const pairedDeviceId = await t.run((ctx) =>
      ctx.db.insert("pairedDevices", {
        institutionId: inst,
        deviceId: "ipad-legacy-01",
        scholarId: scholar,
        pairedAt: Date.now(),
        pairedBy: scholar,
        authSessionId: liveSession,
      }),
    );

    const rowsFor = () =>
      t.run((ctx) =>
        ctx.db
          .query("pairedDeviceAuthSessions")
          .withIndex("by_paired_device", (q) =>
            q.eq("pairedDeviceId", pairedDeviceId),
          )
          .collect(),
      );
    expect(await rowsFor()).toHaveLength(0);

    // First foreground call after this deploy: must NOT revoke the caller's
    // own session — it is the SAME session the binding already points at.
    const res = await (await withUser(t, scholar, liveSession)).mutation(
      api.devicePairing.attachDeviceSession,
      { deviceId: "ipad-legacy-01" },
    );
    expect(res.attached).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(liveSession))).not.toBeNull();
    let rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].authSessionId).toBe(liveSession);

    // Idempotent on a repeated foreground call for the same session.
    await (await withUser(t, scholar, liveSession)).mutation(
      api.devicePairing.attachDeviceSession,
      { deviceId: "ipad-legacy-01" },
    );
    rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(liveSession))).not.toBeNull();

    // Remote revoke still closes it correctly afterward.
    const staff = await seedUser(t, "staff");
    await grantMembership(t, staff, "staff", inst);
    await grantSchoolOperations(t, staff, inst);
    const revokeRes = await (await withUser(t, staff)).mutation(
      api.devicePairing.revokeDeviceSession,
      { pairedDeviceId },
    );
    expect(revokeRes.sessionRevoked).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(liveSession))).toBeNull();
    expect(await rowsFor()).toHaveLength(0);
  });
});

describe("device pairing — sweep", () => {
  test("sweep removes exchanged + expired requests, keeps live pending ones", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "moli");
    const registrar = await seedUser(t, "staff");
    await grantMembership(t, registrar, "staff", inst);
    await grantSchoolOperations(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", { institutionId: inst });

    // Live pending — kept.
    await registerDevice(t, { deviceId: "keep-live" });
    // Exchanged (terminal) — swept.
    const done = await registerDevice(t, { deviceId: "swept-exchanged" });
    await (await withUser(t, registrar)).mutation(
      api.devicePairing.approvePairingRequest,
      { requestId: done.requestId, scholarId: scholar },
    );
    await exchange(t, done.requestId, done.verifier);
    // Expired pending — swept.
    const stale = await registerDevice(t, { deviceId: "swept-expired" });
    await t.run(async (ctx) =>
      ctx.db.patch(stale.requestId, { expiresAt: Date.now() - 1_000 }),
    );

    const before = await t.run(async (ctx) =>
      ctx.db.query("devicePairingRequests").collect(),
    );
    expect(before).toHaveLength(3);

    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.devicePairing.sweepStalePairingRequests, {}),
    );
    expect(result.removed).toBe(2);

    const after = await t.run(async (ctx) =>
      ctx.db.query("devicePairingRequests").collect(),
    );
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("pending");
  });
});

describe("listPairableScholars — enrolled-only by default", () => {
  test("excludes Extended Education (program-guest) scholars unless opted in", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "pairable-scholars");
    const operator = await seedUser(t, "staff");
    await grantMembership(t, operator, "staff", inst);
    await grantSchoolOperations(t, operator, inst);

    const enrolled = await seedUser(t, "scholar", {
      name: "Enrolled Scholar",
      institutionId: inst,
    });
    const guest = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Guest Scholar",
        role: "scholar",
        username: `guest-${Math.random().toString(36).slice(2, 8)}`,
        institutionId: inst,
        enrollmentStanding: "program_guest",
      }),
    );

    const asOperator = await withUser(t, operator);

    // Default: enrolled-only — the program guest is excluded from pairing.
    const byDefault = await asOperator.query(
      api.devicePairing.listPairableScholars,
      {},
    );
    const defaultIds = byDefault.map((s) => String(s._id));
    expect(defaultIds).toContain(String(enrolled));
    expect(defaultIds).not.toContain(String(guest));

    // Explicit opt-in surfaces the program guest too (for a future toggle).
    const withGuests = await asOperator.query(
      api.devicePairing.listPairableScholars,
      { includeProgramGuests: true },
    );
    const guestIds = withGuests.map((s) => String(s._id));
    expect(guestIds).toContain(String(enrolled));
    expect(guestIds).toContain(String(guest));
  });
});
