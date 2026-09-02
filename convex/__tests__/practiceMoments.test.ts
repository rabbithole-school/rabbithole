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

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 6, 12, 12);

beforeEach(() => {
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
  return { fromKey, toKey };
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
        "kindLabel",
        "narrative",
        "probe",
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

    expect(moment?.artUrl).toBe(artUrl);
    expect(moment).not.toHaveProperty("artStorageId");
    expect(moment).not.toHaveProperty("artContentHash");
    expect(moment).not.toHaveProperty("artStatus");
    const { artUrl: _servedUrl, ...redacted } = moment!;
    expect(JSON.stringify(redacted)).not.toContain(String(artStorageId));
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

  test("a third spaced offer dismisses the oldest invitation, keeps all seeds, and the dismissal stays terminal", async () => {
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
      await seedStoryScenario(t, scholarId, {
        fromKey: "skill_newest",
        toKey: "story_newest",
      }),
    ];
    const asScholar = await withUser(t, scholarId);
    const offered: Array<{
      eventId: Id<"momentEvents">;
      seedId: Id<"seeds"> | null;
    }> = [];

    for (const [index, edge] of edges.entries()) {
      vi.setSystemTime(NOW + index * 21 * HOUR_MS);
      offered.push(
        await asScholar.mutation(
          api.practiceMoments.recordMomentOffered,
          {
            scholarId,
            ...edge,
            clientEventId: `governed-offer-${index}`,
          },
        ),
      );
    }

    const events = await t.run(async (ctx) =>
      ctx.db
        .query("momentEvents")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(events.map((event) => event.outcome)).toEqual([
      "dismissed",
      "offered",
      "offered",
    ]);
    expect(events[0]).toMatchObject({
      _id: offered[0].eventId,
      outcomeAt: NOW + 42 * HOUR_MS,
    });

    const standing = await asScholar.query(
      api.seeds.standingStoryInvitationsForSelf,
      {},
    );
    expect(standing.map((invitation) => invitation.eventId)).toEqual([
      offered[2].eventId,
      offered[1].eventId,
    ]);

    const seeds = await t.run(async (ctx) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) =>
          q.eq("scholarId", scholarId).eq("status", "active"),
        )
        .collect(),
    );
    expect(seeds).toHaveLength(3);
    expect(new Set(seeds.map((seed) => seed._id))).toEqual(
      new Set(offered.map((offer) => offer.seedId)),
    );

    vi.setSystemTime(NOW + 43 * HOUR_MS);
    await asScholar.mutation(api.practiceMoments.recordMomentOutcome, {
      eventId: offered[0].eventId,
      outcome: "opened",
    });
    await expect(
      t.run(async (ctx) =>
        ctx.db.get("momentEvents", offered[0].eventId),
      ),
    ).resolves.toMatchObject({
      outcome: "dismissed",
      outcomeAt: NOW + 42 * HOUR_MS,
    });
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
