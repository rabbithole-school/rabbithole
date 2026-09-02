/**
 * Instructional "Launchpad" entries (instructional segments v1).
 *
 * A Launchpad is a short, STRAND-LEVEL instructional beat shown the first time a
 * scholar enters a genuinely new strand — the deliberate answer to "the playlist
 * feels too fully Socratic". It sits on the playlist alongside practice but is
 * pure CONTENT: it never grades, never moves mastery, never scores the scholar.
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
  // Node doorway (§4.1): the SAME positioned-sibling mechanics as the strand
  // doorway, just keyed to a node when a NEW-lane item's specific node is
  // zero-mastery and has PASSED `node:<nodeKey>` content — even inside an
  // otherwise partly-known strand (see `selectRunLaunchpad`). Strand takes
  // precedence whenever both are eligible for the same item (the bigger
  // moment wins); `level` tells the client/teacher-preview which grain fired,
  // though today's card renders both identically (title/atoms only).
  level: "strand" | "node";
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

/** One served item, reduced to what Launchpad selection needs. */
export type RunItemLike = {
  skillKey: string;
  /** The item's practice domain. Single-domain runs stamp the session domain. */
  domain: string;
  /** The item's strand, if its domain is stranded. Unstranded → no Launchpad. */
  strand?: string;
  /** Serving lane; only genuinely NEW frontier work can open a Launchpad. */
  lane?: string;
};

/**
 * Pick the Launchpad for a RUN — the strand OR node to introduce, AND the
 * exact item index to introduce it before.
 *
 * THIS IS THE FIX FOR THE POSITION DEFECT. The previous selector
 * (`selectInstructionKey`, still used by the legacy daily query) chose a strand
 * by walking the whole domain graph in node order and never looked at the
 * playlist, while the queue picked its own frontier independently and the client
 * mounted the result at `idx === 0`. The two routinely disagreed, so a scholar
 * could be handed a doorway into a strand the run never served (reproduced
 * 18/18 configurations).
 *
 * Selecting FROM the served items makes that class of bug unrepresentable rather
 * than merely fixed: the returned strand/node is, by construction, drawn from
 * `items[at]`, so it cannot name work the run does not contain, and `at` is the
 * position of the work it introduces rather than a hardcoded zero.
 *
 * Precedence, evaluated PER ITEM in serve order (§4.1 node doorway):
 *  1. STRAND doorway — the bigger moment, so it wins whenever eligible at this
 *     item: NEW-lane, stranded, no mastery ANYWHERE in the strand (expertise-
 *     reversal guard), PASSED `strand:` content, not suppressed.
 *  2. Else NODE doorway — the SAME item's specific node, when the scholar has
 *     zero mastery on THAT NODE (narrower than the strand check — this is what
 *     lets a hard node re-open instruction even inside an otherwise
 *     partly-known, or dismissed, strand) and PASSED `node:` content exists,
 *     not suppressed. Optional: a caller that omits `hasMasteryOnNode`/
 *     `hasNodeContent` gets strand-only behavior, byte-identical to pre-§4.1.
 *  3. Neither eligible at this item → try the next item.
 *
 * The ≤1/day governor is EXTENDED, not duplicated (§4.1 decision b): it reads
 * the SAME `eventByKey` map regardless of which key kind (`strand:`/`node:`)
 * was actually shown, so "any Launchpad already shown today" and the re-offer
 * cap are shared across BOTH grains for free — a strand shown today blocks a
 * node offer and vice versa, and a node's own `offerCount` caps its re-offers
 * exactly like a strand's.
 *
 * Advisory, exactly like `selectInstructionKey` — a Convex query cannot write,
 * so the claim mutation re-checks the daily cap authoritatively.
 */
/**
 * A Launchpad positioned ON a served run: the entry to show, and the index of
 * the first item of the strand/node it introduces.
 *
 * Deliberately a SIBLING of `items`, never a member of it. `items` is the graded
 * array; keeping an ungraded beat out of it is what makes `masteryEffect:
 * "none"` a structural guarantee rather than a flag some future code path could
 * forget to honour.
 */
export type RunLaunchpad = { at: number; entry: InstructionEntry };

/** The selector's raw pick, before the caller (`resolveRunLaunchpad`) resolves
 *  it against loaded content to build the wire `InstructionEntry`. */
