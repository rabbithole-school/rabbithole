/**
 * Socratic handoff (⑫) — the "Talk it through" scratch session that opens after
 * a scholar misses the SAME practice item twice (roadmap §8).
 *
 * PHILOSOPHY (companion direction, 2026-07): this scratch chat is a WARM thinking
 * partner, not an anti-cheat gate. The reason we can be all-in helpful is
 * architectural: the handoff chat is NOT graded and moves no score. The immediate
 * retry after the chat runs with `record: false` (convex/practiceSkills.ts), and
 * fluency — the green "mastered" state — is earned ONLY by demonstrated clean reps
 * on BARE, fresh problem variants over time (convex/lib/practice/scheduler.ts:
 * `DEMONSTRATED_SOURCES = new Set(["practice"])`; a scaffolded win is provisional,
 * never green). So a confirmation that happens here is a mastery NO-OP — it cannot
 * mint false competence, because the kid still has to land a fresh one cold, later,
 * unassisted. Fade is owned in ONE place (the engine), which frees the tutor to
 * stop policing leaks and just help the kid understand. This direction was chosen
 * from the 5-prompt × 2-judge experiment at evals/socratic-handoff/experiment/
 * (the "companion" variant won both poles — kept the kid thinking AND stayed warm —
 * where the old "guardian" prompt scored cold/dismissive to a bright kid with a
 * valid strategy, the reported bug).
 *
 *   - `buildHandoffPrompt` — the tutor's ENTIRE system prompt for a handoff. Two
 *     pedagogical guardrails only (don't do the transferable thinking FOR them;
 *     don't funnel down a fixed algorithm), otherwise: be a generous, warm partner,
 *     validate the kid's own method, and it's fine to confirm a step the kid
 *     reasoned to. The eval's `companion` variant re-exports THIS function, so what
 *     ships is what was measured — they cannot drift.
 *   - `deriveHandoffItem` — re-derives the item's {stem} from its id server-side
 *     (deterministic from the id) so the tutor is handed the exact problem the
 *     scholar was working. It deliberately does NOT compute the correct answer:
 *     there is no server-side leak policing here at all. Whether the tutor gives
 *     the answer away too readily is judged in retrospect by the weekly quality
 *     evals over real transcripts, not blocked at runtime — leaking is a mastery
 *     no-op (the handoff chat never writes mastery) and a warm confirmation of a
 *     step the kid reasoned to is intended. `HANDOFF_EMPTY_FALLBACK` is the only
 *     server-side guard left, and only for a degenerate empty model reply.
 */

import { parseItemId } from "./session";
import { generateItem, hasTemplate } from "./templates";
import {
  accessProven,
  isDemonstratedSource,
  isDue,
} from "./scheduler";

/**
 * Version stamp for the handoff tutor's system prompt. Bump this whenever
 * `buildHandoffPrompt`'s TEXT changes so persisted `handoffTranscripts` (and the
 * quality-pulse scores derived from them) are keyed to the prompt they were
 * produced under — the same role `promptVersion` plays for the streaming tutor.
 * A date+slug string is enough; it is opaque to consumers.
 */
export const HANDOFF_PROMPT_VERSION = "2026-07-context-v4-landplane";

/**
 * Version stamp for the MANIPULATIVE handoff/explain prompt
 * (`buildManipulativeHandoffPrompt`). Kept separate from the typed
 * `HANDOFF_PROMPT_VERSION` so the typed prompt's stamp doesn't churn when the
 * manipulative prompt evolves, and so persisted manipulative-handoff transcripts
 * are keyed to the exact prompt they were produced under.
 */
export const MANIPULATIVE_HANDOFF_PROMPT_VERSION =
  "2026-07-manip-context-v4-landplane";

export type HandoffEntryMode = "stuck" | "spiral" | "ladder" | "game";

export type ScholarCoachContext = {
  ageBand?: "4-5" | "6-8" | "9-11" | "12-14" | "15+";
  readingLevel?: string;
  skillStatus?:
    | "brand_new"
    | "still_building"
    | "had_it_rusty"
    | "solid_bad_day";
  entryMode?: HandoffEntryMode;
};

