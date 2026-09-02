/**
 * Stretch DIALOGUE — the rubric'd-chat vessel for stretch problems
 * (review/beast-academy-lessons.html §8, "the convergence").
 *
 * A dialogue stretch item is a `practiceItems` row with `tier: "stretch"`,
 * `answerType: "dialogue"`, and server-only `rubricCriteria` (never served to
 * the client, same discipline as `answerCanonical`). Instead of typing an
 * answer, the scholar talks the idea through with the tutor in a bounded chat,
 * then taps "Check my thinking"; an LLM judge grades the transcript against
 * the rubric. A pass writes depth evidence (evidenceType "stretch_dialogue" —
 * MODEL-JUDGED, deliberately distinct from the verifier-graded
 * "stretch_success"); a non-pass touches nothing, exactly like every stretch
 * miss.
 *
 * The tutor's discipline here is INVERTED from the miss-handoff
 * (lib/practice/handoff.ts): the handoff is free help because grading happens
 * later on a fresh variant; THIS chat is itself the evidence, so the tutor
 * must elicit and pressure-test the scholar's idea without ever stating or
 * completing it — a stated insight would contaminate the very transcript the
 * judge reads.
 *
 * Pure module — prompts, the judge tool schema, and verdict parsing. No
 * Convex imports; unit-testable directly.
 */

import { SCHOLAR_PRONOUN_GUIDANCE } from "../scholarPronouns";

export const DIALOGUE_MAX_ASSISTANT_TURNS = 8;
export const DIALOGUE_PROMPT_VERSION = "stretch-dialogue-v1";
export const STRETCH_DIALOGUE_EVIDENCE_TYPE = "stretch_dialogue";
export const DIALOGUE_OPENER =
  "This one's about the WHY — work it out however you like, then tell me your idea. When you've said your whole thinking, tap “Check my thinking”.";

/** Confidence stamped on a model-judged depth observation — deliberately below
 *  the verifier-graded stretch_success (0.85): a rubric judge is strong but
 *  fallible evidence, and the record should say so. */
export const DIALOGUE_JUDGE_CONFIDENCE = 0.75;

export type DialoguePromptPacket = {
  stem: string;
  technique?: string;
};

export function buildStretchDialoguePrompt(packet: DialoguePromptPacket): string {
  return `You're Rabbithole's tutor, in a short "go deeper" conversation. A curious kid
who already OWNS this skill chose a stretch challenge: a problem that takes an
idea, not just a method. Your job is to get them to find and ARTICULATE that
idea out loud — and to pressure-test it — without ever handing it over.

## The challenge on the table

"""
${packet.stem}
"""
${packet.technique ? `\n(The idea in play is of the "${packet.technique.replace(/_/g, " ")}" flavor. That's for your bearings only — never name it, never hint at it as a label.)\n` : ""}
## Why you must NOT give the idea away — even a little

Unlike an ordinary help chat, THIS conversation is the kid's demonstration.
When they're done, they'll tap "Check my thinking" and their own words get
read against what the challenge is really asking. If YOU state the key insight,
complete their half-sentence, or confirm the core idea before they've said it
themselves, you've done their thinking for them and spoiled their own evidence.
The kindest thing you can do is leave them the whole "aha."

## How to run it

- Open small. Ask what they notice, or what they tried. One question at a time.
- Keep every turn SHORT — two or three sentences, tops. This is their air time.
- When they state a piece of the idea, push on it instead of blessing it:
  "why does that work?", "does that hold if the numbers change?", "convince me."
  A counterexample to test is worth ten hints.
- If they're stuck, shrink the problem ("what happens with just the first two?")
  — never narrate the pattern yourself. Keep the shrink OPEN: ask what they
  notice, not "does anything cancel?" or "does the same thing happen?", which
  names the trail and turns the exchange into a leading-question funnel.
- Once they notice a feature, stay on THEIR claim and pressure-test why it works.
  Don't march them through a sequence of hand-picked mini-cases toward your
  destination.
- No verdicts. Don't say "right", "exactly", "that's it" about the CORE idea —
  warmth goes to their reasoning process ("ooh, keep pulling that thread"),
  never to confirming the destination.
- "Checks out", "works arithmetically", "the arithmetic is sound", and similar
  euphemisms ARE verdicts. Never evaluate a candidate core answer even when you
  immediately ask for reasoning; only the later Check may validate it.
- When they've laid out their whole idea and defended it, tell them to tap
  "Check my thinking" — that's the finish line, not your approval.

## Hard lines

1. Never state, name, or complete the key insight, in any words, at any point.
2. Never confirm or deny whether their idea is correct — explicitly OR by
   euphemism ("checks out", "works", "sound"). The check does that.
3. Never turn this into a funnel of leading questions that walks them down your
   path. Their idea, their words, their defense.`;
}

// ── The judge ───────────────────────────────────────────────────────────────

export const DIALOGUE_JUDGE_SYSTEM = `You are a careful, honest grader of a child's mathematical explanation. You will
read a short tutor chat about a stretch (insight) problem and decide, criterion
by criterion, whether THE SCHOLAR THEMSELVES articulated each element of the
idea. Rules:

${SCHOLAR_PRONOUN_GUIDANCE}

- Only the scholar's own words count. An idea the tutor stated, completed, or
  heavily led them to does NOT count as the scholar's — if the tutor funneled,
  grade what the scholar independently contributed.
- Paraphrase is fine; a kid's informal wording ("the tops and bottoms cancel
  out in a chain") fully satisfies a formally-worded criterion. Grade the idea,
  not the vocabulary.
- Be honest, not generous. "Sort of gestured at it" is not met. A criterion is
  met when a reasonable teacher reading the transcript would say "yes, the kid
  said that."
- bestQuote must be a VERBATIM quote from a scholar turn — the single best
  moment of the idea in their own words. Never quote the tutor.`;

export type DialogueJudgePacket = {
  stem: string;
  rubricCriteria: string[];
  transcript: { role: "user" | "assistant"; content: string }[];
};

/**
 * Opaque lookup key for one server-issued dialogue session. The random session
 * token separates repeat visits to the same item; folding in the authenticated
 * caller prevents one scholar from reading or grading another scholar's log.
 * Only this hash is persisted in tutorTranscripts.
 */
export function dialogueDedupKey(
  userId: string,
  itemId: string,
  sessionToken: string,
): string {
  const input = `${userId}\u0000${itemId}\u0000${sessionToken}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9dc51101;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    const lo = c & 0xff;
    const hi = (c >>> 8) & 0xff;
    h1 = Math.imul(h1 ^ lo, 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ hi, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ lo, 0x85ebca77) >>> 0;
    h2 = Math.imul(h2 ^ hi, 0x85ebca77) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}`;
}

export function buildDialogueJudgeUser(packet: DialogueJudgePacket): string {
  const transcript = packet.transcript
    .map((m) => `${m.role === "user" ? "SCHOLAR" : "TUTOR"}: ${m.content}`)
    .join("\n");
  const criteria = packet.rubricCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `The stretch challenge:
"""
${packet.stem}
"""

The rubric — grade EACH criterion:
${criteria}

The conversation:
"""
${transcript}
"""

Grade each criterion against the SCHOLAR's own contributions only.`;
}

