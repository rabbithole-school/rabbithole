import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { SMS_TURN_FAILED_TEXT } from "../lib/parentMessageChannels";
import { SMS_HOURLY_CAP } from "../parentSms";
// The webhook schedules these; load them outside the scheduler's pump budget.
import "../parentSms";
import "../parentChat";
import "../deviceLock";

// Why this file: inbound SMS is the first path where an unauthenticated
// request (a text from a phone) reaches the parent aide, which can read a
// child's learning record and freeze their BunnyPad. These pin every gate in
// front of the model (signature, dedupe, keywords, consent, guardianship,
// first-party, ambiguity) and the queue behind it (one turn at a time per
// parent, each bound to its own text, a failure that doesn't wedge the next).
//
// Nothing here can send a real text: `fetch` is replaced for the whole file
// and refuses any host but a fake Twilio, and the model is a fake.

const fake = vi.hoisted(() => ({
  respond: null as
    | null
    | ((params: RunnerParams) => Promise<string | { refuse: true }>),
  calls: [] as RunnerParams[],
}));

type RunnerParams = {
  system: Array<{ text: string }>;
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string; run: (input: unknown) => Promise<unknown> }>;
};

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = {
      messages: {
        toolRunner: (params: RunnerParams) => ({
          async *[Symbol.asyncIterator]() {
            fake.calls.push({ ...params, messages: [...params.messages] });
            const last = params.messages.at(-1)?.content ?? "";
            const out = fake.respond
              ? await fake.respond(params)
              : `Answer to: ${last}`;
            yield (async function* () {
              yield {
                type: "message_start",
                message: {
                  model: "claude-test",
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              };
              if (typeof out === "string") {
                yield {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: out },
                };
              }
              yield {
                type: "message_delta",
                delta: typeof out === "string" ? {} : { stop_reason: "refusal" },
                usage: { output_tokens: 1 },
              };
            })();
          },
        }),
      },
    };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

const SITE = "https://moli-test.convex.site";
const AUTH_TOKEN = "test-twilio-auth-token";
// Fictional 555 numbers only.
const PARENT_PHONE = "+18085550142";
const STAFF_PHONE = "+18085550177";
const STRANGER_PHONE = "+18085550199";

let sent: Array<{ to: string; body: string }> = [];
let logged: string[] = [];

beforeEach(() => {
  sent = [];
  logged = [];
  fake.respond = null;
  fake.calls = [];
  vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
  vi.stubEnv("TWILIO_API_KEY_SID", "SKtest");
  vi.stubEnv("TWILIO_API_KEY_SECRET", "test-secret");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+18885550100");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("SITE_URL", "https://moli.example");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
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
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  // The path's own promise: no phone number reaches a log line.
  for (const line of logged) {
    for (const phone of [PARENT_PHONE, STAFF_PHONE, STRANGER_PHONE]) {
      expect(line).not.toContain(phone.slice(2));
    }
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
 * Moli School (primary) with a teacher. Hoku Makani guardians Kai and Noe,
 * who have BunnyPads. Avery Stone is a teacher AND guardian of Mele. Lehua
 * Torres guardians Lani, who is at another school.
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
  const otherSchool = await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: "Kealia School",
      slug: "kealia",
      kind: "school" as const,
      timeZone: "Pacific/Honolulu",
    }),
  );
  const teacher = await insertUser(t, { name: "Avery Stone", role: "teacher" });
  await t.run((ctx) =>
    ctx.db.insert("memberships", { userId: teacher, role: "teacher", institutionId }),
  );
  const parent = await insertUser(t, { name: "Hoku Makani", role: "parent" });
  const otherParent = await insertUser(t, { name: "Lehua Torres", role: "parent" });
  const kai = await insertUser(t, { name: "Kai Makani", role: "scholar", institutionId });
  const noe = await insertUser(t, { name: "Noe Makani", role: "scholar", institutionId });
  const mele = await insertUser(t, { name: "Mele Stone", role: "scholar", institutionId });
  const lani = await insertUser(t, {
    name: "Lani Torres",
    role: "scholar",
    institutionId: otherSchool,
  });
  const devices: Record<string, Id<"pairedDevices">> = {};
  await t.run(async (ctx) => {
    for (const [p, s] of [
      [parent, kai],
      [parent, noe],
      [teacher, mele],
      [otherParent, lani],
    ] as const) {
      await ctx.db.insert("guardianships", {
        parentUserId: p,
        scholarUserId: s,
        createdBy: teacher,
      });
    }
    for (const [name, s] of [
      ["kai", kai],
      ["noe", noe],
    ] as const) {
      devices[name] = await ctx.db.insert("pairedDevices", {
        deviceId: `ipad-${name}`,
        deviceLabel: `iPad ${name}`,
        scholarId: s,
        institutionId,
        pairedAt: Date.now(),
        pairedBy: teacher,
      });
    }
  });
  return { institutionId, teacher, parent, otherParent, kai, noe, mele, lani, devices };
}

