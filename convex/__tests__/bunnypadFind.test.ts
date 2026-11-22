import { convexTest } from "convex-test";
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { READ_ONLY_ACCOUNT_ERROR } from "../lib/auth";
import { buildFindPayload, FIND_SOUND_FILE } from "../lib/bunnypadFindPayload";
import { findOutcomeMessage } from "../lib/bunnypadFindMessages";
import { apnsJwt } from "../bunnypadFindPush";

// A stand-in APNs: every push is answered 200, and each request's headers are
// kept so a test can count how many pushes went out.
const apnsRequests = vi.hoisted(() => [] as Record<string, string>[]);
vi.mock("node:http2", async () => {
  const { EventEmitter } = await import("node:events");
  type Emitter = InstanceType<typeof EventEmitter> & Record<string, unknown>;
  const connect = () => {
    const client = new EventEmitter() as Emitter;
    client.close = () => {};
    client.request = (headers: Record<string, string>) => {
      apnsRequests.push(headers);
      const request = new EventEmitter() as Emitter;
      request.setTimeout = () => {};
      request.setEncoding = () => {};
      request.close = () => {};
      request.end = () => {
        queueMicrotask(() => {
          request.emit("response", { ":status": 200 });
          request.emit("end");
        });
      };
      return request;
    };
    return client;
  };
  return { default: { connect }, connect };
});

// Why this file: "Find my BunnyPad" lets a parent's text or a staff aide make a
// child's iPad play a loud sound. These pin who may ask (guardianship for
// parents, live school-operations standing for staff), that a find only
// reaches registered iPads, the repeat guard, and that an iPad's token can
// only be written by its own signed-in scholar.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

const TOKEN = "a".repeat(64);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function insertUser(t: T, fields: Partial<Doc<"users">> & { name: string }) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      username: fields.name.toLowerCase().replaceAll(" ", "-"),
      ...fields,
    } as Omit<Doc<"users">, "_id" | "_creationTime">),
  );
}

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** Two schools. Moli: a teacher, Kai (guardian Hoku) with a registered
 *  BunnyPad, Noe (also Hoku's) with an unregistered one. Kona: a teacher. */
async function seedWorld(t: T) {
  const moli = await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school" as const,
      timeZone: "Pacific/Honolulu",
    }),
  );
  const kona = await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: "Kona School",
      slug: "kona",
      kind: "school" as const,
      timeZone: "Pacific/Honolulu",
    }),
  );
  const teacher = await insertUser(t, { name: "Avery Stone", role: "teacher" });
  const otherTeacher = await insertUser(t, { name: "Sloane Kahale", role: "teacher" });
  await t.run(async (ctx) => {
    await ctx.db.insert("memberships", { userId: teacher, role: "teacher", institutionId: moli });
    await ctx.db.insert("memberships", { userId: otherTeacher, role: "teacher", institutionId: kona });
  });
  const parent = await insertUser(t, { name: "Hoku Makani", role: "parent" });
  const stranger = await insertUser(t, { name: "Lehua Torres", role: "parent" });
  const kai = await insertUser(t, { name: "Kai Makani", role: "scholar", institutionId: moli });
  const noe = await insertUser(t, { name: "Noe Makani", role: "scholar", institutionId: moli });
  const ids = await t.run(async (ctx) => {
    for (const s of [kai, noe]) {
      await ctx.db.insert("guardianships", {
        parentUserId: parent,
        scholarUserId: s,
        createdBy: teacher,
      });
    }
    const base = { institutionId: moli, pairedAt: Date.now(), pairedBy: teacher };
    const kaiPad = await ctx.db.insert("pairedDevices", {
      ...base,
      deviceId: "ipad-kai",
      scholarId: kai,
      apnsToken: TOKEN,
      apnsTopic: "school.rabbithole",
      apnsEnvironment: "production" as const,
    });
    const noePad = await ctx.db.insert("pairedDevices", {
      ...base,
      deviceId: "ipad-noe",
      scholarId: noe,
    });
    return { kaiPad, noePad };
  });
  return { moli, kona, teacher, otherTeacher, parent, stranger, kai, noe, ...ids };
}

