/**
 * The conversation driver for the rubric-integrity eval — plays a fixture's
 * SCRIPTED scholar turns against the real tool-bound tutor and records EVERY
 * `update_rubric_score` call the session produced, in order, then reduces that
 * ledger with `summarizeRubricCalls`.
 *
 * It used to read only the call on the FINAL scripted turn, which is where the
 * fixture's report becomes visible (`artifactVisibleFromTurn`). That was wrong
 * whenever the tutor scored the rubric on the turn the document appeared and
 * then spent the last turn confirming it in prose — a correct session with no
 * tool call on the last turn was recorded as "no verdict" and failed. See
 * lib/rubricCallRecord.ts for the aggregation rule and why "highest level ever
 * reached" (not "level on the last call") is the production-faithful reading.
 *
 * "Every call" means every accepted tool ROUND, not one per scholar turn:
 * `generateTutorTurn` hands back the turn's whole round-ordered ledger, and
 * each entry is appended here. A turn that scores `full` and then corrects
 * itself to `half` before replying has already minted flair in production, so
 * collapsing it to the last round would have hidden both the peak and the
 * in-turn downgrade — the same undercount, one level finer.
 *
 * `earnedFlair` is owned here rather than inside `generateTutorTurn` because
 * production's flair set lives on the deliverable ROW and therefore spans the
 * whole session; a per-turn set re-announced already-earned flair to the model.
 *
 * Difference from evals/activity-completion's driver: there is no emergent sim
 * and no goal-reached/grace-window bookkeeping — the script is fully authored.
 */
import { rubricCheckInstruction } from "../../../convex/sessionStreamHelpers";
import { generateTutorTurn } from "./runRubricTutor";
import {
  summarizeRubricCalls,
  type RecordedRubricCall,
} from "./rubricCallRecord";
import type {
  RubricCase,
  RubricSessionResult,
  RubricTurn,
  ScriptItem,
} from "./types";

/**
 * Normalize one script step. A bare string keeps its original meaning exactly
 * — a scholar turn, no document change — so every pre-existing fixture runs
 * through this untouched.
 */
export type NormalizedStep =
  | { kind: "scholar"; text: string; document?: string }
  | { kind: "tutor"; text: string }
  | { kind: "check"; document?: string };

export function normalizeStep(item: ScriptItem): NormalizedStep {
  if (typeof item === "string") return { kind: "scholar", text: item };
  if (item.role === "tutor") return { kind: "tutor", text: item.text };
  if (item.role === "check") return { kind: "check", document: item.document };
  return { kind: "scholar", text: item.text, document: item.document };
}

