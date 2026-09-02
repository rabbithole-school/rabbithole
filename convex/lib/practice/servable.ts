/**
 * The unified SERVE + GRADE contract for one practice item.
 *
 * Today item grading is duplicated across every surface that serves a practice
 * item — `submitAnswer` (the drill loop), placement, chat practice, tune-ups,
 * re-probe — each re-deriving the correct answer from an item id and dispatching
 * on the item's shape (template vs. stored word-problem vs. manipulative). This
 * module is the single spine that subsumes those: a `ServableItem` (the resolved
 * item, its client-facing `prompt`, and a SERVER-ONLY `verifier`), a `Submission`
 * (what a scholar sent), and a pure `gradeSubmission(item, submission, policy)`
 * dispatcher whose side-effect intentions are driven by a per-surface
 * `GradePolicy`. It is PURE (no Convex `ctx`): the resolver builders take
 * already-fetched docs / the deterministic template lookup, so the grading core
 * is unit-testable without a deployment.
 *
 * Anti-cheat invariant (unchanged): the correct answer is NEVER sent to the
 * client. It lives on `verifier`; `prompt` carries only what is safe to render.
 * A manipulative has no answer string at all — only a goal (the visible task)
 * and a spec the scholar must build against, re-graded server-side.
 *
 * This PR wires `submitAnswer` through the contract with `PRACTICE_POLICY` and
 * is strictly behavior-preserving; later PRs convert placement / chat / tune-up
 * call sites to their own policies.
 */

