/**
 * Judge engine seam for the tutor-quality harness (wave E — the nightly Copilot
 * judge; review/continuous-eval-plan.html §8 "Resolved by Andy").
 *
 * ONE rubric, TWO engines. `judge.ts` owns the rubric text + the tool schemas;
 * this file owns *how the judge is run* and returns a schema-validated object.
 * Both engines force the SAME structured shape (the tool's input_schema), so
 * scores stay comparable regardless of which engine produced them:
 *
 *   - anthropic (default, the fallback): the Anthropic SDK, pinned to
 *     TUTOR_JUDGE_MODEL (Fable 5.1). Fable rejects a forced tool_choice, so
 *     the call uses tool_choice auto plus an instruction to call the tool,
 *     and a reply without the tool call is re-asked like a malformed one.
 *   - copilot: Claude Fable 5.1 via the GitHub Copilot CLI in headless mode. Routes
 *     judging through a Copilot seat rather than the Anthropic API. Auth
 *     is COPILOT_GITHUB_TOKEN (a fine-grained PAT with the "Copilot Requests"
 *     permission — see `copilot login --help`). The CLI has no tool-forcing API,
 *     so we hand it the rubric + the JSON schema and demand a bare JSON object,
 *     then parse + validate it against the same schema the Anthropic path is
 *     bound to.
 *
 * Pick the engine with JUDGE_ENGINE=anthropic|copilot (default anthropic).
 * Provenance is stamped on every eval output via `judgeProvenance()`:
 *   anthropic  → the judge model id            (e.g. "claude-fable-5-1")
 *   copilot    → "copilot-cli:<normalised model>" (e.g. "copilot-cli:claude-fable-5-1")
 * so a report never silently conflates a Copilot-engine run with an API run.
 */
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import { MODELS, TUTOR_JUDGE_MODEL } from "../../../convex/lib/models";

export type JudgeEngineName = "anthropic" | "copilot";

/**
 * The Copilot CLI model slug for the judge. The CLI takes dotted slugs
 * (`--model claude-fable-5.1`); override with JUDGE_MODEL so workflow dispatches
 * can back-test an earlier Copilot judge.
 */
export const COPILOT_JUDGE_CLI_MODEL = process.env.JUDGE_MODEL ?? "claude-fable-5.1";

/**
 * The Anthropic-engine judge. JUDGE_MODEL overrides it too (dotted or dashed —
 * `claude-opus-4.8` and `claude-opus-4-8` both work), e.g. to re-score a
 * reference set with the old judge. assertJudgeNotWeaker still applies.
 */
export function anthropicJudgeModel(): string {
  const raw = process.env.JUDGE_MODEL?.trim();
  return raw ? raw.replace(/\./g, "-") : TUTOR_JUDGE_MODEL;
}

/** Effort for an always-thinking judge (Fable 5.1, Opus 5.5). JUDGE_EFFORT overrides. */
export function judgeEffort(model: string): string | undefined {
  if (process.env.JUDGE_EFFORT) return process.env.JUDGE_EFFORT;
  return ALWAYS_THINKING.has(model) ? "medium" : undefined;
}

const ALWAYS_THINKING = new Set<string>([MODELS.FABLE, MODELS.OPUS_5_5]);

/**
 * Capability order for the "never judge with a weaker model" rule. Higher =
 * stronger. A model missing from this table can't be ranked, so the guard
 * refuses it rather than guessing — add it here when it first shows up.
 */
const MODEL_RANK: Record<string, number> = {
  [MODELS.HAIKU]: 1,
  "claude-haiku-4-5": 1,
  [MODELS.SONNET]: 2,
  [MODELS.OPUS]: 3,
  "claude-opus-5": 4,
  [MODELS.OPUS_5_5]: 5,
  "claude-fable-5": 6,
  [MODELS.FABLE]: 7,
};

/** The judge model id, engine prefix and dotted slugs normalised away. */
export function judgeModelId(engine: JudgeEngineName = judgeEngineName()): string {
  return engine === "copilot"
    ? COPILOT_JUDGE_CLI_MODEL.replace(/\./g, "-")
    : anthropicJudgeModel();
}

/**
 * Throw unless the judge is at least as strong as every model it is grading.
 * A weaker judge can't see what the stronger tutor is doing — and it scored an
 * Opus 5.5 vs Sonnet 5 bake-off as a wash that a blind read called 10-0
 * (TRA-408). Call it wherever the tutor model is known (regenerate mode,
 * pairwise). `asis` mode scores whatever shipped, so it has nothing to check.
 */
