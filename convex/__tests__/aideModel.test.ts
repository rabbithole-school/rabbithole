import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { MODELS } from "../lib/models";
import { resolveAideModel, aideMaxTokens } from "../lib/aideModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Pure resolver ────────────────────────────────────────────────────────

describe("resolveAideModel", () => {
  afterEach(() => {
    delete process.env.AIDE_MODEL;
  });

  test("no preference → Fable default (teacher reasoning gets the strongest model)", () => {
    expect(resolveAideModel(undefined)).toBe(MODELS.FABLE);
    expect(resolveAideModel(null)).toBe(MODELS.FABLE);
  });

  test("sonnet / opus / fable preferences resolve to their models", () => {
    expect(resolveAideModel("sonnet")).toBe(MODELS.SONNET);
    expect(resolveAideModel("opus")).toBe(MODELS.OPUS);
    expect(resolveAideModel("fable")).toBe(MODELS.FABLE);
  });

  test("AIDE_MODEL env override applies when no user preference (the revert lever)", () => {
    process.env.AIDE_MODEL = MODELS.SONNET;
    expect(resolveAideModel(undefined)).toBe(MODELS.SONNET);
  });

  test("user preference beats the env override", () => {
    process.env.AIDE_MODEL = MODELS.SONNET;
    expect(resolveAideModel("opus")).toBe(MODELS.OPUS);
  });

  test("an unknown AIDE_MODEL value is ignored (fail-open to the Fable default)", () => {
    process.env.AIDE_MODEL = "claude-nonsense-9";
    expect(resolveAideModel(undefined)).toBe(MODELS.FABLE);
  });
});

describe("aideMaxTokens", () => {
  test("Fable raises the cap (thinking bills as output)", () => {
    expect(aideMaxTokens(MODELS.FABLE, 4096)).toBe(16000);
    expect(aideMaxTokens(MODELS.FABLE, 20000)).toBe(20000);
  });

  test("non-Fable models keep the caller's base", () => {
    expect(aideMaxTokens(MODELS.SONNET, 4096)).toBe(4096);
    expect(aideMaxTokens(MODELS.OPUS, 2048)).toBe(2048);
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
    // Fable fleet default.
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
