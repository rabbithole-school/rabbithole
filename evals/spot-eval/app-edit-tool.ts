/**
 * Spot-eval (rung 2, mechanical, no judge): how well the tutor EDITS an app
 * with one code-editing tool versus another, on the same scripted build.
 *
 * Written for the switch from `edit_document` str_replace/insert (with
 * `base_revision`) to Anthropic's built-in text editor tool
 * (`str_replace_based_edit_tool`). Each arm is a whole repo checkout: the
 * harness imports THAT tree's real `makeTutorSessionTools` and
 * `buildTutorSystemPrompt`, so the tool definitions, handlers, result strings
 * and prompt wording are exactly what that revision ships. Only the Convex
 * layer is replaced: an in-memory artifact store answers the handful of
 * queries/mutations the code tools call, with the semantics of
 * `convex/artifacts.ts` (revision check, exactly-one literal match, line
 * insert).
 *
 * Script (the same scholar lines for both arms):
 *   1. build a bunny-clicking game (create_code)
 *   2. two changes (bigger bunny, 30 s timer)
 *   3. three changes; after the FIRST successful edit of this turn the
 *      "scholar" edits the code themselves (a comment at the top, revision+1),
 *      so the next write is stale and must be recovered from
 *   4. one behavioural change
 *   5. before the turn the scholar changes the timer in the code; the request
 *      then edits the same line (the edit must use the fresh code)
 *
 * Run. Each arm is a copy of `convex/ shared/ lib/` whose package.json says
 * `"type": "module"` (the tool factory reaches `@convex-dev/auth/server`,
 * which is import-only) with this checkout's node_modules linked in:
 *   for arm in old new; do mkdir -p $S/$arm; done
 *   git archive <base-sha> convex shared lib tsconfig.json package.json | tar -x -C $S/old
 *   cp -R convex shared lib tsconfig.json package.json $S/new
 *   # in both: set "type": "module" in package.json; ln -s $PWD/node_modules .
 *   npx tsx evals/spot-eval/app-edit-tool.ts --old $S/old --new $S/new \
 *     --runs 3 --out <dir>
 * ANTHROPIC_API_KEY comes from the environment or ~/code/.env.local.
 *
 * Output: <out>/runs.json (every tool call) and <out>/report.md (the table).
 */
import Anthropic from "@anthropic-ai/sdk";
import { getFunctionName } from "convex/server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEvalArgs, runPool } from "../lib/harness";

const args = parseEvalArgs({
  old: { default: "" },
  new: { default: "." },
  runs: { default: 3, parse: Number },
  out: { default: "evals/spot-eval/out/app-edit-tool" },
  model: { default: "claude-opus-5-5" },
  effort: { default: "low" },
  turns: { default: 5, parse: Number },
});

