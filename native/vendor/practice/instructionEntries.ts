/**
 * Instructional "Launchpad" entries (instructional segments v1).
 *
 * A Launchpad is a short, STRAND-LEVEL instructional beat shown the first time a
 * scholar enters a genuinely new strand — the deliberate answer to "the playlist
 * feels too fully Socratic". It sits on the playlist alongside practice but is
 * pure CONTENT: it never grades, never moves mastery, never scores the scholar.
 * In the run it is now the "Can you already do this?" frame on a real item,
 * and its move must be about that item — see "The MOVE" below.
 *
 * This module is the PURE core (no `ctx`, no DB) so the selection + fire-once
 * lifecycle rules are unit-testable in isolation. The Convex query/mutations
 * (convex/practiceSkills.ts `practiceSession`, convex/instruction.ts) load
 * rows and delegate every policy decision here.
 *
 * Key invariants (forced by the adversarial review):
 *  - Content is DECOUPLED from any served item (see schema `instructionContent`),
 *    so `masteryEffect: "none"` is structural, not a trusted client flag.
 *  - "≤ 1 Launchpad per day" and "re-offer a skipped-only Launchpad at most 3×"
 *    are enforced from the ledger, so one impulsive skip never permanently
 *    suppresses instruction, and instruction never spams a session.
 *  - The ledger is SYSTEM-ONLY telemetry — never a learner-facing quality signal.
 */

import { rawAnswersEqual, type AnswerType } from "./answers";

/** Max times a "Try it myself"-only (never viewed) Launchpad is re-offered. */
export const INSTRUCTION_REOFFER_CAP = 3;

/** Equal-weight fork copy — preference, not remediation (both grant full credit). */
export const TRY_FIRST_LABEL = "Try it myself";
export const SHOW_ME_LABEL = "Show me the move";

// ── "Can you already do this?" — the question framing (2026-10) ─────────────
// The run's `launchpad` entry is no longer a card in front of the item: the
// first served item in never-attempted territory wears a small pill, the kid
// answers the REAL item (an ordinary graded attempt), and the move is shown
// only if they say "not yet" or miss. Ask, don't tell. Copy lives here so web
// and native (which vendors this module) render the same words.
/** The pill above the stem card on the framed item. */
export const QUESTION_FRAME_PILL = "Can you already do this?";
/** The quiet link under the answer — the honest don't-know for this item. */
export const QUESTION_FRAME_NOT_YET = "Not yet — show me";
/** The primary button under the shown move; returns to answering. */
export const QUESTION_FRAME_TRY_ONE = "Got it, let me try one";

/** Telemetry plan for the framed item, in call order — the same ledger
 *  (`instructionEvents`) the doorway card wrote, so the next read has a
 *  denominator: shown → (show | try) → viewed → completed. Empty in preview or
 *  without a scholar subject, exactly like `instructionWritesFor`. */
export function questionFrameWritesFor(
  event: "frameShown" | "notYet" | "answered" | "moveShown" | "answeredAfterMove",
  opts: { preview?: boolean; scholarId?: string | null },
): InstructionWrite[] {
  if (!shouldRecordInstruction(opts)) return [];
  switch (event) {
    case "frameShown":
      return [{ type: "claimShown" }];
    case "notYet":
      return [{ type: "recordChoice", choice: "show" }];
    case "answered":
      return [{ type: "recordChoice", choice: "try" }];
    case "moveShown":
      return [{ type: "recordViewed" }];
    case "answeredAfterMove":
      return [{ type: "recordCompleted" }];
  }
}

/** Stable content key for a strand-level Launchpad. Domain-scoped so identically
 *  named strands in different domains never collide. */
export function strandInstructionKey(domain: string, strand: string): string {
  return `strand:${domain}:${strand}`;
}

/** Stable content key for a NODE-grain instructional entry (key-space §3 /
 *  node doorway §4.1). `nodeKey` is already globally unique
 *  (`graphValidation.ts`), so — unlike strands — it never needs a domain
 *  prefix. The single source of truth for the `node:` shape; `convex/
 *  instruction.ts`'s `buildInstructionKey`/`parseInstructionKey` build on top
 *  of this rather than re-deriving the string format. */
export function nodeInstructionKey(nodeKey: string): string {
  return `node:${nodeKey}`;
}

