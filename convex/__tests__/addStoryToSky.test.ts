import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HOUR_MS = 60 * 60 * 1000;

async function seedUser(
  t: ReturnType<typeof convexTest>,
  username = "sky-scholar",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Sky Scholar",
      username,
      role: "scholar",
    }),
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

/** Seeds the SAME fraction→music story-edge scenario as practiceMoments.test.ts
 *  (kept as its own small copy here so this file stands alone). */
async function seedStoryEdge(
  t: ReturnType<typeof convexTest>,
  options: { fromKey?: string; toKey?: string } = {},
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
        probe: "How many quarter notes fit in one whole measure?",
        provenance: "registry",
      },
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
    outcome: "offered" | "opened" | "probed" | "saved" | "dismissed";
    clientEventId: string;
    offeredAt?: number;
  },
) {
  const offeredAt = options.offeredAt ?? Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("momentEvents", {
      scholarId,
      kind: "story",
      fromKey: options.fromKey,
      toKey: options.toKey,
      trigger: "fluency_transition",
      offeredAt,
      outcome: options.outcome,
      outcomeAt: options.outcome === "offered" ? undefined : offeredAt + 1,
      clientEventId: options.clientEventId,
    }),
  );
}

async function getSeed(t: ReturnType<typeof convexTest>, seedId: Id<"seeds">) {
  return await t.run(async (ctx) => ctx.db.get(seedId));
}

describe("practiceMoments.addStoryToSky", () => {
  test("mints a story-star souvenir with the edge's own server-derived content", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryEdge(t);
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.mutation(api.practiceMoments.addStoryToSky, {
      scholarId,
      fromKey,
      toKey,
    });

    expect(result.existed).toBe(false);
    const seed = await getSeed(t, result.seedId);
    expect(seed).toMatchObject({
      scholarId,
      origin: "story",
      status: "active",
      suggestionType: "leap",
      topic: "Musical rhythm",
      scholarInvitation: "Fractions keep the beat",
      connectionTo: "Fractions as equal parts",
      domain: "music",
      storyFromKey: fromKey,
      storyToKey: toKey,
    });
    // rationale is required and teacher-facing — never empty, never the raw
    // client args standing in for real content.
    expect(seed?.rationale).toContain("Fractions keep the beat");
  });

  test("dedupes: a second call for the same (scholar, fromKey, toKey) returns the same seed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryEdge(t);
    const asScholar = await withUser(t, scholarId);

    const first = await asScholar.mutation(api.practiceMoments.addStoryToSky, {
      scholarId,
      fromKey,
      toKey,
    });
    const second = await asScholar.mutation(api.practiceMoments.addStoryToSky, {
      scholarId,
      fromKey,
      toKey,
    });

    expect(second.seedId).toBe(first.seedId);
    expect(second.existed).toBe(true);
    const allSeeds = await t.run(async (ctx) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(allSeeds).toHaveLength(1);
  });

  test("advances an opened moment event to saved", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryEdge(t);
    const eventId = await seedMomentEvent(t, scholarId, {
      fromKey,
      toKey,
      outcome: "opened",
      clientEventId: "sky-event",
    });
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.practiceMoments.addStoryToSky, {
      scholarId,
      fromKey,
      toKey,
    });

    const event = await t.run(async (ctx) => ctx.db.get("momentEvents", eventId));
    expect(event).toMatchObject({ outcome: "saved" });
    expect(event?.outcomeAt).toBeTypeOf("number");
  });

  test("never reverts an already-terminal (dismissed) moment event, but still mints the star", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const { fromKey, toKey } = await seedStoryEdge(t);
    const eventId = await seedMomentEvent(t, scholarId, {
      fromKey,
      toKey,
      outcome: "dismissed",
      clientEventId: "dismissed-event",
    });
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.mutation(api.practiceMoments.addStoryToSky, {
      scholarId,
      fromKey,
      toKey,
    });

    expect(result.existed).toBe(false);
    const event = await t.run(async (ctx) => ctx.db.get("momentEvents", eventId));
    expect(event).toMatchObject({ outcome: "dismissed" });
  });

  test("throws when the (fromKey, toKey) pair carries no story edge", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.practiceMoments.addStoryToSky, {
        scholarId,
        fromKey: "no_such_skill",
        toKey: "no_such_world",
      }),
    ).rejects.toThrow(/Story edge not found/);
  });

  test("another scholar cannot mint a story-star onto someone else's sky", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const otherId = await seedUser(t, "other-scholar");
    const { fromKey, toKey } = await seedStoryEdge(t);
    const asOther = await withUser(t, otherId);

    await expect(
      asOther.mutation(api.practiceMoments.addStoryToSky, {
        scholarId,
        fromKey,
        toKey,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});
