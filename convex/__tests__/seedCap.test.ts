import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  OBSERVER_SEED_CAP,
  SKY_FULL_LIVE_POOL,
  buildScholarSky,
  type SeedOrigin,
  type SeedStatus,
} from "../lib/seeds";
import { SEED_CONSIDERATION_CAP } from "../../shared/skyTiers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Seed Scholar", username: "seed", role: "scholar" }),
  );
}

async function sessionFor(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  seedId?: Id<"seeds">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title: seedId ? `Visited ${seedId}` : "Observer session",
      isArchived: false,
      seedId,
    }),
  );
}

async function directSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  fields: {
    topic: string;
    domain?: string;
    origin?: SeedOrigin;
    status?: SeedStatus;
    completedAt?: number;
    teacherId?: Id<"users">;
    unitId?: Id<"units">;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: fields.origin ?? "ai",
      status: fields.status ?? "pending",
      topic: fields.topic,
      domain: fields.domain ?? "Physics",
      suggestionType: "frontier",
      rationale: `rationale: ${fields.topic}`,
      ...(fields.completedAt !== undefined
        ? { completedAt: fields.completedAt }
        : {}),
      teacherId: fields.teacherId,
      unitId: fields.unitId,
    }),
  );
}

async function seedTeacher(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Seed Teacher",
      username: "seed-teacher",
      role: "teacher",
    }),
  );
}

async function withScholar(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: scholarId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${scholarId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function unitWithActivities(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  count: number,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Seed Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Seed Lesson",
      order: 0,
    });
    const activityIds: Id<"activities">[] = [];
    for (let i = 0; i < count; i++) {
      activityIds.push(
        await ctx.db.insert("activities", {
          lessonId,
          title: `Activity ${i + 1}`,
          kind: "online",
          order: i,
          deliverable: {
            kind: "text",
            mode: "manual",
            prompt: "Show what you learned.",
            criteria: [{ id: "c1", label: "Complete" }],
          },
        }),
      );
    }
    return { unitId, lessonId, activityIds };
  });
}

async function recordObserverSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  fields: { topic: string; domain?: string; rationale?: string },
) {
  const sessionId = await sessionFor(t, scholarId);
  return await t.mutation(internal.seeds.record, {
    scholarId,
    sessionId,
    topic: fields.topic,
    domain: fields.domain,
    suggestionType: "frontier",
    rationale: fields.rationale ?? `rationale: ${fields.topic}`,
  });
}

async function seedsFor(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  const rows = await t.run(async (ctx) => ctx.db.query("seeds").collect());
  return rows.filter((seed) => seed.scholarId === scholarId);
}

