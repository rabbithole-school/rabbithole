/**
 * Dependency-free edge ontology helpers shared by Convex, web, and native.
 *
 * `kind` remains the physical column for backward-compatible hot-path reads.
 * These helpers provide the semantic layer on top: relation (dependency vs.
 * bridge), default method for legacy rows, and corpus-vs-cache ownership.
 */

export const DEPENDENCY_KINDS = ["buildsOn", "buildsTowards", "requires"] as const;
export const ASSOCIATIVE_KINDS = ["bridge", "explicit", "nn"] as const;
// INFERENCE-ONLY kinds: directional like a dependency (arrows OK when rendered),
// but structurally INVISIBLE to frontier gating and prereq recommendations.
// `implies` is consumed ONLY by placement inference and implicit-credit
// propagation — it never gates access and is never surfaced as a prerequisite.
// Kept OUT of DEPENDENCY_KINDS on purpose: DEPENDENCY_KINDS is the set that
// ORDERS learning, and callers that gate/recommend key off `kind === "buildsOn"`
// (or DEPENDENCY_KINDS) — adding `implies` there would leak it into gating.
export const INFERENCE_KINDS = ["implies"] as const;

export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
export type AssociativeKind = (typeof ASSOCIATIVE_KINDS)[number];
export type InferenceKind = (typeof INFERENCE_KINDS)[number];
export type EdgeKind = DependencyKind | AssociativeKind | InferenceKind;
export type EdgeRelation = "dependency" | "bridge";
export type EdgeMethod =
  | "curated"
  | "generated"
  | "embedding"
  | "nn"
  | "observed";

const DEPENDENCY_SET = new Set<string>(DEPENDENCY_KINDS);
const ASSOCIATIVE_SET = new Set<string>(ASSOCIATIVE_KINDS);
const INFERENCE_SET = new Set<string>(INFERENCE_KINDS);

/** Total classification: throws on unknown kind instead of silently bucketing.
 *  Inference kinds render as directional ("dependency" relation, arrows), but
 *  note this is a RENDER classification only — access gating keys off
 *  `kind === "buildsOn"`, never off `relationOf`, so an `implies` edge is still
 *  invisible to the frontier gate. */
export function relationOf(kind: string): EdgeRelation {
  if (DEPENDENCY_SET.has(kind)) return "dependency";
  if (INFERENCE_SET.has(kind)) return "dependency";
  if (ASSOCIATIVE_SET.has(kind)) return "bridge";
  throw new Error(`Unknown knowledge edge kind: ${kind}`);
}

/** Default method for legacy rows that predate the `method` column. */
export function methodOf(edge: { kind: string; method?: string }): string {
  if (edge.method) return edge.method;
  if (DEPENDENCY_SET.has(edge.kind)) return "curated";
  if (INFERENCE_SET.has(edge.kind)) return "curated"; // seed-authored corpus
  if (edge.kind === "bridge") return "embedding";
  if (edge.kind === "explicit") return "observed";
  if (edge.kind === "nn") return "nn";
  throw new Error(`Unknown knowledge edge kind: ${edge.kind}`);
}

/** CORPUS vs. CACHE: durable edges may never be deleted by pipelines. */
export function isDurableEdge(edge: { method?: string; story?: unknown }): boolean {
  return (
    edge.story !== undefined ||
    edge.method === "curated" ||
    edge.method === "generated"
  );
}
