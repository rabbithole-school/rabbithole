import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { UNLOCKED_STORY_SECTION_CAP } from "../lib/scholarReads";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HOUR_MS = 60 * 60 * 1000;

/** Build the harness through a function so `Harness` carries OUR schema. A bare
 *  `ReturnType<typeof convexTest>` degrades `ctx.db` inside `t.run` to the system
 *  tables, losing every named index. */
function makeHarness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof makeHarness>;

async function seedUser(
  t: ReturnType<typeof convexTest>,
  username = "unlocked-scholar",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Unlocked Scholar", username, role: "scholar" }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + HOUR_MS,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** One story-bearing bridge edge plus both endpoint nodes. */
async function seedStoryEdge(
  t: ReturnType<typeof convexTest>,
  opts: {
    fromKey: string;
    toKey: string;
    fromLabel: string;
    toLabel: string;
    hook: string;
    teaser?: string;
    visualEmoji?: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: opts.fromKey,
      label: opts.fromLabel,
      domain: "fraction-arithmetic",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: opts.toKey,
      label: opts.toLabel,
      domain: "music",
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: opts.fromKey,
      toKey: opts.toKey,
      domain: "music",
      kind: "bridge",
      method: "curated",
      story: {
        kind: "applies",
        hook: opts.hook,
        narrative: "The full narrative, longer than the teaser.",
        ...(opts.teaser === undefined ? {} : { teaser: opts.teaser }),
        ...(opts.visualEmoji === undefined ? {} : { visualEmoji: opts.visualEmoji }),
        provenance: "registry",
      },
    });
  });
}

/**
 * Push every recorded offer for this scholar back past the 20h offer cooldown,
 * so the next `offerStory` is allowed. Real scholars hit this naturally (a
 * story is offered at most ~once a day); a test that stacks offers in the same
 * millisecond has to say so explicitly.
 */
async function advancePastOfferCooldown(t: Harness, scholarId: Id<"users">) {
  await t.run(async (ctx) => {
    const events = await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    for (const e of events) {
      await ctx.db.patch(e._id, { offeredAt: e.offeredAt - 21 * HOUR_MS });
    }
  });
}

/**
 * Mint the star exactly the way the server does — by driving the REAL offer
 * path (`practiceMoments.recordMomentOffered` → `plantStorySeed`). Hand-rolling
 * the seed insert here would re-implement plantStorySeed's field mapping in the
 * test, so a drift in the real mapping (e.g. it stops writing `connectionTo`,
 * which is the card's "Unlocked by" citation) would leave these tests green
 * while the actual section broke.
 */
async function offerStory(
  t: Harness,
  scholarId: Id<"users">,
  fromKey: string,
  toKey: string,
  clientEventId = `evt-${fromKey}-${toKey}`,
) {
  const as = await withUser(t, scholarId);
  await as.mutation(api.practiceMoments.recordMomentOffered, {
    scholarId,
    fromKey,
    toKey,
    clientEventId,
  });
  const seedId = await t.run(async (ctx) => {
    const seeds = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", scholarId).eq("status", "active"),
      )
      .collect();
    return seeds.find(
      (s) => s.origin === "story" && s.storyFromKey === fromKey && s.storyToKey === toKey,
    )?._id;
  });
  if (!seedId) throw new Error(`offer did not mint a story seed for ${fromKey}→${toKey}`);
  return seedId;
}

async function seedEligibleApplication(
  t: Harness,
  scholarId: Id<"users">,
  fromKey: string,
  toKey: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: fromKey,
      domain: "fraction-arithmetic",
      repetition: 3,
      halfLifeDays: 30,
      lastPracticedAt: Date.now(),
      frontier: false,
      source: "practice",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("practiceItems", {
      skillKey: fromKey,
      domain: "fraction-arithmetic",
      stem: "How many equal beats fill this measure?",
      answerType: "integer",
      answerCanonical: "76432",
      verifierKind: "arithmetic",
      tier: "stretch",
      storyToKey: toKey,
      technique: "application_interpret",
      source: "SECRET_ARCHIVE_ITEM_SOURCE",
      verifiedAt: Date.now(),
    });
  });
}