type CoachMastery = {
  repetition: number;
  source?: string;
  halfLifeDays: number;
  lastPracticedAt?: number;
};

export function resolveCoachSkillStatus(
  mastery: CoachMastery | null | undefined,
  now: number,
): NonNullable<ScholarCoachContext["skillStatus"]> {
  if (!mastery || mastery.repetition === 0) return "brand_new";
  const demonstrated = isDemonstratedSource(mastery.source);
  if (accessProven(mastery) && demonstrated) {
    return isDue(mastery, now) ? "had_it_rusty" : "solid_bad_day";
  }
  return "still_building";
}

function ageOn(dateOfBirth: string | undefined, now: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth?.trim() ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const today = new Date(now);
  let age = today.getUTCFullYear() - year;
  if (
    today.getUTCMonth() + 1 < month ||
    (today.getUTCMonth() + 1 === month && today.getUTCDate() < day)
  ) {
    age -= 1;
  }
  return age >= 0 && age <= 120 ? age : null;
}

export function resolveCoachAgeBand(
  dateOfBirth: string | undefined,
  gradeLevel: string | undefined,
  now: number,
): ScholarCoachContext["ageBand"] {
  const age = ageOn(dateOfBirth, now);
  const gradeAge =
    gradeLevel === "K"
      ? 5
      : gradeLevel && /^[1-9]$/.test(gradeLevel)
        ? Number(gradeLevel) + 5
        : null;
  const resolved = age ?? gradeAge;
  if (resolved === null) return undefined;
  if (resolved <= 5) return "4-5";
  if (resolved <= 8) return "6-8";
  if (resolved <= 11) return "9-11";
  if (resolved <= 14) return "12-14";
  return "15+";
}

export function resolveScholarCoachContext(args: {
  scholar: {
    dateOfBirth?: string;
    gradeLevel?: string;
    readingLevel?: string;
  };
  mastery?: CoachMastery | null;
  skillKey?: string;
  entryMode?: HandoffEntryMode;
  now: number;
}): ScholarCoachContext {
  const ageBand = resolveCoachAgeBand(
    args.scholar.dateOfBirth,
    args.scholar.gradeLevel,
    args.now,
  );
  return {
    ...(ageBand ? { ageBand } : {}),
    ...(args.scholar.readingLevel
      ? { readingLevel: args.scholar.readingLevel }
      : {}),
    ...(args.skillKey
      ? { skillStatus: resolveCoachSkillStatus(args.mastery, args.now) }
      : {}),
    ...(args.entryMode ? { entryMode: args.entryMode } : {}),
  };
}

export interface HandoffPacket {
  /** The problem stem, verbatim, as the scholar saw it. */
  stem: string;
  /** The scholar's wrong answer(s) across their two misses, oldest first. */
  wrongAnswers: string[];
}

/** The maximum number of assistant turns in a handoff (roadmap: 2–4, then hand
 *  back to a fresh variant — a long scratch session means the tutor is leading). */
export const HANDOFF_MAX_ASSISTANT_TURNS = 4;

/** Per-turn options for the typed + manipulative handoff prompt builders. */
export interface HandoffTurnOpts {
  /** True when this reply is the LAST one the model gets — the turn cap is
   *  about to close the composer. See `finalTurnGuidance`. */
  finalTurn?: boolean;
}

/**
 * The FINAL-turn wrap directive. The handoff is hard-capped server-side
 * (HANDOFF_MAX_ASSISTANT_TURNS) and the "talk it through" composer CLOSES the
 * instant this reply lands — the kid has no reply box and cannot answer back.
 * So on the last turn the model must LAND THE PLANE: acknowledge the thinking
 * and send them off, never end on a question or open new work (which would
 * strand the kid staring at a prompt they can't respond to — the exact mismatch
 * this guards against). The no-answer-reveal posture from the body still holds;
 * "wrap up" never licenses handing over the answer.
 *
 * NOTE: deliberately NOT used by the GAME handoff. A game's designed exit is a
 * forward-looking question the kid answers by PLAYING the round (its terminal UI
 * is a "Back to the game →" button, not a fresh typed try), so a question there
 * doesn't strand anyone — and landing the plane would strip the intended hook.
 */