describe("registerPushToken", () => {
  test("the signed-in scholar registers their own iPad's token", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const asNoe = await withUser(t, w.noe);
    const result = await asNoe.mutation(api.bunnypadFind.registerPushToken, {
      deviceId: "ipad-noe",
      token: "b".repeat(64),
      topic: "school.rabbithole.canary",
      environment: "production",
    });
    expect(result).toEqual({ accepted: true });
    const row = await t.run((ctx) => ctx.db.get(w.noePad));
    expect(row?.apnsToken).toBe("b".repeat(64));
    expect(row?.apnsTopic).toBe("school.rabbithole.canary");
  });

  test("refuses another scholar's iPad, a malformed token, and an unknown app", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const asNoe = await withUser(t, w.noe);
    const base = { token: "b".repeat(64), topic: "school.rabbithole", environment: "production" as const };
    expect(
      await asNoe.mutation(api.bunnypadFind.registerPushToken, { ...base, deviceId: "ipad-kai" }),
    ).toEqual({ accepted: false });
    expect(
      await asNoe.mutation(api.bunnypadFind.registerPushToken, { ...base, deviceId: "ipad-noe", token: "not-hex" }),
    ).toEqual({ accepted: false });
    expect(
      await asNoe.mutation(api.bunnypadFind.registerPushToken, { ...base, deviceId: "ipad-noe", topic: "com.example.other" }),
    ).toEqual({ accepted: false });
    const kaiRow = await t.run((ctx) => ctx.db.get(w.kaiPad));
    expect(kaiRow?.apnsToken).toBe(TOKEN);
  });
});

describe("prepareFindFromGuardian", () => {
  test("a guardian's find targets the registered iPad, stamps it, and audits it", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const result = await t.mutation(internal.bunnypadFind.prepareFindFromGuardian, {
      guardianUserId: w.parent,
      scholarId: w.kai,
      source: "parent_sms",
    });
    expect(result).toMatchObject({ ok: true, childName: "Kai Makani", unregistered: 0, recentlyFound: 0 });
    expect(result.ok && result.targets).toEqual([
      { pairedDeviceId: w.kaiPad, token: TOKEN, topic: "school.rabbithole", environment: "production" },
    ]);
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audits.map((a) => [a.action, a.targetUserId, a.institutionId])).toEqual([
      ["device.find.request", w.kai, w.moli],
    ]);
    expect((await t.run((ctx) => ctx.db.get(w.kaiPad)))?.lastFindAt).toBeTypeOf("number");
  });

  test("a second find inside 30 seconds is held back", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const args = { guardianUserId: w.parent, scholarId: w.kai, source: "parent_app" as const };
    await t.mutation(internal.bunnypadFind.prepareFindFromGuardian, args);
    const again = await t.mutation(internal.bunnypadFind.prepareFindFromGuardian, args);
    expect(again).toMatchObject({ ok: true, targets: [], recentlyFound: 1 });
  });

  test("an unregistered BunnyPad is counted, not reached", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const result = await t.mutation(internal.bunnypadFind.prepareFindFromGuardian, {
      guardianUserId: w.parent,
      scholarId: w.noe,
      source: "parent_app",
    });
    expect(result).toMatchObject({ ok: true, targets: [], unregistered: 1 });
    expect(await t.run((ctx) => ctx.db.query("auditLog").collect())).toHaveLength(0);
  });

  test("refuses a parent who isn't the child's guardian, and a read-only account", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const stranger = await t.mutation(internal.bunnypadFind.prepareFindFromGuardian, {
      guardianUserId: w.stranger,
      scholarId: w.kai,
      source: "parent_sms",
    });
    expect(stranger).toEqual({ ok: false, message: "You can only find your own child's BunnyPad." });
    await t.run((ctx) => ctx.db.patch(w.parent, { readOnly: true }));
    const readOnly = await t.mutation(internal.bunnypadFind.prepareFindFromGuardian, {
      guardianUserId: w.parent,
      scholarId: w.kai,
      source: "parent_sms",
    });
    expect(readOnly).toEqual({ ok: false, message: READ_ONLY_ACCOUNT_ERROR });
    expect(await t.run((ctx) => ctx.db.query("auditLog").collect())).toHaveLength(0);
  });
});

