/**
 * Grapheme-pass mechanical eval — main runner.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/grapheme-pass/run.ts [flags]
 *
 * Flags:
 *   --model <id>        model to run (default: MODELS.HAIKU — what ships)
 *   --fixtures <path>   fixtures JSON (default: ./fixtures/segmentations.json)
 *   --concurrency N     parallel API calls (default: 6)
 *   --threshold F       min overall F1 to pass; exits non-zero below it (default: 0.92)
 *   --out DIR           write results.json here (default: ./out)
 *   --verbose           print every case's per-span diff, not just failures
 *
 * NO LLM judge — correctness is objective. Each fixture's `marked` string IS the
 * gold (bracketed = a TRUE team occurrence). We strip the brackets to get the
 * plain text + gold offsets, run the PRODUCTION annotation logic
 * (`convex/lib/graphemeAnnotate.ts` — the exact prompt + tool + validation the
 * live action uses, imported not re-implemented), and score precision/recall per
 * team and overall over the set of (start,end,team) spans.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS } from "../../convex/lib/models";
import { parseEvalArgs, runPool, writeRunArtifacts } from "../lib/harness";
import {
  GRAPHEME_SYSTEM_PROMPT,
  GRAPHEME_TOOL,
  buildAnnotationUserMessage,
  findCandidates,
  parseGraphemeToolResponse,
  annotateFromToolResult,
  normalizeTeams,
  type GraphemeSpan,
} from "../../convex/lib/graphemeAnnotate";

const HERE = dirname(fileURLToPath(import.meta.url));

const {
  model: MODEL,
  fixtures: FIXTURES,
  concurrency: CONCURRENCY,
  threshold: THRESHOLD,
  out: OUT_DIR,
  verbose: VERBOSE,
} = parseEvalArgs({
  model: { default: MODELS.HAIKU, allowOptionLikeValue: true },
  fixtures: { default: join(HERE, "fixtures/segmentations.json"), allowOptionLikeValue: true },
  concurrency: { default: 6, parse: (value) => parseInt(value, 10), allowOptionLikeValue: true },
  threshold: { default: 0.92, parse: (value) => parseFloat(value), allowOptionLikeValue: true },
  out: { default: join(HERE, "out"), allowOptionLikeValue: true },
  verbose: { default: false, boolean: true },
});

// ─── Fixtures ──────────────────────────────────────────────────────────────
interface FixtureCase {
  id: string;
  inventory: string[];
  marked: string;
  note?: string;
}
interface FixtureFile {
  description?: string;
  cases: FixtureCase[];
}

/**
 * Parse a `marked` string: strip the [brackets] to recover the plain text and
 * emit the gold spans (offsets into the plain text). Validates that every
 * bracketed segment is one of the case's declared inventory teams — an authoring
 * mistake fails the run loudly rather than silently scoring against junk.
 */
function parseMarked(
  marked: string,
  inventory: string[],
  id: string,
): { text: string; gold: GraphemeSpan[] } {
  const invSet = new Set(normalizeTeams(inventory));
  let text = "";
  const gold: GraphemeSpan[] = [];
  let i = 0;
  while (i < marked.length) {
    const ch = marked[i];
    if (ch === "]") {
      throw new Error(`[${id}] unbalanced ']' in marked string`);
    }
    if (ch === "[") {
      const close = marked.indexOf("]", i + 1);
      if (close === -1) throw new Error(`[${id}] unclosed '[' in marked string`);
      const letters = marked.slice(i + 1, close);
      if (letters.length === 0) throw new Error(`[${id}] empty [] marker`);
      const team = letters.toLowerCase();
      if (!invSet.has(team)) {
        throw new Error(
          `[${id}] marked team "${team}" is not in the declared inventory [${inventory.join(", ")}]`,
        );
      }
      const start = text.length;
      text += letters;
      gold.push({ start, end: text.length, team });
      i = close + 1;
    } else {
      text += ch;
      i++;
    }
  }
  // Sanity: gold offsets really point at the team's letters in the plain text.
  for (const g of gold) {
    if (text.slice(g.start, g.end).toLowerCase() !== g.team) {
      throw new Error(`[${id}] gold span ${JSON.stringify(g)} does not match text`);
    }
  }
  return { text, gold };
}

