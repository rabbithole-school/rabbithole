// Tutor turns opened by in-app events (`streamTrigger: "appUpdate"`): a
// coalesced batch of app asks and/or new character exchanges and judge
// rulings (`appAiTurns`). Pure: shared by `sessions.startAppUpdateTurn` (the
// gate), `sessionHelpers.getSessionContext` (what the tutor reads), and the
// `/session-stream` handler (the instruction and the `stay_silent` tool).
//
// No static `@anthropic-ai/sdk` import (keeps node:* out of the edge bundle);
// and no dynamic import either: this module is reachable from the schema, so
// the `stay_silent` tool itself lives in staySilentTool.ts.

import type { Id } from "../_generated/dataModel";

/** Newest asks kept per update turn; older ones in a burst are dropped. */
export const APP_UPDATE_MAX_ASKS = 3;
/** At most this many in-app turns reach the tutor, newest last… */
export const APP_AI_CONTEXT_TURN_LIMIT = 40;
/** …trimmed this many at a time, so the window does not slide every turn. */
export const APP_AI_CONTEXT_TRIM_BLOCK = 20;
/** The persona as the tutor reads it: enough to direct, not the whole script. */
export const CHARACTER_PERSONA_BRIEF_CHARS = 600;

export const STAY_SILENT_TOOL_NAME = "stay_silent";

/** One `appAiTurns` row as the tutor and observer read it. */
export type AppAiContextTurn = {
  id: string;
  kind: "exchange" | "aside" | "judgment";
  createdAt: number;
  scholarLine: string | null;
  line: string | null;
  mood: string | null;
  verdict: string | null;
  /** The tutor overruled `verdict` with this one (speak_as_character). */
  verdictOverride: string | null;
  judgeId: string | null;
  feedback: string | null;
  /**
   * The chat row this turn sits immediately before in the tutor's timeline,
   * or null when it sits after the last one. See `placeAppAiTurns`.
   */
  placeBeforeMessageId: string | null;
  /** See `placeAppAiTurns` for the rule. */
  isNew: boolean;
};

/** The app's character, when the session's code artifact has one. */
export type CharacterContext = {
  artifactId: Id<"artifacts">;
  name: string;
  persona: string;
  moods: string[];
  verdicts: string[];
  /** The standing direction in force (the latest direction row), or null. */
  direction: string | null;
  /** The app author's notes to the directing tutor, or null. */
  directorNotes: string | null;
  /** Exchanges, asides and (when the app has judges) judgments. */
  turns: AppAiContextTurn[];
};

/** An app with judges and no character: only judgments reach the tutor. */
export type AppJudgeContext = {
  artifactId: Id<"artifacts">;
  judgeIds: string[];
  turns: AppAiContextTurn[];
};

/**
 * Which in-app turns (oldest first) the tutor reads. Up to the limit, all of
 * them; past it, the oldest are dropped a whole block at a time. Dropping one
 * per turn would move the start of the replayed history on every exchange, so
 * every turn after the fortieth would miss the conversation prompt cache; in
 * blocks, the prefix holds still between trims and misses once per block.
 */
export function appAiContextWindow<T>(turnsAsc: readonly T[]): T[] {
  const excess = turnsAsc.length - APP_AI_CONTEXT_TURN_LIMIT;
  if (excess <= 0) return [...turnsAsc];
  const drop =
    Math.ceil(excess / APP_AI_CONTEXT_TRIM_BLOCK) * APP_AI_CONTEXT_TRIM_BLOCK;
  return turnsAsc.slice(drop);
}

/**
 * Child-typed (or child-influenced) text as it sits inside the tutor's and
 * observer's labelled in-app lines (`[IN-APP — …] text`, `SCHOLAR → …: text`):
 * one line, with square brackets softened to parentheses, so it can neither
 * start a new labelled line nor forge a bracketed label the model trusts.
 * The record keeps the raw text; only these model-facing copies change.
 */
export function neutralizeInAppText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\[/g, "(")
    .replace(/\]/g, ")");
}

// ── "New since the tutor last spoke" ─────────────────────────────────────

/** The fields of a `messages` row the timeline needs. */
export type TimelineSourceMessage = {
  _id: string;
  _creationTime: number;
  role: string;
  content: string;
  imageId?: unknown;
  streamTrigger?: string;
  stopRequestedAt?: number;
};

export type TimelineEntry = {
  id: string;
  createdAt: number;
  /** A user row, or a placeholder a server trigger opened (kickoff/appUpdate). */
  turnStart: boolean;
  /** A tutor reply the scholar could see. */
  visibleReply: boolean;
};

/**
 * An app-update placeholder that has said nothing. The scholar never saw it —
 * even one a typed message stopped mid-decision — so it is neither chat
 * history nor a reply. (Clients hide it the same way: shared/streamRetry.ts
 * isQuietAppUpdatePlaceholder.)
 */
export function isUnspokenAppUpdate(m: {
  role: string;
  content: string;
  streamTrigger?: string;
}): boolean {
  return (
    m.role === "assistant" &&
    m.streamTrigger === "appUpdate" &&
    m.content.trim() === ""
  );
}

/**
 * The chat rows that matter for ordering in-app turns, oldest first. Mirrors
 * getSessionContext's chatHistory filter for the rows it keeps here: empty
 * placeholders (the live one, a silent turn's, a dead one) are not replies.
 */
