/**
 * Self-contained side-by-side HTML viewer for the baked-vs-ad-lib comparison.
 * No deps, inline CSS — open out/compare.html in a browser to read each
 * synthetic scholar's ad-lib transcript next to their baked transcript, with
 * the judge's scores under each and the actual baked activity that drove it.
 */
import type { SessionResult, SimTurn } from "../../curriculum-sim/lib/types";
import type { SessionVerdict } from "../../curriculum-sim/lib/score";
import {
  DESIGN_DIMS,
  FITNESS_DIMS,
  GIFTED_DIMS,
  PROTECTED_DIMS,
} from "../../curriculum-sim/lib/score";
import type { BakedActivity, Topic } from "./arms";
import type { Decision } from "./report";

export interface PairRecord {
  topic: Topic;
  baked: BakedActivity;
  bakeMs: number;
  profileName: string;
  adLib: { session: SessionResult; verdict: SessionVerdict };
  bakedRun: { session: SessionResult; verdict: SessionVerdict };
}

function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function turnsHtml(turns: SimTurn[]): string {
  return turns
    .map((t) => {
      const who = t.role === "tutor" ? "tutor" : "scholar";
      const label = t.role === "tutor" ? "Tutor" : "Scholar";
      return `<div class="msg ${who}"><span class="who">${label}</span><div class="bubble">${esc(
        t.content,
      )}</div></div>`;
    })
    .join("\n");
}

const KEY_DIMS = [...FITNESS_DIMS, ...GIFTED_DIMS, ...PROTECTED_DIMS] as const;

function scoreStrip(
  v: SessionVerdict,
  dims: readonly (keyof SessionVerdict)[],
  label: string,
): string {
  const cell = (d: string) => {
    const raw = v[d as keyof SessionVerdict];
    const val = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    const hue = Math.round(((val - 1) / 4) * 120); // 1→red, 5→green
    return `<span class="sc" style="background:hsl(${hue} 70% 88%)" title="${d}">${d.slice(0, 4)} ${val}</span>`;
  };
  return `<div class="scoregroup"><b>${label}</b><div class="scores">${dims.map(cell).join("")}</div></div>`;
}

function fitness(v: SessionVerdict): string {
  const f = (FITNESS_DIMS.reduce((a, d) => a + (v[d] as number), 0) / FITNESS_DIMS.length).toFixed(2);
  return f;
}

