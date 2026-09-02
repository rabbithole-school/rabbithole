import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  username = `choice_${role}`,
) {
  return await t.run(async (ctx) => {
    const institution =
      role === "scholar"
        ? ((await ctx.db
            .query("institutions")
            .filter((q) =>
              q.eq(q.field("slug"), "practice-choices"),
            )
            .unique()) ??
          {
            _id: await ctx.db.insert("institutions", {
              name: "Practice Choices",
              slug: "practice-choices",
              kind: "school",
              isPrimary: true,
            }),
          })
        : null;
    const userId = await ctx.db.insert("users", {
      name: `Choice ${role}`,
      username,
      role,
      ...(institution ? { institutionId: institution._id } : {}),
    });
    if (institution) {
      await ctx.db.insert("memberships", {
        userId,
        role: "scholar",
        institutionId: institution._id,
      });
    }
    return userId;
  });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

async function insertChoiceItem(
  t: ReturnType<typeof convexTest>,
  skillKey: string,
  domain: string,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey,
      domain,
      stem: `Practice ${skillKey}`,
      answerType: "integer",
      answerCanonical: "1",
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
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

describe("practiceSkills — scholar practice choices", () => {
  test("a mixed-domain choiceHint affects only the matching domain's strand queue", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "choice_hint_mixed");
    const asScholar = await withUser(t, scholar);

    await seedFluent(t, scholar, "count_to_10", "whole-number-arithmetic", "counting");
    await seedFluent(t, scholar, "likelihood_scale", "probability", "chance");
    await seedFluent(t, scholar, "sample_space", "probability", "theoretical");
    await seedFluent(
      t,
      scholar,
      "theoretical_probability_simple",
      "probability",
      "theoretical",
    );

    // Give one whole-number frontier node the same strand name as the probability
    // choice, while a second synthetic strand and the ordinary counting strand
    // occupy its two active slots. If the hint leaked across domains, the
    // theoretical node would be force-activated despite being least recent.
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
        domain: "whole-number-arithmetic",
        strand: "theoretical",
        repetition: 0,
        halfLifeDays: 100,
        frontier: true,
        source: "practice",
        updatedAt: Date.now() + 1_000,
      });
    });

    for (const key of [
      "complement_probability",
      "experimental_probability",
      "compound_two_dice",
    ]) {
      await insertChoiceItem(t, key, "probability");
    }

    const baseArgs = {
      scholarId: scholar,
      size: 12,
      seed: 91,
      domains: ["whole-number-arithmetic", "probability"],
    };
    const baseline = await asScholar.query(api.practiceSkills.practiceSession, baseArgs);
    const chosen = await asScholar.query(api.practiceSkills.practiceSession, {
      ...baseArgs,
      choiceHint: { domain: "probability", strand: "theoretical" },
    });

    const keysFor = (
      session: typeof baseline,
      domain: string,
    ) => session.items.filter((item) => item.domain === domain).map((item) => item.skillKey);

    expect(keysFor(baseline, "whole-number-arithmetic")).not.toContain("count_to_100_tens");
    expect(keysFor(chosen, "whole-number-arithmetic")).not.toContain("count_to_100_tens");
    expect(keysFor(baseline, "probability")[0]).toBe("experimental_probability");
    expect(keysFor(baseline, "probability")).not.toContain("complement_probability");
    expect(keysFor(chosen, "probability")).toContain("complement_probability");
  });

  test("choiceSetForSelf returns at most three balanced frontier-strand cards", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "choice_set_scholar");
    const asScholar = await withUser(t, scholar);
    const domains = ["whole-number-arithmetic", "probability"];

    await insertChoiceItem(t, "likelihood_scale", "probability");

    const cards = await asScholar.query(api.practiceSkills.choiceSetForSelf, { domains });
    expect(cards.length).toBeLessThanOrEqual(3);
    expect(new Set(cards.map((card) => card.domain))).toEqual(new Set(domains));

    for (const domain of domains) {
      const frontier = await asScholar.query(api.practiceSkills.nextForScholar, {
        scholarId: scholar,
        domain,
        limit: 12,
      });
      const frontierPairs = new Set(
        frontier
          .filter((entry) => entry.reason === "new")
          .map((entry) => `${entry.strand}\u0000${entry.key}`),
      );
      for (const card of cards.filter((candidate) => candidate.domain === domain)) {
        expect(frontierPairs.has(`${card.strand}\u0000${card.sampleSkillKey}`)).toBe(true);
      }
    }
  });

  test("choiceCardsForSelf matches the standalone choice set and derives its new-territory exclusions", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "combined_choice_cards");
    const asScholar = await withUser(t, scholar);
    const domains = ["whole-number-arithmetic", "probability"];

    await insertChoiceItem(t, "likelihood_scale", "probability");

    const choiceSet = await asScholar.query(
      api.practiceSkills.choiceSetForSelf,
      { domains },
    );
    const expectedNewTerritory = await asScholar.query(
      api.practiceSkills.newTerritoryCards,
      { excludeDomains: choiceSet.map((card) => card.domain) },
    );
    const combined = await asScholar.query(
      api.practiceSkills.choiceCardsForSelf,
      { domains },
    );

    expect(combined.choiceSet).toEqual(choiceSet);
    expect(combined.newTerritory).toEqual(expectedNewTerritory);
    expect(combined.newTerritory.length).toBeGreaterThan(0);
    const choiceDomains = new Set(choiceSet.map((card) => card.domain));
    expect(
      combined.newTerritory.every((card) => !choiceDomains.has(card.domain)),
    ).toBe(true);
  });

  test("logPracticeChoice is idempotent per scholar and clientPickId", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "choice_log_scholar");
    const asScholar = await withUser(t, scholar);
    const args = {
      domain: "probability",
      strand: "theoretical",
      source: "home_choice" as const,
      candidateSkillKeys: ["complement_probability", "experimental_probability"],
      playlistDomains: ["whole-number-arithmetic", "probability"],
      clientPickId: "pick-123",
    };

    const first = await asScholar.mutation(api.practiceSkills.logPracticeChoice, args);
    const retry = await asScholar.mutation(api.practiceSkills.logPracticeChoice, args);
    const rows = await t.run(async (ctx) => ctx.db.query("practiceChoiceEvents").collect());

    expect(first.created).toBe(true);
    expect(retry).toEqual({ eventId: first.eventId, created: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scholarId: scholar,
      domain: args.domain,
      strand: args.strand,
      source: args.source,
      candidateSkillKeys: args.candidateSkillKeys,
      playlistDomains: args.playlistDomains,
      clientPickId: args.clientPickId,
    });
  });

  test("practice choice endpoints reject a non-scholar identity", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);

    await expect(
      asTeacher.query(api.practiceSkills.choiceSetForSelf, {}),
    ).rejects.toThrow("A learner membership is required");
    await expect(
      asTeacher.mutation(api.practiceSkills.logPracticeChoice, {
        domain: "probability",
        strand: "theoretical",
        source: "home_choice",
        clientPickId: "teacher-pick",
      }),
    ).rejects.toThrow("A learner membership is required");
    await expect(
      asTeacher.query(api.practiceSkills.bonusSkillsForChoice, {
        domain: "probability",
        strand: "theoretical",
      }),
    ).rejects.toThrow("A learner membership is required");
  });
});