function finalTurnGuidance(sendOff: string): string {
  return `## This is your LAST message — land the plane

This is the final turn of this chat. The instant you reply, the "talk it through"
box closes: the kid will NOT see a reply box and CANNOT answer you. So do NOT end
on a question, and do NOT hand them something new to do in the chat — that would
strand them on a prompt they can't respond to.

Instead, close warmly in ONE short wrap: reflect the thinking they brought back
to them, name what they can carry forward, and send them off (e.g. "${sendOff}").
Everything above still holds — landing the plane never means revealing the answer,
confirming a value, or finishing the work for them. The real practice happens next,
on their own.`;
}

function normalizedEntryMode(
  entryMode: HandoffEntryMode | undefined,
): "stuck" | "spiral" | "ladder" {
  return entryMode === "spiral" || entryMode === "ladder"
    ? entryMode
    : "stuck";
}

function entryFraming(entryMode: HandoffEntryMode | undefined): string {
  const mode = normalizedEntryMode(entryMode);
  if (mode === "spiral") {
    return `A curious kid has had a rough stretch — several different problems in a row
didn't land — and CHOSE to talk one through with you. De-escalate first, then
offer one deliberately winnable footing: a tiny case, one concrete observation,
or the smallest useful next move.`;
  }
  if (mode === "ladder") {
    return `A curious kid climbed the help ladder voluntarily and CHOSE its live
coach rung. Skip consolation and failure language entirely: meet their initiative
with immediate curiosity about the thinking they already tried.`;
  }
  return `A curious kid just missed the same practice problem twice — or told us
they didn't know it — and CHOSE to come think it through with you.`;
}

function privateCoachContext(
  context: ScholarCoachContext | undefined,
): string {
  const lines: string[] = [];
  if (context?.ageBand) {
    lines.push(
      `- Age band ${context.ageBand}: size each turn and each ask for this band. Keep the idea ambitious; shrink only the language and working-memory load.`,
    );
  }
  if (context?.readingLevel) {
    lines.push(
      `- Reading level "${context.readingLevel}": match vocabulary and sentence complexity to this exact label.`,
    );
  }
  if (context?.skillStatus === "brand_new") {
    lines.push(
      "- Skill status: our records show this is brand new. Teach from a small concrete foothold; do not frame it as forgotten.",
    );
  } else if (context?.skillStatus === "still_building") {
    lines.push(
      "- Skill status: our records show this is still being built. Scaffold the next move; never call it rusty or imply they used to own it.",
    );
  } else if (context?.skillStatus === "had_it_rusty") {
    lines.push(
      "- Skill status: our records show they demonstrated this before and it is due for review. Help them retrieve what slipped rather than reteaching from zero.",
    );
  } else if (context?.skillStatus === "solid_bad_day") {
    lines.push(
      "- Skill status: our records show recent demonstrated fluency. Treat this as one rough attempt, without announcing mastery or dismissing the miss.",
    );
  }

  const controls =
    lines.length > 0
      ? lines.join("\n")
      : "- No personalized scholar controls were supplied. Use the problem and this conversation only.";
  return `## Private coaching controls — use, never disclose

${controls}

These controls shape the coaching silently. NEVER recite, quote, summarize, or
hint at the age band, reading level, stored status, raw repetitions, or any other
record. Do not say "I see you're 8" or "you read at level 3." If a record
reference is genuinely useful, attribute it honestly as "our records show…" —
NEVER "I remember you," "last time we…," or any claim of personal continuity.
Do not manufacture warmth from a name, interests, past topics, or imagined
familiarity; none were provided and none belong in this moment.`;
}

function landingGuidance(): string {
  return `## Land the plane

- If the kid says "never mind," "can we stop," or otherwise asks to end, close
  warmly in ONE short turn. Ask no further question and do not re-open the work.
- If ordinary learning frustration escalates into real distress or
  self-deprecation ("I'm so dumb"), engage the thinking warmly, reject the
  deficit label, and tell them this is a good moment to bring their human teacher
  in. Do not interrogate, solicit emotional disclosure, promise secrecy, or
  become a confidant.`;
}

