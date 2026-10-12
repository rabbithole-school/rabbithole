/**
 * rubric-integrity eval — runner.
 *
 * Drives each fixture (a document-rubric activity + a SCRIPTED scholar
 * conversation) through the real production tutor prompt with the
 * `update_rubric_score` tool bound, then applies that fixture's scorer.
 *
 * Three probes share this harness because they share the surface under test —
 * the live `update_rubric_score` guidance — and the first two pull in opposite
 * directions:
 *
 *  - `probe-integrity` (default): did an UNANSWERED tutor probe about a
 *    criterion silently become full credit once the artifact merely looked
 *    complete? (review/experiment-detective-tutor-audit.html, Moment F.)
 *  - `spelling-credit`: the work IS present but written in invented
 *    (phonetic) spelling — did the grader decode it and credit it, and did
 *    the reply avoid telling the scholar it was missing? (Guards
 *    convex/sessionHelpers.ts — buildArtifactSection + RUBRIC_TOOL_GUIDANCE.)
 *  - `goalpost`: conduct rather than credit — across a conversation the
 *    fixture stipulates, does the check-my-work reply re-ask for something the
 *    scholar already did, fail what an earlier tutor turn accepted without
 *    owning the reversal, or reopen something the tutor said to leave alone?
 *    (Guards the conduct floor in RUBRIC_TOOL_GUIDANCE + the tail of
 *    `rubricCheckInstruction` in convex/sessionStreamHelpers.ts.)
 *
 * Running them together is the point: "credit the meaning" and "don't credit
 * an artifact that merely looks complete" are the two rules that can trade
 * off against each other, so a regression in either shows up in one run.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx evals/rubric-integrity/run.ts
 *   ANTHROPIC_API_KEY=... npx tsx evals/rubric-integrity/run.ts --case hollow-complete
 *   ANTHROPIC_API_KEY=... npx tsx evals/rubric-integrity/run.ts --n 5
 *   npx tsx evals/rubric-integrity/run.ts --offline   # wiring/demo only, no key, never fails CI
 *
 * `--n` repeats every fixture N times (default 1) because a single sample of
 * a stochastic model is not a result; the report carries each fixture's pass
 * rate and the spread of verdicts behind it. Live runs exit non-zero when a
 * GATING fixture's pass rate falls below half — at the default n=1 that is
 * exactly the old all-must-pass gate. A fixture with `gates: false` still runs
 * and still reports but cannot fail the build; see the README for why
 * `emergent-spelling` is one. `--offline` uses deterministic stubs (see
 * lib/runRubricTutor.ts) and only proves the pipeline runs — it is NOT a
 * behavior claim about the real tutor.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mean, runPool, writeRunArtifacts } from "../lib/harness";
import { runRubricSession } from "./lib/driver";
import { scoreProbeIntegrity } from "./lib/probeIntegrityScore";
import { scoreSpellingCredit, type SpellingCreditScore } from "./lib/spellingCreditScore";
import { judgeSpellingReply, type SpellingReplyVerdict } from "./lib/spellingCreditJudge";
import {
  scoreGoalpost,
  DEFAULT_GOALPOST_CHECKS,
  type GoalpostScore,
} from "./lib/goalpostScore";
import { judgeGoalpost, type GoalpostVerdict } from "./lib/goalpostJudge";
import type { GoalpostCheck } from "./lib/types";
import { tutorTokens } from "./lib/runRubricTutor";
import type { RecordedRubricCall } from "./lib/rubricCallRecord";
import type { RubricCase } from "./lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const OUT_DIR = join(HERE, "out");

/** Sessions in flight at once. Each is a handful of sequential model calls. */
const CONCURRENCY = 4;

