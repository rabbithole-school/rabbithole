import { convexTest } from "convex-test";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { MATH_CROSS_DOMAIN_SEEDS } from "../lib/practice/crossDomainSeeds";

// The question lookups are content (owned by the content lanes). Every story
// edge / seed topic gets this fixture question unless a test lists its key in
// `noQuestion`, so the ledger/policy tests below stay independent of coverage.
const questionFixture = vi.hoisted(() => ({
  noQuestion: new Set<string>(),
  question: {
    prompt: "Which one wins?",
    choices: ["The first", "The second", "Neither"],
    answerIndex: 1,
    reveal: "The second one wins.",
  },
}));
vi.mock("../lib/practice/storyCardQuestions", () => ({
  storyCardQuestion: (fromKey: string, toKey: string) =>
    questionFixture.noQuestion.has(`${fromKey}→${toKey}`)
      ? undefined
      : questionFixture.question,
}));
vi.mock("../lib/practice/seedCardQuestions", () => ({
  seedCardQuestion: (topic: string) =>
    questionFixture.noQuestion.has(topic) ? undefined : questionFixture.question,
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 6, 12, 12);

beforeEach(() => {
  questionFixture.noQuestion.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedUser(
  t: ReturnType<typeof convexTest>,
  username = "moment-scholar",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Moment Scholar",
      username,
      role: "scholar",
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

async function seedStoryScenario(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  options: {
    fromKey?: string;
    toKey?: string;
    becameFluentAt?: number;
  } = {},
) {
  const fromKey = options.fromKey ?? "fraction_as_parts";
  const toKey = options.toKey ?? "music_rhythm";
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: fromKey,
      label: "Fractions as equal parts",
      domain: "fraction-arithmetic",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: toKey,
      label: "Musical rhythm",
      domain: "music",
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey,
      toKey,
      domain: "music",
      kind: "bridge",
      method: "curated",
      story: {
        kind: "applies",
        hook: "Fractions keep the beat",
        narrative:
          "Half notes and quarter notes divide a measure into equal parts.",
        visualEmoji: "🥁",
        probe: "How many quarter notes fit in one whole measure?",
        provenance: "registry",
      },
    });
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: fromKey,
      domain: "fraction-arithmetic",
      repetition: 3,
      halfLifeDays: 4,
      lastPracticedAt: NOW,
      frontier: false,
      source: "practice",
      updatedAt: NOW,
      becameFluentAt: options.becameFluentAt ?? NOW - HOUR_MS,
    });
  });
  return { kind: "story" as const, fromKey, toKey };
}

async function seedCrossDomainSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  options: { topic?: string; scholarInvitation?: string } = {},
) {
  return await t.run(async (ctx) => {
    const seedId = await ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "active",
      suggestionType: "cross_domain",
      topic: options.topic ?? "How rhythm carries fractions",
      rationale: "A nearby idea unlocked by recent fluency.",
      scholarInvitation:
        options.scholarInvitation ??
        "What changes when a fraction becomes a beat?",
      connectionTo: "Fractions as equal parts",
      domain: "music",
    });
    const seed = await ctx.db.get(seedId);
    if (!seed) throw new Error("cross-domain seed was not inserted");
    return { seedId, createdAt: seed._creationTime };
  });
}

async function removeStoryEdges(
  t: ReturnType<typeof convexTest>,
  fromKey: string,
) {
  await t.run(async (ctx) => {
    const edges = await ctx.db
      .query("knowledgeNodeEdges")
      .collect();
    await Promise.all(
      edges
        .filter((edge) => edge.fromKey === fromKey)
        .map((edge) => ctx.db.delete(edge._id)),
    );
  });
}

async function seedMomentEvent(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  options: {
    fromKey: string;
    toKey: string;
    offeredAt: number;
    outcome:
      | "offered"
      | "opened"
      | "probed"
      | "tried"
      | "saved"
      | "dismissed";
    clientEventId: string;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("momentEvents", {
      scholarId,
      kind: "story",
      fromKey: options.fromKey,
      toKey: options.toKey,
      trigger: "fluency_transition",
      offeredAt: options.offeredAt,
      outcome: options.outcome,
      outcomeAt:
        options.outcome === "offered" ? undefined : options.offeredAt + 1,
      clientEventId: options.clientEventId,
    }),
  );
}

async function seedLinkedApplication(
  t: ReturnType<typeof convexTest>,
  fromKey: string,
  toKey: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: fromKey,
      domain: "fraction-arithmetic",
      stem: "How many quarter notes fill the measure?",
      answerType: "integer",
      answerCanonical: "4",
      verifierKind: "arithmetic",
      tier: "stretch",
      storyToKey: toKey,
      technique: "application_interpret",
      bloomLevel: 3,
      source: "SECRET_APPLICATION_SOURCE",
      verifiedAt: NOW,
    }),
  );
}

