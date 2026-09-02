import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";

// Regression for the week-2 pilot's inert-fractions failure: a fresh scholar who
// enters the SECOND practice domain (`fraction-arithmetic`) with no fraction
// mastery must get a REAL placement (≥1 probe) and then a REAL, non-empty queue —
// never the 0-probes / nothing-unlocked dead end. The 0-probes half was the
// expanding-ring regression: a scholar whose grade sits below the domain's floor
// (Fractions starts at grade 3) collapsed every strand's ring to hi=0.

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

const FRACTIONS = "fraction-arithmetic";

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** Drive the placement-v2 loop to completion, answering every probe "unknown"
 *  (an honest "I haven't learned this yet" — a scholar with NO fraction mastery).
 *  Returns the count of probes actually served. */
async function placeWithNoMastery(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
) {
  const base = { scholarId, seed: 11, domain: FRACTIONS };
  let cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
  let probes = 0;
  for (let i = 0; i < 60 && !cur.done && cur.probe; i++) {
    probes++;
    cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: cur.probe.itemId,
      answer: "",
      dontKnow: true,
    });
  }
  return { probes, done: cur.done };
}

describe("fractions entry — a fresh scholar's second domain is functional", () => {
  // Grade K is the sharpest case: Fractions' probeable floor is grade 3, well
  // above K+2, so the pre-fix expanding ring served ZERO probes. Also cover a
  // scholar with no grade tag at all.
  for (const grade of ["K", "1", undefined] as const) {
    test(`grade=${grade ?? "(none)"}: real placement (≥1 probe) then a non-empty queue`, async () => {
      const t = convexTest(schema, modules);
      await t.mutation(internal.practiceSkills.seedGraph, {});
      // The foundational fraction frontier node (partition_shapes) is a
      // manipulative concept node — its servable item comes from this seed.
      await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

      const scholar = await t.run(async (ctx) =>
        ctx.db.insert("users", {
          name: "Fresh",
          username: `fresh-frac-${grade ?? "none"}`,
          role: "scholar",
          ...(grade ? { gradeLevel: grade } : {}),
        }),
      );
      const asScholar = await asUser(t, scholar);

      // Before entering, the scholar has no fraction mastery → needs placement.
      expect(
        await asScholar.query(api.practiceSkills.needsPlacement, { scholarId: scholar, domain: FRACTIONS }),
      ).toBe(true);

      const { probes, done } = await placeWithNoMastery(asScholar, scholar);
      expect(done).toBe(true);
      // The regression: this used to be 0 for a grade whose floor is above the
      // ring. A real diagnostic asks at least one gentle probe.
      expect(probes).toBeGreaterThanOrEqual(1);

      // Placement finalized → mastery seeded → no longer needs placement.
      expect(
        await asScholar.query(api.practiceSkills.needsPlacement, { scholarId: scholar, domain: FRACTIONS }),
      ).toBe(false);

      // And the practice queue is not inert — at least the foundational frontier
      // node is servable.
      const session = await asScholar.query(api.practiceSkills.practiceSession, {
        scholarId: scholar,
        domain: FRACTIONS,
        seed: 5,
      });
      expect(session.items.length).toBeGreaterThanOrEqual(1);
    });
  }

  test("a scholar who KNOWS lower fractions places above the floor (trust upward still works)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});
    const scholar = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Knows", username: "knows-frac", role: "scholar", gradeLevel: "4" }),
    );
    const asScholar = await asUser(t, scholar);

    const base = { scholarId: scholar, seed: 7, domain: FRACTIONS };
    let cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    let probes = 0;
    for (let i = 0; i < 60 && !cur.done && cur.probe; i++) {
      probes++;
      // Answer every probe CORRECTLY.
      const correct = gradeTemplateItem(cur.probe.itemId, "0")?.correctAnswer ?? "0";
      cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
        ...base,
        itemId: cur.probe.itemId,
        answer: correct,
      });
    }
    expect(cur.done).toBe(true);
    expect(probes).toBeGreaterThanOrEqual(1);

    // Trust-upward credited a prefix fluent (more than just the root frontier).
    const fluent = await t.run(async (ctx) => {
      const rows = await ctx.db.query("practiceMastery").collect();
      return rows.filter((r) => r.scholarId === scholar && r.domain === FRACTIONS && r.repetition > 0);
    });
    expect(fluent.length).toBeGreaterThan(1);
  });
});
