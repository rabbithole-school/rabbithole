import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const SUB_SKILL = "subtract_2digit_regroup";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Doc<"users">["role"] = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  if (role === "teacher") {
    return seedStaffWithMembership(t, {
      institutionId,
      name: overrides.name ?? "Ms. Fixture",
      username: overrides.username ?? "testteacher",
    });
  }
  return seedScholarInInstitution(t, {
    institutionId,
    name: overrides.name ?? "Priya Fixture",
    username: overrides.username ?? "testscholar",
  });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

async function insertBorrowItem(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: SUB_SKILL,
      domain: "whole-number-arithmetic",
      stem: "52 - 38 = ?",
      answerType: "integer",
      answerCanonical: "14",
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
}

/** A second borrow item on the SAME node, so the "stuck" don't-know and the
 *  wrong-answer miss land on distinct items. */
async function insertOtherBorrowItem(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: SUB_SKILL,
      domain: "whole-number-arithmetic",
      stem: "81 - 47 = ?",
      answerType: "integer",
      answerCanonical: "34",
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
}

describe("dontKnowsForNode", () => {
  test("counts don't-know taps and reads the teachOutcome rung breakdown", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t, "scholar", { username: "dkpriya" });
    const asScholar = await withUser(t, scholarId);
    const teacherId = await seedUser(t, "teacher", { username: "dkteacher" });
    const asTeacher = await withUser(t, teacherId);

    // Two honest "I haven't learned this yet" taps on two distinct items.
    const firstItemId = `gen#${await insertBorrowItem(t)}`;
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: firstItemId,
      answer: "",
      dontKnow: true,
    });
    const secondItemId = `gen#${await insertOtherBorrowItem(t)}`;
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: secondItemId,
      answer: "",
      dontKnow: true,
    });

    // The teaching moment on the first item bottomed out at "stuck"; the second
    // is left with no recorded rung (window still open, scholar moved on).
    await asScholar.mutation(api.practiceSkills.recordTeachingOutcome, {
      scholarId,
      itemId: firstItemId,
      outcome: "stuck",
    });

    const data = await asTeacher.query(api.practiceSkills.dontKnowsForNode, {
      scholarId,
      nodeKey: SUB_SKILL,
    });
    expect(data.count).toBe(2);
    expect(data.teachOutcomes).toEqual({ solved: 0, hint: 0, stuck: 1 });
    // A rung is recorded for only one of the two, so the buckets sum to < count.
    const bucketSum =
      data.teachOutcomes.solved + data.teachOutcomes.hint + data.teachOutcomes.stuck;
    expect(bucketSum).toBeLessThan(data.count);
    expect(data.items.length).toBeGreaterThan(0);
  });

  test("a plain miss is NOT a don't-know, and a don't-know is NOT a miss", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t, "scholar", { username: "splitpriya" });
    const asScholar = await withUser(t, scholarId);
    const teacherId = await seedUser(t, "teacher", { username: "splitteacher" });
    const asTeacher = await withUser(t, teacherId);

    // One don't-know tap and one genuinely wrong answer, on distinct items,
    // same node.
    const dontKnowItemId = `gen#${await insertBorrowItem(t)}`;
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: dontKnowItemId,
      answer: "",
      dontKnow: true,
    });
    const missItemId = `gen#${await insertOtherBorrowItem(t)}`;
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: missItemId,
      answer: "40", // wrong — a real misconception, not a don't-know
    });

    // Sanity: the don't-know row DOES carry a renderable stem, so absent the
    // exclusion it would leak into the miss list — the double-count this guards.
    const dontKnowRow = await t.run(async (ctx) => {
      const rows = await ctx.db.query("practiceAttempts").collect();
      return rows.find(
        (r) => r.scholarId === scholarId && r.explanationReason === "dont_know",
      );
    });
    expect(dontKnowRow?.stemSnapshot).toBe("52 - 38 = ?");

    const dontKnows = await asTeacher.query(api.practiceSkills.dontKnowsForNode, {
      scholarId,
      nodeKey: SUB_SKILL,
    });
    // Exactly the don't-know is counted — the wrong answer is not.
    expect(dontKnows.count).toBe(1);

    const misses = await asTeacher.query(api.practiceSkills.recentMissesForNode, {
      scholarId,
      nodeKey: SUB_SKILL,
    });
    // Exactly the wrong answer renders as a miss — the don't-know is excluded.
    expect(misses.misses).toHaveLength(1);
    expect(misses.misses[0].stemSnapshot).toBe("81 - 47 = ?");

  });

  test("teacher-only: the scholar's own read is empty; an unrelated caller is forbidden", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t, "scholar", { username: "gatepriya" });
    const asScholar = await withUser(t, scholarId);
    const otherScholarId = await seedUser(t, "scholar", { username: "gatenosy" });
    const asOtherScholar = await withUser(t, otherScholarId);

    const itemId = `gen#${await insertBorrowItem(t)}`;
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });

    // Self-read is redacted to the empty shape, never a throw.
    const mine = await asScholar.query(api.practiceSkills.dontKnowsForNode, {
      scholarId,
      nodeKey: SUB_SKILL,
    });
    expect(mine).toEqual({
      count: 0,
      teachOutcomes: { solved: 0, hint: 0, stuck: 0 },
      items: [],
    });

    // A non-teacher, non-self caller is rejected outright (requireTeacherOrSelf).
    await expect(
      asOtherScholar.query(api.practiceSkills.dontKnowsForNode, {
        scholarId,
        nodeKey: SUB_SKILL,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});
