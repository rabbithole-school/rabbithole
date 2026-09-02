/**
 * Story-open (Moments) — the short, wonder-opening Socratic conversation behind a
 * verified world-connection story.
 *
 * A scholar gets fluent in a skill; at that fluency moment a story card serves a
 * verified bridge story (`knowledgeNodeEdges.story`: hook + narrative + optional
 * socratic probe + source, seeded from convex/lib/practice/storyRegistry.ts) with
 * an "Ask the tutor why" action. This module builds the tutor's ENTIRE system
 * prompt for the conversation that action opens. It is the sibling of
 * `handoff.ts` (the "Talk it through" scratch chat), and shares its shape: a
 * small, pure, unit-testable prompt builder + a turn cap + a dedup key, so the
 * whole surface is reviewable without convex-test.
 *
 * PHILOSOPHY. This is NOT the un-stucking handoff and NOT a lesson. Nothing is
 * graded and nothing moves a score — the kid already earned fluency; this is the
 * *reward*: a door held open into the wider world. So the posture is different
 * from every other tutor surface:
 *
 *   - GROUNDED, not generative. The story's own narrative + source is the ONLY
 *     thing the tutor knows. It must never invent a fact beyond the story to
 *     sound smart; when asked past the edge of the story it wonders aloud
 *     honestly and points at how a person could actually find out. (This is the
 *     open-and-inspectable ethos made behavioral: a made-up "fun fact" is the
 *     failure mode, not the goal.)
 *   - WONDER, not lecture. Lead from the kid's own curiosity (their first message
 *     follows the card), prefer the story's socratic probe as the opening move on
 *     a "why?", one real question at a time with genuine wait-time, short turns.
 *   - NOT a funnel. No chain of leading questions marching the kid to a
 *     predetermined "aha" — there is no answer key for a story, so follow where
 *     the kid actually goes, even sideways.
 *   - HANDS AGENCY BACK. It ends by returning the kid's curiosity to them — an
 *     invitation to explore, never an assignment.
 *   - A METHOD, not a character (anti-parasocial): no name, no persona, nothing
 *     for a kid to bond with.
 *
 * The packet is deliberately NARROW: the story fields +
 * two plain skill/world labels + an optional reading level. It STRUCTURALLY cannot
 * receive dossier / mastery / signals / any sensitive scholar data — the redaction
 * boundary is enforced at the type level.
 *
 * The full running transcript IS persisted (anonymously, no scholarId) for
 * RETROSPECTIVE quality judging — see convex/tutorTranscripts.ts and the
 * `tutorTranscripts` table comment in convex/schema.ts.
 */

/**
 * Version stamp for the story-open system prompt. Bump this whenever
 * `buildStoryOpenPrompt`'s TEXT changes so persisted story-open tutor transcripts (and
 * any quality signal derived from them) are keyed to the prompt they were
 * produced under. A date+slug string is enough; it is opaque to consumers.
 */
export const STORY_OPEN_PROMPT_VERSION = "2026-07-story-open-v1";

/**
 * The maximum number of assistant turns in a story-open conversation. Slightly
 * roomier than the handoff's 4 (this is open exploration, not un-stucking a
 * stuck kid), but still a cap: past it, a long back-and-forth means the tutor is
 * leading rather than the kid wondering. At the cap we hand the door back with a
 * warm close instead of another model call.
 */
export const STORY_OPEN_MAX_ASSISTANT_TURNS = 6;

/** Token cap per turn — short by design (2-4 sentences, one question). */
export const STORY_OPEN_MAX_TOKENS = 400;

/**
 * The warm close streamed at the turn cap (no model call). Hands the kid's own
 * curiosity back as an invitation, never an assignment — the same move the prompt
 * asks the model to make, so the capped ending is on-voice.
 */
export const STORY_OPEN_CLOSE =
  "I love that you followed this thread. It'll still be here whenever you feel " +
  "like pulling on it again — go see what else it's tied to →";

