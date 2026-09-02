/**
 * activity-completion eval — runner.
 *
 * Drives each fixture (a conversation-only activity + a synthetic scholar) once
 * through the real production tutor prompt with the `mark_activity_complete`
 * tool bound, then scores the TIMING of completion: on-time / too-soon /
 * too-late / withheld. This is the regression guard the PR review asked for —
 * "ensure prompt changes don't cause sessions to get marked as done too soon or
 * too late."
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx evals/activity-completion/run.ts
 *   ANTHROPIC_API_KEY=... npx tsx evals/activity-completion/run.ts --case engaged-reaches-goal
 *   npx tsx evals/activity-completion/run.ts --offline   # wiring/demo only, no key, never fails CI
 *
 * Live runs exit non-zero if any fixture's timing verdict fails its
 * expectation, so this can gate a prompt change locally. `--offline` uses
 * deterministic stubs (see lib/runTutor.ts) and only proves the pipeline runs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeRunArtifacts } from "../lib/harness";
import { runCompletionSession } from "./lib/driver";
import { scoreCompletion, type CompletionScore } from "./lib/completionScore";
import { tutorTokens } from "./lib/runTutor";
import type { CompletionCase } from "./lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const OUT_DIR = join(HERE, "out");

function parseArgs(argv: string[]) {
  const args = { offline: false, case: null as string | null, maxTurns: 10, grace: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offline") args.offline = true;
    else if (a === "--case") args.case = argv[++i] ?? null;
    else if (a === "--max-turns") args.maxTurns = Number(argv[++i]);
    else if (a === "--grace") args.grace = Number(argv[++i]);
  }
  return args;
}

function loadCases(only: string | null): CompletionCase[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const cases: CompletionCase[] = [];
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
    score: CompletionScore;
    observation: unknown;
    transcript: string;
  }[] = [];

  for (const testCase of cases) {
    process.stderr.write(`▶ ${testCase.id} (${testCase.expectation})… `);
    const result = await runCompletionSession(testCase, {
      maxTurns: args.maxTurns,
      graceTurns: args.grace,
      offline: args.offline,
    });
    const score = scoreCompletion(result.observation, testCase.expectation);
    process.stderr.write(`${score.pass ? "PASS" : "FAIL"} (${score.verdict})\n`);
    rows.push({
      id: testCase.id,
      expectation: testCase.expectation,
      score,
      observation: result.observation,
      transcript: transcript(result.turns),
    });
  }

  // ── Report ──────────────────────────────────────────────────────────
  const passed = rows.filter((r) => r.score.pass).length;
  const lines: string[] = [
    `# activity-completion eval${args.offline ? " (OFFLINE — wiring only)" : ""}`,
    "",
    `${passed}/${rows.length} fixtures passed. Tutor tokens: ${tutorTokens.input} in / ${tutorTokens.output} out.`,
    "",
    "| Fixture | Expectation | Verdict | Pass | Reason |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.expectation} | ${r.score.verdict} | ${r.score.pass ? "✅" : "❌"} | ${r.score.reason} |`,
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
      ...r.score,
      observation: r.observation,
    })),
    report,
    artifactOrder: ["report", "runs"],
  });

  console.log(`\n${passed}/${rows.length} passed. Report: evals/activity-completion/out/report.md`);
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
