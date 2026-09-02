/**
 * EXPERIMENT report generator: reads out/results.json (from run-experiment.ts)
 * and writes out/report.html — a self-contained, house-style review of
 *   prompt options → what response they produced
 *   judge options → how they scored those responses
 *
 *   npx tsx evals/socratic-handoff/experiment/report.ts [--out DIR]
 *
 * Re-runnable without touching the API (all data lives in results.json), so the
 * narrative + layout can be iterated cheaply.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPERIMENT_SCENARIOS, JUDGE_VARIANTS, TUTOR_VARIANTS } from "./variants";
import type { Cell, ExperimentResults } from "./run-experiment";

const HERE = dirname(fileURLToPath(import.meta.url));
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1] ?? def;
}
const outDir = arg("out", join(HERE, "out"));

const results: ExperimentResults = JSON.parse(readFileSync(join(outDir, "results.json"), "utf8"));

// ── The narrative prose (written after reviewing the numbers; re-run report.ts
// to regenerate — no API calls). Kept inline so the report is one committed
// artifact and stays in sync with the scoreboard/transcripts below it. ────────
const NARRATIVE = {
  headline: `
  <p>The "Talk it through" handoff opens a short scratch chat when a kid misses a
  practice problem twice. The shipped system prompt for that chat is tuned almost
  entirely to survive a <em>cheater</em> — a session-wide banned-words list, "hold
  the line under pressure," "read this one twice." That framing is what made the
  tutor scold a bright kid's clever ÷5-as-÷10-then-double strategy: it treats a
  curious learner as an attacker.</p>

  <div class="callout key">
    <h3>The whole reframe: fade is already solved — once, in the engine.</h3>
    <p>The anxiety that shaped the shipped prompt is "if I confirm anything, the
    kid fakes mastery." We traced the grading code and that fear is
    <strong>architecturally impossible here</strong>. The handoff chat is
    <strong>never graded</strong>: the retry after the chat runs with
    <code>record: false</code> (<code>convex/practiceSkills.ts</code>), which
    returns the existing verdict without writing mastery, bumping a rep, or moving
    the scheduler. Green "mastered" is earned <em>only</em> by demonstrated clean
    reps on <strong>bare, fresh variants</strong>, later, unassisted
    (<code>convex/lib/practice/scheduler.ts</code>: <code>DEMONSTRATED_SOURCES =
    new Set(["practice"])</code>; a scaffolded win is provisional, never green). The
    triggering miss <em>is</em> recorded; the talk-it-through recovery is not. So a
    confirmation that slips out in the chat is a mastery <strong>no-op</strong> — it
    literally cannot mint false competence.</p>
    <p>That means we were solving fade in <strong>two</strong> places — the grading
    system <em>and</em> the tutor's defensiveness — when we only need it in one. The
    engine already owns it. So we can free the tutor to be an all-in thinking
    partner and stop grading it on "did a number leak."</p>
  </div>

  <p>With leak-anxiety retired, only two things still matter, and they're the real
  tension — so we made one judge for each pole. We ran five tutor prompts, from the
  shipped <strong>guardian</strong> to the proposed all-in <strong>companion</strong>,
  against both: did the <strong>kid keep doing the thinking</strong> (pedagogy), and
  was the tutor a <strong>warm partner</strong> (brand). A great tutor should win
  <em>both</em>, not trade one for the other.</p>`,

  findings: `
  <div class="callout">
    <h3>1. The reported bug is real, isolated, and lives entirely in the guardian.</h3>
    <p>Across all 60 conversations, the <strong>only</strong> "cold / dismissive"
    flag belongs to the shipped guardian, stonewalling the bright kid: after she did
    <em>every</em> step of her own ÷10-then-double method and asked "is that right??"
    three times, it answered <em>"I can't tell you if it's right."</em> And here's
    the tell — on that same transcript the <em>thinking</em> judge gave the guardian
    a perfect <strong>5/5</strong> (she kept all the reasoning). So the guardian's
    residual failure isn't pedagogy at all; it's that it <strong>withholds warmth
    even when validation is pedagogically free</strong>. It's flagged cold on
    <strong>17% of strategist</strong> conversations and <strong>0% of
    adversarial</strong> ones — it misfires precisely on the curious kid, which is
    the whole complaint.</p>
  </div>

  <div class="callout">
    <h3>2. Warmth is essentially free on the kids the bug actually hurts.</h3>
    <p>Every warmer prompt takes the coldness to <strong>0% flags</strong> and lifts
    the warmth score from the guardian's 4.29 to <strong>4.8–5.0</strong>. And on
    strategists it costs almost nothing on the other axis: <strong>partner, fading,
    and minimal keep a perfect 0% "did-it-for-them" rate</strong> there (thinking
    ~4.9), and <strong>companion</strong> posts a spotless <strong>5/5 warmth</strong>
    while keeping the kid reasoning (one soft thinking ding — it confirmed the final
    answer after she'd done the work). On the bright kid, warm variants win
    <em>both</em> poles; the guardian is the one that trades.</p>
  </div>

  <div class="callout">
    <h3>3. Warmth's only real cost lands on genuine adversarials — and it's the cost we chose to pay.</h3>
    <p>When the kid is truly fishing ("just tell me the answer"), the warm tutors
    "do more of the thinking" on about <strong>17% of adversarial</strong> cells
    (guardian holds firm at 0%): a step gets confirmed, a number slips out. That is
    exactly the leakage we deliberately stopped worrying about — because
    <strong>finding&nbsp;#0 proved it's a mastery no-op</strong>. It can't fake
    competence; the kid still has to land a fresh one cold, later. Among the warm
    options, <strong>fading</strong> holds the thinking line best under bait
    (thinking avg 3.88 vs companion 3.54 / minimal 3.58 / partner 3.33) while
    staying fully warm — a useful hedge if we want the prompt itself to lean toward
    letting the kid finish.</p>
  </div>

  <p class="blurb">Caveat: 3 trials/cell, one judge model (Opus), one tutor model
  (Sonnet); 17% and 0% are 1-of-6 and 0-of-6. Read the rates as directional — the
  <em>pattern</em> (guardian cold only to strategists; warmth free on strategists;
  its only cost is a mastery-irrelevant leak on adversarials) is what's robust, and
  it's visible in the transcripts, not just the means.</p>`,

  recommendation: `
  <div class="callout key">
    <h3>Adopt a warm partner stance. The guardian's defensiveness is now pure cost.</h3>
    <p>Because the engine owns fade, the guardian's leak-defense buys us
    <strong>nothing</strong> on mastery — and it costs us the exact off-brand beat in
    the bug report (cold to a curious kid on 17% of strategist runs). Every warm
    variant erases that at no strategist-thinking cost. This is no longer a
    safety decision; it's a low-stakes pedagogy dial.</p>
  </div>

  <p><strong>Primary recommendation: the <code>companion</code> direction.</strong>
  It's the philosophy match — go all-in as a thought partner, validate the kid's
  own method, help them through it — and the data backs it: fully warm everywhere
  (0% cold, best-in-class 5/5 warmth on strategists) at a thinking cost that is,
  by construction, a mastery no-op. In the head-to-head transcript it validated the
  ÷10-then-double method, had the kid <em>test</em> it on an easy number first, made
  her redo the steps, then confirmed warmly — she left with a generalizable strategy
  she trusted. That's the on-brand outcome the guardian couldn't produce.</p>

  <p><strong>Conservative alternative: <code>fading</code>.</strong> Equally warm,
  but its prompt language nudges the kid to finish the last step themselves, so it
  holds the thinking line best on adversarials. Pick companion if we trust the
  engine to own fade completely (it does); pick fading if we also want the prompt to
  reinforce it. Either way, <strong>don't keep the guardian as-is</strong> — its
  only distinctive behavior is the coldness we're trying to remove.</p>

  <p><strong>On the judges:</strong> we deliberately retired the old strict
  "a-number-leaked" gate. It rewards exactly the cold withholding we want gone, and
  it measures something the engine already neutralizes — a red herring. The two
  judges that remain are the real, non-overlapping poles: <em>kept the thinking</em>
  (pedagogy) and <em>warm partner</em> (brand). Track both; ship the prompt that
  wins both.</p>

  <p class="blurb">Nothing here is wired into <code>convex/</code> yet — this is a
  research harness, and the shipped <code>buildHandoffPrompt</code> is untouched.
  Next step is your call: adopt companion (or fading), then re-run this matrix on the
  chosen prompt to confirm it holds.</p>`,
};

// ── helpers ──────────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const tutorMeta = (id: string) => TUTOR_VARIANTS.find((t) => t.id === id)!;
const judgeMeta = (id: string) => JUDGE_VARIANTS.find((j) => j.id === id)!;
const scenMeta = (id: string) => EXPERIMENT_SCENARIOS.find((s) => s.id === id)!;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function fmt(n: number): string {
  return n.toFixed(2);
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const cellsFor = (pred: (c: Cell) => boolean) => results.cells.filter(pred);
const isStrategist = (c: Cell) => scenMeta(c.scenarioId).persona === "strategist";

function flagRate(cells: Cell[], judgeId: string): number {
  if (!cells.length) return 0;
  return cells.filter((c) => c.verdicts[judgeId].flag).length / cells.length;
}
function dimMean(cells: Cell[], judgeId: string, dimKey: string): number {
  const vals = cells.map((c) => c.verdicts[judgeId].dims.find((d) => d.key === dimKey)?.value).filter((v): v is number => v != null);
  return mean(vals);
}

// color scales
function flagPill(rate: number): string {
  const cls = rate === 0 ? "ok" : rate <= 0.2 ? "warn" : "bad";
  return `<span class="pill ${cls}">${pct(rate)}</span>`;
}
function flagBool(flag: boolean): string {
  return flag ? `<span class="pill bad">⚑ flag</span>` : `<span class="pill ok">clean</span>`;
}
function dimCell(v: number): string {
  const cls = v >= 4.5 ? "d5" : v >= 3.75 ? "d4" : v >= 2.75 ? "d3" : v >= 1.75 ? "d2" : "d1";
  return `<td class="dim ${cls}">${fmt(v)}</td>`;
}

// ── scoreboard: per-judge tutor × metrics ───────────────────────────────────
function scoreboardForJudge(judgeId: string): string {
  const j = judgeMeta(judgeId);
  const rows = results.tutorIds
    .map((tid) => {
      const cells = cellsFor((c) => c.tutorId === tid);
      const strat = cells.filter(isStrategist);
      const adv = cells.filter((c) => !isStrategist(c));
      const dimTds = j.dimKeys.map((k) => dimCell(dimMean(cells, judgeId, k))).join("");
      return `<tr>
  <th class="rowh">${esc(tutorMeta(tid).label)}</th>
  <td>${flagPill(flagRate(cells, judgeId))}</td>
  <td>${flagPill(flagRate(strat, judgeId))}</td>
  <td>${flagPill(flagRate(adv, judgeId))}</td>
  ${dimTds}
</tr>`;
    })
    .join("\n");
  const dimHeads = j.dimKeys.map((k) => `<th class="dimh">${esc(k)}</th>`).join("");
  return `<div class="card judge-card">
  <h3 id="judge-${judgeId}">${esc(j.label)}</h3>
  <p class="blurb">${esc(j.blurb)}</p>
  <p class="flagdef"><strong>Flag =</strong> ${esc(j.flagMeans)}.</p>
  <table class="grid">
    <thead><tr>
      <th class="rowh">tutor prompt ↓</th>
      <th>flag&nbsp;rate</th><th>· strategist</th><th>· adversarial</th>
      ${dimHeads}
    </tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`;
}

// ── transcripts: representative trial per (scenario × tutor) ─────────────────
function repCell(scenarioId: string, tutorId: string): Cell | undefined {
  const cells = cellsFor((c) => c.scenarioId === scenarioId && c.tutorId === tutorId).sort((a, b) => a.trial - b.trial);
  return cells[0];
}
function renderTranscript(cell: Cell): string {
  const label = scenMeta(cell.scenarioId).persona === "strategist" ? "SCHOLAR" : "SCHOLAR";
  return cell.turns
    .map((t) => {
      const who = t.role === "assistant" ? "TUTOR" : label;
      const cls = t.role === "assistant" ? "t-tutor" : "t-scholar";
      return `<div class="turn ${cls}"><span class="who">${who}</span><span class="msg">${esc(t.content)}</span></div>`;
    })
    .join("\n");
}
function verdictStrip(cell: Cell): string {
  return results.judgeIds
    .map((jid) => {
      const j = judgeMeta(jid);
      const v = cell.verdicts[jid];
      const head = v.dims[0];
      return `<span class="vchip"><span class="vj">${esc(j.label.split(" ")[0])}</span> ${flagBool(v.flag)} <span class="vd">${esc(head.key)} ${head.value}/5</span></span>`;
    })
    .join(" ");
}
function verdictNotes(cell: Cell): string {
  return results.judgeIds
    .map((jid) => {
      const j = judgeMeta(jid);
      const v = cell.verdicts[jid];
      const dims = v.dims.map((d) => `${d.key} ${d.value}`).join(" · ");
      const quote = v.quote ? `<div class="vquote">flagged line: “${esc(v.quote)}”</div>` : "";
      return `<div class="vnote">
  <div class="vnh">${esc(j.label)} — ${flagBool(v.flag)}</div>
  <div class="vdims">${esc(dims)}</div>
  ${quote}
  <div class="vtext">${esc(v.notes)}</div>
</div>`;
    })
    .join("\n");
}

function transcriptsForScenario(scenarioId: string): string {
  const s = scenMeta(scenarioId);
  const blocks = results.tutorIds
    .map((tid) => {
      const cell = repCell(scenarioId, tid);
      if (!cell) return "";
      return `<div class="tx-block">
  <h4>${esc(tutorMeta(tid).label)} <span class="triallbl">trial ${cell.trial}</span></h4>
  <div class="strip">${verdictStrip(cell)}</div>
  <details><summary>Read the conversation</summary>
    <div class="transcript">${renderTranscript(cell)}</div>
    <div class="verdicts">${verdictNotes(cell)}</div>
  </details>
</div>`;
    })
    .join("\n");
  return `<div class="card scenario-card">
  <h3 id="scen-${scenarioId}">${esc(s.persona === "strategist" ? "🧠 " : "🎣 ")}${esc(s.stem)} <span class="pcap">${esc(s.persona ?? "adversarial")}</span></h3>
  <p class="blurb">${esc(s.description)} <span class="ansnote">Correct answer (withheld from tutor): <code>${esc(s.correctAnswer)}</code></span></p>
${blocks}
</div>`;
}

// ── tutor-variant prompt cards ──────────────────────────────────────────────
function tutorPromptCards(): string {
  const sample = { stem: "4825 ÷ 5 = ?", wrongAnswers: ["964", "975"] };
  return TUTOR_VARIANTS.map((t) => {
    const prompt = t.build(sample);
    return `<div class="card prompt-card">
  <h3 id="tutor-${t.id}">${esc(t.label)} <span class="glvl">guard level ${t.guardLevel}/4</span></h3>
  <p class="blurb">${esc(t.blurb)}</p>
  <details><summary>Full system prompt (rendered for <code>4825 ÷ 5</code>)</summary><pre class="promptpre">${esc(prompt)}</pre></details>
</div>`;
  }).join("\n");
}
function judgeCards(): string {
  return JUDGE_VARIANTS.map(
    (j) => `<div class="card mini">
  <h4 id="j-${j.id}">${esc(j.label)}</h4>
  <p class="blurb">${esc(j.blurb)}</p>
  <p class="flagdef"><strong>Flag =</strong> ${esc(j.flagMeans)}.</p>
</div>`,
  ).join("\n");
}

// ── assemble ────────────────────────────────────────────────────────────────
const toc = [
  ["tension", "The tension, and why it's smaller than it looks"],
  ["variants", `What we varied — ${results.tutorIds.length} tutor prompts × ${results.judgeIds.length} judges`],
  ["scoreboard", "Scoreboard — how each judge scored each prompt"],
  ["transcripts", "Read the transcripts"],
  ["findings", "Findings"],
  ["recommendation", "Recommendation"],
]
  .map(([id, t]) => `<a href="#${id}">${esc(t)}</a>`)
  .join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Handoff tutor: less-adversarial prompt & judge review</title>
<style>
  :root{
    --ink:#1a1d24; --mut:#5b6472; --line:#e5e8ee; --bg:#f7f8fb; --card:#fff;
    --accent:#3b5bdb; --accent2:#7048e8;
    --ok:#e6f7ee; --okink:#0f7b46; --warn:#fff4e0; --warnink:#a5620a; --bad:#fdecec; --badink:#b42318;
    --d5:#e7f6ee; --d4:#eefaf0; --d3:#fbf7e8; --d2:#fdefe8; --d1:#fdeaea;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .masthead{background:linear-gradient(120deg,#1e2a5a,#3b2d6b);color:#fff;padding:34px 24px 26px;}
  .masthead .wrap{max-width:1080px;margin:0 auto;}
  .masthead h1{margin:0 0 6px;font-size:26px;letter-spacing:-.02em;}
  .masthead .sub{opacity:.85;font-size:14px;max-width:70ch;}
  .masthead .meta{margin-top:14px;font-size:12px;opacity:.75;display:flex;gap:16px;flex-wrap:wrap;}
  .masthead .meta code{background:rgba(255,255,255,.14);padding:1px 6px;border-radius:5px;color:#fff;}
  .layout{max-width:1080px;margin:0 auto;padding:0 24px;display:grid;grid-template-columns:210px 1fr;gap:28px;}
  nav.toc{position:sticky;top:16px;align-self:start;padding-top:26px;font-size:13px;}
  nav.toc a{display:block;color:var(--mut);text-decoration:none;padding:5px 8px;border-radius:6px;border-left:2px solid transparent;}
  nav.toc a:hover{color:var(--accent);background:#eef1fb;border-left-color:var(--accent);}
  main{padding:26px 0 80px;min-width:0;}
  section{margin-bottom:38px;scroll-margin-top:16px;}
  section>h2{font-size:20px;margin:0 0 12px;padding-bottom:7px;border-bottom:2px solid var(--line);letter-spacing:-.01em;}
  p{margin:0 0 12px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 2px rgba(20,25,40,.03);}
  .card.mini{padding:14px 16px;}
  .card h3{margin:0 0 6px;font-size:16px;letter-spacing:-.01em;}
  .card h4{margin:0 0 4px;font-size:14px;}
  .blurb{color:var(--mut);font-size:13.5px;margin:0 0 8px;}
  .flagdef{font-size:12.5px;color:var(--mut);margin:0;}
  .callout{border-left:4px solid var(--accent);background:#eef1fb;border-radius:0 10px 10px 0;padding:14px 18px;margin:14px 0;}
  .callout.key{border-left-color:var(--accent2);background:#f2edfb;}
  .callout h3{margin:0 0 6px;font-size:15px;}
  code{background:#eef0f4;padding:1px 5px;border-radius:5px;font-size:.9em;}
  pre.promptpre{white-space:pre-wrap;background:#0f1424;color:#e7ecff;padding:14px 16px;border-radius:9px;font-size:12px;line-height:1.5;overflow-x:auto;}
  details{margin-top:8px;}
  summary{cursor:pointer;color:var(--accent);font-size:13px;font-weight:600;user-select:none;}
  summary:hover{text-decoration:underline;}
  .glvl,.triallbl,.pcap,.ansnote{font-size:11px;font-weight:600;color:var(--mut);background:#eef0f4;padding:2px 8px;border-radius:20px;vertical-align:middle;}
  .ansnote{background:#f2edfb;color:#5a3ea8;font-weight:500;}
  table.grid{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:10px;}
  table.grid th,table.grid td{border:1px solid var(--line);padding:6px 8px;text-align:center;}
  table.grid thead th{background:#f0f2f7;font-weight:600;color:#39414f;}
  table.grid .rowh{text-align:left;background:#fafbfe;font-weight:600;white-space:nowrap;}
  table.grid .dimh{font-weight:500;color:var(--mut);font-size:11px;}
  td.dim{font-variant-numeric:tabular-nums;font-weight:600;}
  td.dim.d5{background:var(--d5)} td.dim.d4{background:var(--d4)} td.dim.d3{background:var(--d3)} td.dim.d2{background:var(--d2)} td.dim.d1{background:var(--d1)}
  .pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;}
  .pill.ok{background:var(--ok);color:var(--okink);} .pill.warn{background:var(--warn);color:var(--warnink);} .pill.bad{background:var(--bad);color:var(--badink);}
  .tx-block{border-top:1px dashed var(--line);padding-top:12px;margin-top:12px;}
  .tx-block h4{display:flex;gap:8px;align-items:center;}
  .strip{margin:4px 0 2px;display:flex;gap:10px;flex-wrap:wrap;}
  .vchip{font-size:11.5px;background:#fafbfe;border:1px solid var(--line);border-radius:20px;padding:3px 9px;display:inline-flex;gap:6px;align-items:center;}
  .vchip .vj{font-weight:700;color:#39414f;} .vchip .vd{color:var(--mut);}
  .transcript{margin:12px 0;border:1px solid var(--line);border-radius:9px;overflow:hidden;}
  .turn{display:flex;gap:10px;padding:9px 12px;font-size:13px;}
  .turn+.turn{border-top:1px solid var(--line);}
  .turn.t-tutor{background:#f6f8ff;} .turn.t-scholar{background:#fff;}
  .turn .who{flex:0 0 62px;font-size:10.5px;font-weight:700;letter-spacing:.03em;color:var(--mut);padding-top:2px;}
  .turn.t-tutor .who{color:var(--accent);}
  .turn .msg{white-space:pre-wrap;}
  .verdicts{display:grid;grid-template-columns:repeat(${results.judgeIds.length},minmax(0,1fr));gap:10px;margin-top:6px;}
  .vnote{background:#fafbfe;border:1px solid var(--line);border-radius:9px;padding:10px 12px;font-size:12px;}
  .vnh{font-weight:700;margin-bottom:4px;}
  .vdims{color:var(--mut);font-size:11px;margin-bottom:6px;font-variant-numeric:tabular-nums;}
  .vquote{font-style:italic;color:var(--badink);font-size:11.5px;margin-bottom:5px;}
  .vtext{}
  @media(max-width:900px){.layout{grid-template-columns:1fr}nav.toc{display:none}.verdicts{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="masthead"><div class="wrap">
  <h1>Handoff tutor — less-adversarial prompt & judge review</h1>
  <div class="sub">The "Talk it through" handoff was tuned to survive a cheater — but the grading system already makes cheating here pointless (the chat is ungraded; fluency is earned later on fresh problems). So the anti-cheat framing is pure cost: it's what made the tutor scold a curious kid. This tests whether we can free the tutor to be an all-in thinking partner, judged only on the two things that still matter: did the KID keep doing the thinking, and was the tutor warm?</div>
  <div class="meta">
    <span>tutor: <code>${esc(results.tutorModel)}</code></span>
    <span>scholar sim: <code>${esc(results.scholarModel)}</code></span>
    <span>judge: <code>${esc(results.judgeModel)}</code></span>
    <span>${results.cells.length} conversations · ${results.trials} trials/cell · ${results.tutorTurns} turns</span>
    <span>generated ${esc(results.generatedAt.slice(0, 16).replace("T", " "))}</span>
  </div>
</div></div>

<div class="layout">
<nav class="toc">${toc}</nav>
<main>

<section id="tension">
  <h2>The tension, and why it's smaller than it looks</h2>
  ${NARRATIVE.headline || `<p class="blurb">[narrative pending]</p>`}
</section>

<section id="variants">
  <h2>What we varied — ${results.tutorIds.length} tutor prompts × ${results.judgeIds.length} judges</h2>
  <p>Five handoff system prompts, spanning most-defensive to least — including the proposed <strong>companion</strong>. Each is the tutor's <em>entire</em> system prompt for the scratch session; expand to read the full text.</p>
  ${tutorPromptCards()}
  <h3 style="margin-top:22px">The two judges — one per pole of the tension</h3>
  <p>Now that the engine owns fade, only two things matter, and a great tutor wins <em>both</em>: did the <strong>kid keep the thinking</strong>, and was the tutor a <strong>warm partner</strong>? (The old strict "a number leaked" gate is deliberately gone — it's a red herring that pulls the design toward the wrong goal.)</p>
  ${judgeCards()}
</section>

<section id="scoreboard">
  <h2>Scoreboard — how each judge scored each prompt</h2>
  <p>Flag rate = share of that judge's conversations it flagged (lower is better). Dims are 1–5 means (higher is better). The strategist / adversarial split matters: a warmer prompt should honor method better on <em>strategist</em> cells without collapsing into answer-dumping on <em>adversarial</em> ones.</p>
  ${results.judgeIds.map(scoreboardForJudge).join("\n")}
</section>

<section id="transcripts">
  <h2>Read the transcripts</h2>
  <p>One representative conversation per (scenario × tutor), with both judges' verdicts on that same transcript. This is the "what response did each prompt produce, and how did each judge score it" view.</p>
  ${results.scenarioIds.map(transcriptsForScenario).join("\n")}
</section>

<section id="findings">
  <h2>Findings</h2>
  ${NARRATIVE.findings || `<p class="blurb">[findings pending review of the matrix]</p>`}
</section>

<section id="recommendation">
  <h2>Recommendation</h2>
  ${NARRATIVE.recommendation || `<p class="blurb">[recommendation pending]</p>`}
</section>

</main>
</div>
</body>
</html>`;

writeFileSync(join(outDir, "report.html"), html);
console.error(`Wrote ${join(outDir, "report.html")}`);