describe("seeds.unlockedStoriesForSelf", () => {
  test("returns the kept story, citing the skill that unlocked it", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    await seedStoryEdge(t, {
      fromKey: "fraction_as_parts",
      toKey: "music_rhythm",
      fromLabel: "Fractions as equal parts",
      toLabel: "Musical rhythm",
      hook: "Fractions keep the beat",
      teaser: "Half notes and quarter notes split a measure into equal parts.",
      visualEmoji: "🥁",
    });
    const seedId = await offerStory(t, scholarId, "fraction_as_parts", "music_rhythm");
    const asScholar = await withUser(t, scholarId);

    const stories = await asScholar.query(api.seeds.unlockedStoriesForSelf, {});

    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({
      seedId,
      hook: "Fractions keep the beat",
      teaser: "Half notes and quarter notes split a measure into equal parts.",
      visualEmoji: "🥁",
      skillLabel: "Fractions as equal parts",
      topic: "Musical rhythm",
      domain: "music",
      fromKey: "fraction_as_parts",
      toKey: "music_rhythm",
      hasApplication: false,
    });
  });

  test("exposes only whether each archived story still has an eligible application", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    await seedStoryEdge(t, {
      fromKey: "fraction_as_parts",
      toKey: "music_rhythm",
      fromLabel: "Fractions as equal parts",
      toLabel: "Musical rhythm",
      hook: "Fractions keep the beat",
    });
    await offerStory(t, scholarId, "fraction_as_parts", "music_rhythm");
    await seedEligibleApplication(
      t,
      scholarId,
      "fraction_as_parts",
      "music_rhythm",
    );
    await advancePastOfferCooldown(t, scholarId);
    await seedStoryEdge(t, {
      fromKey: "place_value",
      toKey: "scribe_inventory",
      fromLabel: "Place value",
      toLabel: "Scribe inventory",
      hook: "Clay tokens became a ledger",
    });
    await offerStory(t, scholarId, "place_value", "scribe_inventory");
    const asScholar = await withUser(t, scholarId);

    const stories = await asScholar.query(
      api.seeds.unlockedStoriesForSelf,
      {},
    );
    expect(
      Object.fromEntries(
        stories.map((story) => [story.fromKey, story.hasApplication]),
      ),
    ).toEqual({
      place_value: false,
      fraction_as_parts: true,
    });

    const serialized = JSON.stringify(stories);
    expect(serialized).not.toContain("answerCanonical");
    expect(serialized).not.toContain("\"source\"");
    expect(serialized).not.toContain("76432");
    expect(serialized).not.toContain("SECRET_ARCHIVE_ITEM_SOURCE");
    for (const story of stories) {
      expect(Object.keys(story).sort()).toEqual(
        [
          "domain",
          "fromKey",
          "hasApplication",
          "hook",
          "seedId",
          "skillLabel",
          "teaser",
          "toKey",
          "topic",
        ].sort(),
      );
    }
  });

  test("falls back to the narrative for stories seeded before teasers existed", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    await seedStoryEdge(t, {
      fromKey: "a",
      toKey: "b",
      fromLabel: "Skill A",
      toLabel: "Idea B",
      hook: "Hook",
    });
    await offerStory(t, scholarId, "a", "b");
    const asScholar = await withUser(t, scholarId);

    const stories = await asScholar.query(api.seeds.unlockedStoriesForSelf, {});
    expect(stories[0]?.teaser).toBe("The full narrative, longer than the teaser.");
  });

  test("drops a story the scholar has already flown to", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    await seedStoryEdge(t, {
      fromKey: "a",
      toKey: "b",
      fromLabel: "Skill A",
      toLabel: "Idea B",
      hook: "Hook",
    });
    const seedId = await offerStory(t, scholarId, "a", "b");
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Idea B",
        seedId,
        isArchived: false,
      });
    });
    const asScholar = await withUser(t, scholarId);

    expect(await asScholar.query(api.seeds.unlockedStoriesForSelf, {})).toEqual([]);
  });

  test("drops a story whose edge lost its story copy, and never leaks other origins", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    // Mint the star from a real story edge, then have a curator strip the story
    // copy off that edge — the souvenir seed outlives the text it was made from.
    await seedStoryEdge(t, {
      fromKey: "gone",
      toKey: "nowhere",
      fromLabel: "Skill",
      toLabel: "Idea",
      hook: "Hook",
    });
    await offerStory(t, scholarId, "gone", "nowhere");
    await t.run(async (ctx) => {
      const edge = await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", "gone"))
        .collect();
      for (const e of edge) await ctx.db.patch(e._id, { story: undefined });
    });
    // A teacher seed must never show up in this section.
    await t.run(async (ctx) => {
      await ctx.db.insert("seeds", {
        scholarId,
        origin: "teacher",
        status: "active",
        suggestionType: "teacher_suggestion",
        topic: "A teacher topic",
        rationale: "because",
      });
    });
    const asScholar = await withUser(t, scholarId);

    expect(await asScholar.query(api.seeds.unlockedStoriesForSelf, {})).toEqual([]);
  });

  test("caps the section and shows the newest stories first", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    const total = UNLOCKED_STORY_SECTION_CAP + 2;
    for (let i = 0; i < total; i++) {
      await seedStoryEdge(t, {
        fromKey: `skill_${i}`,
        toKey: `idea_${i}`,
        fromLabel: `Skill ${i}`,
        toLabel: `Idea ${i}`,
        hook: `Hook ${i}`,
      });
      await offerStory(t, scholarId, `skill_${i}`, `idea_${i}`);
      await advancePastOfferCooldown(t, scholarId);
    }
    const asScholar = await withUser(t, scholarId);

    const stories = await asScholar.query(api.seeds.unlockedStoriesForSelf, {});
    expect(stories).toHaveLength(UNLOCKED_STORY_SECTION_CAP);
    expect(stories.map((s) => s.hook)).toEqual([
      `Hook ${total - 1}`,
      `Hook ${total - 2}`,
      `Hook ${total - 3}`,
    ]);
  });

  test("one scholar never sees another scholar's unlocked stories", async () => {
    const t = makeHarness();
    const mine = await seedUser(t, "mine");
    const theirs = await seedUser(t, "theirs");
    await seedStoryEdge(t, {
      fromKey: "a",
      toKey: "b",
      fromLabel: "Skill A",
      toLabel: "Idea B",
      hook: "Hook",
    });
    await offerStory(t, theirs, "a", "b");
    const asMe = await withUser(t, mine);

    expect(await asMe.query(api.seeds.unlockedStoriesForSelf, {})).toEqual([]);
  });

  test("a governor-dismissed invitation is never re-offered, but its story is not lost", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    await seedStoryEdge(t, {
      fromKey: "place_value",
      toKey: "scribe_inventory",
      fromLabel: "Place value to 1000",
      toLabel: "How scribes counted a warehouse",
      hook: "Clay tokens became the first ledger",
      teaser: "Scribes needed a symbol for nothing before they could count big.",
    });
    await seedStoryEdge(t, {
      fromKey: "fractions",
      toKey: "music",
      fromLabel: "Fractions",
      toLabel: "Musical rhythm",
      hook: "Fractions keep the beat",
    });
    await seedStoryEdge(t, {
      fromKey: "angles",
      toKey: "navigation",
      fromLabel: "Angles",
      toLabel: "Celestial navigation",
      hook: "Angles guided sailors home",
    });
    await offerStory(t, scholarId, "place_value", "scribe_inventory");
    await advancePastOfferCooldown(t, scholarId);
    await offerStory(t, scholarId, "fractions", "music");
    await advancePastOfferCooldown(t, scholarId);
    await offerStory(t, scholarId, "angles", "navigation");

    const asScholar = await withUser(t, scholarId);
    const retiredEvent = await t.run(async (ctx) => {
      const events = await ctx.db
        .query("momentEvents")
        .withIndex("by_scholar_edge", (q) =>
          q
            .eq("scholarId", scholarId)
            .eq("fromKey", "place_value")
            .eq("toKey", "scribe_inventory"),
        )
        .first();
      if (!events) throw new Error("oldest story event missing");
      return events;
    });
    expect(retiredEvent.outcome).toBe("dismissed");

    await advancePastOfferCooldown(t, scholarId);

    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        fromKey: "place_value",
        toKey: "scribe_inventory",
        clientEventId: "a-brand-new-event",
      }),
    ).rejects.toThrow(/not eligible/);

    const stories = await asScholar.query(api.seeds.unlockedStoriesForSelf, {});
    expect(stories).toHaveLength(3);
    expect(stories).toContainEqual(
      expect.objectContaining({
        hook: "Clay tokens became the first ledger",
        skillLabel: "Place value to 1000",
      }),
    );
  });
});