function barMean(v: SessionVerdict): string {
  const total = DESIGN_DIMS.reduce((sum, dim) => {
    const value = v[dim];
    return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  return (total / DESIGN_DIMS.length).toFixed(2);
}

function pairHtml(p: PairRecord): string {
  const col = (
    arm: "ad-lib" | "baked",
    run: { session: SessionResult; verdict: SessionVerdict },
  ) => `
    <div class="col ${arm === "baked" ? "baked" : "adlib"}">
      <div class="colhead">
        <span class="arm">${arm}</span>
        <span class="meta">fitness ${fitness(run.verdict)} · bar ${barMean(run.verdict)} · ended: ${run.session.stopReason}</span>
      </div>
      ${scoreStrip(run.verdict, KEY_DIMS, "Quality and guarded dims")}
      ${scoreStrip(run.verdict, DESIGN_DIMS, "Investigation bar (design)")}
      <div class="diag"><b>Stall:</b> ${esc(run.verdict.stallPoint)}<br/><b>Attribution:</b> ${esc(
        run.verdict.promptAttribution,
      )}<br/><b>Verdict:</b> ${esc(run.verdict.summary)}</div>
      <div class="convo">${turnsHtml(run.session.turns)}</div>
    </div>`;

  return `
  <section class="pair">
    <h3>${esc(p.topic.topic)} <span class="who2">— ${esc(p.profileName)} (${esc(
      p.adLib.session.profile.readingLevel,
    )})</span></h3>
    <details class="baked-meta">
      <summary>What got baked (${(p.bakeMs / 1000).toFixed(0)}s) — "${esc(p.baked.title)}"</summary>
      <div class="bakedbody">
        <p><b>Learning goal (both arms judged against this):</b> ${esc(p.topic.learningGoal)}</p>
        <p><b>Deliverable:</b> ${esc(p.baked.deliverablePrompt ?? "(none)")}</p>
        <p><b>Activity tutor prompt:</b></p>
        <pre>${esc(p.baked.systemPrompt ?? "(none)")}</pre>
        <p><b>Full unit design:</b></p>
        <pre>${esc(JSON.stringify(p.baked.design, null, 2))}</pre>
      </div>
    </details>
    <div class="cols">
      ${col("ad-lib", p.adLib)}
      ${col("baked", p.bakedRun)}
    </div>
  </section>`;
}

function summaryTable(decision: Decision, dims: readonly string[]): string {
  const rows = dims
    .map((d) => {
      const a = decision.adLib.dims[d as keyof typeof decision.adLib.dims];
      const b = decision.baked.dims[d as keyof typeof decision.baked.dims];
      const delta = decision.deltas[d];
      const cls = delta > 0.05 ? "up" : delta < -0.05 ? "down" : "";
      return `<tr><td>${d}</td><td>${a.toFixed(2)}</td><td>${b.toFixed(2)}</td><td class="${cls}">${
        delta >= 0 ? "+" : ""
      }${delta.toFixed(2)}</td></tr>`;
    })
    .join("");
  return `<table class="summary"><thead><tr><th>dim</th><th>ad-lib</th><th>baked</th><th>Δ</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderHtml(
  records: PairRecord[],
  decision: Decision,
  meta: { topics: number; scholarsPerTopic: number; offline: boolean; meanBakeMs: number },
): string {
  const verdict = decision.result.better
    ? "✅ baked wins"
    : "❌ baked does not clear the gate";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Seed→bake: baked vs ad-lib</title>
<style>
  :root { --adlib:#2563eb; --baked:#b45309; }
  body { font:15px/1.5 system-ui, sans-serif; margin:0; color:#1e293b; background:#f8fafc; }
  header { padding:20px 28px; background:#0f172a; color:#e2e8f0; position:sticky; top:0; z-index:5; }
  header h1 { margin:0 0 6px; font-size:20px; }
  header .verdict { font-size:18px; font-weight:700; }
  header .sub { color:#94a3b8; font-size:13px; }
  .wrap { max-width:1280px; margin:0 auto; padding:20px 28px 80px; }
  table.summary { border-collapse:collapse; margin:8px 0 24px; font-size:13px; }
  table.summary th, table.summary td { border:1px solid #e2e8f0; padding:3px 10px; text-align:right; }
  table.summary td:first-child, table.summary th:first-child { text-align:left; }
  td.up { color:#15803d; font-weight:600; } td.down { color:#b91c1c; font-weight:600; }
  section.pair { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:16px 18px; margin:0 0 22px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  section.pair h3 { margin:0 0 10px; font-size:16px; }
  .who2 { color:#64748b; font-weight:400; font-size:14px; }
  details.baked-meta { margin-bottom:14px; font-size:13px; }
  details.baked-meta summary { cursor:pointer; color:#b45309; font-weight:600; }
  .bakedbody { padding:8px 12px; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; margin-top:6px; }
  .bakedbody pre { white-space:pre-wrap; font:12px/1.45 ui-monospace, monospace; background:#fff; border:1px solid #fde68a; border-radius:6px; padding:8px; max-height:280px; overflow:auto; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .col { border:1px solid #e2e8f0; border-radius:8px; padding:10px; min-width:0; }
  .col.adlib { border-top:3px solid var(--adlib); }
  .col.baked { border-top:3px solid var(--baked); }
  .colhead { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px; }
  .colhead .arm { font-weight:700; text-transform:uppercase; font-size:12px; letter-spacing:.04em; }
  .col.adlib .arm { color:var(--adlib); } .col.baked .arm { color:var(--baked); }
  .colhead .meta { font-size:12px; color:#64748b; }
  .scores { display:flex; flex-wrap:wrap; gap:3px; margin-bottom:8px; }
  .scoregroup > b { display:block; color:#64748b; font-size:10.5px; margin-bottom:3px; }
  .sc { font-size:10.5px; padding:1px 5px; border-radius:4px; color:#0f172a; }
  .diag { font-size:12px; color:#475569; background:#f1f5f9; border-radius:6px; padding:7px 9px; margin-bottom:10px; }
  .convo { display:flex; flex-direction:column; gap:8px; }
  .msg { display:flex; flex-direction:column; }
  .msg .who { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:#94a3b8; margin-bottom:2px; }
  .msg.scholar { align-items:flex-end; }
  .bubble { white-space:pre-wrap; max-width:92%; padding:7px 10px; border-radius:10px; font-size:13.5px; }
  .msg.tutor .bubble { background:#eef2ff; }
  .msg.scholar .bubble { background:#ecfdf5; }
  @media (max-width:880px){ .cols{ grid-template-columns:1fr; } }
</style></head>
<body>
<header>
  <h1>Seed→unit bake — baked vs ad-lib, side by side</h1>
  <div class="verdict">${verdict} — ad-lib fitness ${decision.adLib.fitness.toFixed(2)} vs baked ${decision.baked.fitness.toFixed(2)} (${
    decision.result.fitnessGain >= 0 ? "+" : ""
  }${decision.result.fitnessGain.toFixed(2)})</div>
  <div class="sub">${meta.topics} topics × ${meta.scholarsPerTopic} scholars · ${
    records.length
  } pairs · mean bake ${(meta.meanBakeMs / 1000).toFixed(0)}s${
    meta.offline ? " · OFFLINE (stub)" : ""
  } · higher = better, "absence-of" dims (offloading/spoilers/sycophancy) too</div>
</header>
<div class="wrap">
  <h2>Quality and guarded dimensions</h2>
  ${summaryTable(decision, KEY_DIMS)}
  <h2>Investigation bar (design)</h2>
  <p>Measured, not gating · bar mean: ad-lib ${(
    DESIGN_DIMS.reduce((sum, dim) => sum + decision.adLib.dims[dim], 0) /
    DESIGN_DIMS.length
  ).toFixed(2)} → baked ${(
    DESIGN_DIMS.reduce((sum, dim) => sum + decision.baked.dims[dim], 0) /
    DESIGN_DIMS.length
  ).toFixed(2)}</p>
  ${summaryTable(decision, DESIGN_DIMS)}
  ${records.map(pairHtml).join("\n")}
</div>
</body></html>`;
}