/** Stable per-scholar render handle threaded through the wire entry + mutations. */
export function instructionOfferId(scholarId: string, key: string): string {
  return `${scholarId}:${key}`;
}

export type InstructionVideoAtom = {
  kind: "video";
  provider: "youtube";
  videoId: string;
  startSec: number;
  endSec: number;
  captionText: string;
  sourceLabel: string;
  sourceUrl: string;
};

export type InstructionAtom =
  | { kind: "story_hook"; hook: string; fromKey?: string; toKey?: string }
  | { kind: "micro_explain"; text: string }
  | {
      kind: "worked_example";
      strategyLabel: string;
      steps: string[];
      examplePrompt: string;
      exampleAnswer: string;
    }
  // Interactive twin of `worked_example`: the final answer is FADED and the
  // scholar produces it, client-graded (see `gradeTryItAtom`). Records nothing.
  | {
      kind: "try_it";
      strategyLabel: string;
      steps: string[];
      examplePrompt: string;
      exampleAnswer: string;
      answerType?: AnswerType;
    }
  // Ungraded instance of the existing manipulative primitive: `spec` is a
  // JSON-serialized `ManipulativeSpec` (same shape as `practiceItems`), rendered
  // by the existing kind renderers, self-checked by the existing `isSolved`.
  | { kind: "manipulative"; spec: string }
  | InstructionVideoAtom;

/**
 * Privacy-enhanced, clipped YouTube embed URL shared by web and native renderers.
 *
 * Every parameter is a DISTRACTION or PRIVACY decision, not a style choice:
 *  - `start`/`end`      — the authored clip bounds; the scholar never lands in
 *                         the middle of an unrelated lesson.
 *  - `playsinline=1`    — the clip stays inside our card on iOS.
 *  - `rel=0`            — end-screen suggestions are restricted to the same
 *                         channel (since 2018 this can no longer be turned off
 *                         entirely by a parameter).
 *  - `iv_load_policy=3` — NO annotations / info cards over the video.
 *  - `disablekb=1`      — the player ignores keyboard shortcuts, so a stray key
 *                         on a fleet iPad's hardware keyboard can't seek or mute.
 *  - `color=white`      — a neutral progress bar instead of YouTube red.
 *  - `cc_load_policy=1` + `cc_lang_pref=en` — captions on, in English, rather
 *                         than whatever auto-translation the viewer profile
 *                         would otherwise pick.
 *
 * Deliberately NOT set: `modestbranding` (deprecated by YouTube in 2023, no
 * effect), `showinfo`/`autohide` (removed), `controls=0` (a scholar must be able
 * to pause and re-watch), `fs=0` (fullscreen is legibility, not a distraction).
 */
export function instructionVideoEmbedUrl(
  atom: Pick<InstructionVideoAtom, "videoId" | "startSec" | "endSec">,
): string {
  return (
    `https://www.youtube-nocookie.com/embed/${atom.videoId}` +
    `?start=${atom.startSec}&end=${atom.endSec}&playsinline=1&rel=0` +
    `&iv_load_policy=3&disablekb=1&color=white` +
    `&cc_load_policy=1&cc_lang_pref=en`
  );
}

/**
 * Client-side grader for a `try_it` atom's one faded step. Reuses the SAME pure
 * `parseAnswer`/`answersEqual` path (`rawAnswersEqual`) the server grader and
 * the teach-as-action `TeachingStep` moment use, so representation like `6/8 ≡
 * 3/4` still matches. It is deliberately the ONLY grading a `try_it` does: no
 * mutation, no mastery, no ledger — the atom lives inside decoupled instructional
 * content, so "records nothing" is structural. `answerType` defaults to
 * "integer" when the atom omits it.
 */
export function gradeTryItAtom(
  rawInput: string,
  atom: { exampleAnswer: string; answerType?: AnswerType },
): boolean {
  return rawAnswersEqual(rawInput.trim(), atom.exampleAnswer, atom.answerType ?? "integer");
}

/** A client-safe faded scaffold — the SAME `FadeResult` shape the post-miss
 *  teaching moment's `WorkedSteps` renderer consumes (revealed steps keep their
 *  text; the faded step carries ONLY a blank). */
export type TryItFade = {
  revealed: { text: string }[];
  faded: { blankText: string }[];
  selfExplainPrompt?: string;
};

