import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  CHARGE_REMINDERS_OFF_REPLY,
  CHARGE_REMINDERS_ON_REPLY,
} from "../lib/chargeReminder";
import "../parentSms";

// Why this file: the school-night charge reminder is the first text the
// school sends that a parent didn't just ask for. These pin who gets it
// (consent, STOP, NO REMINDERS, one per evening), when (a night before a
// school day, inside a term), and the battery rule end to end (low, and no
// fresh check-in saying it's charging).
//
// Nothing here can send a real text: `fetch` is replaced for the whole file
// and refuses any host but a fake Twilio (and a fake SimpleMDM roster, for a
// test that turns SimpleMDM on).

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

// Fictional 555 numbers only.
const PARENT_PHONE = "+18085550142";
const OTHER_PHONE = "+18085550177";

const MIN = 60_000;
/** Wednesday 2026-11-04, 20:00 HST: tomorrow (Thursday) is a school day. */
const WED_8PM = Date.parse("2026-11-05T06:00:00.000Z");
/** Friday 2026-11-06, 20:00 HST: tomorrow is Saturday. */
const FRI_8PM = Date.parse("2026-11-07T06:00:00.000Z");
/** Tuesday 2026-11-10, 20:00 HST: tomorrow is a holiday. */
const TUE_BEFORE_HOLIDAY = Date.parse("2026-11-11T06:00:00.000Z");
/** Sunday 2026-11-29, 20:00 HST: school resumes after Thanksgiving break. */
const SUN_AFTER_BREAK = Date.parse("2026-11-30T06:00:00.000Z");

let sent: Array<{ to: string; body: string }> = [];
/** SimpleMDM's roster for a test that turns SimpleMDM on (`simpleMdmSays`). */
let mdmRoster: unknown[] | null = null;

beforeEach(() => {
  sent = [];
  mdmRoster = null;
  vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
  vi.stubEnv("TWILIO_API_KEY_SID", "SKtest");
  vi.stubEnv("TWILIO_API_KEY_SECRET", "test-secret");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+18885550100");
  // SimpleMDM off unless a test says otherwise: the plan reads the snapshot.
  vi.stubEnv("SIMPLEMDM_API_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (mdmRoster && url.startsWith("https://a.simplemdm.com/api/v1/devices?")) {
        return new Response(JSON.stringify({ has_more: false, data: mdmRoster }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!url.startsWith("https://api.twilio.com/2010-04-01/Accounts/ACtest/")) {
        throw new Error(`unexpected network call in a hermetic test: ${url}`);
      }
      const form = new URLSearchParams(String(init?.body ?? ""));
      sent.push({ to: form.get("To") ?? "", body: form.get("Body") ?? "" });
      return new Response(JSON.stringify({ sid: `SMfake${sent.length}` }), {
        status: 201,
      });
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── fixtures ─────────────────────────────────────────────────────────────

async function insertUser(t: T, fields: Partial<Doc<"users">> & { name: string }) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      username: fields.name.toLowerCase().replaceAll(" ", "-"),
      ...fields,
    } as Omit<Doc<"users">, "_id" | "_creationTime">),
  );
}

/**
 * Moli School (primary, Honolulu) with a fall term and a Thanksgiving break.
 * Hoku Makani guardians Kai and Noe, each with a claimed BunnyPad.
 */
async function seedWorld(t: T) {
  const institutionId = await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school" as const,
      timeZone: "Pacific/Honolulu",
      isPrimary: true,
    }),
  );
  const teacher = await insertUser(t, { name: "Avery Stone", role: "teacher" });
  const parent = await insertUser(t, { name: "Hoku Makani", role: "parent" });
  const kai = await insertUser(t, {
    name: "Kai Makani",
    role: "scholar",
    institutionId,
  });
  const noe = await insertUser(t, {
    name: "Noe Makani",
    role: "scholar",
    institutionId,
  });
  const claims: Record<string, Id<"managedDeviceClaims">> = {};
  await t.run(async (ctx) => {
    await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: Date.parse("2026-08-17T10:00:00.000Z"),
      endsAt: Date.parse("2026-12-19T10:00:00.000Z"),
      status: "open",
      institutionId,
    });
    for (const [start, end, label] of [
      ["2026-11-11", "2026-11-11", "Veterans Day"],
      ["2026-11-26", "2026-11-27", "Thanksgiving Break"],
    ] as const) {
      await ctx.db.insert("schoolClosures", {
        institutionId,
        startDayKey: start,
        endDayKey: end,
        label,
        kind: "holiday",
      });
    }
    for (const [name, scholarId] of [
      ["kai", kai],
      ["noe", noe],
    ] as const) {
      await ctx.db.insert("guardianships", {
        parentUserId: parent,
        scholarUserId: scholarId,
        createdBy: teacher,
      });
      const serial = `SERIAL${name.toUpperCase()}`;
      claims[name] = await ctx.db.insert("managedDeviceClaims", {
        institutionId,
        serial,
        scholarId,
        claimTokenHash: "not-a-real-token",
        claimState: "claimed",
        createdBy: teacher,
        createdAt: 1,
        updatedAt: 1,
        claimIssuedAt: 1,
        rotationCount: 0,
        claimCount: 1,
        lastDeviceId: `ipad-${name}`,
      });
    }
  });
  return { institutionId, teacher, parent, kai, noe, claims };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