describe("practiceMoments.storyMomentForScholar", () => {
  test("returns a story edge for a skill that became fluent today", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const moment = await asScholar.query(
      api.practiceMoments.storyMomentForScholar,
      { scholarId },
    );

    expect(moment).toEqual({
      kind: "story",
      fromKey,
      toKey,
      skillLabel: "Fractions as equal parts",
      hook: "Fractions keep the beat",
      narrative:
        "Half notes and quarter notes divide a measure into equal parts.",
      visualEmoji: "🥁",
      probe: "How many quarter notes fit in one whole measure?",
      kindLabel: "applies to",
      hasApplication: false,
      question: questionFixture.question,
    });
  });

  test("exposes only an eligibility boolean when the story has a linked application", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryScenario(t, scholarId);
    await seedLinkedApplication(t, fromKey, toKey);
    const asScholar = await withUser(t, scholarId);

    const moment = await asScholar.query(
      api.practiceMoments.storyMomentForScholar,
      { scholarId },
    );

    expect(moment?.hasApplication).toBe(true);
    expect(Object.keys(moment ?? {}).sort()).toEqual(
      [
        "fromKey",
        "hasApplication",
        "hook",
        "kind",
        "kindLabel",
        "narrative",
        "probe",
        "question",
        "skillLabel",
        "toKey",
        "visualEmoji",
      ].sort(),
    );
    expect(JSON.stringify(moment)).not.toContain("answerCanonical");
    expect(JSON.stringify(moment)).not.toContain("SECRET_APPLICATION_SOURCE");
    // The stored answer's VALUE, not just its field name, stays server-side.
    expect(JSON.stringify(moment)).not.toContain("\"4\"");
  });

  test("application evidence suppresses the story card's Try it door", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryScenario(t, scholarId);
    await seedLinkedApplication(t, fromKey, toKey);
    await t.run(async (ctx) => {
      await ctx.db.insert("masteryObservations", {
        scholarId,
        conceptLabel: "Fractions as equal parts",
        domain: "fraction-arithmetic",
        nodeKey: fromKey,
        observedAt: NOW,
        transcriptExcerpt: "prior application solve",
        masteryLevel: 3,
        confidenceScore: 0.85,
        evidenceSummary: "prior",
        evidenceType: "application_success",
        attemptContext: "practice",
        studentInitiated: true,
        isSuperseded: false,
      });
    });
    const asScholar = await withUser(t, scholarId);

    const moment = await asScholar.query(
      api.practiceMoments.storyMomentForScholar,
      { scholarId },
    );

    expect(moment?.hasApplication).toBe(false);
  });

  test("the 20-hour global cooldown suppresses every story", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    await seedStoryScenario(t, scholarId);
    await seedMomentEvent(t, scholarId, {
      fromKey: "another_skill",
      toKey: "another_world",
      offeredAt: NOW - 19 * HOUR_MS,
      outcome: "opened",
      clientEventId: "cooldown-event",
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toBeNull();
  });

  test("an edge offered within 45 days is not re-offered", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const edge = await seedStoryScenario(t, scholarId);
    await seedMomentEvent(t, scholarId, {
      ...edge,
      offeredAt: NOW - 44 * DAY_MS,
      outcome: "probed",
      clientEventId: "recent-edge-event",
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toBeNull();
  });

  test.each(["tried", "saved", "dismissed"] as const)(
    "%s permanently suppresses an edge",
    async (outcome) => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const edge = await seedStoryScenario(t, scholarId);
      await seedMomentEvent(t, scholarId, {
        ...edge,
        offeredAt: NOW - 200 * DAY_MS,
        outcome,
        clientEventId: `terminal-${outcome}`,
      });
      const asScholar = await withUser(t, scholarId);

      await expect(
        asScholar.query(api.practiceMoments.storyMomentForScholar, {
          scholarId,
        }),
      ).resolves.toBeNull();
    },
  );

  test("surfaces the card teaser when the story has one", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryScenario(t, scholarId);
    // Attach a teaser to the seeded story (Finding 2: the card renders this).
    await t.run(async (ctx) => {
      const edge = await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", fromKey))
        .collect()
        .then((rows) => rows.find((e) => e.toKey === toKey));
      if (!edge?.story) throw new Error("story scenario was not seeded");
      await ctx.db.patch(edge._id, {
        story: { ...edge.story, teaser: "Two quarter notes take the same time." },
      });

    });
    const asScholar = await withUser(t, scholarId);

    const moment = await asScholar.query(
      api.practiceMoments.storyMomentForScholar,
      { scholarId },
    );
    expect(moment?.teaser).toBe("Two quarter notes take the same time.");
    expect(moment?.kind).toBe("story");
    if (moment?.kind !== "story") throw new Error("Expected a story moment");
    // The full narrative still rides along for the "Find out more" thread.
    expect(moment?.narrative).toBe(
      "Half notes and quarter notes divide a measure into equal parts.",
    );
  });

  test("surfaces an authored visual emoji", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, { scholarId }),
    ).resolves.toMatchObject({ fromKey, toKey, visualEmoji: "🥁" });
  });

  test("resolves ready far-end art to a URL without leaking attachment fields", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { toKey } = await seedStoryScenario(t, scholarId);
    const { artStorageId, artUrl } = await t.run(async (ctx) => {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", toKey))
        .unique();
      if (!node) throw new Error("far-end story node missing");
      const artStorageId = await ctx.storage.store(
        new Blob(["story-art"], { type: "image/png" }),
      );
      await ctx.db.patch(node._id, {
        artStorageId,
        artContentHash: "story-art-hash",
        artStatus: "ready",
      });
      const artUrl = await ctx.storage.getUrl(artStorageId);
      if (!artUrl) throw new Error("story art URL missing");
      return { artStorageId, artUrl };
    });
    const asScholar = await withUser(t, scholarId);

    const moment = await asScholar.query(
      api.practiceMoments.storyMomentForScholar,
      { scholarId },
    );

    expect(moment?.kind).toBe("story");
    if (moment?.kind !== "story") throw new Error("Expected a story moment");
    expect(moment?.artUrl).toBe(artUrl);
    expect(moment).not.toHaveProperty("artStorageId");
    expect(moment).not.toHaveProperty("artContentHash");
    expect(moment).not.toHaveProperty("artStatus");
    const { artUrl: _servedUrl, ...redacted } = moment!;
    expect(JSON.stringify(redacted)).not.toContain(String(artStorageId));
  });

  test("returns a cross-domain seed when no story edge is eligible", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey } = await seedStoryScenario(t, scholarId);
    await removeStoryEdges(t, fromKey);
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
    // Deliberately beyond the former 24-hour story-transition window.
    vi.setSystemTime(createdAt + 3 * DAY_MS);
    const asScholar = await withUser(t, scholarId);

    // A topic the registry doesn't carry falls back to the row's own copy.
    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toEqual({
      kind: "seed",
      seedId,
      hook: "How rhythm carries fractions",
      teaser: "What changes when a fraction becomes a beat?",
      hasApplication: false,
      question: questionFixture.question,
    });
  });

  test("a seed minted with old copy shows the registry's current card", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey } = await seedStoryScenario(t, scholarId);
    await removeStoryEdges(t, fromKey);
    const def = MATH_CROSS_DOMAIN_SEEDS.find(
      (s) => s.gateSkillKey === "exponents_repeated_mult",
    )!;
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId, {
      topic: def.topic,
      scholarInvitation: "OLD_WORKSHEET_INVITATION",
    });
    vi.setSystemTime(createdAt + HOUR_MS);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toEqual({
      kind: "seed",
      seedId,
      hook: def.cardTitle,
      teaser: def.scholarInvitation,
      visualEmoji: def.visualEmoji,
      hasApplication: false,
      question: questionFixture.question,
    });
  });

  // Seed cards have no age window: a topic mints once per scholar ever, so a
  // window would strand every seed that ages out before a slot comes round.
  test("returns a never-carded cross-domain seed at thirty days old", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey } = await seedStoryScenario(t, scholarId);
    await removeStoryEdges(t, fromKey);
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
    vi.setSystemTime(createdAt + 30 * DAY_MS);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toMatchObject({ kind: "seed", seedId });
  });

  test("a seed dismissed beyond the 45-day reserve read is never re-carded", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey } = await seedStoryScenario(t, scholarId);
    await removeStoryEdges(t, fromKey);
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.insert("momentEvents", {
        scholarId,
        kind: "seed",
        seedId,
        trigger: "fluency_transition",
        offeredAt: createdAt,
        outcome: "dismissed",
        outcomeAt: createdAt + 1,
        clientEventId: "dismissed-long-ago",
      });
    });
    vi.setSystemTime(createdAt + 60 * DAY_MS);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toBeNull();
    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        kind: "seed",
        seedId,
        clientEventId: "re-offer-dismissed",
      }),
    ).rejects.toThrow(/not eligible/);
  });

  test("an old seed offered but unsettled within 45 days is not re-carded", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey } = await seedStoryScenario(t, scholarId);
    await removeStoryEdges(t, fromKey);
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.insert("momentEvents", {
        scholarId,
        kind: "seed",
        seedId,
        trigger: "fluency_transition",
        offeredAt: createdAt + 25 * DAY_MS,
        outcome: "offered",
        clientEventId: "offered-unsettled",
      });
    });
    vi.setSystemTime(createdAt + 30 * DAY_MS);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toBeNull();
  });

  test("a story edge wins over an eligible cross-domain seed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { createdAt } = await seedCrossDomainSeed(t, scholarId);
    // An aged seed is still eligible, and a fresh story still takes the slot.
    vi.setSystemTime(createdAt + 30 * DAY_MS);
    const { fromKey, toKey } = await seedStoryScenario(t, scholarId, {
      becameFluentAt: createdAt + 30 * DAY_MS - HOUR_MS,
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toMatchObject({
      kind: "story",
      fromKey,
      toKey,
    });
  });

  test("the 20-hour cooldown blocks a story after a seed moment", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
    vi.setSystemTime(createdAt + HOUR_MS);
    await seedStoryScenario(t, scholarId, {
      becameFluentAt: createdAt,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("momentEvents", {
        scholarId,
        kind: "seed",
        seedId,
        trigger: "fluency_transition",
        offeredAt: createdAt,
        outcome: "offered",
        clientEventId: "seed-before-story",
      });
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toBeNull();
  });

  test("the 20-hour cooldown blocks a seed after a story moment", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey } = await seedStoryScenario(t, scholarId);
    await removeStoryEdges(t, fromKey);
    const { createdAt } = await seedCrossDomainSeed(t, scholarId);
    vi.setSystemTime(createdAt + HOUR_MS);
    await seedMomentEvent(t, scholarId, {
      fromKey: "another_skill",
      toKey: "another_world",
      offeredAt: createdAt - 18 * HOUR_MS,
      outcome: "opened",
      clientEventId: "story-before-seed",
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toBeNull();
  });

  test("the 45-day per-item reserve blocks a seed after global cooldown", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey } = await seedStoryScenario(t, scholarId);
    await removeStoryEdges(t, fromKey);
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
    vi.setSystemTime(createdAt + 21 * HOUR_MS);
    await t.run(async (ctx) => {
      await ctx.db.insert("momentEvents", {
        scholarId,
        kind: "seed",
        seedId,
        trigger: "fluency_transition",
        offeredAt: createdAt,
        outcome: "opened",
        outcomeAt: createdAt + 1,
        clientEventId: "reserved-preview-seed",
      });
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).resolves.toBeNull();
  });
});

