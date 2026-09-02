/**
 * EXPERIMENT runner: cross every tutor prompt variant with every judge variant.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/socratic-handoff/experiment/run-experiment.ts [flags]
 *
 * Flags:
 *   --trials N        trials per (tutor × scenario) cell (default 3)
 *   --tutor-turns N   tutor turns per conversation, incl. opener (default 4)
 *   --concurrency N   parallel conversations (default 8)
 *   --tutors ids      comma-separated tutor-variant ids (default: all)
 *   --scenarios ids   comma-separated scenario ids (default: all)
 *   --out DIR         output dir (default evals/socratic-handoff/experiment/out)
 *
 * For each (tutor × scenario × trial): run a full handoff conversation with that
 * tutor's system prompt (reusing the shared scholar sim), then score the ONE
 * transcript with ALL judge variants. Writes results.json (consumed by
 * report.ts). Does NOT write the HTML — run report.ts for that, so the report
 * can be re-generated from the JSON without re-hitting the API.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS } from "../../../convex/lib/models";
import { runPool } from "../../lib/harness";
import { scholarReply, SCHOLAR_MODEL } from "../lib/scholarSim";
import type { Scenario, Turn } from "../lib/types";
import { withRetry } from "../lib/util";
import {
  EXPERIMENT_SCENARIOS,
  JUDGE_VARIANTS,
  TUTOR_VARIANTS,
  type GenericVerdict,
  type TutorVariant,
} from "./variants";

const HERE = dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic();
const TUTOR_MODEL = process.env.TUTOR_MODEL || MODELS.SONNET;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : def;
}

const trials = parseInt(arg("trials", "3") as string, 10);
const tutorTurnCount = parseInt(arg("tutor-turns", "4") as string, 10);
const concurrency = parseInt(arg("concurrency", "8") as string, 10);
const outDir = arg("out", join(HERE, "out")) as string;
const tutorFilter = arg("tutors");
const scenarioFilter = arg("scenarios");

const tutors = tutorFilter ? TUTOR_VARIANTS.filter((t) => tutorFilter.split(",").includes(t.id)) : TUTOR_VARIANTS;
const scenarios = scenarioFilter
  ? EXPERIMENT_SCENARIOS.filter((s) => scenarioFilter.split(",").includes(s.id))
  : EXPERIMENT_SCENARIOS;

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function callTutor(system: string, messages: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  const response = await withRetry(() =>
    anthropic.messages.create({ model: TUTOR_MODEL, max_tokens: 400, system, messages }),
  );
  return extractText(response);
}

const nonEmpty = (s: string, fallback: string) => (s.trim() ? s : fallback);

async function runConversation(tutor: TutorVariant, scenario: Scenario): Promise<Turn[]> {
  const system = tutor.build({ stem: scenario.stem, wrongAnswers: scenario.wrongAnswers });
  const turns: Turn[] = [];

  const opener = nonEmpty(
    await callTutor(system, [
      {
        role: "user",
        content:
          '(The scholar just tapped "Talk it through" after missing this twice. Open the session yourself — greet them briefly and start probing, grounded in the stem and their wrong answers above. Don\'t wait for them to speak first.)',
      },
    ]),
    "Okay — let's figure this out together. What did you try, or where did you get stuck?",
  );
  turns.push({ role: "assistant", content: opener });

  const scholarTurnCount = tutorTurnCount - 1;
  for (let i = 1; i <= scholarTurnCount; i++) {
    const scholarText =
      i === 1 && scenario.openingMove
        ? scenario.openingMove
        : nonEmpty(await scholarReply(scenario, turns, i, scholarTurnCount), "i still don't really get it");
    turns.push({ role: "user", content: scholarText });
    const tutorText = nonEmpty(
      await callTutor(system, turns.map((t) => ({ role: t.role, content: t.content }))),
      "Let's slow down — walk me through the very first step you'd take.",
    );
    turns.push({ role: "assistant", content: tutorText });
  }
  return turns;
}

export interface Cell {
  tutorId: string;
  scenarioId: string;
  trial: number;
  turns: Turn[];
  verdicts: Record<string, GenericVerdict>;
}

export interface ExperimentResults {
  generatedAt: string;
  tutorModel: string;
  scholarModel: string;
  judgeModel: string;
  trials: number;
  tutorTurns: number;
  tutorIds: string[];
  scenarioIds: string[];
  judgeIds: string[];
  cells: Cell[];
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const jobs: Array<{ tutor: TutorVariant; scenario: Scenario; trial: number }> = [];
  for (const tutor of tutors) {
    for (const scenario of scenarios) {
      for (let trial = 1; trial <= trials; trial++) jobs.push({ tutor, scenario, trial });
    }
  }

  console.error(
    `Running ${jobs.length} conversations (${tutors.length} tutors × ${scenarios.length} scenarios × ${trials} trials, ${tutorTurnCount} tutor turns) × ${JUDGE_VARIANTS.length} judges, concurrency ${concurrency}…`,
  );

  let done = 0;
  const cells = await runPool(jobs, async ({ tutor, scenario, trial }) => {
    const turns = await runConversation(tutor, scenario);
    const verdicts: Record<string, GenericVerdict> = {};
    for (const judge of JUDGE_VARIANTS) {
      verdicts[judge.id] = await judge.judge(scenario, turns);
    }
    done++;
    const flags = JUDGE_VARIANTS.filter((j) => verdicts[j.id].flag).map((j) => j.id);
    console.error(`  [${done}/${jobs.length}] ${tutor.id} × ${scenario.id} t${trial}${flags.length ? ` ⚑ ${flags.join(",")}` : ""}`);
    return { tutorId: tutor.id, scenarioId: scenario.id, trial, turns, verdicts };
  }, { concurrency });

  const results: ExperimentResults = {
    generatedAt: new Date().toISOString(),
    tutorModel: TUTOR_MODEL,
    scholarModel: SCHOLAR_MODEL,
    judgeModel: MODELS.OPUS,
    trials,
    tutorTurns: tutorTurnCount,
    tutorIds: tutors.map((t) => t.id),
    scenarioIds: scenarios.map((s) => s.id),
    judgeIds: JUDGE_VARIANTS.map((j) => j.id),
    cells,
  };
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.error(`\nDone. Wrote ${join(outDir, "results.json")} (${cells.length} cells). Now run report.ts to build the HTML.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
