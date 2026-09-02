/**
 * Observer eval harness — main runner.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/observer/run.ts [flags]
 *
 * Flags:
 *   --models sonnet,opus      models to run (default: sonnet,opus)
 *   --fixtures-only           skip dev transcripts, run hand-authored cases only
 *   --with-dev                include dev transcripts (default on if data file exists)
 *   --dev-limit N             cap dev cases (default 8)
 *   --no-pairwise             skip blind A/B comparison (saves judge calls)
 *   --concurrency N           parallel API calls (default 4)
 *   --out DIR                 output dir (default evals/observer/out)
 *
 * Writes report.md, runs.json, judgments.json to the out dir.
 */
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS, JUDGE_MODEL } from "../../convex/lib/models";
import { fmt, mean, parseEvalArgs, runPool, writeRunArtifacts } from "../lib/harness";
import { runObserver, type TranscriptCase, type ObserverRun } from "./lib/runObserver";
import {
  scoreRun,
  comparePair,
  DIMENSIONS,
  type Dimension,
  type Judgment,
  type PairVerdict,
} from "./lib/judge";
import type { ObserverResult } from "../../convex/lib/observerShared";

const HERE = dirname(fileURLToPath(import.meta.url));

const MODEL_MAP: Record<string, string> = {
  sonnet: MODELS.SONNET,
  opus: MODELS.OPUS,
  haiku: MODELS.HAIKU,
};

const args = parseEvalArgs({
  models: { default: "sonnet,opus", valueWhenMissing: "true" },
  devLimit: { flag: "dev-limit", default: 8, parse: (value) => parseInt(value, 10), valueWhenMissing: "true" },
  concurrency: { default: 4, parse: (value) => parseInt(value, 10), valueWhenMissing: "true" },
  out: { default: join(HERE, "out"), valueWhenMissing: "true" },
  noPairwise: { flag: "no-pairwise", default: false, boolean: true },
  fixturesOnly: { flag: "fixtures-only", default: false, boolean: true },
  only: { default: undefined as string | undefined, valueWhenMissing: "true" },
});

const modelKeys = args.models.split(",").map((s) => s.trim());
const models = modelKeys.map((k) => MODEL_MAP[k] ?? k);
const devLimit = args.devLimit;
const concurrency = args.concurrency;
const outDir = args.out;
const doPairwise = !args.noPairwise && models.length === 2;
const fixturesOnly = args.fixturesOnly;
const only = args.only; // case-id substring filter, e.g. --only seed-refresh

// ─── Load cases ──────────────────────────────────────────────────────
function loadFixtures(): TranscriptCase[] {
  const dir = join(HERE, "fixtures");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ ...JSON.parse(readFileSync(join(dir, f), "utf8")), source: "fixture" as const }));
}

function loadDev(): TranscriptCase[] {
  const file = join(HERE, "data", "dev-transcripts.json");
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as Array<{
    sessionId: string;
    title: string;
    scholarName: string | null;
    unitTitle: string | null;
    messageCount: number;
    transcript: Array<{ role: "user" | "assistant"; content: string }>;
  }>;
  return raw
    .filter((p) => p.messageCount >= 8 && !/perception test/i.test(p.title))
    .slice(0, devLimit)
    .map((p) => ({
      id: `dev-${p.sessionId.slice(0, 8)}`,
      title: p.title,
      scholarName: p.scholarName,
      unitTitle: p.unitTitle,
      transcript: p.transcript,
      source: "dev" as const,
    }));
}

interface CaseRecord {
  c: TranscriptCase;
  runs: Record<string, { run: ObserverRun; judgment: Judgment | null }>;
  pairwise?: { verdict: PairVerdict; modelA: string; modelB: string };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const cases = [...loadFixtures(), ...(fixturesOnly ? [] : loadDev())].filter(
    (c) => !only || c.id.includes(only),
  );
  console.error(
    `[eval] ${cases.length} cases (${cases.filter((c) => c.source === "fixture").length} fixtures, ${cases.filter((c) => c.source === "dev").length} dev) × ${models.length} models [${modelKeys.join(", ")}] | pairwise=${doPairwise}`
  );

  // 1. Run observer for every (case, model)
  const jobs = cases.flatMap((c) => models.map((m) => ({ c, m })));
  const runs = await runPool(jobs, async ({ c, m }) => {
    const r = await runObserver(c, m);
    console.error(`  [run] ${c.id} / ${m} → ${r.result ? `${r.result.observations?.length ?? 0} obs, ${r.latencyMs}ms` : `ERROR ${r.error}`}`);
    return r;
  }, { concurrency });

