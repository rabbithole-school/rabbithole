/**
 * Mastery-rigor gate — a focused eval for the observer's mastery CALIBRATION.
 *
 * Motivation (2026-06-24): a spot-check of the three most active prod scholars
 * found systematic over-scoring — mean mastery 3.85/5, 69% of observations at
 * Analyze+ (4-5), long creative/build sessions averaging 4.4-4.7 with runs of
 * straight 5.0s, and 35-78 observations per session (vs the prompt's "2-5").
 * Concepts the TUTOR introduced were credited to the scholar at the top of
 * Bloom; near-duplicate labels piled up un-deduped. See FINDINGS-rigor.md.
 *
 * This gate runs the PRODUCTION observer on the "modest-expectation" fixtures
 * (sessions where a rigorous observer should stay LOW and FEW) and checks the
 * anti-inflation behaviours, each against a numeric ceiling the fixture declares
 * in `rigorGold`:
 *
 *   - granularity:   observation count stays at/under the cap (consolidated)
 *   - calibration:   almost nothing on these sessions is Analyze+ (>=4.0)
 *   - tutor-credit:  per-fixture, no observation exceeds its mastery ceiling
 *   - misconception: a planted wrong belief is surfaced as its own signal
 *   - dedup:         no two observations with near-duplicate concept labels
 *
 * Run it after editing the observer prompt/schema:
 *
 *   evals/observer/rigor-check.sh            # sonnet (the live observer model)
 *   MODEL=opus RUNS=3 evals/observer/rigor-check.sh
 *
 * Exits non-zero if the live observer's mastery calibration regresses.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS } from "../../convex/lib/models";
import { conceptLabelsNearDuplicate as nearDup } from "../../convex/lib/conceptLabels";
import { runObserver, type TranscriptCase } from "./lib/runObserver";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_MAP: Record<string, string> = { sonnet: MODELS.SONNET, opus: MODELS.OPUS, haiku: MODELS.HAIKU };
const model = MODEL_MAP[process.env.MODEL ?? "sonnet"] ?? MODELS.SONNET;
const runs = parseInt(process.env.RUNS ?? "3", 10); // LLMs sample — average a few

const ANALYZE_PLUS = 4.0; // Bloom Analyze; on these modest sessions, ~nothing should reach it

type RigorGold = { maxObservations: number; maxMastery: number; requireMisconception: boolean; consolidate?: boolean };
type GatingCase = TranscriptCase & { rigorGold: RigorGold };

// The modest-expectation fixtures: scaffolded, fact-collection, directed-build,
// or a pre-existing duplicate pile where a rigorous observer stays LOW and FEW
// and CONSOLIDATES instead of piling on.
const FIXTURE_IDS = ["04-heavy-scaffolding", "02-fact-not-mastery", "09-directed-build-inflation", "10-consolidation-pile"];

function load(id: string): GatingCase {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", `${id}.json`), "utf8"));
  return { ...raw, source: "fixture" as const };
}

function pct(n: number, d: number) {
  return d ? `${Math.round((100 * n) / d)}%` : "n/a";
}

// near-duplicate concept labels — the SAME matcher the live write-path dedup net
// uses (convex/lib/conceptLabels), so the gate and the enforcement agree.
function dupPairs(labels: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (nearDup(labels[i], labels[j])) pairs.push([labels[i], labels[j]]);
    }
  }
  return pairs;
}

async function main() {
  console.error(`[rigor-gate] model=${model} runs=${runs}`);

  const cases = FIXTURE_IDS.map(load);
  const notes: string[] = [];

  // Aggregates across all (fixture × run).
  let totalObs = 0;
  let analyzePlus = 0; // observations at >=4.0 on these modest sessions
  let ceilingBreaches = 0; // observations above their fixture's maxMastery
  let dupPairCount = 0;
  let pileOns = 0; // new obs that near-dup an EXISTING current obs without superseding it
  let consolidateRuns = 0;
  const obsCountByFixture: Record<string, number[]> = {};
  const miscHitByFixture: Record<string, { hit: number; total: number }> = {};

  for (const c of cases) {
    obsCountByFixture[c.id] = [];
    miscHitByFixture[c.id] = { hit: 0, total: 0 };
    for (let r = 0; r < runs; r++) {
      const out = await runObserver(c, model);
      if (!out.result) {
        notes.push(`${c.id} run ${r}: ERROR ${out.error}`);
        continue;
      }
      const obs = out.result.observations ?? [];
      obsCountByFixture[c.id].push(obs.length);
      totalObs += obs.length;

      for (const o of obs) {
        if (o.masteryLevel >= ANALYZE_PLUS) analyzePlus++;
        if (o.masteryLevel > c.rigorGold.maxMastery) {
          ceilingBreaches++;
          notes.push(`${c.id} run ${r}: CEILING — "${o.conceptLabel}" @ ${o.masteryLevel} (cap ${c.rigorGold.maxMastery}, ${o.evidenceType})`);
        }
      }

      const dups = dupPairs(obs.map((o) => o.conceptLabel));
      dupPairCount += dups.length;
      for (const [x, y] of dups) notes.push(`${c.id} run ${r}: DUP — "${x}" ≈ "${y}"`);

      if (c.rigorGold.requireMisconception) {
        miscHitByFixture[c.id].total++;
        const hasMisc = obs.some((o) => o.evidenceType === "misconception_signal");
        if (hasMisc) miscHitByFixture[c.id].hit++;
        else notes.push(`${c.id} run ${r}: MISSED misconception (planted wrong belief not surfaced)`);
      }

      // Consolidation: when the scholar already has near-duplicate observations,
      // a new observation that near-dups one WITHOUT superseding it is a pile-on
      // (the exact prod failure — 6 "debugging" labels coexisting). A reused/
      // superseding observation is the correct move and is NOT counted.
      if (c.rigorGold.consolidate && c.currentObservations?.length) {
        consolidateRuns++;
        for (const o of obs) {
          if (o.supersedesObservationId) continue; // consolidating — good
          const collide = c.currentObservations.find((cur) => nearDup(cur.conceptLabel, o.conceptLabel));
          if (collide) {
            pileOns++;
            notes.push(`${c.id} run ${r}: PILE-ON — new "${o.conceptLabel}" duplicates existing "${collide.conceptLabel}" without superseding`);
          }
        }
      }

      const lvls = obs.map((o) => `${o.conceptLabel}=${o.masteryLevel}${o.supersedesObservationId ? "↻" : ""}`).join("; ");
      console.error(`  [${c.id} run ${r}] ${obs.length} obs · ${lvls || "(none)"}`);
    }
  }

  // ── Metrics ──
  const analyzeRate = totalObs ? analyzePlus / totalObs : 0;
  const meanObs: Record<string, number> = {};
  let granularityOk = true;
  for (const c of cases) {
    const counts = obsCountByFixture[c.id];
    const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    meanObs[c.id] = mean;
    // Allow 1 of slack over the declared cap (LLMs vary).
    if (mean > c.rigorGold.maxObservations + 1) granularityOk = false;
  }
  let miscHit = 0;
  let miscTotal = 0;
  for (const c of cases) {
    miscHit += miscHitByFixture[c.id].hit;
    miscTotal += miscHitByFixture[c.id].total;
  }
  const miscRate = miscTotal ? miscHit / miscTotal : 1;

  console.error(`\n[rigor-gate] observations per fixture (mean over ${runs} runs):`);
  for (const c of cases) console.error(`    ${c.id}: ${meanObs[c.id].toFixed(1)} (cap ${c.rigorGold.maxObservations})`);
  console.error(`[rigor-gate] Analyze+ (>=4.0) on modest sessions: ${analyzePlus}/${totalObs} (${pct(analyzePlus, totalObs)})`);
  console.error(`[rigor-gate] per-fixture mastery-ceiling breaches: ${ceilingBreaches}`);
  console.error(`[rigor-gate] misconception capture: ${miscHit}/${miscTotal} (${pct(miscHit, miscTotal)})`);
  console.error(`[rigor-gate] near-duplicate label pairs (within a run): ${dupPairCount}`);
  console.error(`[rigor-gate] consolidation pile-ons (dup an existing obs, no supersede): ${pileOns} over ${consolidateRuns} runs`);
  if (notes.length) console.error("\n" + notes.map((n) => "  · " + n).join("\n"));

  // ── Gate ──
  // These are deliberately modest sessions, so the bars are strict but carry a
  // little slack for sampling. The headline is the Analyze+ rate: on scaffolded /
  // fact-collection / directed-build chat, almost nothing is genuinely Analyze+.
  const checks = [
    { name: "granularity (obs count under cap)", ok: granularityOk },
    { name: "calibration (Analyze+ rate <= 15%)", ok: analyzeRate <= 0.15 },
    { name: "tutor-credit (<=2 ceiling breaches)", ok: ceilingBreaches <= 2 },
    { name: "misconception capture (>= 60%)", ok: miscRate >= 0.6 },
    { name: "dedup (<=1 dup pair)", ok: dupPairCount <= 1 },
    { name: "consolidation (<=1 pile-on)", ok: pileOns <= 1 },
  ];
  console.error("");
  for (const ch of checks) console.error(`[rigor-gate] ${ch.ok ? "PASS" : "FAIL"} — ${ch.name}`);
  const pass = checks.every((ch) => ch.ok);
  console.error(`\n[rigor-gate] ${pass ? "PASS ✅" : "FAIL ❌"}`);
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