const recordConsent = (t: T, parentUserId: Id<"users">, phone: string) =>
  t.mutation(internal.parentSms.recordSmsConsent, {
    parentUserId,
    phone,
    consentSource: "staff-verbal:Avery Stone",
    consentAt: Date.parse("2026-10-30T19:00:00.000Z"),
  });

// Consent as most tests want it: the intro already sent, so it isn't in
// `sent` or the thread. The intro has its own tests (recordConsent).
async function consent(t: T, parentUserId: Id<"users">, phone: string) {
  const id = await recordConsent(t, parentUserId, phone);
  await t.run((ctx) => ctx.db.patch(id, { introSentAt: Date.now() }));
  return id;
}

// ── a mocked Twilio ──────────────────────────────────────────────────────

async function twilioSignature(url: string, params: Record<string, string>) {
  let data = url;
  for (const name of Object.keys(params).sort()) data += name + params[name];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
  return btoa(String.fromCharCode(...mac));
}

let sidCounter = 0;

/** POST one inbound text the way Twilio does, signed unless told otherwise. */
async function inbound(
  t: T,
  from: string,
  body: string,
  opts: {
    sid?: string;
    extra?: Record<string, string>;
    signature?: string | null;
    signedUrl?: string;
  } = {},
) {
  const params: Record<string, string> = {
    MessageSid: opts.sid ?? `SMin${++sidCounter}`,
    AccountSid: "ACtest",
    From: from,
    To: "+18885550100",
    Body: body,
    NumMedia: "0",
    ...opts.extra,
  };
  const signature =
    opts.signature === undefined
      ? await twilioSignature(opts.signedUrl ?? `${SITE}/twilio/sms`, params)
      : opts.signature;
  const res = await t.fetch("/twilio/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(signature ? { "X-Twilio-Signature": signature } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, text: await res.text(), sid: params.MessageSid };
}

// Small steps, never `runAllTimers`: that would jump to the 11-minute
// watchdog while a turn's action is still in flight, which can't happen live
// (an action is killed at 10 minutes). The watchdog has its own test.
const settle = (t: T) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(10));

const inboundRows = (t: T) =>
  t.run((ctx) => ctx.db.query("parentSmsInbound").collect());

const chatRows = (t: T, parentUserId: Id<"users">) =>
  t.run((ctx) =>
    ctx.db
      .query("parentChatMessages")
      .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
      .collect(),
  );

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// ── signature ────────────────────────────────────────────────────────────

describe("/twilio/sms verifies Twilio's signature and fails closed", () => {
  test("a valid signature over the public URL is accepted and answered", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, "(808) 555-0142");

    const res = await inbound(t, PARENT_PHONE, "How is Kai doing?");
    expect(res.status).toBe(200);
    expect(res.text).toBe(EMPTY_TWIML); // acknowledged at once; no model work inline
    expect(fake.calls).toHaveLength(0);

    await settle(t);
    expect(sent).toEqual([{ to: PARENT_PHONE, body: "Answer to: How is Kai doing?" }]);
    expect((await inboundRows(t)).map((r) => r.status)).toEqual(["answered"]);
  });

  test("bad, missing, or wrongly-scoped signatures write nothing", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);

    // Tampered signature.
    expect((await inbound(t, PARENT_PHONE, "hi", { signature: "bm9wZQ==" })).status).toBe(403);
    // No header.
    expect((await inbound(t, PARENT_PHONE, "hi", { signature: null })).status).toBe(403);
    // Signed over the request's internal URL, not the public one Twilio calls.
    expect(
      (await inbound(t, PARENT_PHONE, "hi", { signedUrl: "https://some.convex.site/twilio/sms" }))
        .status,
    ).toBe(403);
    // Signed for different params than were sent (a replayed signature).
    const sig = await twilioSignature(`${SITE}/twilio/sms`, { Body: "other" });
    expect((await inbound(t, PARENT_PHONE, "hi", { signature: sig })).status).toBe(403);

    // No auth token configured.
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    expect((await inbound(t, PARENT_PHONE, "hi")).status).toBe(403);
    vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
    // No public site URL to verify against.
    vi.stubEnv("CONVEX_SITE_URL", "");
    expect((await inbound(t, PARENT_PHONE, "hi")).status).toBe(403);

    await settle(t);
    expect(await inboundRows(t)).toEqual([]);
    expect(await chatRows(t, parent)).toEqual([]);
    expect(sent).toEqual([]);
  });
});

