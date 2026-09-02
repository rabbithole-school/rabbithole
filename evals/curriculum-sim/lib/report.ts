/**
 * Markdown rendering for the curriculum-sim harness — eyeball reports shared
 * across phases (analyze, propose, optimize).
 */
import {
  DESIGN_DIMS,
  FITNESS_DIMS,
  PROTECTED_DIMS,
  type SessionVerdict,
  type Aggregate,
  type BetterResult,
} from "./score";
import { judgeModel } from "./judge";
import type { CastRun } from "./orchestrator";
import { renderDiff } from "./diff";
import type { ActivityVariant } from "./variant";
import type { SessionResult, SimActivity } from "./types";

function renderTranscript(session: SessionResult, verdict?: SessionVerdict): string {
  const lines: string[] = [];
  const tag = verdict
    ? ` — goal ${verdict.goalAttainment}/5, struggle ${verdict.productiveStruggle}/5`
    : "";
  lines.push(`\n---\n\n## ${session.profile.name} — _${session.stopReason}_${tag}`);
  lines.push(`*Traits: ${session.profile.traits.join("; ") || "none"}*\n`);
  for (const t of session.turns) {
    const who = t.role === "tutor" ? "**Tutor**" : `**${session.profile.name}**`;
    lines.push(`> ${who}: ${t.content.replace(/\n/g, "\n> ")}\n`);
  }
  if (verdict) {
    if (verdict.stallPoint && verdict.stallPoint !== "none") lines.push(`**Stall:** ${verdict.stallPoint}`);
    if (verdict.promptAttribution && verdict.promptAttribution !== "none") lines.push(`**Prompt attribution:** ${verdict.promptAttribution}`);
    lines.push(`**Verdict:** ${verdict.summary}`);
  }
  return lines.join("\n");
}

