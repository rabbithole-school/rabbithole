/**
 * Judge engine seam for the tutor-quality harness (wave E — the nightly Copilot
 * judge; review/continuous-eval-plan.html §8 "Resolved by Andy").
 *
 * ONE rubric, TWO engines. `judge.ts` owns the rubric text + the tool schemas;
 * this file owns *how the judge is run* and returns a schema-validated object.
 * Both engines force the SAME structured shape (the tool's input_schema), so
 * scores stay comparable regardless of which engine produced them:
 *
 *   - anthropic (default, the fallback): the Anthropic SDK with a forced
 *     tool_choice — pinned to JUDGE_MODEL. This is the existing behaviour.
 *   - copilot: Opus via the GitHub Copilot CLI in headless mode. Routes
 *     judging through a Copilot seat rather than the Anthropic API. Auth
 *     is COPILOT_GITHUB_TOKEN (a fine-grained PAT with the "Copilot Requests"
 *     permission — see `copilot login --help`). The CLI has no tool-forcing API,
 *     so we hand it the rubric + the JSON schema and demand a bare JSON object,
 *     then parse + validate it against the same schema the Anthropic path is
 *     bound to.
 *
 * Pick the engine with JUDGE_ENGINE=anthropic|copilot (default anthropic).
 * Provenance is stamped on every eval output via `judgeProvenance()`:
 *   anthropic  → the JUDGE_MODEL id            (e.g. "claude-opus-4-8")
 *   copilot    → "copilot-cli:<normalised model>" (e.g. "copilot-cli:claude-opus-4-8")
 * so a report never silently conflates a Copilot-engine run with an API run.
 */
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import { JUDGE_MODEL } from "../../../convex/lib/models";

export type JudgeEngineName = "anthropic" | "copilot";

/**
 * The Copilot CLI model slug for the judge. The CLI takes dotted slugs
 * (`--model claude-opus-4.8`, mirroring its `gpt-5.4` examples); override with
 * COPILOT_MODEL. Kept in lock-step with JUDGE_MODEL's Opus id — a deliberate
 * judge bump should move both together and note the drift (see models.ts).
 */
export const COPILOT_JUDGE_CLI_MODEL = process.env.COPILOT_MODEL ?? "claude-opus-4.8";

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
 * is normalised to the dashed id form (`claude-opus-4.8` → `claude-opus-4-8`)
 * so it reads like the Anthropic model ids and matches stored promptVersion/pulse
 * conventions.
 */
export function judgeProvenance(engine: JudgeEngineName = judgeEngineName()): string {
  if (engine === "copilot") {
    return `copilot-cli:${COPILOT_JUDGE_CLI_MODEL.replace(/\./g, "-")}`;
  }
  return JUDGE_MODEL;
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
  const raw =
    engine === "copilot"
      ? runCopilotJudge(opts)
      : await runAnthropicJudge(opts);
  return validateToolInput(raw, opts.tool);
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
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: opts.maxTokens,
    system: opts.system,
    tools: [opts.tool as unknown as Anthropic.Tool],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content: opts.userText }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`judge(anthropic): no tool_use in response for ${opts.tool.name}`);
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
