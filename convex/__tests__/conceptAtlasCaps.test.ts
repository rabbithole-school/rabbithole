import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { buildEdges, buildNeighborEdges, canonicalPairKey, MAX_STORED_BRIDGES, MAX_EXPLICIT_EDGES, MIN_NN_SIMILARITY, NN_NEIGHBORS_K, type EdgeConcept } from "../lib/atlasEdges";

// Why this file: prod's concept atlas is dominated by thousands of per-scholar
// exploration seeds (2500+ on prod vs ~300 in dev). The display queries
// (getAtlas / classGalaxy / atlasForScholar) must stay BOUNDED so the page
// renders, and the EDGES must be precomputed at build time so the read-time
// getAtlasEdges query never runs the O(n²) cosine over thousands of 512-d
// embeddings (that blew the per-query budget — the prod ErrorBoundary).

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const MAX_ATLAS_NODES = 900; // mirror of the constant in concepts.ts

async function teacher(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Teacher", username: "t", role: "teacher" }),
  );
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

// A tiny deterministic 8-d embedding (cosine just needs vectors, not 512-d).
function emb(seed: number): number[] {
  return Array.from({ length: 8 }, (_, i) => Math.sin(seed * (i + 1)) + 1.1);
}

async function seedAtlas(
  t: ReturnType<typeof convexTest>,
  counts: { standards: number; mastery: number; seeds: number },
) {
  await t.run(async (ctx) => {
    let n = 0;
    const ins = async (source: string, i: number, refCount: number) => {
      // Sky nodes now live in the SHARED knowledgeNodes table; the atlas reads
      // filter to sky sources + placed (skyX/skyY), so practice nodes are excluded.
      const id = await ctx.db.insert("knowledgeNodes", {
        nodeKey: `${source}-${i}`,
        label: `${source}-${i}`,
        normalizedLabel: `${source}-${i}`,
        domain: i % 2 === 0 ? "math" : "biology",
        source,
        skyX: (i % 50) + 1,
        skyY: (i % 40) + 1,
        refCount,
      });
      // embeddings live in the side table now, keyed by nodeId
      await ctx.db.insert("knowledgeNodeEmbeddings", { nodeId: id, vector: emb(++n) });
    };
    for (let i = 0; i < counts.standards; i++) await ins("standard", i, 1);
    for (let i = 0; i < counts.mastery; i++) await ins("mastery", i, 3);
    for (let i = 0; i < counts.seeds; i++) await ins("seed", i, counts.seeds - i);
  });
}

describe("concept atlas — display caps at prod scale", () => {
  test("getAtlas caps nodes at MAX_ATLAS_NODES and keeps the whole backbone", async () => {
    const t = convexTest(schema, modules);
    const backbone = 150;
    await seedAtlas(t, { standards: 100, mastery: 50, seeds: 2000 });
    const asTeacher = await teacher(t);

    const atlas = await asTeacher.query(api.concepts.getAtlas, {});
    expect(atlas.total).toBe(2150);
    expect(atlas.shown).toBe(MAX_ATLAS_NODES);
    expect(atlas.nodes.length).toBe(MAX_ATLAS_NODES);
    const nonSeed = atlas.nodes.filter((nd) => nd.source !== "seed").length;
    expect(nonSeed).toBe(backbone);
    const seedLabels = atlas.nodes.filter((nd) => nd.source === "seed").map((nd) => nd.label);
    expect(seedLabels).toContain("seed-0");
    expect(seedLabels).not.toContain("seed-1999");
  });

  test("below the cap, every concept is shown (no behavior change at dev scale)", async () => {
    const t = convexTest(schema, modules);
    await seedAtlas(t, { standards: 100, mastery: 50, seeds: 100 });
    const asTeacher = await teacher(t);
    const atlas = await asTeacher.query(api.concepts.getAtlas, {});
    expect(atlas.total).toBe(250);
    expect(atlas.shown).toBe(250);
    expect(atlas.nodes.length).toBe(250);
  });
});

