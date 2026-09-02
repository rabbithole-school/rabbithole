/**
 * Physical-task appropriateness eval — main runner + REGRESSION GATE.
 *
 *   ANTHROPIC_API_KEY=... npx tsx evals/physical-task/run.ts [--samples N] [--out DIR] [--no-gate]
 *
 * Feeds the REAL assembled tutor system prompt (buildSystemPrompt, with a real
 * physicalEnvironmentContext) + the REAL suggest_physical_task tool to the live
 * tutor, then an Opus judge scores whether the tutor used the physical
 * environment APPROPRIATELY:
 *   - offers a hands-on task when it fits (and NOT when it doesn't — over-trigger),
 *   - keeps the invitation OPEN and never leaks the result (anti-offloading),
 *   - never invents gear that isn't in the inventory.
 *
 * Exits NON-ZERO when a hard gate regresses (leak / invented-gear / over-trigger),
 * so it can guard against future regressions. `--no-gate` reports without failing.
 */
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTutor, type TutorCase, type TutorRun } from "./lib/runTutor";
import { judge, type Verdict } from "./lib/judge";
import { MODELS, JUDGE_MODEL } from "../../convex/lib/models";
import { mean, parseEvalArgs, runPool, writeRunArtifacts } from "../lib/harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const { samples: SAMPLES, out: outDir } = parseEvalArgs({
  samples: {
    default: 3,
    parse: (value) => parseInt(value, 10),
    allowOptionLikeValue: true,
  },
  out: { default: join(HERE, "out"), allowOptionLikeValue: true },
});
const GATE = !process.argv.includes("--no-gate");
const CONCURRENCY = 5;

// ── Regression gates (hard = exit non-zero on violation) ────────────────
// Over-triggering (a forced physical detour) and result-leaks (handing the kid
// the answer) are the failure modes that break the pedagogy; guard them hard.
// Under-triggering (missing an apt moment) is the softer miss — warn only.
const LEAK_MAX = 0.05; // fraction of ALL runs that may leak the result (~<1-in-20)
const INVENTED_GEAR_MAX = 0.05; // fraction of ALL runs that may name off-inventory gear
const OVER_TRIGGER_MAX = 0.25; // fraction of INAPT runs that may suggest a task
const APT_SUGGEST_MIN = 0.6; // soft: fraction of APT runs that SHOULD suggest

const CASES: TutorCase[] = [
  // ── Apt: a hands-on task with listed gear genuinely fits ────────────────
  {
    id: "music-consonance",
    description: "Scholar wonders why some note pairs sound nice and others clash (hand bells apt)",
    kind: "apt",
    scholarName: "Mia",
    readingLevel: "4",
    scholarMessage:
      "why do some two notes sound really nice together but other ones sound kind of ugly and clashy?",
    expectSuggest: true,
  },
  {
    id: "resonance-hum",
    description: "Scholar puzzled why a struck metal bowl keeps humming (singing bowl apt)",
    kind: "apt",
    scholarName: "Leo",
    readingLevel: "5",
    scholarMessage:
      "when you tap a metal bowl why does it keep making that humming sound for so long instead of just stopping?",
    expectSuggest: true,
  },
  {
    id: "hexagon-construct",
    description: "Scholar asks if a perfect hexagon can be drawn without measuring angles (compass apt)",
    kind: "apt",
    scholarName: "Noah",
    readingLevel: "6",
    scholarMessage:
      "is there a way to draw a perfect hexagon without measuring any of the angles with a protractor?",
    expectSuggest: true,
  },

  // ── Inapt: suggesting a physical task would be an over-trigger ───────────
  {
    id: "arithmetic-fluency",
    description: "Pure multiplication-fluency practice — no listed gear helps; a bell detour is inapt",
    kind: "inapt",
    scholarName: "Ava",
    readingLevel: "3",
    scholarMessage: "can you help me get faster at my 7 times table? i keep freezing on 7 times 8.",
    expectSuggest: false,
  },
  {
    id: "narrative-writing",
    description: "Personal-narrative writing beat — a physical task would derail it",
    kind: "inapt",
    scholarName: "Mia",
    readingLevel: "4",
    scholarMessage:
      "i'm writing a story about the day my dog ran away and i'm really stuck on how to end it.",
    expectSuggest: false,
  },
  {
    id: "history-rivers",
    description: "Abstract history question with no relevant gear — no physical task",
    kind: "inapt",
    scholarName: "Leo",
    readingLevel: "5",
    scholarMessage: "why did ancient people usually start building their cities right next to rivers?",
    expectSuggest: false,
  },
];

