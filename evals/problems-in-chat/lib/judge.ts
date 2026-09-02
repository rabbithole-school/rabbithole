/**
 * Opus judge for the ⑮ problems-in-chat eval. One pass per conversation.
 *
 * The roadmap's stated risk is PEDAGOGICAL: does the tutor use an inline item
 * as retrieval practice at the right moment (probe-first), or does it
 * lecture-then-test / over-quiz / test a brand-new topic / offload? Plus the
 * hard answer-leak gate (the tutor is never given the served item's answer and
 * must never state or confirm it).
 *
 * Dimensions mirror ⑫'s style where they overlap (probeFirst, answerLeak,
 * cognitiveOffloading) plus problems-in-chat-specific reads (appropriateUse,
 * retrievalFraming, noOverQuizzing, readTheRoom).
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../../convex/lib/models";
import type { Scenario, ServedItem, Turn } from "./types";
import { withRetry } from "./util";

const anthropic = new Anthropic();

const JUDGE_MODEL = MODELS.OPUS;

const RUBRIC = `You are auditing a transcript from Rabbithole's ⑮ "problems-in-chat" feature:
the AI tutor may, at the right moment, drop ONE inline interactive practice
problem into the chat for the scholar (an elementary kid) to solve in place —
a quick RETRIEVAL-PRACTICE item, not a quiz. The tutor has a tool for this and
decides when to use it. The scholar is a simulation playing a specific stance
(confident / frustrated / curious / tired). The tutor was NEVER told the
served problem's correct answer and has no way to compute a guaranteed-correct
one; you (the judge) ARE given it below so you can detect a leak.

You are also told whether, pedagogically, this moment WAS or WAS NOT a good
time to serve an inline item (SERVE-APPROPRIATE), so you can score the tutor's
judgment — but weigh the transcript itself, not just that label.

THE HARD GATE — score strictly, zero benefit of the doubt:
- answerLeak (boolean): true if the tutor, ANYWHERE, (a) stated the served
  item's correct answer (in whole or in a copy-able part), (b) CONFIRMED the
  scholar's guess as correct — including soft confirmations ("yes!", "you got
  it!", "exactly!", a congratulatory beat right after a correct guess), or (c)
  fully computed the answer for the scholar. Do NOT count: naming which step to
  redo, asking them to recompute/recheck, a neutral non-committal reaction to a
  guess, or correctly noting a guess is wrong without handing over the fix.
  (The interactive box grades the answer itself — the tutor's job is to react
  to the THINKING, never to be the answer key.)
- leakQuote (string | null): exact verbatim quote of the leak, else null.

PEDAGOGICAL DIMENSIONS (1-5, higher = better):
- probeFirst: did the tutor draw out the scholar's OWN thinking before doing
  anything else? 5 = clearly probes first. 1 = opens by testing or lecturing.
- appropriateUse: was the SERVE / WITHHOLD decision right for this moment? If
  SERVE-APPROPRIATE: 5 = probed, then served ONE well-timed item as retrieval
  practice; 1 = never served when it clearly should have, or buried it. If NOT
  SERVE-APPROPRIATE: 5 = correctly WITHHELD and kept exploring/supporting; 1 =
  served an item anyway (tested a new topic, quizzed a frustrated/tired kid, or
  derailed a good "why" question). This is the CORE metric.
- retrievalFraming: WHEN an item was served, was it framed as low-stakes
  retrieval practice ("let's see", "try one from memory") and handed to the
  scholar to solve — NOT as a gate or a "did you understand my explanation"
  check? 5 = clean retrieval framing (or N/A because correctly withheld → score
  5). 1 = served as lecture-then-test or a pop quiz.
- noOverQuizzing: did the tutor avoid chaining multiple items / turning the
  chat into a worksheet? 5 = at most one item, used well (or none). 1 = stacked
  problems / kept quizzing.
- readTheRoom: did the tutor respond to the scholar's actual mood and intent
  (support when frustrated, explore when curious, warmth when tired) rather
  than steamrolling toward a drill? 5 = attuned. 1 = tone-deaf.
- cognitiveOffloading (absence-of): is the scholar left to do the actual
  thinking/computation? 5 = yes, entirely. 1 = tutor did the work for them.

NOTES
- notes: one or two terse sentences. Say whether the tutor served an item and
  whether that was the right call; if it leaked, name HOW (stated / confirmed /
  computed).`;

const TOOL = {
  name: "record_verdict" as const,
  description: "Record the judgment for one problems-in-chat conversation.",
  input_schema: {
    type: "object" as const,
    required: [
      "answerLeak",
      "leakQuote",
      "probeFirst",
      "appropriateUse",
      "retrievalFraming",
      "noOverQuizzing",
      "readTheRoom",
      "cognitiveOffloading",
      "notes",
    ],
    properties: {
      answerLeak: { type: "boolean" as const, description: "true if the tutor stated/confirmed/computed the served item's answer anywhere" },
      leakQuote: { type: ["string", "null"] as const, description: "verbatim quote of the leak, or null" },
      probeFirst: { type: "integer" as const, description: "1-5, 5 = elicited the scholar's reasoning before testing/explaining" },
      appropriateUse: { type: "integer" as const, description: "1-5, 5 = serve/withhold decision matched the moment (the core metric)" },
      retrievalFraming: { type: "integer" as const, description: "1-5, 5 = item framed as retrieval practice, not lecture-then-test (5 if correctly withheld)" },
      noOverQuizzing: { type: "integer" as const, description: "1-5, 5 = at most one item, no worksheet" },
      readTheRoom: { type: "integer" as const, description: "1-5, 5 = attuned to the scholar's mood/intent" },
      cognitiveOffloading: { type: "integer" as const, description: "1-5, 5 = scholar did all the thinking" },
      notes: { type: "string" as const },
    },
  },
};

export interface Verdict {
  answerLeak: boolean;
  leakQuote: string | null;
  probeFirst: number;
  appropriateUse: number;
  retrievalFraming: number;
  noOverQuizzing: number;
  readTheRoom: number;
  cognitiveOffloading: number;
  notes: string;
}

function formatTranscript(turns: Turn[]): string {
  return turns
    .map((t) => `[${t.role === "assistant" ? "TUTOR" : "SCHOLAR (sim)"}] ${t.content}`)
    .join("\n\n");
}

export async function judge(
  scenario: Scenario,
  turns: Turn[],
  served: ServedItem[],
): Promise<Verdict> {
  const servedItems = served.filter((s) => s.stem);
  const servedNote =
    servedItems.length === 0
      ? "The tutor did NOT serve any inline item in this transcript."
      : servedItems
          .map(
            (s) =>
              `The tutor served: "${s.stem}" — correct answer (WITHHELD from the tutor, for your grading only): "${s.correctAnswer}".`,
          )
          .join("\n");
  const context = `SERVE-APPROPRIATE for this moment: ${scenario.expectServe ? "YES — a natural retrieval / fluency-claim beat where one well-framed item after probing is appropriate." : "NO — serving an item here would be the anti-pattern (testing a new topic, quizzing a frustrated/tired kid, or derailing a conceptual question). The tutor should WITHHOLD and keep exploring."}
Scenario: ${scenario.description}
${servedNote}`;
  const convo = formatTranscript(turns);
  const response = await withRetry(() =>
    anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 1000,
      system: RUBRIC,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "record_verdict" },
      messages: [{ role: "user", content: `${context}\n\n## Transcript\n${convo}` }],
    }),
  );
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("judge: no tool_use in response");
  return block.input as Verdict;
}
