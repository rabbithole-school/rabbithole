import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { SEED_CONSIDERATION_CAP, SKY_FIELD_SEED_CAP } from "../../shared/skyTiers";
import { buildScholarSky } from "../lib/seeds";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Sky Scholar",
      username: "sky-scholar",
      role: "scholar",
    }),
  );
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

async function seedSkyField(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return await t.run(async (ctx) => {
    const fractionsId = await ctx.db.insert("knowledgeNodes", {
      nodeKey: "fractions",
      label: "Fractions",
      normalizedLabel: "fractions",
      domain: "math",
      source: "seed",
      skyX: 1,
      skyY: 2,
      refCount: 5,
    });
    const ratiosId = await ctx.db.insert("knowledgeNodes", {
      nodeKey: "ratios",
      label: "Ratios",
      normalizedLabel: "ratios",
      domain: "math",
      source: "standard",
      skyX: 3,
      skyY: 4,
      refCount: 3,
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: "fractions",
      toKey: "ratios",
      domain: "math",
      kind: "buildsOn",
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: "ratios",
      toKey: "missing-node",
      domain: "math",
      kind: "buildsOn",
    });
    await ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "pending",
      topic: "Fractions",
      domain: "math",
      suggestionType: "frontier",
      rationale: "Explore why fractions can name the same amount.",
    });
    return { fractionsId, ratiosId };
  });
}

