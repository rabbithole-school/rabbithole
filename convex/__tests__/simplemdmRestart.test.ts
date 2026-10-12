/**
 * `simplemdm.restartDevice` — the remote-restart escape hatch for a wedged
 * iPad.
 *
 * These tests exist because the action commands REAL student hardware. They
 * mirror `simplemdmLostMode.test.ts` deliberately: the two commands share
 * `assertDeviceCommandCallerNotImpersonating` and
 * `pairedDeviceForDeviceCommand`, so each guard is asserted on this path too
 * rather than assumed to still hold by inheritance.
 *
 * The thing they cannot prove is that SimpleMDM accepts the call — that needs
 * one live command against a spare iPad. See the PR.
 */
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { simpleMdmRetryPolicy } from "../lib/simpleMdmClient";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestHarness = ReturnType<typeof convexTest>;

async function seedPrimaryInstitution(t: TestHarness, slug = "moli") {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: slug,
      slug,
      kind: "school" as const,
      timeZone: "Pacific/Honolulu",
      isPrimary: true,
    }),
  );
}

async function seedTeacher(t: TestHarness, institutionId: Id<"institutions">) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Test Teacher",
      username: "test-teacher-restart",
      role: "teacher",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { userId, role: "teacher", institutionId }),
  );
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  const identity = t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
  return Object.assign(identity, { userId, sessionId });
}

async function seedScholar(t: TestHarness, institutionId: Id<"institutions">) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Kai",
      username: "kai-restart",
      role: "scholar",
      institutionId,
    }),
  );
}

async function seedPairedDeviceWithClaim(
  t: TestHarness,
  institutionId: Id<"institutions">,
  scholarId: Id<"users">,
  pairedBy: Id<"users">,
  serial = "SERIAL123",
  deviceId = "device-1",
) {
  const pairedDeviceId = await t.run((ctx) =>
    ctx.db.insert("pairedDevices", {
      deviceId,
      deviceLabel: "iPad 1",
      scholarId,
      institutionId,
      pairedAt: Date.now(),
      pairedBy,
    }),
  );
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("managedDeviceClaims", {
      institutionId,
      serial,
      claimState: "claimed" as const,
      createdBy: pairedBy,
      createdAt: now,
      updatedAt: now,
      claimIssuedAt: now,
      rotationCount: 0,
      claimCount: 1,
      lastDeviceId: deviceId,
    }),
  );
  return pairedDeviceId;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub global fetch for a test; restored automatically in afterEach. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  globalThis.__restoreRestartFetch = () => (globalThis.fetch = realFetch);
  return calls;
}

declare global {
  var __restoreRestartFetch: (() => void) | undefined;
}

// The shared client retries transport failures with backoff; a stub that
// throws on an unexpected URL would otherwise cost ~2 s per test.
beforeAll(() => {
  simpleMdmRetryPolicy.baseDelayMs = 0;
  simpleMdmRetryPolicy.maxDelayMs = 0;
});

afterEach(() => {
  globalThis.__restoreRestartFetch?.();
  globalThis.__restoreRestartFetch = undefined;
  delete process.env.SIMPLEMDM_API_KEY;
});

function deviceListPage(devices: Array<{ id: number; serial: string }>) {
  return jsonResponse({
    data: devices.map((d) => ({
      type: "device",
      id: d.id,
      attributes: { serial_number: d.serial },
    })),
    has_more: false,
  });
}

function deviceDetail(attrs: { is_supervised?: boolean }) {
  return jsonResponse({ data: { type: "device", id: 42, attributes: attrs } });
}

