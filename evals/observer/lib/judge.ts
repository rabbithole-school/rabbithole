/**
 * LLM judge for observer output. Two modes:
 *   - scoreRun: absolute rubric scoring (1-5 per dimension) of one observer
 *     output against the transcript (and gold expectations, for fixtures).
 *   - comparePair: blind A/B pairwise verdict between two outputs.
 *
 * The judge runs on Opus (allowed in eval per project guidance). Its rubric
 * encodes the SAME philosophy the observer prompt commits to, so a high judge
 * score means "faithful to what the observer was told to do," not generic praise.
 */
import Anthropic from "@anthropic-ai/sdk";
import { JUDGE_MODEL } from "../../../convex/lib/models";
import type { ObserverResult } from "../../../convex/lib/observerShared";
import type { TranscriptCase } from "./runObserver";

const anthropic = new Anthropic();

export const DIMENSIONS = [
  "concept_transferability",
  "granularity_discipline",
  "mastery_calibration",
  "misconception_handling",
  "evidence_grounding",
  "signal_usefulness",
  "seed_quality",
  "pulse_accuracy",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const RUBRIC = `You are auditing the output of an automated "Learning Observer" that watches a transcript of a gifted-elementary student talking with an AI tutor and produces structured notes for the student's teacher. Judge how GOOD and USEFUL the observer's output is. You are a demanding evaluator: the teacher will act on these notes, so inaccuracy and noise are costly.

The observer was instructed to follow these principles. Score it against THEM:

1. concept_transferability — Concept labels must be transferable understanding a professor could title a lecture after ("Sound propagation through materials"), NOT moment-specific facts ("propeller speed and submarine acoustic signature"). Domains must be broad disciplines (Physics, Biology, Mathematics), not micro-fields (Marine Science, Signal Processing).
2. granularity_discipline — A session should yield ~2-5 observations, rarely >7. The same understanding shown across several exchanges is ONE observation. Penalize fragmentation and near-duplicate labels heavily.
3. mastery_calibration — Bloom's float 0-5 (1 Remember, 2 Understand, 3 Apply, 4 Analyze, 5 Evaluate/Create) must match the evidence. Heavy tutor scaffolding must LOWER the level — credit the student for their own reasoning, not the tutor's. Gifted asynchrony is real (a kid can Create before they reliably Remember).
4. misconception_handling — A genuine misconception is gold: it should be captured, named precisely, evidenceType "misconception_signal", typically rated ~Remember(1) with HIGH confidence. Penalize missing a clear misconception or rating a wrong idea as high mastery.
5. evidence_grounding — Every observation/signal must be supported by something the student actually did in the transcript. Penalize hallucinated assessments, claims about things not shown, or excerpts that don't support the claim. Confidence should reflect evidence QUALITY, not quantity.
6. signal_usefulness — Session signals should capture real character-level patterns (persistence, self-direction, metacognition...) actually exhibited, not be sprayed across every type. Penalize signals with no transcript basis.
7. seed_quality — Seeds (what to explore next) should be specific, genuinely exciting for THIS kid, and point the right Bloom's direction. Penalize generic/curriculum-filler seeds. When the case lists pending seeds already on the scholar's sky: a suggested seed that is the SAME thread as a pending one (even worded differently) must set refreshesSeedId to that pending seed's id — penalize a near-duplicate planted without it, a refreshesSeedId pointing at the wrong/unrelated pending seed, and a refreshesSeedId attached to a genuinely new direction.
8. pulse_accuracy — engagement/complexity/onTask (0-1), pulseScore (0-5), summary, and concernFlags should match the transcript. Penalize inflation (e.g. high engagement for an off-task session) and missed concern flags.

A key failure mode to watch: a longer/"smarter"-sounding output is NOT better if it is over-granular, hallucinates, or inflates. Reward restraint and accuracy.

Score each dimension 1-5 (5 = excellent, faithful to the principle; 3 = acceptable; 1 = clear violation). If a dimension genuinely does not apply to this transcript (e.g. no misconception was present to handle), set applicable=false for it (it will be excluded from averages) — do not pad it with a neutral 3. Otherwise set applicable=true. Also list concrete errors you found (over-granular labels, hallucinated claims, miscalibrated levels) — be specific and quote the offending label/claim.`;

const SCORE_TOOL = {
  name: "record_judgment" as const,
  description: "Record the rubric scores and errors for this observer output.",
  input_schema: {
    type: "object" as const,
    required: ["scores", "errors", "overall", "headline"],
    properties: {
      scores: {
        type: "object" as const,
        required: [...DIMENSIONS],
        properties: Object.fromEntries(
          DIMENSIONS.map((d) => [
            d,
            {
              type: "object" as const,
              required: ["score", "applicable", "note"],
              properties: {
                score: { type: "integer" as const, description: "1-5" },
                applicable: { type: "boolean" as const, description: "false if this dimension does not apply to this transcript (excluded from averages)" },
                note: { type: "string" as const, description: "one terse sentence of justification" },
              },
            },
          ])
        ),
      },
      errors: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Specific, concrete problems (quote the offending label/claim). Empty if none.",
      },
      overall: { type: "integer" as const, description: "1-5 holistic usefulness to the teacher" },
      headline: { type: "string" as const, description: "one sentence verdict" },
    },
  },
};

