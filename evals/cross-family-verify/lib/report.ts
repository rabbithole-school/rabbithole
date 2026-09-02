/**
 * Markdown rendering for the cross-family agreement report. Pure — takes the
 * AgreementReport from compare.ts and returns a string (printed to stdout and,
 * with --out, written to disk).
 */
import type { AgreementReport, DimComparison } from "./compare";

function arrow(delta: number): string {
  if (delta > 0.001) return "▲";
  if (delta < -0.001) return "▼";
  return "·";
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function dimRow(d: DimComparison): string {
  const flag = d.material ? " ⚠️" : "";
  return `| ${d.dim} | ${d.group} | ${d.anthropic.toFixed(2)} | ${d.openai.toFixed(2)} | ${arrow(d.delta)} ${signed(d.delta)}${flag} |`;
}

export function renderAgreementReport(report: AgreementReport): string {
  const lines: string[] = [];
  lines.push(`# Cross-family verification — ${report.activityTitle}`);
  if (report.dryRun) {
    lines.push(`\n> ⚠️ DRY RUN — GPT verdicts are a deterministic stub (no API call). Structure demo only.`);
  }
  lines.push(
    `\n_Anthropic judge (curriculum loop): \`${report.anthropicJudge}\` · second family: \`${report.openaiJudge}\` · n=${report.n} sessions_`,
  );

  // Headline.
  lines.push(`\n## Verdict`);
  lines.push(`\n${report.recommendation}`);
  lines.push(
    `\n- **Cross-family agreement:** ${report.agree ? "AGREE" : "DISAGREE"} (mean |Δ| = ${report.meanAbsDelta.toFixed(2)} across ${report.dims.length} dims; material threshold |Δ| > 1)`,
  );
  lines.push(
    `- **Fitness (promotion scalar):** Anthropic ${report.fitness.anthropic.toFixed(2)} → GPT ${report.fitness.openai.toFixed(2)} (${arrow(report.fitness.delta)} ${signed(report.fitness.delta)}) — ${report.fitnessAgree ? "agree" : "**disagree**"}`,
  );

  // Per-dimension table.
  lines.push(`\n## Per-dimension agreement`);
  lines.push(`\n| Dimension | Lens | Anthropic | GPT | Δ (GPT − Anthropic) |`);
  lines.push(`|---|---|---|---|---|`);
  for (const d of report.dims) lines.push(dimRow(d));

  // Material disagreements.
  lines.push(`\n## Material disagreements (|Δ| > 1)`);
  if (report.materialDisagreements.length === 0) {
    lines.push(`\n_None — the two families agree within a point on every dimension._`);
  } else {
    for (const d of report.materialDisagreements) {
      lines.push(
        `- **${d.dim}** (${d.group}): Anthropic ${d.anthropic.toFixed(2)} vs GPT ${d.openai.toFixed(2)} — Δ ${signed(d.delta)}`,
      );
    }
  }

  lines.push(
    `\n---\n_Addresses Finding 2 (review/sim-realism-lessons.html §4): the curriculum loop's judge AND improver are both Opus — shared weights share quirks, so the improver can learn to please the judge. This re-judges the winning variant with a different model family at the promotion boundary, before a teacher sees "promote"._`,
  );
  return lines.join("\n");
}
