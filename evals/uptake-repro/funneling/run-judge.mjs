// Code the follow-up type (focusing / funneling / none) of each exchange.
// Usage: node run-judge.mjs <model> <exchanges.json> <out.jsonl> <prompt.md> [concurrency]
//   e.g. ./fetch-data.sh && node run-judge.mjs claude-opus-5-5 data/sample.json results/claude-opus-5-5.jsonl judge-prompt.md
// exchanges.json: [{id, student, tutor, speaker?}]; `tutor` is the reply being coded,
// labelled `speaker` (default "Tutor"). Resumable: skips ids already in out.jsonl.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const [model, inFile, outFile, promptFile, concArg] = process.argv.slice(2);
const CONC = Number(concArg ?? 8);
const system = fs.readFileSync(promptFile, "utf8");
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    rationale: { type: "string" },
    p_focusing: { type: "integer" },
    p_funneling: { type: "integer" },
    p_none: { type: "integer" },
    follow_up: { type: "string", enum: ["focusing", "funneling", "none"] },
  },
  required: ["rationale", "p_focusing", "p_funneling", "p_none", "follow_up"],
};

const done = new Set(
  fs.existsSync(outFile)
    ? fs.readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id)
    : [],
);
const todo = JSON.parse(fs.readFileSync(inFile, "utf8")).filter((r) => !done.has(r.id));
console.log(`${model}: ${todo.length} to score (${done.size} already done)`);
const client = new Anthropic();
let next = 0, ok = 0, fail = 0;
async function worker() {
  while (next < todo.length) {
    const r = todo[next++];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await client.messages.create({
          model,
          max_tokens: 1024,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          output_config: { format: { type: "json_schema", schema } },
          messages: [{ role: "user", content: `Student: ${r.student}\n${r.speaker ?? "Tutor"}: ${r.tutor}` }],
        });
        const text = res.content.find((b) => b.type === "text").text;
        fs.appendFileSync(outFile, JSON.stringify({ id: r.id, ...JSON.parse(text) }) + "\n");
        ok++;
        break;
      } catch (e) {
        if (attempt === 3) { fail++; console.error(r.id, e.message); }
        else await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
      }
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`${model}: finished, ${ok} ok, ${fail} failed`);
