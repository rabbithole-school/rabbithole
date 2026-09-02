// Pure (db-free) Concept Atlas edge builder. Shared by the build action
// (conceptAtlas.computeEdges, a "use node" module) and by tests. Kept out of
// concepts.ts so the node action can import it without pulling in Convex
// query/mutation builders. The edges are PRECOMPUTED at build time and stored
// in `knowledgeNodeEdges` (kind bridge/explicit), so the read-time
// getAtlasEdges query never runs this O(n²) cosine over thousands of 512-d
// embeddings (that blew the per-query budget at prod scale).

export const MAX_BRIDGE_NODES = 240; // backbone size for the O(k²) bridge scan
export const MAX_STORED_BRIDGES = 60; // top cross-domain bridges kept
export const MAX_EXPLICIT_EDGES = 200; // cap explicit cross-domain-connection edges

// Associative nearest-neighbor edges — give EVERY placed+embedded node a small
// same-or-cross-domain neighborhood (the cross-domain-only bridge backbone left
// almost every node, and every tree/skill node, with no "sky/associative"
// neighbors at all). Unlike bridges these are NOT capped globally: each node
// gets its own top-K, so the store grows ~linearly (≤ nodes·K after undirected
// dedupe), not O(bridges).
export const NN_NEIGHBORS_K = 4; // top-K nearest neighbors per node
export const MIN_NN_SIMILARITY = 0.25; // floor so garbage neighbors don't ship

function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Canonical (order-independent) key for an undirected node-pair — the identity
 *  used to dedupe nn edges and to test membership against the tree-pair set. */
export function canonicalPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Edges are KEY-based (nodeKey) so the shared knowledgeNodeEdges table can be
// seeded/merged without id resolution — matching the practice lane's convention.
export type EdgeConcept = {
  nodeKey: string; domain: string; refCount: number;
  normalizedLabel: string; embedding: number[];
};
export type AtlasEdge = {
  fromKey: string; toKey: string; kind: string; weight: number;
};

/** Build the atlas edge set: explicit cross-domain connections (resolved from
 *  the observer's crossDomainConnections) + the strongest cross-domain
 *  embedding bridges over the highest-refCount backbone. Pure + bounded. */
export function buildEdges(
  concepts: EdgeConcept[],
  conns: { conceptLabels: string[] }[],
  durablePairs: Set<string> = new Set(),
): AtlasEdge[] {
  const byNorm = new Map(concepts.map((c) => [c.normalizedLabel, c.nodeKey]));
  const edges: AtlasEdge[] = [];

  // explicit cross-domain connections
  outer: for (const cn of conns) {
    const keys = cn.conceptLabels
      .map((l) => byNorm.get(normalizeLabel(l)))
      .filter(Boolean) as string[];
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        if (edges.length >= MAX_EXPLICIT_EDGES) break outer;
        if (durablePairs.has(canonicalPairKey(keys[i], keys[j]))) continue;
        edges.push({ fromKey: keys[i], toKey: keys[j], kind: "explicit", weight: 1 });
      }
  }

  // top cross-domain embedding bridges over the highest-refCount backbone
  const backbone = [...concepts].sort((a, b) => b.refCount - a.refCount).slice(0, MAX_BRIDGE_NODES);
  const pairs: AtlasEdge[] = [];
  for (let i = 0; i < backbone.length; i++)
    for (let j = i + 1; j < backbone.length; j++) {
      if (backbone[i].domain === backbone[j].domain) continue;
      if (durablePairs.has(canonicalPairKey(backbone[i].nodeKey, backbone[j].nodeKey))) continue;
      pairs.push({
        fromKey: backbone[i].nodeKey, toKey: backbone[j].nodeKey, kind: "bridge",
        weight: cosine(backbone[i].embedding, backbone[j].embedding),
      });
    }
  pairs.sort((a, b) => b.weight - a.weight);
  edges.push(...pairs.slice(0, MAX_STORED_BRIDGES));

  return edges;
}

/** Build the associative neighborhood: for EACH concept, its top-K cosine
 *  neighbors in ANY domain (unlike the cross-domain-only bridges) — so every
 *  placed+embedded node, and crucially every tree/skill node, gets a handful of
 *  "sky/associative" links the NodeDrawer's core⟷all toggle can reveal.
 *
 *  Excludes self; excludes any pair already joined by a tree edge (`treePairs`
 *  = canonicalPairKey set over buildsOn/buildsTowards/requires — the prereq
 *  lattice must NOT be duplicated as associative); floors weak links at
 *  MIN_NN_SIMILARITY; dedupes undirected (each pair emitted once, canonical
 *  order, kind:"nn", weight=cosine). Pure + O(n²) — run in the build action,
 *  never in a client query. */
export function buildNeighborEdges(
  concepts: EdgeConcept[],
  treePairs: Set<string>,
  K = NN_NEIGHBORS_K,
  durablePairs: Set<string> = new Set(),
): AtlasEdge[] {
  const n = concepts.length;
  const seen = new Set<string>();
  const edges: AtlasEdge[] = [];

  for (let i = 0; i < n; i++) {
    const ci = concepts[i];
    const sims: { key: string; w: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const cj = concepts[j];
      const pairKey = canonicalPairKey(ci.nodeKey, cj.nodeKey);
      if (treePairs.has(pairKey) || durablePairs.has(pairKey)) continue;
      const w = cosine(ci.embedding, cj.embedding);
      if (w < MIN_NN_SIMILARITY) continue;
      sims.push({ key: cj.nodeKey, w });
    }
    sims.sort((a, b) => b.w - a.w);
    for (const s of sims.slice(0, K)) {
      const pk = canonicalPairKey(ci.nodeKey, s.key);
      if (seen.has(pk)) continue;
      seen.add(pk);
      const [fromKey, toKey] =
        ci.nodeKey < s.key ? [ci.nodeKey, s.key] : [s.key, ci.nodeKey];
      edges.push({ fromKey, toKey, kind: "nn", weight: s.w });
    }
  }
  return edges;
}
