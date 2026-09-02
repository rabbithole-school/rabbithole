// Single source of truth for scholar reading levels.
//
// ⚠️ WHAT THIS VALUE IS, AND WHAT IT IS NOT
//
// Two different real things share this vocabulary. They are not two
// measurements of one quantity and must not be collapsed:
//
//   • The CONFIRMED level (`users.readingLevel`, appended to
//     `readingLevelHistory` when a teacher sets or accepts it) is a
//     HUMAN-RATIFIED SETTING that the system ACTS ON. It is rendered verbatim
//     into the tutor's READING LEVEL prompt section (`sessionHelpers`), and
//     `pre-reader` switches the tutor to a K register with voice-first UI
//     defaults. A teacher owns it, and "the level we adapt reading TO" is a
//     legitimate reading construct.
//
//   • The COMPUTED estimate (`users.readingLevelSuggestion`) is current
//     evidence, not a setting. It is WRITING-DERIVED: every input to
//     `readingLevelAnalysis` is the child's own PRODUCTION — typed tutor-chat
//     messages plus OCR-transcribed handwritten portfolio prose. There is no
//     reception evidence anywhere in it; nothing measures what the child can
//     READ. Describe it to humans as an estimate from the scholar's own
//     writing, never as a reading measurement.
//
// The estimate is NOT a Lexile measure, NOT a normed assessment, and NOT a
// screener result. It is one model's judgement over a sample of a child's
// composed work. The stored FIELD names keep the "reading" word for now — a
// rename is a migration with blast radius well beyond the naming problem — so
// this comment is the record of what the value actually is.
//
// A reading level is a US grade band stored as a plain string. Grades 1–12
// carry **0.1 granularity** (a tenth-of-a-grade, e.g. "7.3" = about three-tenths
// into grade 7) so a teacher — and the AI estimator — can place a scholar more
// precisely than a whole grade. The canonical forms are:
//
//   "K"              kindergarten
//   "1" … "12"       a whole grade (note: "7", never "7.0")
//   "1.1" … "12.9"   a tenth into a grade
//   "college"        college-level
//
// Consumed by the teacher setter/validator (`scholars.updateReadingLevel`), the
// writing-derived estimator (`readingLevelAnalysis`), and rendered verbatim into
// the tutor's READING LEVEL prompt section (`sessionHelpers`) — so any string
// here must read naturally after "the scholar's reading level is set to …".
//
// Alongside the grade bands there is one non-grade TIER — `pre-reader` — for a
// scholar who can't decode text yet (age ~4–6). It is deliberately NOT a member
// of VALID_READING_LEVELS (which enumerates the K→college grade bands and feeds
// grade dropdowns + the AI estimator's normalization): pre-reader drives a
// dedicated tutor register + voice-first UI defaults rather than a vocabulary
// tweak. A teacher may still *assign* it, so `isValidReadingLevel` accepts it.

/** Every valid reading level, in ascending order (K → 12.9 → college). */
export const VALID_READING_LEVELS: string[] = (() => {
  const levels: string[] = ["K"];
  for (let grade = 1; grade <= 12; grade++) {
    levels.push(String(grade));
    for (let tenth = 1; tenth <= 9; tenth++) {
      levels.push(`${grade}.${tenth}`);
    }
  }
  levels.push("college");
  return levels;
})();

const VALID_SET = new Set(VALID_READING_LEVELS);

/**
 * The pre-reader tier: a scholar (age ~4–6) whose reasoning runs years ahead of
 * her decoding. A recognized reading-level value that flows through the existing
 * `resolveReadingLevel` machinery (so a per-session `readingLevelOverride` lets a
 * teacher test-drive it), but a distinct *tier* — not a grade band. It activates
 * the K tutor register (`buildPreReaderSection`) and voice-first UI defaults.
 */
export const PRE_READER_LEVEL = "pre-reader";

/** Is the resolved reading level the pre-reader tier? */
export function isPreReader(level: string | null | undefined): boolean {
  return level === PRE_READER_LEVEL;
}

/**
 * Is `level` a value a teacher may assign — one of the canonical grade bands OR
 * the pre-reader tier?
 */
export function isValidReadingLevel(level: string): boolean {
  return VALID_SET.has(level) || level === PRE_READER_LEVEL;
}