interface Judged {
  c: TutorCase;
  run: TutorRun;
  verdict: Verdict | null;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const jobs = CASES.flatMap((c) => Array.from({ length: SAMPLES }, (_, s) => ({ c, s })));
  console.error(`[eval] ${CASES.length} cases × ${SAMPLES} samples = ${jobs.length} tutor runs`);

  const runs = await runPool(jobs, async ({ c, s }) => {
    const r = await runTutor(c, s);
    console.error(
      `  [run] ${c.id} #${s} → ${r.error ? `ERROR ${r.error}` : `${r.toolCall ? "TOOL" : "text"} ${(r.text ?? "").length}c`}`,
    );
    return { c, run: r };
  }, { concurrency: CONCURRENCY });

  const judged: Judged[] = await runPool(runs, async ({ c, run }) => {
    if (!run.text && !run.toolCall) return { c, run, verdict: null };
    try {
      const v = await judge(c, run.text, run.toolCall);
      console.error(`  [judge] ${c.id} #${run.sample} → suggested=${v.suggested} (want ${c.expectSuggest}) leak=${v.leakedResult}`);
      return { c, run, verdict: v };
    } catch (e) {
      console.error(`  [judge] ${c.id} FAILED: ${e instanceof Error ? e.message : e}`);
      return { c, run, verdict: null };
    }
  }, { concurrency: CONCURRENCY });

  const { report, gate } = buildReport(judged);
  writeRunArtifacts({
    outDir,
    runs: judged.map((j) => ({
      id: j.c.id,
      sample: j.run.sample,
      text: j.run.text,
      toolCall: j.run.toolCall,
      verdict: j.verdict,
    })),
    report,
  });
  console.error(`\n[eval] wrote report.md + runs.json to ${outDir}`);
  console.error(gate.summary);
  if (GATE && !gate.pass) {
    console.error("\n[eval] REGRESSION GATE FAILED — see above.");
    process.exit(1);
  }
}

