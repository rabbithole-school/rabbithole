"use node";
/**
 * Practice Atlas — Skills-map layout positions.
 *
 * Computes the two projected coordinates stored on each knowledgeNodes row:
 *   treeX  = DAG depth (longest-prerequisite-path; deterministic, no embedding)
 *   treeY  = PC1 of label embeddings  (vertical spread in the Skills map)
 *   treeY2 = PC2 of label embeddings  (parallax lane / subtle 2.5D offset)
 *
 * Mirror of conceptAtlas.ts's pipeline, but for the tech-tree (Skills map)
 * projection:
 *   • X is DAG-depth-constrained (left = roots, right = advanced)
 *   • Y / Y2 come from PCA of label embeddings, NOT from omnidirectional PCA
 *
 * Usage: call rebuildPracticeAtlas from a Convex dashboard run or a
 * one-off cron once the nodes are seeded. It is idempotent (re-running
 * overrides the existing treeX/Y/Y2 + projectedAt).
 *
 * pca2d is imported from convex/lib/pca.ts (shared with conceptAtlas).
 * computeDepths is imported from convex/lib/practiceAtlasLayout.ts (pure,
 * tested independently).
 *
 * Internal DB helpers live in practiceAtlasData.ts (V8 runtime):
 *   _nodesForDomain, _buildsOnEdgesForDomain, _patchAtlasPositions
 * Those are referenced via internal.practiceAtlasData.* — which requires
 * a `npx convex dev` / codegen pass to appear in _generated/api.d.ts.
 * Until then, the three ctx.runQuery/runMutation calls below produce
 * expected tsc errors (Property 'practiceAtlasData' does not exist on
 * type 'FilterApi<...>'). The source is correct; run codegen to clear them.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pca2d } from "./lib/pca";
import { computeDepths } from "./lib/practiceAtlasLayout";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "./seed/wholeNumberArithmeticGraph";

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMS = 512;
const BATCH_SIZE = 128; // OpenAI embeddings batch limit
const PATCH_CHUNK = 100; // Convex mutation chunk size

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
  });
  if (!res.ok)
    throw new Error(
      `OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/**
 * Rebuild treeX / treeY / treeY2 for all nodes in a domain.
 *
 * @param domain - The discipline vertical to process. Defaults to
 *   "whole-number-arithmetic". Future domains (biology, coding, …) pass their
 *   own domain string.
 *
 * @returns Summary: { domain, nodes, maxDepth }
 *
 * NOT invoked automatically — call from the Convex dashboard or a one-off
 * `npx convex run practiceAtlas:rebuildPracticeAtlas` after seeding nodes.
 * Requires OPENAI_API_KEY to be set on the deployment.
 */
export const rebuildPracticeAtlas = internalAction({
  args: {
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set on this deployment");

    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;

    // ── 1. Load canonical node rows + buildsOn edges ─────────────────────
    const nodes = (await ctx.runQuery(internal.practiceAtlasData._nodesForDomain, {
      domain,
    })) as Array<{ _id: Id<"knowledgeNodes">; nodeKey: string; label: string; embeddingText?: string }>;

    const edges = (await ctx.runQuery(internal.practiceAtlasData._buildsOnEdgesForDomain, { domain })) as { fromKey: string; toKey: string }[];

    if (nodes.length === 0) {
      return { domain, nodes: 0, maxDepth: 0 };
    }

    // ── 2. treeX = longest-prerequisite-path DAG depth (deterministic) ───
    const depthMap = computeDepths(
      nodes.map((n) => n.nodeKey),
      edges,
    );
    const maxDepth = Math.max(...depthMap.values(), 0);

    // ── 3. Embed labels → treeY (PC1) + treeY2 (PC2) ────────────────────
    const texts = nodes.map((n) =>
      (n.embeddingText ?? n.label).slice(0, 1000),
    );
    const allVecs: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = await embedBatch(texts.slice(i, i + BATCH_SIZE), apiKey);
      allVecs.push(...batch);
    }

    // PCA: PC1 → treeY (primary vertical spread), PC2 → treeY2 (parallax)
    const coords = pca2d(allVecs);
    const pc1 = coords.map((c) => c[0]);
    const pc2 = coords.map((c) => c[1]);

    const minPC1 = Math.min(...pc1), maxPC1 = Math.max(...pc1);
    const minPC2 = Math.min(...pc2), maxPC2 = Math.max(...pc2);
    const spanPC1 = maxPC1 - minPC1 || 1;
    const spanPC2 = maxPC2 - minPC2 || 1;

    // Normalise to [4, 96] (4% margin on each side, mirrors conceptAtlas)
    const rows = nodes.map((n, i) => ({
      id: n._id,
      treeX: depthMap.get(n.nodeKey) ?? 0,
      treeY: 4 + ((pc1[i] - minPC1) / spanPC1) * 92,
      treeY2: 4 + ((pc2[i] - minPC2) / spanPC2) * 92,
    }));

    // ── 4. Persist in chunks ─────────────────────────────────────────────
    for (let i = 0; i < rows.length; i += PATCH_CHUNK) {
      await ctx.runMutation(internal.practiceAtlasData._patchAtlasPositions, {
        rows: rows.slice(i, i + PATCH_CHUNK),
      });
    }

    return { domain, nodes: nodes.length, maxDepth };
  },
});