export function assertJudgeNotWeaker(
  tutorModels: readonly string[],
  judgeModel: string = judgeModelId(),
): void {
  const canonical = (id: string) => id.trim().replace(/\./g, "-");
  const judge = canonical(judgeModel);
  const judgeRank = MODEL_RANK[judge];
  if (judgeRank === undefined) {
    throw new Error(`judge model "${judge}" has no capability rank — add it to MODEL_RANK in judgeEngine.ts`);
  }
  for (const m of new Set(tutorModels.map(canonical))) {
    const rank = MODEL_RANK[m];
    if (rank === undefined) {
      throw new Error(`tutor model "${m}" has no capability rank — add it to MODEL_RANK in judgeEngine.ts`);
    }
    if (rank > judgeRank) {
      throw new Error(
        `judge "${judge}" is weaker than tutor model "${m}". Never judge with a model weaker ` +
          `than either model being compared — set JUDGE_MODEL to one at least as strong.`,
      );
    }
  }
}

/** Read + validate the selected engine from the environment. */
export function judgeEngineName(): JudgeEngineName {
  const raw = (process.env.JUDGE_ENGINE ?? "anthropic").trim().toLowerCase();
  if (raw === "anthropic" || raw === "copilot") return raw;
  throw new Error(
    `Unknown JUDGE_ENGINE="${raw}" — expected "anthropic" or "copilot".`,
  );
}

/**
 * Provenance string stamped on eval outputs. For the Copilot engine the model
 * is normalised to the dashed id form (`claude-fable-5.1` → `claude-fable-5-1`)
 * so it reads like the Anthropic model ids and matches stored promptVersion/pulse
 * conventions.
 */
export function judgeProvenance(engine: JudgeEngineName = judgeEngineName()): string {
  if (engine === "copilot") return `copilot-cli:${judgeModelId(engine)}`;
  return judgeModelId(engine);
}

// ── The structured-tool contract shared by both engines ──────────────────────

/**
 * The subset of an Anthropic tool definition the seam needs. `judge.ts` defines
 * the two tools `as const`; this shape is intentionally loose (readonly arrays,
 * `unknown` property specs) so those literals assign without a cast.
 */
export interface JudgeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    required: readonly string[];
    properties: Record<string, unknown>;
  };
}

export interface RunJudgeOptions {
  system: string;
  tool: JudgeTool;
  userText: string;
  maxTokens: number;
}

/**
 * Run one structured judgement through the selected engine and return the tool
 * input, validated against `tool.input_schema`. Both engines pass through the
 * same validator so a malformed Copilot response fails loudly (never silently
 * skews a score) exactly where a malformed Anthropic tool call would.
 */
