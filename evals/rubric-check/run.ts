/**
 * rubric-check eval — runner.
 *
 * Measures `checkRubric` (convex/deliverables.ts) — the "Submit & check"
 * batch grader a scholar hits when they click Check my work. It sees the
 * rubric and the raw document and NO transcript, which makes it the
 * least-context grading surface in the product and the one most likely to
 * misread a young scholar's writing. Nothing evaluated it before this.
 *
 * Each fixture is graded `--reps` times (judged output on a 3-point scale is
 * noisy; one sample is an anecdote). Fixtures marked `compareTutorPath` are
 * ALSO graded the same number of times through the tutor's
 * `update_rubric_score` path, on the identical document, so the two graders
 * can be compared rather than described.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... ./evals/rubric-check/run.sh
 *   ANTHROPIC_API_KEY=... ./evals/rubric-check/run.sh --reps 8 --case invented-spelling
 *   ./evals/rubric-check/run.sh --offline    # wiring only, no key, never gates
 *
 * A live run exits non-zero when a fixture's pass rate falls below
 * --min-pass-rate (default 0.5, i.e. a majority of reps must meet the
 * expectation) so this can gate a rubric-prompt change locally. `--offline`
 * uses deterministic stubs and is NOT a behavior claim.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, markdownTable, runPool, writeRunArtifacts } from "../lib/harness";
import { assembleCheckPrompts, checkTokens, checkModel, runCheckRubric } from "./lib/runCheckRubric";
import { runTutorArm, type TutorArmObservation } from "./lib/runTutorArm";
import {
  LEVEL_SCORE,
  levelHistogram,
  scoreCheckRun,
  spread,
  type RubricCheckScore,
} from "./lib/scoreRubricCheck";
import type { CheckRubricCase, CheckRubricObservation, Level } from "./lib/types";

/** "tool_use×4 max_tokens×1" — same shape as levelHistogram, any string key. */
function levelCounts(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}×${n}`).join(" ");
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const OUT_DIR = join(HERE, "out");

function parseArgs(argv: string[]) {
  const args = {
    offline: false,
    case: null as string | null,
    reps: 5,
    concurrency: 4,
    minPassRate: 0.5,
    tutor: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offline") args.offline = true;
    else if (a === "--no-tutor") args.tutor = false;
    else if (a === "--case") args.case = argv[++i] ?? null;
    else if (a === "--reps") args.reps = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--min-pass-rate") args.minPassRate = Number(argv[++i]);
  }
  return args;
}

function loadCases(only: string | null): CheckRubricCase[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      id: f.replace(/\.json$/, ""),
      ...(JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8")) as Omit<
        CheckRubricCase,
        "id"
      >),
    }))
    .filter((c) => !only || c.id === only)
    .sort((a, b) => a.id.localeCompare(b.id));
}

type CaseResult = {
  testCase: CheckRubricCase;
  checks: { observation: CheckRubricObservation; score: RubricCheckScore }[];
  tutors: TutorArmObservation[];
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.offline && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "No ANTHROPIC_API_KEY set. Run with --offline for a wiring check, or export a key for a real eval.",
    );
    process.exit(2);
  }
  // Validate every numeric flag, not just --reps. A flag passed without a
  // value yields Number(undefined) = NaN, and NaN silently disables gating
  // (every comparison against it is false) while NaN concurrency makes
  // Array.from({length: NaN}) throw deep inside runPool. Fail fast instead.
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    console.error("--concurrency must be a positive integer.");
    process.exit(2);
  }
  if (
    !Number.isFinite(args.minPassRate) ||
    args.minPassRate < 0 ||
    args.minPassRate > 1
  ) {
    console.error("--min-pass-rate must be a number between 0 and 1.");
    process.exit(2);
  }
  if (!Number.isFinite(args.reps) || args.reps < 1) {
    console.error("--reps must be a positive integer.");
    process.exit(2);
  }

  const cases = loadCases(args.case);
  if (cases.length === 0) {
    console.error(`No fixtures matched${args.case ? ` --case ${args.case}` : ""}.`);
    process.exit(2);
  }

  // Flatten every (fixture × rep × arm) into one job list so the pool keeps
  // all lanes busy instead of finishing one fixture at a time.
  type Job =
    | { kind: "check"; caseIndex: number; rep: number }
    | { kind: "tutor"; caseIndex: number; rep: number };
  const jobs: Job[] = [];
  cases.forEach((c, caseIndex) => {
    for (let rep = 0; rep < args.reps; rep++) {
      jobs.push({ kind: "check", caseIndex, rep });
      if (args.tutor && c.compareTutorPath) {
        jobs.push({ kind: "tutor", caseIndex, rep });
      }
    }
  });

  const results: CaseResult[] = cases.map((testCase) => ({
    testCase,
    checks: [],
    tutors: [],
  }));

  let done = 0;
  await runPool(
    jobs,
    async (job) => {
      const testCase = cases[job.caseIndex];
      if (job.kind === "check") {
        const observation = await runCheckRubric(testCase, { offline: args.offline });
        results[job.caseIndex].checks.push({
          observation,
          score: scoreCheckRun(testCase, observation),
        });
      } else {
        results[job.caseIndex].tutors.push(
          await runTutorArm(testCase, { offline: args.offline }),
        );
      }
      done += 1;
      process.stderr.write(`\r  ${done}/${jobs.length} gradings…`);
    },
    { concurrency: args.concurrency },
  );
  process.stderr.write("\n");

  // ── Aggregate ───────────────────────────────────────────────────────
  const summary = results.map((r) => {
    const focusLevels = r.checks.map((c) => c.score.focusLevel);
    const focusScores = r.checks
      .map((c) => c.score.focusScore)
      .filter((s): s is number => s !== null);
    const passes = r.checks.filter((c) => c.score.pass).length;
    const focusPasses = r.checks.filter((c) => c.score.focusPass).length;
    const tutorLevels = r.tutors.map(
      (t) => (t.levels[r.testCase.focusCriterionId] ?? null) as Level | null,
    );
    const tutorScores = tutorLevels
      .filter((l): l is Level => l !== null)
      .map((l) => LEVEL_SCORE[l]);
    return {
      id: r.testCase.id,
      readingLevel: r.testCase.readingLevel,
      focusCriterionId: r.testCase.focusCriterionId,
      expected: r.testCase.focusAllowed.join("/"),
      passRate: r.checks.length ? passes / r.checks.length : 0,
      focusPassRate: r.checks.length ? focusPasses / r.checks.length : 0,
      passes,
      focusPasses,
      reps: r.checks.length,
      focusHistogram: levelHistogram(focusLevels),
      focus: spread(focusScores),
      overallHistogram: levelHistogram(
        r.checks.map((c) => c.observation.reportedOverall),
      ),
      // Only counts reps that RETURNED an overall — an omitted one is the
      // separate defect below, and folding it in here would inflate the
      // fork count with rows that have no fork to measure.
      inconsistentOverall: r.checks.filter(
        (c) => !c.score.missingOverall && !c.score.overallConsistent,
      ).length,
      missingOverall: r.checks.filter((c) => c.score.missingOverall).length,
      stopReasons: levelCounts(r.checks.map((c) => c.observation.stopReason ?? "(null)")),
      tutorHistogram: r.tutors.length ? levelHistogram(tutorLevels) : "—",
      tutor: spread(tutorScores),
      tutorNotCalled: r.tutors.filter((t) => !t.called).length,
    };
  });

  // The GATE is the content judgement: did the grader read the writing the
  // way the fixture says it must be read. A malformed `overall` is reported
  // separately (and loudly) rather than folded in here, so a schema defect
  // cannot be mistaken for a misreading.
  const failing = summary.filter((s) => s.focusPassRate < args.minPassRate);
  const totalMissingOverall = summary.reduce((a, s) => a + s.missingOverall, 0);

  // ── Report ──────────────────────────────────────────────────────────
  const title = `# rubric-check eval${args.offline ? " (OFFLINE — wiring only)" : ""}`;
  const lines: string[] = [
    title,
    "",
    `Grader under test: \`checkRubric\` (convex/deliverables.ts) via the real \`buildRubricSystemPrompt\` + \`buildRubricCheckUserMessage\` + \`RUBRIC_TOOL\`. Model: \`${checkModel}\`.`,
    "",
    `${cases.length} fixtures × ${args.reps} reps = ${summary.reduce((a, s) => a + s.reps, 0)} checkRubric gradings; ` +
      `${results.reduce((a, r) => a + r.tutors.length, 0)} tutor-path gradings. ` +
      `checkRubric tokens: ${checkTokens.input} in / ${checkTokens.output} out.`,
    "",
    `Gate: the FOCUS-CRITERION pass rate only. A fixture fails when it lands outside its allowed level set in more than ${fmt((1 - args.minPassRate) * 100, 0)}% of reps (default: a majority of reps must meet it — a 3-point judged scale is too noisy for a point prediction). A malformed \`overall\` is reported separately below so a schema defect cannot be mistaken for a misreading.`,
    "",
    "## Per-fixture",
    "",
    markdownTable(
      [
        "Fixture",
        "reading level",
        "focus criterion",
        "expected",
        "observed levels",
        "mean",
        "min–max",
        "sd",
        "focus pass (gate)",
        "full-row pass",
      ],
      summary.map((s) => [
        s.id,
        s.readingLevel ?? "(unset)",
        s.focusCriterionId,
        s.expected,
        s.focusHistogram,
        fmt(s.focus.mean, 2, "—"),
        `${fmt(s.focus.min, 2, "—")}–${fmt(s.focus.max, 2, "—")}`,
        fmt(s.focus.stdev, 2, "—"),
        `${s.focusPasses}/${s.reps}${s.focusPassRate < args.minPassRate ? " ❌" : " ✅"}`,
        `${s.passes}/${s.reps}`,
      ]),
    ),
    "",
    "## checkRubric vs. the tutor path — same document, same rubric",
    "",
    "The tutor arm reuses `evals/rubric-integrity/lib/runRubricTutor.ts`, whose prompt hardcodes `readingLevel: null`.",
    "Read the tutor column against the **no-reading-level** fixtures for an apples-to-apples comparison.",
    "",
    markdownTable(
      ["Fixture", "checkRubric (mean, n)", "tutor path (mean, n)", "Δ check − tutor", "check levels", "tutor levels"],
      summary
        .filter((s) => s.tutor.n > 0)
        .map((s) => [
          s.id,
          `${fmt(s.focus.mean, 2, "—")} (n=${s.focus.n})`,
          `${fmt(s.tutor.mean, 2, "—")} (n=${s.tutor.n})`,
          fmt(s.focus.mean - s.tutor.mean, 2, "—"),
          s.focusHistogram,
          s.tutorHistogram,
        ]),
    ),
    "",
    "## The `overall` field — two separate defects",
    "",
    `**1. Omitted entirely: ${totalMissingOverall}/${summary.reduce((a, s) => a + s.reps, 0)} gradings.** \`overall\` is marked required in \`RUBRIC_TOOL\`, but the model sometimes returns a tool call without it. \`checkRubric\` passes it straight to \`applyCheckResult\`, whose validator requires a not/half/full literal — and that call sits OUTSIDE the action's try/catch, so production throws and the scholar's "Check my work" fails with no verdict stored. Check the \`stop_reason\` column: \`max_tokens\` would mean a truncated tool call (a max_tokens=2048 problem), \`tool_use\`/\`end_turn\` means the model genuinely chose to omit the field.`,
    "",
    "**2. A definitional fork with the tutor path.** `checkRubric` stores the model's own `overall`; the tutor path recomputes it with `scoreRubricVerdicts` (any `not` → `not`). checkRubric's own system prompt defines `half` more loosely (\"at least one criterion is half **or not**\"), so both are internally correct — but the SAME `deliverables.overall` field means different things depending on which grader wrote it. `passed` (`overall === \"full\"`) agrees either way, so this changes what a scholar is told, not whether they passed.",
    "",
    markdownTable(
      ["Fixture", "reported overall", "omitted", "forked (of those returned)", "stop_reason"],
      summary.map((s) => [
        s.id,
        s.overallHistogram,
        `${s.missingOverall}/${s.reps}`,
        `${s.inconsistentOverall}/${s.reps - s.missingOverall}`,
        s.stopReasons,
      ]),
    ),
    "",
    "## Fixtures in detail",
    "",
    ...results.flatMap((r) => {
      const s = summary.find((x) => x.id === r.testCase.id)!;
      return [
        `### ${r.testCase.id}`,
        "",
        r.testCase.note ? `> ${r.testCase.note}` : "",
        "",
        "Submission (verbatim, unattributed fixture text):",
        "",
        "```",
        r.testCase.submission,
        "```",
        "",
        `Focus criterion \`${r.testCase.focusCriterionId}\` — observed ${s.focusHistogram}; met expectation ${s.focusPasses}/${s.reps}. \`overall\` omitted in ${s.missingOverall}/${s.reps}.`,
        "",
        "Grader notes on the focus criterion, one per rep:",
        "",
        ...r.checks.map(
          (c, i) =>
            `${i + 1}. **${c.score.focusLevel ?? "(none)"}** — ${c.observation.notes[r.testCase.focusCriterionId] ?? "(no note)"}`,
        ),
        "",
        ...(r.tutors.length
          ? [
              "Tutor-path verdicts on the same criterion, one per rep:",
              "",
              ...r.tutors.map(
                (t, i) =>
                  `${i + 1}. **${t.levels[r.testCase.focusCriterionId] ?? "(none)"}**${t.called ? "" : " (tool not called)"}`,
              ),
              "",
            ]
          : []),
        "Prompt actually sent to the grader (first rep):",
        "",
        "```",
        assembleCheckPrompts(r.testCase).user,
        "```",
        "",
        "Scholar-facing feedback (first rep):",
        "",
        "```",
        r.checks[0]?.observation.feedback ?? "(none)",
        "```",
        "",
      ];
    }),
  ];

  writeRunArtifacts({
    outDir: OUT_DIR,
    runs: results.map((r) => ({
      id: r.testCase.id,
      readingLevel: r.testCase.readingLevel,
      focusCriterionId: r.testCase.focusCriterionId,
      focusAllowed: r.testCase.focusAllowed,
      overallAllowed: r.testCase.overallAllowed,
      checks: r.checks,
      tutors: r.tutors,
    })),
    judgments: summary,
    report: lines.join("\n"),
    artifactOrder: ["runs", "judgments", "report"],
  });

  console.log(
    `\n${summary.length - failing.length}/${summary.length} fixtures met their focus-criterion expectation. Report: evals/rubric-check/out/report.md`,
  );
  if (totalMissingOverall > 0) {
    console.log(
      `  ⚠️  ${totalMissingOverall} grading(s) returned NO \`overall\` — production would throw writing those.`,
    );
  }
  for (const s of summary) {
    console.log(
      `  ${s.focusPassRate < args.minPassRate ? "❌" : "✅"} ${s.id}: ${s.focusCriterionId} ${s.focusHistogram} ` +
        `(mean ${fmt(s.focus.mean, 2, "—")}, n=${s.focus.n})` +
        (s.tutor.n > 0 ? ` | tutor ${s.tutorHistogram} (mean ${fmt(s.tutor.mean, 2, "—")})` : ""),
    );
  }

  if (!args.offline && failing.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