export function toReplyTimeline(
  messagesAsc: readonly TimelineSourceMessage[],
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  for (const m of messagesAsc) {
    const hasText = m.content.trim() !== "";
    if (m.role === "user") {
      if (!hasText && !m.imageId) continue;
      timeline.push({
        id: String(m._id),
        createdAt: m._creationTime,
        turnStart: true,
        visibleReply: false,
      });
    } else if (m.role === "assistant") {
      if (isUnspokenAppUpdate(m)) continue;
      if (!hasText && m.stopRequestedAt === undefined) continue;
      timeline.push({
        id: String(m._id),
        createdAt: m._creationTime,
        turnStart: !!m.streamTrigger,
        visibleReply: true,
      });
    }
  }
  return timeline;
}

/**
 * When the tutor's latest visible reply began: the turn-start row at or before
 * its last visible reply row. Null when it has never visibly replied, or that
 * reply has no recorded start (then every in-app turn counts as new).
 */
export function latestReplyTurnStart(
  timeline: readonly TimelineEntry[],
): number | null {
  let i = timeline.length - 1;
  while (i >= 0 && !timeline[i].visibleReply) i--;
  for (; i >= 0; i--) {
    if (timeline[i].turnStart) return timeline[i].createdAt;
  }
  return null;
}

/**
 * The rule, in one sentence: an in-app turn is NEW to the tutor until a tutor
 * reply the scholar could see has started after it was created — so a silent
 * turn (which leaves no row) does not use it up, and the tutor reads the run
 * since it last spoke.
 *
 * Placement follows the same boundary: each in-app turn sits just before the
 * first turn-start row created after it, never between the segments of one
 * tutor reply. That keeps the turns the tutor's latest reply did not see AFTER
 * that reply, and makes an in-app turn's position a fixed function of the
 * history, so the conversation prompt-cache prefix does not churn.
 */
export function placeAppAiTurns<
  T extends { createdAt: number },
>(
  timeline: readonly TimelineEntry[],
  turns: readonly T[],
): Array<T & { placeBeforeMessageId: string | null; isNew: boolean }> {
  const boundary = latestReplyTurnStart(timeline);
  const starts = timeline.filter((entry) => entry.turnStart);
  return turns.map((turn) => {
    const anchor = starts.find((entry) => entry.createdAt > turn.createdAt);
    return {
      ...turn,
      placeBeforeMessageId: anchor?.id ?? null,
      isNew: boundary === null || turn.createdAt > boundary,
    };
  });
}

// ── The appUpdate turn ──────────────────────────────────────────────────

/**
 * The model-only instruction appended to an appUpdate turn (never persisted,
 * like the rubric-check and kickoff instructions).
 */
export function appUpdateInstruction(args: {
  hasAsks: boolean;
  hasCharacter: boolean;
  canStaySilent: boolean;
}): string {
  const moves = args.hasCharacter
    ? `coach the scholar in your own voice, direct the character or speak ` +
      `through it with your director tools, or say nothing`
    : `coach the scholar in your own voice, or say nothing`;
  // Without asks the scholar is mid-task: silence is the default, and the
  // reasons to break it live in CHARACTER ON STAGE when there is a character.
  const restraint = args.hasAsks
    ? ` An APP REQUEST is waiting: answer it.`
    : ` The scholar is still working in the app, and the struggle is the ` +
      `point, so your default is to say nothing.` +
      (args.hasCharacter
        ? ` Speak, direct, or overrule the character only for one of the ` +
          `reasons in CHARACTER ON STAGE, and never right after the character ` +
          `has done its part and before the scholar has had a try.`
        : ` Speak only if they are stuck after several tries, upset, asked ` +
          `you something, or have just finished.`);
  return (
    `[SYSTEM — this is NOT a message the scholar typed. Things happened ` +
    `inside the app since your last reply; they are the IN-APP lines and APP ` +
    `REQUESTs after it, above. You are the director here: ${moves}.` +
    restraint +
    (args.canStaySilent
      ? ` To say nothing, call ${STAY_SILENT_TOOL_NAME} before writing any text.`
      : "") +
    APP_UPDATE_VOICE_RULE +
    (args.hasCharacter && args.canStaySilent
      ? ` Anything you write before a director tool call is discarded unseen, ` +
        `so if you also speak, speak after it.`
      : "") +
    `]`
  );
}

/**
 * The voice rule for an app-update turn, at the model's decision point (the
 * same place stay_silent is offered). The tutor's reasoning has a private
 * channel (its adaptive thinking; lib/tutorModel), and its text has none:
 * every word of it streams to the scholar's line strip. TRA-477.
 */
export const APP_UPDATE_VOICE_RULE =
  ` Every word of text you write goes straight to the scholar, so your first ` +
  `word is addressed to them. Do all your weighing in your private thinking, ` +
  `never in the reply: do not describe what happened in the app, and never ` +
  `say "the notes say" or "the author", never name a verdict, stage, part, ` +
  `loophole, or app-state field, and never read a [bracketed placeholder] ` +
  `aloud. Speak only in your own voice as the tutor, in the scholar's register.`;

/**
 * An app update with no asks holds the model's text until its first tool
 * decision (convex/http.ts). stay_silent drops it, and so does a director
 * tool on such a turn: the scholar never sees a direction, so text written
 * before one is the tutor talking to itself about the play ("Biscuit did
 * something useless… the notes say this is the moment"), never a line for
 * the scholar. Any other tool, or the end of the message, releases it.
 */
export function heldTextFateAtTool(
  toolName: string | undefined,
  args: { quietAppUpdate: boolean; directorToolNames: ReadonlySet<string> },
): "drop" | "release" {
  if (toolName === STAY_SILENT_TOOL_NAME) return "drop";
  if (args.quietAppUpdate && args.directorToolNames.has(toolName ?? "")) {
    return "drop";
  }
  return "release";
}