/** Placeholder for the one faded (answer-producing) step. Matches
 *  `fadedSteps.ts`'s `DEFAULT_BLANK_TEXT`; kept as a local literal so this pure
 *  helper stays vendorable to native without pulling in the mastery/scheduler
 *  module that `applyFade` lives beside. */
export const TRY_IT_BLANK = "___";

/**
 * Fade a `try_it` atom's authored steps for rendering: reveal every step EXCEPT
 * the final, answer-producing one, which is hidden behind a blank the scholar
 * finishes. This is exactly `applyFade(steps, 1)` from
 * `convex/lib/practice/fadedSteps.ts` — an UNGRADED instructional atom reads no
 * scholar mastery, so the fade level is fixed at 1 (never a variable read), which
 * is why this is a tiny specialization rather than a second fade engine. The
 * answer-producing step's text is NEVER in `revealed`, so seeing the scaffold can
 * never leak the answer; the scholar produces it and it's client-graded by
 * `gradeTryItAtom`. Both the web and native `TryItAtom` render this through their
 * `WorkedSteps` twin, so neither shows the steps verbatim.
 */
export function tryItFade(steps: string[]): TryItFade {
  const clean = steps.map((s) => (s ?? "").trim()).filter((s) => s.length > 0);
  if (clean.length === 0) return { revealed: [], faded: [] };
  const revealed = clean.slice(0, -1).map((text) => ({ text }));
  const faded = [{ blankText: TRY_IT_BLANK }];
  return {
    revealed,
    faded,
    selfExplainPrompt:
      revealed.length > 0 ? "Your turn — finish the last step and enter the answer." : undefined,
  };
}

/**
 * The single policy the scholar `LaunchpadCard` obeys before recording ANY
 * instruction-lifecycle mutation (claim/choice/view/completion). Extracted +
 * exported so the "Rehearse (preview) writes nothing" invariant is unit-testable
 * without rendering React: a preview render (teacher "play it") records nothing,
 * and a card with no `scholarId` has no subject to attribute a write to. Only a
 * real scholar view (`preview: false` + a `scholarId`) records.
 */
export function shouldRecordInstruction(opts: {
  preview?: boolean;
  scholarId?: string | null;
}): boolean {
  return !opts.preview && !!opts.scholarId;
}

/**
 * Whether a stored instructional-content key is a STRAND doorway
 * (`strand:<domain>:<strand>`) as opposed to a finer NODE grain
 * (`node:<nodeKey>`). Client-safe twin of the server `parseInstructionKey`
 * discriminator (which lives in the server-only `convex/instruction.ts`): the
 * teacher practice-pool coverage display groups by strand, and a node-grain
 * entry is NOT a strand doorway, so strand rows/counts must read strand keys
 * only. Kept beside `strandInstructionKey` (the matching builder) so the format
 * has one client-safe home.
 */
export function isStrandInstructionKey(key: string): boolean {
  return key.startsWith("strand:");
}

/**
 * The lifecycle mutations the `LaunchpadCard` performs for a UI event, in call
 * order. This is the SINGLE source of truth the card derives its writes from —
 * so "Rehearse (preview) writes nothing" is true BY CONSTRUCTION, not by a
 * parallel gate the renderer could forget. In `preview` (teacher play-it) or
 * with no `scholarId` subject, EVERY event yields an empty plan, so the card
 * invokes no mutation at all. Pure + exported so a vitest can drive the exact
 * seam (execute the plan against real mutations) instead of asserting on a
 * helper the card doesn't use.
 */
export type InstructionWrite =
  | { type: "claimShown" }
  | { type: "recordChoice"; choice: "try" | "show" }
  | { type: "recordViewed" }
  | { type: "recordCompleted" };

export function instructionWritesFor(
  event: "mount" | "tryFirst" | "showMe" | "nowYouTry",
  opts: { preview?: boolean; scholarId?: string | null },
): InstructionWrite[] {
  if (!shouldRecordInstruction(opts)) return [];
  switch (event) {
    case "mount":
      return [{ type: "claimShown" }];
    case "tryFirst":
      return [{ type: "recordChoice", choice: "try" }];
    case "showMe":
      // Viewing the worked example is a terminal engagement (choice + viewed).
      return [{ type: "recordChoice", choice: "show" }, { type: "recordViewed" }];
    case "nowYouTry":
      return [{ type: "recordCompleted" }];
  }
}