  // 2. Judge each run (absolute rubric)
  const judgeJobs = runs.map((run) => ({ run, c: cases.find((c) => c.id === run.caseId)! }));
  const judgments = await runPool(judgeJobs, async ({ run, c }) => {
    if (!run.result) return null;
    try {
      const j = await scoreRun(c, run.result);
      console.error(`  [judge] ${run.caseId} / ${run.model} → overall ${j.overall}/5, ${j.errors.length} errors`);
      return j;
    } catch (e) {
      console.error(`  [judge] ${run.caseId} / ${run.model} FAILED: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }, { concurrency });

  // Assemble per-case records
  const records: CaseRecord[] = cases.map((c) => {
    const rec: CaseRecord = { c, runs: {} };
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].caseId === c.id) {
        rec.runs[runs[i].model] = { run: runs[i], judgment: judgments[i] };
      }
    }
    return rec;
  });

  // 3. Blind pairwise (randomized A/B) when exactly two models
  if (doPairwise) {
    const [mX, mY] = models;
    await runPool(records, async (rec) => {
      const rx = rec.runs[mX]?.run.result;
      const ry = rec.runs[mY]?.run.result;
      if (!rx || !ry) return;
      // randomize which model is presented as A to avoid position bias
      const flip = Math.random() < 0.5;
      const modelA = flip ? mY : mX;
      const modelB = flip ? mX : mY;
      const a = flip ? ry : rx;
      const b = flip ? rx : ry;
      try {
        const verdict = await comparePair(rec.c, a as ObserverResult, b as ObserverResult);
        rec.pairwise = { verdict, modelA, modelB };
        console.error(`  [pair] ${rec.c.id} → winner ${verdict.winner} (A=${modelA.includes("opus") ? "opus" : "sonnet"})`);
      } catch (e) {
        console.error(`  [pair] ${rec.c.id} FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }, { concurrency });
  }

  // ─── Write raw artifacts ───────────────────────────────────────────
  const runArtifacts = records.map((r) => ({
    id: r.c.id, source: r.c.source, title: r.c.title,
    runs: Object.fromEntries(Object.entries(r.runs).map(([m, v]) => [m, { result: v.run.result, latencyMs: v.run.latencyMs, usage: v.run.usage, error: v.run.error }])),
  }));
  const judgmentArtifacts = records.map((r) => ({
    id: r.c.id,
    judgments: Object.fromEntries(Object.entries(r.runs).map(([m, v]) => [m, v.judgment])),
    pairwise: r.pairwise,
  }));
  writeRunArtifacts({ outDir, runs: runArtifacts, judgments: judgmentArtifacts, report: buildReport(records, models, modelKeys) });
  console.error(`\n[eval] Wrote report.md, runs.json, judgments.json to ${outDir}`);
}

function modelShort(m: string): string {
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return m;
}

function buildReport(records: CaseRecord[], models: string[], modelKeys: string[]): string {
  const L: string[] = [];
  const now = new Date().toISOString();
  L.push(`# Observer Eval Report`);
  L.push(`\n_Generated ${now}_`);
  L.push(`\nCases: ${records.length} (${records.filter((r) => r.c.source === "fixture").length} hand-authored fixtures with gold expectations, ${records.filter((r) => r.c.source === "dev").length} real dev transcripts). Models: ${modelKeys.join(", ")}. Judge: ${JUDGE_MODEL}.`);

  // ── Headline: per-model averages ──
  L.push(`\n## Per-model rubric averages (1–5, higher is better)\n`);
  L.push(`| Dimension | ${models.map(modelShort).join(" | ")} |`);
  L.push(`|---|${models.map(() => "---").join("|")}|`);
  for (const dim of DIMENSIONS) {
    const cells = models.map((m) => {
      const scores = records
        .map((r) => r.runs[m]?.judgment?.scores?.[dim as Dimension])
        .filter((s): s is { score: number; applicable: boolean; note: string } => !!s && s.applicable !== false)
        .map((s) => s.score);
      return scores.length ? `${fmt(mean(scores))} _(n=${scores.length})_` : "n/a";
    });
    L.push(`| ${dim} | ${cells.join(" | ")} |`);
  }
  const overallCells = models.map((m) => {
    const xs = records.map((r) => r.runs[m]?.judgment?.overall).filter((x): x is number => typeof x === "number");
    return `**${fmt(mean(xs))}**`;
  });
  L.push(`| **overall** | ${overallCells.join(" | ")} |`);

  // ── Operational stats ──
  L.push(`\n## Operational (cost / latency / output size)\n`);
  L.push(`| Metric | ${models.map(modelShort).join(" | ")} |`);
  L.push(`|---|${models.map(() => "---").join("|")}|`);
  const avgLatency = models.map((m) => fmt(mean(records.map((r) => r.runs[m]?.run.latencyMs ?? 0)), 0) + "ms");
  const avgOut = models.map((m) => fmt(mean(records.map((r) => r.runs[m]?.run.usage.output ?? 0)), 0) + " tok");
  const avgObs = models.map((m) => fmt(mean(records.map((r) => r.runs[m]?.run.result?.observations?.length ?? 0))));
  const avgSig = models.map((m) => fmt(mean(records.map((r) => r.runs[m]?.run.result?.sessionSignals?.length ?? 0))));
  L.push(`| avg latency | ${avgLatency.join(" | ")} |`);
  L.push(`| avg output tokens | ${avgOut.join(" | ")} |`);
  L.push(`| avg #observations | ${avgObs.join(" | ")} |`);
  L.push(`| avg #signals | ${avgSig.join(" | ")} |`);

  // ── Pairwise summary ──
  const withPair = records.filter((r) => r.pairwise);
  if (withPair.length) {
    L.push(`\n## Blind pairwise (Opus vs Sonnet)\n`);
    let opusWins = 0, sonnetWins = 0, ties = 0;
    const dimTally: Record<string, { opus: number; sonnet: number; tie: number }> = {};
    for (const d of DIMENSIONS) dimTally[d] = { opus: 0, sonnet: 0, tie: 0 };
    for (const r of withPair) {
      const { verdict, modelA, modelB } = r.pairwise!;
      const resolve = (pick: "A" | "B" | "tie") => (pick === "tie" ? "tie" : modelShort(pick === "A" ? modelA : modelB));
      const w = resolve(verdict.winner);
      if (w === "opus") opusWins++; else if (w === "sonnet") sonnetWins++; else ties++;
      for (const d of DIMENSIONS) {
        const dw = resolve(verdict.perDimension[d as Dimension]);
        if (dw === "opus") dimTally[d].opus++; else if (dw === "sonnet") dimTally[d].sonnet++; else dimTally[d].tie++;
      }
    }
    L.push(`Overall winner across ${withPair.length} cases: **opus ${opusWins} · sonnet ${sonnetWins} · tie ${ties}**\n`);
    L.push(`| Dimension | opus | sonnet | tie |`);
    L.push(`|---|---|---|---|`);
    for (const d of DIMENSIONS) L.push(`| ${d} | ${dimTally[d].opus} | ${dimTally[d].sonnet} | ${dimTally[d].tie} |`);
  }

  // ── Per-case detail ──
  L.push(`\n## Per-case detail\n`);
  for (const r of records) {
    L.push(`\n### ${r.c.source === "fixture" ? "🧪" : "📄"} ${r.c.id} — "${r.c.title}"`);
    if (r.c.expectations?.length) {
      L.push(`\n_Gold expectations:_`);
      for (const e of r.c.expectations) L.push(`- ${e}`);
    }
    for (const m of models) {
      const v = r.runs[m];
      if (!v) continue;
      const res = v.run.result;
      const j = v.judgment;
      L.push(`\n**${modelShort(m)}** — ${res ? `${res.observations?.length ?? 0} obs, ${res.sessionSignals?.length ?? 0} signals, ${res.seeds?.length ?? 0} seeds, pulse ${res.pulse?.pulseScore}/5` : `ERROR: ${v.run.error}`}${j ? ` · judge overall **${j.overall}/5**` : ""}`);
      if (res?.observations?.length) {
        for (const o of res.observations) {
          L.push(`  - \`${o.conceptLabel}\` _(${o.domain})_ — Bloom ${fmt(o.masteryLevel, 1)}, conf ${fmt(o.confidenceScore, 2)}, ${o.evidenceType}`);
        }
      }
      if (j) {
        L.push(`  - _judge:_ ${j.headline}`);
        if (j.errors.length) for (const err of j.errors) L.push(`    - ⚠️ ${err}`);
      }
    }
    if (r.pairwise) {
      const { verdict, modelA, modelB } = r.pairwise;
      const resolve = (pick: "A" | "B" | "tie") => (pick === "tie" ? "tie" : modelShort(pick === "A" ? modelA : modelB));
      L.push(`\n**Pairwise winner: ${resolve(verdict.winner)}** — ${verdict.reasoning}`);
    }
  }

  return L.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
