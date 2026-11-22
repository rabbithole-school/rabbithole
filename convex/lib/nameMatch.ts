// Strict name matching shared by the agent tools and the mutations behind
// them. Deliberately import-free: convex/assignments.ts uses it, and
// assignments.ts is reachable from convex/schema.ts, whose bundle must be a
// single module. Importing it via lib/scholarReadTools (which lazy-loads the
// Anthropic SDK with a dynamic import) split the schema bundle and failed the
// production deploy (NoImportModuleInSchema); see schemaBundle.test.ts.

/**
 * Strict name → scholar matcher for DESTRUCTIVE roster writes.
 *
 * The read-path `resolveScholarByName` is first-substring-wins, which is fine
 * for "show me Kai's mastery" (a wrong guess is read-only) but unsafe for
 * `set/add_assignment_scholars`, where a silent mis-match adds/removes the
 * WRONG child from a cohort. This matcher is the strict variant the batch
 * roster resolvers use:
 *
 *  1. Prefer a UNIQUE exact case-insensitive full-name match. Duplicate exact
 *     display names remain ambiguous; a sensitive read or roster write must
 *     never guess between two people with the same name.
 *  2. Otherwise allow a partial (substring) match ONLY when exactly one
 *     candidate matches.
 *  3. If a partial query matches MULTIPLE candidates, refuse with the list
 *     of colliding names rather than silently picking the first.
 *
 * Pure (takes the candidate list, no ctx) so both batch resolvers — the aide
 * (lib/aideTools.ts) and the MCP path (convex/mcp.ts) — share one definition.
 * The query is trimmed/lowercased by the caller-facing wrappers; here we trim
 * defensively too.
 */
export type ScholarNameMatch<S> =
  | { kind: "match"; scholar: S }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: S[] };

/**
 * Strict {name}-keyed matcher core. Generalizes the exact-preferred /
 * ambiguity-refusing logic over an arbitrary `normalize` step so the same
 * three-way verdict (match / none / ambiguous) can serve both scholar+group
 * names (identity normalize) and unit TITLES (dash + punctuation folding —
 * see `normalizeUnitTitle` in aideTools.ts). Keeping one core here means the
 * unit resolver mirrors the scholar resolver instead of forking it.
 *
 * `normalize` is applied to BOTH the query and every candidate name; an
 * empty normalized query refuses (never `includes("")`-matches everything).
 */
export function matchByName<S extends { name: string }>(
  query: string,
  rows: S[],
  normalize: (s: string) => string = (s) => s.trim().toLowerCase(),
): ScholarNameMatch<S> {
  const q = normalize(query);
  if (!q) return { kind: "none" };
  const exact = rows.filter((s) => normalize(s.name) === q);
  if (exact.length === 1) return { kind: "match", scholar: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  const partial = rows.filter((s) => normalize(s.name).includes(q));
  if (partial.length === 0) return { kind: "none" };
  if (partial.length === 1) return { kind: "match", scholar: partial[0] };
  return { kind: "ambiguous", candidates: partial };
}
