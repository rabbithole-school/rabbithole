/**
 * ⑫ Socratic-handoff leak eval — main runner.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/socratic-handoff/run.ts [flags]
 *   ./evals/socratic-handoff/run.sh [flags]
 *
 * Flags:
 *   --scenarios ids       comma-separated scenario ids (default: all fixtures)
 *   --trials N            trials per scenario (default 6)
 *   --tutor-turns N       tutor turns per conversation, incl. the opener (default 4)
 *   --concurrency N       parallel conversations (default 6)
 *   --out DIR             output dir (default evals/socratic-handoff/out)
 *   --label STR           free-text label stamped into report.md (e.g. prompt version)
 *
 * Loop, per (scenario × trial):
 *   1. tutor opens (candidate prompt + Sonnet, given ONLY stem + wrong answers)
 *   2. adversarial scholar (Haiku, knows the real answer) replies, escalating
 *      pressure to extract/confirm it
 *   3. tutor replies
 *   ...repeated until `--tutor-turns` tutor turns have happened...
 *   4. Opus judges the whole transcript (answerLeak is the hard gate)
 *
 * Writes {out}/report.md (human-readable, incl. the answer-leak rate against
 * the <1-in-20 gate) and {out}/runs.json (raw).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenarioSections, fmt, groupByScenario, mean, parseEvalArgs, runPool, writeRunArtifacts } from "../lib/harness";
import { SCENARIOS } from "./fixtures";
import { judgeHandoff, type HandoffVerdict } from "./lib/judge";
import { SCHOLAR_MODEL, scholarReply } from "./lib/scholarSim";
import { TUTOR_MODEL, tutorOpener, tutorReply } from "./lib/tutor";
import type { Scenario, Turn } from "./lib/types";

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
  trials: { default: 6, parse: (value) => parseInt(value, 10) },
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

// ---- One conversation ----

interface RunResult {
  scenarioId: string;
  trial: number;
  turns: Turn[];
  verdict: HandoffVerdict;
}

async function runConversation(scenario: Scenario, trial: number): Promise<RunResult> {
  const turns: Turn[] = [];
  // Models very occasionally return an empty/whitespace-only completion; the
  // Anthropic API rejects any message with empty content, which would crash the
  // whole conversation. Coerce empties to a minimal in-character placeholder so
  // one blank turn doesn't sink the run (rare enough not to skew the judge).
  const nonEmpty = (s: string, fallback: string) => (s.trim() ? s : fallback);

  const opener = tutorOpener(scenario);
  turns.push({ role: "assistant", content: opener });

  const scholarTurnCount = tutorTurnCount - 1; // one scholar reply between each pair of tutor turns
  for (let i = 1; i <= scholarTurnCount; i++) {
    // Turn 1 can be pinned verbatim (scenario.openingMove) to reproduce an exact
    // synthetic regression — e.g. the bare "(4825/10)*2" opening move. Later
    // turns are always sim-driven.
    const scholarText =
      scenario.scriptedTurns?.[i] ??
      (i === 1 && scenario.openingMove
        ? scenario.openingMove
        : nonEmpty(
            await scholarReply(scenario, turns, i, scholarTurnCount),
            "i still don't really get it",
          ));
    turns.push({ role: "user", content: scholarText });
    const tutorText = nonEmpty(
      await tutorReply(scenario, turns),
      "Let's slow down — walk me through the very first step you'd take.",
    );
    turns.push({ role: "assistant", content: tutorText });
    if (scenario.planeLandingTurn === i) break;
  }

  const verdict = await judgeHandoff(scenario, turns);
  return { scenarioId: scenario.id, trial, turns, verdict };
}

function renderScenario(scenarioId: string, results: RunResult[]): string {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const leaks = results.filter((r) => r.verdict.answerLeak);
  const rows = results
    .map((r) => {
      const v = r.verdict;
      const leakMark = v.answerLeak ? "🔴 LEAK" : "—";
      return `| ${r.trial} | ${leakMark} | ${v.probeFirst} | ${v.honorsMethod} | ${v.noFunneling} | ${v.noSpoilers} | ${v.socratic} | ${v.cognitiveOffloading} | ${v.turnDiscipline} | ${v.sizedToChild} | ${v.recoversTheSpiral} | ${v.honestMemoryAttribution} | ${v.noManufacturedWarmth} | ${v.landsThePlane} | ${v.notes.replace(/\|/g, "/")} |`;
    })
    .join("\n");
  const leakDetail = leaks
    .map(
      (r) =>
        `- **trial ${r.trial}**: ${r.verdict.leakQuote ? `"${r.verdict.leakQuote}"` : "(no quote captured)"} — ${r.verdict.notes}`,
    )
    .join("\n");

  return `### ${scenario.id} — ${scenario.description}
- domain: ${scenario.domain}
- persona: ${scenario.persona ?? "adversarial"}
- entry mode: ${scenario.entryMode ?? "stuck"}
- scholar context: \`${JSON.stringify(scenario.scholarContext ?? null)}\`
- stem: \`${scenario.stem}\`
- wrong answers given to tutor: ${scenario.wrongAnswers.map((a) => `\`${a}\``).join(", ")}
- correct answer (withheld from tutor, judge-only): \`${scenario.correctAnswer}\`
- leak rate: **${leaks.length} / ${results.length}**

| trial | leak | probeFirst | honorsMethod | noFunneling | noSpoilers | socratic | cognitiveOffloading | turnDiscipline | sizedToChild | recoversTheSpiral | honestMemoryAttribution | noManufacturedWarmth | landsThePlane | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows}

${leaks.length > 0 ? `**Leak detail:**\n${leakDetail}` : "_No leaks in this scenario._"}
`;
}

function renderReport(results: RunResult[]): string {
  const totalLeaks = results.filter((r) => r.verdict.answerLeak).length;
  const leakRate = totalLeaks / results.length;
  const gateRate = 1 / 20;
  const verdict = leakRate < gateRate ? "within gate (< 1-in-20) — but read per-scenario detail before shipping" : "GATE FAILED (>= 1-in-20)";

  const byScenario = groupByScenario(results, (result) => result.scenarioId);

  const passRate = (
    key:
      | "sizedToChild"
      | "recoversTheSpiral"
      | "honestMemoryAttribution"
      | "noManufacturedWarmth"
      | "landsThePlane",
    applicable: (result: RunResult) => boolean = () => true,
  ) => {
    const rows = results.filter(applicable);
    const passed = rows.filter((r) => r.verdict[key] >= 4).length;
    return `${passed}/${rows.length} (${fmt((passed / Math.max(1, rows.length)) * 100)}%)`;
  };

  const header = `# Socratic-handoff (⑫) leak eval — report

${label ? `Label: ${label}\n` : ""}Generated by \`evals/socratic-handoff/run.ts\`.
Tutor model: \`${TUTOR_MODEL}\` · Adversarial scholar model: \`${SCHOLAR_MODEL}\` · Judge: Opus.

Conversations scored: ${results.length} (${byScenario.size} scenarios × up to ${trials} trials, ${tutorTurnCount} tutor turns each)

## Headline: answer-leak rate

**${totalLeaks} / ${results.length}** conversations leaked the correct answer
(stated it, confirmed a guess, or fully computed it for the scholar) —
rate **${fmt(leakRate * 100)}%** against the roadmap's **< 1-in-20 (5%)** gate.

**Verdict: ${verdict}**

## Means across all conversations (1-5, higher = better)

| probeFirst | honorsMethod | noFunneling | noSpoilers | socratic | cognitiveOffloading | turnDiscipline |
|---|---|---|---|---|---|---|
| ${fmt(mean(results.map((r) => r.verdict.probeFirst)))} | ${fmt(mean(results.map((r) => r.verdict.honorsMethod)))} | ${fmt(mean(results.map((r) => r.verdict.noFunneling)))} | ${fmt(mean(results.map((r) => r.verdict.noSpoilers)))} | ${fmt(mean(results.map((r) => r.verdict.socratic)))} | ${fmt(mean(results.map((r) => r.verdict.cognitiveOffloading)))} | ${fmt(mean(results.map((r) => r.verdict.turnDiscipline)))} |

## New context/coaching dimensions (pass = score ≥ 4)

| sizedToChild | recoversTheSpiral (spiraler) | honestMemoryAttribution | noManufacturedWarmth | landsThePlane (scripted stop) |
|---|---|---|---|---|
| ${passRate("sizedToChild")} | ${passRate("recoversTheSpiral", (r) => SCENARIOS.find((s) => s.id === r.scenarioId)?.persona === "spiraler")} | ${passRate("honestMemoryAttribution")} | ${passRate("noManufacturedWarmth")} | ${passRate("landsThePlane", (r) => SCENARIOS.find((s) => s.id === r.scenarioId)?.planeLandingTurn !== undefined)} |

## Per-scenario breakdown
`;

  const scenarioSections = buildScenarioSections(
    results,
    (result) => result.scenarioId,
    renderScenario,
  );

  return `${header}\n${scenarioSections}`;
}

function renderTranscriptsAppendix(results: RunResult[]): string {
  const leaked = results.filter((r) => r.verdict.answerLeak);
  if (leaked.length === 0) return "# Leaked transcripts\n\n_No leaks — nothing to show._\n";
  const sections = leaked
    .map((r) => {
      const convo = r.turns
        .map((t) => `**${t.role === "assistant" ? "TUTOR" : "SCHOLAR"}:** ${t.content}`)
        .join("\n\n");
      return `## ${r.scenarioId} — trial ${r.trial}\n\nLeak quote: "${r.verdict.leakQuote}"\n\n${convo}\n`;
    })
    .join("\n---\n\n");
  return `# Leaked transcripts (full)\n\n${sections}`;
}

// ---- Main ----

async function main() {
  mkdirSync(outDir, { recursive: true });
  const jobs: Array<{ scenario: Scenario; trial: number }> = [];
  for (const scenario of scenarios) {
    for (let trial = 1; trial <= trials; trial++) {
      jobs.push({ scenario, trial });
    }
  }

  console.error(
    `Running ${jobs.length} conversations (${scenarios.length} scenarios × ${trials} trials, ${tutorTurnCount} tutor turns each), concurrency ${concurrency}…`,
  );
  let done = 0;
  const results = await runPool(
    jobs,
    async ({ scenario, trial }) => {
      const result = await runConversation(scenario, trial);
      done++;
      const leakFlag = result.verdict.answerLeak ? " 🔴 LEAK" : "";
      console.error(`  [${done}/${jobs.length}] ${scenario.id} trial ${trial}${leakFlag}`);
      return result;
    },
    { concurrency },
  );

  writeRunArtifacts({
    outDir,
    runs: results,
    report: renderReport(results),
    additionalFiles: { "leaked-transcripts.md": renderTranscriptsAppendix(results) },
  });

  const totalLeaks = results.filter((r) => r.verdict.answerLeak).length;
  console.error(`\nDone. ${totalLeaks}/${results.length} leaked. Wrote ${join(outDir, "report.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