if (!args.old) throw new Error("--old <path to the base checkout> is required");
// Like evals/designer-steer: fall back to the key file the repo docs name.
if (!process.env.ANTHROPIC_API_KEY) {
  const file = join(homedir(), "code/.env.local");
  if (existsSync(file)) {
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((l) => /^(export\s+)?ANTHROPIC_API_KEY=/.test(l));
    if (line) {
      process.env.ANTHROPIC_API_KEY = line
        .replace(/^(export\s+)?ANTHROPIC_API_KEY=/, "")
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
}
const anthropic = new Anthropic();

// ─── the in-memory artifact store (convex/artifacts.ts semantics) ─────────
type Row = {
  _id: string;
  sessionId: string;
  title: string;
  content: string;
  lastEditedBy: "ai" | "scholar";
  type?: "text" | "code";
  language?: string;
  revision: number;
};

class Store {
  rows: Row[] = [];
  private next = 1;
  private messages = 1;

  state(row: Row) {
    return {
      _id: row._id,
      title: row.title,
      content: row.content,
      lastEditedBy: row.lastEditedBy,
      type: row.type,
      language: row.language,
      revision: row.revision,
    };
  }

  apps() {
    return this.rows.filter((row) => row.type === "code");
  }

  /** The scholar typing in the Code view: a write the tutor did not see. */
  scholarEdit(change: (content: string) => string): boolean {
    const app = this.apps().at(-1);
    if (!app) return false;
    const next = change(app.content);
    if (next === app.content) return false;
    app.content = next;
    app.revision += 1;
    app.lastEditedBy = "scholar";
    return true;
  }

  private find(args: { artifactId?: string }) {
    return args.artifactId
      ? this.rows.find((row) => row._id === args.artifactId) ?? null
      : this.rows[0] ?? null;
  }

  private ready(row: Row, baseRevision: number | undefined) {
    return baseRevision === row.revision
      ? null
      : { kind: "conflict" as const, artifact: this.state(row) };
  }

  query(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "artifacts:aiGetContent": {
        if (typeof args.artifactId === "string") {
          const row = this.rows.find((r) => r._id === args.artifactId);
          if (!row) throw new Error("Artifact does not belong to session");
          return this.state(row);
        }
        return this.rows.map((row) => this.state(row));
      }
      case "appAiDirector:directableCharacterForSession":
        return null;
      default:
        throw new Error(`eval store: unsupported query ${name}`);
    }
  }

  mutation(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "artifacts:aiCreate": {
        const id = `app${this.next++}`;
        this.rows.push({
          _id: id,
          sessionId: "eval-session",
          title: String(args.title),
          content: String(args.content),
          lastEditedBy: "ai",
          type: args.type as Row["type"],
          language: args.language as string | undefined,
          revision: 0,
        });
        return id;
      }
      case "artifacts:aiStrReplace": {
        const row = this.find(args as { artifactId?: string });
        if (!row) return { kind: "refused", reason: "missing", error: "Error: No document exists yet. Use create first." };
        const conflict = this.ready(row, args.baseRevision as number | undefined);
        if (conflict) return conflict;
        const oldStr = String(args.oldStr);
        if (!oldStr) return { kind: "refused", reason: "empty", error: "Error: old_str must not be empty." };
        const first = row.content.indexOf(oldStr);
        if (first === -1) {
          return { kind: "refused", reason: "not_found", error: "Error: old_str not found in document. Make sure it matches exactly, including whitespace and line breaks." };
        }
        if (row.content.indexOf(oldStr, first + 1) !== -1) {
          return { kind: "refused", reason: "many", error: "Error: old_str matches multiple places. Re-view the document and provide a unique exact match." };
        }
        row.content = row.content.slice(0, first) + String(args.newStr) + row.content.slice(first + oldStr.length);
        row.revision += 1;
        row.lastEditedBy = "ai";
        return { kind: "success", artifact: this.state(row) };
      }
      case "artifacts:aiInsert": {
        const row = this.find(args as { artifactId?: string });
        if (!row) return { kind: "refused", reason: "missing", error: "Error: No document exists yet. Use create first." };
        const conflict = this.ready(row, args.baseRevision as number | undefined);
        if (conflict) return conflict;
        const lines = row.content.split("\n");
        const at = Math.max(0, Math.min(Number(args.insertLine), lines.length));
        lines.splice(at, 0, String(args.insertText));
        row.content = lines.join("\n");
        row.revision += 1;
        row.lastEditedBy = "ai";
        return { kind: "success", artifact: this.state(row) };
      }
      case "artifacts:aiRename": {
        const row = this.find(args as { artifactId?: string });
        if (!row) return { kind: "refused", reason: "missing", error: "Error: No document exists yet." };
        const conflict = this.ready(row, args.baseRevision as number | undefined);
        if (conflict) return conflict;
        row.title = String(args.title);
        row.revision += 1;
        return { kind: "success", artifact: this.state(row) };
      }
      case "sessionHelpers:splitStream":
        return `message${this.messages++}`;
      default:
        // Every other write (dossier, images, ...) is out of scope here.
        return null;
    }
  }
}

