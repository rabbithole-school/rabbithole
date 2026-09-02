/**
 * "Confirm before you cap" — end-to-end coverage of the check-in's post-miss
 * slip/concede flow through `submitPlacementAnswer` (the single-domain check-in),
 * driven over the REAL seeded practice graph.
 *
 * The prod bug: a single careless slip during a check-in permanently lowered the
 * ceiling and finalized the scholar AT the slipped skill, locking away everything
 * above it. The fix: a FIRST typed miss does not cap — the server re-serves a
 * fresh item on the SAME skill (the confirm) and flags `graded.retry`. A correct
 * confirm supersedes the slip; a second miss confirms a real ceiling; an honest
 * "don't know" caps immediately (the fast path, no retry).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

const _makeTester = () => convexTest(schema, modules);
type Tester = ReturnType<typeof _makeTester>;

const WHOLE = "whole-number-arithmetic";
const SEED = 7;

async function seedScholar(t: Tester, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar" }),
  );
}

async function asUser(t: Tester, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

type Probe = { itemId: string; skillKey: string; strand: string; answerType: string } | null;
type StepResult = {
  done: boolean;
  probe: Probe;
  graded: { outcome: string; retry?: boolean } | null;
};

async function prime(asScholar: Awaited<ReturnType<typeof asUser>>, scholarId: Id<"users">): Promise<Probe> {
  const res = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
    scholarId,
    seed: SEED,
    domain: WHOLE,
  });
  return (res.probe ?? null) as Probe;
}

async function step(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  itemId: string,
  answer: "correct" | "wrong" | "dontKnow",
): Promise<StepResult> {
  const base = { scholarId, seed: SEED, domain: WHOLE };
  const extra =
    answer === "dontKnow"
      ? { itemId, answer: "", dontKnow: true }
      : {
          itemId,
          answer:
            answer === "correct"
              ? gradeTemplateItem(itemId, "0")?.correctAnswer ?? "0"
              : "-999999",
        };
  const res = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, { ...base, ...extra });
  return {
    done: res.done,
    probe: (res.probe ?? null) as Probe,
    graded: (res.graded ?? null) as StepResult["graded"],
  };
}

describe("check-in — confirm before you cap (submitPlacementAnswer)", () => {
  test("a first typed miss offers the retry and re-serves the SAME skill (does not cap)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "confirm_retry");
    const asScholar = await asUser(t, scholar);

    const first = await prime(asScholar, scholar);
    expect(first).not.toBeNull();
    const firstSkill = first!.skillKey;
    // The affect-safe first probe is always a TEMPLATE — a plain typed miss.
    expect(first!.answerType).not.toBe("manipulative");

    const missed = await step(asScholar, scholar, first!.itemId, "wrong");
    expect(missed.graded?.outcome).toBe("incorrect");
    // The miss is a possible slip: NOT capped, the retry is offered, and the next
    // probe is a FRESH item on the SAME skill.
    expect(missed.graded?.retry).toBe(true);
    expect(missed.done).toBe(false);
    expect(missed.probe?.skillKey).toBe(firstSkill);
    expect(missed.probe?.itemId).not.toBe(first!.itemId); // a fresh item, not the same one
  });

  test("a correct confirm supersedes the slip — the search climbs on (no retry)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "confirm_correct");
    const asScholar = await asUser(t, scholar);

    const first = await prime(asScholar, scholar);
    const firstSkill = first!.skillKey;
    const missed = await step(asScholar, scholar, first!.itemId, "wrong");
    expect(missed.graded?.retry).toBe(true);
    // Answer the fresh confirm CORRECTLY.
    const confirmed = await step(asScholar, scholar, missed.probe!.itemId, "correct");
    expect(confirmed.graded?.outcome).toBe("correct");
    expect(confirmed.graded?.retry ?? false).toBe(false);
    // The search moved ON past the (now superseded) slip — it does not re-serve
    // the same skill a third time.
    if (confirmed.probe) expect(confirmed.probe.skillKey).not.toBe(firstSkill);
  });

  test("a second miss confirms a real ceiling — no third try is offered", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "confirm_two_miss");
    const asScholar = await asUser(t, scholar);

    const first = await prime(asScholar, scholar);
    const m1 = await step(asScholar, scholar, first!.itemId, "wrong");
    expect(m1.graded?.retry).toBe(true);
    const m2 = await step(asScholar, scholar, m1.probe!.itemId, "wrong");
    // Two misses on the same node cap the ceiling — the retry is NOT offered again.
    expect(m2.graded?.outcome).toBe("incorrect");
    expect(m2.graded?.retry ?? false).toBe(false);
  });

  test("an honest don't-know is the fast path — caps immediately, no retry", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "confirm_idk");
    const asScholar = await asUser(t, scholar);

    const first = await prime(asScholar, scholar);
    const firstSkill = first!.skillKey;
    const conceded = await step(asScholar, scholar, first!.itemId, "dontKnow");
    expect(conceded.graded?.outcome).toBe("unknown");
    // No retry offered, and the next probe is NEVER a re-serve of the conceded skill.
    expect(conceded.graded?.retry ?? false).toBe(false);
    if (conceded.probe) expect(conceded.probe.skillKey).not.toBe(firstSkill);
  });
});
