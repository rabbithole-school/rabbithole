/**
 * Pull a handful of DIVERSE real transcripts from PROD for the observer-redesign
 * spot eval. READ-ONLY, via the `claude-readonly` teacher service account over
 * HTTPS (the sanctioned quality-eval path — see
 * .agents/skills/prod-data-access/SKILL.md). Calls QUERIES ONLY.
 *
 * Run (creds sourced from outside any repo, never printed):
 *   set -a; source ~/.claude/rabbithole-prod.env; set +a
 *   node evals/observer-redesign/fetch-transcripts.mjs
 *
 * Writes evals/observer-redesign/data/transcripts.json (gitignored).
 */
import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = process.env.RABBITHOLE_PROD_URL;
const USER = process.env.RABBITHOLE_PROD_USERNAME;
const PASS = process.env.RABBITHOLE_PROD_PASSWORD;
if (!URL || !USER || !PASS) {
  console.error("Missing RABBITHOLE_PROD_* env. Did you `source ~/.claude/rabbithole-prod.env`?");
  process.exit(1);
}

const TARGET = 8;        // transcripts to keep
const MIN_MESSAGES = 8;  // skip thin sessions
const MAX_FETCH = 16;    // cap prod getWithMessages calls

const c = new ConvexHttpClient(URL);

// Deep-walk listActiveByUnit's nested result; grab every project entry with the
// nearest unitTitle ancestor, so we don't depend on the exact return shape.
function collect(node, unitTitle, out) {
  if (Array.isArray(node)) { for (const x of node) collect(x, unitTitle, out); return; }
  if (node && typeof node === "object") {
    const ut = typeof node.unitTitle === "string" ? node.unitTitle : unitTitle;
    if (node.projectId && node.projectTitle) {
      out.push({ projectId: node.projectId, name: node.name ?? null, projectTitle: node.projectTitle, unitTitle: ut ?? null });
    }
    for (const k of Object.keys(node)) collect(node[k], ut, out);
  }
}

// Round-robin across units for subject diversity.
function diversify(candidates) {
  const byUnit = new Map();
  for (const x of candidates) {
    const k = x.unitTitle ?? "(none)";
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(x);
  }
  const queues = [...byUnit.values()];
  const out = [];
  let any = true;
  while (any) {
    any = false;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); any = true; }
    }
  }
  return out;
}

async function main() {
  const { tokens } = await c.action("auth:signIn", {
    provider: "password",
    params: { email: `${USER}@local`, password: PASS, flow: "signIn" },
  });
  c.setAuth(tokens.token);
  console.error("[fetch] signed in as service account");

  const active = await c.query("projects:listActiveByUnit", {});
  const candidates = [];
  collect(active, null, candidates);
  // dedupe by projectId
  const seen = new Set();
  const unique = candidates.filter((x) => (seen.has(x.projectId) ? false : (seen.add(x.projectId), true)));
  console.error(`[fetch] ${unique.length} candidate projects across ${new Set(unique.map((u) => u.unitTitle)).size} units`);

  const ordered = diversify(unique).slice(0, MAX_FETCH);
  const out = [];
  for (const cand of ordered) {
    if (out.length >= TARGET) break;
    try {
      const data = await c.query("projects:getWithMessages", { id: cand.projectId });
      const transcript = (data.messages ?? [])
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));
      if (transcript.length < MIN_MESSAGES) {
        console.error(`  skip ${cand.projectId.slice(0, 8)} (${transcript.length} msgs)`);
        continue;
      }
      out.push({
        projectId: cand.projectId,
        title: data.project?.title ?? cand.projectTitle,
        scholarName: cand.name,
        unitTitle: cand.unitTitle,
        transcript,
      });
      console.error(`  keep ${cand.projectId.slice(0, 8)} "${cand.projectTitle}" — ${transcript.length} msgs (${cand.unitTitle ?? "no unit"})`);
    } catch (e) {
      console.error(`  err  ${cand.projectId.slice(0, 8)}: ${e instanceof Error ? e.message : e}`);
    }
  }

  out.sort((a, b) => b.transcript.length - a.transcript.length);
  mkdirSync(join(HERE, "data"), { recursive: true });
  writeFileSync(join(HERE, "data", "transcripts.json"), JSON.stringify(out, null, 2));
  console.error(`\n[fetch] wrote ${out.length} transcripts → data/transcripts.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