// ─── the script ─────────────────────────────────────────────────────────
type Turn = {
  say: string;
  /** Applied before the turn: the scholar edited the code themselves. */
  before?: (store: Store) => boolean;
  /** Applied right after the turn's first successful write. */
  midTurn?: (store: Store) => boolean;
  /** Did the app end up doing what was asked? (mechanical, approximate) */
  check: (html: string) => boolean;
};

const TURNS: Turn[] = [
  {
    say: "can you make a game where a bunny pops up in random spots and you click it to get points",
    check: (html) => /bunny|🐰|🐇/i.test(html) && /click/i.test(html),
  },
  {
    say: "make the bunny way bigger and add a 30 second timer",
    check: (html) => /\b30\b/.test(html),
  },
  {
    say: "change the score so it says carrots instead of points, make the background a green meadow, and add a reset button",
    midTurn: (store) =>
      store.scholarEdit((html) => `<!-- my bunny game, by me -->\n${html}`),
    check: (html) => /carrot/i.test(html) && /reset/i.test(html) && /green|#[0-9a-f]{3,6}/i.test(html),
  },
  {
    say: "the bunny should go faster every time i catch it",
    check: (html) => /faster|speed|interval|delay/i.test(html),
  },
  {
    say: "change the timer to 20 seconds",
    before: (store) =>
      store.scholarEdit((html) => html.replace(/\b30\b(?!%|px|deg)/, "45")),
    check: (html) => /\b20\b/.test(html) && !/\b45\b(?!%|px|deg)/.test(html),
  },
];

// ─── one arm ────────────────────────────────────────────────────────────
type CallRecord = {
  run: number;
  turn: number;
  tool: string;
  command: string;
  outcome: "ok" | "error";
  errorKind?: string;
  outputTokens: number;
  inputTokens: number;
  text?: string;
};

type TurnRecord = {
  run: number;
  turn: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  checkPassed: boolean;
  midTurnApplied: boolean;
  reply: string;
};