/**
 * Neutral fallback used ONLY when the model returns an empty reply. Keeps the
 * door open without inventing anything.
 */
export const STORY_OPEN_EMPTY_FALLBACK =
  "Huh — my thought slipped away for a second. What's the part of this that " +
  "made you go 'wait, really?'";

/**
 * Everything the story-open prompt is allowed to know. Deliberately narrow: the
 * story's own fields + two plain labels (the skill just mastered, the world thing
 * it connects to) + an optional reading level. There is NO field for dossier /
 * mastery / signals / name — a caller cannot even pass sensitive data in.
 */
export interface StoryOpenPacket {
  /** The one-line hook the card showed (the story's title). */
  hook: string;
  /** The story itself, verbatim as the scholar read it on the card. */
  narrative: string;
  /** The story's own Socratic probe, if it has one — the preferred "why?" opener. */
  probe?: string;
  /** The citation / verification trail behind the story, if present. */
  source?: string;
  /** Plain label for the skill the scholar just got fluent in (e.g. "Prime factorization"). */
  fromLabel?: string;
  /** Plain label for the world thing the story connects to (e.g. "Cicada life cycles"). */
  toLabel?: string;
  /** The world thing's domain (e.g. "biology") — a light framing hint. */
  toDomain?: string;
  /** The scholar's reading level, if a teacher/observer has set one. */
  readingLevel?: string;
}

export function buildStoryOpenPrompt(packet: StoryOpenPacket): string {
  const fromLabel = (packet.fromLabel ?? "").trim();
  const toLabel = (packet.toLabel ?? "").trim();
  const domainHint = packet.toDomain?.trim() ? ` (${packet.toDomain.trim()})` : "";

  const skillLine = fromLabel
    ? `The skill they just got fluent in: ${fromLabel}`
    : `They just got fluent in the skill this story grew out of.`;
  const worldLine = toLabel
    ? `Where it turns up out in the world: ${toLabel}${domainHint}`
    : `The story connects that skill to something out in the world${domainHint}.`;

  // The probe is the preferred first move on a "why?" — quote it verbatim if we
  // have one, otherwise tell the model to pose its own small, real question.
  const probeMove = packet.probe?.trim()
    ? `the story's own question — «${packet.probe.trim()}» — asked plainly, then real wait-time`
    : `one small, real question that turns the story back to them, then real wait-time`;

  const sourceLine = packet.source?.trim()
    ? `\nWhere the story comes from (your grounding, not something to recite): ${packet.source.trim()}`
    : ``;

  const readingLevelLine = packet.readingLevel?.trim()
    ? `Match this scholar's reading level: ${packet.readingLevel.trim()}.`
    : `Write in plain, warm language a curious kid reads easily — no jargon, short sentences.`;

  return `You're Rabbithole's tutor at a small, happy moment. A curious kid just got
fluent in a skill, and right then we showed them a short, true story about where
that skill turns up out in the world. They tapped "Ask the tutor why" — they want
to wonder about it with someone. Your job is NOT to teach them the story. It's to
open a door and let them lean through it.

## The story they just saw — this is your whole world, stay inside it

${skillLine}
${worldLine}
The card's hook: "${packet.hook}"
The story, exactly as they read it:
"""
${packet.narrative}
"""${sourceLine}

That narrative — and the source above — is the ONLY thing you actually know here.
Everything you say has to trace back to it. You are NOT an encyclopedia and NOT a
search engine: if the kid asks something the story doesn't answer, do NOT invent a
fact to fill the gap. Saying "I don't know that part" isn't a failure here — it's
the best thing you can model. Wonder about it out loud with them ("huh — the story
doesn't say; I wonder how someone would even find that out…") and point at how a
real person could go find out: look it up, ask someone who'd know, try a little
experiment. A made-up fact would quietly rob them of the real thing this moment is
for.

## How to open the door

- Lead from THEIR curiosity. They spoke first, right after the card — start from
  what THEY actually said, not a script. Meet the exact thing they're wondering.
- On a "why?" (or "how come?", "wait, what?"), the best first move is usually
  ${probeMove}. Ask it and STOP — don't spell out the answer in the same breath,
  and don't chase it with a second question.
- ONE question per turn — never two, even when a big "why?" gets you excited. Real
  wait-time. A stack of questions isn't curiosity, it's a quiz, and this is not a
  quiz. And don't let the excitement swell into a mini-lecture: a sentence or two
  of wonder, one question, done.
- Keep every turn short: two to four sentences. You're lighting a spark, not
  giving a lecture. If you catch yourself explaining three things, cut two.
- "I don't know" — from them OR from you — is always a fine, honest answer. Never
  make a kid feel behind for not knowing where a story goes.

## The one trap: don't funnel

Do NOT run a chain of leading questions that walks the kid to an answer you've
already picked ("right, so what does that mean? and then what? so therefore…?").
That feels like teaching but it's just you doing the thinking in question form,
and it's the opposite of wonder. There is no answer key for a story. If you catch
yourself steering toward one "correct" realization, stop and hand the wheel back:
ask what THEY find strange or cool about it, or offer a genuinely open question
you don't already know the answer to. Follow where the kid goes, even sideways.

## Hand the door back — don't turn it into homework

When the spark's caught (or after a few exchanges), end by giving the kid their
own curiosity back: an invitation, never an assignment. "That's a good thread to
pull sometime →" — not "go read three articles" and not a quiz at the end. Don't
promise to continue later. You opened a door; let them choose whether to walk
through it.

## What you are

You're a method, not a character — no name, no persona, no backstory, nothing for
a kid to bond with. You can wonder out loud ("I love that…"), but you're a
thinking partner for a minute, not a friend and not a narrator playing a role. No
emoji-as-personality. ${readingLevelLine}`;
}

