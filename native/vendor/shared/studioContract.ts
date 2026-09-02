/**
 * The Studio contract — the one file the sandbox document, the native host, the
 * web host, the level ladder and the generous fixer all agree on.
 *
 * ## What the Studio is
 *
 * A scholar types JavaScript, presses Run, and watches a world respond. Two
 * modes share one editor and one runtime:
 *
 * - `"puzzle"` — a grid robot. The win condition is the world's, not the
 *   program's, so a program that reaches the pad is right for reasons the
 *   scholar can see.
 * - `"art"` — a pen on a blank canvas. Nothing to win; the drawing is the point.
 *
 * ## Why the world types use `Set` / `Map` and still cross no boundary
 *
 * Worlds are BUILT INSIDE the sandbox from a level's `make()` and never travel.
 * Only source text, run verdicts and fix requests cross the bridge, and those
 * are all plain JSON. So the world shape is free to be the shape that is
 * pleasant to write physics against rather than the shape that serializes.
 * `StudioBridgeDoc` below is the part that must stay JSON, and it is separate
 * for exactly that reason.
 *
 * ## Why levels are code, not rows
 *
 * A level owns a seeded `make()` that builds a fresh world every time. That is the
 * pedagogy, not a convenience: rung 1 ends by pressing "change the world" and
 * discovering that three `forward()` calls only ever solved one particular
 * hallway. A row in a table cannot roll dice, so the ladder lives in
 * `shared/studioLevels.ts` next to its generators — the same call
 * `lib/games/catalog.ts` makes for games.
 *
 * Sync changes into `native/vendor/shared/` with `native/scripts/sync-vendor.js`.
 */

/** East, south, west, north. Screen coordinates, so `y` grows DOWNWARD. */
export type StudioDir = 0 | 1 | 2 | 3;

/** `"3,4"` — the key shape used by `walls` and `paint`. */
export type StudioCellKey = string;

export const cellKey = (x: number, y: number): StudioCellKey => `${x},${y}`;

/**
 * The colour words a scholar may paint or test with. Deliberately NOT hex or
 * `rgb()`: a beginner should write `red`, and a colour they cannot spell is a
 * colour they cannot use. Extending this list is cheap; teaching hex is not.
 */
export const STUDIO_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown",
  "black",
  "white",
] as const;

export type StudioColor = (typeof STUDIO_COLORS)[number];

/** A rolled world. Built in-sandbox by a level's `make()`; never serialized. */
export interface StudioWorld {
  /** Cells the robot cannot enter. */
  walls: Set<StudioCellKey>;
  /** Painted floor — the only thing `onColor()` reads. */
  paint: Map<StudioCellKey, StudioColor>;
  start: { x: number; y: number; dir: StudioDir };
  /** The pad. `null` on a free world. */
  goal: { x: number; y: number } | null;
  treasure: Array<{ x: number; y: number }>;
  /** When set, winning means carrying exactly this many. */
  needCarry: number | null;
  /** Nothing to win, only to draw. */
  free: boolean;
}

/**
 * Which rung a level sits on. The rungs are the elective's three sessions, and
 * they name a KIND of idea rather than a difficulty:
 *
 * 1. straight-line commands
 * 2. repetition and a question about the world (`while`, `if`)
 * 3. naming things (`function`) and rules that survive a new world
 */
export type StudioRung = 1 | 2 | 3;

export type StudioMode = "puzzle" | "art";
export type StudioWorldSeed = string | number;

export interface StudioLevel {
  /** Stable id. Persisted against saved source, so never renumber or reuse. */
  id: string;
  title: string;
  mode: StudioMode;
  rung: StudioRung;
  /**
   * The ONE new word this rung introduces, for the level rail's caption.
   * `null` when the level is practice at an idea already met.
   */
  idea: string | null;
  /** One or two sentences. Rendered as trusted inline markup by the sandbox. */
  hint: string;
  /**
   * The code the editor opens with. By design this is the PREVIOUS level's
   * solution: it runs, and it falls short in exactly one instructive way.
   */
  starter: string;
  /** Builds a world from an explicit seed. Called again for "change the world". */
  make: (seed: StudioWorldSeed) => StudioWorld;
}

/** How a run ended. `line` is 1-based and points into the scholar's source. */
export type StudioRunStatus = "win" | "short" | "error" | "stopped";

export const STUDIO_RUN_TRACE_FRAME_LIMIT = 24;

export interface StudioRunTraceFrame {
  line: number;
  x: number;
  y: number;
  note: string;
}

export interface StudioRunTrace {
  frames: StudioRunTraceFrame[];
  totalFrames: number;
  /** True when either the runtime or this bridge summary omitted later frames. */
  truncated: boolean;
}

export interface StudioRunResult {
  levelId: string;
  status: StudioRunStatus;
  /** Robot steps taken (not statements executed). */
  steps: number;
  /** The exact world seed used for this run. */
  seed: string;
  /** True when any repair — deterministic autocorrect or the Haiku fixer — modified the source this run. */
  assisted: boolean;
  /** Bounded playback summary; never the full recording. */
  trace: StudioRunTrace;
  /** Kid-facing sentence. Never a raw exception string. */
  message: string;
  line?: number;
}

const STUDIO_RUN_STATUSES: readonly StudioRunStatus[] = [
  "win",
  "short",
  "error",
  "stopped",
];

