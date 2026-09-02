/**
 * Cross-family verification runner (adoptable #4 — Finding 2).
 *
 *   OPENAI_API_KEY=... npx tsx evals/cross-family-verify/run.ts \
 *     --transcripts evals/curriculum-sim/out/sessions.json
 *
 *   # keyless structure demo (no API call):
 *   npx tsx evals/cross-family-verify/run.ts \
 *     --transcripts evals/cross-family-verify/fixtures/sample-run.json --dry-run
 *
 * Re-judges a WINNING curriculum-sim variant's already-judged transcripts with a
 * GPT-family model and prints how much the second model family AGREES with the
 * Anthropic curriculum judge, per dimension. Run this before a teacher sees
 * "promote" — it's the cheap, decision-boundary answer to Finding 2 (judge and
 * improver are both Opus).
 *
 * INPUT SHAPE (--transcripts): a curriculum-sim run output JSON, i.e. what
 * `evals/curriculum-sim/run.ts` writes to out/sessions.json:
 *   {
 *     "activity":  SimActivity,
 *     "sessions":  SessionResult[],   // profile + turns + stopReason per kid
 *     "verdicts":  SessionVerdict[],  // the ANTHROPIC judge's scores, parallel to sessions
 *     "aggregate": Aggregate | null,  // optional; ignored (recomputed here)
 *     "judgeModel": string            // optional; the Anthropic judge id for the label
 *   }
 * `verdicts` must be present and the same length as `sessions` (run curriculum-sim
 * with --judge). Anything else is ignored.
 *
 * Flags: --transcripts <file> (alias --run) [--dry-run] [--model <id>] [--out <dir>]
 */
import { readFileSync } from "node:fs";
import {
  judgeSessionOpenAI,
  stubSecondFamilyVerdict,
  openaiTokens,
  CROSS_FAMILY_JUDGE_MODEL,
} from "./lib/openaiJudge";
import { compareJudges } from "./lib/compare";
import { renderAgreementReport } from "./lib/report";
import { JUDGE_MODEL } from "../../convex/lib/models";
import type { SessionVerdict } from "../curriculum-sim/lib/score";
import type { SessionResult, SimActivity } from "../curriculum-sim/lib/types";
import { writeRunArtifacts } from "../lib/harness";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

interface RunFile {
  activity: SimActivity;
  sessions: SessionResult[];
  verdicts: SessionVerdict[];
  judgeModel?: string;
}

function loadRunFile(path: string): RunFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RunFile>;
  if (!raw.activity || typeof raw.activity.title !== "string") {
    throw new Error(`${path}: missing "activity" (expected a curriculum-sim run output JSON)`);
  }
  if (!Array.isArray(raw.sessions) || raw.sessions.length === 0) {
    throw new Error(`${path}: missing/empty "sessions" array`);
  }
  if (!Array.isArray(raw.verdicts) || raw.verdicts.length === 0) {
    throw new Error(
      `${path}: missing/empty "verdicts" (the Anthropic judge scores). Re-run curriculum-sim with --judge.`,
    );
  }
  if (raw.sessions.length !== raw.verdicts.length) {
    throw new Error(
      `${path}: sessions (${raw.sessions.length}) and verdicts (${raw.verdicts.length}) must be parallel/equal length.`,
    );
  }
  return {
    activity: raw.activity,
    sessions: raw.sessions,
    verdicts: raw.verdicts,
    judgeModel: raw.judgeModel,
  };
}

async function main() {
  const transcriptsPath = arg("transcripts") ?? arg("run");
  if (!transcriptsPath) {
    console.error(
      "Usage: --transcripts <curriculum-sim sessions.json> [--dry-run] [--model <id>] [--out <dir>]",
    );
    process.exit(1);
  }
  const dryRun = has("dry-run");
  const model = arg("model", CROSS_FAMILY_JUDGE_MODEL)!;
  const outDir = arg("out");

  const { activity, sessions, verdicts, judgeModel } = loadRunFile(transcriptsPath);
  const anthropicJudge = judgeModel || process.env.JUDGE_MODEL || JUDGE_MODEL;
  const openaiJudge = dryRun ? "(dry-run stub — no model call)" : model;

  if (!dryRun && !process.env.OPENAI_API_KEY) {
    console.error(
      "No OPENAI_API_KEY set. Re-run with --dry-run for a keyless structure demo, or export a key.",
    );
    process.exit(1);
  }

  console.error(
    `Cross-family verify: "${activity.title}" — re-judging ${sessions.length} session(s) with ${dryRun ? "a DRY-RUN stub" : `\`${model}\``} vs Anthropic \`${anthropicJudge}\`…`,
  );

  const openaiVerdicts: SessionVerdict[] = [];
  for (let i = 0; i < sessions.length; i++) {
    if (dryRun) {
      openaiVerdicts.push(stubSecondFamilyVerdict(verdicts[i]));
    } else {
      console.error(`  ▶ ${sessions[i].profile.name} (${sessions[i].profile.readingLevel})…`);
      openaiVerdicts.push(await judgeSessionOpenAI(activity, sessions[i], model));
    }
  }

  const report = compareJudges({
    activityTitle: activity.title,
    anthropicVerdicts: verdicts,
    openaiVerdicts,
    anthropicJudge,
    openaiJudge,
    dryRun,
  });

  const md = renderAgreementReport(report);
  console.log(md);

  if (outDir) {
    writeRunArtifacts({
      outDir,
      runs: report,
      report: md,
      runsFile: "agreement.json",
      reportFile: "agreement.md",
    });
    console.error(`\nWrote ${outDir}/agreement.md and agreement.json`);
  }
  if (!dryRun) {
    console.error(`\nOpenAI judge tokens — in ${openaiTokens.input} / out ${openaiTokens.output}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
