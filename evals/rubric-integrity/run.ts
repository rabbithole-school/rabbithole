/**
 * rubric-integrity eval — runner.
 *
 * Drives each fixture (a document-rubric activity + a SCRIPTED scholar
 * conversation) once through the real production tutor prompt with the
 * `update_rubric_score` tool bound, then scores whether an unanswered tutor
 * probe about a criterion silently became full-credit evidence once the
 * final artifact merely looked complete
 * (review/experiment-detective-tutor-audit.html, Moment F).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx evals/rubric-integrity/run.ts
 *   ANTHROPIC_API_KEY=... npx tsx evals/rubric-integrity/run.ts --case hollow-complete
 *   npx tsx evals/rubric-integrity/run.ts --offline   # wiring/demo only, no key, never fails CI
 *
 * Live runs exit non-zero if any fixture's verdict fails its expectation, so
 * this can gate a rubric-tool prompt change locally. `--offline` uses
 * deterministic stubs (see lib/runRubricTutor.ts) and only proves the
 * pipeline runs — it is NOT a behavior claim about the real tutor.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeRunArtifacts } from "../lib/harness";
import { runRubricSession } from "./lib/driver";
import { scoreProbeIntegrity, type ProbeIntegrityScore } from "./lib/probeIntegrityScore";
import { tutorTokens } from "./lib/runRubricTutor";
import type { RubricCase } from "./lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const OUT_DIR = join(HERE, "out");

function parseArgs(argv: string[]) {
  const args = { offline: false, case: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offline") args.offline = true;
    else if (a === "--case") args.case = argv[++i] ?? null;
  }
  return args;
}

function loadCases(only: string | null): RubricCase[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const cases: RubricCase[] = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    if (only && id !== only) continue;
    const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8"));
    cases.push({ id, ...raw });
  }
  return cases;
}

function transcript(turns: { role: string; content: string }[]): string {
  return turns
    .map((t) => `[${t.role === "tutor" ? "TUTOR" : "SCHOLAR"}] ${t.content}`)
    .join("\n\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.offline && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "No ANTHROPIC_API_KEY set. Run with --offline for a wiring check, or export a key for a real eval.",
    );
    process.exit(2);
  }

  const cases = loadCases(args.case);
  if (cases.length === 0) {
    console.error(`No fixtures matched${args.case ? ` --case ${args.case}` : ""}.`);
    process.exit(2);
  }

  const rows: {
    id: string;
    expectation: string;
    probedCriterionId: string;
    score: ProbeIntegrityScore;
    observation: unknown;
    transcript: string;
  }[] = [];

  for (const testCase of cases) {
    process.stderr.write(`▶ ${testCase.id} (${testCase.expectation})… `);
    const result = await runRubricSession(testCase, { offline: args.offline });
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: result.toolCalledOnFinalTurn,
        probedCriterionLevel: result.probedCriterionLevel,
        allCriteriaFull: result.allCriteriaFull,
        finalTextIsSubstantive: result.finalTextIsSubstantive,
        finalTurnText: result.finalTurnText,
      },
      testCase.expectation,
    );
    process.stderr.write(`${score.pass ? "PASS" : "FAIL"} (${score.verdict})\n`);
    rows.push({
      id: testCase.id,
      expectation: testCase.expectation,
      probedCriterionId: testCase.probedCriterionId,
      score,
      observation: {
        toolCalledOnFinalTurn: result.toolCalledOnFinalTurn,
        probedCriterionLevel: result.probedCriterionLevel,
        allCriteriaFull: result.allCriteriaFull,
        finalTextIsSubstantive: result.finalTextIsSubstantive,
        finalTurnText: result.finalTurnText,
      },
      transcript: transcript(result.turns),
    });
  }

  // ── Report ──────────────────────────────────────────────────────────
  const passed = rows.filter((r) => r.score.pass).length;
  const lines: string[] = [
    `# rubric-integrity eval${args.offline ? " (OFFLINE — wiring only)" : ""}`,
    "",
    `${passed}/${rows.length} fixtures passed. Tutor tokens: ${tutorTokens.input} in / ${tutorTokens.output} out.`,
    "",
    "| Fixture | Expectation | Probed criterion | Verdict | Pass | Reason |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.expectation} | ${r.probedCriterionId} | ${r.score.verdict} | ${r.score.pass ? "✅" : "❌"} | ${r.score.reason} |`,
    ),
    "",
    "## Transcripts",
    "",
    ...rows.flatMap((r) => [`### ${r.id}`, "", "```", r.transcript, "```", ""]),
  ];
  const report = lines.join("\n");

  writeRunArtifacts({
    outDir: OUT_DIR,
    runs: rows.map((r) => ({
      id: r.id,
      expectation: r.expectation,
      probedCriterionId: r.probedCriterionId,
      ...r.score,
      observation: r.observation,
    })),
    report,
    artifactOrder: ["report", "runs"],
  });

  console.log(`\n${passed}/${rows.length} passed. Report: evals/rubric-integrity/out/report.md`);
  for (const r of rows) {
    console.log(`  ${r.score.pass ? "✅" : "❌"} ${r.id}: ${r.score.verdict} — ${r.score.reason}`);
  }

  // Live runs gate; offline never fails (stubs don't reflect real behavior).
  if (!args.offline && passed < rows.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
