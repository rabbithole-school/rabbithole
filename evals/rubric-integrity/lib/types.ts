/**
 * Types for the rubric-integrity eval (Moment F,
 * review/experiment-detective-tutor-audit.html): does the live
 * `update_rubric_score` tool ever let an unanswered tutor probe about a
 * criterion silently become full-credit evidence once the final artifact
 * merely looks complete?
 *
 * Every fixture uses SCRIPTED scholar turns (no emergent sim) — same
 * precedent as evals/activity-completion's should-withhold fixtures — because
 * this scenario needs precise, reproducible control over exactly when a
 * probe goes unanswered. The artifact (document) appears once, fully formed,
 * at `artifactVisibleFromTurn`; before that turn the tutor sees no document
 * yet, matching the real shape (the scholar writes the report only after the
 * conversation, not incrementally).
 *
 * A script item may also be an OBJECT rather than a bare scholar string, which
 * is what the `goalpost` probe needs: a revised document mid-conversation, a
 * SEEDED tutor turn (played verbatim, no model call — the fixture stipulates
 * what the tutor already said), and a "Check my work" CLICK, which is not a
 * scholar message at all but production's ephemeral `rubricCheckInstruction`
 * appended as a user-role turn. See `ScriptItem`.
 */
import type { SimTurn } from "../../../convex/lib/curriculumSimShared";
import type { RecordedRubricCall } from "./rubricCallRecord";

export type { SimTurn };
/** Alias for readability in this eval — same `{ role, content }` shape as
 * curriculum-sim's SimTurn ("tutor" | "scholar" roles), reused directly so
 * this harness doesn't fork a parallel turn type. */
export type RubricTurn = SimTurn;

/**
 * One step of a fixture's script.
 *
 * A bare string is the original shape and still means exactly what it always
 * meant: a scholar turn, answered by a live model turn.
 *
 * - `{ role: "scholar" }` — same thing, with an optional `document`: the full
 *   artifact content the tutor sees from this step onward (a mid-conversation
 *   revision, which `artifactVisibleFromTurn`'s single fixed reveal cannot
 *   express).
 * - `{ role: "tutor" }` — a SEEDED tutor turn, played verbatim with NO model
 *   call. It lets a fixture stipulate what the tutor already said (e.g. "'near
 *   the end' is enough"), which is the premise the goalpost probe measures the
 *   tutor against. A scholar step immediately followed by a seeded tutor step
 *   does not get a generated reply — the seeded turn IS the reply.
 * - `{ role: "check" }` — the scholar clicked "Check my work". The driver
 *   appends `rubricCheckInstruction(activityTitle)` (imported from
 *   convex/sessionStreamHelpers.ts) as a user-role turn exactly as
 *   convex/http.ts does, with no scholar text of its own; the model turn that
 *   follows is the verdict turn.
 */
export type ScriptItem =
  | string
  | { role: "scholar"; text: string; document?: string }
  | { role: "tutor"; text: string }
  | { role: "check"; document?: string };

/** The booleans lib/goalpostJudge.ts records. See lib/goalpostScore.ts. */
export type GoalpostCheck =
  | "reasksDoneThing"
  | "raisesBarWithoutOwning"
  | "reopensSettled"
  | "declaresSufficientWithoutBar";

export type RubricCriterion = {
  id: string;
  label: string;
  description?: string;
};