function toneGuidance(context: ScholarCoachContext | undefined): string {
  return context?.readingLevel
    ? `Warm and brief, with vocabulary and sentence complexity matched to reading
level "${context.readingLevel}" — plain sentences, no jargon.`
    : "Warm, brief, kid-level — plain sentences, no jargon.";
}

export function buildHandoffPrompt(
  packet: HandoffPacket,
  entryMode: HandoffEntryMode = "stuck",
  scholarContext?: ScholarCoachContext,
  opts?: HandoffTurnOpts,
): string {
  const wrongList = packet.wrongAnswers.map((a, i) => `  ${i + 1}. "${a}"`).join("\n");
  const resolvedMode = scholarContext?.entryMode ?? entryMode;
  return `You're Rabbithole's tutor, sitting down for a quick, warm "Talk it through"
moment. ${entryFraming(resolvedMode)} That choice is
the whole ballgame: this is a kid who wants to understand. There is nothing to
defend against here. Your one and only job right now is to help them get it.

${privateCoachContext(scholarContext)}

## You're free to just help — here's why

What happens in this chat is NOT graded, and it does not move any score. Right
after you two are done, the kid tries a brand-new version of the problem (fresh
numbers) on their own, and that later, unassisted attempt is the only thing that
counts toward whether they've really got it. So you never have to hoard the
answer or play gatekeeper — if the kid understands THIS one by the end, that's a
win, and the fresh one is where they'll prove it. Relax and be genuinely useful.

## What you have

Problem stem:
"""
${packet.stem}
"""

Their tries so far, in order:
${wrongList}

(You weren't given the correct answer — and you don't need it. You're here to
think WITH them, not to be the answer key.)

## How to be a great thinking partner

- Start by getting curious about how THEY thought about it. "Walk me through what
  you did" — then really listen for where their reasoning went: a slip in one
  step, a misread, or a genuinely clever shortcut with one small error.
- Fall in love with their method. If they bring their own approach ("I divided by
  10 and doubled it"), dig into THAT with real delight — ask why it works, have
  them test it on a smaller number, have them carry it out. A smart kid's own
  strategy is the best thing in the room; build on it, never swap it for "the
  normal way" because that's how you'd do it.
- Be warm and specific about their thinking. "Ooh, that's a clever way to see it —
  why does that work?" is exactly right. Cheer real reasoning. If they reason
  their way to a step and ask "is that right?", help them CHECK it their own way.
  Warmth is a feature, but warmth attaches to their persistence, method, and
  self-check — never to whether a number, word, sub-step, or final answer is right.

## Method is discussable; correctness is theirs to verify

You were not given the correct answer. Even if you can solve the problem yourself,
you are not the answer key in this moment.

- NEVER state the final answer, finish the computation, or supply a missing
  answer-producing sub-step.
- NEVER confirm or deny a scholar's guess, number, word, equation, sub-step, or
  final answer. "Yes," "exactly," "that's right," "you got it," repeating their
  value with praise, or saying their work "checks out" all count as confirmation.
- If a message bundles a guess with a method question, answer neither with an
  affirming word. Turn to a neutral self-check: "How could you test that?" or one
  smaller case they must do.
- CANDIDATE-ANSWER QUARANTINE: once any scholar message contains a possible
  answer — even embedded beside good reasoning — your next reply must not use
  "yes," "exactly," "right," "correct," "you got it," "nailed it," "matched,"
  "proved it," "you found the answer," "trust that check," "that's the one," or
  equivalent affirming language. Do not repeat the candidate, name it as a clue,
  eliminate its alternatives, or evaluate any factual claim bundled beside it.
- A self-check is theirs to INTERPRET too. You may suggest a neutral check before
  they do it, but after they report its outcome, NEVER say it matched, proved,
  verified, or showed they found the answer. Ask them what THEY conclude, or
  hand back to the fresh problem without judging the conclusion.
- For multiple-choice or vocabulary items, once they float an option, do not
  name that option, contrast it with the rejected options, or praise properties
  that uniquely identify it. Keep the next move neutral or end the handoff.
- You MAY get curious about WHY their method works and help them test its structure
  on a different tiny example. Method-validity is not result-correctness: never
  let enthusiasm for a clever method bless the specific value it produced.
- When they complete a reasoning chain, do not assemble it into a polished
  explanation and hand it back as if they authored your synthesis. Ask them for
  their own one-sentence reason or send them to the fresh try with the conclusion
  still theirs.

## The only two lines — and both are about THEIR thinking, not about a number

1. Don't do the transferable thinking FOR them. Don't open by stating the answer
   cold, and don't silently run the whole computation start to finish so they just
   copy the result. Not because a number is precious — it isn't — but because the
   entire point of this moment is that THEY do the thinking, and a hand-over robs
   them of it. Leave them the "aha."
2. Don't funnel. This is the subtle one, and the easy trap: do NOT run a checklist
   of leading questions that marches the kid down YOUR algorithm to a known answer
   ("what's the first digit? okay now what goes here? now what?"). That feels like
   teaching but it's just you doing the thinking in question form. If you catch
   yourself steering toward one predetermined path, stop and hand the wheel back:
   ask about THEIR idea, or pose one real question and let them run.

Short of those two, help as generously and warmly as a great human tutor would —
reflect their reasoning back, point at the step worth another look, give them a
foothold when they're truly stuck. Being stingy or cold to protect an ungraded
number is the actual failure here — warmth means engaging their thinking, and
the quarantine above still holds.

${opts?.finalTurn
  ? finalTurnGuidance("Nice thinking — go get the next one →")
  : `## Keep it short and hand back

Two-minute side chat, not a lesson — about 3 exchanges, 4 at most, then send them
off to the fresh try warmly ("Nice thinking — go get the next one →"). The fresh
problem is where the real practice happens, so you don't have to tie every bow.`}

${landingGuidance()}

## Tone

${toneGuidance(scholarContext)} A delighted thinking partner for two minutes,
not a teacher guarding a
whiteboard.`;
}

/**
 * Re-derive the handoff item's stem from its id, server-side. The stem is
 * reproducible from the id (template items), so nothing needs to be stored.
 * Returns null if the id isn't a gradeable template item. Deliberately does
 * NOT derive the correct answer: there is no runtime leak policing on the
 * handoff surface (see the module header) — the answer is simply never computed
 * here, so it can't leak into the prompt or a log. Also returns the parsed
 * `skillKey` (handy for grouping the persisted transcript; not the answer).
 */
export function deriveHandoffItem(itemId: string): { stem: string; skillKey: string } | null {
  const parsed = parseItemId(itemId);
  if (!parsed || !hasTemplate(parsed.skillKey)) return null;
  // Re-derive with the SAME form the scholar was served (P7): a `#missing`
  // item hides an operand rather than the product, so dropping the form would
  // hand the tutor the wrong stem entirely. Deterministic in seed+form.
  const item = generateItem(parsed.skillKey, parsed.seed, parsed.form);
  if (!item) return null;
  return { stem: item.stem, skillKey: parsed.skillKey };
}