// ── dedupe ───────────────────────────────────────────────────────────────

test("a Twilio retry with the same MessageSid appends nothing and answers once", async () => {
  vi.useFakeTimers();
  const t = newTest();
  const { parent } = await seedWorld(t);
  await consent(t, parent, PARENT_PHONE);

  const first = await inbound(t, PARENT_PHONE, "How is Kai doing?", { sid: "SMretry1" });
  const retry = await inbound(t, PARENT_PHONE, "How is Kai doing?", { sid: "SMretry1" });
  expect([first.status, retry.status]).toEqual([200, 200]);
  await settle(t);
  // A retry after the turn already ran is still a no-op.
  await inbound(t, PARENT_PHONE, "How is Kai doing?", { sid: "SMretry1" });
  await settle(t);

  expect(await inboundRows(t)).toHaveLength(1);
  expect((await chatRows(t, parent)).map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(fake.calls).toHaveLength(1);
  expect(sent).toHaveLength(1);
});

// ── who may reach the aide ───────────────────────────────────────────────

describe("only one consented, eligible guardian reaches the aide", () => {
  async function expectNoTurn(t: T, from: string, reason: string) {
    const res = await inbound(t, from, "How is Kai doing?");
    expect(res).toMatchObject({ status: 200, text: EMPTY_TWIML });
    await settle(t);
    expect(fake.calls).toHaveLength(0);
    expect(sent).toEqual([]);
    const rows = await inboundRows(t);
    expect(rows.at(-1)).toMatchObject({ status: "ignored", reason });
    expect(rows.at(-1)!.body).toBeUndefined();
  }

  test("an unknown number gets no turn, no reply, no stored number or text", async () => {
    vi.useFakeTimers();
    const t = newTest();
    await seedWorld(t);
    await expectNoTurn(t, STRANGER_PHONE, "unknown-number");
  });

  test("a number with no consent date gets no turn", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("parentChannelIdentities", {
        parentUserId: parent,
        channel: "sms",
        identity: "18085550142",
      }),
    );
    await expectNoTurn(t, PARENT_PHONE, "no-consent");
  });

  test("a stopped number gets no turn", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const row = await consent(t, parent, PARENT_PHONE);
    await t.run((ctx) => ctx.db.patch(row, { stopState: true }));
    await expectNoTurn(t, PARENT_PHONE, "stopped-number");
  });

  test("two rows for one number (two families, or a duplicate) get no turn", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent, otherParent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    // recordSmsConsent refuses this, so it can only come from a bad import.
    await t.run((ctx) =>
      ctx.db.insert("parentChannelIdentities", {
        parentUserId: otherParent,
        channel: "sms",
        identity: "18085550142",
        optInAt: Date.now(),
      }),
    );
    await expectNoTurn(t, PARENT_PHONE, "ambiguous-identity");

    // Same parent twice is refused too: it is still not exactly one row.
    const t2 = newTest();
    const w2 = await seedWorld(t2);
    await consent(t2, w2.parent, PARENT_PHONE);
    await t2.run((ctx) =>
      ctx.db.insert("parentChannelIdentities", {
        parentUserId: w2.parent,
        channel: "sms",
        identity: "18085550142",
        optInAt: Date.now(),
      }),
    );
    await expectNoTurn(t2, PARENT_PHONE, "ambiguous-identity");
  });

  test("a guardian who has lost their guardianship gets no turn", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    await t.run(async (ctx) => {
      const links = await ctx.db
        .query("guardianships")
        .withIndex("by_parent", (q) => q.eq("parentUserId", parent))
        .collect();
      for (const link of links) await ctx.db.delete(link._id);
    });
    await expectNoTurn(t, PARENT_PHONE, "not-guardian");
  });

  test("a staff guardian is authorized by guardianship, not role", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { teacher } = await seedWorld(t);
    await consent(t, teacher, STAFF_PHONE);

    await inbound(t, STAFF_PHONE, "How is Mele doing?");
    await settle(t);

    expect(sent).toEqual([{ to: STAFF_PHONE, body: "Answer to: How is Mele doing?" }]);
    // Scoped to the teacher's own child, never their class.
    expect(fake.calls[0].system[0].text).toContain("Mele Stone");
    expect(fake.calls[0].system[0].text).not.toContain("Kai Makani");
  });
});