function pct(n: number, d: number) {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`;
}
function f(n: number, d = 1) {
  return isNaN(n) ? "n/a" : n.toFixed(d);
}

function buildReport(judged: Judged[]): { report: string; gate: { pass: boolean; summary: string } } {
  const L: string[] = [];
  L.push(`# Physical-Task Appropriateness Eval\n`);
  L.push(`_Tutor model: ${MODELS.SONNET} (live tutor) + the real suggest_physical_task tool. Judge: ${JUDGE_MODEL}._\n`);
  L.push(
    `Does the tutor invite an embodied task when (and only when) it fits, keep the invitation open, never leak the result, and never invent gear? Over-triggering + result-leaks are the guarded failure modes.\n`,
  );

  const withV = judged.filter((j) => j.verdict) as Array<Judged & { verdict: Verdict }>;
  const apt = withV.filter((j) => j.c.expectSuggest);
  const inapt = withV.filter((j) => !j.c.expectSuggest);

  const leaks = withV.filter((j) => j.verdict.leakedResult).length;
  const invented = withV.filter((j) => j.verdict.inventedGear).length;
  const overTriggers = inapt.filter((j) => j.verdict.suggested).length;
  const aptSuggests = apt.filter((j) => j.verdict.suggested).length;

  const leakRate = withV.length ? leaks / withV.length : 0;
  const inventedRate = withV.length ? invented / withV.length : 0;
  const overRate = inapt.length ? overTriggers / inapt.length : 0;
  const aptRate = apt.length ? aptSuggests / apt.length : 1;

  // ── Gates ──
  const gates = [
    { name: "result-leak", pass: leakRate <= LEAK_MAX, got: pct(leaks, withV.length), max: `≤${LEAK_MAX * 100}%`, hard: true },
    { name: "invented-gear", pass: inventedRate <= INVENTED_GEAR_MAX, got: pct(invented, withV.length), max: `≤${INVENTED_GEAR_MAX * 100}%`, hard: true },
    { name: "over-trigger (inapt)", pass: overRate <= OVER_TRIGGER_MAX, got: pct(overTriggers, inapt.length), max: `≤${OVER_TRIGGER_MAX * 100}%`, hard: true },
    { name: "apt-suggest (soft)", pass: aptRate >= APT_SUGGEST_MIN, got: pct(aptSuggests, apt.length), max: `≥${APT_SUGGEST_MIN * 100}%`, hard: false },
  ];
  const hardPass = gates.filter((g) => g.hard).every((g) => g.pass);

  L.push(`## Gates (hard gates fail the run)\n`);
  L.push(`| Gate | Threshold | Observed | Result |`);
  L.push(`|---|---|---|---|`);
  for (const g of gates) {
    L.push(`| ${g.name}${g.hard ? "" : " ⚠︎"} | ${g.max} | ${g.got} | ${g.pass ? "✅ pass" : g.hard ? "❌ FAIL" : "⚠️ warn"} |`);
  }
  L.push(``);

  L.push(`## Per-case\n`);
  L.push(`| Case | Kind | Want suggest? | Suggested | Correct | Open (1-5) | Leak | Invented |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  const byCase = new Map<string, Judged[]>();
  for (const j of judged) {
    if (!byCase.has(j.c.id)) byCase.set(j.c.id, []);
    byCase.get(j.c.id)!.push(j);
  }
  for (const [id, rows] of byCase) {
    const c = rows[0].c;
    const vs = rows.map((r) => r.verdict).filter(Boolean) as Verdict[];
    const sugg = vs.filter((v) => v.suggested).length;
    const correct = vs.filter((v) => v.suggested === c.expectSuggest).length;
    const lk = vs.filter((v) => v.leakedResult).length;
    const inv = vs.filter((v) => v.inventedGear).length;
    L.push(
      `| ${id} | ${c.kind} | ${c.expectSuggest ? "yes" : "**no**"} | ${sugg}/${vs.length} | **${correct}/${vs.length}** | ${f(mean(vs.map((v) => v.openInvitation), NaN))} | ${lk} | ${inv} |`,
    );
  }
  L.push(``);

  L.push(`## Sample notes\n`);
  for (const [id, rows] of byCase) {
    const ex = rows.find((r) => r.verdict);
    if (ex?.verdict) {
      L.push(`- **${id}** — suggested=${ex.verdict.suggested}, leak=${ex.verdict.leakedResult}: ${ex.verdict.notes}`);
      if (ex.run.toolCall) L.push(`  - tool prompt: _"${ex.run.toolCall.prompt}"_`);
    }
  }

  const summary =
    `[eval] gates → leak ${pct(leaks, withV.length)} (≤${LEAK_MAX * 100}%), ` +
    `invented ${pct(invented, withV.length)} (≤${INVENTED_GEAR_MAX * 100}%), ` +
    `over-trigger ${pct(overTriggers, inapt.length)} (≤${OVER_TRIGGER_MAX * 100}%), ` +
    `apt-suggest ${pct(aptSuggests, apt.length)} (≥${APT_SUGGEST_MIN * 100}%) → ${hardPass ? "PASS" : "FAIL"}`;

  return { report: L.join("\n") + "\n", gate: { pass: hardPass, summary } };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
