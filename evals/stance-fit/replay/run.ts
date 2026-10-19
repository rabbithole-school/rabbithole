/**
 * Stance-fit decision-point replay: regenerate ONLY the next tutor turn at each
 * decision point under the CURRENT working-tree `buildSystemPrompt`, then judge
 * that one move with the stance-fit taxonomy.
 *
 *   tsx evals/stance-fit/replay/run.ts --out <stance-fit out dir> --label <name>
 *       [--samples N=2] [--limit K] [--states a,b] [--dry-run]
 *
 * Writes <out>/replay/<label>/generations.json and verdicts.json. Both are
 * resumable: an existing generation is kept when its system-prompt hash still
 * matches, and an existing verdict is kept when it judged the same text.
 * Generation goes through evals/tutor-quality/lib/runTutor.ts (the real
 * buildSystemPromptParts + the shipped tutor model/effort/max_tokens).
 */
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assemblePrompt,
  generateAssistantTurn,
  tokenUsage,
  tutorEffort,
  tutorModel,
} from "../../tutor-quality/lib/runTutor";
import { JUDGE_MODEL, JUDGE_PROMPT_SHA256, buildJudgePrompt, judgeTurn } from "./judge";
import {
  type DecisionPoint,
  type GenerationsFile,
  type Message,
  type SessionData,
  type VerdictsFile,
  buildPrefix,
  dpKey,
  inferOffersWrapUp,
  loadDecisionPoints,
  loadSessions,
} from "./lib";

const CONCURRENCY = 4;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The whole assembled system prompt, in send order, for fingerprinting. */
function promptText(parts: ReturnType<typeof assemblePrompt>): string {
  return [parts.stable, parts.dynamic, parts.documents, parts.turnSystem, parts.turnContext].join("\n\u0000\n");
}

function parseArgs(argv: string[]) {
  const args = {
    out: "",
    label: "",
    samples: 2,
    limit: undefined as number | undefined,
    states: null as Set<string> | null,
    dryRun: false,
  };
  const usage =
    "Usage: tsx evals/stance-fit/replay/run.ts --out DIR --label NAME [--samples N] [--limit K] [--states a,b] [--dry-run]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--out") args.out = value();
    else if (flag === "--label") args.label = value();
    else if (flag === "--samples") args.samples = Number(value());
    else if (flag === "--limit") args.limit = Number(value());
    else if (flag === "--states") args.states = new Set(value().split(",").map((s) => s.trim()));
    else throw new Error(usage);
  }
  if (!args.out || !args.label) throw new Error(usage);
  if (!/^[A-Za-z0-9._-]+$/.test(args.label)) throw new Error("--label must be [A-Za-z0-9._-]");
  if (!Number.isInteger(args.samples) || args.samples < 1) throw new Error("--samples must be a positive integer");
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return args;
}