function classifyError(text: string): string {
  if (/conflict|STALE_FILE/i.test(text)) return "stale";
  if (/not found|did not appear verbatim/i.test(text)) return "not_found";
  if (/multiple|more than once/i.test(text)) return "ambiguous";
  if (/READ_REQUIRED/.test(text)) return "read_required";
  if (/scholar's writing/i.test(text)) return "writing_box";
  if (/INVALID_PATH|INVALID_RANGE|INVALID_LINE/.test(text)) return "invalid_input";
  if (/cut off/.test(text)) return "truncated";
  return "other";
}

const CODE_TOOLS = new Set(["create_code", "edit_document", "str_replace_based_edit_tool"]);

async function runArm(repo: string, run: number, label: string) {
  const root = resolve(repo);
  const helpers = await import(pathToFileURL(join(root, "convex/sessionStreamHelpers.ts")).href);
  const factory = await import(pathToFileURL(join(root, "convex/lib/tutorSessionTools.ts")).href);
  const store = new Store();
  const calls: CallRecord[] = [];
  const turns: TurnRecord[] = [];
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (let index = 0; index < Math.min(args.turns, TURNS.length); index++) {
    // A dropped connection mid-turn replays the whole turn from the state
    // before it, so a network blip never leaves half a turn in the store.
    const snapshot = {
      rows: structuredClone(store.rows),
      calls: calls.length,
      history: history.length,
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await runTurn(index);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 4 || !/terminated|ETIMEDOUT|ECONNRESET|ENOTFOUND|overloaded|Connection error|socket/i.test(message + String((error as { cause?: unknown })?.cause ?? ""))) {
          throw error;
        }
        console.log(`  run ${run} turn ${index + 1}: network error (${message.slice(0, 60)}), retrying`);
        store.rows = structuredClone(snapshot.rows);
        calls.length = snapshot.calls;
        history.length = snapshot.history;
      }
    }
  }
  return { calls, turns, finalHtml: store.apps().at(-1)?.content ?? "" };

  async function runTurn(index: number) {
    const turn = TURNS[index];
    turn.before?.(store);
    const artifactData = store.rows.map((row) => ({
      id: row._id,
      title: row.title,
      content: row.content,
      lastEditedBy: row.lastEditedBy,
      type: row.type,
      revision: row.revision,
    }));
    const system: string = helpers.buildTutorSystemPrompt(promptContext(artifactData, index === 0));

    const ctx = {
      runQuery: async (ref: unknown, a: Record<string, unknown>) =>
        store.query(getFunctionName(ref as never), a ?? {}),
      runMutation: async (ref: unknown, a: Record<string, unknown>) =>
        store.mutation(getFunctionName(ref as never), a ?? {}),
      runAction: async () => null,
      storage: {},
      scheduler: { runAfter: async () => null },
    };
    const toolState = {
      assistantMsgId: "message0",
      fullContent: "",
      lastPersistLength: 0,
      completionHadPreToolText: false,
      rubricHadPreToolText: false,
      completionPreToolClosingIsValid: false,
      rubricPreToolClosingIsValid: false,
      suppressCompletionFollowUp: false,
      activityCompletedThisStream: false,
      createdCodeArtifact: false,
    };
    const tools: Array<Record<string, unknown> & { name: string; run: (i: unknown, c?: unknown) => Promise<unknown> }> =
      await factory.makeTutorSessionTools(ctx, () => {}, {
        session: {
          scholarId: "scholar",
          sessionMode: "vibecode",
          artifactData: artifactData.length ? artifactData : null,
          appStateContext: null,
        },
        projId: "eval-session",
        callerUserId: "scholar",
        state: toolState,
        splitAfterTool: async () => {},
        hasProcess: false,
        hasRubric: false,
        activityWasAlreadyComplete: false,
        hasConversationCompletion: false,
        hasActivityResources: false,
        hasPhysicalEnv: false,
        isAngleKickoff: false,
        isOwnIsUnit: false,
        ownIsUnitId: null,
        instructionPlatform: "web",
        chatPracticeOn: false,
        teachBackOn: false,
      });

    let lastUsage = { input: 0, output: 0 };
    let midTurnApplied = false;
    let wroteThisTurn = false;
    const wrapped = tools.map((tool) => ({
      ...tool,
      run: async (input: unknown, context?: unknown) => {
        const command =
          tool.name === "create_code"
            ? "create"
            : String((input as { command?: unknown })?.command ?? "?");
        if (!CODE_TOOLS.has(tool.name)) {
          calls.push({ run, turn: index + 1, tool: tool.name, command, outcome: "error", errorKind: "out_of_scope", outputTokens: lastUsage.output, inputTokens: lastUsage.input });
          return "This tool is not available in this session.";
        }
        let text: string;
        let failed = false;
        try {
          const result = await tool.run(input, context);
          text = typeof result === "string" ? result : JSON.stringify(result);
          // The old tool reported failures as plain result strings.
          failed = /^(Error|Conflict)|not found|matches multiple|requires/i.test(text) && command !== "view";
        } catch (error) {
          text = error instanceof Error ? error.message : String(error);
          failed = true;
          calls.push({ run, turn: index + 1, tool: tool.name, command, outcome: "error", errorKind: classifyError(text), outputTokens: lastUsage.output, inputTokens: lastUsage.input, text: text.slice(0, 300) });
          throw error;
        }
        calls.push({
          run,
          turn: index + 1,
          tool: tool.name,
          command,
          outcome: failed ? "error" : "ok",
          ...(failed ? { errorKind: classifyError(text), text: text.slice(0, 300) } : {}),
          outputTokens: lastUsage.output,
          inputTokens: lastUsage.input,
        });
        const mutating = command === "str_replace" || command === "insert";
        if (!failed && mutating && !wroteThisTurn) {
          wroteThisTurn = true;
          if (turn.midTurn) midTurnApplied = turn.midTurn(store);
        }
        return text;
      },
    }));

    history.push({ role: "user", content: turn.say });
    const runner = anthropic.beta.messages.toolRunner({
      model: args.model,
      max_tokens: 64000,
      system,
      messages: history.map((m) => ({ ...m })),
      tools: wrapped as never,
      stream: true,
      max_iterations: 12,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: { effort: args.effort },
    } as never);

    let apiCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reply = "";
    for await (const stream of runner as AsyncIterable<{ finalMessage: () => Promise<Anthropic.Beta.BetaMessage> }>) {
      const message = await stream.finalMessage();
      apiCalls += 1;
      const input =
        message.usage.input_tokens +
        (message.usage.cache_read_input_tokens ?? 0) +
        (message.usage.cache_creation_input_tokens ?? 0);
      inputTokens += input;
      outputTokens += message.usage.output_tokens;
      lastUsage = { input, output: message.usage.output_tokens };
      for (const block of message.content) {
        if (block.type === "text") reply += block.text;
      }
    }
    history.push({ role: "assistant", content: reply.trim() || "(built it)" });
    const html = store.apps().at(-1)?.content ?? "";
    turns.push({
      run,
      turn: index + 1,
      apiCalls,
      inputTokens,
      outputTokens,
      checkPassed: turn.check(html),
      midTurnApplied,
      reply: reply.trim().slice(0, 600),
    });
    console.log(`  ${label} run ${run} turn ${index + 1}: ${apiCalls} calls, check ${turns.at(-1)!.checkPassed ? "pass" : "FAIL"}`);
  }
}