// The intro is marked sent, so its scheduled job (tested in parentSms.test.ts)
// can't fire into a later test's `sent`.
async function consent(t: T, parentUserId: Id<"users">, phone = PARENT_PHONE) {
  const id = await t.mutation(internal.parentSms.recordSmsConsent, {
    parentUserId,
    phone,
    consentSource: "staff-verbal:Avery Stone",
    consentAt: Date.parse("2026-10-30T19:00:00.000Z"),
  });
  await t.run((ctx) => ctx.db.patch(id, { introSentAt: Date.now() }));
  return id;
}

/** What SimpleMDM last said about a kid's BunnyPad. */
async function mdmBattery(
  t: T,
  world: World,
  kid: "kai" | "noe",
  level: number,
  seenAt: number,
) {
  await t.run((ctx) =>
    ctx.db.insert("simpleMdmDeviceSnapshots", {
      institutionId: world.institutionId,
      serial: `SERIAL${kid.toUpperCase()}`,
      foundInSimpleMdm: true,
      batteryLevel: level,
      lastSeenAt: seenAt,
      inventoryAt: seenAt,
      updatedAt: seenAt,
    }),
  );
}

/** The BunnyPad app's own check-in. */
async function appCheckIn(
  t: T,
  world: World,
  kid: "kai" | "noe",
  at: number,
  batteryLevel: number,
  batteryState: "unplugged" | "charging" | "full",
) {
  await t.run((ctx) =>
    ctx.db.insert("nativeClientHeartbeats", {
      userId: world[kid],
      institutionId: world.institutionId,
      deviceId: `ipad-${kid}`,
      channel: "stable",
      appVersion: "1.0.0",
      buildNumber: "100",
      gitSha: "abcdef1",
      managedDeviceId: world.claims[kid],
      lastSeenAt: at,
      batteryLevel,
      batteryState,
      batteryAt: at,
    }),
  );
}

/** What SimpleMDM says at 8 pm, newer than the hourly snapshot. */
function simpleMdmSays(
  devices: Array<{ kid: "kai" | "noe"; level: number; seenAt: number }>,
) {
  vi.stubEnv("SIMPLEMDM_API_KEY", "test-key");
  mdmRoster = devices.map(({ kid, level, seenAt }, index) => ({
    id: index + 1,
    attributes: {
      serial_number: `SERIAL${kid.toUpperCase()}`,
      battery_level: `${level}%`,
      last_seen_at: new Date(seenAt).toISOString(),
      status: "enrolled",
    },
  }));
}

const run = (t: T, nowMs: number) =>
  t.action(internal.parentSms.sendChargeReminders, { nowMs });

const smsRow = async (t: T) => {
  const [row] = await t.run((ctx) =>
    ctx.db.query("parentChannelIdentities").collect(),
  );
  return row;
};

// ── the battery rule, end to end ─────────────────────────────────────────

