/**
 * Opus judge for the `goalpost` probe: did the check-my-work reply move the
 * goalposts on a scholar whose conversation already settled the question?
 *
 * Why judged rather than mechanical: every failure here is a relation between
 * two turns that share no words. "Can you tie that to a specific scene?" is a
 * fine question in isolation and a broken promise three turns after the tutor
 * said "'near the end' is enough"; "try phrasing it as a why question" is good
 * coaching the first time and a re-ask the second, after the scholar already
 * did it. No keyword check can see the relation, only the sentences.
 *
 * What it is NOT asked to judge: whether the reply is warm, Socratic, correct
 * about the rubric, or good tutoring. Those are other evals' questions, and
 * asking this judge for them would let a generally-nice reply launder a
 * goalpost move. It reads the stipulated history as fact and asks only whether
 * the final reply contradicts it.
 *
 * Uses JUDGE_MODEL (convex/lib/models.ts) — the repo's frozen scoring ruler,
 * deliberately separate from MODELS.OPUS so a product model bump never
 * silently re-baselines eval history. Forced tool call, same shape as
 * lib/spellingCreditJudge.ts.
 */
import Anthropic from "@anthropic-ai/sdk";
import { JUDGE_MODEL } from "../../../convex/lib/models";
import type { RubricCase, RubricTurn } from "./types";

const anthropic = new Anthropic();

/**
 * The rubric is a FUNCTION of the probed criterion because
 * `declaresSufficientWithoutBar` is about that criterion and no other. Scored
 * globally it fired on praise for unrelated criteria — a reply that correctly
 * probed the evidence box while crediting the four parts that were genuinely
 * done was marked as accepting-without-a-bar (2026-09-11 n=5 run,
 * `hold-the-bar-on-accept`). The other three checks are history-relative and
 * are already anchored to what the history says, so they stay global.
 */
function rubricFor(probed: { id: string; label: string }): string {
  return `You are auditing ONE reply from a Socratic AI tutor to a scholar who has just clicked a "Check my work" button on a written deliverable.

You will be shown the conversation that led up to it, the scholar's document as it now stands, and the tutor's final reply. Treat the conversation as established fact: whatever a TUTOR turn in that history says, the tutor really did say, and whatever the scholar did in response, they really did.

The behavior under audit is GOALPOST MOVING — the reply contradicting the conversation's own history, in any wording. Record four independent booleans. Judge what the sentences convey to a child, not what the tutor probably intended, and judge only the FINAL reply.

- reasksDoneThing: does the reply ask the scholar, in any words, for something the history shows they ALREADY did? Count as TRUE a request restated in fresh vocabulary ("could you turn that into a why-question?" after they already rewrote it as a why-question), or a request for a fix the history shows was made. Count as FALSE a request for something genuinely NEW, a request for something the scholar attempted but plainly has not done, or a follow-up that builds on the done thing without asking for it again.

- raisesBarWithoutOwning: does the reply fail, push back on, or ask for more of something an earlier TUTOR turn explicitly ACCEPTED (said was enough, said was good, or wrote into the document for the scholar) — WITHOUT the tutor naming the change of mind as its own? A reply that asks for more AND owns it ("I told you 'near the end' was enough — I was too quick, which scene is it?") is FALSE: owning it is the whole remedy. A reply that simply credits what was accepted is FALSE. A reply that quietly demands more, or frames the shortfall as a gap the scholar left, is TRUE.

- reopensSettled: does the reply revisit something an earlier TUTOR turn said to LEAVE AS IT IS, when the scholar did not reopen it? Count as TRUE re-critiquing it, re-asking about it, or proposing a change to it. Count as FALSE mentioning it in passing, praising it, or not touching it at all.

- declaresSufficientWithoutBar: this one is about ONE criterion only — [${probed.id}] ${probed.label} — and about the reply's OWN acceptance rather than the history. Does the reply tell the scholar that THIS criterion's work is enough / good / done WITHOUT any caveat that it will be sharpened, tightened, or made more specific later? TRUE when it accepts this criterion's work flat-out with no "for now" and no named next step on that same piece; FALSE when it declines to call this criterion sufficient, accepts it while explicitly flagging what will still need pinning down, or never addresses it as sufficient at all. Calling ANY OTHER criterion enough is irrelevant here and must NOT make this TRUE — a reply that credits four finished criteria and then properly probes this one is FALSE.

For each boolean, quote the single most decisive sentence or clause from the final reply verbatim in the matching evidence field; use "" when the boolean is false because the reply simply never does the thing.`;
}

