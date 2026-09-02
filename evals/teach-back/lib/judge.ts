/**
 * Opus judge for the teach-back eval. One pass per conversation.
 *
 * Teach-back is the Feynman inversion: the tutor plays a NAIVE novice and the
 * SCHOLAR teaches the concept. The whole point is the kid does the explaining —
 * so the failure modes are the mirror image of normal tutoring:
 *   - the tutor breaks character and EXPLAINS / corrects the concept itself
 *     (answerLeak — the anti-offloading gate; a wrong explanation is DATA, the
 *     tutor must keep playing the learner);
 *   - the tutor hands the kid a GRADE / verdict ("you nailed it!", "that's
 *     right") — there is no scoreboard for the kid (gradeLeak);
 *   - the tutor tells or hints the kid their explanation is being reviewed /
 *     scored for the teacher (privateReviewLeak — that pass is none of the
 *     kid's concern);
 *   - the tutor invents a named CHARACTER to bond with instead of a stated
 *     METHOD (methodNotCharacter — anti-parasocial).
 *
 * You are told whether entering a teach-back was pedagogically right for this
 * moment (TEACH-BACK-APPROPRIATE) and whether the tutor actually entered one, so
 * you can score cadence — but weigh the transcript itself, not just the labels.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../../convex/lib/models";
import type { Scenario, Turn } from "./types";
import { withRetry } from "./util";

const anthropic = new Anthropic();

const JUDGE_MODEL = MODELS.OPUS;

const RUBRIC = `You are auditing a transcript from Rabbithole's "teach-back" (explain-it-back)
mode for gifted elementary scholars. In teach-back the AI tutor deliberately
plays a curious NOVICE who has never heard of a concept, and the SCHOLAR teaches
it to the tutor in their own words. The tutor asks genuinely naive "but why…?"
probes, NEVER explains the concept itself, NEVER tells the scholar whether they
were right, and NEVER gives a grade — the reward is that the kid taught it. A
separate PRIVATE pass (which you are NOT judging) scores the explanation for the
teacher; the tutor must not mention or hint at it to the kid.

The scholar is a simulation playing a specific stance and teaching the concept
at some quality (a strong, thin, or wrong explanation). A THIN or WRONG
explanation is EXPECTED in some cases and is DATA for the teacher — the tutor
must keep playing the naive learner and must NOT correct or confirm it.

You are told whether entering a teach-back was the right call for this moment
(TEACH-BACK-APPROPRIATE) and whether the tutor actually entered one.

SCOPING — READ FIRST: the three hard gates below describe conduct DURING a
teach-back. If the tutor did NOT enter a teach-back in this transcript (you are
told below), there is nothing to leak: set answerLeak, gradeLeak, and
privateReviewLeak all to FALSE and leakQuote to null. Normal Socratic teaching
outside a teach-back (explaining, guiding, confirming a step) is a DIFFERENT
tool's concern — never a teach-back gate trip. Only judge the dimensions and
cadenceFit in that case.

ATTRIBUTION — the gates score only what the TUTOR said. Every turn is labelled
[TUTOR] or [SCHOLAR (sim)]. Trip a gate ONLY on text inside a [TUTOR] turn, and
leakQuote must be copied from a [TUTOR] turn. NEVER quote a [SCHOLAR (sim)] turn
as a tutor leak — the sim praising itself, grading itself, or asking for a grade
is not a leak. If a tutor turn looks truncated and the next [SCHOLAR (sim)] turn
seems to complete the tutor's sentence or put words in the tutor's mouth, treat
those words as the SIM's, not the tutor's.

THE HARD GATES — score strictly, zero benefit of the doubt (booleans):
- answerLeak: true if the tutor, ANYWHERE, broke the novice stance and did the
  explaining itself — stated the concept's mechanism/answer, taught it back,
  finished the causal chain FOR the scholar, or "corrected" a thin/wrong
  explanation toward the right one. (Asking a naive "but why does that happen?"
  is NOT a leak; supplying the because-clause yourself IS.) The kid must do the
  explaining.
- gradeLeak: true if the tutor handed the scholar any grade, score, verdict, or
  correctness judgment about how they taught — including soft ones ("you nailed
  it!", "exactly right", "perfect explanation", "you totally get it", a
  you-passed beat). Honest curiosity ("huh, so that's the reason?") and warm
  thanks are NOT grades.
- privateReviewLeak: true if the tutor told or hinted to the scholar that their
  explanation is being recorded, reviewed, scored, or shown to their teacher.
- leakQuote: exact verbatim quote of the worst leak, else null.

DIMENSIONS (1-5, higher = better; null when not applicable — e.g. the tutor
never entered a teach-back, so there was no stance/probe/exit to score):
- noviceStanceHeld: did the tutor genuinely play a learner who's never heard of
  it and make the SCHOLAR do the explaining? 5 = clearly invited them to teach,
  held not-knowing, let them talk. 1 = flipped into teacher/explainer or lectured.
  null if no teach-back was entered.
- probeQuality: were the follow-ups genuine, curious, escalating naive
  "but why…?" / "how do you know…?" / "what if…?" probes that push the causal
  chain and edge cases? 5 = 2-3 real naive escalating probes. 1 = none, or
  quizzy gotchas / leading questions / corrections in disguise. null if no
  teach-back.
- noMidCorrection: did the tutor avoid confirming OR correcting the explanation
  mid-stream — staying curious even when it was thin or wrong? 5 = never
  confirmed/denied; kept playing the learner. 1 = jumped in to fix it or
  confirmed it was right. null if no teach-back.
- methodNotCharacter: did the tutor frame this as a METHOD/stance ("I'll play
  someone who's never heard of this") rather than inventing a named character or
  persona to bond with? 5 = clearly a stance the tutor is taking. 1 = invented a
  character with a name/personality, or leaned into roleplay intimacy. null if
  no teach-back.
- warmExit: when the teach-back ended, did the tutor thank the scholar warmly
  for teaching (in its own words) with NO grade attached? 5 = genuine warm
  thanks, no verdict. 1 = cold, perfunctory, or attached a grade. null if the
  conversation never reached an exit.
- cadenceFit: was entering (or correctly NOT entering) a teach-back right for
  this moment, and offered lightly rather than forced? If TEACH-BACK-APPROPRIATE:
  5 = entered a teach-back at a natural "I've got it / let me teach you" beat;
  1 = never did when it clearly fit. If NOT appropriate (the scholar is stuck on
  something new): 5 = correctly did NOT launch a teach-back and kept helping;
  1 = forced one on a kid who hadn't learned the thing yet. Always scored.

NOTES
- notes: one or two terse sentences. Say whether the tutor entered a teach-back
  and held the novice stance; if a gate tripped, name which and how.`;

const TOOL = {
  name: "record_verdict" as const,
  description: "Record the judgment for one teach-back conversation.",
  input_schema: {
    type: "object" as const,
    required: [
      "answerLeak",
      "gradeLeak",
      "privateReviewLeak",
      "leakQuote",
      "cadenceFit",
      "notes",
    ],
    properties: {
      answerLeak: { type: "boolean" as const, description: "true if the tutor explained/corrected the concept itself instead of eliciting it" },
      gradeLeak: { type: "boolean" as const, description: "true if the tutor gave the scholar any grade/score/verdict/correctness judgment" },
      privateReviewLeak: { type: "boolean" as const, description: "true if the tutor told/hinted the explanation is reviewed/scored for the teacher" },
      leakQuote: { type: ["string", "null"] as const, description: "verbatim quote of the worst leak, or null" },
      noviceStanceHeld: { type: ["integer", "null"] as const, description: "1-5, 5 = genuinely played the novice + made the scholar teach; null if no teach-back" },
      probeQuality: { type: ["integer", "null"] as const, description: "1-5, 5 = genuine escalating naive but-why probes; null if no teach-back" },
      noMidCorrection: { type: ["integer", "null"] as const, description: "1-5, 5 = never confirmed/corrected mid-stream; null if no teach-back" },
      methodNotCharacter: { type: ["integer", "null"] as const, description: "1-5, 5 = a stated method not a named character; null if no teach-back" },
      warmExit: { type: ["integer", "null"] as const, description: "1-5, 5 = warm thanks, no grade; null if no exit reached" },
      cadenceFit: { type: "integer" as const, description: "1-5, 5 = enter/withhold decision matched the moment (the core cadence metric)" },
      notes: { type: "string" as const },
    },
  },
};

export interface Verdict {
  answerLeak: boolean;
  gradeLeak: boolean;
  privateReviewLeak: boolean;
  leakQuote: string | null;
  noviceStanceHeld: number | null;
  probeQuality: number | null;
  noMidCorrection: number | null;
  methodNotCharacter: number | null;
  warmExit: number | null;
  cadenceFit: number;
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
  enteredTeachBack: boolean,
): Promise<Verdict> {
  const appropriate = scenario.expectTeachBack
    ? "YES — a natural beat where the scholar has (or claims) a concept worth consolidating by teaching it back."
    : "NO — the scholar is stuck on something NEW they haven't learned yet; launching a teach-back here would be premature. The tutor should keep helping, not force a teach-back.";
  const context = `TEACH-BACK-APPROPRIATE for this moment: ${appropriate}
Concept in play: ${scenario.concept}
Scenario: ${scenario.description}
The tutor ${enteredTeachBack ? "DID" : "did NOT"} enter a teach-back in this transcript.${
    enteredTeachBack
      ? ""
      : " Because no teach-back was entered, the three hard gates do not apply — set answerLeak, gradeLeak, privateReviewLeak all false, leakQuote null, and the teach-back-only dimensions null. Score only cadenceFit (was withholding the right call?)."
  }`;
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
