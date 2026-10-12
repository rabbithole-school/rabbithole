/**
 * Honest build progress for the Vibecode Workshop, derived ENTIRELY from
 * signals the client already sees on the tutor stream — no new backend
 * contract. The web `VibecodeWorkshop` feeds an ordered list of `BuildSignal`s
 * (stream start, the CODE_TOOLS `create_code` / `edit_document` tool
 * starts/completes, the `renderCheck` request, `done`) and this pure reducer
 * says which stage the build is in, so the preview card and the chat status
 * line render the SAME derived stage (one canonical rendering per signal).
 *
 * Framework-free so it can be unit-tested and shared; the labels/subtitles
 * live in the React component that renders it.
 */

/** The stages a first app build moves through, in order. */
export const BUILD_STAGE_ORDER = [
  "planning",
  "writing",
  "looking",
  "fixing",
] as const;

export type BuildStage = (typeof BUILD_STAGE_ORDER)[number];

/** Tool names whose in-flight state means the app is being written/rewritten. */
const CREATE_CODE = "create_code";
const EDIT_DOCUMENT = "edit_document";

/**
 * A normalized signal the workshop extracts from the SSE stream. Deliberately
 * smaller than the raw `StreamEvent`: only the moments that move the stage.
 */
export type BuildSignal =
  | { type: "streamStart" }
  | { type: "codeToolStart"; name: string }
  | { type: "codeToolComplete"; name: string }
  | { type: "renderCheck" }
  | { type: "renderCheckAnswered" }
  | { type: "done" }
  | { type: "error" };

export interface BuildStageState {
  /** The stage that is currently active (or the last one reached once ended). */
  stage: BuildStage;
  /** True once the stream finished (`done`/`error`) — the build is no longer live. */
  ended: boolean;
}

/** The numeric position of a stage in `BUILD_STAGE_ORDER`. */
export function buildStageIndex(stage: BuildStage): number {
  return BUILD_STAGE_ORDER.indexOf(stage);
}

/**
 * Reduce an ordered list of build signals to the active stage.
 *
 * - `planning` — from stream start until the first code tool starts.
 * - `writing`  — `create_code` in flight (and the brief lull after it, until a
 *   render check is requested or the artifact renders).
 * - `looking`  — a `renderCheck` was requested (until an edit or `done` follows).
 * - `fixing`   — `edit_document` in flight AFTER a render check.
 *
 * A build with no render check simply stops at `writing` (then the artifact
 * renders and the card disappears).
 */
export function deriveBuildStage(events: readonly BuildSignal[]): BuildStageState {
  let stage: BuildStage = "planning";
  let ended = false;
  let renderCheckSeen = false;

  for (const ev of events) {
    switch (ev.type) {
      case "streamStart":
        stage = "planning";
        break;
      case "codeToolStart":
        if (ev.name === CREATE_CODE) {
          // A fresh `create_code` starts the app over from scratch, so the
          // render-check cycle restarts too: an `edit_document` before the
          // replacement app is inspected is "Writing the app", not "Fixing
          // what it saw".
          renderCheckSeen = false;
          stage = "writing";
        } else if (ev.name === EDIT_DOCUMENT) {
          stage = renderCheckSeen ? "fixing" : "writing";
        }
        break;
      case "renderCheck":
        renderCheckSeen = true;
        stage = "looking";
        break;
      case "renderCheckAnswered":
        // The review is answered; the stage holds at `looking` until the model
        // either starts an edit (→ fixing) or finishes (→ done).
        break;
      case "codeToolComplete":
        // A completed tool never advances the stage on its own — the next
        // start / render check / done does.
        break;
      case "done":
      case "error":
        ended = true;
        break;
    }
  }

  return { stage, ended };
}

/** What the Vibecode preview surface should show for a build. */
export type BuildPreview = "app" | "live" | "stopped" | "empty";

/**
 * Decide what the preview pane renders, from signals the workshop already has.
 * Pure so the settle logic is unit-testable without mounting the workshop.
 *
 * - `app`     — a rendered HTML artifact exists; show the live app.
 * - `live`    — a build is streaming, launching, or a teacher build was opened
 *   whose kickoff has not produced (or failed to produce) anything yet.
 * - `stopped` — a teacher build ran and settled with NO artifact (Stop, a
 *   rejected fetch, an SSE error, or `done` with no code): show a settled
 *   recovery card, NOT a ticking progress card. Keyed on the live/ended
 *   signals, never on the durable `hasBuildRequest` alone.
 * - `empty`   — a scholar session with nothing in flight: the "start" prompt.
 */
export function deriveBuildPreview(input: {
  hasArtifact: boolean;
  isStreaming: boolean;
  /** A kickoff stream is being launched or a retry is scheduled. */
  launching: boolean;
  /** The session was opened as a teacher build (`teacherBuildKickoff`). */
  hasBuildRequest: boolean;
  /** A build stream has started at least once this session. */
  buildStarted: boolean;
  /** A terminal SSE signal (`done`/`error`) was seen. */
  ended: boolean;
}): BuildPreview {
  const { hasArtifact, isStreaming, launching, hasBuildRequest, buildStarted, ended } =
    input;
  if (hasArtifact) return "app";
  if (isStreaming || launching) return "live";
  if (hasBuildRequest) return buildStarted || ended ? "stopped" : "live";
  return "empty";
}