function parseArgs(argv: string[]) {
  const args = { offline: false, case: null as string | null, n: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offline") args.offline = true;
    else if (a === "--case") args.case = argv[++i] ?? null;
    else if (a === "--n") args.n = Math.max(1, Number(argv[++i] ?? 1) || 1);
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
    .map((t) => {
      if (t.role === "tutor") return `[TUTOR] ${t.content}`;
      // A "Check my work" click is a user-role turn with no scholar words —
      // label it so a transcript reader doesn't mistake it for something the
      // scholar typed.
      const label = t.content.startsWith("[SYSTEM —") ? "CHECK-CLICK" : "SCHOLAR";
      return `[${label}] ${t.content}`;
    })
    .join("\n\n");
}

type Row = {
  id: string;
  rep: number;
  scorer: "probe-integrity" | "spelling-credit" | "goalpost";
  expectation: string;
  probedCriterionId: string;
  verdict: string;
  pass: boolean;
  reason: string;
  /** spelling-credit only: the two halves, reported separately. */
  creditedFull?: boolean;
  replyAvoidsMissingClaim?: boolean | null;
  judge?: SpellingReplyVerdict | null;
  /** goalpost only: the four booleans + their quoted evidence. */
  goalpostJudge?: GoalpostVerdict | null;
  /** goalpost only: the checks this fixture gated on, and which fired. */
  goalpostChecks?: GoalpostCheck[];
  goalpostFailedChecks?: GoalpostCheck[];
  observation: unknown;
  // The signals the peak rule deliberately does NOT decide on, kept beside
  // the observation so a walk-back is auditable from the artifact alone.
  recordedOnFinalTurn: boolean;
  probedCriterionFinalLevel: "not" | "half" | "full" | null;
  probedCriterionDowngraded: boolean;
  probedCriterionDowngradedWithinTurn: boolean;
  // The raw per-round ledger, so a run can be re-scored under a different
  // reduction rule without spending tokens again.
  rubricCalls: RecordedRubricCall[];
  transcript: string;
};

/**
 * The expectation the two CREDIT scorers need. `conduct-only` belongs to the
 * goalpost scorer and means "this fixture makes no claim about the verdict" —
 * handing it to a credit scorer would be a fixture-authoring error, so say so
 * loudly rather than coercing it to a default.
 */
function creditExpectation(
  testCase: RubricCase,
): "should-not-silently-full" | "should-be-full" {
  if (testCase.expectation === "conduct-only") {
    throw new Error(
      `${testCase.id}: expectation 'conduct-only' is only for the goalpost scorer; a credit scorer needs a real expectation.`,
    );
  }
  return testCase.expectation;
}

async function runOnce(
  testCase: RubricCase,
  rep: number,
  offline: boolean,
): Promise<Row> {
  const scorer = testCase.scorer ?? "probe-integrity";
  const result = await runRubricSession(testCase, { offline });
  const observation = {
    verdictRecorded: result.verdictRecorded,
    probedCriterionLevel: result.probedCriterionLevel,
    allCriteriaFull: result.allCriteriaFull,
    finalTextIsSubstantive: result.finalTextIsSubstantive,
    finalTurnText: result.finalTurnText,
  };

  const base = {
    id: testCase.id,
    rep,
    scorer,
    expectation: testCase.expectation,
    probedCriterionId: testCase.probedCriterionId,
    observation,
    recordedOnFinalTurn: result.recordedOnFinalTurn,
    probedCriterionFinalLevel: result.probedCriterionFinalLevel,
    probedCriterionDowngraded: result.probedCriterionDowngraded,
    probedCriterionDowngradedWithinTurn: result.probedCriterionDowngradedWithinTurn,
    rubricCalls: result.rubricCalls,
    transcript: transcript(result.turns),
  };

  if (scorer === "spelling-credit") {
    // The judged half. Offline stubs never make model calls, so the judge is
    // skipped there and the score fails closed (see scoreSpellingCredit).
    let judge: SpellingReplyVerdict | null = null;
    if (!offline && result.finalTurnText.trim().length > 0) {
      judge = await judgeSpellingReply(testCase, result.finalTurnText);
    }
    const score: SpellingCreditScore = scoreSpellingCredit(
      { ...observation, saysWorkIsMissing: judge ? judge.saysWorkIsMissing : null },
      creditExpectation(testCase),
    );
    return {
      ...base,
      verdict: score.verdict,
      pass: score.pass,
      reason: score.reason,
      creditedFull: score.creditedFull,
      replyAvoidsMissingClaim: score.replyAvoidsMissingClaim,
      judge,
    };
  }

  if (scorer === "goalpost") {
    // Conduct, not credit: the rubric-tool ledger is still recorded in `base`
    // (so a goalpost run is auditable the same way), but the verdict comes
    // entirely from the judged relation between the final reply and the
    // conversation the fixture stipulated.
    const checks = testCase.goalpostChecks ?? DEFAULT_GOALPOST_CHECKS;
    let goalpostJudge: GoalpostVerdict | null = null;
    if (!offline && result.finalTurnText.trim().length > 0) {
      goalpostJudge = await judgeGoalpost(
        testCase,
        result.turns,
        result.finalDocumentContent,
        result.finalTurnText,
      );
    }
    const score: GoalpostScore = scoreGoalpost(
      {
        finalTurnText: result.finalTurnText,
        judged: goalpostJudge
          ? {
              reasksDoneThing: goalpostJudge.reasksDoneThing,
              raisesBarWithoutOwning: goalpostJudge.raisesBarWithoutOwning,
              reopensSettled: goalpostJudge.reopensSettled,
              declaresSufficientWithoutBar:
                goalpostJudge.declaresSufficientWithoutBar,
            }
          : null,
      },
      checks,
    );
    return {
      ...base,
      verdict: score.verdict,
      pass: score.pass,
      reason: score.reason,
      goalpostJudge,
      goalpostChecks: score.checks,
      goalpostFailedChecks: score.failedChecks,
    };
  }

  const score = scoreProbeIntegrity(observation, creditExpectation(testCase));
  return { ...base, verdict: score.verdict, pass: score.pass, reason: score.reason };
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

  const jobs = cases.flatMap((testCase) =>
    Array.from({ length: args.n }, (_, rep) => ({ testCase, rep })),
  );
  let done = 0;
  const rows = await runPool(
    jobs,
    async ({ testCase, rep }) => {
      const row = await runOnce(testCase, rep, args.offline);
      done++;
      process.stderr.write(
        `▶ [${done}/${jobs.length}] ${row.id} #${rep + 1} — ${row.pass ? "PASS" : "FAIL"} (${row.verdict})\n`,
      );
      return row;
    },
    { concurrency: args.offline ? 1 : CONCURRENCY },
  );

  // ── Aggregate per fixture ───────────────────────────────────────────
  const summaries = cases.map((testCase) => {
    const mine = rows.filter((r) => r.id === testCase.id);
    const passes = mine.filter((r) => r.pass).length;
    const verdictCounts = new Map<string, number>();
    for (const r of mine) verdictCounts.set(r.verdict, (verdictCounts.get(r.verdict) ?? 0) + 1);
    const judgedHalf = mine.filter((r) => r.scorer === "spelling-credit");
    return {
      id: testCase.id,
      scorer: testCase.scorer ?? "probe-integrity",
      gates: testCase.gates !== false,
      expectation: testCase.expectation,
      probedCriterionId: testCase.probedCriterionId,
      n: mine.length,
      passes,
      passRate: mean(mine.map((r) => (r.pass ? 1 : 0))),
      verdicts: Object.fromEntries(verdictCounts),
      creditedFullRate: judgedHalf.length
        ? mean(judgedHalf.map((r) => (r.creditedFull ? 1 : 0)))
        : null,
      replyAvoidsMissingRate: judgedHalf.length
        ? mean(judgedHalf.map((r) => (r.replyAvoidsMissingClaim === true ? 1 : 0)))
        : null,
      // goalpost only: how often each gated check FIRED (lower is better),
      // so a fixture that fails can be read without opening the transcripts.
      goalpostCheckFireRates:
        (testCase.scorer ?? "probe-integrity") === "goalpost"
          ? Object.fromEntries(
              (testCase.goalpostChecks ?? DEFAULT_GOALPOST_CHECKS).map((c) => [
                c,
                mean(mine.map((r) => (r.goalpostFailedChecks?.includes(c) ? 1 : 0))),
              ]),
            )
          : null,
    };
  });

  const totalPasses = rows.filter((r) => r.pass).length;
  const lines: string[] = [
    `# rubric-integrity eval${args.offline ? " (OFFLINE — wiring only)" : ""}`,
    "",
    `${totalPasses}/${rows.length} runs passed across ${cases.length} fixtures × n=${args.n}. Tutor tokens: ${tutorTokens.input} in / ${tutorTokens.output} out.`,
    "",
    "| Fixture | Scorer | Gates? | Probed criterion | n | Passes | Pass rate | Verdicts |",
    "|---|---|---|---|---|---|---|---|",
    ...summaries.map(
      (s) =>
        `| ${s.id} | ${s.scorer} | ${s.gates ? "yes" : "no"} | ${s.probedCriterionId} | ${s.n} | ${s.passes} | ${(s.passRate * 100).toFixed(0)}% | ${Object.entries(s.verdicts)
          .map(([v, c]) => `${v}×${c}`)
          .join(", ")} |`,
    ),
    "",
    "### spelling-credit halves (mechanical verdict vs. what the scholar is told)",
    "",
    "| Fixture | criterion scored `full` | reply avoided \"it's missing\" |",
    "|---|---|---|",
    ...summaries
      .filter((s) => s.creditedFullRate !== null)
      .map(
        (s) =>
          `| ${s.id} | ${((s.creditedFullRate ?? 0) * 100).toFixed(0)}% | ${((s.replyAvoidsMissingRate ?? 0) * 100).toFixed(0)}% |`,
      ),
    "",
    "### goalpost checks (how often each gated check FIRED — lower is better)",
    "",
    "| Fixture | Check | Fire rate |",
    "|---|---|---|",
    ...summaries
      .filter((s) => s.goalpostCheckFireRates !== null)
      .flatMap((s) =>
        Object.entries(s.goalpostCheckFireRates ?? {}).map(
          ([check, rate]) => `| ${s.id} | ${check} | ${(rate * 100).toFixed(0)}% |`,
        ),
      ),
    "",
    "## Runs",
    "",
    ...rows.flatMap((r) => [
      `### ${r.id} #${r.rep + 1} — ${r.pass ? "✅" : "❌"} ${r.verdict}`,
      "",
      r.reason,
      "",
      r.judge ? `Judge: saysWorkIsMissing=${r.judge.saysWorkIsMissing} — ${r.judge.notes} (${JSON.stringify(r.judge.quotedEvidence)})\n` : "",
      r.goalpostJudge
        ? [
            `Judge (gated on ${(r.goalpostChecks ?? []).join(", ")}): ${r.goalpostJudge.notes}`,
            "",
            `- reasksDoneThing=${r.goalpostJudge.reasksDoneThing} ${JSON.stringify(r.goalpostJudge.reasksDoneThingEvidence)}`,
            `- raisesBarWithoutOwning=${r.goalpostJudge.raisesBarWithoutOwning} ${JSON.stringify(r.goalpostJudge.raisesBarWithoutOwningEvidence)}`,
            `- reopensSettled=${r.goalpostJudge.reopensSettled} ${JSON.stringify(r.goalpostJudge.reopensSettledEvidence)}`,
            `- declaresSufficientWithoutBar=${r.goalpostJudge.declaresSufficientWithoutBar} ${JSON.stringify(r.goalpostJudge.declaresSufficientWithoutBarEvidence)}`,
            "",
          ].join("\n")
        : "",
      "```",
      r.transcript,
      "```",
      "",
    ]),
  ];
  const report = lines.join("\n");

  writeRunArtifacts({
    outDir: OUT_DIR,
    runs: { summaries, rows },
    report,
    artifactOrder: ["report", "runs"],
  });

  console.log(
    `\n${totalPasses}/${rows.length} runs passed. Report: evals/rubric-integrity/out/report.md`,
  );
  for (const s of summaries) {
    const ok = s.passRate >= 0.5;
    console.log(
      `  ${ok ? "✅" : s.gates ? "❌" : "⚠️ (non-gating)"} ${s.id} [${s.scorer}]: ${s.passes}/${s.n} (${(s.passRate * 100).toFixed(0)}%) — ${Object.entries(s.verdicts)
        .map(([v, c]) => `${v}×${c}`)
        .join(", ")}`,
    );
  }

  // Live runs gate on a majority pass rate per GATING fixture; at n=1 that is
  // exactly the old all-must-pass behavior. A fixture with `gates: false`
  // documents a measured, currently-unfixed defect and still reports — it just
  // cannot fail the build (an always-red gate is not a gate). Offline never
  // fails (stubs don't reflect real behavior).
  if (!args.offline && summaries.some((s) => s.gates && s.passRate < 0.5)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
