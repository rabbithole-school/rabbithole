import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SPOTTED_FLAIR_PER_SCHOLAR_WEEK } from "../../convex/lib/spottedFlair";
import { labelsSchema, resultsSchema, scoreLabels, scoreWeeks } from "./lib";

const cell = (value: string) => value.replace(/[|\n\r<>]/g, " ");
const ratio = (yes: number, total: number) => total ? `${yes}/${total} (${(100 * yes / total).toFixed(1)}%)` : "N/A (0 labels)";

function main() {
  const { values, positionals } = parseArgs({
    options: { out: { type: "string" } }, allowPositionals: true,
  });
  if (positionals.length < 2 || !values.out) {
    throw new Error("Usage: npx tsx evals/spotted-flair/score.ts results.json labels-a.json [labels-b.json ...] --out report.md");
  }
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  const results = resultsSchema.parse(read(positionals[0]));
  if (!results.sessions.length) throw new Error("No successful sessions to score");
  const labels = positionals.slice(1).map((path) => labelsSchema.parse(read(path)));
  const scores = scoreLabels(results, labels);
  const weekly = scoreWeeks(results);
  const lines = [
    "# Spotted flair back-test",
    "",
    `${results.sessions.length} sessions; ${results.model}; ${labels.length} labeler(s).`,
    `Code fingerprint: \`${results.codeHash}\`.`,
    "",
    "## Teacher judgments",
    "",
    "Precision = yes among labeled awarded moments. Recall proxy = yes among sampled not-awarded corroborated moments (a missed-opportunity rate, NOT recall).",
    "The main denominator includes unsure; decisive-only excludes unsure. Missing answers are never no. Pooled values count judgments, not unique moments; see each rater separately.",
    "",
    "| Labeler | Group | Yes / labeled | Yes / decisive | Unsure | Missing |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of [...scores.perLabeler, { labeler: "Pooled", ...scores.pooled }]) {
    for (const group of ["awarded", "notAwarded"] as const) {
      const c = row[group];
      lines.push(`| ${cell(row.labeler)} | ${group === "awarded" ? "Precision" : "Recall proxy"} | ${ratio(c.yes, c.yes + c.no + c.unsure)} | ${ratio(c.yes, c.yes + c.no)} | ${c.unsure} | ${c.missing} |`);
    }
  }
  lines.push("", "## Inter-rater agreement", "",
    "Exact nominal agreement on mutually answered cards, including unsure. Cohen's kappa is N/A when no overlap or chance agreement is 1.",
    "", "| Labelers | Exact agreement | Cohen's kappa |", "| --- | --- | --- |");
  for (const pair of scores.agreement) {
    lines.push(`| ${pair.labelers.map(cell).join(" / ")} | ${ratio(pair.agree, pair.n)} | ${pair.kappa?.toFixed(3) ?? "N/A"} |`);
  }
  if (!scores.agreement.length) lines.push("| Only one labeler | N/A | N/A |");
  lines.push("", "## Award frequency and rolling cap", "",
    "Awards below are uncapped, code-gated proposals: at most one per replayed session. Weeks start Monday in UTC; every scholar-week with an input session counts, including zero-award weeks. Unobserved weeks do not count.",
    "For each positive integer cap, replay awards chronologically per scholar. An award is blocked when previously accepted awards in the inclusive trailing 7 days reach the cap. A scholar-week binds if any award in it is blocked. Exact timestamp ties use session id order.",
    "",
    `**Smallest cap binding in strictly fewer than 1 in 5 observed scholar-weeks: ${weekly.recommended ?? "N/A"}.**`,
    "",
    "| Cap | Bound scholar-weeks | Fraction |",
    "| --- | --- | --- |",
    ...weekly.caps.map((c) => `| ${c.cap} | ${c.boundWeeks}/${weekly.weeks.length} | ${(100 * c.fraction).toFixed(1)}% |`),
    "",
    `| Scholar | Week (UTC) | Uncapped awards | Accepted at cap ${SPOTTED_FLAIR_PER_SCHOLAR_WEEK} | Blocked at cap ${SPOTTED_FLAIR_PER_SCHOLAR_WEEK} |`,
    "| --- | --- | --- | --- | --- |",
    ...weekly.weeks.map((w) => `| ${cell(w.scholarId)} | ${w.week} | ${w.awards} | ${w.awards - w.blockedAtCurrentCap} | ${w.blockedAtCurrentCap} |`),
    "",
    "## Limits",
    "",
    "- This is one end-of-session observer pass, always open, with the production transcript window and empty prior observer state. It is not a replay of every live observer turn.",
    "- Input date stands in for award time. Missing earlier history left-censors rolling windows; incomplete weeks and selected sessions bias cap estimates. A real study needs complete scholar-week coverage and a preceding 7-day warm-up history.",
    "- The blind controls are a sample of corroborated, unawarded turns. Moments with no corroboration are invisible here. The proxy cannot estimate whole-corpus recall.",
    "- Teacher judgments measure quality; the cap estimate uses all code-gated awards, not just teacher-approved ones. Fictional data or simulated labels prove plumbing, not calibration.",
    "- No production cap or prompt is changed by this report. Keep this report and all source transcripts/labels in private scratch storage.",
    "",
  );
  writeFileSync(values.out, lines.join("\n"), { mode: 0o600 });
  console.log(`Report written; ${results.sessions.length} sessions, ${labels.length} labeler(s), suggested cap ${weekly.recommended}`);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : "Scoring failed");
  process.exitCode = 1;
}
