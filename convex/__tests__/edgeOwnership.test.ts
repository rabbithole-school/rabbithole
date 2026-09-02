import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  buildEdges,
  buildNeighborEdges,
  canonicalPairKey,
  type EdgeConcept,
} from "../lib/atlasEdges";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const concept = (
  nodeKey: string,
  domain: string,
  embedding: number[],
): EdgeConcept => ({
  nodeKey,
  domain,
  embedding,
  normalizedLabel: nodeKey,
  refCount: 1,
});

describe("durable edge ownership", () => {
  test("_clearEdges preserves durable story edges and deletes cache rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "a",
        toKey: "b",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: {
          kind: "history",
          hook: "Durable",
          narrative: "Corpus survives.",
          provenance: "authored",
        },
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "a",
        toKey: "c",
        domain: "sky",
        kind: "bridge",
        method: "embedding",
        weight: 0.7,
      });
    });

    expect(await t.mutation(internal.concepts._clearEdges, {})).toBe(1);
    const rows = await t.run(async (ctx) => ctx.db.query("knowledgeNodeEdges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].toKey).toBe("b");
    expect(rows[0].story?.hook).toBe("Durable");
  });

  test("pruneStaleSkyNodes preserves nodes anchored by durable edges", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "seed_topic",
        label: "Seed Topic",
        domain: "science",
        source: "seed",
        normalizedLabel: "seed_topic",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "world_topic",
        label: "World Topic",
        domain: "history",
        source: "world",
        normalizedLabel: "world_topic",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "seed_topic",
        toKey: "world_topic",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: {
          kind: "history",
          hook: "Anchored",
          narrative: "The durable edge anchors both endpoints.",
          provenance: "authored",
        },
      });
    });

    const res = await t.mutation(internal.knowledgeNodes.pruneStaleSkyNodes, {
      keepKeys: [],
    });
    expect(res.deleted).toBe(0);
    const nodes = await t.run(async (ctx) => ctx.db.query("knowledgeNodes").collect());
    expect(nodes.map((n) => n.nodeKey).sort()).toEqual(["seed_topic", "world_topic"]);
  });

  test("practice and tree rebuilds preserve durable story edges and world nodes", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "world_topic",
        label: "World Topic",
        domain: "history",
        source: "world",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "prime_factorization",
        toKey: "world_topic",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: {
          kind: "history",
          hook: "Anchored",
          narrative: "A manually curated story.",
          provenance: "authored",
        },
      });
    });

    await t.mutation(internal.knowledgeNodes.rebuild, {});
    await t.mutation(internal.knowledgeNodes.rebuildTree, {});

    const rows = await t.run(async (ctx) => ({
      nodes: await ctx.db.query("knowledgeNodes").collect(),
      edges: await ctx.db.query("knowledgeNodeEdges").collect(),
    }));
    expect(rows.nodes.some((n) => n.nodeKey === "world_topic")).toBe(true);
    expect(
      rows.edges.some(
        (e) =>
          e.fromKey === "prime_factorization" &&
          e.toKey === "world_topic" &&
          e.story?.hook === "Anchored",
      ),
    ).toBe(true);
  });

  test("atlas builders skip pairs already joined by durable edges", () => {
    const a = concept("a", "math", [1, 0]);
    const b = concept("b", "biology", [1, 0]);
    const durablePairs = new Set([canonicalPairKey("a", "b")]);

    expect(
      buildEdges([a, b], [{ conceptLabels: ["a", "b"] }], durablePairs),
    ).toEqual([]);
    expect(buildNeighborEdges([a, b], new Set(), 4, durablePairs)).toEqual([]);
  });

  test("practice rebuild is fixture-authoritative: stale buildsOn pairs are removed", async () => {
    const t = convexTest(schema, modules);
    // A leftover edge from an imagined earlier fixture version — method:"curated"
    // must NOT protect it (the regression: curated-stamped reinserts making the
    // practice graph append-only).
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "phantom_prereq",
        toKey: "phantom_child",
        domain: "whole-number-arithmetic",
        kind: "buildsOn",
        method: "curated",
      });
    });
    await t.mutation(internal.knowledgeNodes.rebuild, {});
    const edges = await t.run(async (ctx) =>
      ctx.db.query("knowledgeNodeEdges").collect(),
    );
    expect(
      edges.some((e) => e.fromKey === "phantom_prereq" && e.kind === "buildsOn"),
    ).toBe(false);
  });

  test("a story on a fixture buildsOn pair survives the rebuild's clear+reinsert", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});
    const { pair, countBefore } = await t.run(async (ctx) => {
      const all = await ctx.db.query("knowledgeNodeEdges").collect();
      const buildsOn = all.filter((e) => e.kind === "buildsOn");
      const target = buildsOn[0];
      await ctx.db.patch(target._id, {
        story: {
          kind: "history" as const,
          hook: "Why this unlocks that",
          narrative: "A narrative about the dependency itself.",
          provenance: "authored" as const,
        },
      });
      return {
        pair: { fromKey: target.fromKey, toKey: target.toKey },
        countBefore: buildsOn.length,
      };
    });
    await t.mutation(internal.knowledgeNodes.rebuild, {});
    const after = await t.run(async (ctx) => {
      const all = await ctx.db.query("knowledgeNodeEdges").collect();
      return all.filter((e) => e.kind === "buildsOn");
    });
    expect(after.length).toBe(countBefore); // idempotent, not append-only
    const carried = after.find(
      (e) => e.fromKey === pair.fromKey && e.toKey === pair.toKey,
    );
    expect(carried?.story?.hook).toBe("Why this unlocks that");
  });

  test("pruneStaleSkyNodes keeps a story-anchored node WITH its embedding intact", async () => {
    const t = convexTest(schema, modules);
    const nodeId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("knowledgeNodes", {
        nodeKey: "tide_pools", label: "Tide pools", domain: "biology", source: "seed",
        skyX: 1, skyY: 2,
      });
      await ctx.db.insert("knowledgeNodeEmbeddings", { nodeId: id, vector: [0.1, 0.2, 0.3] });
      // A durable STORY bridge anchors the node (as the far end).
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "prime_factorization", toKey: "tide_pools", domain: "sky",
        kind: "bridge", method: "curated",
        story: { kind: "applies", hook: "Anchor", narrative: "n", provenance: "authored" },
      });
      return id;
    });
    // Not in keepKeys → prune candidate, but the story anchors it.
    const res = await t.mutation(internal.knowledgeNodes.pruneStaleSkyNodes, { keepKeys: [] });
    expect(res.deleted).toBe(0);
    const { node, emb } = await t.run(async (ctx) => ({
      node: await ctx.db.get(nodeId),
      emb: await ctx.db.query("knowledgeNodeEmbeddings").withIndex("by_node", (q) => q.eq("nodeId", nodeId)).unique(),
    }));
    expect(node).not.toBeNull();
    // The bug was: embedding deleted before the keep-check, orphaning the vector.
    expect(emb).not.toBeNull();
  });

  test("a plain curated dependency edge does NOT anchor a fixture-dropped curated node (no ghost)", async () => {
    const t = convexTest(schema, modules);
    // A curated node NOT in the TREES fixture, carrying only a plain (story-less)
    // curated tree edge — must be pruned, not stranded as a zero-edge ghost.
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "phantom_tree_node", label: "Phantom", domain: "math", source: "curated",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "phantom_tree_node", toKey: "phantom_child",
        domain: "math", kind: "buildsTowards", method: "curated",
      });
    });
    await t.mutation(internal.knowledgeNodes.rebuildTree, {});
    const survivor = await t.run(async (ctx) =>
      ctx.db.query("knowledgeNodes").withIndex("by_nodeKey", (q) => q.eq("nodeKey", "phantom_tree_node")).first(),
    );
    expect(survivor).toBeNull();
  });
});
