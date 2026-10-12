/**
 * Spot-eval (rung one, no judge) for the PARENT AIDE's homework answer —
 * the A/B behind the HOMEWORK directive + selected-child line in
 * `convex/lib/parentAidePrompt.ts`, per .agents/skills/prompt-eval/SKILL.md.
 *
 * The defect under test: asked "what homework does my child have tonight?",
 * the aide sent a parent who was standing IN the parent portal off to "the
 * school portal". It holds no assignment data on purpose, so the fix is an
 * EXIT, not a feed — name where the list actually lives (the child's own
 * Rabbithole home screen) and how to reach the teacher (the Messages tab).
 *
 * Branches, same model + same parent turns:
 *   OLD — `buildParentAideSystemPrompt` at the baseline ref (default
 *         `origin/master`), materialized next to its real imports so the
 *         baseline is the actual previous builder, not a reconstruction.
 *   NEW — the builder at HEAD, given the header's selected child.
 *
 * Cases (each an independent single-turn ask, like a parent opening the dock):
 *   1. homework-tonight  — the reported dead end.
 *   2. homework-unnamed  — "did she finish her homework?" — homework AND an
 *      unnamed child, so it reads both halves of the change at once.
 *   3. math-regression   — a non-homework question, to confirm the new
 *      directive doesn't bleed into ordinary answers.
 *
 * Mechanical flags (the eyeball read is what decides; see FINDINGS):
 *   sendsToPortal   — routes the parent to "the portal"/"school portal" (bad)
 *   namesChildScreen— names the child's own screen/"To do tonight" (good)
 *   offersTeacher   — names the Messages tab / messaging the teacher (good)
 *   asksWhichChild  — asks which child they mean (bad when one is selected)
 *   mentionsHomework— any homework talk (case 3: bleed check, want false)
 *
 * TOOLS: the real aide's tools are Convex-ctx-bound (lib/scholarReadTools), so
 * this harness declares STUBS with the same names returning small synthetic
 * fixtures. Enough for the shape of a real answer; not a substitute for the
 * live tool data. Fictional seeded family only (Sloane / Kai / Lani Kahale).
 *
 * Run:
 *   ANTHROPIC_API_KEY=$(npx convex env get ANTHROPIC_API_KEY) \
 *     npx tsx evals/spot-eval/parent-homework.ts
 *
 * Output:
 *   evals/spot-eval/out/parent-homework/runs.json   raw transcripts + flags (gitignored)
 *   evals/spot-eval/out/parent-homework/report.md   side-by-side, eyeball-ready
 *   evals/spot-eval/parent-homework-FINDINGS.md   committed verdicts
 */
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MODELS } from "../../convex/lib/models";
import { buildParentAideSystemPrompt } from "../../convex/lib/parentAidePrompt";

const OUT_DIR = resolve("evals/spot-eval/out/parent-homework");
const PROMPT_SRC = "convex/lib/parentAidePrompt.ts";
const MODEL = MODELS.SONNET;

const argOf = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASELINE = argOf("--baseline", "origin/master");

// The seeded two-child parent (convex/seed/devPersonas.ts) — fictional, so the
// transcripts are safe to paste into a PR.
const PARENT = {
  parentName: "Sloane Kahale",
  childList: "Kai Kahale, Lani Kahale",
  childCount: 2,
};
const SELECTED_CHILD = "Lani Kahale";

const CASES = [
  { id: "homework-tonight", ask: "What homework does my child have tonight?" },
  { id: "homework-unnamed", ask: "Did she finish her homework?" },
  { id: "math-regression", ask: "How is Kai doing in math?" },
] as const;

// ── Stub tools: real names, synthetic tier-1 payloads ──────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_scholar_mastery",
    description:
      "Get a scholar's concept mastery — what they are growing in. Parent-facing, trend altitude.",
    input_schema: {
      type: "object",
      properties: { scholarName: { type: "string" } },
      required: ["scholarName"],
    },
  },
  {
    name: "get_scholar_signals",
    description:
      "Get a scholar's learning signals (curiosity, persistence, collaboration).",
    input_schema: {
      type: "object",
      properties: { scholarName: { type: "string" } },
      required: ["scholarName"],
    },
  },
  {
    name: "get_scholar_seeds",
    description: "Get a scholar's exploration seeds — suggested next topics.",
    input_schema: {
      type: "object",
      properties: { scholarName: { type: "string" } },
      required: ["scholarName"],
    },
  },
  {
    name: "get_scholar_practice",
    description:
      "Get a scholar's practice progress at trend altitude (the due-review backlog is redacted for parents).",
    input_schema: {
      type: "object",
      properties: { scholarName: { type: "string" } },
      required: ["scholarName"],
    },
  },
];

function stubToolResult(name: string, input: unknown): string {
  const who =
    (input as { scholarName?: string })?.scholarName ?? "the scholar";
  switch (name) {
    case "get_scholar_mastery":
      return JSON.stringify({
        scholar: who,
        mastery: [
          { topic: "Multiplication facts", level: "solid", trend: "steady since August" },
          { topic: "Equivalent fractions", level: "growing", trend: "clear gains this quarter" },
          { topic: "Multi-step word problems", level: "emerging", trend: "new this month" },
        ],
      });
    case "get_scholar_signals":
      return JSON.stringify({
        scholar: who,
        signals: [
          { signal: "curiosity", note: "asks follow-up questions unprompted" },
          { signal: "persistence", note: "stays with a hard problem past the first stall" },
        ],
      });
    case "get_scholar_seeds":
      return JSON.stringify({
        scholar: who,
        seeds: [
          { topic: "Tide charts and patterns", status: "approved" },
          { topic: "How bridges hold weight", status: "approved" },
        ],
      });
    case "get_scholar_practice":
      return JSON.stringify({
        scholar: who,
        practice: { subject: "math", frontier: "fractions of a set", trend: "up over the last month" },
      });
    default:
      return JSON.stringify({ error: "unknown tool" });
  }
}

