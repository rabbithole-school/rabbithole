"use node";
// Concept Atlas — the heavy build steps (Node action): embed each concept as
// label+evidence, then project the embedding cloud to a shared 2D atlas.
//
// Projection is dependency-free PCA (dual / Gram-matrix power iteration) — clean
// and server-side; the UMAP spike (review/concept-atlas-spike.html) validated a
// nicer nonlinear layout as a future upgrade. Embeddings are 512-dim
// (text-embedding-3-small `dimensions:512`) to keep storage + read compact.
// The internal q/m these call live in concepts.ts (a node file holds only actions).
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildEdges, buildNeighborEdges, canonicalPairKey, NN_NEIGHBORS_K } from "./lib/atlasEdges";

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMS = 512;

async function embedBatch(texts: string[], key: string): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/** Embed every concept that lacks an embedding (label + evidence) → side table. */
export const embedConcepts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ embedded: number }> => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set on this deployment");
    const todo = await ctx.runQuery(internal.concepts._conceptsToEmbed, {});
    let done = 0;
    for (let i = 0; i < todo.length; i += 128) {
      const chunk = todo.slice(i, i + 128);
      const vecs = await embedBatch(chunk.map((c) => c.text.slice(0, 1000)), key);
      const rows = chunk.map((c, k) => ({ nodeId: c.id as Id<"knowledgeNodes">, vector: vecs[k] }));
      for (let j = 0; j < rows.length; j += 32) {
        await ctx.runMutation(internal.concepts._insertEmbeddings, { rows: rows.slice(j, j + 32) });
      }
      done += chunk.length;
    }
    return { embedded: done };
  },
});

// ─── PCA (dual / Gram-matrix power iteration) ───────────────────────
function pca2d(vectors: number[][]): [number, number][] {
  const n = vectors.length;
  if (n === 0) return [];
  const d = vectors[0].length;
  const mean = new Array(d).fill(0);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const X = vectors.map((v) => v.map((x, j) => x - mean[j]));
  // Gram matrix G = X Xᵀ (n×n)
  const G: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = i; k < n; k++) {
      let s = 0;
      const xi = X[i], xk = X[k];
      for (let j = 0; j < d; j++) s += xi[j] * xk[j];
      G[i][k] = s; G[k][i] = s;
    }
  }
  function topEig(M: number[][]): { vec: number[]; val: number } {
    let v = Array.from({ length: n }, () => Math.random() - 0.5);
    let val = 0;
    for (let iter = 0; iter < 120; iter++) {
      const w = new Array(n).fill(0);
      for (let i = 0; i < n; i++) { let s = 0; const Mi = M[i]; for (let k = 0; k < n; k++) s += Mi[k] * v[k]; w[i] = s; }
      const norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0)) || 1;
      v = w.map((x) => x / norm);
      val = norm;
    }
    return { vec: v, val };
  }
  const e1 = topEig(G);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) G[i][k] -= e1.val * e1.vec[i] * e1.vec[k];
  const e2 = topEig(G);
  const s1 = Math.sqrt(Math.max(e1.val, 1e-9)), s2 = Math.sqrt(Math.max(e2.val, 1e-9));
  return vectors.map((_, i) => [e1.vec[i] * s1, e2.vec[i] * s2] as [number, number]);
}

/** Project the embedded concepts to the shared 2D atlas (PCA), persist x/y. */
export const projectAtlas = internalAction({
  args: {},
  handler: async (ctx): Promise<{ projected: number }> => {
    const rows = await ctx.runQuery(internal.concepts._allEmbeddings, {});
    if (rows.length === 0) return { projected: 0 };
    const coords = pca2d(rows.map((r) => r.embedding));
    const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const sx = maxX - minX || 1, sy = maxY - minY || 1;
    const out = rows.map((r, i) => ({
      id: r.id as Id<"knowledgeNodes">,
      x: 4 + ((coords[i][0] - minX) / sx) * 92,
      y: 4 + ((coords[i][1] - minY) / sy) * 92,
    }));
    for (let i = 0; i < out.length; i += 100) {
      await ctx.runMutation(internal.concepts._patchPositions, { rows: out.slice(i, i + 100) });
    }
    return { projected: out.length };
  },
});

/** Precompute the atlas edges (explicit cross-domain connections + the
 *  strongest cross-domain embedding bridges) and store them in `conceptEdges`,
 *  so the read-time getAtlasEdges query reads a tiny table instead of running
 *  an O(n²) cosine over thousands of embeddings (which exceeds the per-query
 *  budget at prod scale). Reads the heavy embeddings here, in an action's high
 *  limits, never in a client-facing query. */
export const computeEdges = internalAction({
  args: {},
  handler: async (ctx): Promise<{ edges: number }> => {
    // Read light concept meta + the vectors (from the side table) in SEPARATE
    // queries — each stays under the per-query read limit — then merge here in
    // the action's high limits.
    const [meta, vectors, conns, treeEdges, storyEdges] = await Promise.all([
      ctx.runQuery(internal.concepts._conceptMetaForEdges, {}),
      ctx.runQuery(internal.concepts._allEmbeddings, {}),
      ctx.runQuery(internal.concepts._crossDomainConns, {}),
      ctx.runQuery(internal.concepts._treeEdgePairs, {}),
      ctx.runQuery(internal.concepts._storyEdgePairs, {}),
    ]);
    const vecById = new Map(vectors.map((v) => [v.id as string, v.embedding]));
    const concepts = meta
      .map((m) => {
        const embedding = vecById.get(m.id as string);
        return embedding ? { ...m, embedding } : null;
      })
      .filter(Boolean) as { nodeKey: string; domain: string; refCount: number; normalizedLabel: string; embedding: number[] }[];
    // Cross-domain bridges + explicit connections (the atlas VIEW's edges) …
    // Suppress a cosine bridge/nn only where a STORY bridge already renders that
    // pair — never for a plain dependency pair (that would drop the only atlas
    // link shown for it; tree pairs are handled separately below).
    const storyPairs = new Set(storyEdges.map((e) => canonicalPairKey(e.fromKey, e.toKey)));
    const edges = buildEdges(concepts, conns, storyPairs);
    // … plus a per-node associative neighborhood (top-K cosine, ANY domain),
    // excluding pairs already joined by the tree lattice so we don't duplicate
    // prereqs as "nn". These surface in the NodeDrawer's "all" toggle (and the
    // per-node sky bucket), NOT on the atlas view (getAtlasEdges filters them out).
    const treePairs = new Set(treeEdges.map((e) => canonicalPairKey(e.fromKey, e.toKey)));
    edges.push(...buildNeighborEdges(concepts, treePairs, NN_NEIGHBORS_K, storyPairs));
    await ctx.runMutation(internal.concepts._clearEdges, {});
    for (let i = 0; i < edges.length; i += 200) {
      await ctx.runMutation(internal.concepts._insertEdges, { rows: edges.slice(i, i + 200) });
    }
    return { edges: edges.length };
  },
});

/** One-shot: rebuild registry → embed → project → edges. Returns a summary. */
export const rebuildAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ registry: { total: number; bySource: Record<string, number> }; embedded: number; projected: number; edges: number }> => {
    const registry = await ctx.runAction(internal.concepts.rebuildRegistry, {});
    const { embedded } = await ctx.runAction(internal.conceptAtlas.embedConcepts, {});
    const { projected } = await ctx.runAction(internal.conceptAtlas.projectAtlas, {});
    const { edges } = await ctx.runAction(internal.conceptAtlas.computeEdges, {});
    return { registry, embedded, projected, edges };
  },
});