describe("recordSmsConsent (staff, after verbal consent)", () => {
  test("normalizes the number the same way inbound does, and records who and when", async () => {
    const t = newTest();
    const { parent } = await seedWorld(t);
    const id = await consent(t, parent, "(808) 555-0142");
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({
      channel: "sms",
      identity: "18085550142",
      consentSource: "staff-verbal:Avery Stone",
      optInAt: Date.parse("2026-10-30T19:00:00.000Z"),
      stopState: false,
      scope: "aide",
    });
    // Re-recording the same guardian updates in place (and clears a STOP).
    await t.run((ctx) => ctx.db.patch(id, { stopState: true }));
    expect(await consent(t, parent, "+1 808 555 0142")).toBe(id);
    expect((await t.run((ctx) => ctx.db.get(id)))!.stopState).toBe(false);
  });

  test("refuses a non-guardian, a child at another school, a short number, and a number someone else holds", async () => {
    const t = newTest();
    const { parent, otherParent, teacher } = await seedWorld(t);
    const stranger = await insertUser(t, { name: "Sloane Kahale", role: "parent" });
    await expect(consent(t, stranger, PARENT_PHONE)).rejects.toThrow("not-guardian");
    // Lani is at Kealia, not the primary school that owns the number.
    await expect(consent(t, otherParent, PARENT_PHONE)).rejects.toThrow("not-first-party");
    await expect(consent(t, parent, "555-0142")).rejects.toThrow("not a full phone number");
    await consent(t, parent, PARENT_PHONE);
    await expect(consent(t, teacher, PARENT_PHONE)).rejects.toThrow(
      "linked to another account",
    );
  });
});

describe("the intro text, sent once when consent is first recorded", () => {
  test("names a different kid in each example, lands in the thread, and isn't resent", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const id = await recordConsent(t, parent, "(808) 555-0142");
    await settle(t);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(PARENT_PHONE);
    expect(sent[0].body).toContain("Ask what Kai is learning");
    expect(sent[0].body).toContain(`"freeze Noe's BunnyPad"`);
    expect(sent[0].body).toMatch(/Reply HELP for help, STOP to opt out\.$/);
    expect((await chatRows(t, parent)).map((r) => [r.role, r.content])).toEqual([
      ["assistant", sent[0].body],
    ]);
    expect((await t.run((ctx) => ctx.db.get(id)))!.introSentAt).toBeDefined();

    // Re-recording (here, after a STOP) doesn't send it again.
    await t.run((ctx) => ctx.db.patch(id, { stopState: true }));
    await recordConsent(t, parent, PARENT_PHONE);
    await settle(t);
    expect(sent).toHaveLength(1);
  });

  test("a STOP before the intro goes out stops it, and re-opting in doesn't text the blocked number", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const id = await recordConsent(t, parent, PARENT_PHONE);
    await t.run((ctx) => ctx.db.patch(id, { stopState: true }));
    await settle(t);
    expect(sent).toEqual([]);
    // Clearing the STOP: the carrier still blocks the number until START.
    await recordConsent(t, parent, PARENT_PHONE);
    await settle(t);
    expect(sent).toEqual([]);
  });
});

// ── keywords ─────────────────────────────────────────────────────────────

