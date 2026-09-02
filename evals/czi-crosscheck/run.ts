/**
 * CZI cross-check runner — the LIVE pass (calls the judge; NOT run in CI).
 *
 *   ./evals/czi-crosscheck/run.sh                     # all fixtures
 *   ./evals/czi-crosscheck/run.sh --case fixture:answer-dump
 *   ./evals/czi-crosscheck/run.sh --transcripts /path/to/redacted-transcripts.json
 *
 * Runs two vendored Learning Commons lenses over each tutor turn, on OUR own
 * models via the tutor-quality judge seam (JUDGE_ENGINE / JUDGE_MODEL),
 * telemetry-free:
 *   • coaching answer-dump detector  (manageable + acknowledges-strength)
 *   • grade-level calibration gauge   (band vs the scholar's reading level)
 *
 * Writes out/{report.md, runs.json}. This is an ad-hoc cross-check, deliberately
 * separate from our own Opus judge (external provenance) — see ./README.md.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeEngineName, judgeProvenance } from "../tutor-quality/lib/judgeEngine";
import {
  COACHING_DIMS,
  computeGradeDrift,
  pairTurns,
  runCoachingDim,
  runGradeLevel,
} from "./lib/cziLens";
import type { CziCaseResult, TurnEvaluation, TutorCase } from "./lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  cases: string[];
  transcripts: string | null;
  fixturesOnly: boolean;
  out: string;
  gradeLevel: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cases: [],
    transcripts: null,
    fixturesOnly: false,
    out: join(HERE, "out"),
    gradeLevel: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--case") args.cases.push(argv[++i]);
    else if (a === "--transcripts") args.transcripts = argv[++i];
    else if (a === "--fixtures-only") args.fixturesOnly = true;
    else if (a === "--no-grade-level") args.gradeLevel = false;
    else if (a === "--out") args.out = argv[++i];
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
  }
  return args;
}

function loadFixture(id: string): TutorCase {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", `${id}.json`), "utf8"));
  return { ...raw, id, source: "fixture" };
}

function loadAllFixtures(): TutorCase[] {
  const dir = join(HERE, "fixtures");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadFixture(f.replace(/\.json$/, "")));
}

/** Load an array of TutorCase-shaped objects from a saved (redacted) JSON file. */
function loadTranscripts(path: string): TutorCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((c, i) => ({
    id: c.id ?? `transcript-${i + 1}`,
    description: c.description ?? "",
    scholar: c.scholar ?? { name: null, readingLevel: null },
    anchor: c.anchor ?? null,
    turns: c.turns ?? [],
    source: "prod" as const,
  }));
}

async function evaluateCase(caseData: TutorCase, withGradeLevel: boolean): Promise<CziCaseResult> {
  const pairs = pairTurns(caseData);
  const turns: TurnEvaluation[] = [];
  for (const pair of pairs) {
    const coaching = [];
    for (const dim of COACHING_DIMS) {
      coaching.push(await runCoachingDim(dim, pair.studentText, pair.feedbackText));
    }
    let gradeLevel = null;
    let drift = null;
    if (withGradeLevel) {
      gradeLevel = await runGradeLevel(pair.feedbackText);
      drift = computeGradeDrift(gradeLevel.grade, caseData.scholar.readingLevel);
    }
    turns.push({
      turnIndex: pair.turnIndex,
      studentText: pair.studentText,
      feedbackText: pair.feedbackText,
      coaching,
      gradeLevel,
      drift,
    });
  }
  return {
    caseId: caseData.id,
    description: caseData.description,
    scholarReadingLevel: caseData.scholar.readingLevel,
    judge: judgeProvenance(),
    turns,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function truncate(s: string, n = 220): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function renderTurn(t: TurnEvaluation): string {
  const dumps = t.coaching.filter((c) => c.dim === "manageable" && c.concern);
  const noStrength = t.coaching.filter((c) => c.dim === "acknowledges-strength" && c.concern);
  const flags: string[] = [];
  if (dumps.length) flags.push("🚨 answer-dump (manageable=0)");
  if (noStrength.length) flags.push("⚠️ no strength acknowledged");
  if (t.drift?.pitchedAboveReadingLevel) {
    flags.push(`📈 pitched above reading level (band ${t.drift.band} vs level ${t.drift.readingGrade})`);
  }
  const scoreLine = t.coaching
    .map((c) => `${c.dim}=${c.score}`)
    .concat(t.gradeLevel ? [`grade=${t.gradeLevel.grade}`] : [])
    .join(", ");
  return `### Turn ${t.turnIndex}
- **Scores:** ${scoreLine}
- **Flags:** ${flags.length ? flags.join("; ") : "none"}
- **Student:** ${truncate(t.studentText) || "(none)"}
- **Tutor:** ${truncate(t.feedbackText)}`;
}

function renderCase(r: CziCaseResult): string {
  return `## ${r.caseId}
${r.description ? `_${r.description}_\n` : ""}Scholar reading level: ${r.scholarReadingLevel ?? "(unknown)"}

${r.turns.map(renderTurn).join("\n\n")}`;
}

function renderReport(results: CziCaseResult[]): string {
  let dumpTurns = 0;
  let pitchedTurns = 0;
  let totalTurns = 0;
  for (const r of results) {
    for (const t of r.turns) {
      totalTurns++;
      if (t.coaching.some((c) => c.dim === "manageable" && c.concern)) dumpTurns++;
      if (t.drift?.pitchedAboveReadingLevel) pitchedTurns++;
    }
  }
  const header = `# CZI cross-check report

External second opinion from vendored Learning Commons rubrics (CC BY 4.0), run
on our own models — telemetry-free. NOT a replacement for the Opus tutor-quality
judge; a cross-provenance sanity check. See \`evals/czi-crosscheck/README.md\`.

Judge: \`${judgeProvenance()}\` (engine: ${judgeEngineName()})
Cases: ${results.length} · tutor turns scored: ${totalTurns}
Answer-dump turns (manageable=0): ${dumpTurns}/${totalTurns}
Pitched-above-reading-level turns: ${pitchedTurns}/${totalTurns}
`;
  return [header, ...results.map(renderCase)].join("\n\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  const cases: TutorCase[] = [];
  if (args.transcripts) cases.push(...loadTranscripts(args.transcripts));
  for (const c of args.cases) {
    if (c.startsWith("fixture:")) cases.push(loadFixture(c.slice(8)));
    else throw new Error(`Unknown case spec: ${c}. Use fixture:<id> or --transcripts.`);
  }
  if (cases.length === 0) cases.push(...loadAllFixtures());
  if (cases.length === 0) {
    console.error("No cases to score.");
    process.exit(1);
  }

  console.error(`CZI cross-check: ${cases.length} case(s), judge ${judgeProvenance()}…`);
  const results: CziCaseResult[] = [];
  for (const c of cases) {
    console.error(`  - ${c.id} (${c.turns.length} turns)…`);
    results.push(await evaluateCase(c, args.gradeLevel));
  }

  writeFileSync(join(args.out, "runs.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(args.out, "report.md"), renderReport(results));
  console.error(`Done. Wrote ${join(args.out, "report.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
