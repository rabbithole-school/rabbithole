/**
 * Workshop Code Explorer eval — Rung 2 (spot-eval-style, NO judge).
 * See .agents/skills/prompt-eval/SKILL.md.
 *
 * Replays scripted, coding-curious scholar turns through the REAL Workshop
 * system prompt (buildMetaSystemPrompt, flag-on) + the Anthropic SDK
 * toolRunner, executing the two Code Explorer tools with the SAME public-fetch
 * helpers the product uses (imported from convex/lib/scholarCodeTools — no
 * forked fetch logic). Every tool call hits the REAL public repo over the
 * network, unauthenticated, exactly like production.
 *
 * This is documentation-by-transcript: run it, read the transcripts, and see
 * whether the tour-guide register holds — translation not dumping, ≤10-line
 * quotes, thinking questions, honest limits, and consent-gated idea capture.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx evals/workshop-code-explorer/run.ts
 *
 * Optional:
 *   --script <path>   Run one script (default: every scripts/*.json)
 *   --out <dir>       Output dir (default: ./out)
 *   --model <id>      Override model (default: MODELS.SONNET, the live tutor)
 *
 * Output (git-ignored): <out>/<scenario>.md + <out>/<scenario>.json. Curate
 * the good ones into ./examples/*.md (those ARE committed).
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { MODELS } from "../../convex/lib/models";
import { parseEvalArgs, writeRunArtifacts } from "../lib/harness";
import { buildMetaSystemPrompt } from "../../convex/metaPrompts";
import {
  makeScholarCodeTools,
  CODE_EXPLORER_MAX_ITERATIONS,
} from "../../convex/lib/scholarCodeTools";

// ─── args ───────────────────────────────────────────────────────────────────
const { script: SCRIPT_ARG, out: OUT_DIR, model: MODEL } = parseEvalArgs({
  script: { default: "", allowOptionLikeValue: true },
  out: { default: "evals/workshop-code-explorer/out", allowOptionLikeValue: true },
  model: { default: MODELS.SONNET, allowOptionLikeValue: true },
});
const SCRIPTS_DIR = resolve(__dirname, "scripts");

// ─── script shape ─────────────────────────────────────────────────────────
interface Script {
  scenario: string;
  firstName: string;
  readingLevel?: string | null;
  todaySessions?: { title: string; activityTitle: string | null }[];
  /** Scholar turns in order. A leading "<start>" fires the day-aware opener. */
  messages: string[];
}

// ─── loose SDK block/message shapes (avoids fighting the beta union types) ──
interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}
interface Msg {
  role: string;
  content: string | Block[];
}