export type RunLaunchpadCandidate = {
  at: number;
  level: "strand" | "node";
  domain: string;
  strand: string;
  /** Set only when `level === "node"`. */
  nodeKey?: string;
  key: string;
};

/** The ≤1/day governor: true when some OTHER key (either grain) was already
 *  shown today. Shared across strand/node keys by construction — it just reads
 *  `eventByKey`, which stores both grains under one scholar-keyed table. */
function dailyCapBlocks(
  eventByKey: Map<string, InstructionEventLike>,
  dayBucket: string,
  key: string,
): boolean {
  // Scoped to OTHER keys, and not a softening of the rule. This selector runs
  // inside the reactive `practiceSession` query, and the card claims its own
  // impression on mount -- which writes `shownAt` for exactly this key. A
  // blanket "anything shown today" test would therefore flip to true the
  // instant the card appeared and retract the very offer being rendered,
  // yanking the card off-screen before the scholar could choose a path. (That
  // is the precise failure the old client-side `launchpadLatchRef` existed to
  // hide; scoping the check removes the cause instead of the symptom.)
  //
  // Excluding this key is also the behaviour we want on its own merits: an
  // unengaged doorway survives a reload, while `isInstructionSuppressed`
  // above still retracts it the moment the scholar views/completes/dismisses
  // it. Instruction for a DIFFERENT key (strand OR node) is still capped at
  // one per day.
  return [...eventByKey.entries()].some(
    ([k, e]) => k !== key && e.shownAt != null && e.lastShownDayBucket === dayBucket,
  );
}

export function selectRunLaunchpad(params: {
  items: RunItemLike[];
  /** True when the scholar has ANY mastery row in the strand → not new. */
  hasMasteryInStrand: (domain: string, strand: string) => boolean;
  /** True when PASSED, non-empty instructional content exists for the strand. */
  hasContent: (domain: string, strand: string) => boolean;
  /** Node doorway (§4.1): true when the scholar has ANY mastery row on THIS
   *  specific node — finer than `hasMasteryInStrand`, which is exactly what
   *  lets a hard node qualify even inside a strand that already has mastery
   *  elsewhere. Optional; omitting it (with `hasNodeContent`) disables the
   *  node doorway entirely for strand-only callers. */
  hasMasteryOnNode?: (skillKey: string) => boolean;
  /** Node doorway: true when PASSED, non-empty `node:<nodeKey>` content exists
   *  for this item's skillKey. Optional, same reason as `hasMasteryOnNode`. */
  hasNodeContent?: (skillKey: string) => boolean;
  eventByKey: Map<string, InstructionEventLike>;
  dayBucket: string;
  reofferCap?: number;
}): RunLaunchpadCandidate | null {
  const cap = params.reofferCap ?? INSTRUCTION_REOFFER_CAP;
  const nodeDoorwayEnabled = !!params.hasMasteryOnNode && !!params.hasNodeContent;
  for (let at = 0; at < params.items.length; at++) {
    const item = params.items[at];
    if (item.lane !== "new") continue;
    const strand = item.strand;
    if (!strand) continue;

    // 1. STRAND doorway — the bigger moment; wins whenever eligible here.
    if (!params.hasMasteryInStrand(item.domain, strand) && params.hasContent(item.domain, strand)) {
      const key = strandInstructionKey(item.domain, strand);
      if (!isInstructionSuppressed(params.eventByKey.get(key), cap)) {
        if (dailyCapBlocks(params.eventByKey, params.dayBucket, key)) return null;
        return { at, level: "strand", domain: item.domain, strand, key };
      }
      // Suppressed at this item — fall through to a node check on the SAME
      // item rather than skipping to the next one; a dismissed strand doorway
      // shouldn't block a still-eligible node doorway on the very item it
      // would have introduced.
    }

    // 2. NODE doorway (§4.1) — the SAME item's own node, zero-mastery on that
    // node specifically (not the whole strand).
    if (nodeDoorwayEnabled && !params.hasMasteryOnNode!(item.skillKey) && params.hasNodeContent!(item.skillKey)) {
      const key = nodeInstructionKey(item.skillKey);
      if (!isInstructionSuppressed(params.eventByKey.get(key), cap)) {
        if (dailyCapBlocks(params.eventByKey, params.dayBucket, key)) return null;
        return { at, level: "node", domain: item.domain, strand, nodeKey: item.skillKey, key };
      }
    }
  }
  return null;
}
