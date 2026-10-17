/**
 * promptVersion — a deterministic hash of the tutor prompt that ships in code.
 *
 * WHY: quality signals (observer `analyses` rows, and the Pulse rollups keyed
 * off them — see `review/continuous-eval-plan.html` §7 item 5) need a stable
 * grouping key for the tutor's system-prompt configuration. A content hash
 * cannot drift like a hand-maintained tag.
 *
 * WHAT FEEDS THE HASH — a *canonical reference render* of the STATIC,
 * tutor-visible prompt constants that ship in `convex/prompts.ts`, built with
 * FIXED synthetic inputs so nothing per-session leaks in:
 *   - buildBasePrompt — with the runtime date/time line normalized out (see
 *     below). Its `<start>` bullet is turn-invariant since TRA-234.
 *   - buildOpeningTurnSection (both the first-ever FIRST MESSAGE directive and
 *     the returning-scholar fresh-start guards) — the turn-1-only directives
 *     that used to be branches inside buildBasePrompt / SESSION CONTEXT.
 *   - buildSoulSection() — the soul-doc text as the live env flag
 *     (RABBITHOLE_SOUL_DOC) renders it. This is what makes the hash change when
 *     the soul doc is edited or switched off.
 *   - buildNonHumanIntroSection(true) — the static first-session self-intro.
 *   - buildToolsSection() — the static tool-affordance description (chat and
 *     app-builder variants), plus buildSideAppSection (a side app's steer-back).
 *   - buildTutorMissionSteering — the tutor-stance MISSION steering
 *     (TRA-519 B1), rendered for a fixed reference mission with and without
 *     a Quest build unlock.
 *   - buildOpenExplorationWrapUpSection() — the static "how an open
 *     exploration ends" note (rendered only for activity-less sessions).
 *   - TUTOR_PROMPT_SECTION_ORDER + TUTOR_TURN_SYSTEM_SECTIONS +
 *     TUTOR_TURN_CONTEXT_SECTIONS + the cache-breakpoint keys — the section LAYOUT of the assembled prompt.
 *     Reordering sections is model-visible (what the tutor reads first changes)
 *     even though no section's text does, so a layout change must group as a
 *     new prompt version (TRA-185).
 *   - Any enabled tutor-prompt add-ons, including their deployment-env gates,
 *     tool schemas, and tool-result guidance.
 *
 * DELIBERATELY EXCLUDED (so property (a) — stability across calls when
 * code+env are unchanged — holds):
 *   - The runtime "Current date and time: …" line: it changes every render, so
 *     it is excluded from the hash. As of the prompt-cache work it no longer
 *     lives inside buildBasePrompt at all — it moved to buildClockLine, emitted
 *     in per-turn message context (see buildSystemPromptParts), which
 *     buildVersionMaterial does not render, so it's naturally excluded. The
 *     normalizeBasePrompt() call below is retained as a defensive no-op: if a
 *     clock line ever reappears inside the base prompt it is normalized to a
 *     fixed placeholder (label kept, so a template-label change is still
 *     detected) rather than flaking the hash.
 *   - All per-session / dynamic sections (dossier, whispers, document notes,
 *     mastery, signals, reading level, unit/lesson/activity/persona/
 *     perspective/process/seeds, physical environment): those are keyed on
 *     session data, not the shipped prompt.
 *   - OBSERVER_SYSTEM_PROMPT: that's the observer's own prompt, not the tutor
 *     prompt whose version we're stamping.
 *   - Core tool schemas and callback guidance defined inside `http.ts`.
 *     `promptVersion` groups system-prompt configurations; it is not a complete
 *     release fingerprint. Message timestamps + GitHub deployment history are
 *     the authoritative lookup for the exact code revision that served a turn.
 *
 * RUNTIME: default Convex runtime (Web Crypto) — intentionally NOT `"use node"`
 * so it stays importable from any runtime; the observer action (which is
 * `"use node"`) awaits it once per run.
 */

import {
  buildBasePrompt,
  buildSoulSection,
  buildNonHumanIntroSection,
  buildOpeningTurnSection,
  buildOpenExplorationWrapUpSection,
  buildToolsSection,
  buildSideAppSection,
  buildTutorMissionSteering,
  FIRST_DOCUMENT_TUTOR_SECTION,
  FIRST_DYNAMIC_TUTOR_SECTION,
  TUTOR_PROMPT_SECTION_ORDER,
  TUTOR_TURN_CONTEXT_SECTIONS,
  TUTOR_TURN_SYSTEM_SECTIONS,
} from "../prompts";
import {
  buildChatPracticeSection,
  chatPracticeFailureGuidance,
  chatPracticeEnabled,
  chatPracticeSuccessGuidance,
  CHAT_PRACTICE_NO_ITEM_REASON,
  CHAT_PRACTICE_NO_MATCH_REASON,
  SERVE_PRACTICE_PROBLEM_TOOL,
} from "./practice/chatPractice";
import {
  buildTeachBackSection,
  FINISH_TEACH_BACK_TOOL,
  START_TEACH_BACK_TOOL,
  teachBackFinishFailureGuidance,
  teachBackEnabled,
  TEACH_BACK_FINISH_GUIDANCE,
  TEACH_BACK_NO_ACTIVE_GUIDANCE,
  teachBackStartFailureGuidance,
  teachBackStartGuidance,
} from "./teachBack";

/** Fixed synthetic scholar name — a constant so the name-handling *template*
 *  is covered while no real per-session name affects the hash. */
const REF_SCHOLAR_NAME = "Reference Scholar";

