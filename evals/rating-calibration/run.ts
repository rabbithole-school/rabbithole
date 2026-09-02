/**
 * Rating-calibration eval — main runner.
 *
 * Measures how well the AI rating-suggester (a mirror of
 * convex/courseNarrativeAI.ts → suggestRatings, see lib/suggestRatings.ts)
 * agrees with a teacher's hand-assigned "gold" 1–7 PCM rating, on synthetic
 * evidence-binder fixtures (fixtures.ts) spanning the whole rubric range.
 * This is the calibration dataset review/assessment-and-goals-plan.html §11
 * describes: the teacher's committed PCM ratings vs. the AI's suggested
 * ratings.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/rating-calibration/run.ts [flags]
 *   ./evals/rating-calibration/run.sh [flags]
 *
 * Flags:
 *   --model opus|sonnet|haiku|<raw id>   suggester model (default: opus — MODELS.OPUS, matches prod)
 *   --runs N                             samples per fixture (default 1; LLMs vary — bump for stabler numbers)
 *   --concurrency N                      parallel API calls (default 4)
 *   --out DIR                            output dir (default evals/rating-calibration/out)
 *
 * Writes report.md + runs.json to the out dir. If ANTHROPIC_API_KEY isn't
 * set, prints a clear message and exits 0 — this harness makes real model
 * calls, it does not mock them.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS } from "../../convex/lib/models";
import { PCM_DIMENSIONS } from "../../convex/lib/pcm";
import { fmt as formatNumber, parseEvalArgs, runPool, writeRunArtifacts } from "../lib/harness";
import { BINDERS } from "./fixtures";
import { scoreFixture, summarize, type DimensionAgreement } from "./lib/judge";
import { suggestRatingsForFixture, type BinderFixture, type SuggestRun } from "./lib/suggestRatings";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_MAP: Record<string, string> = { sonnet: MODELS.SONNET, opus: MODELS.OPUS, haiku: MODELS.HAIKU };

const args = parseEvalArgs({
  model: { default: "opus" },
  runs: { default: 1, parse: (value) => parseInt(value, 10) },
  concurrency: { default: 4, parse: (value) => parseInt(value, 10) },
  out: { default: join(HERE, "out") },
});

const modelArg = args.model;
const model = MODEL_MAP[modelArg] ?? modelArg;
const runsPerFixture = args.runs;
const concurrency = args.concurrency;
const outDir = args.out;

interface FixtureRecord {
  fixture: BinderFixture;
  runs: Array<{ suggestion: SuggestRun; agreement: DimensionAgreement[] }>;
}

function fmt(n: number, d = 2): string {
  return formatNumber(n, d, "n/a");
}
function pct(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "n/a";
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  console.error(
    `[eval] rating-calibration model=${model} fixtures=${BINDERS.length} runsPerFixture=${runsPerFixture}`,
  );

  const jobs: Array<{ fixture: BinderFixture; run: number }> = [];
  for (const fixture of BINDERS) {
    for (let r = 0; r < runsPerFixture; r++) jobs.push({ fixture, run: r });
  }

  const raw = await runPool(jobs, async ({ fixture, run }) => {
    const suggestion = await suggestRatingsForFixture(fixture, model);
    const agreement = scoreFixture(fixture.goldRatings, suggestion.ratings);
    const summaryStr = suggestion.error
      ? `ERROR ${suggestion.error}`
      : agreement.map((a) => `${a.dimension}=${a.ai ?? "omitted"}(gold ${a.gold})`).join(" ");
    console.error(`  [${fixture.id} run ${run}] ${summaryStr}`);
    return { fixture, suggestion, agreement };
  }, { concurrency });

  const records = new Map<string, FixtureRecord>();
  for (const { fixture, suggestion, agreement } of raw) {
    const rec = records.get(fixture.id) ?? { fixture, runs: [] };
    rec.runs.push({ suggestion, agreement });
    records.set(fixture.id, rec);
  }
  const recordList = [...records.values()];

  writeRunArtifacts({
    outDir,
    runs: recordList,
    report: buildReport(recordList),
  });
  console.error(`\n[eval] Wrote report.md, runs.json to ${outDir}`);
}

function buildReport(records: FixtureRecord[]): string {
  const L: string[] = [];
  L.push(`# Rating-Calibration Eval Report`);
  L.push(`\n_Generated ${new Date().toISOString()}_`);
  L.push(
    `\nSuggester model: \`${model}\`. Fixtures: ${records.length} synthetic evidence binders × ${runsPerFixture} run(s) each. Compares the AI's suggested 1–7 PCM rating against a hand-assigned TEACHER gold rating, scored with convex/lib/pcm.ts's RUBRIC_BANDS (see lib/judge.ts).`,
  );

  const allAgreements: DimensionAgreement[] = records.flatMap((r) => r.runs.flatMap((run) => run.agreement));
  const overall = summarize(allAgreements);

  L.push(`\n## Headline agreement (across all fixtures × runs × dimensions)\n`);
  L.push(`| Metric | Value |`);
  L.push(`|---|---|`);
  L.push(`| Mean absolute error (1–7 scale) | ${fmt(overall.mae)} |`);
  L.push(`| Within-1-band hit rate | ${pct(overall.withinOneBandRate)} |`);
  L.push(`| Exact-band match rate | ${pct(overall.exactBandRate)} |`);
  L.push(`| Ratings scored / omitted by the AI | ${overall.n} / ${overall.omitted} |`);

  L.push(`\n## Per-dimension agreement\n`);
  L.push(`| Dimension | MAE | Within-1-band | Exact band |`);
  L.push(`|---|---|---|---|`);
  for (const dim of PCM_DIMENSIONS) {
    const dimRows = allAgreements.filter((a) => a.dimension === dim);
    const s = summarize(dimRows);
    L.push(`| ${dim} | ${fmt(s.mae)} | ${pct(s.withinOneBandRate)} | ${pct(s.exactBandRate)} |`);
  }

  L.push(`\n## Per-fixture detail\n`);
  for (const rec of records) {
    L.push(`\n### ${rec.fixture.id} — ${rec.fixture.scholarName} (${rec.fixture.subject})`);
    L.push(`\nTeacher gold: ${PCM_DIMENSIONS.map((d) => `${d}=${rec.fixture.goldRatings[d]}`).join(", ")}`);
    for (const [i, run] of rec.runs.entries()) {
      if (run.suggestion.error) {
        L.push(`\n**run ${i}**: ERROR ${run.suggestion.error}`);
        continue;
      }
      L.push(`\n**run ${i}**`);
      L.push(`\n| Dimension | Gold | AI | \\|Δ\\| | Gold band | AI band | Within 1 band |`);
      L.push(`|---|---|---|---|---|---|---|`);
      for (const a of run.agreement) {
        L.push(
          `| ${a.dimension} | ${a.gold} | ${a.ai ?? "omitted"} | ${a.absError !== null ? fmt(a.absError, 1) : "—"} | ${a.goldBand ?? "—"} | ${a.aiBand ?? "—"} | ${a.withinOneBand === null ? "—" : a.withinOneBand ? "✓" : "✗"} |`,
        );
      }
      if (run.suggestion.rationale) L.push(`\n_AI rationale:_ ${run.suggestion.rationale}`);
    }
  }

  return L.join("\n") + "\n";
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "[eval] No ANTHROPIC_API_KEY set — skipping rating-calibration eval (this harness makes real Anthropic calls; nothing to run without a key).",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