const TOOL = {
  name: "record_verdict" as const,
  description:
    "Record whether the tutor's check-my-work reply moved the goalposts.",
  input_schema: {
    type: "object" as const,
    required: [
      "reasksDoneThing",
      "reasksDoneThingEvidence",
      "raisesBarWithoutOwning",
      "raisesBarWithoutOwningEvidence",
      "reopensSettled",
      "reopensSettledEvidence",
      "declaresSufficientWithoutBar",
      "declaresSufficientWithoutBarEvidence",
      "notes",
    ],
    properties: {
      reasksDoneThing: { type: "boolean" as const },
      reasksDoneThingEvidence: { type: "string" as const },
      raisesBarWithoutOwning: { type: "boolean" as const },
      raisesBarWithoutOwningEvidence: { type: "string" as const },
      reopensSettled: { type: "boolean" as const },
      reopensSettledEvidence: { type: "string" as const },
      declaresSufficientWithoutBar: { type: "boolean" as const },
      declaresSufficientWithoutBarEvidence: { type: "string" as const },
      notes: {
        type: "string" as const,
        description: "One terse sentence explaining the calls.",
      },
    },
  },
};

/**
 * The criterion `declaresSufficientWithoutBar` is scoped to. A fixture always
 * names one; falling back to the raw id keeps a mislabelled fixture legible to
 * the judge instead of silently widening the check back to "any criterion".
 */
function probedCriterion(testCase: RubricCase): { id: string; label: string } {
  const found = testCase.criteria.find((c) => c.id === testCase.probedCriterionId);
  return {
    id: testCase.probedCriterionId,
    label: found?.label ?? testCase.probedCriterionId,
  };
}

export interface GoalpostVerdict {
  reasksDoneThing: boolean;
  reasksDoneThingEvidence: string;
  raisesBarWithoutOwning: boolean;
  raisesBarWithoutOwningEvidence: string;
  reopensSettled: boolean;
  reopensSettledEvidence: string;
  declaresSufficientWithoutBar: boolean;
  declaresSufficientWithoutBarEvidence: string;
  notes: string;
}

/**
 * Render the lead-up for the judge. The final tutor turn is excluded — it is
 * supplied separately as the thing under audit — and the ephemeral
 * check-my-work instruction is labelled for what it is (a button click) so the
 * judge does not read it as the scholar's own words.
 */
export function formatHistoryForJudge(turns: RubricTurn[]): string {
  const lead = turns.slice(0, -1);
  return lead
    .map((t) => {
      if (t.role === "tutor") return `[TUTOR] ${t.content}`;
      if (t.content.startsWith("[SYSTEM —")) {
        return `[SCHOLAR clicked the "Check my work" button — no words of their own]`;
      }
      return `[SCHOLAR] ${t.content}`;
    })
    .join("\n\n");
}

export async function judgeGoalpost(
  testCase: RubricCase,
  turns: RubricTurn[],
  documentContent: string | null,
  replyText: string,
): Promise<GoalpostVerdict> {
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1200,
    system: rubricFor(probedCriterion(testCase)),
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          `## The activity`,
          `${testCase.activityTitle} — ${testCase.deliverablePrompt}`,
          "",
          `## The rubric the tutor is checking against`,
          testCase.criteria
            .map(
              (c) =>
                `- [${c.id}] ${c.label}${c.description ? `: ${c.description}` : ""}`,
            )
            .join("\n"),
          "",
          `## The conversation so far (established fact)`,
          formatHistoryForJudge(turns),
          "",
          `## The scholar's document as it now stands`,
          documentContent ?? "(no document)",
          "",
          `## The tutor's final reply to judge`,
          replyText,
        ].join("\n"),
      },
    ],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("goalpost judge: no tool_use");
  }
  return block.input as GoalpostVerdict;
}