describe("STOP, START, and HELP are handled in code, before the model", () => {
  test("STOP (and carrier synonyms) records stopState on every row for the number, silently", async () => {
    for (const word of ["STOP", "unsubscribe", " Cancel ", "quit", "OPTOUT", "revoke"]) {
      vi.useFakeTimers();
      const t = newTest();
      const { parent } = await seedWorld(t);
      const row = await consent(t, parent, PARENT_PHONE);
      sent = [];
      const res = await inbound(t, PARENT_PHONE, word);
      // No reply of ours: the toll-free network already sent its own.
      expect(res.text).toBe(EMPTY_TWIML);
      await settle(t);
      expect((await t.run((ctx) => ctx.db.get(row)))!.stopState).toBe(true);
      expect(fake.calls).toHaveLength(0);
      expect(sent).toEqual([]);
      expect((await inboundRows(t)).map((r) => r.status)).toEqual(["stopped"]);
      vi.useRealTimers();
    }
  });

  test("a forwarded STOP via OptOutType counts even if the body is unusual", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const row = await consent(t, parent, PARENT_PHONE);
    await inbound(t, PARENT_PHONE, "stop2", { extra: { OptOutType: "STOP" } });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(row)))!.stopState).toBe(true);
  });

  test("a STOP while a question waits cancels the reply", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    await inbound(t, PARENT_PHONE, "How is Kai doing?");
    await inbound(t, PARENT_PHONE, "STOP");
    await settle(t);
    expect(fake.calls).toHaveLength(0);
    expect(sent).toEqual([]);
    expect((await inboundRows(t)).map((r) => [r.status, r.reason])).toEqual([
      ["ignored", "consent-withdrawn"],
      ["stopped", undefined],
    ]);
  });

  test("a sentence containing stop is a question, not an opt-out", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const row = await consent(t, parent, PARENT_PHONE);
    await inbound(t, PARENT_PHONE, "Can you stop Kai's BunnyPad for an hour?");
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(row)))!.stopState).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  test("HELP gets the program's help text inline, unless Twilio already answered it", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    const res = await inbound(t, PARENT_PHONE, "support");
    expect(res.text).toContain("<Message>Moli School family texts from Rabbithole:");
    expect(res.text).toContain("BunnyPad");
    expect(res.text).toContain("https://moli.example/parent");
    expect(res.text).toContain("Reply STOP to opt out.");
    expect(res.text).toContain("Msg &amp; data rates may apply.");

    // Advanced Opt-Out forwards HELP with OptOutType after replying itself.
    const forwarded = await inbound(t, PARENT_PHONE, "HELP", {
      extra: { OptOutType: "HELP" },
    });
    expect(forwarded.text).toBe(EMPTY_TWIML);
    await settle(t);
    expect(fake.calls).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  test("an unknown sender gets no HELP reply of ours (no SMS-pumping target)", async () => {
    vi.useFakeTimers();
    const t = newTest();
    await seedWorld(t);
    for (const word of ["support", "HELP", "info"]) {
      expect((await inbound(t, STRANGER_PHONE, word)).text).toBe(EMPTY_TWIML);
    }
    await settle(t);
    expect((await inboundRows(t)).map((r) => [r.status, r.reason])).toEqual([
      ["ignored", "unknown-number"],
      ["ignored", "unknown-number"],
      ["ignored", "unknown-number"],
    ]);
    expect(sent).toEqual([]);
  });

  test("punctuated keywords count: STOP. opts out", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const row = await consent(t, parent, PARENT_PHONE);
    await inbound(t, PARENT_PHONE, "STOP.");
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(row)))!.stopState).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  test("a From that isn't one E.164 number never resolves to a family", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const row = await consent(t, parent, PARENT_PHONE);
    for (const from of [`whatsapp:${PARENT_PHONE}`, "18085550142", "+1808555014", "+1 808 555 0142"]) {
      expect((await inbound(t, from, "STOP")).text).toBe(EMPTY_TWIML);
    }
    await inbound(t, `whatsapp:${PARENT_PHONE}`, "How is my child doing?");
    await settle(t);
    expect(fake.calls).toHaveLength(0);
    expect(sent).toEqual([]);
    // Not even a STOP lands on the family's row from a malformed sender.
    expect((await t.run((ctx) => ctx.db.get(row)))!.stopState).toBe(false);
    expect((await inboundRows(t)).every((r) => r.reason === "malformed-from")).toBe(true);
  });

  test("START never re-opts a stopped number and never reaches the aide", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const row = await consent(t, parent, PARENT_PHONE);
    await t.run((ctx) => ctx.db.patch(row, { stopState: true }));
    expect((await inbound(t, PARENT_PHONE, "START")).text).toBe(EMPTY_TWIML);
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(row)))!.stopState).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

// ── the turn ─────────────────────────────────────────────────────────────