function git(args: string[]) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Fingerprint of uncommitted prompt-affecting code (tracked diff + untracked files). */
function convexDiffSha(): string | null {
  const diff = git(["diff", "HEAD", "--", "convex/"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "convex/"]).trim();
  const untrackedBodies = untracked
    ? untracked.split("\n").map((f) => `${f}\n${readFileSync(join(REPO_ROOT, f), "utf8")}`).join("\n")
    : "";
  return diff || untrackedBodies ? sha256(diff + untrackedBodies) : null;
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

interface Task {
  dp: DecisionPoint;
  session: SessionData;
  prefix: Message[];
  sample: number;
  key: string;
  systemPromptSha256: string;
  offersWrapUp: boolean;
}

function scholarContext(session: SessionData) {
  // Name is null: fetch.mjs redacts it to "[scholar]" and it only affects the
  // <start> greeting bullet, which a decision point never reaches.
  return { name: null, readingLevel: session.readingLevel };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessions = loadSessions(args.out);
  let dps = loadDecisionPoints(args.out);
  if (args.states) dps = dps.filter((dp) => args.states!.has(dp.state));
  if (args.limit) dps = dps.slice(0, args.limit);

  const runDir = join(args.out, "replay", args.label);
  const gensPath = join(runDir, "generations.json");
  const verdictsPath = join(runDir, "verdicts.json");
  const gitSha = git(["rev-parse", "HEAD"]).trim();
  const convexDiffSha256 = convexDiffSha();

  const gens = readJson<GenerationsFile>(gensPath, {
    label: args.label,
    gitSha,
    convexDiffSha256,
    tutorModel,
    tutorEffort: tutorEffort ?? null,
    usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    generations: {},
  });
  if (gens.gitSha !== gitSha || gens.convexDiffSha256 !== convexDiffSha256 || gens.tutorModel !== tutorModel) {
    throw new Error(
      `${gensPath} was written at ${gens.gitSha.slice(0, 12)} (convex diff ${gens.convexDiffSha256?.slice(0, 12) ?? "clean"}, ${gens.tutorModel}); ` +
        `now ${gitSha.slice(0, 12)} (convex diff ${convexDiffSha256?.slice(0, 12) ?? "clean"}, ${tutorModel}). Use a new --label.`,
    );
  }
  const verdicts = readJson<VerdictsFile>(verdictsPath, {
    label: args.label,
    judgeModel: JUDGE_MODEL,
    judgePromptSha256: JUDGE_PROMPT_SHA256,
    verdicts: {},
  });
  if (verdicts.judgePromptSha256 !== JUDGE_PROMPT_SHA256) {
    throw new Error(`${verdictsPath} was judged with a different judge prompt/model. Use a new --label.`);
  }

  const tasks: Task[] = [];
  const skipped: string[] = [];
  for (const dp of dps) {
    const session = sessions.get(dp.sessionId);
    if (!session) {
      skipped.push(`${dpKey(dp)}: transcript not in data/`);
      continue;
    }
    let prefix: Message[];
    try {
      prefix = buildPrefix(session, dp);
    } catch (error) {
      skipped.push(`${dpKey(dp)}: ${(error as Error).message}`);
      continue;
    }
    const offersWrapUp = inferOffersWrapUp(session);
    const systemPromptSha256 = sha256(promptText(assemblePrompt(scholarContext(session), false, false, undefined, undefined, offersWrapUp)));
    for (let sample = 1; sample <= args.samples; sample++) {
      tasks.push({ dp, session, prefix, sample, key: `${dpKey(dp)}#${sample}`, systemPromptSha256, offersWrapUp });
    }
  }

  const toGenerate = tasks.filter((t) => gens.generations[t.key]?.systemPromptSha256 !== t.systemPromptSha256);
  const pendingJudge = (t: Task) => {
    const g = gens.generations[t.key];
    return !g || g.systemPromptSha256 !== t.systemPromptSha256 || verdicts.verdicts[t.key]?.textSha256 !== g.textSha256;
  };
  const toJudge = tasks.filter(pendingJudge);

  for (const s of skipped) console.warn(`skip ${s}`);
  console.log(
    `label=${args.label} git=${gitSha.slice(0, 12)} convexDiff=${convexDiffSha256?.slice(0, 12) ?? "clean"} ` +
      `tutor=${tutorModel}/${tutorEffort ?? "default"} judge=${JUDGE_MODEL}`,
  );
  console.log(
    `decisionPoints=${dps.length} usable=${new Set(tasks.map((t) => dpKey(t.dp))).size} samples=${args.samples} ` +
      `tasks=${tasks.length} toGenerate=${toGenerate.length} toJudge=${toJudge.length} ` +
      `(≈${toGenerate.length} tutor + ${toJudge.length} judge calls)`,
  );

  if (args.dryRun) {
    const hashes = new Set(tasks.map((t) => t.systemPromptSha256));
    // Stability check: the same inputs must yield the same system prompt, or
    // hashes would churn and every resume would regenerate.
    const t0 = tasks[0];
    if (t0) {
      const again = sha256(promptText(assemblePrompt(scholarContext(t0.session), false, false, undefined, undefined, t0.offersWrapUp)));
      console.log(`systemPrompt distinct hashes=${hashes.size} stableAcrossCalls=${again === t0.systemPromptSha256}`);
      const sample = buildJudgePrompt(t0.session, t0.prefix, "(generated tutor turn)");
      console.log(`example judge prompt chars=${sample.length}, prefix messages=${t0.prefix.length}`);
    }
    for (const t of tasks.filter((x) => x.sample === 1)) {
      console.log(`  ${dpKey(t.dp)} state=${t.dp.state} prefix=${t.prefix.length} wrapUp=${t.offersWrapUp} sys=${t.systemPromptSha256.slice(0, 12)}`);
    }
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required unless --dry-run is set");
  mkdirSync(runDir, { recursive: true });
  const save = () => {
    writeFileSync(gensPath, `${JSON.stringify(gens, null, 2)}\n`);
    writeFileSync(verdictsPath, `${JSON.stringify(verdicts, null, 2)}\n`);
  };
  save();

  const usageBefore = { ...tokenUsage };
  const failures: string[] = [];
  await runPool(toGenerate, async (t) => {
    try {
      const text = await generateAssistantTurn(
        scholarContext(t.session),
        t.prefix.map((m) => ({ role: m.role, content: m.content })),
        undefined,
        undefined,
        t.offersWrapUp,
      );
      gens.generations[t.key] = {
        key: t.key,
        dpKey: dpKey(t.dp),
        sample: t.sample,
        sessionId: t.dp.sessionId,
        scholarIndex: t.dp.scholarIndex,
        state: t.dp.state,
        text,
        textSha256: sha256(text),
        systemPromptSha256: t.systemPromptSha256,
        generatedAt: new Date().toISOString(),
      };
      gens.usage.calls++;
      save();
      console.log(`generated ${t.key} (${text.length} chars)`);
    } catch (error) {
      failures.push(`generate ${t.key}: ${(error as Error).message}`);
    }
  });
  gens.usage.input += tokenUsage.input - usageBefore.input;
  gens.usage.output += tokenUsage.output - usageBefore.output;
  gens.usage.cacheRead += tokenUsage.cacheRead - usageBefore.cacheRead;
  gens.usage.cacheCreate += tokenUsage.cacheCreate - usageBefore.cacheCreate;
  save();

  const anthropic = new Anthropic();
  await runPool(tasks.filter(pendingJudge), async (t) => {
    const g = gens.generations[t.key];
    if (!g) return; // generation failed above
    try {
      const verdict = await judgeTurn(anthropic, buildJudgePrompt(t.session, t.prefix, g.text));
      verdicts.verdicts[t.key] = { ...verdict, key: t.key, dpKey: g.dpKey, textSha256: g.textSha256 };
      save();
      console.log(`judged ${t.key}: state=${verdict.scholarState} move=${verdict.tutorMove} fit=${verdict.stanceFit}`);
    } catch (error) {
      failures.push(`judge ${t.key}: ${(error as Error).message}`);
    }
  });

  console.log(
    `done: generations=${Object.keys(gens.generations).length} verdicts=${Object.keys(verdicts.verdicts).length} ` +
      `tutorTokens(cumulative) in=${gens.usage.input} out=${gens.usage.output} cacheRead=${gens.usage.cacheRead} cacheCreate=${gens.usage.cacheCreate}`,
  );
  if (failures.length) {
    for (const f of failures) console.error(f);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
