import Anthropic from "@anthropic-ai/sdk";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { buildObserverSystemPrompt } from "../../convex/prompts";
import {
  buildObserverRequest, buildObserverUserMessageBlocks, createObserverMessage,
  parseObserverResponse,
} from "../../convex/lib/observerShared";
import { renderCriteriaForRubricCheck } from "../../convex/lib/deliverable";
import { spottedFlairListedGoals } from "../../convex/lib/spottedFlair";
import { OBSERVER_MODEL } from "../../convex/lib/models";
import { evaluateGates, hash, parseSessions, resultsSchema, type Results } from "./lib";

async function main() {
  const { values, positionals } = parseArgs({
    options: { out: { type: "string" }, concurrency: { type: "string", default: "2" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1 || !values.out) {
    throw new Error("Usage: npx tsx evals/spotted-flair/backtest.ts sessions.json --out scratch-dir [--concurrency 2]");
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Concurrency must be an integer from 1 to 8");
  }
  const sessions = parseSessions(JSON.parse(readFileSync(positionals[0], "utf8")));
  const codeHash = hash([
    "./backtest.ts", "./lib.ts", "../../convex/observer.ts",
    "../../convex/lib/observerShared.ts", "../../convex/lib/spottedFlair.ts",
  ].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")));
  const jobs = sessions.map((session) => {
    const request = buildObserverRequest({
      system: [{
        type: "text" as const, text: buildObserverSystemPrompt(),
        cache_control: { type: "ephemeral" as const },
      }],
      userContent: buildObserverUserMessageBlocks(
        session.chatHistory, new Map(), [], [], [], {
          scholarName: "Scholar", scholarId: session.scholarId, title: session.title,
          unitContext: null, spottedFlairOpen: true,
          listedGoals: spottedFlairListedGoals({
            rubric: session.deliverableCriteria
              ? renderCriteriaForRubricCheck(session.deliverableCriteria) : null,
            buildContract: session.buildContract,
          }),
        }, [],
      ),
    });
    return { session, request, inputHash: hash(session), requestHash: hash(request) };
  });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const path = join(out, "results.json");
  const lock = join(out, "backtest.lock");
  // Separate invocations must not overwrite each other's resumable checkpoints.
  const fd = openSync(lock, "wx", 0o600);
  closeSync(fd);
  try {
    const results: Results = existsSync(path)
      ? resultsSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { version: 1, codeHash, model: OBSERVER_MODEL, sessions: [] };
    if (results.codeHash !== codeHash || results.model !== OBSERVER_MODEL) {
      throw new Error("Observer/harness changed; use a new output directory instead of mixing runs");
    }
    const done = new Set<string>();
    for (const result of results.sessions) {
      const job = jobs.find((j) => j.session.id === result.session.id);
      if (done.has(result.session.id) || !job ||
          job.inputHash !== result.inputHash || job.requestHash !== result.requestHash ||
          hash(result.session) !== result.inputHash) {
        throw new Error("Existing results do not match this input/request; use a new output directory");
      }
      done.add(result.session.id);
    }
    const pending = jobs.filter((job) => !done.has(job.session.id));
    console.log(`${done.size} skipped, ${pending.length} pending`);
    if (!pending.length) return;
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is unavailable to this process; no model calls made");
    }
    const client = new Anthropic({ maxRetries: 0 });
    let cursor = 0;
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (!failed) {
        const index = cursor++;
        const job = pending[index];
        if (!job) return;
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
        let stage = "model request";
        try {
          const response = await createObserverMessage(
            () => client.messages.create(job.request),
            (r) => {
              usage.input += r.usage.input_tokens;
              usage.output += r.usage.output_tokens;
              usage.cacheRead += r.usage.cache_read_input_tokens ?? 0;
              usage.cacheWrite += r.usage.cache_creation_input_tokens ?? 0;
              usage.calls++;
            },
          );
          stage = "response parsing";
          const parsed = parseObserverResponse(response.content);
          if (!parsed) throw new Error("No observer tool call");
          const tool = response.content.find((block) => block.type === "tool_use");
          const raw = tool?.type === "tool_use" && tool.input &&
            typeof tool.input === "object" && "spottedFlair" in tool.input
            ? tool.input.spottedFlair : undefined;
          stage = "evidence gates";
          results.sessions.push({
            session: job.session, inputHash: job.inputHash, requestHash: job.requestHash,
            ...evaluateGates(job.session, parsed, raw), usage, completedAt: new Date().toISOString(),
          });
          results.sessions.sort((a, b) => a.session.id.localeCompare(b.session.id));
          stage = "checkpoint write";
          writeFileSync(`${path}.tmp`, JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
          renameSync(`${path}.tmp`, path);
          console.log(`Completed ${results.sessions.length}/${sessions.length}`);
        } catch (error) {
          failed = true;
          // SDK errors can contain request data; keep transcripts/credentials out of logs.
          const detail = error instanceof Anthropic.APIError ? `API status ${error.status ?? "unknown"}`
            : error instanceof Error ? error.name : "Unknown error";
          console.error(`Session ${index + 1} of pending input failed during ${stage} (${detail}); check results.json, rerun to retry`);
        }
      }
    }));
    if (failed) process.exitCode = 1;
  } finally {
    unlinkSync(lock);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Backtest failed");
  process.exitCode = 1;
});
