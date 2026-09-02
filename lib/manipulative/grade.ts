/**
 * Server/client-shared grading for a manipulative rendered as a practiceItem.
 *
 * The item stores its `ManipulativeSpec` (JSON); on Done the client submits the
 * locked-in runtime state (JSON). Grading re-runs the pure control-of-error
 * predicate (`isSolved`) AUTHORITATIVELY server-side — the client's own
 * self-check chip is only optimistic UI and is never trusted for the grade.
 *
 * Framework-free + total: malformed or kind-mismatched JSON grades as
 * INCORRECT and never throws (a forged/garbage submission can't crash the
 * grader or sneak a pass).
 */

import { isSolved } from "./logic";
import type { ManipulativeSpec } from "./types";
import { parseManipulativeSpec } from "./types";
import { redactTaskForClient } from "../geomap/types";
import type { RegionResolver } from "../geomap/grade";

/** Parse a stored spec JSON to a `ManipulativeSpec`, or null if unusable.
 *  Re-exported from `types.ts` (the single, vendorable home) so existing
 *  `grade.ts` importers keep working while every surface shares one parser. */
export { parseManipulativeSpec };

/**
 * Grade one manipulative submission. `specJson` is the item's stored spec;
 * `submittedStateJson` is the client's `JSON.stringify(state)` from Done.
 *
 * `resolveRegion` is threaded through to `isSolved` for the kinds that need it
 * (geoLocate `region` tasks resolve a registry key server-side). Optional and
 * backward-compatible: every existing kind ignores it, and a geoLocate
 * `locate`/`pinSet` task grades without one.
 */
export function gradeManipulativeSubmission(
  specJson: string | undefined | null,
  submittedStateJson: string,
  resolveRegion?: RegionResolver,
): { correct: boolean } {
  const spec = parseManipulativeSpec(specJson);
  if (!spec) return { correct: false };
  let state: unknown;
  try {
    state = JSON.parse(submittedStateJson) as unknown;
  } catch {
    return { correct: false };
  }
  // TOTAL by contract: a kind's predicate may assume its own state shape (e.g.
  // partitionSolved reads `state.discs[...]`), so a valid-JSON-but-wrong-shape
  // submission can throw. A throw is never a pass — swallow it as incorrect so
  // a forged/garbage payload can neither crash the grader nor sneak through.
  try {
    return { correct: isSolved(spec, state, resolveRegion) };
  } catch {
    return { correct: false };
  }
}

/**
 * Redact any answer-bearing fields from a manipulative spec BEFORE it is served
 * to a client with an open graded attempt. Today only `geoLocate` carries an
 * answer inside its spec (the map task's target/region), so this strips that via
 * the geomap contract's `redactTaskForClient`; every other kind's spec has no
 * answer string and passes through byte-for-byte. TOTAL: an unparseable spec is
 * returned unchanged (the renderer, not this seam, decides what to do with
 * garbage; grading is always server-side on the raw doc regardless).
 *
 * Returns the (possibly rewritten) JSON string — the shape the serving path
 * already passes around — so callers stay a one-line wrap.
 */
export function redactManipulativeSpecForClient(
  specJson: string | undefined | null,
): string | undefined | null {
  if (specJson == null) return specJson;
  const spec = parseManipulativeSpec(specJson);
  if (!spec || spec.kind !== "geoLocate") return specJson;
  const redacted: ManipulativeSpec = {
    ...spec,
    map: { ...spec.map, task: redactTaskForClient(spec.map.task) },
  };
  return JSON.stringify(redacted);
}