describe("restartDevice", () => {
  test("POSTs /restart with no body and audits the request", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
    );

    let restartCall: { url: string; init?: RequestInit } | null = null;
    stubFetch((url, init) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        return deviceDetail({ is_supervised: true });
      }
      if (url.endsWith("/devices/42/restart")) {
        restartCall = { url, init };
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await teacher.action(api.simplemdm.restartDevice, {
      pairedDeviceId,
    });
    expect(result.queued).toBe(true);
    expect(result.message).toMatch(/queued/i);

    expect(restartCall).not.toBeNull();
    expect(restartCall!.init?.method).toBe("POST");
    // notify_user / rebuild_kernel_cache are macOS-only; sending a body here
    // would be noise the fleet never reads.
    expect(restartCall!.init?.body ?? null).toBeNull();

    const auditRows = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("device.restart.requested");
    expect(auditRows[0].targetUserId).toBe(scholarId);
    expect(auditRows[0].actorUserId).toBe(teacher.userId);
    expect(auditRows[0].detail).toContain("SERIAL123");
  });

  test("reports queued: false when SimpleMDM accepts with a non-202 status", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
    );

    stubFetch((url) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        return deviceDetail({ is_supervised: true });
      }
      if (url.endsWith("/devices/42/restart")) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await teacher.action(api.simplemdm.restartDevice, {
      pairedDeviceId,
    });
    expect(result.queued).toBe(false);
    expect(result.message).toMatch(/immediately/i);
  });

  test("refuses to restart an unsupervised device", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
    );

    let restartCalled = false;
    stubFetch((url) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        return deviceDetail({ is_supervised: false });
      }
      if (url.endsWith("/devices/42/restart")) {
        restartCalled = true;
        throw new Error("must not restart an unsupervised device");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      teacher.action(api.simplemdm.restartDevice, { pairedDeviceId }),
    ).rejects.toThrow(/supervised/i);
    expect(restartCalled).toBe(false);
    const auditRows = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(auditRows).toHaveLength(0);
  });

  test("refuses when supervision is unreported (null), not just false", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
    );

    let restartCalled = false;
    stubFetch((url) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        // SimpleMDM omits is_supervised entirely.
        return deviceDetail({});
      }
      if (url.endsWith("/devices/42/restart")) {
        restartCalled = true;
        throw new Error("must not restart when supervision is unknown");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      teacher.action(api.simplemdm.restartDevice, { pairedDeviceId }),
    ).rejects.toThrow(/supervised/i);
    expect(restartCalled).toBe(false);
  });

  test("throws a legible error when the iPad isn't enrolled in SimpleMDM", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    // Paired device with NO managedDeviceClaims row.
    const pairedDeviceId = await t.run((ctx) =>
      ctx.db.insert("pairedDevices", {
        deviceId: "unenrolled-device",
        scholarId,
        institutionId,
        pairedAt: Date.now(),
        pairedBy: scholarId,
      }),
    );

    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      throw new Error("must not reach SimpleMDM for an unenrolled device");
    });

    await expect(
      teacher.action(api.simplemdm.restartDevice, { pairedDeviceId }),
    ).rejects.toThrow(/enrolled/i);
    expect(fetchCalled).toBe(false);
  });

  test("refuses while impersonating, and never reaches SimpleMDM at all", async () => {
    const prevFlag = process.env.IMPERSONATION_ENABLED;
    process.env.IMPERSONATION_ENABLED = "on";
    process.env.SIMPLEMDM_API_KEY = "test-key";
    try {
      const t = convexTest(schema, modules);
      const institutionId = await seedPrimaryInstitution(t);
      const admin = await seedTeacher(t, institutionId);
      const scholarId = await seedScholar(t, institutionId);
      const pairedDeviceId = await seedPairedDeviceWithClaim(
        t,
        institutionId,
        scholarId,
        scholarId,
        "SERIAL123",
      );
      await t.run((ctx) =>
        ctx.db.insert("impersonationOverlays", {
          adminUserId: admin.userId,
          adminSessionId: admin.sessionId,
          targetUserId: scholarId,
          startedAt: Date.now(),
          active: true,
        }),
      );

      let fetchCalled = false;
      stubFetch(() => {
        fetchCalled = true;
        throw new Error("restartDevice must not call fetch while impersonating");
      });

      await expect(
        admin.action(api.simplemdm.restartDevice, { pairedDeviceId }),
      ).rejects.toThrow(/impersonat/i);

      expect(fetchCalled).toBe(false);
      const auditRows = await t.run((ctx) => ctx.db.query("auditLog").collect());
      expect(auditRows).toHaveLength(0);
    } finally {
      if (prevFlag === undefined) delete process.env.IMPERSONATION_ENABLED;
      else process.env.IMPERSONATION_ENABLED = prevFlag;
    }
  });

  test("membership revoked mid-flight blocks the restart and writes no audit row", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const admin = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
    );

    let restartCalled = false;
    stubFetch(async (url) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        // Staff access revoked AFTER pairedDeviceForDeviceCommand resolved the
        // mapping but BEFORE recordDeviceRestartIntent re-verifies the caller.
        const membership = await t.run((ctx) =>
          ctx.db
            .query("memberships")
            .withIndex("by_user", (q) => q.eq("userId", admin.userId))
            .unique(),
        );
        if (membership) await t.run((ctx) => ctx.db.delete(membership._id));
        return deviceDetail({ is_supervised: true });
      }
      if (url.endsWith("/devices/42/restart")) {
        restartCalled = true;
        throw new Error("must not restart once access was revoked mid-flight");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      admin.action(api.simplemdm.restartDevice, { pairedDeviceId }),
    ).rejects.toThrow(/Forbidden|membership|context|configured/i);

    expect(restartCalled).toBe(false);
    const auditRows = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(auditRows).toHaveLength(0);
  });

  test("serial drift mid-flight blocks the restart and writes no audit row", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const admin = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
      "device-1",
    );

    let restartCalled = false;
    stubFetch(async (url) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        // The physical device is re-claimed onto a different serial after the
        // early read resolved SERIAL123 for this pairedDeviceId.
        await t.run((ctx) =>
          ctx.db.patch(pairedDeviceId, { deviceId: "device-1-reclaimed" }),
        );
        const claim = await t.run((ctx) =>
          ctx.db
            .query("managedDeviceClaims")
            .withIndex("by_last_device_id", (q) =>
              q.eq("lastDeviceId", "device-1"),
            )
            .unique(),
        );
        if (claim) {
          await t.run((ctx) =>
            ctx.db.patch(claim._id, {
              lastDeviceId: "device-1-reclaimed",
              serial: "SERIAL999-DIFFERENT",
            }),
          );
        }
        return deviceDetail({ is_supervised: true });
      }
      if (url.endsWith("/devices/42/restart")) {
        restartCalled = true;
        throw new Error("must not restart once the mapping drifted mid-flight");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // ONE call, both assertions off the same rejection: a second invocation
    // would re-resolve the already-drifted serial and fail on the stub's
    // "Unexpected fetch" instead, which happens to match the message regex
    // and would pass for the wrong reason.
    const drift = await admin
      .action(api.simplemdm.restartDevice, { pairedDeviceId })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(drift).toBeInstanceOf(ConvexError);
    expect(String((drift as ConvexError<string>).data)).toMatch(
      /enrollment changed/i,
    );

    expect(restartCalled).toBe(false);
    const auditRows = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(auditRows).toHaveLength(0);
  });

  test("refusals survive the action boundary as ConvexError, not a redacted Error", async () => {
    // Convex replaces a plain Error's message with an opaque "Server Error" in
    // prod. The console's Restart button is deliberately offered on an unknown
    // snapshot, so these refusals are how staff learn why it can't run — they
    // must arrive with their text intact, the way the SimpleMDM client's own
    // errors do.
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await t.run((ctx) =>
      ctx.db.insert("pairedDevices", {
        deviceId: "unenrolled-device",
        scholarId,
        institutionId,
        pairedAt: Date.now(),
        pairedBy: scholarId,
      }),
    );

    await expect(
      teacher.action(api.simplemdm.restartDevice, { pairedDeviceId }),
    ).rejects.toThrow(ConvexError);
  });

  test("same-serial reassignment to another scholar mid-flight blocks the restart", async () => {
    // The serial check cannot see this: the same physical iPad, same SimpleMDM
    // record, handed to a different scholar while the detail read was in
    // flight. Authorization is unaffected, but the audit row would name a
    // scholar staff never selected.
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const otherScholarId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Noa",
        username: "noa-restart",
        role: "scholar",
        institutionId,
      }),
    );
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
    );

    let restartCalled = false;
    stubFetch(async (url) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        await t.run((ctx) =>
          ctx.db.patch(pairedDeviceId, { scholarId: otherScholarId }),
        );
        return deviceDetail({ is_supervised: true });
      }
      if (url.endsWith("/devices/42/restart")) {
        restartCalled = true;
        throw new Error("must not restart a device reassigned mid-flight");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      teacher.action(api.simplemdm.restartDevice, { pairedDeviceId }),
    ).rejects.toThrow(/reassigned/i);

    expect(restartCalled).toBe(false);
    const auditRows = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(auditRows).toHaveLength(0);
  });

  test("an ambiguous transport failure is NOT retried — one reboot must not become two", async () => {
    // The shared client retries transport errors and 5xx by default. A restart
    // POST whose response was lost may already have queued a reboot, so
    // re-sending it can queue a second one under authority checked only for
    // the first attempt. Only an explicit 429 is safe to retry.
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
    );

    let restartAttempts = 0;
    stubFetch((url) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        return deviceDetail({ is_supervised: true });
      }
      if (url.endsWith("/devices/42/restart")) {
        restartAttempts += 1;
        throw new Error("connection reset");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      teacher.action(api.simplemdm.restartDevice, { pairedDeviceId }),
    ).rejects.toThrow();
    expect(restartAttempts).toBe(1);
  });

  test("a 429 IS retried — SimpleMDM proved it did not act on the request", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      scholarId,
      "SERIAL123",
    );

    let restartAttempts = 0;
    stubFetch((url) => {
      if (url.includes("/devices?search=SERIAL123")) {
        return deviceListPage([{ id: 42, serial: "SERIAL123" }]);
      }
      if (url.endsWith("/devices/42")) {
        return deviceDetail({ is_supervised: true });
      }
      if (url.endsWith("/devices/42/restart")) {
        restartAttempts += 1;
        if (restartAttempts === 1) return new Response(null, { status: 429 });
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await teacher.action(api.simplemdm.restartDevice, {
      pairedDeviceId,
    });
    expect(result.queued).toBe(true);
    expect(restartAttempts).toBe(2);
  });

  test("a scholar cannot restart their own iPad", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const institutionId = await seedPrimaryInstitution(t);
    const teacher = await seedTeacher(t, institutionId);
    const scholarId = await seedScholar(t, institutionId);
    const pairedDeviceId = await seedPairedDeviceWithClaim(
      t,
      institutionId,
      scholarId,
      teacher.userId,
      "SERIAL123",
    );
    const scholarSessionId = await t.run((ctx) =>
      ctx.db.insert("authSessions", {
        userId: scholarId,
        expirationTime: Date.now() + 60 * 60 * 1000,
      }),
    );
    const scholar = t.withIdentity({
      subject: `${scholarId}|${scholarSessionId}`,
      issuer: "https://convex.dev",
    });

    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      throw new Error("a scholar must never reach SimpleMDM");
    });

    await expect(
      scholar.action(api.simplemdm.restartDevice, { pairedDeviceId }),
    ).rejects.toThrow();
    expect(fetchCalled).toBe(false);
  });
});