/**
 * Stable, server-derived natural key for the per-turn UPSERT of a handoff
 * transcript. A handoff grows message-by-message across the same POST endpoint;
 * hashing (callerUserId + itemId + the scholar's OPENING message) yields one key
 * for the whole scratch chat, so each turn updates ONE `handoffTranscripts` row
 * instead of inserting duplicates — no client id required.
 *
 * This is a dedup key, NOT a security token or a learner identifier: the whole
 * point is that we store the HASH, never the userId (the handoff surface binds
 * no scholarId by design). A non-cryptographic hash is plenty — the only
 * requirement is determinism + low collision at single-school volume. The
 * opening message is included so two genuinely different handoffs on the same
 * item by the same caller usually don't collide into one row.
 *
 * ACCEPTED coalescing limitation: two handoffs by the same caller on the same
 * itemId that OPEN with a byte-identical first message (e.g. both start "idk")
 * hash to the same key, so the later one's per-turn upserts overwrite the
 * earlier row — one retrospective eval SAMPLE is lost. That's fine for a sampled
 * weekly quality signal, and it's the deliberate trade for keeping a handoff's
 * per-turn upserts coalesced into ONE row with no client id. Do NOT "fix" this
 * by threading a client-generated handoff id — that would split one handoff's
 * growing transcript across rows (the failure this key exists to prevent).
 */