// ── bonusSkillsForChoice — the "More of your pick" done-screen bonus set ────
describe("practiceSkills — bonusSkillsForChoice", () => {
  async function insertBonusNode(
    t: ReturnType<typeof convexTest>,
    node: { nodeKey: string; domain: string; strand: string },
  ) {
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: node.nodeKey,
        label: node.nodeKey,
        domain: node.domain,
        strand: node.strand,
        source: "practice",
      }),
    );
  }

  async function insertBonusEdge(
    t: ReturnType<typeof convexTest>,
    fromKey: string,
    toKey: string,
    domain: string,
  ) {
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodeEdges", { fromKey, toKey, domain, kind: "buildsOn" }),
    );
  }

  test("returns only same-strand candidates, capped at count", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "bonus_strand_scholar");
    const asScholar = await withUser(t, scholar);

    const result = await asScholar.query(api.practiceSkills.bonusSkillsForChoice, {
      domain: "probability",
      strand: "theoretical",
      count: 2,
    });
    expect(result.skillKeys.length).toBeLessThanOrEqual(2);
    expect(result.labels).toHaveLength(result.skillKeys.length);

    // Every returned key really belongs to the requested strand — cross-check
    // against the ordinary whole-graph queue (nextForScholar), which stamps
    // each entry with its real `strand`.
    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: "probability",
      limit: 20,
    });
    const strandOf = new Map(queue.map((entry) => [entry.key, entry.strand]));
    for (const key of result.skillKeys) expect(strandOf.get(key)).toBe("theoretical");
  });

  test("excludes a same-strand skill still locked behind an unmet prerequisite", async () => {
    const t = convexTest(schema, modules);
    const domain = "bonus-strand-test";
    // s1: a root (nodeA) and a child (nodeB) gated on nodeA — nodeB is NOT yet
    // frontier for a fresh scholar. s2 is a different strand entirely, used to
    // confirm cross-strand isolation.
    await insertBonusNode(t, { nodeKey: "nodeA", domain, strand: "s1" });
    await insertBonusNode(t, { nodeKey: "nodeB", domain, strand: "s1" });
    await insertBonusNode(t, { nodeKey: "nodeC", domain, strand: "s2" });
    await insertBonusEdge(t, "nodeA", "nodeB", domain);
    // Stored items make both s1 nodes servable (`runnableSkillKeySet`) — the
    // exclusion under test is the scheduler's OWN prereq/frontier gate, not a
    // missing-content gate.
    await insertChoiceItem(t, "nodeA", domain);
    await insertChoiceItem(t, "nodeB", domain);
    await insertChoiceItem(t, "nodeC", domain);

    const scholar = await seedUser(t, "scholar", "bonus_locked_scholar");
    const asScholar = await withUser(t, scholar);

    const result = await asScholar.query(api.practiceSkills.bonusSkillsForChoice, {
      domain,
      strand: "s1",
      count: 5,
    });
    expect(result.skillKeys).toContain("nodeA");
    expect(result.skillKeys).not.toContain("nodeB"); // still locked
    expect(result.skillKeys).not.toContain("nodeC"); // wrong strand
  });
});