function promptContext(
  artifactData: Array<Record<string, unknown>>,
  isFirstTurn: boolean,
) {
  return {
    teacherWhisper: null,
    readingLevel: "grade4",
    scholarName: "Eval Scholar",
    sessionMode: "vibecode",
    unitContext: null,
    personaContext: null,
    perspectiveContext: null,
    processContext: null,
    processStateData: null,
    artifactData: artifactData.length ? artifactData : null,
    appStateContext: null,
    dossierContent: null,
    documentNotes: null,
    seeds: [],
    masteryContext: null,
    signalContext: null,
    timingContext: null,
    lessonContext: null,
    teacherDirectives: [],
    goals: [],
    weeklyGoals: [],
    lessonActivityContext: {
      title: "Bunny game",
      description: null,
      kind: "vibecode",
      systemPrompt: "The scholar designs and builds a small game of their own.",
      durationMinutes: null,
      processTitle: null,
      processEmoji: null,
      starterAppId: null,
      appRequest: null,
    },
    activityResourceContext: null,
    priorActivityContext: null,
    gameRoundContexts: null,
    activityContext: null,
    standaloneDeliverableContext: null,
    currentVerdictsContext: null,
    advanceRubricContext: null,
    conversationCompletionContext: null,
    practiceSkillsContext: null,
    isFirstTurn,
    isFirstSession: false,
    lastSessionAt: null,
    sessionCreatedAt: Date.UTC(2026, 9, 14, 18, 0, 0),
    webPracticeContext: null,
    granuleStatusContext: null,
    activityRecipe: null,
    baselineEvidenceContext: null,
    seedOriginContext: null,
    physicalEnvironmentContext: null,
    institutionProfile: undefined,
  };
}