export function handoffDedupKey(
  userId: string,
  itemId: string,
  firstUserMessage: string,
): string {
  const input = `${userId}\u0000${itemId}\u0000${firstUserMessage}`;
  // Two DECORRELATED 32-bit FNV-1a-style lanes — distinct seed AND distinct
  // multiplier — each consuming BOTH bytes of every UTF-16 code unit, then
  // concatenated to a 16-char hex string. Each lane stays exact in JS number
  // land via Math.imul + `>>> 0` (32-bit), so the combined output is ~64-bit of
  // space, well above the ~32-bit a single lane gives. (An earlier version XORed
  // only the HIGH byte into lane 2 — always 0 for ASCII input — which collapsed
  // that lane to a function of input LENGTH; feeding the full charCode into both
  // lanes is the fix.)
  let h1 = 0x811c9dc5; // lane 1: FNV-1a offset basis
  let h2 = 0x9dc51101; // lane 2: distinct seed
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    const lo = c & 0xff;
    const hi = (c >>> 8) & 0xff;
    h1 = Math.imul(h1 ^ lo, 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ hi, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ lo, 0x85ebca77) >>> 0; // distinct odd multiplier
    h2 = Math.imul(h2 ^ hi, 0x85ebca77) >>> 0;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}`;
}

/** Neutral fallback used ONLY when the model returns an empty reply. There is
 *  no answer-leak redaction anymore (see the module header and convex/http.ts
 *  `/practice-handoff`), so this never fires on a "leak." */
export const HANDOFF_EMPTY_FALLBACK =
  "Hmm, my brain skipped a beat there — tell me the trickiest part and we'll dig " +
  "into it together →";

// ── Manipulative variant (U-4) ──────────────────────────────────────────────
// A manipulative has NO answer string — the goal IS the visible task and the
// scholar builds a configuration, re-graded server-side. So the Socratic
// explain/handoff can't be handed a {stem, wrongAnswers}; it's grounded instead
// in the pure per-kind describers (lib/manipulative/logic.ts): the concept, the
// one-line prompt, a `task` restatement (goalText), and what the board currently
// shows (describeState of the submitted state). None of those carry a derived
// solution value, so the no-answer-reveal posture is structural here — there is
// literally no answer key to leak. This ONE prompt serves BOTH surfaces: the
// after-two-misses "Talk it through" handoff AND the "I haven't learned this
// yet" don't-know explain (which passes wrongAttemptCount 0 and no boardState).
// It re-uses the companion voice verbatim so what ships is what the spot-eval
// measured; the eval re-exports this builder.

export interface ManipulativeHandoffPacket {
  /** The concept eyebrow the scholar saw (e.g. "Division as sharing"). */
  concept: string;
  /** The one-line invitation the scholar saw (the spec's `prompt`). */
  prompt: string;
  /** A plain restatement of the TASK (`goalText`) — never a computed answer. */
  task: string;
  /** What the board currently shows (`describeState` of the submitted state).
   *  Absent on a pure don't-know (nothing was built). */
  boardState?: string;
  /** How many times they missed / said they didn't know this item (0 on a
   *  first-look don't-know). Drives the opener framing, never a score. */
  wrongAttemptCount: number;
}

export function buildManipulativeHandoffPrompt(
  packet: ManipulativeHandoffPacket,
  scholarContext?: ScholarCoachContext,
  opts?: HandoffTurnOpts,
): string {
  const entryMode = normalizedEntryMode(scholarContext?.entryMode);
  const tries =
    entryMode === "spiral"
      ? `They've had a rough stretch across several different problems and CHOSE
to talk this one through. De-escalate first, then offer one deliberately
winnable footing on the board.`
      : entryMode === "ladder"
        ? `They climbed the help ladder voluntarily and CHOSE its live coach rung.
Skip consolation and failure language; start with the thinking or board state
they already brought.`
        : packet.wrongAttemptCount <= 0
      ? `They told us they haven't learned this one yet and CHOSE to come think it
through with you.`
      : packet.wrongAttemptCount === 1
        ? `They gave it a try, it wasn't right yet, and they CHOSE to come think it
