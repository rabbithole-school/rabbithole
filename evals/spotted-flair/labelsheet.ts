import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { HANKEN_GROTESK_WOFF2_DATA_URI } from "../../shared/hankenGroteskFontData";
import { blindSheet, resultsSchema } from "./lib";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

function main() {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: "string" },
      seed: { type: "string", default: "spotted-flair-v1" },
      // "equal" (default) pairs each award with one control; "all" or a number
      // shows more of the moments the observer passed over.
      controls: { type: "string", default: "equal" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1 || !values.out) {
    throw new Error("Usage: npx tsx evals/spotted-flair/labelsheet.ts results.json --out labelsheet.html [--seed name]");
  }
  const results = resultsSchema.parse(JSON.parse(readFileSync(positionals[0], "utf8")));
  const controls =
    values.controls === "equal" || values.controls === "all"
      ? values.controls
      : Number.parseInt(values.controls, 10);
  if (typeof controls === "number" && (!Number.isInteger(controls) || controls < 0)) {
    throw new Error(`--controls must be "equal", "all" or a non-negative integer, got ${values.controls}`);
  }
  const sheet = blindSheet(results, values.seed, controls);
  const cards = sheet.cards.map((card, index) => {
    const goals = [
      ...card.goals.criteria.map((c) => c.description ? `${c.label}: ${c.description}` : c.label),
      ...(card.goals.mission?.gate ? [card.goals.mission.gate] : []),
      ...(card.goals.mission?.invariants ?? []),
    ];
    return `<article data-card="${card.id}" aria-labelledby="heading-${index}">
      <h2 id="heading-${index}">Moment ${index + 1}</h2>
      <blockquote>${escape(card.excerpt)}</blockquote>
      <details><summary>Listed goals</summary>${goals.length
        ? `<ul>${goals.map((goal) => `<li>${escape(goal)}</li>`).join("")}</ul>`
        : "<p>No listed goals supplied.</p>"}</details>
      <h3>Surrounding conversation</h3>
      <ol class="turns">${card.context.map((turn) => `<li${turn.selected ? ' class="selected"' : ""}>
        <strong>${escape(turn.speaker)}${turn.selected ? " (selected turn)" : ""}</strong>
        <p>${escape(turn.content)}</p></li>`).join("")}</ol>
      <fieldset><legend>Would you have pinned this one?</legend>
      ${(["yes", "no", "unsure"] as const).map((answer) =>
        `<label class="choice"><input type="radio" name="${card.id}" value="${answer}"> ${answer[0].toUpperCase() + answer.slice(1)}</label>`).join("")}
      </fieldset>
      <label class="notes">Optional note<textarea data-note="${card.id}" rows="2"></textarea></label>
    </article>`;
  }).join("\n");
  const metadata = JSON.stringify({
    datasetId: sheet.datasetId, sheetId: sheet.sheetId, itemIds: sheet.cards.map((c) => c.id),
  }).replace(/</g, "\\u003c");
  writeFileSync(values.out, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Rabbithole moment review</title>
<style>
@font-face{font-family:"Hanken Grotesk";src:url("${HANKEN_GROTESK_WOFF2_DATA_URI}") format("woff2");font-weight:300 700;font-display:swap}
*{box-sizing:border-box}body{margin:0;background:#f7f6fb;color:#242133;font:17px/1.5 "Hanken Grotesk",system-ui,sans-serif}
main{max-width:820px;margin:auto;padding:28px 20px 70px}h1{font-size:2rem;line-height:1.15}h2{font-size:1.35rem}
h3,legend{font-size:1rem;font-weight:700}header p{max-width:65ch}
article{background:white;border:1px solid #dcd7e7;border-radius:12px;padding:24px;margin:24px 0}
blockquote{border-left:4px solid #6b46c1;margin:18px 0;padding:8px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
.turns{list-style:none;padding:0}.turns li{padding:10px;border-left:3px solid transparent}.turns li.selected{border-color:#6b46c1;background:#f7f4ff}
.turns p{margin:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}.turns strong{font-size:.85rem}
fieldset{border:0;padding:10px 0}.choice{display:inline-block;margin-right:22px;padding:8px 0}
textarea,input[type=text]{font:inherit;border:1px solid #8e869f;border-radius:5px;padding:8px;max-width:100%}
textarea{display:block;width:100%;margin-top:5px}.notes{display:block}
button{font:inherit;background:#5934a2;color:white;border:0;border-radius:7px;padding:10px 18px;cursor:pointer}
:focus-visible{outline:3px solid #875cd5;outline-offset:3px}
.toolbar{position:sticky;top:0;background:#f7f6fb;padding:12px 0;border-bottom:1px solid #dcd7e7;z-index:1;display:flex;gap:15px;align-items:center;flex-wrap:wrap}
#error{color:#8f1d29;white-space:pre-wrap}summary{cursor:pointer}#export{font:13px/1.5 ui-monospace,monospace}
@media(max-width:500px){article{padding:16px}main{padding:18px 12px}}
</style></head><body><main>
<header><p>Rabbithole</p><h1>Moment review</h1>
<p>Would you pin this idea for the scholar to keep? Look for an unprompted idea beyond the listed goals, not just a good answer, effort, or polish. Judge the scholar's contribution, not the tutor's explanation. Choose unsure when the context is insufficient.</p>
<p>This private page works offline and sends nothing. Answers are saved in this browser when local storage is available. Export before closing; the page and your browser storage contain transcript text and judgments.</p>
<label>Your name <input id="labeler" type="text" autocomplete="off"></label></header>
<div class="toolbar"><span id="progress" role="status"></span><button id="export-button" type="button">Export answers</button></div>
<p id="error" role="alert"></p>
${cards}
<section aria-labelledby="export-heading"><h2 id="export-heading">Exported answers</h2>
<p>Copy this JSON into a private scratch file and send it to the study coordinator. Partial answers can be exported; use your latest export only.</p>
<textarea id="export" rows="12" readonly aria-label="Exported answers JSON"></textarea></section>
</main><script type="application/json" id="metadata">${metadata}</script>
<script>
"use strict";
const meta = JSON.parse(document.getElementById("metadata").textContent);
const storageKey = "rabbithole-moment-review:" + meta.sheetId;
const nameField = document.getElementById("labeler");
const errorField = document.getElementById("error");
const answers = Object.create(null);
function snapshot() {
  return {version:1,datasetId:meta.datasetId,sheetId:meta.sheetId,labeler:nameField.value.trim(),itemIds:meta.itemIds,answers};
}
function progress() {
  const count = Object.values(answers).filter(a => a.answer).length;
  document.getElementById("progress").textContent = count + " of " + meta.itemIds.length + " answered";
}
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(snapshot())); }
  catch { errorField.textContent = "This browser could not save your answers. Export and copy the JSON before closing."; }
  progress();
}
try {
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    const saved = JSON.parse(stored);
    if (saved.sheetId !== meta.sheetId || typeof saved.labeler !== "string" || !saved.answers || typeof saved.answers !== "object") throw new Error("Invalid saved answers");
    nameField.value = saved.labeler;
    for (const id of meta.itemIds) {
      const answer = saved.answers[id];
      if (!answer) continue;
      if (answer.answer && !["yes","no","unsure"].includes(answer.answer)) throw new Error("Invalid saved choice");
      if (answer.note !== undefined && typeof answer.note !== "string") throw new Error("Invalid saved note");
      answers[id] = answer;
    }
  }
} catch { errorField.textContent = "Saved answers could not be restored. Keep any earlier export; export new answers before closing."; }
for (const article of document.querySelectorAll("[data-card]")) {
  const id = article.dataset.card;
  const note = article.querySelector("textarea");
  note.value = answers[id]?.note || "";
  for (const radio of article.querySelectorAll("input[type=radio]")) {
    radio.checked = radio.value === answers[id]?.answer;
    radio.addEventListener("change", () => { answers[id] = {answer:radio.value,note:note.value}; save(); });
  }
  note.addEventListener("input", () => { answers[id] = {...answers[id],note:note.value}; save(); });
}
nameField.addEventListener("input", save);
document.getElementById("export-button").addEventListener("click", () => {
  if (!nameField.value.trim()) { errorField.textContent = "Enter your name before exporting."; nameField.focus(); return; }
  const data = snapshot();
  data.answers = Object.fromEntries(Object.entries(answers).filter(([, answer]) => answer.answer));
  const output = document.getElementById("export");
  output.value = JSON.stringify(data, null, 2);
  output.focus(); output.select();
});
progress();
</script></body></html>\n`, { mode: 0o600 });
  console.log(`Wrote ${sheet.cards.length} blind cards`);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : "Label sheet failed");
  process.exitCode = 1;
}