// ─── Model call ──────────────────────────────────────────────────────────────
const anthropic = new Anthropic();

interface CaseRun {
  id: string;
  note?: string;
  text: string;
  inventory: string[];
  gold: GraphemeSpan[];
  predicted: GraphemeSpan[];
  calledModel: boolean;
  error?: string;
}

async function runCase(c: FixtureCase): Promise<CaseRun> {
  const { text, gold } = parseMarked(c.marked, c.inventory, c.id);
  const teams = normalizeTeams(c.inventory);
  const candidates = findCandidates(text, teams);

  // Same short-circuits the production action applies: empty inventory or no
  // literal candidate → annotate nothing, no model call.
  if (teams.length === 0 || candidates.length === 0) {
    return { id: c.id, note: c.note, text, inventory: c.inventory, gold, predicted: [], calledModel: false };
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: GRAPHEME_SYSTEM_PROMPT,
      tools: [GRAPHEME_TOOL],
      tool_choice: { type: "tool", name: GRAPHEME_TOOL.name },
      messages: [{ role: "user", content: buildAnnotationUserMessage(text, candidates) }],
    });
    const trueIds = parseGraphemeToolResponse(response.content) ?? [];
    const predicted = annotateFromToolResult(text, candidates, trueIds);
    return { id: c.id, note: c.note, text, inventory: c.inventory, gold, predicted, calledModel: true };
  } catch (e) {
    return {
      id: c.id,
      note: c.note,
      text,
      inventory: c.inventory,
      gold,
      predicted: [],
      calledModel: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
const key = (s: GraphemeSpan) => `${s.start}:${s.end}:${s.team}`;

interface Tally {
  tp: number;
  fp: number;
  fn: number;
}
function emptyTally(): Tally {
  return { tp: 0, fp: 0, fn: 0 };
}
function precision(t: Tally): number {
  return t.tp + t.fp === 0 ? 1 : t.tp / (t.tp + t.fp);
}
function recall(t: Tally): number {
  return t.tp + t.fn === 0 ? 1 : t.tp / (t.tp + t.fn);
}
function f1(t: Tally): number {
  const p = precision(t);
  const r = recall(t);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function scoreCase(run: CaseRun): {
  overall: Tally;
  perTeam: Map<string, Tally>;
  fp: GraphemeSpan[];
  fn: GraphemeSpan[];
} {
  const goldKeys = new Map(run.gold.map((s) => [key(s), s]));
  const predKeys = new Map(run.predicted.map((s) => [key(s), s]));
  const overall = emptyTally();
  const perTeam = new Map<string, Tally>();
  const bump = (team: string, field: keyof Tally) => {
    if (!perTeam.has(team)) perTeam.set(team, emptyTally());
    perTeam.get(team)![field]++;
    overall[field]++;
  };
  const fp: GraphemeSpan[] = [];
  const fn: GraphemeSpan[] = [];
  for (const [k, s] of predKeys) {
    if (goldKeys.has(k)) bump(s.team, "tp");
    else {
      bump(s.team, "fp");
      fp.push(s);
    }
  }
  for (const [k, s] of goldKeys) {
    if (!predKeys.has(k)) {
      bump(s.team, "fn");
      fn.push(s);
    }
  }
  return { overall, perTeam, fp, fn };
}

// ─── Reporting ───────────────────────────────────────────────────────────────
function fmtPct(x: number): string {
  return (x * 100).toFixed(1).padStart(5) + "%";
}
function spanStr(text: string, s: GraphemeSpan): string {
  return `"${s.team}"@${s.start}(${text.slice(s.start, s.end)})`;
}

async function main() {
  const fixtures: FixtureFile = JSON.parse(readFileSync(FIXTURES, "utf8"));
  console.error(`Model: ${MODEL}  |  cases: ${fixtures.cases.length}  |  threshold(F1): ${THRESHOLD}`);

  const runs = await runPool(fixtures.cases, runCase, { concurrency: CONCURRENCY });

  const overall = emptyTally();
  const perTeam = new Map<string, Tally>();
  const failures: string[] = [];
  const errors: string[] = [];

  for (const run of runs) {
    if (run.error) errors.push(`${run.id}: ${run.error}`);
    const { overall: o, perTeam: pt, fp, fn } = scoreCase(run);
    overall.tp += o.tp;
    overall.fp += o.fp;
    overall.fn += o.fn;
    for (const [team, t] of pt) {
      if (!perTeam.has(team)) perTeam.set(team, emptyTally());
      const acc = perTeam.get(team)!;
      acc.tp += t.tp;
      acc.fp += t.fp;
      acc.fn += t.fn;
    }
    const caseFailed = fp.length > 0 || fn.length > 0;
    if (caseFailed || VERBOSE) {
      const parts: string[] = [];
      if (fp.length) parts.push(`  FP (over-annotated): ${fp.map((s) => spanStr(run.text, s)).join(", ")}`);
      if (fn.length) parts.push(`  FN (missed): ${fn.map((s) => spanStr(run.text, s)).join(", ")}`);
      const head = `${caseFailed ? "✗" : "✓"} ${run.id}  ${JSON.stringify(run.text)}  [inv: ${run.inventory.join(",")}]`;
      failures.push([head, ...parts].join("\n"));
    }
  }

  // ── per-team table ──
  console.log("\nPer-team:");
  console.log("  team    P        R        F1      (tp/fp/fn)");
  const teamRows = [...perTeam.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [team, t] of teamRows) {
    console.log(
      `  ${team.padEnd(6)} ${fmtPct(precision(t))}  ${fmtPct(recall(t))}  ${fmtPct(f1(t))}   (${t.tp}/${t.fp}/${t.fn})`,
    );
  }

  // ── overall ──
  console.log("\nOverall:");
  console.log(`  precision: ${fmtPct(precision(overall))}   (tp=${overall.tp}, fp=${overall.fp})`);
  console.log(`  recall:    ${fmtPct(recall(overall))}   (tp=${overall.tp}, fn=${overall.fn})`);
  console.log(`  F1:        ${fmtPct(f1(overall))}`);

  if (failures.length) {
    console.log(`\nCase detail (${failures.filter((f) => f.startsWith("✗")).length} failing):`);
    for (const f of failures) console.log(f);
  }
  if (errors.length) {
    console.log(`\nAPI errors (${errors.length}):`);
    for (const e of errors) console.log(`  ${e}`);
  }

  // ── persist ──
  const artifact = {
    model: MODEL,
    threshold: THRESHOLD,
    overall: { ...overall, precision: precision(overall), recall: recall(overall), f1: f1(overall) },
    perTeam: Object.fromEntries(
      [...perTeam.entries()].map(([team, t]) => [
        team,
        { ...t, precision: precision(t), recall: recall(t), f1: f1(t) },
      ]),
    ),
    runs,
  };
  writeRunArtifacts({ outDir: OUT_DIR, runs: artifact, runsFile: "results.json" });

  const f1Overall = f1(overall);
  if (errors.length) {
    console.error(`\nFAIL — ${errors.length} API error(s).`);
    process.exit(1);
  }
  if (f1Overall < THRESHOLD) {
    console.error(`\nFAIL — overall F1 ${fmtPct(f1Overall)} < threshold ${fmtPct(THRESHOLD)}.`);
    process.exit(1);
  }
  console.error(`\nPASS — overall F1 ${fmtPct(f1Overall)} ≥ threshold ${fmtPct(THRESHOLD)}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