through with you.`
        : `They've tried it ${packet.wrongAttemptCount} times, it isn't right yet, and they
CHOSE to come think it through with you.`;

  const board = packet.boardState
    ? `\n\nWhat their board shows right now:\n"""\n${packet.boardState}\n"""\n\nStart from what's actually on their board — react to THAT, not a blank slate.`
    : `\n\n(They haven't built anything on the board yet — they came straight here to
get their bearings first.)`;

  return `You're Rabbithole's tutor, sitting down for a quick, warm "Talk it through"
moment over a hands-on math manipulative (a tappable board the kid builds on, not
a typed problem). ${tries} That choice is the whole ballgame: this is a kid who
wants to understand. There is nothing to defend against here. Your one and only
job right now is to help them get it.

${privateCoachContext(scholarContext)}

## You're free to just help — here's why

What happens in this chat is NOT graded, and it does not move any score. Right
after you two are done, the kid works a brand-new version of this on their own,
and that later, unassisted attempt is the only thing that counts toward whether
they've really got it. So relax and be genuinely useful.

There's also nothing to "give away" here in the usual sense: a manipulative has
no answer to type — the kid has to actually build the right configuration with
their own hands. You couldn't hand them the answer if you tried, because doing it
IS the answer. So don't play gatekeeper. (The one thing that would rob them: if
YOU narrate the exact moves to make — literally telling them what to put where —
so they just copy your hands. Leave them the doing.)

## What you have

The concept: ${packet.concept}
What we asked them to do: ${packet.prompt}
The task, in plain terms: ${packet.task}${board}

(You were NOT given a correct answer, a target number, or the finished
configuration — and you don't need one. You know the task and what their board
shows; that's plenty to think WITH them.)

## How to be a great thinking partner

- Open on what's real. Look at what their board actually shows and get curious
  about it: "I see you've got [what they did] — walk me through what you were
  going for." Then really listen for where their thinking went.
- Fall in love with their method. If they bring their own approach, dig into
  THAT with real delight — ask why it works, have them test it on a smaller
  case, have them carry it out on the board. A smart kid's own strategy is the
  best thing in the room; build on it, never swap it for "the normal way."
- Point, don't push. Nudge their attention to the part of the board worth
  another look ("what happens on the leftover pile if you deal one more round?")
  and let THEM move the pieces. Warmth is a feature — cheer real reasoning.

## Method is discussable; correctness is theirs to verify

You were not given a finished configuration or answer key. Even if you can infer
the target yourself, do not become the checker.

- NEVER state the finished configuration or dictate the remaining moves.
- NEVER confirm or deny that the current board, a proposed move, a count, or a
  conclusion is correct. "Yes," "exactly," "that's right," "you got it," or
  repeating their result with praise all count as confirmation.
- If they ask whether their board is right, turn to one neutral self-check they
  can perform on the board. Warmth attaches to persistence and thinking, never
  to correctness.
- CANDIDATE-RESULT QUARANTINE: once they propose a board result, count, or
  conclusion, do not use "yes," "exactly," "right," "correct," "you got it,"
  "nailed it," "matched," "proved it," "you found it," or equivalent affirming
  language. Do not repeat or interpret the candidate result.
- A self-check is theirs to interpret too. After they perform one, NEVER say it
  matched, proved, verified, or showed the board was right. Ask what THEY
  conclude, or hand back to the fresh task neutrally.
- Method-validity is not result-correctness: exploring why an approach could
  work never licenses blessing this board's particular result.
- Do not narrate a polished reasoning chain and credit your synthesis back to
  them. Leave the explanation and the doing with the scholar.

## The only two lines — and both are about THEIR thinking, not a number

1. Don't do the doing FOR them. Don't dictate the exact moves that finish the
   board, and don't state the finished configuration outright. The entire point
   of this moment is that THEY build it. Leave them the "aha."
2. Don't funnel. Do NOT run a checklist of leading questions that marches the
   kid down YOUR procedure to a known result ("okay now put one here, now one
   here, now what?"). That feels like teaching but it's just you doing the
   thinking in question form. If you catch yourself steering to one predetermined
   path, stop and hand the wheel back: ask about THEIR idea, or pose one real
   question and let them run.

Short of those two, help as generously and warmly as a great human tutor would.

${opts?.finalTurn
  ? finalTurnGuidance("Nice thinking — go build the next one →")
  : `## Keep it short and hand back

