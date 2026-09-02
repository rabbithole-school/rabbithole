import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { MODELS } from "../lib/models";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("usage.byInstitution", () => {
  test("rolls up two institutions and unattributed events in the indexed window", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const { adminId, moliId, guestId } = await t.run(async (ctx) => {
      const adminId = await ctx.db.insert("users", {
        name: "Avery Stone",
        username: "avery",
        role: "platform_admin",
      });
      const moliId = await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
      });
      const guestId = await ctx.db.insert("institutions", {
        name: "Guests",
        slug: "guests",
        kind: "guest",
      });

      await ctx.db.insert("usageEvents", {
        source: "tutor",
        role: "scholar",
        institutionId: moliId,
        model: MODELS.SONNET,
        inputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
        createdAt: now - 1_000,
      });
      await ctx.db.insert("usageEvents", {
        source: "observer",
        role: "scholar",
        institutionId: moliId,
        model: MODELS.SONNET,
        inputTokens: 200,
        cacheWriteTokens: 300,
        cacheReadTokens: 400,
        outputTokens: 500,
        createdAt: now - 2_000,
      });
      await ctx.db.insert("usageEvents", {
        source: "curriculum-sim",
        role: "teacher",
        institutionId: guestId,
        model: MODELS.HAIKU,
        inputTokens: 500_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 200_000,
        createdAt: now - 3_000,
      });
      await ctx.db.insert("usageEvents", {
        source: "quality-pulse",
        role: "platform_admin",
        model: MODELS.OPUS,
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 1_000_000,
        outputTokens: 0,
        createdAt: now - 4_000,
      });
      await ctx.db.insert("usageEvents", {
        source: "tutor",
        role: "scholar",
        institutionId: guestId,
        model: MODELS.HAIKU,
        inputTokens: 9_000_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 9_000_000,
        createdAt: now - 2 * day,
      });

      return { adminId, moliId, guestId };
    });
    const asAdmin = await withUser(t, adminId);

    const result = await asAdmin.query(api.usage.byInstitution, {
      sinceMs: now - day,
      untilMs: now,
      paginationOpts: { numItems: 100, cursor: null },
    });

    expect(result.isDone).toBe(true);
    expect(result.page).toHaveLength(3);

    const moli = result.page.find((row) => row.institutionId === moliId)!;
    expect(moli.label).toBe("Moli School");
    expect(moli.calls).toBe(2);
    expect(moli.totals).toEqual({
      inputTokens: 1_000_200,
      cacheWriteTokens: 1_000_300,
      cacheReadTokens: 1_000_400,
      outputTokens: 1_000_500,
    });
    expect(moli.estimatedCost).toBeCloseTo(14.70623, 6);

    const guests = result.page.find((row) => row.institutionId === guestId)!;
    expect(guests.totals.inputTokens).toBe(500_000);
    expect(guests.totals.outputTokens).toBe(200_000);
    expect(guests.estimatedCost).toBeCloseTo(1.5, 6);

    const unattributed = result.page.find(
      (row) => row.institutionId === null,
    )!;
    expect(unattributed.label).toBe("Unattributed");
    expect(unattributed.totals.cacheReadTokens).toBe(1_000_000);
    expect(unattributed.estimatedCost).toBeCloseTo(0.5, 6);
  });
});