describe("concepts.skyFieldForScholar", () => {
  test("extends atlasForScholar with hop tiers and buildsOn prereq edges", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const ids = await seedSkyField(t, scholarId);
    // Push the live seed count to SKY_COLD_START_MIN_STARS so the cold-start
    // "starter" layer (convex/lib/skyMuseum.ts) doesn't blend in synthetic
    // stars here — this test is specifically pinning that skyFieldForScholar's
    // real nodes/lit/seeds/threads stay byte-identical to atlasForScholar's.
    // Both duplicate "Fractions" so they match the ALREADY-placed concept
    // (no new unmatched float), keeping that invariant meaningful.
    await t.run(async (ctx) => {
      await ctx.db.insert("seeds", {
        scholarId, origin: "ai", status: "pending", topic: "Fractions",
        domain: "math", suggestionType: "frontier", rationale: "more fractions",
      });
      await ctx.db.insert("seeds", {
        scholarId, origin: "ai", status: "pending", topic: "Fractions",
        domain: "math", suggestionType: "frontier", rationale: "even more fractions",
      });
    });
    const asScholar = await withUser(t, scholarId);

    const atlas = await asScholar.query(api.concepts.atlasForScholar, { scholarId });
    expect(Object.keys(atlas).sort()).toEqual([
      "lit",
      "litCount",
      "nodes",
      "seeds",
      "standardLit",
      "threads",
    ]);

    const sky = await asScholar.query(api.concepts.skyFieldForScholar, { scholarId });
    expect(sky.prereqEdges).toEqual([{ s: ids.fractionsId, t: ids.ratiosId }]);
    expect(sky.nodes.every((node) => typeof node.hopTier === "number")).toBe(true);

    const touched = sky.nodes.find((node) => node.id === ids.fractionsId);
    const unlock = sky.nodes.find((node) => node.id === ids.ratiosId);
    expect(touched?.hopTier).toBe(0);
    expect(unlock?.hopTier).toBe(1);

    const skyAsAtlas = {
      nodes: sky.nodes.map(
        ({ id, label, domain, source, x, y, refCount }) => ({
          id,
          label,
          domain,
          source,
          x,
          y,
          refCount,
        }),
      ),
      lit: sky.lit,
      standardLit: sky.standardLit,
      seeds: sky.seeds,
      threads: sky.threads,
      litCount: sky.litCount,
    };
    expect(skyAsAtlas).toEqual(atlas);
  });

  test("carries scholar-safe seed meta and free-floats an unmatched seed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const ids = await seedSkyField(t, scholarId); // seeds a matched "Fractions" seed
    // an unmatched seed — its topic isn't a placed concept, connected to Fractions
    const unmatchedSeedId = await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai",
        status: "pending",
        topic: "Vampire-bat reciprocity",
        domain: "biology",
        suggestionType: "leap",
        connectionTo: "Fractions",
        rationale: "TEACHER-ONLY: Kai never connected fairness to biology.",
        scholarInvitation: "How do vampire bats remember who shared blood with them?",
      }),
    );
    const asScholar = await withUser(t, scholarId);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, { scholarId });

    // matched seed → meta keyed by its placed concept id
    expect(sky.seedMeta[ids.fractionsId as string]).toMatchObject({
      pinned: false,
      completed: false,
    });
    expect(typeof sky.seedMeta[ids.fractionsId as string]?.seedId).toBe("string");

    // unmatched seed → a free-float node + meta, NOT dropped
    const floatId = `seed:${unmatchedSeedId}`;
    const floatNode = sky.nodes.find((n) => n.id === floatId);
    expect(floatNode?.label).toBe("Vampire-bat reciprocity");
    expect(sky.seeds).toContain(floatId);
    // scholar-safe blurb = the invitation, never the teacher rationale
    expect(sky.seedMeta[floatId]?.blurb).toBe(
      "How do vampire bats remember who shared blood with them?",
    );
    expect(JSON.stringify(sky.seedMeta)).not.toContain("TEACHER-ONLY");
  });

  test("caps the tier-0 consideration set; overflow seeds join the field, not dropped", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);

    // CAP + 3 placed concepts, each with a matched pending seed. Insert oldest
    // → newest; buildScholarAtlas keeps the newest CAP, so the oldest 3 overflow.
    const OVERFLOW = 3;
    const total = SKY_FIELD_SEED_CAP + OVERFLOW;
    const conceptByIndex: Id<"knowledgeNodes">[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        const label = `Topic ${String(i).padStart(2, "0")}`;
        const conceptId = await ctx.db.insert("knowledgeNodes", {
          nodeKey: `topic-${i}`,
          label,
          normalizedLabel: norm(label),
          domain: "math",
          source: "seed",
          skyX: 10 + i,
          skyY: 20 + i,
          refCount: 2,
        });
        conceptByIndex.push(conceptId);
        await ctx.db.insert("seeds", {
          scholarId,
          origin: "ai",
          status: "pending",
          topic: label,
          domain: "math",
          suggestionType: "frontier",
          rationale: `explore ${label}`,
        });
      }
    });

    const asScholar = await withUser(t, scholarId);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, {
      scholarId,
    });

    // Exactly a handful of tier-0 invitations — never the whole accrued pile.
    expect(sky.seeds).toHaveLength(SKY_FIELD_SEED_CAP);

    // The consideration set is the NEWEST CAP concepts…
    const considered = new Set(sky.seeds as string[]);
    const nodeIds = new Set(sky.nodes.map((n) => n.id as string));
    const overflow = conceptByIndex.slice(0, OVERFLOW).map((c) => c as string);
    const kept = conceptByIndex.slice(OVERFLOW).map((c) => c as string);
    for (const id of kept) expect(considered.has(id)).toBe(true);

    // …and the overflow seeds are NOT tier-0 but STILL in the field (revealed on
    // zoom by their hopTier) — never dropped.
    for (const id of overflow) {
      expect(considered.has(id)).toBe(false);
      expect(nodeIds.has(id)).toBe(true);
      const node = sky.nodes.find((n) => n.id === id);
      expect(typeof node?.hopTier).toBe("number");
      expect(sky.seedMeta[id]).toMatchObject({
        seedId: expect.any(String),
        completed: false,
      });
    }
    // Every seed's concept survives in the node list.
    for (const id of conceptByIndex) expect(nodeIds.has(id as string)).toBe(true);
  });

  test("fresh diverse free-floats displace a stale cluster of matched seeds", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const freshTopics: string[] = [];

    await t.run(async (ctx) => {
      // Production-shaped failure: old observer suggestions have atlas matches,
      // but all repeat one Physics thread.
      for (let i = 0; i < SKY_FIELD_SEED_CAP; i++) {
        const topic = `Pressure and boiling variant ${i}`;
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: `pressure-${i}`,
          label: topic,
          normalizedLabel: norm(topic),
          domain: "Physics",
          source: "seed",
          skyX: 10 + i,
          skyY: 20 + i,
          refCount: 2,
        });
        await ctx.db.insert("seeds", {
          scholarId,
          origin: "ai",
          status: "pending",
          topic,
          domain: "Physics",
          suggestionType: "depth_probe",
          connectionTo: "Pressure and phase changes",
          rationale: `old observer suggestion ${i}`,
        });
      }

      // A freshly regenerated Interpretive constellation has no atlas nodes yet,
      // but reaches into genuinely different domains.
      const domains = [
        "Biology",
        "History",
        "Linguistics",
        "Engineering",
        "Philosophy",
        "Economics",
        "Music",
        "Astronomy",
      ];
      for (const [i, domain] of domains.entries()) {
        const topic = `Fresh ${domain} leap`;
        freshTopics.push(topic);
        await ctx.db.insert("seeds", {
          scholarId,
          origin: "ai-constellation",
          status: "pending",
          topic,
          domain,
          suggestionType: "leap",
          connectionTo: `A different bridge ${i}`,
          reach: 2,
          rationale: `fresh interpretive suggestion ${i}`,
          scholarInvitation: `Explore ${domain} from a surprising angle.`,
        });
      }
    });

    const asScholar = await withUser(t, scholarId);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, {
      scholarId,
    });

    expect(sky.seeds).toHaveLength(SKY_FIELD_SEED_CAP);
    expect(sky.seeds.every((id) => String(id).startsWith("seed:"))).toBe(true);
    const nodeById = new Map(sky.nodes.map((node) => [String(node.id), node]));
    expect(
      sky.seeds.map((id) => nodeById.get(String(id))?.label).sort(),
    ).toEqual([...freshTopics].sort());

    // The stale matched concepts remain available in the deeper field.
    const staleNodes = sky.nodes.filter((node) =>
      node.label.startsWith("Pressure and boiling variant"),
    );
    expect(staleNodes).toHaveLength(SKY_FIELD_SEED_CAP);
    expect(staleNodes.every((node) => node.hopTier > 0)).toBe(true);
  });

  test("unmatched overflow seeds free-float into the field at a deeper tier, not dropped", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);

    // No placed concepts → every seed is UNMATCHED, so they all free-float.
    // Insert more than the cap; the newest CAP are tier-0 floats (hopTier 0, in
    // `seeds`), the rest join the field at a deeper hopTier, still present.
    const OVERFLOW = 4;
    const total = SKY_FIELD_SEED_CAP + OVERFLOW;
    const seedIds: Id<"seeds">[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        const id = await ctx.db.insert("seeds", {
          scholarId,
          origin: "ai",
          status: "pending",
          topic: `Floating idea ${String(i).padStart(2, "0")}`,
          domain: "biology",
          suggestionType: "leap",
          rationale: `float ${i}`,
          scholarInvitation: `Wonder about ${i}?`,
        });
        seedIds.push(id);
      }
    });

    const asScholar = await withUser(t, scholarId);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, {
      scholarId,
    });

    expect(sky.seeds).toHaveLength(SKY_FIELD_SEED_CAP);
    // Every seed still appears as a node (nothing vanishes).
    const nodeById = new Map(sky.nodes.map((n) => [n.id as string, n]));
    for (const sid of seedIds) {
      const node = nodeById.get(`seed:${sid}`);
      expect(node).toBeTruthy();
    }
    // The overflow floats are NOT tier-0 and sit deeper, but remain actionable:
    // zoom reveals them and their retained metadata opens the invitation.
    const tier0 = new Set(sky.seeds as string[]);
    const overflowNodes = seedIds
      .map((sid) => `seed:${sid}`)
      .filter((id) => !tier0.has(id));
    expect(overflowNodes).toHaveLength(OVERFLOW);
    for (const id of overflowNodes) {
      expect((nodeById.get(id)!.hopTier as number)).toBeGreaterThan(0);
      expect(sky.seedMeta[id]).toBeTruthy();
    }
    // Tier-0 floats DO carry meta (tappable Begin Quest) at hopTier 0.
    for (const id of tier0 as Set<string>) {
      expect(nodeById.get(id)?.hopTier).toBe(0);
      expect(sky.seedMeta[id]).toBeTruthy();
    }
  });

  test("a large anchored pool still reaches the field — the map is never truncated by the at-rest budget", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);

    // The at-rest consideration cap is a HARD budget on the seed-list path, so
    // the map must ask buildScholarSky for the whole bounded live pool. It used
    // to ask for the per-status read limit (60) and get everything anyway,
    // because anchored ("active") stars bypassed the cap. They no longer do, so
    // a stale 60 here would silently drop the oldest anchors — the earliest
    // teacher pins — off the map entirely, with no zoom tier to catch them.
    // Story souvenirs mint one `active` seed per curated story edge, so an
    // anchored pool this size is reachable in normal use.
    const ANCHORED = 70;
    const seedIds: Id<"seeds">[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < ANCHORED; i++) {
        seedIds.push(
          await ctx.db.insert("seeds", {
            scholarId,
            origin: "ai",
            status: "active",
            topic: `Kept star ${String(i).padStart(3, "0")}`,
            domain: `domain-${i % 7}`,
            suggestionType: "leap",
            rationale: `kept ${i}`,
            scholarInvitation: `Revisit ${i}?`,
          }),
        );
      }
    });

    const asScholar = await withUser(t, scholarId);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, {
      scholarId,
    });

    expect(ANCHORED).toBeGreaterThan(SKY_FIELD_SEED_CAP);
    // Tier-0 is still bounded by the map's OWN cap...
    expect(sky.seeds).toHaveLength(SKY_FIELD_SEED_CAP);
    // ...but every anchored star survives into the field and stays tappable.
    const nodeById = new Map(sky.nodes.map((n) => [n.id as string, n]));
    for (const sid of seedIds) {
      const id = `seed:${sid}`;
      expect(nodeById.get(id)).toBeTruthy();
      expect(sky.seedMeta[id]).toBeTruthy();
    }
  });

  test("priority kept: a threaded-to-mastery seed beats a newer unthreaded one for a tier-0 slot", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);

    const { threadedConcept, oldestUnthreadedConcept } = await t.run(
      async (ctx) => {
        // A mastered concept, lit via an observation, is the thread's anchor.
        const masteredLabel = "Sharing fairly";
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: "sharing-fairly",
          label: masteredLabel,
          normalizedLabel: norm(masteredLabel),
          domain: "math",
          source: "standard",
          skyX: 5,
          skyY: 5,
          refCount: 4,
        });
        const sessionId = await ctx.db.insert("sessions", {
          userId: scholarId,
          title: "warmup",
          isArchived: false,
        });
        await ctx.db.insert("masteryObservations", {
          scholarId,
          conceptLabel: masteredLabel,
          domain: "math",
          sessionId,
          observedAt: Date.now(),
          transcriptExcerpt: "split evenly",
          masteryLevel: 2.5,
          confidenceScore: 0.9,
          evidenceSummary: "demonstrated",
          evidenceType: "direct_demonstration",
          attemptContext: "guided",
          studentInitiated: true,
          isSuperseded: false,
        });

        // The THREADED seed is inserted FIRST (oldest) — on recency alone it
        // would overflow. Its connectionTo points at the mastered concept.
        const threadedLabel = "Vampire-bat reciprocity";
        const threadedConcept = await ctx.db.insert("knowledgeNodes", {
          nodeKey: "vampire-bat",
          label: threadedLabel,
          normalizedLabel: norm(threadedLabel),
          domain: "biology",
          source: "seed",
          skyX: 40,
          skyY: 40,
          refCount: 2,
        });
        await ctx.db.insert("seeds", {
          scholarId,
          origin: "ai",
          status: "pending",
          topic: threadedLabel,
          domain: "biology",
          suggestionType: "leap",
          connectionTo: masteredLabel,
          rationale: "threaded to a mastered idea",
        });

        // Then CAP newer, UNTHREADED matched seeds. The oldest of these should
        // get bumped out of the consideration set by the threaded seed.
        let oldestUnthreadedConcept: Id<"knowledgeNodes"> | null = null;
        for (let i = 0; i < SKY_FIELD_SEED_CAP; i++) {
          const label = `Unthreaded ${String(i).padStart(2, "0")}`;
          const conceptId = await ctx.db.insert("knowledgeNodes", {
            nodeKey: `unthreaded-${i}`,
            label,
            normalizedLabel: norm(label),
            domain: "math",
            source: "seed",
            skyX: 60 + i,
            skyY: 60 + i,
            refCount: 2,
          });
          if (i === 0) oldestUnthreadedConcept = conceptId;
          await ctx.db.insert("seeds", {
            scholarId,
            origin: "ai",
            status: "pending",
            topic: label,
            domain: "math",
            suggestionType: "frontier",
            rationale: `explore ${label}`,
          });
        }
        return { threadedConcept, oldestUnthreadedConcept: oldestUnthreadedConcept! };
      },
    );

    const asScholar = await withUser(t, scholarId);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, {
      scholarId,
    });

    expect(sky.seeds).toHaveLength(SKY_FIELD_SEED_CAP);
    const considered = new Set(sky.seeds as string[]);
    // Threaded-to-mastery wins its slot despite being the oldest seed.
    expect(considered.has(threadedConcept as string)).toBe(true);
    // …and it displaced the oldest unthreaded seed, which drops to the field.
    expect(considered.has(oldestUnthreadedConcept as string)).toBe(false);
    const nodeIds = new Set(sky.nodes.map((n) => n.id as string));
    expect(nodeIds.has(oldestUnthreadedConcept as string)).toBe(true);
  });

  test("the map's tier-0 cap is independent of the seed-list / galaxy cap", async () => {
    // The sky map is the only surface where the cap is a LEGIBILITY judgement
    // about a rendered field of stars. The shared SEED_CONSIDERATION_CAP is a
    // list/payload bound (buildScholarSky → native "me" tab, and
    // GALAXY_SEED_PER_SCHOLAR → the teacher Class Galaxy). Tuning one must
    // never silently move the other, so each surface asserts against ITS OWN
    // constant here — these assertions stay meaningful the moment the two
    // values diverge, and would fail if the map were rewired back to the
    // shared constant (or vice versa).
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);

    const total = Math.max(SKY_FIELD_SEED_CAP, SEED_CONSIDERATION_CAP) + 5;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        const label = `Independent ${String(i).padStart(2, "0")}`;
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: `independent-${i}`,
          label,
          normalizedLabel: norm(label),
          // Distinct domains, so the diversity ranker never has to reject a
          // candidate — the only thing bounding the result is the cap itself.
          domain: `domain-${i}`,
          source: "seed",
          skyX: 10 + i,
          skyY: 20 + i,
          refCount: 2,
        });
        await ctx.db.insert("seeds", {
          scholarId,
          origin: "ai",
          status: "pending",
          topic: label,
          domain: `domain-${i}`,
          suggestionType: "frontier",
          rationale: `explore ${label}`,
        });
      }
    });

    const asScholar = await withUser(t, scholarId);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, {
      scholarId,
    });
    expect(sky.seeds).toHaveLength(SKY_FIELD_SEED_CAP);

    const list = await t.run(async (ctx) => buildScholarSky(ctx, scholarId));
    expect(list.filter((star) => !star.completed)).toHaveLength(
      SEED_CONSIDERATION_CAP,
    );
  });
});
