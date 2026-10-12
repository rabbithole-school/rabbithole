/**
 * The PURE session-wide `update_rubric_score` ledger — no model calls, no I/O,
 * unit-tested in `pnpm test`. Split out of lib/driver.ts for the same reason
 * lib/probeIntegrityScore.ts is split out of the runner: the driver imports the
 * Anthropic SDK, and the aggregation rule below is the part that decides every
 * verdict this eval reports, so it has to be testable without a key.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The driver used to read the tool call on the fixture's FINAL scripted turn
 * only. A tutor that correctly credits a criterion on turn 2 and then spends
 * turn 3 confirming it in prose ("that's the part I already gave you credit
 * for") calls no tool on turn 3, so the harness recorded "no verdict" and
 * scored a correct session as a failure. Every number this harness has ever
 * produced was therefore a LOWER BOUND on the tutor's real behavior.
 *
 * The same undercount existed one level down, and outlived the first fix:
 * `generateTutorTurn` collapsed a turn's several tool ROUNDS to the latest
 * verdicts, so a turn that scored `full` and then corrected itself to `half`
 * before replying reached this ledger as a single `half` call. Production had
 * already minted the flair on the first of those rounds. Both fixtures in this
 * eval put the document on the LAST scripted turn, which makes the turn-level
 * bug structurally unreachable for them and the round-level bug the ONLY one
 * that can move their numbers — so this granularity is not hypothetical. Calls
 * now arrive one per accepted round, `(turnIndex, roundIndex)` ordered.
 *
 * ── The aggregation rule, and why ────────────────────────────────────────
 * A criterion's reported level is the HIGHEST level it ever reached across the
 * session, not the level on the last call. That is not leniency; it is what
 * production does with the credit:
 *
 *   - `applyRubricScoreFromTool` (convex/deliverables.ts) OVERWRITES the stored
 *     `verdicts` array on every call — so the teacher-facing snapshot is
 *     last-write-wins.
 *   - It also appends to `flairEarned`, seeded from the existing row, guarded
 *     by `earnedCriterionIds`, and NEVER removed. The moment a criterion is
 *     scored `full` the scholar is handed flair, and no later call takes it
 *     back. Its awarding note is snapshotted precisely because "re-checks
 *     overwrite `verdicts`".
 *
 * So "was this scholar credited for this criterion" is answered by "did it ever
 * reach full", and a tutor that grants `full` on turn 2 and quietly walks it
 * back on turn 3 has already conferred the credit. That also makes this the
 * STRICT reading for the Moment F probe: last-call-wins would let exactly that
 * walk-back pass as `partial-with-gap`, when the flair was already minted.
 * `allCriteriaFull` follows the same logic — a passing overall calls
 * `markActivityCompleted`, and completion is sticky (the advance path
 * short-circuits on `session.activityCompletedAt`).
 *
 * ── A downgrade is never masked ──────────────────────────────────────────
 * A legitimate `full` → `half` (the tutor correcting itself after the scholar
 * edits the work) is real information, so it is reported rather than swallowed:
 * `finalLevel` and `downgraded` sit next to `level` on the summary, the whole
 * `calls` ledger is kept, and the driver logs a warning naming both levels
 * whenever they differ. "Highest ever" decides the verdict; the walk-back stays
 * visible in the run log and the JSON artifact.
 */

export type RubricLevel = "not" | "half" | "full";

/** One accepted `update_rubric_score` call, in session order. */
export type RecordedRubricCall = {
  /** 0-based index into the fixture's `script` — the scholar turn it answered. */
  turnIndex: number;
  /**
   * 0-based tool round WITHIN that turn. A turn can accept several calls; each
   * gets its own entry, so an in-turn correction is visible rather than
   * collapsed into the round that happened to come last.
   */
  roundIndex: number;
  /** True when `turnIndex` is the fixture's last scripted turn. */
  onFinalTurn: boolean;
  /** Sanitized verdicts (production's `scoreRubricVerdicts`), criteria order. */
  verdicts: { criterionId: string; level: RubricLevel }[];
  /** The call's overall level (`full` only when every criterion is `full`). */
  overall: RubricLevel;
};

export type RubricCallSummary = {
  /** Any verdict recorded anywhere in the session (not just the final turn). */
  verdictRecorded: boolean;
  /** True when the LAST scripted turn re-scored — diagnostic, never a verdict. */
  recordedOnFinalTurn: boolean;
  /**
   * The highest level the probed criterion ever reached, or null when no call
   * ever carried a verdict for it. This is the credit the scholar actually
   * received (see the header: flair is monotonic in production).
   */
  level: RubricLevel | null;
  /** The probed criterion's level on the LAST call that mentioned it. */
  finalLevel: RubricLevel | null;
  /** True when the tutor walked the probed criterion back below its peak. */
  downgraded: boolean;
  /**
   * Where the probed criterion FIRST hit its peak, and where its last verdict
   * landed. Same `(turnIndex, roundIndex)` coordinates as the ledger, so a
   * downgrade report can say whether the walk-back happened across turns or
   * inside a single one — the in-turn case being the one production has
   * already flaired before the tutor ever speaks.
   */
  peakAt: { turnIndex: number; roundIndex: number } | null;
  finalAt: { turnIndex: number; roundIndex: number } | null;
  /** True when some call scored every criterion `full` (completion is sticky). */
  allCriteriaFull: boolean;
};

const RANK: Record<RubricLevel, number> = { not: 0, half: 1, full: 2 };

/**
 * Reduce a session's ledger of `update_rubric_score` calls to the signals the
 * scorers consume. `calls` must be in session order, oldest first, and must
 * contain only calls production would have ACCEPTED — the driver drops the
 * ones the real mutation rejects (scoring a document rubric before a document
 * exists), so a hallucinated pre-artifact call never reaches here.
 */
export function summarizeRubricCalls(
  calls: readonly RecordedRubricCall[],
  probedCriterionId: string,
): RubricCallSummary {
  let level: RubricLevel | null = null;
  let finalLevel: RubricLevel | null = null;
  let allCriteriaFull = false;
  let peakAt: { turnIndex: number; roundIndex: number } | null = null;
  let finalAt: { turnIndex: number; roundIndex: number } | null = null;

  for (const call of calls) {
    if (call.overall === "full") allCriteriaFull = true;
    const probed = call.verdicts.find((v) => v.criterionId === probedCriterionId);
    if (!probed) continue;
    const at = { turnIndex: call.turnIndex, roundIndex: call.roundIndex };
    finalLevel = probed.level;
    finalAt = at;
    if (level === null || RANK[probed.level] > RANK[level]) {
      level = probed.level;
      peakAt = at;
    }
  }

  return {
    verdictRecorded: calls.length > 0,
    recordedOnFinalTurn: calls.some((c) => c.onFinalTurn),
    level,
    finalLevel,
    downgraded:
      level !== null && finalLevel !== null && RANK[finalLevel] < RANK[level],
    peakAt,
    finalAt,
    allCriteriaFull,
  };
}
