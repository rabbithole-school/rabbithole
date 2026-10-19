// Score uptake exchanges with an LLM judge given the original coding instrument.
// Usage: ./fetch-data.sh && node run-judge.mjs <model> <n> [concurrency]
// Writes results/<model>.jsonl (resumable: skips ids already scored).
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(new URL(import.meta.url).pathname);
const [model, nArg, concArg] = process.argv.slice(2);
const N = Number(nArg ?? 400);
const CONC = Number(concArg ?? 8);

// Minimal RFC 4180 CSV parser (quoted fields may hold commas/newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Deterministic sample: seeded shuffle of the rows that carry an uptake label.
export function sample(n) {
  const all = parseCsv(fs.readFileSync(path.join(here, "data/uptake_data.csv"), "utf8"))
    .filter((r) => r.uptake !== "");
  let s = 20211;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n);
}

const tool = {
  name: "code_exchange",
  description: "Record the codes for this exchange.",
  input_schema: {
    type: "object",
    properties: {
      rationale: { type: "string" },
      student_on_task: { type: "integer", enum: [0, 1] },
      teacher_on_task: { type: "integer", enum: [0, 1] },
      p_low: { type: "integer" },
      p_mid: { type: "integer" },
      p_high: { type: "integer" },
      uptake: { type: "integer", enum: [0, 1, 2] },
    },
    required: ["rationale", "student_on_task", "teacher_on_task", "p_low", "p_mid", "p_high", "uptake"],
  },
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const client = new Anthropic();
  const system = fs.readFileSync(path.join(here, "judge-prompt.md"), "utf8");
  fs.mkdirSync(path.join(here, "results"), { recursive: true });
  const outFile = path.join(here, "results", `${model}.jsonl`);
  const done = new Set(
    fs.existsSync(outFile)
      ? fs.readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id)
      : [],
  );
  const todo = sample(N).filter((r) => !done.has(`${r.obs_id}:${r.exchange_idx}`));
  console.log(`${model}: ${todo.length} to score (${done.size} already done)`);

  let next = 0, ok = 0, fail = 0;
  async function worker() {
    while (next < todo.length) {
      const r = todo[next++];
      const id = `${r.obs_id}:${r.exchange_idx}`;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await client.messages.create({
            model,
            max_tokens: 1024,
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            output_config: { format: { type: "json_schema", schema: { ...tool.input_schema, additionalProperties: false } } },
            messages: [{ role: "user", content: `Student: ${r.student_text}\nTeacher: ${r.teacher_text}` }],
          });
          const text = res.content.find((b) => b.type === "text").text;
          fs.appendFileSync(outFile, JSON.stringify({ id, ...JSON.parse(text), usage: res.usage }) + "\n");
          ok++;
          break;
        } catch (e) {
          if (attempt === 3) { fail++; console.error(id, e.message); }
          else await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
        }
      }
      if ((ok + fail) % 50 === 0) console.log(`${model}: ${ok} ok, ${fail} failed`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`${model}: finished, ${ok} ok, ${fail} failed`);
}