/**
 * The baseline builder: check the file out of `BASELINE` next to its real
 * relative imports, import it, then delete it. Keeps OLD honest (it IS the
 * previous revision) without vendoring a copy of the prompt into this file.
 */
async function loadBaselineBuilder(): Promise<typeof buildParentAideSystemPrompt> {
  const source = execFileSync("git", ["show", `${BASELINE}:${PROMPT_SRC}`], {
    encoding: "utf8",
  });
  const tempPath = resolve("convex/lib/__baselineParentAidePrompt.tmp.ts");
  writeFileSync(tempPath, source);
  try {
    const mod = (await import(pathToFileURL(tempPath).href)) as {
      buildParentAideSystemPrompt: typeof buildParentAideSystemPrompt;
    };
    return mod.buildParentAideSystemPrompt;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

type Flags = {
  sendsToPortal: boolean;
  namesChildScreen: boolean;
  offersTeacher: boolean;
  asksWhichChild: boolean;
  mentionsHomework: boolean;
};

function flag(text: string): Flags {
  // Drop the "…I can't see that here in the portal" phrasings first: naming
  // the portal the parent is standing in is honest, not a redirect. Only a
  // portal offered as somewhere to GO should trip `sendsToPortal`.
  const t = text
    .toLowerCase()
    .replace(/\b(right )?(here )?(in|on|from|within) (the|this) portal\b/g, " ");
  return {
    // The dead end itself: the portal offered as the place to GO look. A
    // reply that merely says this portal doesn't carry homework is fine.
    sendsToPortal:
      /(check|go to|visit|log ?in to|look (at|in|on)|see|find|through)[^.!?]{0,40}\bportal\b/.test(
        t,
      ),
    namesChildScreen:
      /to do tonight/.test(t) ||
      /(their|her|his|kai'?s|lani'?s)\s+(own\s+)?(rabbithole\s+)?(home\s+screen|home page|screen)/.test(t),
    offersTeacher: /messages tab/.test(t) || /message (their|her|his|the) teacher/.test(t),
    asksWhichChild:
      /which (child|one|of them)/.test(t) ||
      /(kai or lani|lani or kai)/.test(t) ||
      /are you asking about/.test(t),
    mentionsHomework: /homework|assignment/.test(t),
  };
}

async function ask(
  anthropic: Anthropic,
  system: string,
  userText: string,
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userText },
  ];
  // Small tool loop — the aide typically makes at most a couple of reads.
  for (let turn = 0; turn < 4; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system,
      tools: TOOLS,
      messages,
    });
    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) {
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    }
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: toolUses.map((use) => ({
        type: "tool_result" as const,
        tool_use_id: use.id,
        content: stubToolResult(use.name, use.input),
      })),
    });
  }
  return "(tool loop did not settle)";
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY required — ANTHROPIC_API_KEY=$(npx convex env get ANTHROPIC_API_KEY) npx tsx evals/spot-eval/parent-homework.ts",
    );
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const buildBaseline = await loadBaselineBuilder();

  const oldSystem = buildBaseline(PARENT);
  const newSystem = buildParentAideSystemPrompt({
    ...PARENT,
    selectedChildName: SELECTED_CHILD,
  });

  const runs = [];
  for (const testCase of CASES) {
    const [oldText, newText] = await Promise.all([
      ask(anthropic, oldSystem, testCase.ask),
      ask(anthropic, newSystem, testCase.ask),
    ]);
    runs.push({
      id: testCase.id,
      ask: testCase.ask,
      old: { text: oldText, flags: flag(oldText) },
      new: { text: newText, flags: flag(newText) },
    });
    console.log(`✓ ${testCase.id}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "runs.json"),
    JSON.stringify({ model: MODEL, baseline: BASELINE, runs }, null, 2),
  );

  const report = [
    `# Parent aide — homework dead end (spot-eval)`,
    ``,
    `Model \`${MODEL}\` · baseline \`${BASELINE}\` · parent: ${PARENT.parentName} (${PARENT.childList}), header selection: ${SELECTED_CHILD}.`,
    ``,
    ...runs.flatMap((run) => [
      `## ${run.id} — "${run.ask}"`,
      ``,
      `| flag | OLD | NEW |`,
      `|---|---|---|`,
      ...(
        Object.keys(run.old.flags) as (keyof Flags)[]
      ).map(
        (key) =>
          `| ${key} | ${run.old.flags[key] ? "yes" : "no"} | ${run.new.flags[key] ? "yes" : "no"} |`,
      ),
      ``,
      `**OLD**`,
      ``,
      run.old.text.replace(/^/gm, "> "),
      ``,
      `**NEW**`,
      ``,
      run.new.text.replace(/^/gm, "> "),
      ``,
    ]),
  ].join("\n");
  writeFileSync(join(OUT_DIR, "report.md"), report);
  console.log(`\nReport: ${join(OUT_DIR, "report.md")}`);
}

void main();