describe("who gets a charge reminder", () => {
  test("texts the guardian about the low, unplugged BunnyPad only", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);
    // Kai: 14% by SimpleMDM, no app check-in (lid closed) → text.
    await mdmBattery(t, world, "kai", 14, WED_8PM - 40 * MIN);
    // Noe: low too, but the app says it's charging → no text.
    await mdmBattery(t, world, "noe", 9, WED_8PM - 40 * MIN);
    await appCheckIn(t, world, "noe", WED_8PM - 3 * MIN, 10, "charging");

    const summary = await run(t, WED_8PM);

    expect(summary).toMatchObject({ status: "send", sent: 1, failed: 0 });
    expect(sent).toEqual([
      {
        to: PARENT_PHONE,
        body: "Moli School: Kai's BunnyPad is at 14% and going to sleep for the night. Please plug it in for school tomorrow. Reply NO REMINDERS to stop these.",
      },
    ]);
    expect(summary.skipped).toMatchObject({ charging: 1 });
    // The text lands in the parent's thread, so a reply reads in context.
    const thread = await t.run((ctx) =>
      ctx.db
        .query("parentChatMessages")
        .withIndex("by_parent", (q) => q.eq("parentUserId", world.parent))
        .collect(),
    );
    expect(thread.map((m) => [m.role, m.content])).toEqual([
      ["assistant", sent[0].body],
    ]);
  });

  test("a fresh app reading beats SimpleMDM's, and a stale 'charging' doesn't count", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);
    // Kai: SimpleMDM says 14%, but the app says 55% a minute ago → not low.
    await mdmBattery(t, world, "kai", 14, WED_8PM - 40 * MIN);
    await appCheckIn(t, world, "kai", WED_8PM - MIN, 55, "unplugged");
    // Noe: the "charging" check-in is an hour old → treated as unplugged.
    await mdmBattery(t, world, "noe", 8, WED_8PM - 40 * MIN);
    await appCheckIn(t, world, "noe", WED_8PM - 60 * MIN, 12, "charging");

    await run(t, WED_8PM);

    expect(sent.map((s) => s.body)).toEqual([
      "Moli School: Noe's BunnyPad is at 8% and going to sleep for the night. Please plug it in for school tomorrow. Reply NO REMINDERS to stop these.",
    ]);
  });

  test("SimpleMDM's reading at 8 pm beats the hourly snapshot", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);
    // The 19:17 snapshot still has Kai at 14%, from before the charger; by
    // 8 pm SimpleMDM has heard 71%. Noe is low in both, at 11% by now.
    await mdmBattery(t, world, "kai", 14, WED_8PM - 140 * MIN);
    await mdmBattery(t, world, "noe", 18, WED_8PM - 140 * MIN);
    simpleMdmSays([
      { kid: "kai", level: 71, seenAt: WED_8PM - 28 * MIN },
      { kid: "noe", level: 11, seenAt: WED_8PM - 28 * MIN },
    ]);

    const summary = await run(t, WED_8PM);

    expect(summary).toMatchObject({ status: "send", sent: 1, mdmLive: true });
    expect(summary.skipped).toMatchObject({ "not-low": 1 });
    expect(sent.map((s) => s.body)).toEqual([
      "Moli School: Noe's BunnyPad is at 11% and going to sleep for the night. Please plug it in for school tomorrow. Reply NO REMINDERS to stop these.",
    ]);
  });

  test("two low BunnyPads share one text", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);
    await mdmBattery(t, world, "kai", 14, WED_8PM - 40 * MIN);
    await appCheckIn(t, world, "noe", WED_8PM - 2 * MIN, 6, "unplugged");

    await run(t, WED_8PM);

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe(
      "Moli School: Kai's and Noe's BunnyPads are going to sleep. Please plug them in so they're charged for school tomorrow. Reply NO REMINDERS to stop.",
    );
  });

  test("no text when nothing is low, or nothing is known", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);
    await mdmBattery(t, world, "kai", 64, WED_8PM - 40 * MIN);
    // Noe's only reading is from this morning: too stale to text about.
    await mdmBattery(t, world, "noe", 5, WED_8PM - 10 * 60 * MIN);

    const summary = await run(t, WED_8PM);

    expect(sent).toEqual([]);
    expect(summary.skipped).toMatchObject({ "not-low": 1, "no-reading": 1 });
  });

  test("once per evening, even if the cron runs twice", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);
    await mdmBattery(t, world, "kai", 14, WED_8PM - 40 * MIN);

    await run(t, WED_8PM);
    await run(t, WED_8PM + 5 * MIN);

    expect(sent).toHaveLength(1);
    expect((await smsRow(t)).chargeReminderLastDayKey).toBe("2026-11-04");
  });

  test("only guardians with a consent row, and never after STOP", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await mdmBattery(t, world, "kai", 14, WED_8PM - 40 * MIN);

    // No consent row: nothing.
    await run(t, WED_8PM);
    expect(sent).toEqual([]);

    await consent(t, world.parent);
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("parentChannelIdentities").collect();
      await ctx.db.patch(row._id, { stopState: true });
    });
    const summary = await run(t, WED_8PM);
    expect(sent).toEqual([]);
    expect(summary.skipped).toMatchObject({ "no-consent": 1 });
  });

  test("a guardian with a child at another school gets nothing (first-party only)", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    const elsewhere = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Kealia School",
        slug: "kealia",
        kind: "school" as const,
      }),
    );
    const otherParent = await insertUser(t, { name: "Lehua Torres", role: "parent" });
    const lani = await insertUser(t, {
      name: "Lani Torres",
      role: "scholar",
      institutionId: world.institutionId,
    });
    await t.run((ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: otherParent,
        scholarUserId: lani,
        createdBy: world.teacher,
      }),
    );
    await consent(t, otherParent, OTHER_PHONE);
    // Moved schools after consent was recorded.
    await t.run((ctx) => ctx.db.patch(lani, { institutionId: elsewhere }));

    const summary = await run(t, WED_8PM);

    expect(sent).toEqual([]);
    expect(summary.skipped).toMatchObject({ ineligible: 1 });
  });
});