export async function runStructuredJudge(
  opts: RunJudgeOptions,
): Promise<Record<string, unknown>> {
  const engine = judgeEngineName();
  // A judge call is not deterministic: on welfare turns it sometimes writes
  // "null" into an integer-only dimension. Re-ask before failing, so one
  // malformed call no longer aborts the whole run (and every unwritten case).
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const raw =
        engine === "copilot"
          ? runCopilotJudge(opts)
          : await runAnthropicJudge(opts);
      return validateToolInput(raw, opts.tool);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      console.error(`judge: ${(err as Error).message} — retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
    }
  }
}

// ── Anthropic engine (default / fallback) ────────────────────────────────────

let _anthropic: Anthropic | null = null;
async function anthropicClient(): Promise<Anthropic> {
  if (_anthropic) return _anthropic;
  const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
  _anthropic = new AnthropicSdk();
  return _anthropic;
}

async function runAnthropicJudge(
  opts: RunJudgeOptions,
): Promise<Record<string, unknown>> {
  const anthropic = await anthropicClient();
  const model = anthropicJudgeModel();
  // Fable 5.1 and Opus 5.5 always think: forced tool_choice is a 400, and
  // thinking bills against max_tokens, so the cap needs headroom above the
  // verdict's own size. No refusal fallback on purpose — a verdict from a
  // different model than the one stamped in provenance would be a silent swap.
  const thinks = ALWAYS_THINKING.has(model);
  const effort = judgeEffort(model);
  const system = thinks
    ? `${opts.system}\n\nRecord your judgment by calling the ${opts.tool.name} tool exactly once.`
    : opts.system;
  const response = await anthropic.messages.create({
    model,
    max_tokens: thinks ? Math.max(opts.maxTokens, 16000) : opts.maxTokens,
    // The rubric + tool schema is the same on every call of a run (~6k tokens
    // for the per-turn judge), so cache it: tools render before system, and a
    // breakpoint on the system block covers both. Only the case text is new
    // per call. A prefix under the model's cache minimum simply isn't cached.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [opts.tool as unknown as Anthropic.Tool],
    tool_choice: thinks ? { type: "auto" } : { type: "tool", name: opts.tool.name },
    ...(effort ? { output_config: { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
    messages: [{ role: "user", content: opts.userText }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(
      `judge(anthropic): no ${opts.tool.name} call in the response (stop_reason ${response.stop_reason})`,
    );
  }
  return block.input as Record<string, unknown>;
}

// ── Copilot CLI engine (nightly, headless) ───────────────────────────────────

/**
 * Build the single prompt string handed to `copilot -p`. The CLI has no
 * separate system channel, so the rubric, the case, and an explicit
 * output-contract are concatenated. The schema is embedded verbatim so the
 * model targets the exact keys the validator enforces.
 */
export function buildCopilotPrompt(opts: RunJudgeOptions): string {
  const schema = JSON.stringify(
    {
      required: opts.tool.input_schema.required,
      properties: opts.tool.input_schema.properties,
    },
    null,
    2,
  );
  return [
    opts.system,
    "",
    "## Case to judge",
    opts.userText,
    "",
    "## Output contract — read carefully",
    "Respond with EXACTLY ONE JSON object and nothing else: no prose, no",
    "explanation, no markdown code fence. The object MUST contain every key in",
    '"required" below. Integer dimensions are 1–5; a field whose type includes',
    '"null" may be null when the rubric says it does not apply. `notes` /',
    "`topProblems` are the only free-text fields.",
    "",
    "JSON schema:",
    schema,
  ].join("\n");
}

/**
 * The `copilot` argv for a pure, repo-blind judging call:
 *   -p / -s          non-interactive, response-only (script-friendly)
 *   --allow-all-tools required for non-interactive mode (no tools are actually
 *                     used — the judge only emits text)
 *   --no-ask-user    never block waiting on input
 *   --no-custom-instructions  the judge must NOT inherit this repo's CLAUDE.md/
 *                     AGENTS.md — it scores against the frozen rubric alone
 *   --disable-builtin-mcps    no GitHub MCP surface
 *   --no-color / --log-level error   clean stdout to parse
 *   --model          pin the judge model
 */
export function copilotArgs(model = COPILOT_JUDGE_CLI_MODEL): string[] {
  return [
    "-p",
    "__PROMPT__", // placeholder; replaced by the caller with the real prompt
    "-s",
    "--allow-all-tools",
    "--no-ask-user",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--no-color",
    "--log-level",
    "error",
    "--model",
    model,
  ];
}

function runCopilotJudge(opts: RunJudgeOptions): Record<string, unknown> {
  const prompt = buildCopilotPrompt(opts);
  const args = copilotArgs();
  args[1] = prompt; // fill the placeholder with the assembled prompt

  let stdout: string;
  try {
    stdout = execFileSync("copilot", args, {
      // Run OUTSIDE the repo so the judge can't wander the codebase; combined
      // with --no-custom-instructions it sees only our prompt.
      cwd: tmpdir(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      // A hung judge should fail this one call, not block the whole run.
      timeout: Number(process.env.COPILOT_JUDGE_TIMEOUT_MS ?? 180_000),
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });
  } catch (e) {
    const err = e as { status?: number; message?: string; signal?: string };
    throw new Error(
      `judge(copilot): the copilot CLI failed (exit ${err.status ?? "?"}${err.signal ? `, signal ${err.signal}` : ""}). ` +
        `Is it installed and is COPILOT_GITHUB_TOKEN set? ${err.message ?? ""}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = extractJson(stdout);
  } catch (e) {
    throw new Error(
      `judge(copilot): could not extract a JSON object from the CLI output for ` +
        `${opts.tool.name}: ${(e as Error).message}\n--- raw ---\n${stdout.slice(0, 2000)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`judge(copilot): expected a JSON object, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

// ── Pure helpers (unit-tested in judgeEngine.test.ts) ─────────────────────────

/**
 * Extract the first balanced top-level JSON object from arbitrary text. Tolerant
 * of leading log noise and ```json fences — the CLI is chatty and may wrap the
 * object. Strings (incl. escaped quotes) are respected so braces inside text
 * don't confuse the brace counter.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no '{' found in output");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error("no balanced closing '}' found");
}

/**
 * Validate a parsed object against a tool's input_schema: every `required` key
 * present, and each declared property (present or required) matches its type.
 * Supported property types mirror the two tools' schemas: "integer",
 * "string", "array", and the union forms ["integer","null"]. Unknown/other
 * types are accepted (not the judge's job to over-police). Returns the object
 * (unchanged) so callers can `return validateToolInput(...)`.
 */
export function validateToolInput(
  obj: unknown,
  tool: JudgeTool,
): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error(`${tool.name}: expected an object`);
  }
  const rec = obj as Record<string, unknown>;

  for (const key of tool.input_schema.required) {
    if (!(key in rec)) {
      throw new Error(`${tool.name}: missing required field "${key}"`);
    }
  }

  for (const [key, specRaw] of Object.entries(tool.input_schema.properties)) {
    if (!(key in rec)) continue; // optional + absent is fine
    const spec = specRaw as { type?: unknown };
    const types = normaliseTypes(spec.type);
    if (types.length === 0) continue; // no declared type → don't police
    const value = rec[key];
    if (!matchesAnyType(value, types)) {
      throw new Error(
        `${tool.name}: field "${key}" = ${JSON.stringify(value)} does not match type ${JSON.stringify(spec.type)}`,
      );
    }
  }
  return rec;
}

function normaliseTypes(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

function matchesAnyType(value: unknown, types: string[]): boolean {
  return types.some((t) => matchesType(value, t));
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true; // unknown declared type → accept
  }
}