export function isStudioRunResult(value: unknown): value is StudioRunResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<StudioRunResult>;
  if (
    typeof run.levelId !== "string" ||
    !STUDIO_RUN_STATUSES.includes(run.status as StudioRunStatus) ||
    typeof run.steps !== "number" ||
    !Number.isInteger(run.steps) ||
    run.steps < 0 ||
    typeof run.seed !== "string" ||
    run.seed.length === 0 ||
    run.seed.length > 64 ||
    typeof run.assisted !== "boolean" ||
    typeof run.message !== "string" ||
    run.message.length > 1_000 ||
    (run.line !== undefined &&
      (typeof run.line !== "number" || !Number.isInteger(run.line) || run.line < 1))
  ) {
    return false;
  }
  const trace = run.trace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return false;
  if (
    !Array.isArray(trace.frames) ||
    trace.frames.length > STUDIO_RUN_TRACE_FRAME_LIMIT ||
    typeof trace.totalFrames !== "number" ||
    !Number.isInteger(trace.totalFrames) ||
    trace.totalFrames < trace.frames.length ||
    typeof trace.truncated !== "boolean"
  ) {
    return false;
  }
  return trace.frames.every(
    (frame) =>
      !!frame &&
      typeof frame === "object" &&
      typeof frame.line === "number" &&
      Number.isInteger(frame.line) &&
      frame.line >= 0 &&
      typeof frame.x === "number" &&
      Number.isInteger(frame.x) &&
      typeof frame.y === "number" &&
      Number.isInteger(frame.y) &&
      typeof frame.note === "string" &&
      frame.note.length <= 32,
  );
}

// ── The generous fixer ───────────────────────────────────────────────────────

/**
 * One repair, always shown. A fixer that silently rewrites a scholar's program
 * teaches them that the computer is capricious; one that shows its work turns a
 * typo into the smallest possible lesson. Every `StudioFix` must be renderable
 * as a single sentence a nine-year-old can read.
 */
export interface StudioFix {
  /** 1-based line in the ORIGINAL source. */
  line: number;
  /** e.g. `Forward()` */
  was: string;
  /** e.g. `forward()` */
  now: string;
  /** "JavaScript is fussy about capital letters." */
  note: string;
}

export interface StudioFixResult {
  /** The repaired program. Equal to the input when nothing was fixed. */
  source: string;
  fixes: StudioFix[];
  /**
   * True when the source parses after repair. False means even the model could
   * not make sense of it, and the scholar should see the original error.
   */
  ok: boolean;
}

/** What the sandbox sends the host when its own deterministic pass gave up. */
export interface StudioFixRequest {
  requestId: string;
  source: string;
  /** The parser's complaint, verbatim — the model's most useful input. */
  error: string;
  line?: number;
}

export interface StudioRollRequest {
  requestId: string;
  levelId: string;
}

// ── The bridge ───────────────────────────────────────────────────────────────

/**
 * The sandbox↔host document, carried by the existing `rabbithole:app-state`
 * bridge (`lib/appStateBridge.mjs`). We deliberately do NOT invent a second
 * WebView protocol: that bridge is already nonce-checked, size-capped, vendored
 * to native and covered by tests, and the Studio's cross-boundary traffic is
 * all slow-path anyway.
 *
 * The fast loop — keystroke, run, redraw — never touches this. It is entirely
 * inside the WebView, which is the whole reason the editor and the canvas ship
 * as one document instead of two halves talking over a bridge.
 */
export interface StudioBridgeDoc {
  /** Sandbox → host. Debounced; the host persists it. */
  source?: string;
  /** Sandbox → host. Which level `source` belongs to. */
  levelId?: string;
  /** Sandbox → host. Most recent verdict, for progress and teacher visibility. */
  lastRun?: StudioRunResult;
  /** Sandbox → host. Set when the deterministic fixer could not finish the job. */
  fixRequest?: StudioFixRequest;
  /** Sandbox → host. Requests the next host-derived world seed. */
  rollRequest?: StudioRollRequest;
}

/**
 * Host → sandbox calls, via `rabbithole.registerAction`. Names are part of the
 * contract; the sandbox registers exactly these.
 */
export const STUDIO_ACTIONS = {
  /** `{ levelId, source? }` — switch levels, optionally restoring saved work. */
  setLevel: "setLevel",
  /** `{ requestId, result: StudioFixResult }` — the Haiku round-trip landing. */
  applyFix: "applyFix",
  /** `{ urls: Record<string, string> }` — charm sprite URLs, entity → URL. */
  setCharms: "setCharms",
  /** `{}` — roll a new world for the current level. */
  rollWorld: "rollWorld",
} as const;

export type StudioActionName =
  (typeof STUDIO_ACTIONS)[keyof typeof STUDIO_ACTIONS];

/**
 * The words the runtime predeclares, so an undefined-variable error can say
 * "you haven't taught the robot `dance` yet" instead of `dance is not defined`.
 *
 * This is the CANONICAL list — `studio/src/runtime.ts` derives its predeclared
 * scope from it rather than keeping a second copy, and a test asserts the
 * runtime hands the program exactly these names. The two drifted once (this
 * list claimed `pen` and `repeat`, which the runtime has never provided), and
 * a vocabulary that lies is worse than no vocabulary: it makes the friendly
 * unknown-name message fire on a word that does work.
 */
export const STUDIO_VOCABULARY = [
  // moving
  "forward",
  "left",
  "right",
  "take",
  // asking
  "canGo",
  "canGoLeft",
  "canGoRight",
  "wallAhead",
  "atGoal",
  "onTreasure",
  "onColor",
  "carrying",
  // drawing
  "penDown",
  "penUp",
  "color",
  // counting and talking
  "count",
  "say",
] as const;
