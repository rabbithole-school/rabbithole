/**
 * The FROZEN contract for a manipulative rendered as a first-class practiceItem.
 *
 * Shared by three surfaces (lane 1 owns this file; lanes 2/3 code against it):
 *   • the web renderer          — components/manipulative/*
 *   • the server grader         — convex/practiceSkills.ts (submitAnswer)
 *   • the native inline webview — native /embed + the RN host bridge
 *
 * The rule everywhere: the client's own `isSolved()` self-check is OPTIMISTIC UI
 * only; the authoritative correct/incorrect is the SERVER re-running `isSolved`
 * on the submitted state (see lib/manipulative/grade.ts). Nothing here leaks an
 * answer — a manipulative has no answer string, only a goal (the task, already
 * visible) and a configuration the scholar must actually build.
 */

/**
 * The value stamped on a `practiceItems` row to mark it a manipulative. It goes
 * in BOTH `answerType` (so the session renderer dispatches to the Manipulative
 * surface) and `verifierKind` (so the grader dispatches to `isSolved`). The
 * `ManipulativeSpec` itself lives in the row's `manipulativeSpec` (JSON) column.
 */
export const MANIPULATIVE_ANSWER_TYPE = "manipulative";
export const MANIPULATIVE_VERIFIER_KIND = "manipulative";

const RETIRED_MANIPULATIVE_SPEC_IDS: ReadonlySet<string> = new Set([
  "compare-4200-vs-3800",
]);

/** Content specs excluded from every serving path while their rows are cleaned up. */
export function isRetiredManipulativeSpecId(id: string): boolean {
  return RETIRED_MANIPULATIVE_SPEC_IDS.has(id);
}

/**
 * What the client submits to `api.practiceSkills.submitAnswer` for a
 * manipulative: the locked-in runtime state, JSON-serialized, passed as the
 * generic `answer` string — so `submitAnswer`'s signature is unchanged (it is
 * just an opaque payload the manipulative verifier knows how to read).
 */
export type ManipulativeSubmission = {
  itemId: string;
  /** `JSON.stringify` of the kind-matched runtime state (PartitionState | …). */
  stateJson: string;
};

/** Build the `submitAnswer` args for a manipulative from a submission. */
export function manipulativeSubmitArgs(sub: ManipulativeSubmission): {
  itemId: string;
  answer: string;
} {
  return { itemId: sub.itemId, answer: sub.stateJson };
}

/**
 * The message a native-embedded manipulative postMessages up to the RN host on
 * Done. The host forwards `{ itemId, stateJson }` to `submitAnswer` and reflects
 * the *server's* graded result back into the native practice chrome. `solved` is
 * the client's optimistic self-check (for instant UI) — never the grade.
 */
export const RH_MANIPULATIVE_DONE = "rhManipulativeDone" as const;

export type ManipulativeDoneMessage = {
  type: typeof RH_MANIPULATIVE_DONE;
  itemId: string;
  /** optimistic client self-check — UI only, never trusted for grading. */
  solved: boolean;
  stateJson: string;
};

/** Narrow an untrusted postMessage payload to a `ManipulativeDoneMessage`. */
export function isManipulativeDoneMessage(msg: unknown): msg is ManipulativeDoneMessage {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === RH_MANIPULATIVE_DONE &&
    typeof (msg as { itemId?: unknown }).itemId === "string" &&
    typeof (msg as { stateJson?: unknown }).stateJson === "string" &&
    typeof (msg as { solved?: unknown }).solved === "boolean"
  );
}