export type InstructionEntry = {
  id: string;
  offerId: string;
  kind: "launchpad";
  // The run's frame is always NODE grain now (`selectRunLaunchpad`): the move
  // must be about the framed item, and strand content cannot be shown to be.
  // "strand" stays in the union for resume snapshots minted before the change.
  level: "strand" | "node";
  /** Where the move comes from (`FrameMoveSource`). `item_steps` carries no
   *  atoms — the client renders the item's own TeachingStep. Absent on an
   *  entry minted before 2026-10-10 (a resumed run), which always had atoms. */
  move?: FrameMoveSource;
  key: string;
  target: {
    domain: string;
    strand: string;
    /** Set only when `level === "node"`. */
    nodeKey?: string;
  };
  title: string;
  subtitle?: string;
  fork: { tryFirstLabel: string; showMeLabel: string };
  atoms: InstructionAtom[];
  contentVersion: number;
  /** Structural invariant: a Launchpad NEVER affects mastery/placement/credit. */
  masteryEffect: "none";
};

/** The subset of an `instructionEvents` row the pure rules read. */
export type InstructionEventLike = {
  key: string;
  shownAt?: number | null;
  initialChoice?: "try" | "show" | null;
  viewedAt?: number | null;
  completedAt?: number | null;
  dismissedAt?: number | null;
  offerCount?: number | null;
  lastShownDayBucket?: string | null;
};

/**
 * A Launchpad is permanently suppressed once the scholar has actually engaged
 * with it (viewed / completed) or deliberately dismissed it, OR once it has been
 * re-offered `cap` times while only ever being skipped ("try") — so instruction
 * is persistent but never nagging.
 */
export function isInstructionSuppressed(
  ev: InstructionEventLike | undefined | null,
  cap: number = INSTRUCTION_REOFFER_CAP,
): boolean {
  if (!ev) return false;
  if (ev.viewedAt || ev.completedAt || ev.dismissedAt) return true;
  if ((ev.offerCount ?? 0) >= cap) return true;
  return false;
}

// REMOVED with P1: `anyInstructionShownOn` + `StrandCandidate` +
// `selectInstructionKey` -- the graph-order strand picker that backed the
// retired `instructionForDaily` query. It chose a strand from the whole domain
// graph without consulting the run, which is exactly how a scholar could be
// offered a doorway into a strand the run never served. `selectRunLaunchpad`
// below is now the ONE selector; a second one left alive here would be an
// invitation to re-introduce the same divergence.

// ── The MOVE: what "Not yet — show me" (or a miss) actually shows ──────────
//
// The framed item's move must be about THAT ITEM. A kid who says "I don't know
// how to do this" and gets a lesson about something else has been handed a
// wall, not a move. (Seen live, 2026-10: "Make 45¢ out of nickels and dimes"
// — a skip-count node filed under the mult-divide strand — showed the
// STRAND's "Multiplying counts equal groups… 4 × 3" lesson plus a full eggs
// manipulative.) So the selector frames an item ONLY when an on-topic move
// exists, in this precedence:
//
//   1. "item_steps"   — the item's OWN faded worked step: the existing
//                       teach-as-action moment (`practiceSkills.teachingStep`,
//                       `TeachingStep` on both clients), reused verbatim.
//   2. "node_content" — PASSED instruction content keyed to the item's own
//                       node (`node:<nodeKey>`), compacted to its text +
//                       worked-example atoms (`compactMoveAtoms`).
//   3. Strand content — NEVER. A `strand:` entry is authored for the strand's
//                       core move on its own numbers (convex/seed/
//                       instructionSeed.ts); nothing ties it to any one node,
//                       so it cannot be shown to be about the framed item.
//                       It stays where it belongs: the "See an example" shelf.
//
// An item with neither is simply not framed.

/** Where the framed item's move comes from (see the precedence above). */
export type FrameMoveSource = "item_steps" | "node_content";

/** True when an item's worked steps support the teach-as-action faded step —
 *  the SAME predicate `practiceSkills.teachingStep` uses to decide between the
 *  interactive step and reveal-only (a single-blank fade needs ≥2 steps). One
 *  definition, so "frameable by its own step" can never disagree with "the
 *  teaching moment actually has a step to show". */
