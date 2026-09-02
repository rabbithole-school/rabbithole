/**
 * ⑮ problems-in-chat eval — main runner.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/problems-in-chat/run.ts [flags]
 *   ./evals/problems-in-chat/run.sh [flags]
 *
 * Flags:
 *   --scenarios ids     comma-separated scenario ids (default: all fixtures)
 *   --trials N          trials per scenario (default 4)
 *   --tutor-turns N     tutor turns per conversation, incl. the first (default 4)
 *   --concurrency N     parallel conversations (default 6)
 *   --out DIR           output dir (default evals/problems-in-chat/out)
 *   --label STR         free-text label stamped into report.md
 *
 * Loop, per (scenario × trial):
 *   1. scholar opens (scenario.scholarOpener)
 *   2. tutor replies (candidate prompt = eval preamble + SHIPPED practice
 *      section; has the SHIPPED serve_practice_problem tool). If it serves an
 *      item, the harness resolves + generates a real item and feeds back the
 *      STEM only (answer withheld).
 *   3. scholar replies — in-persona; if an item was served, answers/baits it
 *      (knowing the real answer, to pressure the leak gate).
 *   ...repeated until `--tutor-turns` tutor turns…
 *   4. Opus judges the transcript. appropriateUse is the core pedagogical
 *      metric; answerLeak is the hard gate.
 *
 * Also computes an OBJECTIVE serve-appropriateness matrix from mechanical
 * serve-detection × each scenario's expectServe flag (independent of the judge).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenarioSections, fmt, groupByScenario, mean, parseEvalArgs, runPool, writeRunArtifacts } from "../lib/harness";
import { SCENARIOS } from "./fixtures";
import { judge, type Verdict } from "./lib/judge";
import { SCHOLAR_MODEL, scholarReply } from "./lib/scholarSim";
import { buildTutorSystem, TUTOR_MODEL, tutorTurn } from "./lib/tutor";
import type { Scenario, ServedItem, Turn } from "./lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));

const {
  scenarios: scenarioIds,
  trials,
  tutorTurns: tutorTurnCount,
  concurrency,
  out: outDir,
  label,
} = parseEvalArgs({
  scenarios: { default: undefined as string | undefined },
  trials: { default: 4, parse: (value) => parseInt(value, 10) },
  tutorTurns: { flag: "tutor-turns", default: 4, parse: (value) => parseInt(value, 10) },
  concurrency: { default: 6, parse: (value) => parseInt(value, 10) },
  out: { default: join(HERE, "out") },
  label: { default: "" },
});

const scenarios: Scenario[] = scenarioIds
  ? SCENARIOS.filter((s) => scenarioIds.split(",").includes(s.id))
  : SCENARIOS;

if (scenarios.length === 0) {
  console.error("No matching scenarios.");
  process.exit(1);
}

interface RunResult {
  scenarioId: string;
  trial: number;
  turns: Turn[];
  served: ServedItem[];
  verdict: Verdict;
}

async function runConversation(scenario: Scenario, trial: number): Promise<RunResult> {
  const system = buildTutorSystem(scenario);
  const turns: Turn[] = [{ role: "user", content: scenario.scholarOpener }];
  const allServed: ServedItem[] = [];
  const seedBase = (scenario.id.length * 1000 + trial * 97) >>> 0;

  for (let t = 0; t < tutorTurnCount; t++) {
    const { text, served } = await tutorTurn(scenario, system, turns, turns.length, seedBase + t * 13);
    turns.push({ role: "assistant", content: text });
    allServed.push(...served);
    if (t < tutorTurnCount - 1) {
      const lastServed = served.filter((s) => s.stem).at(-1) ?? null;
      const scholarText = await scholarReply(scenario, turns, lastServed);
      turns.push({ role: "user", content: scholarText });
    }
  }

  const verdict = await judge(scenario, turns, allServed);
  return { scenarioId: scenario.id, trial, turns, served: allServed, verdict };
}

function servedAny(r: RunResult): boolean {
  return r.served.some((s) => s.stem);
}

function hasStackedServes(r: RunResult): boolean {
  const turnIndexes = r.served
    .filter((s) => s.stem)
    .map((s) => s.atTurnIndex)
    .sort((a, b) => a - b);
  // A tutor turn occurs every two history entries. Consecutive tool-serving
  // tutor turns leave no tutor reflection/feedback turn between practice reps.
  return turnIndexes.some((turnIndex, i) => i > 0 && turnIndex - turnIndexes[i - 1] <= 2);
}

function renderScenario(scenarioId: string, results: RunResult[]): string {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const leaks = results.filter((r) => r.verdict.answerLeak);
  const servedCount = results.filter(servedAny).length;
  const stackedCount = results.filter(hasStackedServes).length;
  const expectedMinServes = scenario.expectedMinServes;
  const multiRepMisses = expectedMinServes
    ? results.filter((r) => r.served.filter((s) => s.stem).length < expectedMinServes).length
    : 0;
  const rows = results
    .map((r) => {
      const v = r.verdict;
      const serve = servedAny(r) ? "✅" : "—";
      const leakMark = v.answerLeak ? "🔴" : "—";
      const servedDetail = r.served.filter((s) => s.stem).length;
      return `| ${r.trial} | ${serve} (${servedDetail}) | ${hasStackedServes(r) ? "🔴" : "—"} | ${leakMark} | ${v.probeFirst} | ${v.appropriateUse} | ${v.retrievalFraming} | ${v.noOverQuizzing} | ${v.readTheRoom} | ${v.notes.replace(/\|/g, "/")} |`;
    })
    .join("\n");
  const leakDetail = leaks
    .map(
      (r) => `- **trial ${r.trial}**: ${r.verdict.leakQuote ? `"${r.verdict.leakQuote}"` : "(no quote)"} — ${r.verdict.notes}`,
    )
    .join("\n");
  return `### ${scenario.id} — ${scenario.description}
- serve-appropriate: **${scenario.expectServe ? "YES" : "NO"}**  ·  tutor served: **${servedCount} / ${results.length}**  ·  stacked serves: **${stackedCount} / ${results.length}**  ·  leaks: **${leaks.length} / ${results.length}**
${scenario.expectedMinServes ? `- multi-rep target: **at least ${scenario.expectedMinServes} spaced serves**; misses: **${multiRepMisses} / ${results.length}**` : ""}

| trial | served (count) | stacked | leak | probeFirst | appropriateUse | retrievalFraming | noOverQuizzing | readTheRoom | notes |
|---|---|---|---|---|---|---|---|---|---|
${rows}

${leaks.length > 0 ? `**Leak detail:**\n${leakDetail}` : ""}`;
}

function renderReport(results: RunResult[]): string {
  const totalLeaks = results.filter((r) => r.verdict.answerLeak).length;
  const leakRate = totalLeaks / results.length;
  const gateRate = 1 / 20;

  // Objective serve-appropriateness matrix (mechanical serve × expectServe).
  const shouldServe = results.filter((r) => SCENARIOS.find((s) => s.id === r.scenarioId)!.expectServe);
  const shouldWithhold = results.filter((r) => !SCENARIOS.find((s) => s.id === r.scenarioId)!.expectServe);
  const servedWhenShould = shouldServe.filter(servedAny).length;
  const withheldWhenShould = shouldServe.length - servedWhenShould; // missed opportunities (mild)
  const servedWhenShouldnt = shouldWithhold.filter(servedAny).length; // OVER-EAGER — the roadmap's core fear
  const withheldWhenShouldnt = shouldWithhold.length - servedWhenShouldnt; // good restraint

  const appropriateUseMean = mean(results.map((r) => r.verdict.appropriateUse));
  const leakOk = leakRate < gateRate;
  const overEagerRate = shouldWithhold.length ? servedWhenShouldnt / shouldWithhold.length : 0;
  const stackedServes = results.filter(hasStackedServes).length;
  // Ship gate: no answer leaks, strong appropriateUse, and low over-eager serving.
  const recommend =
    leakOk && stackedServes === 0 && appropriateUseMean >= 4 && overEagerRate <= 0.1
      ? "SHIP-CANDIDATE (pending owner review)"
      : leakOk && appropriateUseMean >= 3.5 && overEagerRate <= 0.25
        ? "PROMISING — tighten the prompt, re-run, then owner review"
        : "DO NOT SHIP — prompt needs work (see failures below)";

  const byScenario = groupByScenario(results, (result) => result.scenarioId);

  const header = `# problems-in-chat (⑮) eval — report

${label ? `Label: ${label}\n` : ""}Generated by \`evals/problems-in-chat/run.ts\`.
Tutor model: \`${TUTOR_MODEL}\` · Scholar sim: \`${SCHOLAR_MODEL}\` · Judge: Opus.
Prompt section under test imported from \`convex/lib/practice/chatPractice.ts\` (eval == shipped).

Conversations scored: ${results.length} (${byScenario.size} scenarios × up to ${trials} trials, ${tutorTurnCount} tutor turns each)

## Ship recommendation: **${recommend}**

## Hard gate — answer-leak rate
**${totalLeaks} / ${results.length}** conversations leaked the served item's answer — rate **${fmt(leakRate * 100)}%** vs. the **< 5% (1-in-20)** gate → **${leakOk ? "PASS" : "FAIL"}**.

## Core metric — serve-appropriateness (objective: mechanical serve × expectServe)

| moment | count | tutor served | tutor withheld |
|---|---|---|---|
| SHOULD serve | ${shouldServe.length} | **${servedWhenShould}** ✅ | ${withheldWhenShould} (missed) |
| should WITHHOLD | ${shouldWithhold.length} | **${servedWhenShouldnt}** 🔴 over-eager | ${withheldWhenShouldnt} ✅ restraint |

- Over-eager rate (served when it shouldn't have): **${fmt(overEagerRate * 100)}%** (roadmap's core fear — lecture-then-test / testing a new topic).
- Serve rate when appropriate: **${fmt((shouldServe.length ? servedWhenShould / shouldServe.length : 0) * 100)}%**.
- Crowded-serve runs (two problems without a tutor reflection/feedback turn between): **${stackedServes} / ${results.length}**.

## Judge means (1-5, higher = better)

| probeFirst | appropriateUse | retrievalFraming | noOverQuizzing | readTheRoom | cognitiveOffloading |
|---|---|---|---|---|---|
| ${fmt(mean(results.map((r) => r.verdict.probeFirst)))} | ${fmt(appropriateUseMean)} | ${fmt(mean(results.map((r) => r.verdict.retrievalFraming)))} | ${fmt(mean(results.map((r) => r.verdict.noOverQuizzing)))} | ${fmt(mean(results.map((r) => r.verdict.readTheRoom)))} | ${fmt(mean(results.map((r) => r.verdict.cognitiveOffloading)))} |

## Per-scenario breakdown
`;

  const sections = buildScenarioSections(
    results,
    (result) => result.scenarioId,
    renderScenario,
    "\n\n",
  );
  return `${header}\n${sections}`;
}

function renderTranscripts(results: RunResult[]): string {
  const notable = results.filter((r) => r.verdict.answerLeak || servedAny(r));
  if (notable.length === 0) return "# Transcripts\n\n_No items served, no leaks._\n";
  const sections = notable
    .map((r) => {
      const convo = r.turns
        .map((t) => `**${t.role === "assistant" ? "TUTOR" : "SCHOLAR"}:** ${t.content}`)
        .join("\n\n");
      const flags = `${r.verdict.answerLeak ? "🔴 LEAK · " : ""}served ${r.served.filter((s) => s.stem).length}`;
      return `## ${r.scenarioId} — trial ${r.trial} (${flags})\n\n${convo}\n`;
    })
    .join("\n---\n\n");
  return `# Transcripts where the tutor served an item (or leaked)\n\n${sections}`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const jobs: Array<{ scenario: Scenario; trial: number }> = [];
  for (const scenario of scenarios)
    for (let trial = 1; trial <= trials; trial++) jobs.push({ scenario, trial });

  console.error(
    `Running ${jobs.length} conversations (${scenarios.length} scenarios × ${trials} trials, ${tutorTurnCount} tutor turns), concurrency ${concurrency}…`,
  );
  let done = 0;
  const results = await runPool(
    jobs,
    async ({ scenario, trial }) => {
      const result = await runConversation(scenario, trial);
      done++;
      const flags = `${result.verdict.answerLeak ? " 🔴 LEAK" : ""}${servedAny(result) ? " [served]" : ""}`;
      console.error(`  [${done}/${jobs.length}] ${scenario.id} trial ${trial}${flags}`);
      return result;
    },
    { concurrency },
  );

  writeRunArtifacts({
    outDir,
    runs: results,
    report: renderReport(results),
    additionalFiles: { "transcripts.md": renderTranscripts(results) },
  });

  const totalLeaks = results.filter((r) => r.verdict.answerLeak).length;
  console.error(`\nDone. ${totalLeaks}/${results.length} leaked. Wrote ${join(outDir, "report.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
