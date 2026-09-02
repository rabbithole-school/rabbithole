/**
 * Seed→unit bake eval — baked vs ad-lib, head to head.
 *
 * The ship gate for the seed→unit bake (review/seed-to-unit-bake-plan.md). For a
 * set of exploration topics, it runs the SAME synthetic scholars toward the SAME
 * learning goal under two tutors:
 *   - ad-lib  : the current topic-seed launch (tutor riffs, no structure)
 *   - baked   : the real bake's first online activity drives the tutor
 * then judges both with the curriculum-sim rubric (curriculum-fit + gifted +
 * protected dims) and decides with `isBetter`. The bake's wall-clock latency is
 * reported alongside so the "worth it net of latency" call is explicit.
 *
 * Usage (from repo root):
 *   ./evals/seed-bake/run.sh                      # live: real bake + live judge
 *   ./evals/seed-bake/run.sh --offline            # stubbed wiring smoke test
 *   ./evals/seed-bake/run.sh --scholars 2 --max-turns 8
 *
 * Live mode needs ANTHROPIC_API_KEY (judge/tutor/sim) and a provisioned dev
 * deployment (the bake runs server-side via `npx convex run`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mean, parseEvalArgs, writeRunArtifacts } from "../lib/harness";
import { runAdLibArm, runBakedArm, adLibActivity, bakedSimActivity, armTutorTokens, type Topic } from "./lib/arms";
import { bakeTopic } from "./lib/bake";
import { judgeSession, judgeTokens } from "../curriculum-sim/lib/judge";
import { simTokens } from "../curriculum-sim/lib/scholarSimulator";
import type { ScholarProfile } from "../curriculum-sim/lib/types";
import type { SessionVerdict } from "../curriculum-sim/lib/score";
import { decide, renderReport } from "./lib/report";
import { renderHtml, type PairRecord } from "./lib/html";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main() {
  const {
    offline,
    scholars: scholarsN,
    maxTurns,
    topics: topicsPath,
    cast: castPath,
  } = parseEvalArgs({
    offline: { default: false, boolean: true },
    scholars: { default: 2, parse: Number, allowOptionLikeValue: true },
    maxTurns: { flag: "max-turns", default: 16, parse: Number, allowOptionLikeValue: true },
    topics: { default: join(HERE, "scripts", "topics.json"), allowOptionLikeValue: true },
    cast: { default: join(HERE, "..", "curriculum-sim", "scripts", "cast.json"), allowOptionLikeValue: true },
  });
  const outDir = join(HERE, "out");

  if (!offline && !process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required for a live run (or pass --offline).");
    process.exit(1);
  }

  const topics: Topic[] = JSON.parse(readFileSync(topicsPath, "utf8"));
  const cast: ScholarProfile[] = JSON.parse(readFileSync(castPath, "utf8"));
  const profiles = cast.slice(0, Math.max(1, scholarsN));

  console.log(
    `seed-bake eval — ${topics.length} topic(s) × ${profiles.length} scholar(s) = ${topics.length * profiles.length} session(s)/arm${offline ? " (OFFLINE)" : ""}`,
  );

  const adLibVerdicts: SessionVerdict[] = [];
  const bakedVerdicts: SessionVerdict[] = [];
  const perTopicMs: number[] = [];
  const records: PairRecord[] = [];

  for (const topic of topics) {
    process.stdout.write(`\n[${topic.id}] baking… `);
    const baked = await bakeTopic(topic, offline);
    perTopicMs.push(baked.ms);
    process.stdout.write(`done (${(baked.ms / 1000).toFixed(0)}s) — "${baked.activity.title}"\n`);

    for (const profile of profiles) {
      process.stdout.write(`  ${profile.name}: ad-lib… `);
      const adlibSession = await runAdLibArm(profile, topic, { maxTurns, offline });
      const adlibVerdict = await judgeSession(adLibActivity(topic), adlibSession, offline);
      adLibVerdicts.push(adlibVerdict);
      process.stdout.write(`baked… `);
      const bakedSession = await runBakedArm(profile, topic, baked.activity, { maxTurns, offline });
      const bakedVerdict = await judgeSession(bakedSimActivity(topic, baked.activity), bakedSession, offline);
      bakedVerdicts.push(bakedVerdict);
      records.push({
        topic,
        baked: baked.activity,
        bakeMs: baked.ms,
        profileName: profile.name,
        adLib: { session: adlibSession, verdict: adlibVerdict },
        bakedRun: { session: bakedSession, verdict: bakedVerdict },
      });
      process.stdout.write(`✓\n`);
    }
  }

  const decision = decide(adLibVerdicts, bakedVerdicts);
  const adLibCapRate = records.length
    ? records.filter((r) => r.adLib.session.stopReason === "maxTurns").length / records.length
    : 0;
  const bakedCapRate = records.length
    ? records.filter((r) => r.bakedRun.session.stopReason === "maxTurns").length / records.length
    : 0;
  const report = renderReport(
    decision,
    { perTopicMs },
    {
      topics: topics.length,
      scholarsPerTopic: profiles.length,
      offline,
      adLibCapRate,
      bakedCapRate,
    },
  );
  const meanBakeMs = mean(perTopicMs);

  // Persist the raw results + report FIRST, so a downstream rendering hiccup can
  // never throw away an expensive run. The HTML viewer is best-effort on top.
  writeRunArtifacts({
    outDir,
    runs: { adLibVerdicts, bakedVerdicts, perTopicMs, records },
    report,
    runsFile: "verdicts.json",
    artifactOrder: ["report", "runs"],
  });
  try {
    const html = renderHtml(records, decision, {
      topics: topics.length,
      scholarsPerTopic: profiles.length,
      offline,
      meanBakeMs,
    });
    writeFileSync(join(outDir, "compare.html"), html);
  } catch (e) {
    console.error("compare.html render failed (results still saved):", e);
  }

  console.log("\n" + report);
  console.log(
    `\ntokens — tutor ${armTutorTokens.input}/${armTutorTokens.output} · sim ${simTokens.input}/${simTokens.output} · judge ${judgeTokens.input}/${judgeTokens.output}`,
  );
  console.log(`report → ${join(outDir, "report.md")}`);
  console.log(`side-by-side → ${join(outDir, "compare.html")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
