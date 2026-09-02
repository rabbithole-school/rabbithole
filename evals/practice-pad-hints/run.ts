/**
 * Judged merge gate for pad-grounded practice hints.
 *
 * ANTHROPIC_API_KEY=... npx tsx evals/practice-pad-hints/run.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeRunArtifacts } from "../lib/harness";
import {
  JUDGE_MODEL,
  MODELS,
} from "../../convex/lib/models";
import {
  buildPadHintPrompt,
  PAD_HINT_TOOL,
  verifyPadHintOutput,
  type PadHintModelOutput,
} from "../../convex/lib/practice/padHints";
import { PAD_HINT_FIXTURES, type PadHintFixture } from "./fixtures";
import { renderPadPng } from "./renderPad";

const HERE = dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic();
const trials = Number(process.env.TRIALS ?? 4);
const models = [MODELS.HAIKU, MODELS.SONNET] as const;

const JUDGE_TOOL = {
  name: "record_pad_hint_verdict" as const,
  input_schema: {
    type: "object" as const,
    properties: {
      answerLeak: { type: "boolean" as const },
      leakQuote: { type: ["string", "null"] as const },
      groundsInTheirWork: {
        type: "integer" as const,
        description: "1-5; 5 names the specific visible move/slip and follows their method.",
      },
      notes: { type: "string" as const },
    },
    required: ["answerLeak", "leakQuote", "groundsInTheirWork", "notes"],
  },
};

type Verdict = {
  answerLeak: boolean;
  leakQuote: string | null;
  groundsInTheirWork: number;
  notes: string;
};

type Run = {
  model: string;
  fixtureId: string;
  trial: number;
  rawNudge: string | null;
  visibleNudge: string | null;
  verifiedSteps: boolean;
  verdict: Verdict;
};

async function candidate(model: string, fixture: PadHintFixture) {
  const image = renderPadPng(fixture.padLines).toString("base64");
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1200,
    tools: [PAD_HINT_TOOL],
    tool_choice: { type: "tool", name: PAD_HINT_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: image,
            },
          },
          {
            type: "text",
            text: buildPadHintPrompt({
              stem: fixture.stem,
              allowSteps: true,
            }),
          },
        ],
      },
    ],
  });
  const block = response.content.find((part) => part.type === "tool_use");
  const raw = block?.type === "tool_use"
    ? (block.input as PadHintModelOutput)
    : null;
  const verified = raw
    ? verifyPadHintOutput(raw, {
        answerCanonical: fixture.correctAnswer,
        answerType: fixture.answerType,
        allowSteps: true,
        stem: fixture.stem,
      })
    : null;
  return { raw, verified };
}

async function judge(
  fixture: PadHintFixture,
  visibleNudge: string | null,
): Promise<Verdict> {
  if (!visibleNudge) {
    return {
      answerLeak: false,
      leakQuote: null,
      groundsInTheirWork: 1,
      notes: "No verified model nudge reached the scholar.",
    };
  }
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 500,
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: JUDGE_TOOL.name },
    system:
      `Judge one pre-answer practice hint strictly. answerLeak=true ONLY if the hint states or confirms the CORRECT answer, gives a directly copyable correct final value, or supplies arithmetic whose value is the correct answer. A wrong or misleading hint is not an answer leak; punish it on groundsInTheirWork instead. Asking the scholar to compare or recompute a non-final sub-step is not itself a leak. groundsInTheirWork scores whether it references the specific visible move/slip and follows that method rather than giving a generic or canonical-algorithm hint.`,
    messages: [
      {
        role: "user",
        content:
          `Problem: ${fixture.stem}\n` +
          `Correct answer (judge-only): ${fixture.correctAnswer}\n` +
          `Synthetic pad transcription (judge-only): ${fixture.padLines.join(" | ")}\n` +
          `Recognizable slip/method: ${fixture.visibleSlip}\n` +
          `Scholar-visible nudge: ${visibleNudge}`,
      },
    ],
  });
  const block = response.content.find((part) => part.type === "tool_use");
  if (block?.type !== "tool_use") throw new Error("Pad hint judge returned no verdict");
  return block.input as Verdict;
}

async function main() {
  const runs: Run[] = [];
  for (const model of models) {
    for (const fixture of PAD_HINT_FIXTURES) {
      for (let trial = 1; trial <= trials; trial++) {
        const { raw, verified } = await candidate(model, fixture);
        const verdict = await judge(fixture, verified?.nudge ?? null);
        runs.push({
          model,
          fixtureId: fixture.id,
          trial,
          rawNudge: raw?.nudge ?? null,
          visibleNudge: verified?.nudge ?? null,
          verifiedSteps: !!verified?.workedSteps,
          verdict,
        });
        console.error(
          `[${runs.length}/${models.length * PAD_HINT_FIXTURES.length * trials}] ${model} ${fixture.id} ${verdict.answerLeak ? "LEAK" : `ground=${verdict.groundsInTheirWork}`}`,
        );
      }
    }
  }

  const lines = ["# Pad-grounded Hint eval", ""];
  for (const model of models) {
    const modelRuns = runs.filter((run) => run.model === model);
    const leaks = modelRuns.filter((run) => run.verdict.answerLeak).length;
    const grounding =
      modelRuns.reduce((sum, run) => sum + run.verdict.groundsInTheirWork, 0) /
      modelRuns.length;
    const accepted = modelRuns.filter((run) => run.visibleNudge).length;
    const steps = modelRuns.filter((run) => run.verifiedSteps).length;
    const passes = leaks / modelRuns.length < 0.05 && grounding >= 4;
    lines.push(
      `## ${model}`,
      "",
      `- answer leaks: **${leaks}/${modelRuns.length} (${((leaks / modelRuns.length) * 100).toFixed(1)}%)**`,
      `- groundsInTheirWork mean: **${grounding.toFixed(2)}/5**`,
      `- verified nudges: **${accepted}/${modelRuns.length}**`,
      `- verified step sequences: **${steps}/${modelRuns.length}**`,
      `- gate: **${passes ? "PASS" : "FAIL"}** (<5% leak and grounding >=4.0)`,
      "",
    );
  }
  lines.push(
    "## Runs",
    "",
    "| model | fixture | trial | visible nudge | leak | grounding | notes |",
    "|---|---|---:|---|---|---:|---|",
    ...runs.map(
      (run) =>
        `| ${run.model} | ${run.fixtureId} | ${run.trial} | ${(run.visibleNudge ?? "(fallback)").replace(/\|/g, "/")} | ${run.verdict.answerLeak ? "yes" : "no"} | ${run.verdict.groundsInTheirWork} | ${run.verdict.notes.replace(/\|/g, "/")} |`,
    ),
  );
  const out = join(HERE, "out");
  writeRunArtifacts({
    outDir: out,
    runs,
    report: `${lines.join("\n")}\n`,
  });
  console.error(`Wrote ${join(out, "report.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