describe("concept atlas — precomputed edges", () => {
  // NOTE: this is the heaviest test in the suite — it seeds 2150 sky nodes and
  // runs the bounded O(n²) cosine build through an action. In isolation it's
  // ~1s, but under CPU contention (the full parallel suite on a low-core CI
  // runner) the test body has been observed to stretch to ~2s, so it runs
  // against the 5000ms default timeout with a shrinking margin. It's passing on
  // CI today; if it starts flaking on timeout, bump this test's timeout (add a
  // 4th arg, e.g. 20_000) rather than shrinking the seed — the prod-scale
  // fixture is the point. Revisit only if it actually flakes.
  test("getAtlasEdges reads the precomputed table (no concept read / cosine at query time)", async () => {
    const t = convexTest(schema, modules);
    await seedAtlas(t, { standards: 100, mastery: 50, seeds: 2000 });
    const asTeacher = await teacher(t);

    // Before the build, no edges exist → the query returns empty (it never
    // touches the thousands of embeddings).
    const before = await asTeacher.query(api.concepts.getAtlasEdges, { maxBridges: 20 });
    expect(before.bridges).toEqual([]);

    // Build the edges (this is where the bounded cosine runs — in an action).
    const built = await t.action(internal.conceptAtlas.computeEdges, {});
    expect(built.edges).toBeGreaterThan(0);
    // bridges + explicit are globally capped; the per-node "nn" neighborhood adds
    // ≤ nodes·K more (undirected-deduped), so the total is bounded but well above
    // the sky-view cap. 2150 sky nodes are seeded here.
    expect(built.edges).toBeLessThanOrEqual(
      MAX_STORED_BRIDGES + MAX_EXPLICIT_EDGES + 2150 * NN_NEIGHBORS_K,
    );

    const started = Date.now();
    const edges = await asTeacher.query(api.concepts.getAtlasEdges, { maxBridges: 20 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(edges.bridges.length).toBeLessThanOrEqual(20);
    for (const b of edges.bridges) expect(b.source).not.toBe(b.target);
  }, 30000);
});

describe("buildEdges — pure, bounded", () => {
  function concept(i: number, domain: string, refCount: number): EdgeConcept {
    return { nodeKey: `c-${i}`, domain, refCount, normalizedLabel: `c-${i}`, embedding: emb(i) };
  }

  test("bridges are cross-domain only and capped at MAX_STORED_BRIDGES", () => {
    const concepts: EdgeConcept[] = [];
    for (let i = 0; i < 300; i++) concepts.push(concept(i, i % 2 ? "math" : "biology", 300 - i));
    const edges = buildEdges(concepts, []);
    const bridges = edges.filter((e) => e.kind === "bridge");
    expect(bridges.length).toBeLessThanOrEqual(MAX_STORED_BRIDGES);
    expect(bridges.length).toBeGreaterThan(0);
  });

  test("explicit edges resolve labels case-insensitively and are capped", () => {
    const concepts: EdgeConcept[] = [concept(0, "math", 1), concept(1, "biology", 1)];
    const conns = [{ conceptLabels: ["C-0", "c-1"] }];
    const edges = buildEdges(concepts, conns);
    const explicit = edges.filter((e) => e.kind === "explicit");
    expect(explicit.length).toBe(1);
    expect(explicit.length).toBeLessThanOrEqual(MAX_EXPLICIT_EDGES);
  });
});

describe("buildNeighborEdges — per-node associative neighborhood", () => {
  // 2-D embeddings; cosine normalizes, so magnitudes don't matter.
  function c(key: string, domain: string, vec: number[]): EdgeConcept {
    return { nodeKey: key, domain, refCount: 1, normalizedLabel: key, embedding: vec };
  }
  const touching = <T extends { fromKey: string; toKey: string }>(
    edges: T[],
    key: string,
  ) => edges.filter((e) => e.fromKey === key || e.toKey === key);

  test("each node contributes at most K edges from its own top-K", () => {
    // A tight 8-node cluster (mutual cosine ≈ 1) + one node at 45° (cosine ≈
    // 0.707 to all of them, above the floor but below the cluster's mutual sim).
    // The cluster's own top-K are always other cluster members, so the 45° node
    // is never a reverse-pick → it links to EXACTLY K neighbors.
    const concepts: EdgeConcept[] = [];
    concepts.push(c("hub", "math", [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)]));
    for (let i = 1; i <= 8; i++) {
      const t = i * 0.0005; // near-0 angle → mutually ≈ identical
      concepts.push(c(`cl-${i}`, "math", [Math.cos(t), Math.sin(t)]));
    }
    const edges = buildNeighborEdges(concepts, new Set(), NN_NEIGHBORS_K);
    for (const e of edges) expect(e.kind).toBe("nn");
    expect(touching(edges, "hub").length).toBe(NN_NEIGHBORS_K);
    // weight is the cosine (~0.707 for the hub's links)
    for (const e of touching(edges, "hub")) {
      expect(e.weight).toBeGreaterThan(0.6);
      expect(e.weight).toBeLessThan(0.8);
    }
  });

  test("connects same-domain neighbors (unlike cross-domain-only bridges)", () => {
    const a = c("a", "math", [1, 0]);
    const b = c("b", "math", [0.99, 0.01]); // very close, same domain
    const edges = buildNeighborEdges([a, b], new Set());
    expect(edges.length).toBe(1);
    expect(edges[0].kind).toBe("nn");
  });

  test("drops neighbors below MIN_NN_SIMILARITY", () => {
    // orthogonal → cosine 0, well under the 0.25 floor.
    const edges = buildNeighborEdges(
      [c("a", "math", [1, 0]), c("b", "math", [0, 1])],
      new Set(),
    );
    expect(edges).toEqual([]);
    expect(MIN_NN_SIMILARITY).toBeGreaterThan(0);
  });

  test("excludes pairs already joined by a tree edge (no lattice duplication)", () => {
    const a = c("a", "math", [1, 0]);
    const b = c("b", "math", [1, 0.001]); // ~identical → would be top neighbor
    const withoutTree = buildNeighborEdges([a, b], new Set());
    expect(withoutTree.length).toBe(1);
    // now mark (a,b) as a tree pair → the nn link must not be re-emitted
    const withTree = buildNeighborEdges([a, b], new Set([canonicalPairKey("a", "b")]));
    expect(withTree).toEqual([]);
  });

  test("dedupes undirected: a mutual pair is emitted once, canonical order", () => {
    const a = c("z", "math", [1, 0.002]);
    const b = c("a", "math", [1, 0]); // mutual nearest neighbor of z
    const edges = buildNeighborEdges([a, b], new Set());
    expect(edges.length).toBe(1);
    // canonical order → fromKey < toKey ("a" before "z")
    expect(edges[0].fromKey).toBe("a");
    expect(edges[0].toKey).toBe("z");
  });

  test("excludes self", () => {
    const edges = buildNeighborEdges([c("a", "math", [1, 0])], new Set());
    expect(edges).toEqual([]);
  });
});