export type RubricCase = {
  /** Stable id (usually the fixture filename without extension). */
  id: string;
  activityTitle: string;
  deliverablePrompt: string;
  criteria: RubricCriterion[];
  /** The criterion this fixture is testing the unanswered-probe behavior on. */
  probedCriterionId: string;
  /** Scripted turns, played verbatim in order. See `ScriptItem`. */
  script: ScriptItem[];
  /**
   * 0-based index into `script`. Before this turn, no document exists yet
   * (artifactData is null); from this turn on, the tutor sees
   * `finalArtifactContent` as the scholar's submitted document.
   *
   * Optional: a fixture that reveals/revises its document through per-step
   * `document` fields omits both this and `finalArtifactContent`. Once any
   * step has supplied a `document`, that content wins for the rest of the
   * session and this fixed reveal no longer applies.
   */
  artifactVisibleFromTurn?: number;
  finalArtifactContent?: string;
  /**
   * `should-not-silently-full` — the probe was asked and never really
   * answered; the probed criterion must not quietly become `full` once the
   * artifact looks complete.
   * `should-be-full` — regression guard: the probe WAS genuinely answered in
   * conversation, so the criterion (and the whole rubric) should legitimately
   * earn full credit and receive a substantive response.
   * `conduct-only` — this fixture is not about the verdict at all (the
   * `goalpost` scorer), so declaring a credit expectation would be fiction.
   * The rubric-tool ledger is still recorded; nothing scores off it.
   */
  expectation: "should-not-silently-full" | "should-be-full" | "conduct-only";
  /**
   * Which of the eval's probes scores this fixture. Defaults to
   * `probe-integrity` (lib/probeIntegrityScore.ts — did an UNANSWERED probe
   * silently become full credit?). `spelling-credit`
   * (lib/spellingCreditScore.ts) is the opposite direction: the work IS there,
   * written in invented spelling — was it decoded and credited, and did the
   * reply avoid telling the scholar it was missing?
   *
   * `goalpost` (lib/goalpostScore.ts) is a third, conduct question rather than
   * a credit one: across a conversation the fixture has already stipulated,
   * does the check-my-work reply move the goalposts — re-ask for something the
   * scholar already did, fail what an earlier tutor turn accepted without
   * owning the change of mind, or reopen something the tutor said to leave
   * alone? Judged by lib/goalpostJudge.ts; `expectation` is not consulted.
   */
  scorer?: "probe-integrity" | "spelling-credit" | "goalpost";
  /**
   * `goalpost` fixtures only: which of the judge's booleans this fixture
   * actually gates on. Defaults to the three history-relative ones
   * (`reasksDoneThing`, `raisesBarWithoutOwning`, `reopensSettled`). A fixture
   * with no seeded tutor history has no history to contradict, so it names the
   * check that does apply to it instead (`declaresSufficientWithoutBar`).
   */
  goalpostChecks?: GoalpostCheck[];
  /**
   * `spelling-credit` fixtures only: a plain-English decoding of
   * `finalArtifactContent`, handed to the judge so whether the work is present
   * is a premise of the fixture rather than something the judge re-litigates.
   */
  decodedDocument?: string;
  /**
   * Whether this fixture's pass rate gates the live run's exit code. Default
   * true. Set false for a fixture that documents a MEASURED, currently
   * unfixed defect — an always-red gate is not a gate, and silently deleting
   * the fixture instead would lose the measurement. A non-gating fixture
   * still runs and still reports; it just cannot fail the build. Say why in
   * `note`, with the numbers.
   */
  gates?: boolean;
  /** Optional prose describing the failure mode this case guards. */
  note?: string;
};


export type RubricSessionResult = {
  case: RubricCase;
  turns: RubricTurn[];
  /**
   * EVERY accepted `update_rubric_score` call in the session, oldest first —
   * one entry per accepted tool ROUND, not one per scholar turn, so an in-turn
   * correction is not collapsed away. The raw ledger the fields below are
   * reduced from; the runner writes it into the JSON artifact so a run can
   * always be re-scored without re-running the model.
   */
  rubricCalls: RecordedRubricCall[];
  /**
   * Whether `update_rubric_score` was called ANYWHERE in the session. This
   * used to be "on the fixture's FINAL turn", which mis-scored a tutor that
   * credited the criterion on the turn the document appeared and then spent
   * the last turn confirming it in prose. See lib/rubricCallRecord.ts.
   */
  verdictRecorded: boolean;
  /** Diagnostic: did the LAST scripted turn re-score? Never a verdict itself. */
  recordedOnFinalTurn: boolean;
  /**
   * The HIGHEST level `probedCriterionId` ever reached, or null if no call
   * carried a verdict for it. Highest-ever rather than last-call because
   * production's flair is monotonic: the moment a criterion is scored `full`
   * the scholar is credited and no later call takes it back
   * (lib/rubricCallRecord.ts has the citations).
   */
  probedCriterionLevel: "not" | "half" | "full" | null;
  /** The probed criterion's level on the LAST call that mentioned it. */
  probedCriterionFinalLevel: "not" | "half" | "full" | null;
  /**
   * True when the tutor walked the probed criterion back below its peak. The
   * verdict is still taken from the peak, but a downgrade is never silent —
   * the driver warns, and both levels are reported here.
   */
  probedCriterionDowngraded: boolean;
  /**
   * The walk-back happened inside a single turn — the tutor scored `full` and
   * corrected itself before ever replying to the scholar. Production had
   * already minted the flair by then, so this is the case where the
   * scholar-visible text and the credit can disagree outright. Invisible to
   * this harness until `generateTutorTurn` stopped collapsing tool rounds.
   */
  probedCriterionDowngradedWithinTurn: boolean;
  /**
   * Some call scored every criterion `full` — i.e. the rubric passed at least
   * once. Session-wide for the same reason as `probedCriterionLevel`: a pass
   * calls `markActivityCompleted`, and completion is sticky.
   */
  allCriteriaFull: boolean;
  /**
   * The document content the tutor could see on the LAST generated turn, or
   * null if none ever became visible. For a fixture whose steps revise the
   * document, this is the final revision — what the goalpost judge must read
   * the final reply against.
   */
  finalDocumentContent: string | null;
  /** The tutor's scholar-visible text on the final turn (post-tool-result). */
  finalTurnText: string;
  /** Whether the final response is non-empty and substantive. */
  finalTextIsSubstantive: boolean;
};