describe("an SMS turn is the parent aide, in plain text", () => {
  test("freeze a BunnyPad by text, end to end, audited as parent_sms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T03:00:00.000Z"));
    const t = newTest();
    const { parent, devices } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    fake.respond = async (params) => {
      const set = params.tools.find((tool) => tool.name === "set_bunnypad_freeze")!;
      return String(await set.run({ childName: "Kai", frozen: true, minutes: 30 }));
    };

    await inbound(t, PARENT_PHONE, "Please freeze Kai's BunnyPad for 30 minutes");
    await settle(t);

    const device = await t.run((ctx) => ctx.db.get(devices.kai));
    // 30 minutes from the text (the settle steps move the fake clock a few ms).
    const end = Date.parse("2026-11-02T03:30:00.000Z");
    expect(device!.freezeUntil! - end).toBeGreaterThanOrEqual(0);
    expect(device!.freezeUntil! - end).toBeLessThan(1000);
    expect(device!.freezeUpdatedBy).toBe(parent);
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "device.freeze.start"))
        .collect(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toContain("via parent_sms");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/^Kai Makani's BunnyPad will be frozen until /);

    // The prompt carried the SMS rules; links are absolute.
    const system = fake.calls[0].system[0].text;
    expect(system).toContain("## Links & formatting (SMS)");
  });

  test("a refusal notice goes out without markdown", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    fake.respond = async () => ({ refuse: true });
    await inbound(t, PARENT_PHONE, "How is Kai doing?");
    await settle(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/declined/);
    expect(sent[0].body).not.toMatch(/(^_|_$)/);
  });

  test("a reply longer than Twilio's cap is truncated, not rejected", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    fake.respond = async () => "word ".repeat(500);
    await inbound(t, PARENT_PHONE, "Tell me everything");
    await settle(t);
    expect(sent[0].body.length).toBeLessThanOrEqual(1600);
    expect(sent[0].body.endsWith("…")).toBe(true);
  });
});

describe("one turn at a time per parent, each bound to its own text (TRA-558)", () => {
  test("two quick texts are answered in order, each to its own question", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);

    // Both land before either turn runs.
    await inbound(t, PARENT_PHONE, "How is Kai doing?");
    await inbound(t, PARENT_PHONE, "And Noe?");
    await settle(t);

    expect(fake.calls).toHaveLength(2);
    // The first turn saw only its own question, not the later one.
    expect(fake.calls[0].messages).toEqual([
      { role: "user", content: "How is Kai doing?" },
    ]);
    expect(fake.calls[1].messages).toEqual([
      { role: "user", content: "How is Kai doing?" },
      { role: "assistant", content: "Answer to: How is Kai doing?" },
      { role: "user", content: "And Noe?" },
    ]);
    expect(sent.map((s) => s.body)).toEqual([
      "Answer to: How is Kai doing?",
      "Answer to: And Noe?",
    ]);
    expect((await inboundRows(t)).map((r) => r.status)).toEqual(["answered", "answered"]);
  });

  test("getContext binds history to the turn's own message, and only the parent's", async () => {
    const t = newTest();
    const { parent, otherParent } = await seedWorld(t);
    const [first, , , foreign] = await t.run(async (ctx) => [
      await ctx.db.insert("parentChatMessages", { parentUserId: parent, role: "user", content: "one" }),
      await ctx.db.insert("parentChatMessages", { parentUserId: parent, role: "assistant", content: "reply" }),
      await ctx.db.insert("parentChatMessages", { parentUserId: parent, role: "user", content: "two" }),
      await ctx.db.insert("parentChatMessages", { parentUserId: otherParent, role: "user", content: "x" }),
    ]);
    const bound = await t.query(internal.parentChat.getContext, {
      parentUserId: parent,
      throughMessageId: first,
    });
    expect(bound!.messages.map((m) => m.content)).toEqual(["one"]);
    expect(
      await t.query(internal.parentChat.getContext, {
        parentUserId: parent,
        throughMessageId: foreign,
      }),
    ).toBeNull();
  });
});

