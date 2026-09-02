import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asScholar(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

test("an all-not-yet first block cannot mix count-to-20 with long division", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.practiceSkills.seedGraph, {});

  const now = Date.now();
  const scholarId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "First Block Scholar",
      username: "ftue_first_block",
      role: "scholar",
      gradeLevel: "3",
    }),
  );
  const spread = [
    { key: "count_objects_within_20", strand: "counting" },
    { key: "compare_within_10", strand: "counting" },
    { key: "long_division_2digit_divisor", strand: "mult-divide" },
    { key: "mult_2digit_by_2digit", strand: "mult-divide" },
    { key: "area_model_multiplication", strand: "mult-divide" },
  ] as const;

  await t.run(async (ctx) => {
    await ctx.db.insert("practicePlacements", {
      scholarId,
      domain: "whole-number-arithmetic",
      status: "complete",
      probesAnswered: spread.length,
      probeLog: spread.map(({ key, strand }) => ({
        nodeKey: key,
        strand,
        outcome: "unknown" as const,
        at: now,
      })),
      updatedAt: now,
    });
    for (const { key, strand } of spread) {
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: key,
        domain: "whole-number-arithmetic",
        strand,
        repetition: 0,
        halfLifeDays: 0,
        frontier: true,
        source: "placement",
        updatedAt: now,
      });
    }
  });

  const authed = await asScholar(t, scholarId);
  const playlist = await authed.query(api.practiceSkills.playlistForScholar, {
    scholarId,
    domain: "whole-number-arithmetic",
  });
  const keys = new Set(playlist.set.map((row) => row.key));
  const domain = await authed.query(api.practiceSkills.getDomain, {
    domain: "whole-number-arithmetic",
  });
  const gradeByKey = new Map(
    domain.skills.map((skill) => [skill.skillKey, skill.grade]),
  );

  expect(playlist.firstPostPlacementBlock).toBe(true);
  expect(playlist.set).toHaveLength(1);
  expect([...keys].every((key) => gradeByKey.get(key) === "K")).toBe(true);
  expect(keys.has("count_to_10")).toBe(true);
  expect(keys.has("compare_within_10")).toBe(false);
  expect(keys.has("count_objects_within_20")).toBe(false);
  expect(keys.has("long_division_2digit_divisor")).toBe(false);
  expect(keys.has("mult_2digit_by_2digit")).toBe(false);
  expect(keys.has("area_model_multiplication")).toBe(false);

  const session = await authed.query(api.practiceSkills.practiceSession, {
    scholarId,
    domain: "whole-number-arithmetic",
    size: 5,
    seed: 25,
  });
  expect(session.firstPostPlacementBlock).toBe(true);
  expect(session.items).toHaveLength(5);
  expect(new Set(session.items.map((item) => item.skillKey))).toEqual(
    new Set(["count_to_10"]),
  );
  expect(
    session.items.some((item) => item.skillKey === "compare_within_10"),
  ).toBe(false);
  expect(
    session.items.some((item) => item.skillKey === "count_objects_within_20"),
  ).toBe(false);
  expect(
    session.items.some((item) => item.skillKey === "long_division_2digit_divisor"),
  ).toBe(false);
});