/** Defensive normalizer for a runtime clock line. As of the prompt-cache work
 *  buildBasePrompt no longer emits "Current date and time: …" (it moved to the
 *  per-turn message context via buildClockLine, which the hash material doesn't
 *  render), so this is a no-op today. Retained so that if a clock line ever
 *  reappears in the base prompt its volatile value is neutralized (label kept)
 *  instead of flaking the hash. */
const DATE_LINE_RE = /Current date and time: [^\n]*/g;
const DATE_LINE_PLACEHOLDER = "Current date and time: <reference>";

function normalizeBasePrompt(prompt: string): string {
  return prompt.replace(DATE_LINE_RE, DATE_LINE_PLACEHOLDER);
}

/**
 * The exact string the version hash is computed over. Exported (pure, no I/O)
 * so tests can assert on WHAT is hashed — per `rabbithole-test-strategy.md`,
 * "export the pure material-builder + a thin hasher".
 */
/** Arbitrary fixed epoch-ms anchor for the opening-turn hash material. */
const REF_LAST_SESSION_AT = 1_700_000_000_000;

/** Fixed reference mission for the MISSION steering's hash material. */
const REF_MISSION = {
  source: "default" as const,
  gate: "Reference gate.",
  freedoms: [],
  invariants: [],
  questLine: null,
  ownQuest: false,
  unlocksBuild: null,
  buildStepOpen: false,
};

export function buildVersionMaterial(): string {
  const chatPracticeOn = chatPracticeEnabled();
  const teachBackOn = teachBackEnabled();
  const parts: (string | null)[] = [
    normalizeBasePrompt(buildBasePrompt(REF_SCHOLAR_NAME)),
    // Fixed synthetic timestamps (non-zero: a falsy lastSessionAt means "no
    // prior session" and yields null): 2h gap vs. same-sitting, so all three
    // opening-turn variants are covered without any wall-clock input.
    buildOpeningTurnSection(true, true, null, null),
    buildOpeningTurnSection(true, false, REF_LAST_SESSION_AT, REF_LAST_SESSION_AT + 2 * 60 * 60_000),
    buildOpeningTurnSection(true, false, REF_LAST_SESSION_AT, REF_LAST_SESSION_AT + 5 * 60_000),
    // Reads RABBITHOLE_SOUL_DOC at call time, so the hash tracks the live soul
    // doc (and returns null when it's switched off).
    buildSoulSection(),
    buildNonHumanIntroSection(true),
    buildToolsSection({ builderFeatures: false }),
    buildToolsSection({ builderFeatures: true }),
    buildToolsSection({ builderFeatures: false, appActions: true }),
    buildSideAppSection("text"),
    buildSideAppSection(null),
    buildSideAppSection("text", { hasMission: true }),
    buildSideAppSection("text", { lockedBuild: "Reference build step" }),
    buildTutorMissionSteering(REF_MISSION),
    buildTutorMissionSteering({
      ...REF_MISSION,
      unlocksBuild: "Reference build step",
    }),
    buildTutorMissionSteering({
      ...REF_MISSION,
      unlocksBuild: "Reference build step",
      buildStepOpen: true,
    }),
    buildSideAppSection("text", { openBuild: "Reference build step" }),
    buildOpenExplorationWrapUpSection(),
    // Section layout + where the prompt-cache breakpoint falls.
    `layout: ${TUTOR_PROMPT_SECTION_ORDER.join(",")} | turn-system: ${TUTOR_TURN_SYSTEM_SECTIONS.join(",")} | turn-context: ${TUTOR_TURN_CONTEXT_SECTIONS.join(",")} | breakpoint: ${FIRST_DYNAMIC_TUTOR_SECTION} | documents: ${FIRST_DOCUMENT_TUTOR_SECTION}`,
    chatPracticeOn
      ? buildChatPracticeSection({
          fluentLabels: ["Reference fluent skill"],
          frontierLabels: ["Reference frontier skill"],
          dueLabels: ["Reference review skill"],
        })
      : null,
    chatPracticeOn ? JSON.stringify(SERVE_PRACTICE_PROBLEM_TOOL) : null,
    chatPracticeOn
      ? [
          CHAT_PRACTICE_NO_MATCH_REASON,
          CHAT_PRACTICE_NO_ITEM_REASON,
          chatPracticeSuccessGuidance("Reference skill", "Reference stem"),
          chatPracticeFailureGuidance("Reference error"),
        ].join("\n")
      : null,
    teachBackOn ? buildTeachBackSection() : null,
    teachBackOn
      ? JSON.stringify([START_TEACH_BACK_TOOL, FINISH_TEACH_BACK_TOOL])
      : null,
    teachBackOn ? teachBackStartGuidance("Reference concept") : null,
    teachBackOn ? teachBackStartFailureGuidance("Reference error") : null,
    teachBackOn ? TEACH_BACK_FINISH_GUIDANCE : null,
    teachBackOn ? TEACH_BACK_NO_ACTIVE_GUIDANCE : null,
    teachBackOn ? teachBackFinishFailureGuidance("Reference error") : null,
  ];
  return parts.filter((p): p is string => p !== null).join("\n\n---\n\n");
}

/**
 * Deterministic 12-hex-char sha256 of {@link buildVersionMaterial}. Stable
 * across calls when code+env are unchanged; changes when any tutor-visible
 * system-prompt material covered above or the active soul variant changes.
 */
export async function computePromptVersion(): Promise<string> {
  const bytes = new TextEncoder().encode(buildVersionMaterial());
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 12);
}