describe("a failed turn tells the parent and doesn't block the next text", () => {
  test("a model error sends the failure text; the next text is answered", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    let first = true;
    fake.respond = async (params) => {
      if (first) {
        first = false;
        throw new Error("overloaded");
      }
      return `Answer to: ${params.messages.at(-1)!.content}`;
    };

    await inbound(t, PARENT_PHONE, "How is Kai doing?");
    await settle(t);
    await inbound(t, PARENT_PHONE, "Trying again: how is Kai?");
    await settle(t);

    expect(sent.map((s) => s.body)).toEqual([
      SMS_TURN_FAILED_TEXT,
      "Answer to: Trying again: how is Kai?",
    ]);
    expect((await inboundRows(t)).map((r) => [r.status, r.reason])).toEqual([
      ["failed", "turn-error"],
      ["answered", undefined],
    ]);
    // The failure is the aide's reply in the thread, so the next turn sees
    // the earlier request as failed rather than as still open.
    expect(fake.calls[1].messages).toEqual([
      { role: "user", content: "How is Kai doing?" },
      { role: "assistant", content: SMS_TURN_FAILED_TEXT },
      { role: "user", content: "Trying again: how is Kai?" },
    ]);
    // No streaming placeholder or other half-written row is left behind.
    expect((await chatRows(t, parent)).every((m) => m.streamId === undefined)).toBe(true);
  });

  test("a turn whose action died is failed by the watchdog, and the queue moves on", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    const identityId = await consent(t, parent, PARENT_PHONE);
    // A turn left "running" by an action that was killed mid-turn.
    const stuck = await t.run((ctx) =>
      ctx.db.insert("parentSmsInbound", {
        messageSid: "SMstuck",
        parentUserId: parent,
        identityId,
        status: "running",
        startedAt: Date.now(),
      }),
    );
    await inbound(t, PARENT_PHONE, "Are you there?");
    await settle(t);
    // Waiting behind the stuck turn, not answered out of order.
    expect(fake.calls).toHaveLength(0);

    await t.mutation(internal.parentSms.expireStuckSmsTurn, { turnId: stuck });
    await settle(t);

    expect(sent.map((s) => s.body)).toEqual([
      SMS_TURN_FAILED_TEXT,
      "Answer to: Are you there?",
    ]);
    expect((await t.run((ctx) => ctx.db.get(stuck)))).toMatchObject({
      status: "failed",
      reason: "timed-out",
    });
    // The watchdog saved the failure as the aide's reply too; the history
    // still opens with the parent (the stuck turn never saved its text).
    expect((await chatRows(t, parent)).map((m) => [m.role, m.content])).toEqual([
      ["assistant", SMS_TURN_FAILED_TEXT],
      ["user", "Are you there?"],
      ["assistant", "Answer to: Are you there?"],
    ]);
    expect(fake.calls[0].messages).toEqual([{ role: "user", content: "Are you there?" }]);
  });

  test("a queued text older than five minutes is dropped, not answered later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T03:00:00.000Z"));
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    await inbound(t, PARENT_PHONE, "Freeze the BunnyPad now");
    // Its turn doesn't come up until six minutes later.
    vi.setSystemTime(new Date("2026-11-02T03:06:00.000Z"));
    await settle(t);
    expect(fake.calls).toHaveLength(0);
    expect(sent).toEqual([]);
    expect((await inboundRows(t)).map((r) => [r.status, r.reason, r.body])).toEqual([
      ["ignored", "stale", undefined],
    ]);
  });

  test("a guardianship removed mid-turn stops the reply", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    fake.respond = async () => {
      await t.run(async (ctx) => {
        for (const link of await ctx.db
          .query("guardianships")
          .withIndex("by_parent", (q) => q.eq("parentUserId", parent))
          .collect()) {
          await ctx.db.delete(link._id);
        }
      });
      return "A reply carrying the child's learning details.";
    };
    await inbound(t, PARENT_PHONE, "How is my child doing?");
    await settle(t);
    expect(fake.calls).toHaveLength(1);
    expect(sent).toEqual([]);
    expect((await inboundRows(t)).map((r) => [r.status, r.reason])).toEqual([
      ["answered", "no-reply-target"],
    ]);
  });

  test("SMS credentials missing: the turn runs and is recorded, nothing is sent", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    vi.stubEnv("TWILIO_API_KEY_SECRET", "");
    await inbound(t, PARENT_PHONE, "How is Kai doing?");
    await settle(t);
    expect(sent).toEqual([]);
    expect((await inboundRows(t)).map((r) => [r.status, r.reason])).toEqual([
      ["answered", "sms-not-configured"],
    ]);
  });
});

// ── cost cap and loop guard ──────────────────────────────────────────────