// ─── rendered transcript events ─────────────────────────────────────────────
type Event =
  | { kind: "scholar"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_result"; text: string };

const anthropic = new Anthropic();

/** Mirror http.ts: on an empty thread, the first user turn is "<start>" and a
 * dynamic system block tells the model to open (kept OUT of the cached prompt). */
const START_DYNAMIC =
  'The scholar just opened the Workshop and hasn\'t written anything yet — their first message is the marker "<start>". Deliver your opening line now (per "Reflection" above), and do NOT mention or repeat "<start>".';

function blocks(content: string | Block[]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function truncate(text: string, maxLines = 28, maxChars = 1400): string {
  let out = text;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n") + "\n…(clipped for readability)";
  }
  if (out.length > maxChars) out = out.slice(0, maxChars) + " …(clipped)";
  return out;
}

async function runScript(script: Script): Promise<Event[]> {
  const systemPrompt = buildMetaSystemPrompt({
    firstName: script.firstName,
    readingLevel: script.readingLevel ?? null,
    todaySessions: script.todaySessions ?? [],
    openIdeas: [],
    ideaUpdates: [],
    credits: [],
    codeExplorerEnabled: true, // the eval always exercises the flag-on prompt
  });

  const tools = await makeScholarCodeTools((data) => {
    const tc = (data as { toolComplete?: { name: string; result: string } })
      .toolComplete;
    if (tc) console.error(`   ↳ ${tc.name}(${tc.result})`);
  });

  const events: Event[] = [];
  const history: Msg[] = [];

  for (let i = 0; i < script.messages.length; i++) {
    const scholarMsg = script.messages[i];
    const isStart = scholarMsg === "<start>";
    if (!isStart) events.push({ kind: "scholar", text: scholarMsg });

    history.push({ role: "user", content: scholarMsg });
    const before = history.length;

    // System: static prompt (cached) + the <start> dynamic block on turn 0 only.
    const system =
      isStart && i === 0
        ? [
            { type: "text" as const, text: systemPrompt },
            { type: "text" as const, text: START_DYNAMIC },
          ]
        : systemPrompt;

    console.error(
      `[${script.scenario}] turn ${i + 1}/${script.messages.length}: ${
        isStart ? "<start>" : JSON.stringify(scholarMsg)
      }`,
    );

    const runner = anthropic.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 2048,
      system,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: history as any,
      tools,
      max_iterations: CODE_EXPLORER_MAX_ITERATIONS,
    });
    await runner.runUntilDone();

    const finalMsgs = runner.params.messages as unknown as Msg[];
    // Everything the runner appended this turn: assistant text/tool_use + the
    // user tool_result messages.
    for (const msg of finalMsgs.slice(before)) {
      for (const b of blocks(msg.content)) {
        if (b.type === "text" && b.text?.trim()) {
          events.push({ kind: "assistant", text: b.text });
        } else if (b.type === "tool_use") {
          events.push({ kind: "tool_call", name: b.name ?? "?", input: b.input });
        } else if (b.type === "tool_result") {
          const c = b.content;
          const text = typeof c === "string" ? c : JSON.stringify(c);
          events.push({ kind: "tool_result", text });
        }
      }
    }

    // Carry the full conversation (incl. tool calls/results) into the next turn.
    history.length = 0;
    history.push(...finalMsgs);
  }

  return events;
}

function renderMarkdown(script: Script, events: Event[]): string {
  const lines: string[] = [];
  lines.push(`# Code Explorer transcript — "${script.scenario}"`);
  lines.push("");
  lines.push(`- Scholar: **${script.firstName}** (reading level: ${script.readingLevel ?? "unset"})`);
  lines.push(`- Model: \`${MODEL}\``);
  lines.push(`- Tools: \`list_rabbithole_files\`, \`read_rabbithole_file\`, \`search_rabbithole_code\` (real, unauthenticated public fetch)`);
  lines.push(`- Iteration cap: ${CODE_EXPLORER_MAX_ITERATIONS} per turn`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const e of events) {
    if (e.kind === "scholar") {
      lines.push(`### 🧒 ${script.firstName}`);
      lines.push("");
      lines.push(e.text);
      lines.push("");
    } else if (e.kind === "assistant") {
      lines.push(`**Rabbithole:**`);
      lines.push("");
      lines.push(e.text);
      lines.push("");
    } else if (e.kind === "tool_call") {
      const summary =
        e.input && typeof e.input === "object"
          ? Object.entries(e.input as Record<string, unknown>)
              .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
              .join(", ")
          : "";
      lines.push(`> 🔧 \`${e.name}(${summary})\``);
      lines.push("");
    } else if (e.kind === "tool_result") {
      lines.push(`<details><summary>📄 tool result (clipped)</summary>`);
      lines.push("");
      lines.push("```");
      lines.push(truncate(e.text));
      lines.push("```");
      lines.push("");
      lines.push(`</details>`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function loadScript(path: string): Script {
  return JSON.parse(readFileSync(path, "utf-8")) as Script;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY to run the Code Explorer eval.");
    process.exit(1);
  }
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const paths = SCRIPT_ARG
    ? [SCRIPT_ARG]
    : readdirSync(SCRIPTS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(SCRIPTS_DIR, f));

  for (const p of paths) {
    const script = loadScript(p);
    const events = await runScript(script);
    const stem = script.scenario || basename(p, ".json");
    writeRunArtifacts({
      outDir: OUT_DIR,
      runs: { model: MODEL, script, events },
      report: renderMarkdown(script, events),
      runsFile: `${stem}.json`,
      reportFile: `${stem}.md`,
    });
    console.error(`Wrote ${join(OUT_DIR, `${stem}.md`)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