export interface Judgment {
  scores: Record<Dimension, { score: number; applicable: boolean; note: string }>;
  errors: string[];
  overall: number;
  headline: string;
}

function caseBlock(c: TranscriptCase): string {
  const transcript = c.transcript
    .map((m) => `${m.role === "user" ? "SCHOLAR" : "TUTOR"}: ${m.content}`)
    .join("\n\n");
  let block = `## Session: "${c.title}"${c.unitTitle ? ` (unit: ${c.unitTitle})` : ""}\n\n### Transcript\n${transcript}`;
  if (c.pendingSeeds?.length) {
    block += `\n\n### Pending seeds already on the scholar's sky (refreshesSeedId dedup targets)\n${c.pendingSeeds
      .map((s) => `- [${s._id}] ${s.topic} (${s.domain ?? "general"})`)
      .join("\n")}`;
  }
  if (c.expectations?.length) {
    block += `\n\n### Gold expectations (what a perfect observer would do here)\n- ${c.expectations.join("\n- ")}`;
  }
  if (c.traps?.length) {
    block += `\n\n### Known traps in this case\n- ${c.traps.join("\n- ")}`;
  }
  return block;
}

function outputBlock(r: ObserverResult): string {
  return JSON.stringify(
    {
      pulse: r.pulse,
      observations: r.observations?.map((o) => ({
        conceptLabel: o.conceptLabel,
        domain: o.domain,
        masteryLevel: o.masteryLevel,
        confidenceScore: o.confidenceScore,
        evidenceType: o.evidenceType,
        evidenceSummary: o.evidenceSummary,
        studentInitiated: o.studentInitiated,
      })),
      sessionSignals: r.sessionSignals,
      crossDomainConnections: r.crossDomainConnections,
      seeds: r.seeds,
      inferredReadingLevel: r.inferredReadingLevel,
    },
    null,
    2
  );
}

export async function scoreRun(
  c: TranscriptCase,
  result: ObserverResult
): Promise<Judgment> {
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2048,
    system: RUBRIC,
    tools: [SCORE_TOOL],
    tool_choice: { type: "tool", name: "record_judgment" },
    messages: [
      {
        role: "user",
        content: `${caseBlock(c)}\n\n## Observer output to judge\n\`\`\`json\n${outputBlock(result)}\n\`\`\`\n\nScore it against the rubric.`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("judge: no tool_use");
  return block.input as Judgment;
}

const PAIR_TOOL = {
  name: "record_comparison" as const,
  description: "Record the blind pairwise verdict.",
  input_schema: {
    type: "object" as const,
    required: ["winner", "perDimension", "reasoning"],
    properties: {
      winner: { type: "string" as const, enum: ["A", "B", "tie"] },
      perDimension: {
        type: "object" as const,
        required: [...DIMENSIONS],
        properties: Object.fromEntries(
          DIMENSIONS.map((d) => [d, { type: "string" as const, enum: ["A", "B", "tie"] }])
        ),
      },
      reasoning: { type: "string" as const, description: "2-4 sentences on the decisive differences" },
    },
  },
};

export interface PairVerdict {
  winner: "A" | "B" | "tie";
  perDimension: Record<Dimension, "A" | "B" | "tie">;
  reasoning: string;
}

/** Blind comparison. Caller controls which model is A vs B (randomize + unmap). */
export async function comparePair(
  c: TranscriptCase,
  a: ObserverResult,
  b: ObserverResult
): Promise<PairVerdict> {
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1536,
    system: RUBRIC,
    tools: [PAIR_TOOL],
    tool_choice: { type: "tool", name: "record_comparison" },
    messages: [
      {
        role: "user",
        content: `${caseBlock(c)}\n\nTwo different observers analyzed this same session. Decide which output is more accurate and useful to the teacher, per the rubric. Judge on substance, not length or verbosity.\n\n## Observer A\n\`\`\`json\n${outputBlock(a)}\n\`\`\`\n\n## Observer B\n\`\`\`json\n${outputBlock(b)}\n\`\`\``,
      },
    ],
  });
  const block = response.content.find((b2) => b2.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("judge: no tool_use");
  return block.input as PairVerdict;
}
