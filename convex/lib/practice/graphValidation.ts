/**
 * Seed-time validation for the COMBINED practice knowledge graph (every domain's
 * nodes + edges, including cross-domain edges) — the D4 acyclicity guard.
 *
 * Before D4, each practice domain was a self-contained DAG and per-domain cycle
 * checks were sufficient. D4 lets a child domain's seed declare a `buildsOn`
 * edge whose `fromKey` is a node in ANOTHER domain (a foreign prerequisite —
 * e.g. a fraction skill gating a probability skill). A cycle that closes THROUGH
 * such a cross-domain edge is invisible to per-domain validation, so the rebuild
 * validates the union of every graph here instead. Pure (no ctx) so it can run
 * both at seed time and in unit tests.
 */

export type ValidatableNode = { nodeKey: string; domain: string };
export type ValidatableEdge = { fromKey: string; toKey: string };

export type GraphValidationIssue =
  | {
      kind: "unknown-endpoint";
      edge: ValidatableEdge;
      missing: "from" | "to";
      missingKey: string;
    }
  | { kind: "cycle"; cycle: string[] }
  | { kind: "duplicate-key"; nodeKey: string; domains: string[] };

/**
 * Validate the combined `buildsOn` graph. Returns every issue found (empty =
 * valid):
 *  - `duplicate-key`: a `nodeKey` is declared by more than one node (in the
 *    same domain OR — the dangerous case — across two domains). Cross-domain
 *    frontier resolution (`buildFrontierStateOf` in `practiceSkills.ts`) and
 *    this validator itself assume `nodeKey` is GLOBALLY unique: `known` and the
 *    adjacency map are keyed by `nodeKey` alone, so a collision would silently
 *    merge two distinct skills into one graph node (masking edges/cycles) and
 *    make a foreign-prereq lookup ambiguous. Fail loudly at seed time instead.
 *  - `unknown-endpoint`: an edge references a `nodeKey` no node defines (a typo
 *    or a cross-domain edge pointing at a node that isn't seeded).
 *  - `cycle`: the directed graph (`fromKey → toKey`) is not acyclic; `cycle`
 *    lists the keys on one detected cycle so the error message is legible.
 *
 * Only well-formed edges (both endpoints known) enter cycle detection, so a
 * dangling endpoint is reported without masking a real cycle elsewhere.
 */
export function validateCombinedGraph(
  nodes: readonly ValidatableNode[],
  edges: readonly ValidatableEdge[],
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];

  // Global nodeKey uniqueness across the combined multi-domain set. Collect the
  // distinct domains each key appears in (in first-seen order); any key seen more
  // than once is a duplicate — reported with every domain it collides across.
  const domainsByKey = new Map<string, string[]>();
  for (const n of nodes) {
    const seen = domainsByKey.get(n.nodeKey);
    if (seen === undefined) domainsByKey.set(n.nodeKey, [n.domain]);
    else if (!seen.includes(n.domain)) seen.push(n.domain);
  }
  const dupCount = new Map<string, number>();
  for (const n of nodes) dupCount.set(n.nodeKey, (dupCount.get(n.nodeKey) ?? 0) + 1);
  for (const [nodeKey, count] of dupCount) {
    if (count > 1) issues.push({ kind: "duplicate-key", nodeKey, domains: domainsByKey.get(nodeKey)! });
  }

  const known = new Set(nodes.map((n) => n.nodeKey));
  const adj = new Map<string, string[]>();
  for (const n of nodes) if (!adj.has(n.nodeKey)) adj.set(n.nodeKey, []);

  for (const e of edges) {
    if (!known.has(e.fromKey)) {
      issues.push({ kind: "unknown-endpoint", edge: e, missing: "from", missingKey: e.fromKey });
    }
    if (!known.has(e.toKey)) {
      issues.push({ kind: "unknown-endpoint", edge: e, missing: "to", missingKey: e.toKey });
    }
    if (known.has(e.fromKey) && known.has(e.toKey)) adj.get(e.fromKey)!.push(e.toKey);
  }

  // Iterative 3-color DFS cycle detection; captures one cycle path for the
  // message. Iterative (explicit stack) so a deep chain can't blow the call
  // stack.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const k of adj.keys()) color.set(k, WHITE);

  let cycle: string[] | null = null;
  for (const root of adj.keys()) {
    if (cycle) break;
    if (color.get(root) !== WHITE) continue;
    // Each frame tracks the node and its next-neighbor index.
    const frames: { node: string; i: number }[] = [{ node: root, i: 0 }];
    color.set(root, GRAY);
    while (frames.length > 0 && !cycle) {
      const frame = frames[frames.length - 1];
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.i < neighbors.length) {
        const v = neighbors[frame.i++];
        const c = color.get(v) ?? WHITE;
        if (c === GRAY) {
          // Found a back-edge: build the cycle from v's frame to the top.
          const idx = frames.findIndex((f) => f.node === v);
          cycle = [...frames.slice(idx).map((f) => f.node), v];
        } else if (c === WHITE) {
          color.set(v, GRAY);
          frames.push({ node: v, i: 0 });
        }
      } else {
        color.set(frame.node, BLACK);
        frames.pop();
      }
    }
  }
  if (cycle) issues.push({ kind: "cycle", cycle });

  return issues;
}

/**
 * Seed-time guard: throw a legible error if the combined graph has any issue,
 * otherwise return. Call BEFORE writing nodes/edges so a bad seed never lands a
 * partial graph.
 */
export function assertCombinedGraphValid(
  nodes: readonly ValidatableNode[],
  edges: readonly ValidatableEdge[],
): void {
  const issues = validateCombinedGraph(nodes, edges);
  if (issues.length === 0) return;
  const lines = issues.map((i) => {
    if (i.kind === "cycle") return `cycle: ${i.cycle.join(" → ")}`;
    if (i.kind === "duplicate-key")
      return `duplicate nodeKey "${i.nodeKey}" declared in ${i.domains.length > 1 ? "domains" : "domain"} ${i.domains.map((d) => `"${d}"`).join(", ")} — nodeKeys must be globally unique across all practice domains`;
    return `unknown ${i.missing} endpoint "${i.missingKey}" on edge ${i.edge.fromKey} → ${i.edge.toKey}`;
  });
  throw new Error(
    `Practice knowledge graph invalid (D4 cross-domain validation):\n  ${lines.join("\n  ")}`,
  );
}