/** Keep the observation excerpt grounded in an actual scholar turn even if the
 * judge returns a malformed or hallucinated bestQuote. */
export function dialogueEvidenceExcerpt(
  bestQuote: string,
  transcript: DialogueJudgePacket["transcript"],
): string {
  const scholarTurns = transcript
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const candidate = bestQuote.trim();
  if (candidate && scholarTurns.some((turn) => turn.includes(candidate))) {
    return candidate.slice(0, 400);
  }
  return (scholarTurns.sort((a, b) => b.length - a.length)[0] ?? "").slice(0, 400);
}

/** Forced-tool schema for the judge's verdict (same reliability pattern as the
 *  observer): one call, validated JSON, no text parsing. */
export const DIALOGUE_JUDGE_TOOL = {
  name: "grade_dialogue",
  description: "Report the per-criterion grading of the scholar's explanation.",
  input_schema: {
    type: "object" as const,
    properties: {
      criteria: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            index: { type: "number" as const, description: "1-based criterion number" },
            met: { type: "boolean" as const },
            evidence: {
              type: "string" as const,
              description: "One line: why met/not, citing the scholar's words",
            },
          },
          required: ["index", "met"],
        },
      },
      bestQuote: {
        type: "string" as const,
        description: "Verbatim scholar quote — the best moment of the idea in their own words. Empty string if none.",
      },
      note: {
        type: "string" as const,
        description: "One teacher-facing sentence summarizing what the scholar demonstrated (or where the idea stopped short).",
      },
    },
    required: ["criteria", "bestQuote", "note"],
  },
};

export type DialogueVerdict = {
  metCount: number;
  total: number;
  /** Pass = EVERY criterion met. Authors keep rubrics to 2–3 essential
   *  criteria, so all-of-them is the honest bar (a 2-of-3 pass would let the
   *  core idea go unsaid). */
  passed: boolean;
  perCriterion: { index: number; met: boolean; evidence?: string }[];
  bestQuote: string;
  note: string;
};

/** Parse + harden the judge tool input. `passed` is COMPUTED here from the
 *  per-criterion grades — the model never gets to declare an overall verdict
 *  that its own line items don't support. Missing/extra criteria are treated
 *  as not-met (fail-closed). */
export function parseDialogueVerdict(input: unknown, criteriaCount: number): DialogueVerdict {
  const raw = (input ?? {}) as {
    criteria?: unknown;
    bestQuote?: unknown;
    note?: unknown;
  };
  const items = Array.isArray(raw.criteria) ? raw.criteria : [];
  const perCriterion: DialogueVerdict["perCriterion"] = [];
  for (let i = 1; i <= criteriaCount; i++) {
    const found = items.find(
      (c): c is { index: number; met: boolean; evidence?: string } =>
        !!c &&
        typeof c === "object" &&
        (c as { index?: unknown }).index === i &&
        typeof (c as { met?: unknown }).met === "boolean",
    );
    perCriterion.push({
      index: i,
      met: found?.met === true,
      ...(typeof found?.evidence === "string" ? { evidence: found.evidence } : {}),
    });
  }
  const metCount = perCriterion.filter((c) => c.met).length;
  return {
    metCount,
    total: criteriaCount,
    passed: criteriaCount > 0 && metCount === criteriaCount,
    perCriterion,
    bestQuote: typeof raw.bestQuote === "string" ? raw.bestQuote.slice(0, 400) : "",
    note: typeof raw.note === "string" ? raw.note.slice(0, 500) : "",
  };
}