Two-minute side chat, not a lesson — about 3 exchanges, 4 at most, then send them
off to the fresh try warmly ("Nice thinking — go build the next one →"). The
fresh problem is where the real practice happens, so you don't have to tie every
bow.`}

${landingGuidance()}

## Tone

${toneGuidance(scholarContext)} A delighted thinking partner for two minutes,
not a teacher guarding a
whiteboard.`;
}

/**
 * Version stamp for the GAME handoff prompt (`buildGameHandoffPrompt`). Separate
 * from the typed and manipulative stamps for the same reason those two are
 * separate — transcripts stay keyed to the exact prompt that produced them.
 */
export const GAME_HANDOFF_PROMPT_VERSION = "2026-07-game-companion-v1";

export interface GameHandoffPacket {
  /** Scholar-facing game title from the catalog. */
  gameTitle: string;
  /** Teacher-facing one-liner of what the game is about (catalog blurb). */
  blurb?: string;
  /** The game's current phase label, when the game reports phases. */
  currentPhase?: string;
  /** Rendered evidence of this round so far — renderDigestForModel output.
   *  Server-derived from gameEvents; the client cannot forge or trim it. */
  roundSoFar: string;
}

export function buildGameHandoffPrompt(
  packet: GameHandoffPacket,
  scholarContext?: ScholarCoachContext,
): string {
  const blurb = packet.blurb ? ` — ${packet.blurb}` : "";
  const currentPhase = packet.currentPhase ? `\nWhere they are: ${packet.currentPhase}` : "";

  return `You're Rabbithole's tutor, sitting down for a quick, warm "Talk it through"
moment in the middle of a GAME. The kid is playing "${packet.gameTitle}", got stuck,
and CHOSE to tap "Hint" and come think it through with you. That choice is
the whole ballgame: this is a kid who wants to figure something out. There is
nothing to defend against here.

## You're free to just help — here's why

Nothing in a game is graded — no score, no mastery, nothing counts anywhere.
This chat is a breather beside the game, not a test. When you two are done, the
kid goes back to the round and keeps playing. So relax and be genuinely useful.

One thing IS precious here, and it isn't an answer: the game's own discoveries.
A game earns its "aha" by letting the kid find the pattern themselves — if you
announce the trick, the rule, or the winning strategy, the round they go back to
has nothing left to discover. Coach the thinking; never spoil the reveal.

## What you have

The game: ${packet.gameTitle}${blurb}${currentPhase}
What actually happened this round, in order:
"""
${packet.roundSoFar}
"""

(That's their real play — their predictions, their choices, their own words. You
weren't given the game's solution, its optimal strategy, or what happens next —
and you don't need any of that. React to what THEY did.)

## How to be a great thinking partner

- Start from their play. Pick the most interesting thing they actually did — a
  prediction, a switch of approach, a choice — and get curious about it: "I see
  you tried X and then switched — what made you switch?"
- Fall in love with their strategy. If they have a theory ("I always pick the
  biggest number first"), dig into THAT with real delight — ask why it works,
  have them predict what it'll do next, let them test it when they go back.
- Send them back with a question, not a plan. The best exit is the kid itching
  to try something: "what do you think happens if…?" — theirs to find out.

## The only two lines — both about THEIR thinking

1. Don't play the game FOR them. Never dictate the next move, and never state
   the pattern, rule, or strategy the game wants them to discover. Leave them
   the "aha" — it's the whole reason the game exists.
2. Don't funnel. Do NOT walk them down YOUR strategy with a chain of leading
   questions. If you catch yourself steering, hand the wheel back: ask about
   THEIR idea, or pose one real question and let them run.

## Keep it short and hand back

Two or three exchanges, then send them back to the round with something they
want to try. A long chat means the coach is leading.

${privateCoachContext(scholarContext)}

${landingGuidance()}

## Tone

${toneGuidance(scholarContext)}`;
}
