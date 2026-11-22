/**
 * TRA-496: public actions that spent AI money or wrote rows with no caller
 * check. Each one is now either signed-in-only (it has an app caller) or
 * internal (ops/CLI only — `npx convex run` still reaches it, a client cannot).
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import * as audioActions from "../audioActions";
import * as deliverables from "../deliverables";
import * as openMap from "../openMap";
import * as standardsImport from "../standardsImport";
import * as standardsMapper from "../standardsMapper";
import * as understandings from "../understandings";

const createModel = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createModel };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

afterEach(() => {
  createModel.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedScholar(t: T) {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: "Test Scholar", username: "aa-scholar", role: "scholar" }),
  );
}

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60 * 60 * 1_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

function stubWhisper() {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  const fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ text: "hello", duration: 1.5 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

const audio = { audioBase64: Buffer.from("audio").toString("base64") };

describe("audioActions.transcribe", () => {
  test("refuses an anonymous caller before any Whisper spend", async () => {
    const fetchSpy = stubWhisper();
    const t = convexTest(schema, modules);
    await expect(t.action(api.audioActions.transcribe, audio)).rejects.toThrow("Not authenticated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("transcribes for a signed-in scholar", async () => {
    const fetchSpy = stubWhisper();
    const t = convexTest(schema, modules);
    const asScholar = await withUser(t, await seedScholar(t));
    await expect(asScholar.action(api.audioActions.transcribe, audio)).resolves.toEqual({
      text: "hello",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("suspended institution and foreign sessions", () => {
  async function seedSchool(t: T, slug: string, disabled: boolean) {
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: slug,
        slug,
        kind: "school",
        ...(disabled ? { disabledAt: 1 } : {}),
      }),
    );
    const scholarId = await t.run((ctx) =>
      ctx.db.insert("users", { name: slug, username: `u-${slug}`, role: "scholar", institutionId }),
    );
    return { institutionId, scholarId };
  }

  test("a scholar of a suspended school gets no Whisper or model spend", async () => {
    const fetchSpy = stubWhisper();
    const t = convexTest(schema, modules);
    const { scholarId } = await seedSchool(t, "paused", true);
    const asScholar = await withUser(t, scholarId);
    await expect(asScholar.action(api.audioActions.transcribe, audio)).rejects.toThrow(
      /paused/,
    );
    await expect(
      asScholar.action(api.openMap.leapsForConcept, { concept: "Fractions" }),
    ).rejects.toThrow(/paused/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createModel).not.toHaveBeenCalled();
  });

  test("a foreign session id is refused before Whisper and writes no usage", async () => {
    const fetchSpy = stubWhisper();
    const t = convexTest(schema, modules);
    const a = await seedSchool(t, "school-a", false);
    const b = await seedSchool(t, "school-b", false);
    const foreignSession = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: b.scholarId,
        title: "B work",
        isArchived: false,
        institutionId: b.institutionId,
      }),
    );
    const asA = await withUser(t, a.scholarId);
    await expect(
      asA.action(api.audioActions.transcribe, { ...audio, sessionId: foreignSession }),
    ).rejects.toThrow(/not your session/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("usageEvents").collect())).toHaveLength(0);
  });

  test("an own session stamped with a school the scholar has left is refused before Whisper", async () => {
    const fetchSpy = stubWhisper();
    const t = convexTest(schema, modules);
    const a = await seedSchool(t, "school-a", false);
    const b = await seedSchool(t, "school-b", false);
    // The scholar's own session, from when they belonged to school B.
    const leftBehind = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: a.scholarId,
        title: "From B",
        isArchived: false,
        institutionId: b.institutionId,
      }),
    );
    const asA = await withUser(t, a.scholarId);
    await expect(
      asA.action(api.audioActions.transcribe, { ...audio, sessionId: leftBehind }),
    ).rejects.toThrow(/not in your learning community/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("usageEvents").collect())).toHaveLength(0);
  });

  test("an own session and a sessionless call both transcribe", async () => {
    stubWhisper();
    const t = convexTest(schema, modules);
    const a = await seedSchool(t, "school-a", false);
    const own = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: a.scholarId,
        title: "Mine",
        isArchived: false,
        institutionId: a.institutionId,
      }),
    );
    const asA = await withUser(t, a.scholarId);
    await expect(
      asA.action(api.audioActions.transcribe, { ...audio, sessionId: own }),
    ).resolves.toEqual({ text: "hello" });
    await expect(asA.action(api.audioActions.transcribe, audio)).resolves.toEqual({
      text: "hello",
    });
    const events = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(events.every((e) => e.institutionId === a.institutionId || !e.sessionId)).toBe(true);
  });
});

describe("openMap.leapsForConcept", () => {
  const leap = { topic: "Bridges", bridge: "arches spread a load", domain: "Engineering", reach: 1 };

  test("refuses an anonymous caller before any model spend", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(api.openMap.leapsForConcept, { concept: "Fractions" }),
    ).rejects.toThrow("Not authenticated");
    expect(createModel).not.toHaveBeenCalled();
  });

  test("returns leaps for a signed-in scholar", async () => {
    createModel.mockResolvedValue({
      content: [{ type: "tool_use", name: "record_leaps", input: { leaps: [leap] } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const t = convexTest(schema, modules);
    const asScholar = await withUser(t, await seedScholar(t));
    const res = await asScholar.action(api.openMap.leapsForConcept, { concept: "Fractions" });
    expect(res).toEqual({ concept: "Fractions", leaps: [leap] });
    expect(createModel).toHaveBeenCalledTimes(1);
  });
});

describe("ops-only actions are internal", () => {
  test("no client can call them", () => {
    const fns = {
      "understandings.translateBand": understandings.translateBand,
      "standardsImport.importCommonCoreMath": standardsImport.importCommonCoreMath,
      "standardsImport.importCommonCoreELA": standardsImport.importCommonCoreELA,
      "standardsImport.importUCLAHistoricalThinking": standardsImport.importUCLAHistoricalThinking,
      "standardsImport.importNGSS": standardsImport.importNGSS,
      "standardsImport.importNGSSScience": standardsImport.importNGSSScience,
      "standardsMapper.backfillAll": standardsMapper.backfillAll,
      "standardsMapper.rebackfillAll": standardsMapper.rebackfillAll,
      "deliverables.checkRubric": deliverables.checkRubric,
    } as Record<string, { isInternal?: boolean; isPublic?: boolean }>;
    for (const [name, fn] of Object.entries(fns)) {
      expect({ name, isInternal: fn.isInternal, isPublic: fn.isPublic }).toEqual({
        name,
        isInternal: true,
        isPublic: undefined,
      });
    }
    // The app-facing ones stay public, behind the signed-in gate above.
    const publicFns = [audioActions.transcribe, openMap.leapsForConcept] as Array<{
      isPublic?: boolean;
    }>;
    for (const fn of publicFns) expect(fn.isPublic).toBe(true);
  });

  test("an ops caller still runs one (translateBand, nothing to translate)", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(internal.understandings.translateBand, { strandKey: "none", grade: "4" }),
    ).resolves.toEqual({ translated: 0, skipped: 0 });
    expect(createModel).not.toHaveBeenCalled();
  });
});
