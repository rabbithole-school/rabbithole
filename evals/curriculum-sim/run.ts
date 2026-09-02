/**
 * Phase 1 runner — ANALYZE (simulate + judge, no edits).
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/curriculum-sim/run.ts \
 *     --activity evals/curriculum-sim/scripts/halving-shapes.json \
 *     --cast evals/curriculum-sim/scripts/cast.json --judge
 *
 * Simulates each synthetic scholar PLAYING THROUGH the activity against the real
 * production tutor, optionally judges each session (curriculum-fit + protected
 * tutor-quality dims), and writes a transcripts+scores report. No improver/loop
 * yet (Phases 2–3). Question it answers: how does this activity, as written,
 * fare across a diverse cast — and where do kids stall?
 *
 * Flags: --activity <p> --cast <p> [--judge] [--turns N] [--out dir] [--offline]
 */
import { readFileSync } from "node:fs";
import { runCastThroughActivity } from "./lib/orchestrator";
import { simTokens } from "./lib/scholarSimulator";
import { tutorTokens } from "./lib/runTutor";
import { judgeTokens } from "./lib/judge";
import { renderAnalyzeReport } from "./lib/report";
import type { ScholarProfile, SimActivity } from "./lib/types";
import { writeRunArtifacts } from "../lib/harness";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const activityPath = arg("activity");
  const castPath = arg("cast");
  if (!activityPath || !castPath) {
    console.error("Usage: --activity <path> --cast <path> [--judge] [--turns N] [--out dir] [--offline]");
    process.exit(1);
  }
  const offline = has("offline");
  const judge = has("judge");
  const maxTurns = Number(arg("turns", "10"));
  const outDir = arg("out", "evals/curriculum-sim/out")!;

  const activity: SimActivity = JSON.parse(readFileSync(activityPath, "utf8"));
  const cast: ScholarProfile[] = JSON.parse(readFileSync(castPath, "utf8"));

  if (!offline && !process.env.ANTHROPIC_API_KEY) {
    console.error("No ANTHROPIC_API_KEY set. Re-run with --offline for a stubbed demo, or export a key.");
    process.exit(1);
  }

  console.error(`Activity: "${activity.title}" — ${cast.length} scholars${judge ? " + judge" : ""}${offline ? " (OFFLINE)" : ""}`);
  const run = await runCastThroughActivity(activity, cast, {
    maxTurns,
    offline,
    judge,
    onProgress: (m) => console.error(m),
  });

  writeRunArtifacts({
    outDir,
    runs: { activity, ...run },
    report: renderAnalyzeReport(activity, run, offline),
    runsFile: "sessions.json",
  });
  console.error(`\nWrote ${outDir}/report.md and sessions.json`);
  if (!offline) {
    console.error(
      `Tokens — tutor ${tutorTokens.input}/${tutorTokens.output}, sim ${simTokens.input}/${simTokens.output}, judge ${judgeTokens.input}/${judgeTokens.output}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
