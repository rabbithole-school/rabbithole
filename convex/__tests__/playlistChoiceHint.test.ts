import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";

// The "You Pick" select-and-recompose fix (raise-the-ceiling §C-2 follow-up):
// tiles used to LAUNCH practice immediately with a strand bias the scholar-home
// preview never showed ("what you see isn't what you'll start"). The fix
// threads the SAME `choiceHint` `practiceSession` already accepted onto
// `playlistForScholar` too, reusing the identical `buildStrandScheduling`/
// `nextPractice` call (no forked composition) so the home preview is a byte-
// faithful stand-in for what Start will actually serve. These tests lock in
// that parity, plus the "hint is silently dropped on a domain mismatch"
// safety property both functions already shared before this change.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username = "playlist_hint_scholar") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Playlist Hint Scholar", username, role: "scholar" }),
  );
}

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

async function seedFluent(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  skillKey: string,
  domain: string,
  strand: string,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain,
      strand,
      repetition: FLUENT_REPS,
      halfLifeDays: 100,
      lastPracticedAt: Date.now(),
      frontier: false,
      source: "practice",
      updatedAt: Date.now(),
    }),
  );
}

describe("practiceSkills — playlistForScholar's choiceHint (You Pick select-and-recompose)", () => {
  async function seedCompetingStrands(t: ReturnType<typeof convexTest>, scholar: Id<"users">, domain: string) {
    // count_to_10 fluent moves the frontier window past the "counting" root, so
    // a second strand can compete for the window's other active slot. Relabel
    // count_to_100_tens to a synthetic "theoretical" strand and give it a LATER
    // updatedAt than anything else — under the ordinary least-recently-served
    // round robin it loses out to "alternate" (count_to_20) and stays OFF the
    // set entirely, exactly mirroring convex/__tests__/practiceChoices.test.ts's
    // mixed-domain choiceHint test, but single-domain.
    await seedFluent(t, scholar, "count_to_10", domain, "counting");
    await t.run(async (ctx) => {
      const theoreticalNode = await ctx.db
        .query("knowledgeNodes")
        .filter((q) => q.eq(q.field("nodeKey"), "count_to_100_tens"))
        .unique();
      const alternateNode = await ctx.db
        .query("knowledgeNodes")
        .filter((q) => q.eq(q.field("nodeKey"), "count_to_20"))
        .unique();
      await ctx.db.patch(theoreticalNode!._id, { strand: "theoretical" });
      await ctx.db.patch(alternateNode!._id, { strand: "alternate" });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_100_tens",
        domain,
        strand: "theoretical",
        repetition: 0,
        halfLifeDays: 100,
        frontier: true,
        source: "practice",
        updatedAt: Date.now() + 1_000,
      });
    });
  }

  test("a matching choiceHint force-activates the hinted strand into the preview, exactly as it would in the real session", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const domain = "whole-number-arithmetic";
    await seedCompetingStrands(t, scholar, domain);

    const baseline = await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      domain,
    });
    const hinted = await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      domain,
      choiceHint: { domain, strand: "theoretical" },
    });

    // Baseline never surfaces the least-recently-served synthetic strand.
    expect(baseline.set.map((s) => s.key)).not.toContain("count_to_100_tens");
    // The SAME hint that would bias a real practiceSession call force-
    // activates it here too — it leads both the set AND next-up.
    expect(hinted.set.map((s) => s.key)[0]).toBe("count_to_100_tens");
    expect(hinted.nextUp).toMatchObject({ key: "count_to_100_tens" });

    // No forked composition: the identical choiceHint against practiceSession
    // (the actual session Start would serve) front-loads the SAME skill —
    // playlistForScholar's preview is a byte-faithful stand-in.
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain,
      size: 8,
      seed: 7,
      choiceHint: { domain, strand: "theoretical" },
    });
    expect(session.items.map((i) => i.skillKey)).toContain("count_to_100_tens");
  });

  test("a choiceHint whose domain does NOT match the resolved domain is silently ignored (never a mismatched preview)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const domain = "whole-number-arithmetic";
    await seedCompetingStrands(t, scholar, domain);

    const baseline = await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      domain,
    });
    // A pick from a DIFFERENT domain (e.g. a "You Pick" card from another
    // registered domain) must never leak a bias into this domain's preview —
    // mirrors practiceSession's own `choiceHint.domain === domain` gate.
    const mismatched = await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      domain,
      choiceHint: { domain: "probability", strand: "theoretical" },
    });

    expect(mismatched.set).toEqual(baseline.set);
    expect(mismatched.nextUp).toEqual(baseline.nextUp);
  });
});