export function renderAggregateTable(agg: Aggregate): string {
  const lines: string[] = [];
  const designValue = (dim: (typeof DESIGN_DIMS)[number]) => {
    const value = agg.dims[dim];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const barMean =
    DESIGN_DIMS.reduce((sum, dim) => sum + designValue(dim), 0) /
    DESIGN_DIMS.length;
  lines.push(`**Fitness (mean of ${FITNESS_DIMS.join(", ")}): ${agg.fitness.toFixed(2)}/5** · goal-reached rate ${(agg.goalAttainmentRate * 100).toFixed(0)}% · n=${agg.n}\n`);
  lines.push(`| Dimension | Mean | |`);
  lines.push(`|---|---|---|`);
  for (const d of FITNESS_DIMS) lines.push(`| ${d} | ${agg.dims[d].toFixed(2)} | fitness |`);
  for (const d of PROTECTED_DIMS) lines.push(`| ${d} | ${agg.dims[d].toFixed(2)} | protected |`);
  lines.push(`\n### Investigation bar (design)`);
  lines.push(`\n**Bar mean: ${barMean.toFixed(2)}/5**`);
  lines.push(`\n| Dimension | Mean |`);
  lines.push(`|---|---|`);
  for (const d of DESIGN_DIMS) lines.push(`| ${d} | ${designValue(d).toFixed(2)} |`);
  return lines.join("\n");
}

export function renderAnalyzeReport(activity: SimActivity, run: CastRun, offline: boolean): string {
  const lines: string[] = [];
  lines.push(`# Curriculum simulation — ${activity.title}`);
  if (offline) lines.push(`\n> ⚠️ OFFLINE stub output (no model calls). Shape demo only.`);
  else lines.push(`\n_Judge: \`${judgeModel}\`_`);
  lines.push(`\n**Learning goal:** ${activity.learningGoal}`);
  if (run.aggregate) {
    lines.push(`\n${renderAggregateTable(run.aggregate)}`);
  } else {
    const reached = run.sessions.filter((s) => s.stopReason === "goal").length;
    lines.push(`\n**Goal reached:** ${reached}/${run.sessions.length} (by stop signal; run with --judge for scored fit).`);
  }
  lines.push(`\n| Scholar | Reading level | Outcome | Scholar turns |`);
  lines.push(`|---|---|---|---|`);
  for (const s of run.sessions) {
    const n = s.turns.filter((t) => t.role === "scholar").length;
    lines.push(`| ${s.profile.name} | ${s.profile.readingLevel} | ${s.stopReason} | ${n} |`);
  }
  // Cap-bite check: a high share of sessions ending on the turn cap (rather than
  // a natural goal/stuck signal) means the conversation was likely cut off
  // mid-thread — read the numbers with that in mind and consider --max-turns.
  const capped = run.sessions.filter((s) => s.stopReason === "maxTurns").length;
  if (run.sessions.length) {
    lines.push(
      `\n_Hit the turn cap: ${capped}/${run.sessions.length} (${Math.round((capped / run.sessions.length) * 100)}%). High = sessions cut off; raise --max-turns for a fairer read._`,
    );
  }
  run.sessions.forEach((s, i) => lines.push(renderTranscript(s, run.verdicts[i])));
  return lines.join("\n");
}

/** Side-by-side fitness deltas for a before→after pair. */
function renderDeltaTable(before: Aggregate, after: Aggregate): string {
  const lines: string[] = [];
  lines.push(`| Dimension | Baseline | Candidate | Δ | |`);
  lines.push(`|---|---|---|---|---|`);
  const row = (d: keyof Aggregate["dims"], kind: string) => {
    const b = before.dims[d];
    const a = after.dims[d];
    const delta = a - b;
    const arrow = delta > 0.001 ? "▲" : delta < -0.001 ? "▼" : "·";
    lines.push(`| ${d} | ${b.toFixed(2)} | ${a.toFixed(2)} | ${arrow} ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} | ${kind} |`);
  };
  for (const d of FITNESS_DIMS) row(d, "fitness");
  for (const d of PROTECTED_DIMS) row(d, "protected");
  lines.push(`\n**Fitness ${before.fitness.toFixed(2)} → ${after.fitness.toFixed(2)}** · goal-reached ${(before.goalAttainmentRate * 100).toFixed(0)}% → ${(after.goalAttainmentRate * 100).toFixed(0)}%`);
  const beforeBar =
    DESIGN_DIMS.reduce((sum, dim) => {
      const value = before.dims[dim];
      return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0) /
    DESIGN_DIMS.length;
  const afterBar =
    DESIGN_DIMS.reduce((sum, dim) => {
      const value = after.dims[dim];
      return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0) /
    DESIGN_DIMS.length;
  lines.push(`\n### Investigation bar (design)\n`);
  lines.push(`| Dimension | Baseline | Candidate | Δ |`);
  lines.push(`|---|---|---|---|`);
  for (const d of DESIGN_DIMS) {
    const beforeValue = before.dims[d];
    const afterValue = after.dims[d];
    const b =
      typeof beforeValue === "number" && Number.isFinite(beforeValue)
        ? beforeValue
        : 0;
    const a =
      typeof afterValue === "number" && Number.isFinite(afterValue)
        ? afterValue
        : 0;
    const delta = a - b;
    const arrow = delta > 0.001 ? "▲" : delta < -0.001 ? "▼" : "·";
    lines.push(
      `| ${d} | ${b.toFixed(2)} | ${a.toFixed(2)} | ${arrow} ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} |`,
    );
  }
  lines.push(`\n**Bar mean ${beforeBar.toFixed(2)} → ${afterBar.toFixed(2)}**`);
  return lines.join("\n");
}

/** Phase 3 — the full optimization run: lineage, per-generation, final diff. */
export function renderOptimizeReport(args: {
  activity: SimActivity;
  result: import("./optimizer").OptimizerResult;
  offline: boolean;
}): string {
  const { activity, result, offline } = args;
  const { baseline, best } = result;
  const lines: string[] = [];
  lines.push(`# Self-improvement run — ${activity.title}`);
  if (offline) lines.push(`\n> ⚠️ OFFLINE stub output (no model calls). Shape demo only.`);
  lines.push(`\n**Learning goal (fixed):** ${activity.learningGoal}`);
  lines.push(`\n**Stopped:** ${result.stoppedReason} after ${result.generations.length} generation(s), ${result.evaluations} cast-evaluations.`);
  const improved = best.variant.id !== baseline.variant.id;
  lines.push(`\n**Outcome:** ${improved ? `champion improved fitness ${baseline.agg.fitness.toFixed(2)} → ${best.agg.fitness.toFixed(2)}` : "no variant beat the baseline — keep current activity"}.`);

  lines.push(`\n## Generations\n`);
  lines.push(`| Gen | Candidates | Best cand fitness | Promoted |`);
  lines.push(`|---|---|---|---|`);
  for (const g of result.generations) {
    const bestF = g.candidates.length ? Math.max(...g.candidates.map((c) => c.agg.fitness)).toFixed(2) : "—";
    lines.push(`| ${g.generation} | ${g.candidates.length} | ${bestF} | ${g.promotedVariantId ?? "—"} |`);
  }

  if (improved) {
    lines.push(`\n## Winning change\n`);
    lines.push(renderDeltaTable(baseline.agg, best.agg));
    lines.push(`\n**Rationale:** ${best.variant.rationale ?? "(none)"}`);
    lines.push(`\n## systemPrompt diff (baseline → champion)\n`);
    lines.push(renderDiff(baseline.variant.systemPrompt ?? "", best.variant.systemPrompt ?? ""));
  }
  return lines.join("\n");
}

/** Phase 2 — one proposed variant with its measured before/after + diff. */
export function renderProposeReport(args: {
  activity: SimActivity;
  baseline: { variant: ActivityVariant; agg: Aggregate };
  candidate: { variant: ActivityVariant; agg: Aggregate };
  decision: BetterResult;
  offline: boolean;
}): string {
  const { activity, baseline, candidate, decision, offline } = args;
  const lines: string[] = [];
  lines.push(`# Proposed improvement — ${activity.title}`);
  if (offline) lines.push(`\n> ⚠️ OFFLINE stub output (no model calls). Shape demo only.`);
  lines.push(`\n**Learning goal (fixed):** ${activity.learningGoal}`);
  lines.push(`\n## Decision: ${decision.better ? "✅ PROMOTE (candidate wins)" : "❌ HOLD (keep baseline)"}`);
  lines.push(`${decision.reason}`);
  if (!decision.gate.pass) {
    lines.push(`\n**Protected-dim gate violations:**`);
    for (const v of decision.gate.violations) lines.push(`- ${v.dim}: ${v.candidate.toFixed(2)} vs baseline ${v.baseline.toFixed(2)} — ${v.reason}`);
  }
  lines.push(`\n## Measured effect across the cast\n`);
  lines.push(renderDeltaTable(baseline.agg, candidate.agg));
  lines.push(`\n## Rationale\n${candidate.variant.rationale ?? "(none)"}`);
  lines.push(`\n## systemPrompt diff\n`);
  lines.push(renderDiff(baseline.variant.systemPrompt ?? "", candidate.variant.systemPrompt ?? ""));
  return lines.join("\n");
}