// ── which nights ─────────────────────────────────────────────────────────

describe("which nights", () => {
  async function lowWorld() {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);
    return { t, world };
  }

  test("no text before a weekend or a holiday", async () => {
    for (const night of [FRI_8PM, TUE_BEFORE_HOLIDAY]) {
      const { t, world } = await lowWorld();
      await mdmBattery(t, world, "kai", 14, night - 40 * MIN);
      const summary = await run(t, night);
      expect(summary.status).toBe("not-a-school-night");
      expect(sent).toEqual([]);
    }
  });

  test("no text outside a term (summer has no closure row)", async () => {
    const { t, world } = await lowWorld();
    await t.run(async (ctx) => {
      for (const p of await ctx.db.query("reportingPeriods").collect()) {
        await ctx.db.delete(p._id);
      }
    });
    await mdmBattery(t, world, "kai", 14, WED_8PM - 40 * MIN);

    const summary = await run(t, WED_8PM);

    expect(summary.status).toBe("not-a-school-night");
    expect(sent).toEqual([]);
  });

  test("the night before school resumes says so", async () => {
    const { t, world } = await lowWorld();
    await mdmBattery(t, world, "kai", 14, SUN_AFTER_BREAK - 40 * MIN);

    await run(t, SUN_AFTER_BREAK);

    expect(sent.map((s) => s.body)).toEqual([
      "Moli School: School starts again tomorrow! Kai's BunnyPad is at 14%. Please plug it in tonight so it's ready. Reply NO REMINDERS to stop these.",
    ]);
  });
});

// ── turning it off by text ───────────────────────────────────────────────

describe("NO REMINDERS / REMINDERS ON", () => {
  const ingest = (t: T, body: string, sid: string) =>
    t.mutation(internal.parentSms.ingestInboundSms, {
      messageSid: sid,
      from: PARENT_PHONE,
      body,
    });

  test("turns the reminder off and on, answered in code, never by the aide", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);
    await mdmBattery(t, world, "kai", 14, WED_8PM - 40 * MIN);

    await expect(ingest(t, "No reminders", "SMin1")).resolves.toEqual({
      action: "reminders",
      reply: CHARGE_REMINDERS_OFF_REPLY,
    });
    expect((await smsRow(t)).chargeRemindersOffAt).toEqual(expect.any(Number));
    const summary = await run(t, WED_8PM);
    expect(sent).toEqual([]);
    expect(summary.skipped).toMatchObject({ "reminders-off": 1 });

    await expect(ingest(t, "REMINDERS ON", "SMin2")).resolves.toEqual({
      action: "reminders",
      reply: CHARGE_REMINDERS_ON_REPLY,
    });
    expect((await smsRow(t)).chargeRemindersOffAt).toBeUndefined();
    await run(t, WED_8PM);
    expect(sent).toHaveLength(1);

    // Neither text was queued for the aide.
    const inbound = await t.run((ctx) => ctx.db.query("parentSmsInbound").collect());
    expect(inbound.map((r) => [r.status, r.reason])).toEqual([
      ["ignored", "reminders-off"],
      ["ignored", "reminders-on"],
    ]);
  });

  test("a stranger's NO REMINDERS changes nothing", async () => {
    const t = newTest();
    const world = await seedWorld(t);
    await consent(t, world.parent);

    await expect(
      t.mutation(internal.parentSms.ingestInboundSms, {
        messageSid: "SMin9",
        from: OTHER_PHONE,
        body: "NO REMINDERS",
      }),
    ).resolves.toEqual({ action: "ignored", reply: null });
    expect((await smsRow(t)).chargeRemindersOffAt).toBeUndefined();
  });
});