/**
 * Coerce a free-form grade string (typically an LLM's answer) to a canonical
 * reading level, or `null` if it can't be mapped.
 *
 * Accepts "K"/"kindergarten", "college"/"university", and grade numbers with or
 * without a tenth ("7", "7.0", "7.3", "Grade 7.3", "7th"). The first decimal
 * digit is kept (so "7.35" → "7.3"); a ".0" tenth collapses to the whole grade
 * ("7.0" → "7"). Grades below 1 map to "K", above 12 to "college".
 */
export function normalizeReadingLevel(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === "k" || s.startsWith("kinder")) return "K";
  if (s.includes("college") || s.includes("univ")) return "college";

  const m = s.match(/(\d+)(?:\.(\d))?/);
  if (!m) return null;
  const grade = parseInt(m[1], 10);
  if (Number.isNaN(grade)) return null;
  if (grade < 1) return "K";
  if (grade > 12) return "college";

  const tenth = m[2] ? parseInt(m[2], 10) : 0;
  const canonical = tenth > 0 ? `${grade}.${tenth}` : String(grade);
  return isValidReadingLevel(canonical) ? canonical : null;
}

/**
 * How stale a stored writing-derived estimate may get before a writer refreshes
 * its timestamp even though the value has not moved.
 *
 * The observer runs after EVERY tutor session, and patching a `users` doc
 * invalidates every live subscription on it, so an unconditional stamp on that
 * path is real write amplification. This bound keeps a displayed age honest to
 * within a school half-day while collapsing a busy scholar's many sessions into
 * at most a couple of writes.
 */
export const ESTIMATE_REFRESH_MS = 6 * 60 * 60 * 1000;

/** What a writer should do with a freshly computed writing-derived estimate. */
export interface EstimateWriteDecision {
  /**
   * `"stored"`    — a new/changed disagreement to show the teacher.
   * `"cleared"`   — evidence now AGREES with the confirmed level, so the
   *                 previously stored disagreement is superseded.
   * `"refreshed"` — same conclusion as last time, but the stamp was stale
   *                 enough that its age was about to mislead.
   * `"skipped"`   — nothing to say and the stamp is still fresh; do not write.
   */
  action: "stored" | "cleared" | "refreshed" | "skipped";
  /** The value to patch into `users.readingLevelSuggestion`. */
  nextSuggestion: string | undefined;
}

/**
 * Decide how to record a writing-derived grade-level estimate.
 *
 * Pure, so the honesty properties are testable without a database:
 *
 *  • AGREEMENT IS RECORDED. The old observer path wrote only on disagreement, so
 *    once later evidence caught up with the teacher's setting nothing happened —
 *    and a weeks-old disagreement kept sitting on the profile looking current.
 *    Agreement now clears the superseded suggestion. A displayed disagreement is
 *    therefore always current evidence.
 *
 *  • AGE IS NEVER SILENTLY STALE. Any write stamps `computedAt`; an unchanged
 *    conclusion still refreshes it once the stamp passes `ESTIMATE_REFRESH_MS`.
 *
 *  • THE HOT PATH IS BOUNDED. Same conclusion inside the window is a no-op.
 */
export function decideEstimateWrite(args: {
  /** The teacher-ratified level the system acts on, or null if unset. */
  confirmed: string | null;
  /** The currently stored pending estimate, or null if none. */
  pending: string | null;
  /** When the stored estimate was computed, or null if never stamped. */
  pendingAt: number | null;
  /** The freshly computed writing-derived estimate. */
  estimate: string;
  now: number;
  /** Skip the freshness guard — for an explicit, teacher-initiated analysis. */
  force?: boolean;
}): EstimateWriteDecision {
  const agrees = args.confirmed !== null && args.confirmed === args.estimate;
  const nextSuggestion = agrees ? undefined : args.estimate;
  const valueUnchanged = (nextSuggestion ?? null) === args.pending;
  const stampFresh =
    args.pendingAt !== null && args.now - args.pendingAt < ESTIMATE_REFRESH_MS;

  if (valueUnchanged && stampFresh && !args.force) {
    return { action: "skipped", nextSuggestion };
  }
  if (valueUnchanged) return { action: "refreshed", nextSuggestion };
  return { action: agrees ? "cleared" : "stored", nextSuggestion };
}