describe("prepareFindFromAgent", () => {
  test("staff at the iPad's school can send; staff at another school can't", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const other = await t.mutation(internal.bunnypadFind.prepareFindFromAgent, {
      callerUserId: w.otherTeacher,
      source: "slack",
      pairedDeviceIds: [w.kaiPad],
    });
    expect(other.ok).toBe(false);
    const own = await t.mutation(internal.bunnypadFind.prepareFindFromAgent, {
      callerUserId: w.teacher,
      source: "slack",
      pairedDeviceIds: [w.kaiPad, w.noePad],
    });
    expect(own).toMatchObject({ ok: true, unregistered: 1 });
    expect(own.ok && own.targets.map((x) => x.pairedDeviceId)).toEqual([w.kaiPad]);
  });
});

describe("recordFindDelivery", () => {
  test("forgets a dead token, but not one the iPad has since replaced", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    await t.mutation(internal.bunnypadFind.recordFindDelivery, {
      deadTokens: [{ pairedDeviceId: w.kaiPad, token: "c".repeat(64) }],
    });
    expect((await t.run((ctx) => ctx.db.get(w.kaiPad)))?.apnsToken).toBe(TOKEN);
    await t.mutation(internal.bunnypadFind.recordFindDelivery, {
      deadTokens: [{ pairedDeviceId: w.kaiPad, token: TOKEN }],
    });
    expect((await t.run((ctx) => ctx.db.get(w.kaiPad)))?.apnsToken).toBeUndefined();
  });
});

describe("findFromGuardian", () => {
  test("with no APNs key configured it sends nothing and writes no audit row", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const result = await t.action(internal.bunnypadFindPush.findFromGuardian, {
      guardianUserId: w.parent,
      scholarId: w.kai,
      source: "parent_sms",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/aren't set up yet/);
    expect(await t.run((ctx) => ctx.db.query("auditLog").collect())).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(w.kaiPad)))?.lastFindAt).toBeUndefined();
  });
});

describe("findFromGuardian follow-ups", () => {
  test("an accepted find is pushed twice more, nine seconds apart, then stops", async () => {
    apnsRequests.length = 0;
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    vi.stubEnv("APNS_KEY_ID", "ABC123DEFG");
    vi.stubEnv("APNS_TEAM_ID", "HKR5398M4S");
    vi.stubEnv("APNS_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    vi.useFakeTimers();
    const t = newTest();
    const w = await seedWorld(t);
    const result = await t.action(internal.bunnypadFindPush.findFromGuardian, {
      guardianUserId: w.parent,
      scholarId: w.kai,
      source: "parent_sms",
    });
    expect(result.ok).toBe(true);
    expect(apnsRequests).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(apnsRequests).toHaveLength(3);
    expect(new Set(apnsRequests.map((h) => h[":path"]))).toEqual(new Set([`/3/device/${TOKEN}`]));
    // One ask is one audited find, however many pushes carry it.
    expect(await t.run((ctx) => ctx.db.query("auditLog").collect())).toHaveLength(1);
  });
});

describe("buildFindPayload", () => {
  test("is a Time Sensitive alert with the bundled tone by default", () => {
    expect(buildFindPayload({ critical: false }).aps).toMatchObject({
      sound: FIND_SOUND_FILE,
      "interruption-level": "time-sensitive",
    });
  });

  test("one flag turns it into a full-volume Critical Alert", () => {
    expect(buildFindPayload({ critical: true }).aps).toMatchObject({
      sound: { critical: 1, name: FIND_SOUND_FILE, volume: 1 },
      "interruption-level": "critical",
    });
  });
});

describe("findOutcomeMessage", () => {
  const none = { sent: 0, unregistered: 0, recentlyFound: 0, failed: 0, notConfigured: false };

  test("says sent, never beeping", () => {
    const message = findOutcomeMessage({ ...none, sent: 1 }, { kind: "child", name: "Kai" });
    expect(message).toMatch(/^Sent a find sound to Kai's BunnyPad\./);
    expect(message).not.toMatch(/is beeping/);
  });

  test("names the update an unregistered BunnyPad needs", () => {
    expect(
      findOutcomeMessage({ ...none, unregistered: 1 }, { kind: "child", name: "Noe" }),
    ).toBe("Noe's BunnyPad can't play a find sound yet. Open Rabbithole on it once, updating it first if it's an older version.");
  });
});

describe("apnsJwt", () => {
  test("is an ES256 token APNs can verify with the key's public half", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const token = apnsJwt(
      { keyId: "ABC123DEFG", teamId: "HKR5398M4S", key: privateKey, fingerprint: "test", critical: false },
      1_800_000_000_000,
    );
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "HKR5398M4S", iat: 1_800_000_000 });
    expect(
      verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });
});