// ─── report ─────────────────────────────────────────────────────────────
function summarize(label: string, results: Array<Awaited<ReturnType<typeof runArm>>>) {
  const calls = results.flatMap((r) => r.calls);
  const turns = results.flatMap((r) => r.turns);
  const edits = calls.filter((c) => c.command === "str_replace" || c.command === "insert");
  const okEdits = edits.filter((c) => c.outcome === "ok");
  const strReplace = edits.filter((c) => c.command === "str_replace");
  const failedStrReplace = strReplace.filter((c) => c.outcome === "error");
  const views = calls.filter((c) => c.command === "view");
  const creates = calls.filter((c) => c.command === "create");
  const errorKinds: Record<string, number> = {};
  for (const c of edits) if (c.outcome === "error") errorKinds[c.errorKind ?? "other"] = (errorKinds[c.errorKind ?? "other"] ?? 0) + 1;
  // Recovery: in the stale turn, did a successful write follow the stale one?
  let staleTurns = 0;
  let recovered = 0;
  for (const r of results) {
    for (const t of r.turns.filter((t) => t.midTurnApplied)) {
      const turnCalls = r.calls.filter((c) => c.turn === t.turn);
      const staleAt = turnCalls.findIndex((c) => c.errorKind === "stale");
      if (staleAt === -1) continue;
      staleTurns += 1;
      if (turnCalls.slice(staleAt + 1).some((c) => (c.command === "str_replace" || c.command === "insert") && c.outcome === "ok")) recovered += 1;
    }
  }
  const midTurn = turns.filter((t) => t.midTurnApplied).length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const editOutput = sum(edits.map((c) => c.outputTokens));
  return {
    label,
    runs: results.length,
    edits: edits.length,
    okEdits: okEdits.length,
    editSuccessRate: edits.length ? okEdits.length / edits.length : NaN,
    strReplace: strReplace.length,
    failedStrReplace: failedStrReplace.length,
    failedStrReplaceRate: strReplace.length ? failedStrReplace.length / strReplace.length : NaN,
    errorKinds,
    views: views.length,
    creates: creates.length,
    outputTokensPerEditCall: edits.length ? editOutput / edits.length : NaN,
    outputTokensPerSuccessfulEdit: okEdits.length ? editOutput / okEdits.length : NaN,
    inputTokensPerTurn: sum(turns.map((t) => t.inputTokens)) / turns.length,
    outputTokensPerTurn: sum(turns.map((t) => t.outputTokens)) / turns.length,
    apiCallsPerTurn: sum(turns.map((t) => t.apiCalls)) / turns.length,
    checksPassed: `${turns.filter((t) => t.checkPassed).length}/${turns.length}`,
    staleInjected: midTurn,
    staleHit: staleTurns,
    staleRecovered: recovered,
  };
}

async function main() {
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  const arms: Record<string, Array<Awaited<ReturnType<typeof runArm>>>> = { old: [], new: [] };
  // Each (arm, run) has its own store and history, so they run side by side.
  const jobs = Array.from({ length: args.runs }, (_, i) => i + 1).flatMap((run) =>
    (["old", "new"] as const).map((label) => ({ label, run })),
  );
  const results = await runPool(
    jobs,
    async ({ label, run }) => {
      console.log(`${label} run ${run}: start`);
      return runArm(label === "old" ? args.old : args.new, run, label);
    },
    { concurrency: 4 },
  );
  jobs.forEach((job, i) => arms[job.label].push(results[i]));
  writeFileSync(join(out, "runs.json"), JSON.stringify(arms, null, 2));
  const rows = [summarize("old: edit_document", arms.old), summarize("new: str_replace_based_edit_tool", arms.new)];
  const fmt = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : typeof v === "object" ? JSON.stringify(v) : String(v));
  const keys = Object.keys(rows[0]).filter((k) => k !== "label");
  const report = [
    `# App-edit tool A/B (${args.model}, effort ${args.effort}, ${args.runs} runs x ${Math.min(args.turns, TURNS.length)} turns)`,
    "",
    `| metric | ${rows.map((r) => r.label).join(" | ")} |`,
    `|---|${rows.map(() => "---").join("|")}|`,
    ...keys.map((k) => `| ${k} | ${rows.map((r) => fmt((r as Record<string, unknown>)[k])).join(" | ")} |`),
    "",
  ].join("\n");
  writeFileSync(join(out, "report.md"), report);
  console.log(report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
