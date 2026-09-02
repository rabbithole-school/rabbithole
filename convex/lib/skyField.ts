/** BFS hop-distance tier over an UNDIRECTED view of the buildsOn graph, from the
 *  scholar's touched set. tier 0 = touched; 1 = 1 hop; 2 = 2–3 hops; 3 = 4+ hops
 *  OR unreachable. (Undirected: a concept is "near" whether it's a prereq behind
 *  or an unlock ahead of something touched.) */
export function hopTiers(
  touched: Iterable<string>,
  edges: ReadonlyArray<{ s: string; t: string }>,
  nodeIds: Iterable<string>,
): Map<string, number> {
  const ids = [...nodeIds];
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);

  for (const { s, t } of edges) {
    const from = adjacency.get(s) ?? [];
    const to = adjacency.get(t) ?? [];
    from.push(t);
    to.push(s);
    adjacency.set(s, from);
    adjacency.set(t, to);
  }

  const distances = new Map<string, number>();
  const queue: string[] = [];
  for (const id of touched) {
    if (distances.has(id)) continue;
    distances.set(id, 0);
    queue.push(id);
    if (!adjacency.has(id)) adjacency.set(id, []);
  }

  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const nextDistance = (distances.get(cur) ?? 0) + 1;
    for (const next of adjacency.get(cur) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, nextDistance);
      queue.push(next);
    }
  }

  const tiers = new Map<string, number>();
  for (const id of ids) {
    const distance = distances.get(id);
    if (distance === 0) tiers.set(id, 0);
    else if (distance === 1) tiers.set(id, 1);
    else if (distance === 2 || distance === 3) tiers.set(id, 2);
    else tiers.set(id, 3);
  }
  return tiers;
}