describe("an hourly cap and a repeat guard keep a loop from running the model", () => {
  test(`past ${SMS_HOURLY_CAP} texts in an hour the rest are ignored, until the hour rolls over`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T03:00:00.000Z"));
    const t = newTest();
    const { parent } = await seedWorld(t);
    const identityId = await consent(t, parent, PARENT_PHONE);
    await t.run(async (ctx) => {
      for (let i = 0; i < SMS_HOURLY_CAP; i++) {
        await ctx.db.insert("parentSmsInbound", {
          messageSid: `SMearlier${i}`,
          parentUserId: parent,
          identityId,
          status: "answered",
        });
      }
    });

    await inbound(t, PARENT_PHONE, "One more question");
    await settle(t);
    expect(fake.calls).toHaveLength(0);
    expect((await inboundRows(t)).at(-1)).toMatchObject({
      status: "ignored",
      reason: "rate-limited",
    });

    vi.setSystemTime(new Date("2026-11-02T04:01:00.000Z"));
    await inbound(t, PARENT_PHONE, "One more question");
    await settle(t);
    expect(sent.map((x) => x.body)).toEqual(["Answer to: One more question"]);
  });

  test("an exact repeat of the previous text within the hour is ignored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T03:00:00.000Z"));
    const t = newTest();
    const { parent } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    // An auto-responder answering each reply with the same words.
    await inbound(t, PARENT_PHONE, "I'm driving, I'll text you later");
    await settle(t);
    await inbound(t, PARENT_PHONE, "I'm driving, I'll text you later");
    await settle(t);
    // Different words are a new question.
    await inbound(t, PARENT_PHONE, "Is the BunnyPad frozen?");
    await settle(t);
    expect(fake.calls).toHaveLength(2);
    expect((await inboundRows(t)).map((r) => [r.status, r.reason])).toEqual([
      ["answered", undefined],
      ["ignored", "repeat"],
      ["answered", undefined],
    ]);
    // No text body is kept once a turn has run; only its hash.
    expect((await inboundRows(t)).every((r) => r.body === undefined)).toBe(true);

    // After the hour, the same words are answered again.
    vi.setSystemTime(new Date("2026-11-02T04:01:00.000Z"));
    await inbound(t, PARENT_PHONE, "Is the BunnyPad frozen?");
    await settle(t);
    expect(fake.calls).toHaveLength(3);
  });
});

// ── teacher messages stay off ────────────────────────────────────────────

describe("aide consent doesn't turn on teacher messages by SMS", () => {
  async function withUser(t: T, userId: Id<"users">) {
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 60 * 60_000,
      }),
    );
    return t.withIdentity({
      subject: `${userId}|${sessionId}`,
      issuer: "https://convex.dev",
    });
  }

  async function deliveryChannelsOfLatest(t: T, threadId: Id<"parentThreads">) {
    const msgs = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    const rows = await t.run((ctx) =>
      ctx.db
        .query("messageDeliveries")
        .withIndex("by_message", (q) => q.eq("messageId", msgs.at(-1)!._id))
        .collect(),
    );
    return rows.map((d) => d.channel).sort();
  }

  test("a teacher's message queues no SMS delivery on an aide-consent row", async () => {
    // Fake timers: sendMessage schedules a dispatch that must not fire
    // into a later test.
    vi.useFakeTimers();
    const t = newTest();
    const { parent, teacher, kai } = await seedWorld(t);
    const row = await consent(t, parent, PARENT_PHONE);
    const asTeacher = await withUser(t, teacher);

    const first = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "A note about tomorrow",
      scholarId: kai,
    });
    expect(await deliveryChannelsOfLatest(t, first.threadIds[0])).not.toContain("sms");

    // The same row without the aide scope (a broader, older consent) does.
    await t.run((ctx) => ctx.db.patch(row, { scope: undefined }));
    const second = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "Another note",
      scholarId: kai,
    });
    expect(await deliveryChannelsOfLatest(t, second.threadIds[0])).toContain("sms");
  });

  test("the send path won't text a queued teacher SMS to an aide-consent number", async () => {
    // Fake timers: sendMessage schedules a dispatch that must not fire
    // into a later test.
    vi.useFakeTimers();
    const t = newTest();
    const { parent, teacher, kai } = await seedWorld(t);
    await consent(t, parent, PARENT_PHONE);
    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.mutation(api.parentMessages.sendMessage, {
      body: "A note about tomorrow",
      scholarId: kai,
    });
    const msgs = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", res.threadIds[0]))
        .collect(),
    );
    // A delivery queued before the scope existed, say.
    const delivery = await t.run((ctx) =>
      ctx.db.insert("messageDeliveries", {
        messageId: msgs.at(-1)!._id,
        parentUserId: parent,
        channel: "sms",
        status: "queued",
      }),
    );
    await t.action(internal.parentMessageSend.dispatch, { messageIds: [msgs.at(-1)!._id] });
    expect(sent).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(delivery)))!.status).not.toBe("sent");
  });

  test("a parent can't self-serve resume (or toggle) an SMS row", async () => {
    const t = newTest();
    const { parent } = await seedWorld(t);
    const row = await consent(t, parent, PARENT_PHONE);
    const asParent = await withUser(t, parent);
    await expect(
      asParent.mutation(api.parentMessages.setMyChannelStopped, {
        channelId: row,
        stopped: false,
      }),
    ).rejects.toThrow("set up by the school office");
  });
});