/**
 * Turn-cap bookkeeping for a story-open conversation, kept pure so the endpoint's
 * cap logic is unit-testable without convex-test. `assistantTurns` is how many
 * assistant replies the transcript already holds; `atCap` means the next scholar
 * message should get the warm close (STORY_OPEN_CLOSE) instead of a model turn.
 */
export function storyOpenTurnState(
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): { assistantTurns: number; atCap: boolean } {
  const assistantTurns = messages.filter((m) => m.role === "assistant").length;
  return { assistantTurns, atCap: assistantTurns >= STORY_OPEN_MAX_ASSISTANT_TURNS };
}

/** True once THIS reply is the last one before the cap (so the client can close). */
export function storyOpenEndsAfterReply(assistantTurnsBefore: number): boolean {
  return assistantTurnsBefore + 1 >= STORY_OPEN_MAX_ASSISTANT_TURNS;
}

/**
 * Stable, server-derived natural key for the per-turn UPSERT of a story-open
 * transcript. A conversation grows message-by-message across the same POST
 * endpoint; hashing (callerUserId + fromKey + toKey + the scholar's OPENING
 * message) yields one key for the whole chat, so each turn updates ONE
 * story-open `tutorTranscripts` row instead of inserting duplicates — no client id
 * required.
 *
 * This is a dedup key, NOT a security token or a learner identifier: we store the
 * HASH, never the userId (the story-open surface binds no scholarId by design). A
 * non-cryptographic hash is plenty — the only requirement is determinism + low
 * collision at single-school volume. The opening message is folded in so two
 * genuinely different conversations on the same edge by the same caller usually
 * don't collide into one row. (Same decorrelated two-lane FNV-1a construction as
 * handoffDedupKey — see the rationale there.)
 */
export function storyOpenDedupKey(
  userId: string,
  fromKey: string,
  toKey: string,
  firstUserMessage: string,
): string {
  const input = `${userId}\u0000${fromKey}\u0000${toKey}\u0000${firstUserMessage}`;
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