describe("practiceMoments event lifecycle", () => {
  test("recordMomentOffered returns a stable momentId on retry", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const edge = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const args = {
      scholarId,
      ...edge,
      clientEventId: "render-123",
    };

    const first = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      args,
    );
    const second = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      args,
    );

    expect(second.eventId).toBe(first.eventId);
    // Both offers hand back the SAME minted seed — the star is minted on the
    // first offer, and the idempotent retry re-reads it (the "Start quest" CTA
    // needs a seedId on either path).
    expect(first.seedId).not.toBeNull();
    expect(second.seedId).toBe(first.seedId);
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("momentEvents")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "story",
      trigger: "fluency_transition",
      outcome: "offered",
      clientEventId: "render-123",
    });
  });

  test("recordMomentOffered KEEPS the story: it mints the star itself, once, without touching the outcome", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const edge = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const args = { scholarId, ...edge, clientEventId: "render-mint" };

    await asScholar.mutation(api.practiceMoments.recordMomentOffered, args);
    // A StrictMode/reconnect retry must not mint a second star.
    await asScholar.mutation(api.practiceMoments.recordMomentOffered, args);

    const seeds = await t.run(async (ctx) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      origin: "story",
      status: "active",
      topic: "Musical rhythm",
      scholarInvitation: "Fractions keep the beat",
      // The unlocking skill — what the scholar-home card cites.
      connectionTo: "Fractions as equal parts",
      storyFromKey: edge.fromKey,
      storyToKey: edge.toKey,
    });

    // Minting is NOT engagement: the funnel must still read "offered".
    const events = await t.run(async (ctx) =>
      ctx.db
        .query("momentEvents")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("offered");
  });

  test("new offers never evict earlier open moments (the Quests list has no cap)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const edges = [
      await seedStoryScenario(t, scholarId, {
        fromKey: "skill_oldest",
        toKey: "story_oldest",
      }),
      await seedStoryScenario(t, scholarId, {
        fromKey: "skill_middle",
        toKey: "story_middle",
      }),
    ];
    const { seedId } = await seedCrossDomainSeed(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const offered: Array<{ eventId: Id<"momentEvents"> }> = [];
    for (const [index, edge] of edges.entries()) {
      vi.setSystemTime(NOW + index * 21 * HOUR_MS);
      offered.push(
        await asScholar.mutation(api.practiceMoments.recordMomentOffered, {
          scholarId,
          ...edge,
          clientEventId: `governed-offer-${index}`,
        }),
      );
    }
    vi.setSystemTime(NOW + 42 * HOUR_MS);
    offered.push(
      await asScholar.mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        kind: "seed",
        seedId,
        clientEventId: "governed-offer-seed",
      }),
    );

    const events = await t.run(async (ctx) =>
      ctx.db
        .query("momentEvents")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(events.map((event) => event.outcome)).toEqual([
      "offered",
      "offered",
      "offered",
    ]);
    const queue = await asScholar.query(api.questionQueue.forSelf, {});
    expect(queue.map((row) => row.eventId)).toEqual([
      offered[2].eventId,
      offered[1].eventId,
      offered[0].eventId,
    ]);
  });

  test("recordMomentOffered returns the minted seedId, and the idempotent retry re-reads it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const edge = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const args = { scholarId, ...edge, clientEventId: "render-seed" };

    // The "Start quest" CTA launches THIS seed, so the offer must return it.
    const first = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      args,
    );
    expect(first.seedId).not.toBeNull();
    const seed = await t.run(async (ctx) => ctx.db.get("seeds", first.seedId!));
    expect(seed).toMatchObject({
      origin: "story",
      storyFromKey: edge.fromKey,
      storyToKey: edge.toKey,
    });

    // A reconnect / StrictMode retry (same clientEventId) takes the idempotent
    // early-exit but STILL hands back the seedId (re-read from the already-
    // planted star), so the CTA is never dead on a retry.
    const retry = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      args,
    );
    expect(retry.eventId).toBe(first.eventId);
    expect(retry.seedId).toBe(first.seedId);
  });

  test("a dismissed moment no longer loses the story — the star outlives the card", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const edge = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const { eventId } = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      { scholarId, ...edge, clientEventId: "render-dismiss" },
    );
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "dismissed",
    });

    const seeds = await t.run(async (ctx) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.status).toBe("active");
  });

  test("recordMomentOffered mints nothing when the pair carries no story", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        kind: "story",
        fromKey: "not_a_node",
        toKey: "also_not_a_node",
        clientEventId: "render-nostory",
      }),
    ).rejects.toThrow(/Story edge not found/);

    const seeds = await t.run(async (ctx) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(seeds).toHaveLength(0);
  });

  test("recordMomentOffered for a seed mints no souvenir seed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
    // The mutation shares the card's eligibility rule (no age window).
    vi.setSystemTime(createdAt + 3 * DAY_MS);
    const asScholar = await withUser(t, scholarId);

    const offer = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      {
        scholarId,
        kind: "seed",
        seedId,
        clientEventId: "render-preview-seed",
      },
    );

    expect(offer.seedId).toBe(seedId);
    const seeds = await t.run(async (ctx) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(seeds).toHaveLength(1);
    await expect(
      t.run(async (ctx) => ctx.db.get("momentEvents", offer.eventId)),
    ).resolves.toMatchObject({
      kind: "seed",
      seedId,
      outcome: "offered",
    });

    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId: offer.eventId,
      outcome: "opened",
    });
    await expect(
      t.run(async (ctx) => ctx.db.get("momentEvents", offer.eventId)),
    ).resolves.toMatchObject({
      kind: "seed",
      seedId,
      outcome: "opened",
    });
  });

  test("recordMomentOffered rejects a second offer for a reserved seed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
    vi.setSystemTime(createdAt + HOUR_MS);
    const asScholar = await withUser(t, scholarId);

    const offer = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      {
        scholarId,
        kind: "seed",
        seedId,
        clientEventId: "first-preview-seed",
      },
    );
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId: offer.eventId,
      outcome: "dismissed",
    });

    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        kind: "seed",
        seedId,
        clientEventId: "second-preview-seed",
      }),
    ).rejects.toThrow(/not eligible/);
  });

  test("recordMomentOffered enforces cooldown and terminal suppression", async () => {
    const cooldownTest = convexTest(schema, modules);
    const cooldownScholar = await seedUser(cooldownTest, "cooldown-scholar");
    const cooldownEdge = await seedStoryScenario(
      cooldownTest,
      cooldownScholar,
    );
    await seedMomentEvent(cooldownTest, cooldownScholar, {
      fromKey: "another_skill",
      toKey: "another_world",
      offeredAt: NOW - HOUR_MS,
      outcome: "opened",
      clientEventId: "recent-other-story",
    });
    const asCooldownScholar = await withUser(
      cooldownTest,
      cooldownScholar,
    );

    await expect(
      asCooldownScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        {
          scholarId: cooldownScholar,
          ...cooldownEdge,
          clientEventId: "cooldown-bypass",
        },
      ),
    ).rejects.toThrow(/already offered recently/);

    const terminalTest = convexTest(schema, modules);
    const terminalScholar = await seedUser(terminalTest, "terminal-scholar");
    const terminalEdge = await seedStoryScenario(
      terminalTest,
      terminalScholar,
    );
    await seedMomentEvent(terminalTest, terminalScholar, {
      ...terminalEdge,
      offeredAt: NOW - 200 * DAY_MS,
      outcome: "dismissed",
      clientEventId: "old-dismissal",
    });
    const asTerminalScholar = await withUser(
      terminalTest,
      terminalScholar,
    );

    await expect(
      asTerminalScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        {
          scholarId: terminalScholar,
          ...terminalEdge,
          clientEventId: "terminal-bypass",
        },
      ),
    ).rejects.toThrow(/not eligible/);
  });

  test("outcomes advance by precedence and terminal choices never change", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const edge = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const { eventId } = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      { scholarId, ...edge, clientEventId: "outcome-event" },
    );

    vi.setSystemTime(NOW + HOUR_MS);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "opened",
    });

    vi.setSystemTime(NOW + 2 * HOUR_MS);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "probed",
    });
    const probedAt = NOW + 2 * HOUR_MS;

    vi.setSystemTime(NOW + 3 * HOUR_MS);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "opened",
    });
    let event = await t.run(async (ctx) =>
      ctx.db.get("momentEvents", eventId),
    );
    expect(event).toMatchObject({
      outcome: "probed",
      outcomeAt: probedAt,
    });

    vi.setSystemTime(NOW + 4 * HOUR_MS);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "saved",
    });
    const savedAt = NOW + 4 * HOUR_MS;
    vi.setSystemTime(NOW + 5 * HOUR_MS);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "dismissed",
    });

    event = await t.run(async (ctx) =>
      ctx.db.get("momentEvents", eventId),
    );
    expect(event).toMatchObject({
      outcome: "saved",
      outcomeAt: savedAt,
    });
  });

  describe("sessions.createFromSeed", () => {
    test("a cross-domain seed opens directly without a quest bake", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const { seedId } = await seedCrossDomainSeed(t, scholarId);
      const asScholar = await withUser(t, scholarId);

      const { id } = await asScholar.mutation(api.sessions.createFromSeed, {
        seedId,
      });

      const session = await t.run(async (ctx) => ctx.db.get("sessions", id));
      expect(session?.seedId).toBe(seedId);
      expect(session?.questBakeStatus).toBeUndefined();
    });

    // The card is gift-only and the standing-invitation surface is
    // story-only, so this launch is the ONLY place a seed moment can learn
    // that the scholar followed the preview. Without it every seed row reads
    // "offered" forever (prod, 2026-09-18) and the funnel is unmeasurable.
    test("following a carded seed advances its moment to opened", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const { fromKey } = await seedStoryScenario(t, scholarId);
      await removeStoryEdges(t, fromKey);
      const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
      vi.setSystemTime(createdAt + HOUR_MS);
      const asScholar = await withUser(t, scholarId);
      const { eventId } = await asScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        { scholarId, kind: "seed", seedId, clientEventId: "seed-card" },
      );

      const openedAt = createdAt + 2 * HOUR_MS;
      vi.setSystemTime(openedAt);
      await asScholar.mutation(api.sessions.createFromSeed, { seedId });

      const event = await t.run(async (ctx) =>
        ctx.db.get("momentEvents", eventId),
      );
      expect(event?.outcome).toBe("opened");
      // convex-test nudges the fake clock a fraction of a ms per operation.
      expect(event?.outcomeAt).toBeCloseTo(openedAt, 0);
    });

    test("following a seed invitation retires it while both writers leave it opened", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
      vi.setSystemTime(createdAt + HOUR_MS);
      const asScholar = await withUser(t, scholarId);
      const { eventId } = await asScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        { scholarId, kind: "seed", seedId, clientEventId: "seed-follow-card" },
      );

      // It stands in the "New quests" section until the scholar acts on it.
      await expect(
        asScholar.query(api.seeds.standingStoryInvitationsForSelf, {}),
      ).resolves.toMatchObject([{ kind: "seed", seedId, eventId }]);

      vi.setSystemTime(createdAt + 2 * HOUR_MS);
      // Follow: createFromSeed's server-side `opened` write and the client's
      // own `opened` write both land — the shared precedence rule makes the
      // pair idempotent, never an error or a downgrade.
      await asScholar.mutation(api.sessions.createFromSeed, { seedId });
      await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
        eventId,
        outcome: "opened",
      });

      const event = await t.run(async (ctx) =>
        ctx.db.get("momentEvents", eventId),
      );
      expect(event?.outcome).toBe("opened");
      // A started session (session.seedId) retires the standing invitation.
      await expect(
        asScholar.query(api.seeds.standingStoryInvitationsForSelf, {}),
      ).resolves.toEqual([]);
    });

    test("a seed launched with no card of its own leaves the ledger alone", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const edge = await seedStoryScenario(t, scholarId);
      const asScholar = await withUser(t, scholarId);
      // A story moment is live; the scholar opens an unrelated Sky star.
      const { eventId } = await asScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        { scholarId, ...edge, clientEventId: "story-card" },
      );
      const { seedId } = await seedCrossDomainSeed(t, scholarId);

      await asScholar.mutation(api.sessions.createFromSeed, { seedId });

      const event = await t.run(async (ctx) =>
        ctx.db.get("momentEvents", eventId),
      );
      expect(event?.outcome).toBe("offered");
      expect(event?.outcomeAt).toBeUndefined();
    });

    test("a card followed months later is still followed", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const { fromKey } = await seedStoryScenario(t, scholarId);
      await removeStoryEdges(t, fromKey);
      const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
      vi.setSystemTime(createdAt + HOUR_MS);
      const asScholar = await withUser(t, scholarId);
      const { eventId } = await asScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        { scholarId, kind: "seed", seedId, clientEventId: "seed-card" },
      );

      // Past the offer side's 45-day reserve window; the seed itself is still
      // an active star in the Sky.
      vi.setSystemTime(createdAt + 60 * DAY_MS);
      await asScholar.mutation(api.sessions.createFromSeed, { seedId });

      const event = await t.run(async (ctx) =>
        ctx.db.get("momentEvents", eventId),
      );
      expect(event?.outcome).toBe("opened");
    });

    // The question card writes `probed` on answer, which outranks `opened`, so
    // the follow needs its own stamp or the funnel's last step is invisible.
    test("an answered story card followed into a session is stamped followed", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const { fromKey, toKey } = await seedStoryScenario(t, scholarId);
      const asScholar = await withUser(t, scholarId);
      const { eventId, seedId } = await asScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        { scholarId, kind: "story", fromKey, toKey, clientEventId: "story-q" },
      );
      await asScholar.mutation(api.practiceMoments.recordMomentAnswer, {
        eventId,
        choiceIndex: 0,
      });
      expect(seedId).not.toBeNull();

      await asScholar.mutation(api.sessions.createFromSeed, { seedId: seedId! });

      const event = await t.run(async (ctx) => ctx.db.get("momentEvents", eventId));
      expect(event?.outcome).toBe("probed");
      expect(event?.followedAt).toBeDefined();
    });

    test("following a carded seed stamps followed once", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const { fromKey } = await seedStoryScenario(t, scholarId);
      await removeStoryEdges(t, fromKey);
      const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
      vi.setSystemTime(createdAt + HOUR_MS);
      const asScholar = await withUser(t, scholarId);
      const { eventId } = await asScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        { scholarId, kind: "seed", seedId, clientEventId: "seed-q" },
      );
      vi.setSystemTime(createdAt + 2 * HOUR_MS);
      await asScholar.mutation(api.sessions.createFromSeed, { seedId });
      const first = await t.run(async (ctx) => ctx.db.get("momentEvents", eventId));
      vi.setSystemTime(createdAt + 3 * HOUR_MS);
      await asScholar.mutation(api.sessions.createFromSeed, { seedId });
      const second = await t.run(async (ctx) => ctx.db.get("momentEvents", eventId));

      expect(first?.followedAt).toBeDefined();
      expect(second?.followedAt).toBe(first?.followedAt);
    });

    test("a re-open never walks a settled seed moment backwards", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedUser(t);
      const { fromKey } = await seedStoryScenario(t, scholarId);
      await removeStoryEdges(t, fromKey);
      const { seedId, createdAt } = await seedCrossDomainSeed(t, scholarId);
      vi.setSystemTime(createdAt + HOUR_MS);
      const asScholar = await withUser(t, scholarId);
      const { eventId } = await asScholar.mutation(
        api.practiceMoments.recordMomentOffered,
        { scholarId, kind: "seed", seedId, clientEventId: "seed-card" },
      );
      const dismissedAt = createdAt + 2 * HOUR_MS;
      vi.setSystemTime(dismissedAt);
      await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
        eventId,
        outcome: "dismissed",
      });

      vi.setSystemTime(createdAt + 3 * HOUR_MS);
      await asScholar.mutation(api.sessions.createFromSeed, { seedId });

      const event = await t.run(async (ctx) =>
        ctx.db.get("momentEvents", eventId),
      );
      expect(event?.outcome).toBe("dismissed");
      expect(event?.outcomeAt).toBeCloseTo(dismissedAt, 0);
    });
  });

  test("tried records the started Go-deeper round and remains terminal", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const edge = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const { eventId } = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      { scholarId, ...edge, clientEventId: "try-event" },
    );

    vi.setSystemTime(NOW + HOUR_MS);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "tried",
    });
    const triedAt = NOW + HOUR_MS;

    vi.setSystemTime(NOW + 2 * HOUR_MS);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "dismissed",
    });

    await expect(
      t.run(async (ctx) => ctx.db.get("momentEvents", eventId)),
    ).resolves.toMatchObject({
      outcome: "tried",
      outcomeAt: triedAt,
    });
  });

  test("another scholar cannot read or mutate a scholar's moments", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const otherId = await seedUser(t, "other-scholar");
    const edge = await seedStoryScenario(t, scholarId);
    const eventId = await seedMomentEvent(t, scholarId, {
      ...edge,
      offeredAt: NOW,
      outcome: "offered",
      clientEventId: "owned-event",
    });
    const asOther = await withUser(t, otherId);

    await expect(
      asOther.query(api.practiceMoments.storyMomentForScholar, {
        scholarId,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asOther.mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        ...edge,
        clientEventId: "foreign-render",
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asOther.mutation(api.practiceMoments.recordMomentOutcome, {
        eventId,
        outcome: "opened",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});


describe("question cards", () => {
  test("the selector skips a story edge with no question and keeps looking", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryScenario(t, scholarId);
    questionFixture.noQuestion.add(`${fromKey}→${toKey}`);
    const asScholar = await withUser(t, scholarId);

    // No other eligible moment: nothing is offered rather than a questionless card.
    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, { scholarId }),
    ).resolves.toBeNull();

    // A seed with a question is then found past the questionless story.
    const { seedId } = await seedCrossDomainSeed(t, scholarId);
    const moment = await asScholar.query(
      api.practiceMoments.storyMomentForScholar,
      { scholarId },
    );
    expect(moment).toMatchObject({ kind: "seed", seedId });
  });

  test("the selector skips a seed with no question; recordMomentOffered agrees", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { seedId } = await seedCrossDomainSeed(t, scholarId, {
      topic: "No question topic",
    });
    questionFixture.noQuestion.add("No question topic");
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.practiceMoments.storyMomentForScholar, { scholarId }),
    ).resolves.toBeNull();
    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        kind: "seed",
        seedId,
        clientEventId: "q-seed-1",
      }),
    ).rejects.toThrow(/not eligible/);
  });

  async function offeredStory(t: ReturnType<typeof convexTest>) {
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryScenario(t, scholarId);
    const asScholar = await withUser(t, scholarId);
    const { eventId } = await asScholar.mutation(
      api.practiceMoments.recordMomentOffered,
      { scholarId, kind: "story", fromKey, toKey, clientEventId: "q-1" },
    );
    return { scholarId, asScholar, eventId };
  }

  test("recordMomentAnswer computes correctness server-side, stamps the row, advances to probed", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, eventId } = await offeredStory(t);

    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentAnswer, {
        eventId,
        choiceIndex: 0,
      }),
    ).resolves.toEqual({ correct: false, answerIndex: 0 });

    const row = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(row).toMatchObject({
      answerIndex: 0,
      answerCorrect: false,
      outcome: "probed",
    });
    expect(row?.answeredAt).toBe(NOW);
  });

  test("first answer wins: a second call returns the stored result unchanged", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, eventId } = await offeredStory(t);
    await asScholar.mutation(api.practiceMoments.recordMomentAnswer, {
      eventId,
      choiceIndex: 0,
    });
    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentAnswer, {
        eventId,
        choiceIndex: 1,
      }),
    ).resolves.toEqual({ correct: false, answerIndex: 0 });
    const row = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(row?.answerIndex).toBe(0);
  });

  test("an answer never regresses a later outcome", async () => {
    const t = convexTest(schema, modules);
    const { asScholar, eventId } = await offeredStory(t);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId,
      outcome: "dismissed",
    });
    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentAnswer, {
        eventId,
        choiceIndex: 1,
      }),
    ).resolves.toEqual({ correct: true, answerIndex: 1 });
    const row = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(row?.outcome).toBe("dismissed");
  });

  test("recordMomentAnswer refuses another user's row and out-of-range choices", async () => {
    const t = convexTest(schema, modules);
    const { eventId, asScholar } = await offeredStory(t);
    const otherId = await seedUser(t, "someone-else");
    const asOther = await withUser(t, otherId);
    await expect(
      asOther.mutation(api.practiceMoments.recordMomentAnswer, {
        eventId,
        choiceIndex: 1,
      }),
    ).rejects.toThrow(/Not your moment/);
    for (const choiceIndex of [-1, 3, 1.5]) {
      await expect(
        asScholar.mutation(api.practiceMoments.recordMomentAnswer, {
          eventId,
          choiceIndex,
        }),
      ).rejects.toThrow(/out of range/);
    }
    const row = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(row?.answerIndex).toBeUndefined();
  });
});
