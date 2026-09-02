/**
 * teach-back ("explain it back" viva) eval — main runner.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/teach-back/run.ts [flags]
 *   ./evals/teach-back/run.sh [flags]
 *
 * Flags:
 *   --scenarios ids     comma-separated scenario ids (default: all fixtures)
 *   --trials N          trials per scenario (default 4)
 *   --tutor-turns N     tutor turns per conversation, incl. the first (default 5)
 *   --concurrency N     parallel conversations (default 6)
 *   --out DIR           output dir (default evals/teach-back/out)
 *   --label STR         free-text label stamped into report.md
 *
 * Loop, per (scenario × trial):
 *   1. scholar opens (scenario.scholarOpener).
 *   2. tutor replies (candidate = eval preamble + SHIPPED teach-back section;
 *      has the SHIPPED start/finish tools). When it calls a teach-back tool the
 *      harness hands back the SHIPPED guidance string (see lib/tutor.ts).
 *   3. scholar replies in-persona — teaches the concept at the target band, or
 *      stays stuck when the moment is not a teach-back one.
 *   …repeated until `--tutor-turns` tutor turns…
 *   4. If a teach-back was entered, run the SHIPPED private grader on the
 *      teach-back transcript (does the rubric discriminate strong/thin/wrong?).
 *   5. Opus judges the conversation: the hard gates (answerLeak / gradeLeak /
 *      privateReviewLeak) and the behavior dims (novice stance, probes, no
 *      mid-correction, method-not-character, warm exit, cadence fit).
 *
 * Also computes an OBJECTIVE cadence matrix from mechanical teach-back detection
 * × each scenario's expectTeachBack flag (independent of the judge).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenarioSections, fmt, groupByScenario, mean, parseEvalArgs, runPool, writeRunArtifacts } from "../lib/harness";
import { SCENARIOS } from "./fixtures";
import { gradeTeachBack, renderTeachBackTranscript, type GradeResult } from "./lib/grader";
import { judge, type Verdict } from "./lib/judge";
import { SCHOLAR_MODEL, scholarReply } from "./lib/scholarSim";
import { buildTutorSystem, TUTOR_MODEL, tutorTurn } from "./lib/tutor";
import type { ExplanationQuality, Scenario, TeachBackEvent, Turn } from "./lib/types";

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
  tutorTurns: { flag: "tutor-turns", default: 5, parse: (value) => parseInt(value, 10) },
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
  events: TeachBackEvent[];
  enteredTeachBack: boolean;
  grade: GradeResult;
  verdict: Verdict;
}

async function runConversation(scenario: Scenario, trial: number): Promise<RunResult> {
  const system = buildTutorSystem();
  const turns: Turn[] = [{ role: "user", content: scenario.scholarOpener }];
  const events: TeachBackEvent[] = [];

  for (let t = 0; t < tutorTurnCount; t++) {
    const { text, events: turnEvents } = await tutorTurn(system, turns, turns.length, events);
    // Coerce empties: the model can occasionally return no visible text (e.g. a
    // bare tool call), and the Anthropic API rejects an empty-content turn on
    // the next call. A placeholder keeps the loop alive AND surfaces the silence.
    turns.push({ role: "assistant", content: text.trim() || "(the tutor gave no visible reply)" });
    events.push(...turnEvents);
    if (t < tutorTurnCount - 1) {
      const scholarText = await scholarReply(scenario, turns);
      turns.push({ role: "user", content: scholarText.trim() || "(the scholar gave no reply)" });
    }
  }

  const startEvent = events.find((e) => e.tool === "start_teach_back") ?? null;
  const enteredTeachBack = startEvent !== null;

  let grade: GradeResult = { rubric: null, total: null };
  if (enteredTeachBack) {
    const conceptLabel = startEvent?.conceptLabel || scenario.concept;
    const transcript = renderTeachBackTranscript(turns, startEvent?.atTurnIndex ?? 0);
    grade = await gradeTeachBack(conceptLabel, transcript);
  }

  const verdict = await judge(scenario, turns, enteredTeachBack);
  return { scenarioId: scenario.id, trial, turns, events, enteredTeachBack, grade, verdict };
}

/** Mean over the non-null values a selector pulls from the results. */
function meanOf(results: RunResult[], sel: (v: Verdict) => number | null): number {
  const xs = results.map((r) => sel(r.verdict)).filter((x): x is number => x !== null);
  return mean(xs);
}
function renderScenario(scenarioId: string, results: RunResult[]): string {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const entered = results.filter((r) => r.enteredTeachBack).length;
  const leaks = results.filter((r) => r.verdict.answerLeak);
  const gradeLeaks = results.filter((r) => r.verdict.gradeLeak);
  const reviewLeaks = results.filter((r) => r.verdict.privateReviewLeak);
  const n = (x: number | null) => (x === null ? "—" : String(x));
  const rows = results
    .map((r) => {
      const v = r.verdict;
      const tb = r.enteredTeachBack ? "✅" : "—";
      const gates = [v.answerLeak ? "ans" : "", v.gradeLeak ? "grade" : "", v.privateReviewLeak ? "review" : ""].filter(Boolean).join("+") || "—";
      const total = r.grade.total === null ? "—" : `${r.grade.total}/12`;
      return `| ${r.trial} | ${tb} | ${gates} | ${n(v.noviceStanceHeld)} | ${n(v.probeQuality)} | ${n(v.noMidCorrection)} | ${n(v.methodNotCharacter)} | ${n(v.warmExit)} | ${v.cadenceFit} | ${total} | ${v.notes.replace(/\|/g, "/")} |`;
    })
    .join("\n");
  const leakDetail = [...leaks, ...gradeLeaks, ...reviewLeaks]
    .filter((r, i, arr) => arr.indexOf(r) === i)
    .map(
      (r) =>
        `- **trial ${r.trial}** [${[r.verdict.answerLeak ? "answerLeak" : "", r.verdict.gradeLeak ? "gradeLeak" : "", r.verdict.privateReviewLeak ? "privateReviewLeak" : ""].filter(Boolean).join(", ")}]: ${r.verdict.leakQuote ? `"${r.verdict.leakQuote}"` : "(no quote)"} — ${r.verdict.notes}`,
    )
    .join("\n");
  const band = scenario.explanationQuality ? ` · target band: **${scenario.explanationQuality}**` : "";
  return `### ${scenario.id} — ${scenario.description}
- teach-back-appropriate: **${scenario.expectTeachBack ? "YES" : "NO"}**${band}  ·  tutor entered: **${entered} / ${results.length}**  ·  gate trips (ans/grade/review): **${leaks.length}/${gradeLeaks.length}/${reviewLeaks.length}**

| trial | teach-back | gates | novice | probes | noMidCorr | method≠char | warmExit | cadence | grader | notes |
|---|---|---|---|---|---|---|---|---|---|---|
${rows}

${leakDetail ? `**Gate trips:**\n${leakDetail}` : ""}`;
}