describe("observer seed cap", () => {
  test("keeps newest 24 observer seeds and preserves pinned, visited, and teacher seeds", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);

    const visited = await directSeed(t, scholarId, { topic: "visited-old" });
    await sessionFor(t, scholarId, visited);
    const teacher = await directSeed(t, scholarId, {
      topic: "teacher-pending",
      origin: "teacher",
      status: "pending",
    });
    const pinned = await directSeed(t, scholarId, {
      topic: "pinned-ai",
      status: "active",
    });
    const completed = await directSeed(t, scholarId, {
      topic: "completed-old",
      status: "completed",
      completedAt: 123,
    });

    for (let i = 0; i < 30; i++) {
      await directSeed(t, scholarId, { topic: `old-${String(i).padStart(2, "0")}` });
    }

    await recordObserverSeed(t, scholarId, { topic: "fresh" });

    const rows = await seedsFor(t, scholarId);
    const byTopic = new Map(rows.map((seed) => [seed.topic, seed]));
    expect(byTopic.get("fresh")).toBeTruthy();
    expect(byTopic.get("visited-old")?._id).toBe(visited);
    expect(byTopic.get("teacher-pending")?._id).toBe(teacher);
    expect(byTopic.get("pinned-ai")?._id).toBe(pinned);
    expect(byTopic.get("completed-old")?._id).toBe(completed);
    expect(byTopic.get("completed-old")?.completedAt).toBe(123);

    for (let i = 0; i < 7; i++) {
      expect(byTopic.has(`old-${String(i).padStart(2, "0")}`)).toBe(false);
    }
    for (let i = 7; i < 30; i++) {
      expect(byTopic.has(`old-${String(i).padStart(2, "0")}`)).toBe(true);
    }

    const pendingAi = rows.filter(
      (seed) => seed.origin === "ai" && seed.status === "pending",
    );
    const unvisitedPendingAi = pendingAi.filter((seed) => seed._id !== visited);
    expect(unvisitedPendingAi).toHaveLength(OBSERVER_SEED_CAP);
    expect(pendingAi).toHaveLength(OBSERVER_SEED_CAP + 1);
  });

  test("markCompleted flips status and stamps completedAt", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const seedId = await directSeed(t, scholarId, { topic: "finished thread" });

    const result = await t.mutation(internal.seeds.markCompleted, { seedId });
    const row = await t.run(async (ctx) => ctx.db.get(seedId));

    expect(result.completed).toBe(true);
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).toBeTypeOf("number");
  });

  test("buildScholarSky caps the live consideration set, completed stars ride outside it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const completed = await directSeed(t, scholarId, {
      topic: "completed thread",
      status: "completed",
      completedAt: 456,
    });

    for (let i = 0; i < 20; i++) {
      await directSeed(t, scholarId, { topic: `live-${String(i).padStart(2, "0")}` });
    }

    const sky = await t.run(async (ctx) => buildScholarSky(ctx, scholarId));
    const doneStar = sky.find((star) => star._id === completed);

    expect(sky.filter((star) => star.status === "pending")).toHaveLength(
      SEED_CONSIDERATION_CAP,
    );
    expect(doneStar).toBeTruthy();
    expect(doneStar?.completed).toBe(true);
    expect(doneStar?.completedAt).toBe(456);

    // A caller can widen the live cap (skyFieldForScholar does this to see the
    // whole live pool before applying the tier-0 cap itself).
    const wide = await t.run(async (ctx) =>
      buildScholarSky(ctx, scholarId, { liveCap: 100 }),
    );
    expect(wide.filter((star) => star.status === "pending")).toHaveLength(20);
  });

  test("keeps a saved (active) or visited star past the recency cap (J8c)", async () => {
    // pilot9 J8c regression, sharpened: a star the scholar deliberately kept —
    // a saved story/keepsake (status "active") or one they already flew to (a
    // session stamped with its seedId → visited) — outranks fresh suggestions
    // for the scarce at-rest slots, so newer pending stars can never evict it.
    // Anchored stars do NOT, however, outrank the CAP: the live set is a hard
    // budget. Overflow isn't dropped, it just isn't lit at rest (the sky map
    // still renders it, revealed on zoom).
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);

    // An older SAVED keepsake and an older VISITED (started-quest) star.
    const saved = await directSeed(t, scholarId, {
      topic: "saved-active",
      status: "active",
    });
    const visited = await directSeed(t, scholarId, {
      topic: "visited-pending",
      status: "pending",
    });
    await sessionFor(t, scholarId, visited);

    // A dozen newer fresh suggestions (pending, never visited) chart in on top —
    // far more than SEED_CONSIDERATION_CAP.
    for (let i = 0; i < 12; i++) {
      await directSeed(t, scholarId, { topic: `fresh-${String(i).padStart(2, "0")}` });
    }

    const sky = await t.run(async (ctx) => buildScholarSky(ctx, scholarId));
    const byTopic = new Map(sky.map((s) => [s.topic, s]));

    // Both anchored stars survive despite the newer suggestions + the cap.
    expect(byTopic.get("saved-active")?._id).toBe(saved);
    expect(byTopic.get("visited-pending")?._id).toBe(visited);

    // Fresh suggestions still bounded: anchored stars fill part of the cap, the
    // rest goes to the ranked pending pool — the live set never exceeds the cap.
    const live = sky.filter((s) => !s.completed);
    expect(live).toHaveLength(SEED_CONSIDERATION_CAP);
    const fresh = live.filter((s) => s.topic.startsWith("fresh-"));
    expect(fresh).toHaveLength(SEED_CONSIDERATION_CAP - 2);
  });

  test("more anchored stars than the cap does NOT blow the live budget", async () => {
    // The bug this guards: anchored stars used to be kept "in full past the
    // cap", so the live set silently returned max(cap, anchoredCount) rows —
    // over budget, and with ZERO slots left for fresh invitations. Anchored
    // stars accrue without bound (a story-moment souvenir mints one per curated
    // story edge), so this is reachable in normal use, not a synthetic edge.
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);

    const anchoredCount = SEED_CONSIDERATION_CAP + 4;
    for (let i = 0; i < anchoredCount; i++) {
      await directSeed(t, scholarId, {
        topic: `anchored-${String(i).padStart(2, "0")}`,
        // Distinct domains, so the diversity ranker never has to reject a
        // candidate — the only thing bounding the result is the cap itself.
        domain: `domain-${i}`,
        status: "active",
      });
    }
    for (let i = 0; i < 5; i++) {
      await directSeed(t, scholarId, {
        topic: `fresh-${String(i).padStart(2, "0")}`,
        domain: `fresh-domain-${i}`,
      });
    }

    const sky = await t.run(async (ctx) => buildScholarSky(ctx, scholarId));
    const live = sky.filter((s) => !s.completed);

    expect(anchoredCount).toBeGreaterThan(SEED_CONSIDERATION_CAP);
    expect(live).toHaveLength(SEED_CONSIDERATION_CAP);
    // Anchored still beats fresh for every available slot.
    expect(live.every((s) => s.topic.startsWith("anchored-"))).toBe(true);
    // Newest-first ordering survives the ranked selection.
    const creationTimes = await t.run(async (ctx) =>
      Promise.all(live.map(async (s) => (await ctx.db.get(s._id))!._creationTime)),
    );
    expect(creationTimes).toEqual([...creationTimes].sort((a, b) => b - a));
  });

  test("a live pool smaller than liveCap is returned untouched, newest-first (map path)", async () => {
    // concepts.skyFieldForScholar passes a wide liveCap and derives its own
    // recencyRank from the ARRAY INDEX of this result, so the ranked selection
    // must be a provable identity transform whenever the cap isn't binding.
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);

    const ids: Id<"seeds">[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        await directSeed(t, scholarId, {
          topic: `pool-${String(i).padStart(2, "0")}`,
          domain: i % 2 === 0 ? "Physics" : "Biology",
          status: i % 3 === 0 ? "active" : "pending",
        }),
      );
    }
    // One visited (anchored-by-visit) row, to exercise both partitions.
    await sessionFor(t, scholarId, ids[4]);

    const wide = await t.run(async (ctx) =>
      buildScholarSky(ctx, scholarId, { liveCap: 100 }),
    );
    const rows = await t.run(async (ctx) =>
      ctx.db.query("seeds").collect(),
    );
    const expected = rows
      .filter((s) => s.scholarId === scholarId)
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((s) => String(s._id));

    expect(wide.map((s) => String(s._id))).toEqual(expected);
  });

  test("the map's full-pool read keeps every anchor past the old 60-row cap", async () => {
    // concepts.skyFieldForScholar wants the WHOLE live pool — it applies its own
    // tier-0 cap and reveals the rest on zoom, so nothing may be dropped here.
    // It used to ask for `SEED_READ_LIMIT` (60) and get everything anyway,
    // because anchored stars bypassed the cap entirely. Now that the cap is a
    // hard budget, asking for 60 would TRUNCATE the map — and would throw away
    // precisely the oldest anchors that ACTIVE_SEED_READ_LIMIT was widened to
    // preserve, defeating that half of the fix. `SKY_FULL_LIVE_POOL` is the
    // bounded pool both reads can produce, so the selection stays non-binding.
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);

    const anchoredCount = 70; // > the old 60-row liveCap
    for (let i = 0; i < anchoredCount; i++) {
      await directSeed(t, scholarId, {
        topic: `anchor-${String(i).padStart(3, "0")}`,
        domain: `domain-${i % 7}`,
        status: "active",
      });
    }

    const mapPool = await t.run(async (ctx) =>
      buildScholarSky(ctx, scholarId, { liveCap: SKY_FULL_LIVE_POOL }),
    );
    expect(anchoredCount).toBeGreaterThan(60);
    expect(mapPool.filter((s) => !s.completed)).toHaveLength(anchoredCount);

    // The at-rest consideration set is still a hard budget for the list path.
    const atRest = await t.run(async (ctx) => buildScholarSky(ctx, scholarId));
    expect(atRest.filter((s) => !s.completed)).toHaveLength(
      SEED_CONSIDERATION_CAP,
    );
  });

  test("manual activity completion marks a unit-backed seed completed after the unit is done", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const teacherId = await seedTeacher(t);
    const { unitId, activityIds } = await unitWithActivities(t, teacherId, 2);
    const seedId = await directSeed(t, scholarId, {
      topic: "unit trail",
      origin: "teacher",
      status: "active",
      unitId,
    });
    const sessionId = await sessionFor(t, scholarId, seedId);
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, {
        unitId,
        activityId: activityIds[0],
      }),
    );

    const asScholar = await withScholar(t, scholarId);
    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId: activityIds[0],
      sessionId,
    });
    let row = await t.run(async (ctx) => ctx.db.get(seedId));
    expect(row?.status).toBe("active");

    const secondSessionId = await sessionFor(t, scholarId, seedId);
    await t.run(async (ctx) =>
      ctx.db.patch(secondSessionId, {
        unitId,
        activityId: activityIds[1],
      }),
    );
    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId: activityIds[1],
      sessionId: secondSessionId,
    });
    row = await t.run(async (ctx) => ctx.db.get(seedId));
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).toBeTypeOf("number");
  });

  test("deliverable rubric pass leaves the spawned seed pending", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const teacherId = await seedTeacher(t);
    const { unitId, activityIds } = await unitWithActivities(t, teacherId, 1);
    const seedId = await directSeed(t, scholarId, {
      topic: "deliverable trail",
      unitId,
    });
    const sessionId = await sessionFor(t, scholarId, seedId);
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, {
        unitId,
        activityId: activityIds[0],
      }),
    );
    const deliverableId = await t.run(async (ctx) =>
      ctx.db.insert("deliverables", {
        scholarId,
        sessionId,
        activityId: activityIds[0],
        submittedAt: Date.now(),
        textContent: "I completed the work.",
      }),
    );

    await t.mutation(internal.deliverables.applyCheckResult, {
      deliverableId,
      verdicts: [{ criterionId: "c1", level: "full" }],
      overall: "full",
      feedback: "Meets the criterion.",
      conceptLabel: "Seed completion",
      domain: "General",
      masteryLevel: 3,
      confidence: 0.9,
    });

    const [seed, session] = await t.run(async (ctx) =>
      Promise.all([ctx.db.get(seedId), ctx.db.get(sessionId)]),
    );
    expect(seed?.status).toBe("pending");
    expect(seed?.completedAt).toBeUndefined();
    expect(session?.activityCompletedAt).toBeUndefined();
  });
});

describe("observer seed dedup", () => {
  test("merges an exact-topic re-emit into the existing pending seed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);

    const first = await recordObserverSeed(t, scholarId, {
      topic: "Conduction and radiation in heat transfer",
      domain: "Physics",
      rationale: "first",
    });
    const second = await recordObserverSeed(t, scholarId, {
      topic: "Conduction and radiation in heat transfer",
      domain: "Physics",
      rationale: "merged",
    });

    expect(second).toBe(first);
    const rows = await seedsFor(t, scholarId);
    expect(rows).toHaveLength(1);
    expect(rows[0].rationale).toBe("merged");
  });

  test("different wording is NOT heuristically merged — semantic dedup is the observer's job via refreshesSeedId", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);

    await recordObserverSeed(t, scholarId, {
      topic: "Conduction and radiation in heat transfer",
      domain: "Physics",
    });
    await recordObserverSeed(t, scholarId, {
      topic: "How heat transfer works through conduction/radiation",
      domain: "Physics",
    });

    const rows = await seedsFor(t, scholarId);
    expect(rows).toHaveLength(2);
  });
});
