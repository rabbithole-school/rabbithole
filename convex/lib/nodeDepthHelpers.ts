/**
 * Pure helpers for per-scholar node depth readings.
 *
 * No Convex imports — this module is safe to import in unit tests and in
 * any server-side context. The Convex query that calls these lives in
 * convex/nodeDepth.ts.
 *
 * Depth is the Bloom conceptual level (0–5) normalized to 0..1 and rides
 * as the right-arc gauge on the KnowledgeNodeDial.
 *
 * REDACTION CONTRACT:
 *   buildNodeReadings() takes an `isTeacher` flag. When false (scholar /
 *   parent / any non-teacher caller), `hasOpenMisconception` is NEVER set
 *   on any returned reading — the field is structurally absent, not just
 *   undefined. The calling query in nodeDepth.ts enforces the access gate;
 *   this helper enforces the field-level redaction.
 */

// Bloom taxonomy scale used by masteryObservations.masteryLevel.
// Source: review/practice/practice-engine-roadmap.html §5 and schema comment.
export const BLOOM_MAX = 5;

/** Lowercase + collapse-whitespace label normalizer (mirrors atlasEdges.ts). */
export function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Map a raw Bloom level (0–5) to a 0..1 depth value. */
export function bloomToDepth(masteryLevel: number): number {
  return Math.min(1, Math.max(0, masteryLevel / BLOOM_MAX));
}

export type NodeReading = {
  nodeKey: string;
  /** Conceptual depth 0..1 (Bloom / 5). Scholar- and teacher-facing. */
  depth: number;
  /**
   * TEACHER-ONLY. Present (true) when ≥1 current observation for this
   * node is a misconception_signal whose misconceptionStatus is not
   * "addressed" (absent field = "open" per schema). NEVER set for
   * non-teacher callers — use `"hasOpenMisconception" in reading` to
   * distinguish "no flag" from "redacted".
   */
  hasOpenMisconception?: boolean;
};

/** Minimal observation shape needed by buildNodeReadings. */
export type ObsInput = {
  masteryLevel: number;
  evidenceType: string;
  misconceptionStatus?: "open" | "addressed";
};

/**
 * Build per-node depth readings from grouped observation clusters.
 *
 * Pure function — no I/O, safe to call in tests.
 *
 * @param groups   Per-node clusters of non-superseded observations.
 * @param isTeacher Whether the caller has teacher/admin role.
 */
export function buildNodeReadings(
  groups: Array<{ nodeKey: string; observations: ObsInput[] }>,
  isTeacher: boolean,
): NodeReading[] {
  return groups.map(({ nodeKey, observations }) => {
    const maxLevel = Math.max(...observations.map((o) => o.masteryLevel));
    const reading: NodeReading = {
      nodeKey,
      depth: bloomToDepth(maxLevel),
    };

    // ── REDACTION HARD GATE ─────────────────────────────────────────────
    // hasOpenMisconception is TEACHER-ONLY (sensitive: misconception signals
    // are a separate, teacher-side flag, not to be surfaced to the scholar
    // until they can be framed as growth — roadmap §5 redaction boundary).
    // This block must NOT run for non-teacher callers. The field must be
    // structurally absent (never false/null) on a scholar/parent reading.
    if (isTeacher) {
      const hasOpen = observations.some(
        (o) =>
          o.evidenceType === "misconception_signal" &&
          // absent misconceptionStatus == "open" (schema guarantee)
          o.misconceptionStatus !== "addressed",
      );
      if (hasOpen) reading.hasOpenMisconception = true;
    }

    return reading;
  });
}