import {
  type AnswerType,
  type TypedAnswer,
  type UnitKey,
  answersEqual,
  formatUnit,
  parseAnswer,
  parseAnswerWithUnit,
  parseUnitKey,
  formatAnswerForDisplay,
} from "./answers";
import { generateItem, hasTemplate, type ItemVariant } from "./templates";
import { parseItemId } from "./session";
import {
  gradeManipulativeSubmission,
  parseManipulativeSpec,
  redactManipulativeSpecForClient,
} from "../../../lib/manipulative/grade";
import { goalText as manipulativeGoalText } from "../../../lib/manipulative/logic";
import { resolveRegion } from "../../../lib/geomap/registry";
import type { ManipulativeSpec } from "../../../lib/manipulative/types";
import { isCurrentManipulativeKind } from "../../../lib/manipulative/types";
import {
  isRetiredManipulativeSpecId,
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../../lib/manipulative/practiceContract";
import type { PracticePromptVisual } from "../../../shared/practicePromptVisual";
import {
  isBareDotsPrompt,
  reconstructCountablesPromptVisual,
} from "./countableReconstruct";
import type { Id } from "../../_generated/dataModel";

// ── Prompt + verifier ──────────────────────────────────────────────────────

/**
 * The client-facing prompt payload for a servable item — everything safe to
 * render. The correct answer is deliberately absent (it lives on `verifier`).
 *
 * `workedSteps` is the STORED, fully-worked form (its `text` is server-only —
 * see the schema); the serve-time backward fade that hides later steps is
 * applied by the serving layer (a later PR). Grading only reads its length, to
 * decide whether a correct answer was produced with the scaffold still visible.
 */
export type ServablePrompt = {
  stem: string;
  // "dialogue" = a rubric'd-chat stretch item (lib/practice/dialogueStretch.ts)
  // — served through the same shape, but graded on /practice-dialogue, never
  // by gradeSubmission.
  answerType: AnswerType | typeof MANIPULATIVE_ANSWER_TYPE | "dialogue";
  /** The DISPLAY unit this item must be answered in ("cm³"), when its verifier
   *  requires one. NOT an answer leak: the stem already names the unit in
   *  words ("…in cubic centimeters") — this is the machine-readable echo so a
   *  client can render the unit affordance on the pad and refuse to submit a
   *  bare number. The verifier's canonical `requiredUnit` stays server-only. */
  answerUnit?: string;
  choices?: string[];
  promptVisual?: PracticePromptVisual;
  workedSteps?: { text: string; blankText?: string; hintText?: string }[];
  manipulativeSpec?: string;
};

/**
 * The SERVER-ONLY grader payload — never serialized to a client. One arm per
 * item kind, each holding exactly what the current `submitAnswer` re-derives to
 * grade that kind:
 *   • template     — the by-construction `TypedAnswer` from the template engine.
 *   • storedAnswer — the stored `answerCanonical` string, parsed at grade time.
 *   • manipulative — the `ManipulativeSpec` JSON, re-run through `isSolved`.
 *
 * `requiredUnit` (typed arms only) makes the measurement unit part of the
 * answer: the submission is correct only when the VALUE matches AND the unit
 * the learner wrote normalizes to this key. Absent = the item is unit-free and
 * a trailing unit is ignored, exactly as before.
 */
export type ServableVerifier =
  | {
      kind: "template";
      answerType: AnswerType;
      answer: TypedAnswer;
      choices?: string[];
      requiredUnit?: UnitKey;
    }
  | {
      kind: "storedAnswer";
      answerType: AnswerType;
      answerCanonical: string;
      choices?: string[];
      requiredUnit?: UnitKey;
    }
  | { kind: "manipulative"; spec: string | undefined };

/**
 * The tutor-facing context handed to the Socratic explain/handoff on a miss.
 * A typed/stored item is text-only (`{ type: "text", stem }` — the correct
 * answer is derived elsewhere and deliberately absent). A MANIPULATIVE has no
 * answer string at all, so instead of a stem it carries structured, no-leak
 * grounding: the concept eyebrow, the authored one-line `prompt`, a `goalText`
 * restatement of the task, and the parsed `spec` — so the endpoint can run
 * `describeState(spec, submittedStateJson)` on the board the scholar actually
 * built. None of these fields ever contains a derived solution value (see the
 * describer rules in lib/manipulative/logic.ts).
 */
export type TutorContext =
  | { type: "text"; stem: string }
  | {
      type: "manipulative";
      concept: string;
      prompt: string;
      goalText: string;
      spec: ManipulativeSpec;
    };

/** Fields shared by every `ServableItem` kind. */
type ServableBase = {
  itemId: string;
  skillKey: string;
  skillLabel: string;
  domain: string;
  prompt: ServablePrompt;
  tutorContext: TutorContext;
};

/**
 * A resolved practice item, ready to serve and to grade. Discriminated on
 * `kind`:
 *   • template     — `ref` re-derives the item from the deterministic engine
 *                    (`skillKey` + `seed` [+ `form`]); `itemId` = "skillKey#seed[#form]".
 *   • stored       — a verified word-problem `practiceItems` row; `ref` is its id,
 *                    `itemId` = "gen#<id>".
 *   • manipulative — a `practiceItems` row whose `verifierKind` is "manipulative";
 *                    same "gen#<id>" encoding, graded by re-running its spec.
 */
export type ServableItem =
  | (ServableBase & {
      kind: "template";
      ref: { skillKey: string; seed: number; form?: string };
      variant?: ItemVariant;
      verifier: Extract<ServableVerifier, { kind: "template" }>;
    })
  | (ServableBase & {
      kind: "stored";
      ref: Id<"practiceItems">;
      verifier: Extract<ServableVerifier, { kind: "storedAnswer" }>;
      /** The pre-verified placement warmth-floor reveal line (Tier 1c), when the
       *  row carries one. Safe to serve in a placement reveal. */
      revealLine?: string;
    })
  | (ServableBase & {
      kind: "manipulative";
      ref: Id<"practiceItems">;
      verifier: Extract<ServableVerifier, { kind: "manipulative" }>;
    });

/**
 * What a scholar submitted, normalized off the wire:
 *   • typed            — a raw text answer (parsed per the item's answer type).
 *   • choice           — a picked multiple-choice option index.
 *   • manipulativeState — the locked-in runtime state JSON (opaque; re-graded).
 *   • dontKnow         — an explicit "I haven't learned this yet" (always a miss).
 */
export type Submission =
  | { kind: "typed"; raw: string }
  | { kind: "choice"; index: number }
  | { kind: "manipulativeState"; stateJson: string }
  | { kind: "dontKnow" };

// ── Grade policy ───────────────────────────────────────────────────────────

/**
 * Per-surface grading policy — the knobs that decide which side effects a graded
 * submission earns, so one dispatcher can serve every surface. Fields:
 *   • surface               — a label for the calling surface (diagnostics only).
 *   • recordMastery         — advance the spaced-repetition mastery row.
 *   • recordPracticeAttempt — append a `practiceAttempts` row.
 *   • recordLatency         — feed the silent retrieval-latency baseline.
 *   • classifyErrorPatterns — run the Ashlock buggy-algorithm classifier on a miss.
 *   • revealAnswer          — when the correct answer may be echoed to the client
 *                             ("onCorrect" | "never" | "always"); a manipulative
 *                             never reveals (it has no answer string).
 *   • explanation           — "dontKnowReason" stamps a `dont_know` explanation
 *                             reason on a dontKnow miss; "none" records none.
 *   • lane                  — optional serving lane forced onto the recorded
 *                             attempt (e.g. placement); omitted = inferred.
 *   • finalCredit           — optional forced outcome (e.g. placement crediting
 *                             below the discovered frontier), overriding grading
 *                             but not an explicit dontKnow (which stays a miss).
 */
export type GradePolicy = {
  surface: string;
  recordMastery: boolean;
  recordPracticeAttempt: boolean;
  recordLatency: boolean;
  classifyErrorPatterns: boolean;
  revealAnswer: "onCorrect" | "never" | "always";
  explanation: "dontKnowReason" | "none";
  lane?: string;
  finalCredit?: boolean;
};

/**
 * The drill-loop policy — the EXACT current `submitAnswer` behavior encoded as a
 * policy: record the attempt + mastery + latency, classify wrong answers, reveal
 * the answer only on a correct non-manipulative submission, and stamp a
 * `dont_know` reason on an "I haven't learned this yet" miss.
 */
export const PRACTICE_POLICY: GradePolicy = {
  surface: "practice",
  recordMastery: true,
  recordPracticeAttempt: true,
  recordLatency: true,
  classifyErrorPatterns: true,
  revealAnswer: "onCorrect",
  explanation: "dontKnowReason",
};

/**
 * A grade-only policy with NO side effects — grade the submission and record
 * nothing, reveal nothing. Used by the dispatcher tests as the "record-nothing"
 * counterpart to `PRACTICE_POLICY`; a future unscored surface (tune-ups) can
 * adopt it directly.
 */
export const GRADE_ONLY_POLICY: GradePolicy = {
  surface: "grade-only",
  recordMastery: false,
  recordPracticeAttempt: false,
  recordLatency: false,
  classifyErrorPatterns: false,
  revealAnswer: "never",
  explanation: "none",
};

/**
 * The REHEARSE policy — a teacher previewing a skill's question pool as a scholar
 * (the Content-view "Rehearse" on the Questions surface). Grades exactly like the
 * drill (same correctness + `revealAnswer: "onCorrect"`) but records NOTHING: it
 * is the drill's `PRACTICE_POLICY` with every side-effect knob turned off. The
 * point is structural — a rehearse session grades through `gradeSubmission` with
 * this policy on the CLIENT, so no `should*` flag ever reaches a writer and no
 * `practiceMastery` / spaced-repetition / attempt row can be minted under the
 * teacher's own account. `GRADE_ONLY_POLICY` is the abstract "record nothing"
 * counterpart; this one keeps the drill's reveal behavior so the preview reads
 * like the real thing.
 */
export const REHEARSE_POLICY: GradePolicy = {
  surface: "rehearse",
  recordMastery: false,
  recordPracticeAttempt: false,
  recordLatency: false,
  classifyErrorPatterns: false,
  revealAnswer: "onCorrect",
  explanation: "none",
};

/**
 * A story-thread application is feedback inside an exploration, never an SR
 * attempt. A correct, unassisted solve may separately earn depth evidence, but
 * the grading policy itself records no mastery, attempt, latency, or error data.
 */
export const STORY_THREAD_POLICY: GradePolicy = {
  surface: "story-thread",
  recordMastery: false,
  recordPracticeAttempt: false,
  recordLatency: false,
  classifyErrorPatterns: false,
  revealAnswer: "onCorrect",
  explanation: "none",
};

/**
 * The PLACEMENT policy (U-3) — the ternary adaptive check-in. Placement drives
 * its OWN side effects (its `practiceAttempts` row, the resumable probe log, and
 * mastery credited only at finalize via `creditPlacementFrontiers`), so the
 * dispatcher records NOTHING here and runs NO latency baseline or error
 * classifier. It differs from the drill in ONE grading knob: `revealAnswer:
 * "always"` — a placement item is a locked measurement, so the answer is shown on
 * a MISS as well as a correct (to teach), a deliberate carve-out from the drill's
 * no-reveal rule. A MANIPULATIVE still never reveals (it has no answer string —
 * `gradeSubmission` gates the reveal on kind), so the no-reveal handoff (U-4) is
 * structural for a manipulative probe. The ternary outcome (correct | incorrect |
 * unknown) is derived by the caller from `grade.isDontKnow` / `grade.correct`.
 */
export const PLACEMENT_POLICY: GradePolicy = {
  surface: "placement",
  recordMastery: false,
  recordPracticeAttempt: false,
  recordLatency: false,
  classifyErrorPatterns: false,
  revealAnswer: "always",
  explanation: "none",
};

// ── Resolver layer (pure builders — take fetched docs / the template lookup) ──

/** The knowledge-graph node fields the resolver reads for a served item —
 *  its display label and owning domain. Both optional; absent falls back to the
 *  skillKey / the caller's default domain. */
export type ServableNodeInfo = { label?: string; domain?: string };

/** The `practiceItems` fields the stored/manipulative resolver reads. A full
 *  `Doc<"practiceItems">` is structurally assignable (it has these + more). */
export type StoredPracticeItem = {
  _id: Id<"practiceItems">;
  skillKey: string;
  stem: string;
  answerType: string;
  answerCanonical: string;
  /** The unit this item must be answered in, display form ("cm³") — see the
   *  `practiceItems.answerUnit` schema comment. Absent on every row that
   *  predates the column, which is why it can only ever ADD a requirement. */
  answerUnit?: string;
  choices?: string[];
  verifierKind?: string;
  manipulativeSpec?: string;
  workedSteps?: { text: string; blankText?: string; hintText?: string }[];
  promptVisual?: PracticePromptVisual;
  verifiedAt?: number;
  /** The pre-verified placement warmth-floor reveal line (Tier 1c). */
  revealLine?: string;
};

/**
 * Build a `ServableItem` for a TEMPLATE id ("skillKey#seed[#form]"), or null if
 * `itemId` isn't a template item the engine can generate (so the caller falls
 * through to the stored-item lookup, exactly as `gradeTemplateItem` does). Pure:
 * the item is re-derived from the deterministic template engine; `node` supplies
 * the display label + domain (falling back to the skillKey / `defaultDomain`).
 */
export function buildTemplateServable(
  itemId: string,
  node: ServableNodeInfo | null,
  defaultDomain: string,
): ServableItem | null {
  const parsed = parseItemId(itemId);
  if (!parsed || !hasTemplate(parsed.skillKey)) return null;
  const item = generateItem(parsed.skillKey, parsed.seed, parsed.form);
  if (!item) return null;
  const { skillKey } = parsed;
  return {
    kind: "template",
    ref: { skillKey, seed: parsed.seed, ...(parsed.form ? { form: parsed.form } : {}) },
    ...(item.variant ? { variant: item.variant } : {}),
    itemId,
    skillKey,
    skillLabel: node?.label ?? skillKey,
    domain: node?.domain ?? defaultDomain,
    prompt: {
      stem: item.stem,
      answerType: item.answerType,
      ...(item.choices ? { choices: item.choices } : {}),
      ...(item.promptVisual ? { promptVisual: item.promptVisual } : {}),
      // Deterministic worked steps for the teach-as-action moment (teachingStep
      // reads this, forcing a single-blank fade). Present only for mechanical
      // families; the serving path deliberately does NOT copy prompt.workedSteps
      // to the client (see servedItemFromServable in serve.ts), so this changes
      // no answering-phase behavior for templates.
      ...(item.workedSteps ? { workedSteps: item.workedSteps } : {}),
      // The unit the answer must carry, in display form. The stem already says
      // it in words; this is what lets the pad show it and gate the submit.
      ...(item.answerUnit ? { answerUnit: formatUnit(item.answerUnit) } : {}),
    },
    verifier: {
      kind: "template",
      answerType: item.answerType,
      answer: item.answer,
      ...(item.choices ? { choices: item.choices } : {}),
      ...(item.answerUnit ? { requiredUnit: item.answerUnit } : {}),
    },
    tutorContext: { type: "text", stem: item.stem },
  };
}

/**
 * Build a `ServableItem` for a STORED "gen#<id>" item from its fetched
 * `practiceItems` doc — a manipulative when `verifierKind` is "manipulative",
 * otherwise a typed-answer word problem. Pure; `node` supplies the display label
 * + domain (falling back to the skillKey / `defaultDomain`).
 *
 * Returns null to EXCLUDE the row when it is UNANSWERABLE as served: a
 * counting-family ("How many dots?") item that lacks a `promptVisual` and
 * cannot have one safely reconstructed, or a manipulative whose spec carries no
 * readable `prompt` (the stage shows only mechanics, so the scholar would get a
 * board with no question). Skipping beats serving either. Every other stored row
 * (a word problem legitimately has no visual) always resolves.
 */
export function buildStoredServable(
  itemId: string,
  doc: StoredPracticeItem,
  node: ServableNodeInfo | null,
  defaultDomain: string,
): ServableItem | null {
  const { skillKey, stem } = doc;
  const base = {
    itemId,
    skillKey,
    skillLabel: node?.label ?? skillKey,
    domain: node?.domain ?? defaultDomain,
    tutorContext: { type: "text" as const, stem },
  };

  // A stored counting-family "How many dots?" row must never ship without its
  // dots visual: the stem carries no count, and the accessible label that
  // exposes it lives on the visual. Backfill it the same way
  // `migrateLegacyCountablePromptVisuals` does; if the count can't be trusted,
  // exclude the row rather than serve a bare stem. Scoped to the bare dots
  // prompt on the typed-answer path — a manipulative, or a counting word problem
  // whose text stands on its own, is untouched.
  let promptVisual = doc.promptVisual;
  if (
    promptVisual === undefined &&
    doc.verifierKind !== MANIPULATIVE_VERIFIER_KIND &&
    isBareDotsPrompt(skillKey, stem)
  ) {
    const reconstructed = reconstructCountablesPromptVisual(doc);
    if (!reconstructed) return null;
    promptVisual = reconstructed;
  }

  if (doc.verifierKind === MANIPULATIVE_VERIFIER_KIND) {
    // A manipulative's tutor context is structured + no-leak: parse the spec so
    // the explain/handoff can restate the task (`goalText`) and later describe
    // the submitted board (`describeState`). A malformed spec degrades to the
    // text stem (nothing to ground on, but never a crash).
    const spec = parseManipulativeSpec(doc.manipulativeSpec);
    // A RETIRED kind is different from a malformed one, and must not degrade —
    // it must EXCLUDE the row, the same call the bare-dots branch above makes.
    // `parseManipulativeSpec` only requires a string `kind`, so a row left
    // behind by a retired mechanic (`factorGame` moving to the games platform)
    // parses cleanly, serves, then renders nothing: the renderer's switch has no
    // default and `isSolved` falls through its exhaustive guard, so the scholar
    // gets a blank frame that grades incorrect forever. Returning null lets the
    // drill loop's manipulative guarantee fall through to a word problem and a
    // placement probe re-prime, which is what an unrenderable row deserves.
    if (
      spec &&
      (!isCurrentManipulativeKind(spec.kind) ||
        isRetiredManipulativeSpecId(spec.id))
    ) {
      return null;
    }
    // A manipulative's PROMPT is the question — the stage itself renders only
    // mechanics ("Start at 3. Drag the dot left or right."), so a row with no
    // readable prompt is unanswerable exactly like the bare-dots stem above.
    // `assertGradableManipulative` already refuses to AUTHOR one; this refuses
    // to SERVE one, so a hand-inserted or pre-assertion row can never reach a
    // scholar — and never as a placement probe, whose answer is written into
    // the learning record as evidence. Excluding lets the drill's manipulative
    // guarantee fall through to a word problem and a placement probe re-prime.
    if (spec ? !spec.prompt?.trim() : !stem.trim()) return null;
    const tutorContext: TutorContext = spec
      ? {
          type: "manipulative",
          concept: spec.concept,
          prompt: spec.prompt,
          goalText: manipulativeGoalText(spec),
          spec,
        }
      : { type: "text", stem };
    return {
      ...base,
      tutorContext,
      kind: "manipulative",
      ref: doc._id,
      prompt: {
        stem,
        answerType: MANIPULATIVE_ANSWER_TYPE,
        // No-spoilers: the CLIENT copy of the spec is stripped of any answer-
        // bearing field (today: a geoLocate map task's target/region) via
        // `redactManipulativeSpecForClient`. The `verifier.spec` below keeps the
        // RAW spec — grading is server-side against that, never the client copy.
        ...(doc.manipulativeSpec !== undefined
          ? { manipulativeSpec: redactManipulativeSpecForClient(doc.manipulativeSpec) ?? undefined }
          : {}),
        ...(doc.promptVisual ? { promptVisual: doc.promptVisual } : {}),
      },
      verifier: { kind: "manipulative", spec: doc.manipulativeSpec },
    };
  }

  const answerType = doc.answerType as AnswerType;
  // A stored row may declare the unit its stem asks for, exactly as a template
  // family does — resolved through the SAME registry, so there is one unit
  // vocabulary and one grading rule for both kinds of item. A row with no
  // `answerUnit` (every row predating the column) resolves to no `requiredUnit`
  // and grades value-only, unchanged; so does an unrecognized token, since a
  // unit the grader can't normalize could never be satisfied.
  //
  // Restricted to TYPED answers: a tapped multiple-choice index has nowhere to
  // write a unit, so requiring one would make the item unanswerable. Templates
  // simply never declare a unit on such a family; a stored row is arbitrary DB
  // content, so the serve path enforces it.
  const requiredUnit =
    doc.answerUnit && answerType !== "multipleChoice" ? parseUnitKey(doc.answerUnit) : null;
  return {
    ...base,
    kind: "stored",
    ref: doc._id,
    ...(doc.revealLine ? { revealLine: doc.revealLine } : {}),
    prompt: {
      stem,
      answerType,
      ...(doc.choices ? { choices: doc.choices } : {}),
      ...(doc.workedSteps ? { workedSteps: doc.workedSteps } : {}),
      ...(promptVisual ? { promptVisual } : {}),
      // The pad's unit affordance, in the registry's display form (never the
      // raw stored string), so it renders identically to a template item's.
      ...(requiredUnit ? { answerUnit: formatUnit(requiredUnit) } : {}),
    },
    verifier: {
      kind: "storedAnswer",
      answerType,
      answerCanonical: doc.answerCanonical,
      ...(doc.choices ? { choices: doc.choices } : {}),
      ...(requiredUnit ? { requiredUnit } : {}),
    },
  };
}

// ── Pure grading core ──────────────────────────────────────────────────────

/**
 * The graded outcome + the policy-derived side-effect intentions a surface acts
 * on. Nothing here has run yet — a Convex caller performs the writes the flags
 * describe. `correctAnswer` is the unredacted server truth (for the error
 * classifier); `revealedAnswer` is what may be echoed to the client (policy- +
 * kind-gated).
 */
export type GradeResult = {
  correct: boolean;
  correctAnswer: string;
  revealedAnswer: string | undefined;
  /**
   * The "so close" signal, set ONLY when the numeric value was right and the
   * unit was not: `"missing"` (no unit written at all) or `"wrong"` (a unit was
   * written but it isn't the required one — an unrecognized token counts as
   * wrong). A wrong VALUE leaves this undefined, because the unit is not what
   * went wrong; so does a dontKnow, and so does any item with no
   * `requiredUnit`. The submission is incorrect either way — this only tells a
   * surface which sentence to say.
   */
  unitOutcome?: "missing" | "wrong";
  stem: string;
  skillKey: string;
  variant?: ItemVariant;
  isManipulative: boolean;
  isDontKnow: boolean;
  shouldClassifyError: boolean;
  shouldRecordMastery: boolean;
  shouldRecordPracticeAttempt: boolean;
  shouldRecordLatency: boolean;
  explanationReason: "dont_know" | undefined;
  lane: string | undefined;
};

/** The learner's submission as a `TypedAnswer` for a template/stored item, or
 *  null when it can't be one (a manipulative state or a dontKnow → a miss). */
function learnerTypedAnswer(submission: Submission, type: AnswerType): TypedAnswer | null {
  switch (submission.kind) {
    case "typed":
      return parseAnswer(submission.raw, type);
    case "choice":
      return { type: "multipleChoice", choiceIndex: submission.index };
    case "manipulativeState":
    case "dontKnow":
      return null;
  }
}

/** The submitted manipulative state string, or null when the submission carries
 *  none. A `typed` submission's raw string is treated as the opaque state (the
 *  legacy contract passes state as the generic `answer` string). */
function manipulativeStateFrom(submission: Submission): string | null {
  switch (submission.kind) {
    case "manipulativeState":
      return submission.stateJson;
    case "typed":
      return submission.raw;
    case "choice":
    case "dontKnow":
      return null;
  }
}

/** Correctness plus, when the value was right but the unit wasn't, which way it
 *  was wrong. */
type Correctness = { correct: boolean; unitOutcome?: "missing" | "wrong" };

/**
 * Judge the UNIT half of a typed submission whose value already matched. Only a
 * `typed` submission can carry a unit at all — a tapped multiple-choice index
 * and an opaque manipulative state have no place to write one, so those items
 * never declare a `requiredUnit`.
 */
function gradeUnit(
  submission: Submission,
  answerType: AnswerType,
  requiredUnit: UnitKey,
): Correctness {
  if (submission.kind !== "typed") return { correct: false, unitOutcome: "missing" };
  const { unit, unitRaw } = parseAnswerWithUnit(submission.raw, answerType);
  if (unit === requiredUnit) return { correct: true };
  // Nothing written → "missing"; something written that isn't the required unit
  // (including a token the registry doesn't know) → "wrong".
  return { correct: false, unitOutcome: unitRaw === null ? "missing" : "wrong" };
}

/** Base correctness of a submission against an item's verifier, before any
 *  policy `finalCredit` override or dontKnow miss. */
function gradeCorrectness(item: ServableItem, submission: Submission): Correctness {
  switch (item.kind) {
    case "template": {
      const type = item.verifier.answerType;
      const learner = learnerTypedAnswer(submission, type);
      const valueMatches =
        learner !== null &&
        answersEqual(learner, item.verifier.answer, {
          requireSimplifiedRadical: item.skillKey === "roots_simplify_radicals",
        });
      if (!valueMatches || !item.verifier.requiredUnit) return { correct: valueMatches };
      return gradeUnit(submission, type, item.verifier.requiredUnit);
    }
    case "stored": {
      const type = item.verifier.answerType;
      const truth = parseAnswer(item.verifier.answerCanonical, type);
      const learner = learnerTypedAnswer(submission, type);
      const valueMatches =
        truth !== null && learner !== null && answersEqual(learner, truth);
      if (!valueMatches || !item.verifier.requiredUnit) return { correct: valueMatches };
      return gradeUnit(submission, type, item.verifier.requiredUnit);
    }
    case "manipulative": {
      const state = manipulativeStateFrom(submission);
      if (state === null) return { correct: false };
      // Pass the registry resolver so a geoLocate `region` task can resolve its
      // target polygon server-side; every other kind ignores it.
      return {
        correct: gradeManipulativeSubmission(item.verifier.spec, state, resolveRegion).correct,
      };
    }
  }
}

/** The `requiredUnit` of a typed item's verifier, if it has one. */
function requiredUnitOf(item: ServableItem): UnitKey | undefined {
  return item.kind === "manipulative" ? undefined : item.verifier.requiredUnit;
}

/** The unredacted server-truth answer string for an item (the form the current
 *  `submitAnswer` compares against / would reveal): the template's display form,
 *  the stored `answerCanonical`, or "" for a manipulative (no answer string). */
function serverTruth(item: ServableItem): string {
  switch (item.kind) {
    case "template":
      return formatAnswerForDisplay(item.verifier.answer, item.verifier.choices);
    case "stored": {
      if (item.verifier.answerType !== "multipleChoice") {
        return item.verifier.answerCanonical;
      }
      const answer = parseAnswer(item.verifier.answerCanonical, "multipleChoice");
      return answer
        ? formatAnswerForDisplay(answer, item.verifier.choices)
        : item.verifier.answerCanonical;
    }
    case "manipulative":
      return "";
  }
}

/**
 * The FULL expected answer as a scholar should write it — the server truth plus
 * the required unit ("112 cm³"). This is the reveal form: a reveal that showed
 * a bare "112" would model an answer the grader would then mark incomplete.
 *
 * Kept separate from `serverTruth` on purpose: `GradeResult.correctAnswer` feeds
 * the Ashlock error classifier, which compares scalar numbers — appending a unit
 * there would only blind it.
 */
function displayTruth(item: ServableItem, correctAnswer: string): string {
  const unit = requiredUnitOf(item);
  if (!unit || !correctAnswer) return correctAnswer;
  const display = formatUnit(unit);
  // Degrees binds to the number with no space ("65°"); every other unit reads
  // as "112 cm³". Matches the pad's `applyUnitKey` so the reveal models exactly
  // what a scholar would type.
  return unit === "deg" ? `${correctAnswer}${display}` : `${correctAnswer} ${display}`;
}

/** What may be echoed to the client, gating the reveal by the policy's rule; a
 *  manipulative never reveals (it has no answer to show). */
function revealForClient(
  correct: boolean,
  isManipulative: boolean,
  displayAnswer: string,
  policy: GradePolicy,
): string | undefined {
  if (isManipulative) return undefined;
  switch (policy.revealAnswer) {
    case "never":
      return undefined;
    case "always":
      return displayAnswer;
    case "onCorrect":
      return correct ? displayAnswer : undefined;
  }
}

/**
 * Grade one submission against one resolved item under a policy — the single
 * dispatcher every surface shares. Pure: it computes correctness and the
 * policy-derived side-effect intentions (`should*` flags, `revealedAnswer`,
 * `explanationReason`, `lane`) but performs no writes. An explicit dontKnow is
 * always a miss (it overrides both grading and any `finalCredit`), and error
 * classification is reserved for a non-manipulative, non-dontKnow miss.
 *
 * When the verifier carries a `requiredUnit`, a right value with the wrong (or
 * no) unit is INCORRECT and reports `unitOutcome` so the surface can say "so
 * close — it needs the unit" instead of a flat miss.
 */
export function gradeSubmission(
  item: ServableItem,
  submission: Submission,
  policy: GradePolicy,
): GradeResult {
  const isDontKnow = submission.kind === "dontKnow";
  const graded = gradeCorrectness(item, submission);
  let correct = graded.correct;
  if (policy.finalCredit !== undefined) correct = policy.finalCredit;
  if (isDontKnow) correct = false;

  const isManipulative = item.kind === "manipulative";
  const correctAnswer = serverTruth(item);
  return {
    correct,
    correctAnswer,
    // A forced `finalCredit` win retires the unit note — there is no "so close"
    // to report on an attempt the policy has decided to credit.
    ...(!correct && graded.unitOutcome ? { unitOutcome: graded.unitOutcome } : {}),
    revealedAnswer: revealForClient(
      correct,
      isManipulative,
      displayTruth(item, correctAnswer),
      policy,
    ),
    stem: item.prompt.stem,
    skillKey: item.skillKey,
    ...(item.kind === "template" && item.variant ? { variant: item.variant } : {}),
    isManipulative,
    isDontKnow,
    shouldClassifyError:
      policy.classifyErrorPatterns && !correct && !isManipulative && !isDontKnow,
    shouldRecordMastery: policy.recordMastery,
    shouldRecordPracticeAttempt: policy.recordPracticeAttempt,
    shouldRecordLatency: policy.recordLatency,
    explanationReason: policy.explanation === "dontKnowReason" && isDontKnow ? "dont_know" : undefined,
    lane: policy.lane,
  };
}
