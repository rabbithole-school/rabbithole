import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { MODELS } from "../lib/models";
import {
  resolveAideModel,
  aideMaxTokens,
  aideEffort,
  aideRefusalFallback,
  aideThinking,
} from "../lib/aideModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Pure resolver ────────────────────────────────────────────────────────

describe("resolveAideModel", () => {
  test("no preference → Opus 5.5 default", () => {
    expect(resolveAideModel(undefined)).toBe(MODELS.OPUS_5_5);
    expect(resolveAideModel(null)).toBe(MODELS.OPUS_5_5);
  });

  test("sonnet / opus / fable preferences resolve to their models", () => {
    expect(resolveAideModel("sonnet")).toBe(MODELS.SONNET);
    expect(resolveAideModel("opus")).toBe(MODELS.OPUS_5_5);
    expect(resolveAideModel("fable")).toBe(MODELS.FABLE);
  });

  test("the retired AIDE_MODEL env lever no longer resolves anything", () => {
    // It used to sit between the pin and the code default — and a pin
    // outranked it, so the documented "instant fleet revert" could not reach
    // pinned users. Deleted: the default is a code constant, full stop.
    process.env.AIDE_MODEL = MODELS.SONNET;
    try {
      expect(resolveAideModel(undefined)).toBe(MODELS.OPUS_5_5);
      expect(resolveAideModel("opus")).toBe(MODELS.OPUS_5_5);
    } finally {
      delete process.env.AIDE_MODEL;
    }
  });
});

describe("aideRefusalFallback", () => {
  test("the classifier tiers (Fable, Opus 5.5) fall back to Opus 4.8", () => {
    expect(aideRefusalFallback(MODELS.FABLE)).toBe(MODELS.OPUS);
    expect(aideRefusalFallback(MODELS.OPUS_5_5)).toBe(MODELS.OPUS);
  });

  test("every other model has no fallback — a refusal there is a real decline", () => {
    expect(aideRefusalFallback(MODELS.OPUS)).toBeNull();
    expect(aideRefusalFallback(MODELS.SONNET)).toBeNull();
    expect(aideRefusalFallback(MODELS.HAIKU)).toBeNull();
    // A retired Fable slug must not opt into the retry either — the policy
    // follows the CURRENT model constant.
    expect(aideRefusalFallback("claude-fable-5")).toBeNull();
  });

  test("the fallback is never the model that just refused (no retry loop)", () => {
    const fallback = aideRefusalFallback(MODELS.FABLE);
    expect(fallback).not.toBe(MODELS.FABLE);
    // …and the fallback itself doesn't chain into another retry.
    expect(aideRefusalFallback(fallback as string)).toBeNull();
  });
});

describe("aideMaxTokens", () => {
  test("Fable and Opus 5.5 raise the cap (thinking bills as output)", () => {
    expect(aideMaxTokens(MODELS.FABLE, 4096)).toBe(16000);
    expect(aideMaxTokens(MODELS.OPUS_5_5, 4096)).toBe(16000);
    expect(aideMaxTokens(MODELS.FABLE, 20000)).toBe(20000);
  });

  test("non-Fable models keep the caller's base", () => {
    expect(aideMaxTokens(MODELS.SONNET, 4096)).toBe(4096);
    expect(aideMaxTokens(MODELS.OPUS, 2048)).toBe(2048);
  });
});

describe("aideEffort", () => {
  test("Fable asks for medium (5.1's frontier shift, not the API default)", () => {
    expect(aideEffort(MODELS.FABLE)).toBe("medium");
  });

  test("Opus 5.5 asks for high (its API default is medium)", () => {
    expect(aideEffort(MODELS.OPUS_5_5)).toBe("high");
  });

  test("every other model sends no output_config at all", () => {
    expect(aideEffort(MODELS.OPUS)).toBeUndefined();
    expect(aideEffort(MODELS.SONNET)).toBeUndefined();
    expect(aideEffort(MODELS.HAIKU)).toBeUndefined();
    // Including a retired Fable id — the dial follows the CURRENT model
    // constant, never a stale slug that could still be in flight.
    expect(aideEffort("claude-fable-5")).toBeUndefined();
  });
});

describe("aideThinking", () => {
  test("staff surface on Fable or Opus 5.5 asks for summarized adaptive thinking", () => {
    for (const model of [MODELS.FABLE, MODELS.OPUS_5_5]) {
      expect(aideThinking(model, true)).toEqual({
        type: "adaptive",
        display: "summarized",
      });
    }
  });

  test("non-staff surfaces never send a thinking param", () => {
    expect(aideThinking(MODELS.FABLE, false)).toBeUndefined();
    expect(aideThinking(MODELS.FABLE, undefined)).toBeUndefined();
    expect(aideThinking(MODELS.OPUS_5_5, false)).toBeUndefined();
  });

  test("other models stay at the API default (Opus 4.8 would switch thinking ON)", () => {
    expect(aideThinking(MODELS.OPUS, true)).toBeUndefined();
    expect(aideThinking(MODELS.SONNET, true)).toBeUndefined();
    expect(aideThinking("claude-fable-5", true)).toBeUndefined();
  });
});

// ── Mutation gates ───────────────────────────────────────────────────────

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role: role as never,
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Awaited<ReturnType<typeof seedUser>>,
) {
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

describe("users.setAideModel", () => {
  test("a teacher can pin any model, and clear back to the fleet default", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.users.setAideModel, { model: "fable" });
    expect(
      (await t.run(async (ctx) => ctx.db.get(teacherId)))?.aideModel,
    ).toBe("fable");

    // Sonnet is now an explicit pin (not a "clear"), since absent = the
    // Opus 5.5 fleet default.
    await asTeacher.mutation(api.users.setAideModel, { model: "sonnet" });
    expect(
      (await t.run(async (ctx) => ctx.db.get(teacherId)))?.aideModel,
    ).toBe("sonnet");

    await asTeacher.mutation(api.users.setAideModel, {});
    expect(
      (await t.run(async (ctx) => ctx.db.get(teacherId)))?.aideModel,
    ).toBeUndefined();
  });

  test("a scholar is forbidden", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.users.setAideModel, { model: "fable" }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a parent is forbidden", async () => {
    const t = convexTest(schema, modules);
    const parentId = await seedUser(t, "parent");
    const asParent = await withUser(t, parentId);

    await expect(
      asParent.mutation(api.users.setAideModel, { model: "opus" }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("users.setAideModelInternal (the aide's set_aide_model tool path)", () => {
  test("sets and clears for a staff principal", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.users.setAideModelInternal, {
        callerUserId: teacherId,
        model: "opus",
      }),
    );
    expect(
      (await t.run(async (ctx) => ctx.db.get(teacherId)))?.aideModel,
    ).toBe("opus");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.users.setAideModelInternal, {
        callerUserId: teacherId,
        model: undefined,
      }),
    );
    expect(
      (await t.run(async (ctx) => ctx.db.get(teacherId)))?.aideModel,
    ).toBeUndefined();
  });

  test("re-checks the principal's role server-side", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.users.setAideModelInternal, {
          callerUserId: scholarId,
          model: "fable",
        }),
      ),
    ).rejects.toThrow(/Forbidden/);
  });
});