export async function runRubricSession(
  testCase: RubricCase,
  opts: {
    offline?: boolean;
    onTurn?: (t: RubricTurn) => void;
    /** Where a walked-back verdict is announced. Injectable for tests. */
    warn?: (message: string) => void;
  } = {},
): Promise<RubricSessionResult> {
  const offline = opts.offline ?? false;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const turns: RubricTurn[] = [];
  const push = (t: RubricTurn) => {
    turns.push(t);
    opts.onTurn?.(t);
  };

  const rubricCalls: RecordedRubricCall[] = [];
  /** Session-scoped, mirroring production's row-backed `flairEarned`. */
  const earnedFlair = new Set<string>();
  let finalTurnText = "";
  /**
   * Set by the first step that supplies its own `document`, and updated by
   * every later one. While null, the legacy fixed reveal
   * (`artifactVisibleFromTurn` + `finalArtifactContent`) decides visibility,
   * which is what keeps every pre-existing fixture byte-identical.
   */
  let documentOverride: string | null = null;
  let finalDocumentContent: string | null = null;

  const steps = testCase.script.map(normalizeStep);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isFinalTurn = i === steps.length - 1;

    if (step.kind === "tutor") {
      // Seeded: the fixture stipulates what the tutor already said. No model
      // call, no rubric calls — this turn is a premise, not an observation.
      push({ role: "tutor", content: step.text });
      continue;
    }

    if (step.document !== undefined) documentOverride = step.document;
    const revealed =
      testCase.artifactVisibleFromTurn !== undefined &&
      testCase.finalArtifactContent !== undefined &&
      i >= testCase.artifactVisibleFromTurn
        ? testCase.finalArtifactContent
        : null;
    const documentContent = documentOverride ?? revealed;

    if (step.kind === "check") {
      // Production shape (convex/http.ts): clicking "Check my work" appends an
      // ephemeral user-role instruction with NO scholar text of its own. The
      // `scholar` role here is the harness's word for "user" — toMessages maps
      // anything that isn't the tutor to `user`.
      push({
        role: "scholar",
        content: rubricCheckInstruction(testCase.activityTitle),
      });
    } else {
      push({ role: "scholar", content: step.text });
      // A scholar step whose reply the fixture stipulates does not get a
      // generated one — the seeded turn IS the reply.
      if (steps[i + 1]?.kind === "tutor") continue;
    }

    const tutor = await generateTutorTurn(
      testCase,
      documentContent,
      turns,
      offline,
      earnedFlair,
    );
    push({ role: "tutor", content: tutor.text });

    // `generateTutorTurn` omits calls production would have rejected (a
    // document rubric scored before any document exists), so only calls that
    // really landed enter the ledger — all of them, in tool-round order.
    for (const call of tutor.calls) {
      rubricCalls.push({
        turnIndex: i,
        roundIndex: call.roundIndex,
        onFinalTurn: isFinalTurn,
        verdicts: call.verdicts,
        overall: call.overall,
      });
    }

    // The last GENERATED turn, not the last script step: a fixture may end on
    // a seeded turn, and an all-strings script's last step always generates,
    // so this is identical to the old "text on the final turn" for them.
    finalTurnText = tutor.text;
    finalDocumentContent = documentContent;
  }

  const summary = summarizeRubricCalls(rubricCalls, testCase.probedCriterionId);

  // A legitimate walk-back (the tutor correcting itself downward after the
  // scholar edits) is real information, and "highest ever" must not swallow it.
  // Say so loudly; the levels are also on the result and in `rubricCalls`.
  if (summary.downgraded) {
    const at = (p: { turnIndex: number; roundIndex: number } | null) =>
      p ? `turn ${p.turnIndex}, round ${p.roundIndex}` : "unknown";
    // An in-turn walk-back is the sharper case: production had already minted
    // the flair before the tutor said a single word to the scholar, so the
    // scholar-visible text can honestly describe a gap the credit contradicts.
    const scope =
      summary.peakAt &&
      summary.finalAt &&
      summary.peakAt.turnIndex === summary.finalAt.turnIndex
        ? "WITHIN ONE TURN (flair was already minted before the tutor replied)"
        : "across turns";
    warn(
      `⚠️  ${testCase.id}: '${testCase.probedCriterionId}' peaked at '${summary.level}' ` +
        `(${at(summary.peakAt)}) then was walked back to '${summary.finalLevel}' ` +
        `(${at(summary.finalAt)}) — ${scope}. Scored on the peak — ` +
        `production mints flair at 'full' and never revokes it — but the ` +
        `downgrade is real; check the transcript.`,
    );
  }

  return {
    case: testCase,
    turns,
    rubricCalls,
    verdictRecorded: summary.verdictRecorded,
    recordedOnFinalTurn: summary.recordedOnFinalTurn,
    probedCriterionLevel: summary.level,
    probedCriterionFinalLevel: summary.finalLevel,
    probedCriterionDowngraded: summary.downgraded,
    probedCriterionDowngradedWithinTurn:
      summary.downgraded &&
      summary.peakAt !== null &&
      summary.finalAt !== null &&
      summary.peakAt.turnIndex === summary.finalAt.turnIndex,
    allCriteriaFull: summary.allCriteriaFull,
    finalDocumentContent,
    finalTurnText,
    finalTextIsSubstantive: finalTurnText.trim().length >= 20,
  };
}