export function hasTeachingStep(workedSteps: readonly unknown[] | null | undefined): boolean {
  return (workedSteps?.length ?? 0) >= 2;
}

/** The atom kinds a move may carry inline: words and a worked example. Kids
 *  skip text, so the move is short — explorers, manipulatives, videos and
 *  story hooks stay on the "See an example" shelf, never inline. */
const MOVE_ATOM_KINDS: ReadonlySet<InstructionAtom["kind"]> = new Set<InstructionAtom["kind"]>([
  "micro_explain",
  "worked_example",
]);

/** Compact node content to the inline move: text + worked-example atoms only.
 *  Empty when the content has neither — which makes it no move at all, so the
 *  selector will not frame on it. */
export function compactMoveAtoms(atoms: readonly InstructionAtom[]): InstructionAtom[] {
  return atoms.filter((a) => MOVE_ATOM_KINDS.has(a.kind));
}

/** One served item, reduced to what framing selection needs. */
export type RunItemLike = {
  skillKey: string;
  /** The item's practice domain. Single-domain runs stamp the session domain. */
  domain: string;
  /** The item's strand, if its domain is stranded. Unstranded → never framed. */
  strand?: string;
  /** Serving lane; only genuinely new ground can be framed. */
  lane?: string;
  /** True when THIS item carries its own teach-as-action step
   *  (`hasTeachingStep` over the resolved item's worked steps). */
  hasTeachingStep?: boolean;
};

/**
 * A frame positioned ON a served run: the entry, and the index of the item it
 * frames. Deliberately a SIBLING of `items`, never a member: `items` is the
 * graded array, and keeping an ungraded beat out of it is what makes
 * `masteryEffect: "none"` structural rather than a flag.
 */
export type RunLaunchpad = { at: number; entry: InstructionEntry };

/** The selector's raw pick, before `resolveRunLaunchpad` builds the wire
 *  `InstructionEntry` from it. */
export type RunLaunchpadCandidate = {
  at: number;
  level: "node";
  domain: string;
  strand: string;
  nodeKey: string;
  key: string;
  move: FrameMoveSource;
};

/** The ≤1/day governor: true when some OTHER key was already shown today. */
function dailyCapBlocks(
  eventByKey: Map<string, InstructionEventLike>,
  dayBucket: string,
  key: string,
): boolean {
  // Scoped to OTHER keys, and not a softening of the rule. This selector runs
  // inside the reactive `practiceSession` query, and the client claims its own
  // impression on mount -- which writes `shownAt` for exactly this key. A
  // blanket "anything shown today" test would flip to true the instant the
  // frame appeared and retract the very offer being rendered.
  return [...eventByKey.entries()].some(
    ([k, e]) => k !== key && e.shownAt != null && e.lastShownDayBucket === dayBucket,
  );
}

/** Serving lanes that can carry the framed item. `new` is frontier work;
 *  `review` is admitted because a placement-CREDITED skill the scholar never
 *  actually attempted is served there (the confirmation lane) and is, for the
 *  kid, still new ground. The never-attempted check keeps a genuine review (a
 *  skill really drilled) out. Mapping (a placement probe), challenge, and
 *  stretch (hit-only) are never framed. */
const FRAMEABLE_LANES: ReadonlySet<string> = new Set(["new", "review"]);
export function isFrameableLane(lane: string | undefined): boolean {
  return !!lane && FRAMEABLE_LANES.has(lane);
}

/** Which on-topic move an item has, by precedence — or null (not frameable). */
export function frameMoveFor(
  item: Pick<RunItemLike, "skillKey" | "hasTeachingStep">,
  hasNodeContent: (skillKey: string) => boolean,
): FrameMoveSource | null {
  if (item.hasTeachingStep) return "item_steps";
  if (hasNodeContent(item.skillKey)) return "node_content";
  return null;
}