function renderReport(results: RunResult[]): string {
  // Hard gates describe conduct INSIDE a teach-back, so they're scored over the
  // conversations that actually entered one (the opportunities to leak). A
  // conversation that correctly never entered a teach-back can't trip them.
  const tbResults = results.filter((r) => r.enteredTeachBack);
  const gateDenom = tbResults.length;
  const totalAnswerLeaks = tbResults.filter((r) => r.verdict.answerLeak).length;
  const totalGradeLeaks = tbResults.filter((r) => r.verdict.gradeLeak).length;
  const totalReviewLeaks = tbResults.filter((r) => r.verdict.privateReviewLeak).length;
  const answerLeakRate = gateDenom ? totalAnswerLeaks / gateDenom : 0;
  const answerGateRate = 1 / 20;

  // Objective cadence matrix (mechanical teach-back entry × expectTeachBack).
  const shouldTB = results.filter((r) => SCENARIOS.find((s) => s.id === r.scenarioId)!.expectTeachBack);
  const shouldNotTB = results.filter((r) => !SCENARIOS.find((s) => s.id === r.scenarioId)!.expectTeachBack);
  const enteredWhenShould = shouldTB.filter((r) => r.enteredTeachBack).length;
  const missedWhenShould = shouldTB.length - enteredWhenShould; // missed opportunities (mild)
  const enteredWhenShouldnt = shouldNotTB.filter((r) => r.enteredTeachBack).length; // PREMATURE — the core fear
  const withheldWhenShouldnt = shouldNotTB.length - enteredWhenShouldnt; // good restraint
  const prematureRate = shouldNotTB.length ? enteredWhenShouldnt / shouldNotTB.length : 0;

  // Judge behavior dims, over conversations that actually entered a teach-back.
  const noviceMean = meanOf(tbResults, (v) => v.noviceStanceHeld);
  const probeMean = meanOf(tbResults, (v) => v.probeQuality);
  const noMidCorrMean = meanOf(tbResults, (v) => v.noMidCorrection);
  const methodMean = meanOf(tbResults, (v) => v.methodNotCharacter);
  const warmExitMean = meanOf(tbResults, (v) => v.warmExit);
  const cadenceMean = meanOf(results, (v) => v.cadenceFit);

  // Grader discrimination: mean total (0-12) per target band.
  const gradeByBand = (band: ExplanationQuality): number[] =>
    results
      .filter((r) => SCENARIOS.find((s) => s.id === r.scenarioId)!.explanationQuality === band && r.grade.total !== null)
      .map((r) => r.grade.total as number);
  const strongTotals = gradeByBand("strong");
  const thinTotals = gradeByBand("thin");
  const wrongTotals = gradeByBand("wrong");
  const strongMean = mean(strongTotals);
  const thinMean = mean(thinTotals);
  const wrongMean = mean(wrongTotals);
  const discriminates =
    strongTotals.length > 0 &&
    (thinTotals.length === 0 || strongMean > thinMean) &&
    (wrongTotals.length === 0 || strongMean > wrongMean);

  // Ship gate.
  const answerOk = answerLeakRate < answerGateRate;
  const gradeOk = totalGradeLeaks === 0;
  const reviewOk = totalReviewLeaks === 0;
  const coreDimsOk = noviceMean >= 4 && noMidCorrMean >= 4 && methodMean >= 4 && probeMean >= 4;
  const cadenceOk = cadenceMean >= 4 && prematureRate <= 0.1;
  const gatesHardOk = answerOk && gradeOk && reviewOk;

  const recommend =
    gatesHardOk && coreDimsOk && cadenceOk && discriminates
      ? "SHIP-CANDIDATE (pending owner review)"
      : gatesHardOk && noviceMean >= 3.5 && noMidCorrMean >= 3.5 && methodMean >= 3.5 && cadenceMean >= 3.5
        ? "PROMISING — tighten the prompt, re-run, then owner review"
        : "DO NOT SHIP — prompt needs work (see failures below)";

  const byScenario = groupByScenario(results, (result) => result.scenarioId);

  const header = `# teach-back ("explain it back" viva) eval — report

${label ? `Label: ${label}\n` : ""}Generated by \`evals/teach-back/run.ts\`.
Tutor model: \`${TUTOR_MODEL}\` · Scholar sim: \`${SCHOLAR_MODEL}\` · Judge: Opus · Grader (private): shipped tier.
Prompt section + tools + grader imported from \`convex/lib/teachBack.ts\` (eval == shipped; guarded by \`__tests__/specSync.test.ts\`).

Conversations scored: ${results.length} (${byScenario.size} scenarios × up to ${trials} trials, ${tutorTurnCount} tutor turns each)

## Ship recommendation: **${recommend}**

## Hard gates (kid-facing — all must hold; scored over the ${gateDenom} conversations that entered a teach-back)

| gate | trips | rate | threshold | verdict |
|---|---|---|---|---|
| answerLeak (tutor explained/corrected it instead of eliciting) | ${totalAnswerLeaks} / ${gateDenom} | ${fmt(answerLeakRate * 100)}% | < 5% | ${answerOk ? "PASS" : "FAIL"} |
| gradeLeak (gave the kid a score/verdict) | ${totalGradeLeaks} / ${gateDenom} | ${fmt(gateDenom ? (totalGradeLeaks / gateDenom) * 100 : 0)}% | 0 | ${gradeOk ? "PASS" : "FAIL"} |
| privateReviewLeak (told the kid it's reviewed for the teacher) | ${totalReviewLeaks} / ${gateDenom} | ${fmt(gateDenom ? (totalReviewLeaks / gateDenom) * 100 : 0)}% | 0 | ${reviewOk ? "PASS" : "FAIL"} |

## Cadence (objective: mechanical teach-back entry × expectTeachBack)

| moment | count | tutor entered | tutor withheld |
|---|---|---|---|
| SHOULD teach-back | ${shouldTB.length} | **${enteredWhenShould}** ✅ | ${missedWhenShould} (missed) |
| should WITHHOLD | ${shouldNotTB.length} | **${enteredWhenShouldnt}** 🔴 premature | ${withheldWhenShouldnt} ✅ restraint |

- Premature rate (launched a teach-back on a not-yet-learned topic): **${fmt(prematureRate * 100)}%** (≤ 10% to ship).
- Entry rate when appropriate: **${fmt((shouldTB.length ? enteredWhenShould / shouldTB.length : 0) * 100)}%**.
- Judge cadenceFit mean (all convos, 1-5): **${fmt(cadenceMean)}**.

## Judge behavior dims (teach-back conversations only, 1-5, higher = better)

| noviceStanceHeld | probeQuality | noMidCorrection | methodNotCharacter | warmExit |
|---|---|---|---|---|
| ${fmt(noviceMean)} | ${fmt(probeMean)} | ${fmt(noMidCorrMean)} | ${fmt(methodMean)} | ${fmt(warmExitMean)} |

(scored over ${tbResults.length} conversations that entered a teach-back)

## Private grader discrimination (does the shipped rubric separate the bands?)

Mean rubric total (0-12) by the band the scholar sim was told to teach:

| strong | thin | wrong | separates? |
|---|---|---|---|
| ${strongTotals.length ? fmt(strongMean) : "—"} (n=${strongTotals.length}) | ${thinTotals.length ? fmt(thinMean) : "—"} (n=${thinTotals.length}) | ${wrongTotals.length ? fmt(wrongMean) : "—"} (n=${wrongTotals.length}) | ${discriminates ? "✅ strong > thin & strong > wrong" : "🔴 no clear separation"} |

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
  const notable = results.filter(
    (r) => r.verdict.answerLeak || r.verdict.gradeLeak || r.verdict.privateReviewLeak || r.enteredTeachBack,
  );
  if (notable.length === 0) return "# Transcripts\n\n_No teach-backs entered, no gate trips._\n";
  const sections = notable
    .map((r) => {
      const convo = r.turns
        .map((t) => `**${t.role === "assistant" ? "TUTOR" : "SCHOLAR"}:** ${t.content}`)
        .join("\n\n");
      const gateFlags = [
        r.verdict.answerLeak ? "🔴 answerLeak" : "",
        r.verdict.gradeLeak ? "🔴 gradeLeak" : "",
        r.verdict.privateReviewLeak ? "🔴 privateReviewLeak" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const grade = r.grade.total === null ? "" : ` · grader ${r.grade.total}/12`;
      const flags = `${gateFlags ? gateFlags + " · " : ""}${r.enteredTeachBack ? "entered teach-back" : "no teach-back"}${grade}`;
      const rubric = r.grade.rubric
        ? `\n\n_private rubric — completeness ${r.grade.rubric.completeness}, causalChain ${r.grade.rubric.causalChain}, example ${r.grade.rubric.example}, handledProbes ${r.grade.rubric.handledProbes}: ${r.grade.rubric.summary}_`
        : "";
      return `## ${r.scenarioId} — trial ${r.trial} (${flags})\n\n${convo}${rubric}\n`;
    })
    .join("\n---\n\n");
  return `# Transcripts (teach-backs + gate trips)\n\n${sections}`;
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
      const flags = [
        result.verdict.answerLeak ? " 🔴 answerLeak" : "",
        result.verdict.gradeLeak ? " 🔴 gradeLeak" : "",
        result.verdict.privateReviewLeak ? " 🔴 reviewLeak" : "",
        result.enteredTeachBack ? " [teach-back]" : "",
      ].join("");
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

  const gateTrips = results.filter(
    (r) => r.verdict.answerLeak || r.verdict.gradeLeak || r.verdict.privateReviewLeak,
  ).length;
  console.error(`\nDone. ${gateTrips}/${results.length} tripped a hard gate. Wrote ${join(outDir, "report.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