/**
 * Pick the framed item for a RUN — the "Can you already do this?" pill — and
 * the move it will show.
 *
 * Selection reads FROM the served items, so the frame can only ever sit on
 * work the run contains (the 2026-07 position defect stays unrepresentable),
 * and `at` is that item's index.
 *
 * TRIGGER: the first item, in serve order, that is
 *  - on a frameable lane (`new`, or `review` of inferred credit),
 *  - stranded,
 *  - on a node the scholar has never ATTEMPTED (`lastAttemptAt` or a
 *    demonstrated source — placement credit alone is still new ground),
 *  - and HAS an on-topic move: its own teaching step, else passed node
 *    content (precedence above). Strand content never qualifies.
 * The key is always `node:<nodeKey>`, so the fire-once ledger is per node:
 * once a scholar has seen this node's move (viewed/completed/dismissed, or
 * skipped past the re-offer cap) the node is not framed again.
 *
 * The ≤1/day governor (`dailyCap`, default ON) reads the same `eventByKey`
 * regardless of key kind. Both run clients pass `false` — a pill on a real
 * graded item has nothing to ration. Advisory: a query cannot write, so the
 * claim mutation re-checks authoritatively.
 */
export function selectRunLaunchpad(params: {
  items: RunItemLike[];
  /** True when the scholar has actually attempted THIS node. */
  hasAttemptOnNode: (skillKey: string) => boolean;
  /** True when PASSED `node:<nodeKey>` content with a non-empty compact move
   *  (`compactMoveAtoms`) exists for this skillKey on this platform. */
  hasNodeContent: (skillKey: string) => boolean;
  eventByKey: Map<string, InstructionEventLike>;
  dayBucket: string;
  reofferCap?: number;
  /** The cross-key ≤1/day governor — default ON; the question framing passes
   *  `false`. At most one frame per RUN stays structural (one `launchpad`). */
  dailyCap?: boolean;
}): RunLaunchpadCandidate | null {
  const cap = params.reofferCap ?? INSTRUCTION_REOFFER_CAP;
  const dailyCap = params.dailyCap ?? true;
  for (let at = 0; at < params.items.length; at++) {
    const item = params.items[at];
    if (!isFrameableLane(item.lane)) continue;
    const strand = item.strand;
    if (!strand) continue;
    if (params.hasAttemptOnNode(item.skillKey)) continue;
    const move = frameMoveFor(item, params.hasNodeContent);
    if (!move) continue;
    const key = nodeInstructionKey(item.skillKey);
    if (isInstructionSuppressed(params.eventByKey.get(key), cap)) continue;
    if (dailyCap && dailyCapBlocks(params.eventByKey, params.dayBucket, key)) return null;
    return { at, level: "node", domain: item.domain, strand, nodeKey: item.skillKey, key, move };
  }
  return null;
}

// ── The frame's stage machine (shared by web and native) ───────────────────

/** ask → (nailed | move) → after → done. See PracticeSession's comment. */
export type QuestionFrameStage = "ask" | "move" | "after" | "nailed" | "done";
export type QuestionFrameEvent = Parameters<typeof questionFrameWritesFor>[0];

/**
 * Advance the framed item's stage when the answer machine moves, and name the
 * telemetry events to write. Returns null when nothing changes. Pure, so both
 * clients advance identically.
 *
 *  - right first time → "nailed" (the move is never shown);
 *  - "Not yet" → "move": the item's own teaching step (item_steps) or the
 *    compact node move (node_content);
 *  - a MISS → with node_content, the move + "Got it, let me try one"; with
 *    item_steps, "done" — the teaching step is earned by the honest don't-know
 *    (`teachingStep` is gated on it, #900), so a miss takes the ordinary miss
 *    lane (Socratic retry, then the stuck lane) rather than a second mechanism;
 *  - back to answering after a node_content move → "after"; the next verdict →
 *    "done" (completed).
 */
export function advanceQuestionFrame(
  stage: QuestionFrameStage,
  phase: string,
  verdict: { correct: boolean; dontKnow?: boolean } | null | undefined,
  move: FrameMoveSource,
): { stage: QuestionFrameStage; events: QuestionFrameEvent[] } | null {
  if (stage === "move" && phase === "answering") return { stage: "after", events: [] };
  if (phase !== "feedback" || !verdict) return null;
  if (stage === "ask") {
    if (verdict.correct) return { stage: "nailed", events: ["answered"] };
    // "Not yet" already recorded its choice ("show") on tap.
    if (verdict.dontKnow) return { stage: "move", events: ["moveShown"] };
    if (move === "item_steps") return { stage: "done", events: ["answered"] };
    return { stage: "move", events: ["answered", "moveShown"] };
  }
  if (stage === "after") return { stage: "done", events: ["answeredAfterMove"] };
  return null;
}
