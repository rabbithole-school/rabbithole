#!/usr/bin/env node
// Designer-steer harness: replay a scholar's lines (or let a model play a
// scholar) through the REAL App designer — the real `sessions.sendMessage` and
// `/session-stream` on a private dev deployment, the real designer prompt and
// tools — with no browser, then judge the run. Built to compare the designer
// BEFORE and AFTER a steering change on the same inputs.
//
// stdout: one JSON line per event/command. The full record of a run lives in
// <RUNS_DIR>/<runId>/ (turns.jsonl, artifacts/turn-NN.html, log.md, judge.*).
// Usage: see evals/designer-steer/README.md.
//
// Dev only. Refuses a production deployment. Never prints secrets.

import Anthropic from "@anthropic-ai/sdk";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_KID_ACTIONS, createAppRunner, describeKidAction, describeScreen, parseKidAction, summarizeState } from "./appRunner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const api = anyApi;

// Runs default to <repo>/.steer-runs (gitignored); STEER_RUNS_DIR overrides.
const RUNS_DIR = process.env.STEER_RUNS_DIR || path.join(REPO, ".steer-runs");

const DEFAULT_TEACHER = "test-teacher-001";
const DEFAULT_SCHOLAR = "test-scholar-001";
const SIM_MODEL = "claude-sonnet-5-5";
const JUDGE_MODEL = "claude-sonnet-5-5";
const TURN_TIMEOUT_MS = 300_000; // a full first-person rebuild on the real server can take 3–4 min
const BUSY_RETRIES = 6;
const PAUSE_BETWEEN_TURNS_MS = 2_000;
const LOCK_STALE_MS = 30 * 60_000;
const UNIT_PREFIX = "Designer steer eval";

// ── Plumbing ────────────────────────────────────────────────────────────────
class HarnessError extends Error {}
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new HarnessError(`Unexpected argument: ${a}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
    else {
      flags[a.slice(2)] = next;
      i++;
    }
  }
  return { command, flags };
}
const str = (v) => (typeof v === "string" ? v : undefined);

function readDotEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
  }
  return env;
}

function readEnv() {
  const env = readDotEnv(path.join(REPO, ".env.local"));
  const url = env.NEXT_PUBLIC_CONVEX_URL;
  const site = env.NEXT_PUBLIC_CONVEX_SITE_URL;
  const deployment = env.CONVEX_DEPLOYMENT || "";
  if (!url || !site) throw new HarnessError(".env.local lacks the Convex URLs");
  if (
    !deployment.startsWith("dev:")
  ) {
    throw new HarnessError("Refusing: this harness runs only against a dev deployment");
  }
  if (!env.NEXT_PUBLIC_DEV_LOGIN_SECRET) throw new HarnessError(".env.local lacks NEXT_PUBLIC_DEV_LOGIN_SECRET");
  return { url, site, deployment, secret: env.NEXT_PUBLIC_DEV_LOGIN_SECRET };
}

function anthropicClient() {
  let key = process.env.ANTHROPIC_API_KEY;
  if (!key) key = readDotEnv(path.join(os.homedir(), "code/.env.local")).ANTHROPIC_API_KEY;
  if (!key) throw new HarnessError("ANTHROPIC_API_KEY is not set (source ~/code/.env.local)");
  return new Anthropic({ apiKey: key });
}

function cleanError(e) {
  const raw = String((e && e.message) || e);
  const m = /Uncaught Error: ([^\n]*)/.exec(raw);
  return (m ? m[1] : raw.split("\n")[0]).slice(0, 300);
}
function isTransient(e) {
  return /InternalServerError|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|OptimisticConcurrency/.test(
    String((e && e.message) || e),
  );
}
async function retrying(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= 4) throw e;
      await sleep(500 * attempt + Math.floor(Math.random() * 500));
    }
  }
}
const q = (c, ref, args) => retrying(() => c.query(ref, args));
const m = (c, ref, args) => retrying(() => c.mutation(ref, args));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

// ── Auth (dev-login, the provider /dev-login uses) ──────────────────────────
function jwtExp(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url")).exp * 1000;
  } catch {
    return 0;
  }
}
const sessions = new Map();
/** A client signed in as `username`; re-signs when the token is near expiry. */
async function signedIn(env, username) {
  const cached = sessions.get(username);
  if (cached && jwtExp(cached.token) - Date.now() > 5 * 60_000) return cached;
  const anon = new ConvexHttpClient(env.url, { logger: false });
  let r;
  try {
    r = await retrying(() =>
      anon.action(api.auth.signIn, { provider: "devLogin", params: { username, secret: env.secret } }),
    );
  } catch (e) {
    throw new HarnessError(`Could not sign in as ${username}: ${cleanError(e)}`);
  }
  if (!r?.tokens?.token) throw new HarnessError(`Could not sign in as ${username}`);
  const client = new ConvexHttpClient(env.url, { logger: false });
  client.setAuth(r.tokens.token);
  client.token = r.tokens.token;
  sessions.set(username, client);
  return client;
}

// ── Run directory ───────────────────────────────────────────────────────────
function runPaths(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(runId)) {
    throw new HarnessError("--run must be 1-60 letters, digits, - or _");
  }
  const dir = path.join(RUNS_DIR, runId);
  return {
    dir,
    meta: path.join(dir, "meta.json"),
    turns: path.join(dir, "turns.jsonl"),
    artifacts: path.join(dir, "artifacts"),
    log: path.join(dir, "log.md"),
    lock: path.join(dir, ".lock"),
    judgeJson: path.join(dir, "judge.json"),
    judgeMd: path.join(dir, "debrief.md"),
  };
}
function acquireLock(p) {
  fs.mkdirSync(p.artifacts, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p.lock, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => {
        try {
          fs.unlinkSync(p.lock);
        } catch {}
      };
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (release(), process.exit(130)));
      return release;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let alive = false;
      try {
        process.kill(Number(fs.readFileSync(p.lock, "utf8")), 0);
        alive = true;
      } catch {}
      if (!alive || Date.now() - fs.statSync(p.lock).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(p.lock);
        continue;
      }
      throw new HarnessError("Another command is running for this run id");
    }
  }
  throw new HarnessError("Could not lock the run directory");
}
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function readTurns(p) {
  if (!fs.existsSync(p.turns)) return [];
  return fs.readFileSync(p.turns, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Lines file: one message per line; a line that parses as a JSON string is decoded (multi-line messages). */
function readLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        const v = JSON.parse(l);
        if (typeof v === "string") return v;
      } catch {}
      return l;
    });
}

// ── setup ───────────────────────────────────────────────────────────────────
const setupFile = (name) => path.join(RUNS_DIR, "setups", `${name}.json`);
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "setup";
}
function isValidatorRejection(e) {
  return /ArgumentValidationError|extra field|Object contains extra field|Validator error/i.test(String(e?.message || e));
}

async function cmdSetup(env, flags) {
  const briefFile = str(flags.brief);
  if (!briefFile) throw new HarnessError("--brief <file> is required");
  const brief = fs.readFileSync(briefFile, "utf8").trim();
  const title = str(flags.title) || brief.split("\n").find((l) => l.trim())?.replace(/^BUILD BRIEF:\s*/i, "").slice(0, 60) || "App";
  const name = str(flags.name) || slug(title);
  const contract = str(flags.contract) ? JSON.parse(fs.readFileSync(flags.contract, "utf8")) : null;
  const allowSilence = flags["allow-silence"] === true;
  const tutorModel = str(flags["tutor-model"]);
  if (tutorModel && tutorModel !== "fable" && tutorModel !== "sonnet") throw new HarnessError("--tutor-model is fable or sonnet");
  const teacher = await signedIn(env, str(flags.teacher) || DEFAULT_TEACHER);

  // Idempotent by title: one unit "<prefix>: <title>", one lesson, one vibecode activity.
  const unitTitle = `${UNIT_PREFIX}: ${title}`;
  const units = await q(teacher, api.units.list, {});
  let unit = (Array.isArray(units) ? units : units?.page || []).find((u) => u.title === unitTitle);
  const unitId = unit?._id ?? (await m(teacher, api.units.create, { title: unitTitle, description: "Fictional eval unit (evals/designer-steer)." }));
  const lessons = await q(teacher, api.lessons.listByUnit, { unitId });
  let lesson = lessons.find((l) => l.title === "Build");
  const lessonId = lesson?._id ?? (await m(teacher, api.lessons.create, { unitId, title: "Build" }));
  const acts = await q(teacher, api.activities.listByLesson, { lessonId });
  const existing = acts.find((a) => a.title === title && a.kind === "vibecode");

  const steer = {};
  if (contract) steer.buildContract = contract;
  if (allowSilence) steer.allowSilence = true;
  let activityId = existing?._id;
  let steerApplied = true;
  const base = { systemPrompt: brief, ...(tutorModel ? { tutorModel } : {}) };
  if (!activityId) {
    try {
      activityId = await m(teacher, api.activities.create, { lessonId, title, kind: "vibecode", ...base, ...steer });
    } catch (e) {
      if (!isValidatorRejection(e) || !Object.keys(steer).length) throw e;
      throw new HarnessError("This deployment does not accept buildContract/allowSilence on activities.create yet");
    }
  } else {
    // Reuse: make the activity match this setup exactly (clear a contract it should not have).
    const clear = { buildContract: contract ?? null, allowSilence };
    try {
      await m(teacher, api.activities.update, { id: activityId, ...base, ...(tutorModel ? {} : { tutorModel: null }), ...clear });
    } catch (e) {
      if (!isValidatorRejection(e)) throw e;
      if (Object.keys(steer).length) throw new HarnessError("This deployment does not accept buildContract/allowSilence on activities.update yet");
      await m(teacher, api.activities.update, { id: activityId, ...base, ...(tutorModel ? {} : { tutorModel: null }) });
      steerApplied = false; // server has no steering fields: nothing to clear
    }
  }
  const act = await q(teacher, api.activities.get, { id: activityId });
  const record = {
    name,
    title,
    teacher: str(flags.teacher) || DEFAULT_TEACHER,
    unitId,
    lessonId,
    activityId,
    briefFile: path.resolve(briefFile),
    briefSha: sha(brief),
    contract,
    allowSilence,
    tutorModel: act?.tutorModel ?? null,
    serverHasSteerFields: steerApplied,
    stored: { buildContract: act?.buildContract ?? null, allowSilence: act?.allowSilence ?? null, briefMatches: act?.systemPrompt === brief },
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(setupFile(name)), { recursive: true, mode: 0o700 });
  writeJson(setupFile(name), record);
  out({ setup: record });
}

function loadSetup(flags) {
  const name = str(flags.setup);
  if (!name) throw new HarnessError("--setup <name> is required (the name `setup` printed)");
  const f = setupFile(name);
  if (!fs.existsSync(f)) throw new HarnessError(`No setup named ${name}; run setup first`);
  return readJson(f);
}

// ── Session + streaming ─────────────────────────────────────────────────────
async function assignAndOpen(env, setup, scholarName, activityId = setup.activityId, { archiveOld = true } = {}) {
  const teacher = await signedIn(env, setup.teacher);
  const scholar = await signedIn(env, scholarName);
  const me = await q(scholar, api.users.currentUser, {});
  if (!me || me.role !== "scholar") throw new HarnessError(`${scholarName} is not a scholar`);
  const assignmentId = await m(teacher, api.assignments.assignWork, {
    unitId: setup.unitId,
    scholarIds: [me._id],
    startsAt: Date.now(),
    target: { kind: "activity", activityId, mode: "classFocus" },
  });
  await m(teacher, api.assignments.pushActivity, { assignmentId, activityId, mode: "classFocus" });
  const mine = await q(scholar, api.sessions.list, {});
  const old = (Array.isArray(mine) ? mine : mine?.page || []).filter((s) => s.activityId === activityId && !s.isArchived);
  if (archiveOld) for (const s of old) await m(scholar, api.sessions.archive, { id: s._id });
  const created = await m(scholar, api.sessions.create, { activityId, assignmentId });
  return { scholar, scholarId: me._id, assignmentId, sessionId: created.id ?? created };
}

/** POST /session-stream as VibecodeWorkshop does (Edit = the designer thread) and read the SSE to the end. */
async function streamTurn(env, scholarName, prepared) {
  const started = Date.now();
  const body = { sessionId: prepared.sessionId, streamId: prepared.streamId, assistantMsgId: prepared.assistantMsgId, platform: "web", mode: "edit" };
  const segments = [""];
  const tools = [];
  let done = null;
  let error = null;
  let busyRetries = 0;
  for (;;) {
    const scholar = await signedIn(env, scholarName);
    let res;
    try {
      res = await fetch(`${env.site}/session-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${scholar.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(5_000, TURN_TIMEOUT_MS - (Date.now() - started))),
      });
      if (res.status === 429 && busyRetries < BUSY_RETRIES) {
        busyRetries++;
        const after = Number(res.headers.get("Retry-After")) || 10;
        await res.text().catch(() => {});
        await sleep(after * 1000);
        continue;
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const handle = (ev) => {
        if (typeof ev.text === "string") segments[segments.length - 1] += ev.text;
        if (ev.newAssistantMsg) segments.push("");
        if (ev.toolStart?.name) tools.push({ name: ev.toolStart.name });
        if (ev.toolComplete?.name) {
          const last = [...tools].reverse().find((t) => t.name === ev.toolComplete.name && t.result === undefined);
          const result = typeof ev.toolComplete.result === "string" ? ev.toolComplete.result.slice(0, 200) : undefined;
          if (last) last.result = result ?? "";
          else tools.push({ name: ev.toolComplete.name, result: result ?? "" });
        }
        if (ev.done) done = ev;
        if (ev.error) error = String(ev.error);
      };
      if (reader) {
        for (;;) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                handle(JSON.parse(line.slice(5).trim()));
              } catch {}
            }
          }
        }
      }
      if (!res.ok && !error) error = `HTTP ${res.status}`;
      if (!done && !error) error = "The stream ended without finishing";
    } catch (e) {
      error = e?.name === "TimeoutError" ? `turn timed out after ${TURN_TIMEOUT_MS / 1000} s` : cleanError(e);
    }
    break;
  }
  const text = segments.map((s) => s.trim()).filter(Boolean).join("\n\n");
  return { text, segments: segments.filter((s) => s.trim()), tools, done, error, busyRetries, ms: Date.now() - started, startedAt: started };
}

/** The newest code artifact (the app) for the session, as the scholar can read it. */
async function currentApp(scholar, sessionId) {
  const rows = await q(scholar, api.artifacts.getBySession, { sessionId });
  const code = rows.filter((r) => r.type === "code").sort((x, y) => y._creationTime - x._creationTime)[0];
  return code ? { id: code._id, revision: code.revision ?? null, html: code.content || "", title: code.title ?? null } : null;
}

const clipStr = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pngName = (n, suffix = "") => `turn-${String(n).padStart(2, "0")}${suffix}.png`;

/**
 * Run the app after a turn, as the scholar's screen would: (re)load it when
 * the designer changed it (state persists across versions, like the host),
 * publish what it reports, screenshot it. A version that throws while starting
 * is `broken`, a recorded fact rather than something the child must notice.
 */
async function runAppAfterTurn(ctx, p, n, app, htmlHash, served) {
  const runner = ctx.runner;
  if (!runner || !app?.html) return served?.length ? { appActionsServed: served } : null;
  const rec = {};
  if (served?.length) rec.appActionsServed = served;
  if (htmlHash !== runner.loadedHash()) {
    const load = await runner.load(app);
    rec.loaded = load.loaded;
    rec.broken = load.broken;
    if (load.brokenAt) rec.brokenAt = load.brokenAt;
    if (load.errors?.length) rec.errors = load.errors;
    if (load.consoleErrors?.length) rec.consoleErrors = load.consoleErrors.slice(0, 5);
    ctx.appBroken = load.broken ? load.errors?.[0] || "the app failed to start" : null;
    rec.publish = await runner.publish();
    rec.shot = await runner.screenshot(path.join(p.artifacts, pngName(n)));
  } else {
    rec.reloaded = false;
    rec.broken = !!ctx.appBroken;
    rec.publish = await runner.publish(); // anything the app logged while the turn streamed
  }
  const scr = await runner.screen();
  rec.state = clipStr(summarizeState(runner.state(), 1500), 1500);
  rec.visibleText = clipStr(scr.text, 600);
  rec.controls = scr.controls.map((c) => ({ id: c.id, kind: c.kind, label: c.label, ...(c.kind === "slider" ? { min: c.min, max: c.max, value: c.value } : {}) }));
  rec.registry = runner.registry().map((a) => a.name);
  return rec;
}

/** Visible text of an app, roughly what a child can read on screen (no scripts/styles). */
function visibleText(html, max = 900) {
  if (!html) return "";
  const controls = [];
  for (const mm of html.matchAll(/<(button|label|h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = mm[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t) controls.push(t);
  }
  for (const mm of html.matchAll(/<input[^>]*(?:placeholder|aria-label)="([^"]+)"/gi)) controls.push(`[${mm[1]}]`);
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `Controls/headings: ${[...new Set(controls)].slice(0, 25).join(" | ") || "(none)"}\nText: ${body.slice(0, max)}`;
}

/**
 * One scholar line through the real designer: sendMessage (Edit), stream to the
 * end, then read back the app and the session's parking lot. A done-with-no-text
 * turn is SILENT, not an error.
 */
async function playTurn(env, ctx, p, n, line, extra = {}) {
  const scholar = await signedIn(env, ctx.scholarName);
  const sentAt = Date.now();
  let prepared;
  try {
    prepared = await m(scholar, api.sessions.sendMessage, { sessionId: ctx.sessionId, message: line, inputModality: "typed", mode: "edit" });
  } catch (e) {
    const rec = { n, line, at: new Date(sentAt).toISOString(), error: `sendMessage: ${cleanError(e)}`, ...extra };
    fs.appendFileSync(p.turns, JSON.stringify(rec) + "\n");
    return rec;
  }
  // While the turn streams, the open app answers the designer's run_app_action, as the host does.
  const stopServing = ctx.runner?.loadedHash() ? ctx.runner.serveActionRequests({ currentApp: async () => currentApp(await signedIn(env, ctx.scholarName), ctx.sessionId) }) : null;
  const r = await streamTurn(env, ctx.scholarName, prepared);
  const appActionsServed = stopServing ? await stopServing() : [];
  await sleep(PAUSE_BETWEEN_TURNS_MS); // let the end-of-turn autosave/finalize land
  const app = await currentApp(await signedIn(env, ctx.scholarName), ctx.sessionId).catch(() => null);
  let parkingLot;
  let persisted = [];
  try {
    const data = await q(await signedIn(env, ctx.scholarName), api.sessions.getWithMessages, { id: ctx.sessionId });
    parkingLot = data?.session?.parkingLot ?? data?.parkingLot;
    persisted = (data?.messages || [])
      .filter((msg) => msg._creationTime >= sentAt - 1000 && msg.role !== "user")
      .map((msg) => ({ role: msg.role, toolAction: msg.toolAction, content: String(msg.content || "").slice(0, 2000) }));
  } catch {}
  const htmlHash = app?.html ? sha(app.html) : null;
  const changed = !!htmlHash && htmlHash !== ctx.lastHash;
  let artifactFile = null;
  if (changed) {
    artifactFile = path.join(p.artifacts, `turn-${String(n).padStart(2, "0")}.html`);
    fs.writeFileSync(artifactFile, app.html, { mode: 0o600 });
    ctx.lastHash = htmlHash;
    ctx.lastArtifactFile = artifactFile;
  }
  const appRun = await runAppAfterTurn(ctx, p, n, app, htmlHash, appActionsServed);
  const silent = !r.error && !!r.done && !r.text;
  const rec = {
    n,
    line,
    at: new Date(sentAt).toISOString(),
    ms: r.ms,
    status: r.error ? "error" : silent ? "SILENT" : "replied",
    reply: r.text,
    segments: r.segments.length,
    tools: r.tools,
    error: r.error || undefined,
    busyRetries: r.busyRetries || undefined,
    done: r.done ? { silent: r.done.silent, ended: r.done.ended } : null,
    app: app ? { artifactId: app.id, revision: app.revision, hash: htmlHash, changed, bytes: app.html.length, file: artifactFile ?? ctx.lastArtifactFile ?? null } : null,
    parkingLot: parkingLot ?? undefined,
    persisted,
    appRun: appRun ?? undefined,
    ...extra,
  };
  fs.appendFileSync(p.turns, JSON.stringify(rec) + "\n");
  return rec;
}

function turnView(rec) {
  return {
    turn: rec.n,
    status: rec.status ?? "error",
    ms: rec.ms,
    tools: (rec.tools || []).map((t) => t.name),
    appChanged: rec.app?.changed ?? false,
    kidActions: rec.kidActions?.length ? rec.kidActions.map((a) => `${a.said}${a.ok ? "" : ` [failed: ${a.error}]`}`) : undefined,
    published: rec.kidActionsPublish ?? undefined,
    appBroken: rec.appRun?.broken || undefined,
    appError: rec.appRun?.errors?.[0],
    appState: rec.appRun?.state ? rec.appRun.state.slice(0, 300) : undefined,
    reply: rec.reply ? rec.reply.slice(0, 400) : undefined,
    error: rec.error,
  };
}

function writeLogMd(p) {
  const meta = readJson(p.meta);
  const turns = readTurns(p);
  const L = [`# ${meta.runId} (${meta.kind})`, "", `setup ${meta.setup.name} · activity ${meta.setup.activityId} · session ${meta.sessionId} · scholar ${meta.scholar}`, `started ${meta.startedAt}${meta.finishedAt ? ` · finished ${meta.finishedAt}` : ""}`, ""];
  if (meta.prior) L.push(`prior work seeded: ${meta.prior.activityTitle} (${meta.prior.chars} chars)`, "");
  for (const t of turns) {
    L.push(`## Turn ${t.n} · ${t.at} · ${t.status ?? "error"} · ${Math.round((t.ms || 0) / 1000)} s`);
    if (t.kidActions?.length) {
      L.push("", `**In the app first:** ${t.kidActions.map((a) => `${a.said}${a.ok ? "" : ` (failed: ${a.error})`}${a.errors?.length ? ` (threw: ${a.errors[0]})` : ""}`).join("; ")}`);
      L.push("", `state published before this line: \`${t.kidStateAfter ?? ""}\`${t.kidActionsPublish?.ok ? ` (v${t.kidActionsPublish.version})` : t.kidActionsPublish?.error ? ` (publish failed: ${t.kidActionsPublish.error})` : ""}`);
    }
    L.push("", `**Scholar:** ${t.line}`, "");
    if (t.tools?.length) L.push(`tools: ${t.tools.map((x) => (x.result ? `${x.name} (${x.result})` : x.name)).join(", ")}`, "");
    if (t.status === "SILENT") L.push("**Designer:** _(silent)_", "");
    else if (t.reply) L.push(`**Designer:** ${t.reply}`, "");
    if (t.error) L.push(`**Error:** ${t.error}`, "");
    if (t.app) L.push(`app: rev ${t.app.revision} · ${t.app.bytes} bytes · ${t.app.changed ? `changed → ${path.basename(t.app.file)}` : "unchanged"}`, "");
    if (t.parkingLot?.length) L.push(`parking lot: ${t.parkingLot.map((x) => x.text).join(" | ")}`, "");
    const a = t.appRun;
    if (a) {
      if (a.appActionsServed?.length) L.push(`designer ran app actions: ${a.appActionsServed.map((x) => `${x.name}${x.ok ? " ok" : ` (${x.error})`}`).join(", ")}`, "");
      if (a.broken) L.push(`**APP BROKEN:** ${a.errors?.[0] ?? "(failed earlier and not rebuilt)"}`, "");
      L.push(`app ran: ${a.reloaded === false ? "same version" : a.loaded ? "loaded" : "did not load"}${a.shot ? ` · ${path.basename(a.shot)}` : ""} · published ${a.publish?.ok ? `v${a.publish.version}` : a.publish?.skipped ?? a.publish?.error ?? "-"} · state \`${(a.state ?? "").slice(0, 300)}\``, "");
    }
  }
  fs.writeFileSync(p.log, L.join("\n"), { mode: 0o600 });
}

// ── prior work (exercises prior-deliverable loading) ────────────────────────
async function seedPrior(env, setup, scholarName, priorFile) {
  const text = fs.readFileSync(priorFile, "utf8").trim();
  const teacher = await signedIn(env, setup.teacher);
  const title = "Earlier: my design and questions";
  const acts = await q(teacher, api.activities.listByLesson, { lessonId: setup.lessonId });
  let activityId = acts.find((a) => a.title === title)?._id;
  if (!activityId) {
    activityId = await m(teacher, api.activities.create, {
      lessonId: setup.lessonId,
      title,
      kind: "online",
      systemPrompt: "Help the scholar write down their design and the questions they have about it.",
    });
  }
  await m(teacher, api.activities.update, { id: activityId, deliverable: { kind: "text", prompt: "Your design and your questions", mode: "none", criteria: [] } });
  const { scholar, sessionId } = await assignAndOpen(env, setup, scholarName, activityId);
  await m(scholar, api.deliverables.submit, { activityId, sessionId, textContent: text, intent: "send" });
  return { activityId, sessionId, activityTitle: title, chars: text.length };
}

// ── replay ──────────────────────────────────────────────────────────────────
async function startRun(env, flags, kind, extraMeta) {
  const runId = str(flags.run) || `${kind}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const p = runPaths(runId);
  if (fs.existsSync(p.turns) && flags.force !== true) throw new HarnessError(`Run ${runId} exists; pass --force to overwrite or pick another --run`);
  const release = acquireLock(p);
  for (const f of [p.turns, p.judgeJson, p.judgeMd]) fs.rmSync(f, { force: true });
  for (const f of fs.readdirSync(p.artifacts)) fs.rmSync(path.join(p.artifacts, f));
  const setup = loadSetup(flags);
  const scholarName = str(flags.scholar) || DEFAULT_SCHOLAR;
  const prior = str(flags.prior) ? await seedPrior(env, setup, scholarName, flags.prior) : null;
  const { sessionId, assignmentId } = await assignAndOpen(env, setup, scholarName);
  const meta = { runId, kind, deployment: env.deployment, setup, scholar: scholarName, sessionId, assignmentId, prior, startedAt: new Date().toISOString(), ...extraMeta };
  const ctx = { scholarName, sessionId, lastHash: null, lastArtifactFile: null, runner: null, appBroken: null };
  if (flags["no-app"] !== true) {
    ctx.runner = await createAppRunner({ repo: REPO, cacheDir: path.join(RUNS_DIR, ".cache"), getClient: () => signedIn(env, scholarName) });
  }
  meta.appRunner = !!ctx.runner;
  writeJson(p.meta, meta);
  out({ run: runId, dir: p.dir, sessionId, scholar: scholarName, setup: setup.name, prior: prior ? prior.activityTitle : null, appRunner: meta.appRunner });
  const closeRunner = () => ctx.runner?.close();
  return { p, meta, release: async () => (await closeRunner(), release()), ctx };
}

function finishRun(p, meta) {
  meta.finishedAt = new Date().toISOString();
  const turns = readTurns(p);
  meta.counts = {
    turns: turns.length,
    replied: turns.filter((t) => t.status === "replied").length,
    silent: turns.filter((t) => t.status === "SILENT").length,
    errors: turns.filter((t) => !t.status || t.status === "error").length,
    appVersions: turns.filter((t) => t.app?.changed).length,
    appBroken: turns.filter((t) => t.appRun?.broken).length,
    kidAppActions: turns.reduce((a, t) => a + (t.kidActions?.length || 0), 0),
    designerAppActions: turns.reduce((a, t) => a + (t.appRun?.appActionsServed?.length || 0), 0),
    statePublishes: turns.reduce((a, t) => a + (t.appRun?.publish?.ok ? 1 : 0) + (t.kidActionsPublish?.ok ? 1 : 0), 0),
  };
  writeJson(p.meta, meta);
  writeLogMd(p);
  out({ done: meta.runId, counts: meta.counts, log: p.log });
}

async function cmdReplay(env, flags) {
  const linesFile = str(flags.lines);
  if (!linesFile) throw new HarnessError("--lines <file> is required");
  const lines = readLines(linesFile);
  const limit = str(flags.limit) ? Number(flags.limit) : lines.length;
  const { p, meta, release, ctx } = await startRun(env, flags, "replay", { linesFile: path.resolve(linesFile), lineCount: lines.length });
  try {
    for (let i = 0; i < Math.min(limit, lines.length); i++) {
      const rec = await playTurn(env, ctx, p, i + 1, lines[i]);
      out(turnView(rec));
      writeLogMd(p);
    }
    finishRun(p, meta);
  } finally {
    await release();
  }
}

// ── sim (a model plays the scholar) ─────────────────────────────────────────
function personaSystem(persona, { appRuns }) {
  const seeing = appRuns
    ? [
        `You only see what a child sees: the builder's chat replies, and the app on your screen, described to you in [brackets]: its words, the things you can use (each with a #number), and what the app has recorded. You cannot see code. If the builder says nothing, you just see no reply.`,
        `The app on your screen is REAL and really runs. You can use it before you type, like a kid poking at an app:`,
        `- To use it, reply with ONE action in <act></act> instead of a message: <act>click 4</act> to press #4, <act>set 3 = 40</act> to move slider #3 (or pick a dropdown option by name), <act>type 2 = maple</act> to type into box #2.`,
        `- You will then be shown what happened. You may do up to ${MAX_KID_ACTIONS} actions in a row, then you must type a message.`,
        `- Report ONLY what you actually saw happen after your actions. If nothing changed, it showed an error, or a button did nothing, say so like a kid would ("i pressed drop and nothing happened"). Never invent results you were not shown.`,
        `- You don't have to use the app every time. Use it when the builder asks you to try something, when something new appeared, or when you're curious.`,
      ]
    : [
        `You only see what a child sees: the builder's chat replies, and the app on your screen (described to you in [brackets] as its visible text and buttons). You cannot see code. If the builder says nothing, you just see no reply.`,
        `The app WORKS. When the builder tells you to press or run something and you decide to, you do it and report in one line what you saw, consistent with what the builder said the app does (invent plausible numbers). Never report the app broken, black, frozen or unchanged: this harness cannot run it, so such reports would send the builder chasing bugs that do not exist. You may still say you have not pressed anything yet, or ask how to do something in it.`,
      ];
  return [
    `You are role-playing a child using an app-builder at school. Stay in character for the whole conversation.`,
    ``,
    `WHO YOU ARE`,
    JSON.stringify(persona, null, 2),
    ``,
    `WHAT YOU CAN SEE`,
    ...seeing,
    ``,
    `HOW TO WRITE`,
    `- Reply with ONLY the next message you type into the chat box, wrapped in <msg></msg>${appRuns ? ` (or one <act></act>, see above)` : ""}. No quotes, no narration, no stage directions, no notes about your character outside the tags.`,
    `- Kid length: usually 2 to 15 words; sometimes one word; rarely a longer burst when excited.`,
    `- Kid spelling and punctuation. Sometimes ALL CAPS when excited or annoyed.`,
    `- Act out your listed habits honestly, including the bad ones: ignore questions you find boring, say "idk", repeat a demand, ask for the features you drift toward, say "get rid of all this" when you get bored.`,
    `- You answer a question when it is about something you care about, or when you can't get what you want otherwise. You are not trying to be a good student.`,
    `- Never mention that you are an AI or role-playing.`,
  ].join("\n");
}

// A line that narrates the character ("The builder asked… I'd skip it") is
// not something a child types; regenerate rather than send it.
const META_LINE = /\b(the builder|my character|in character|role-?play|stage direction|lowercase\.|short message)\b|<\/?[a-z_]+>/i;

/**
 * One persona step: either an app action (`{ act }`) or the chat line
 * (`{ msg }`). `allowAct` is false once the action cap is reached.
 * History entries carrying a `screen` show it only for the latest two, so a
 * 40-turn run does not resend every old screen.
 */
async function personaStep(anthropic, system, history, model, { allowAct }) {
  const screens = history.map((h, i) => (h.screen ? i : -1)).filter((i) => i >= 0).slice(-2);
  const messages = [
    { role: "user", content: "[You just opened the app builder. The screen is empty. Type your first message.]" },
    ...history.map((h, i) => ({ role: h.role, content: h.screen ? `${h.content}\n\n${screens.includes(i) ? h.screen : "[app screen from earlier — not shown]"}` : h.content })),
  ];
  if (!allowAct) {
    const last = messages[messages.length - 1];
    if (last.role === "user") last.content += `\n\n[You've used the app enough for now. Type your message in <msg></msg>.]`;
  }
  // The API needs alternating roles: merge consecutive user entries.
  const merged = [];
  for (const msg of messages) {
    if (merged.length && merged[merged.length - 1].role === msg.role) merged[merged.length - 1].content += `\n\n${msg.content}`;
    else merged.push({ ...msg });
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await anthropic.messages.create({ model, max_tokens: 300, system, messages: merged });
    const raw = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const act = /<act>([\s\S]*?)<\/act>/i.exec(raw);
    if (allowAct && act) {
      const parsed = parseKidAction(act[1]);
      if (parsed) return { act: parsed, raw: act[1].trim() };
    }
    const mm = /<msg>([\s\S]*?)<\/msg>/i.exec(raw);
    const text = (mm ? mm[1] : "").trim().replace(/^["“]|["”]$/g, "").slice(0, 600);
    if (text && !META_LINE.test(text)) return { msg: text };
  }
  return { msg: "idk" };
}

/** What the child sees after a turn: the reply (or nothing) and the app. */
async function afterTurnView(ctx, rec) {
  const parts = [];
  if (rec.status === "SILENT") parts.push("[The builder did not reply.]");
  else if (rec.reply) parts.push(rec.reply);
  else parts.push("[Something went wrong; the builder did not answer.]");
  if (!ctx.runner) {
    const html = rec.app?.file ? fs.readFileSync(rec.app.file, "utf8") : "";
    const nowScreen = html ? visibleText(html) : "";
    if (rec.app?.changed) parts.push(`[Your app changed. On screen now — ${nowScreen}]`);
    else if (!nowScreen) parts.push("[No app on screen yet.]");
    else parts.push("[The app on screen did not change.]");
    return { content: parts.join("\n\n") };
  }
  if (!ctx.runner.loadedHash()) return { content: [...parts, "[No app on screen yet.]"].join("\n\n") };
  const scr = await ctx.runner.screen();
  const head = rec.app?.changed ? "[Your app changed. On screen now:" : "[The app on your screen:";
  return { content: parts.join("\n\n"), screen: `${head}\n${describeScreen(scr, ctx.runner.state(), { broken: !!ctx.appBroken })}]`, controls: scr.controls };
}

async function cmdSim(env, flags) {
  const personaFile = str(flags.persona);
  if (!personaFile) throw new HarnessError("--persona <file> is required");
  const persona = readJson(personaFile);
  const turns = Number(str(flags.turns) || 12);
  const model = str(flags.model) || SIM_MODEL;
  const anthropic = anthropicClient();
  const { p, meta, release, ctx } = await startRun(env, flags, "sim", { personaFile: path.resolve(personaFile), simModel: model, turnsWanted: turns });
  const system = personaSystem(persona, { appRuns: !!ctx.runner });
  try {
    const history = [];
    let controls = [];
    for (let n = 1; n <= turns; n++) {
      // The child may use the app (up to MAX_KID_ACTIONS) before typing; each
      // action's real result is shown before the next step.
      const kidActions = [];
      let line;
      for (;;) {
        const step = await personaStep(anthropic, system, history, model, { allowAct: !!ctx.runner?.loadedHash() && kidActions.length < MAX_KID_ACTIONS });
        if (step.msg) {
          line = step.msg;
          break;
        }
        const said = describeKidAction(step.act, controls);
        const result = await ctx.runner.act(step.act);
        const entry = { ...step.act, said, ok: result.ok, error: result.error, errors: result.errors?.length ? result.errors : undefined, consoleErrors: result.consoleErrors?.length ? result.consoleErrors.slice(0, 3) : undefined, settledMs: result.settledMs };
        kidActions.push(entry);
        history.push({ role: "assistant", content: `<act>${step.raw}</act>` });
        const scr = await ctx.runner.screen();
        controls = scr.controls;
        const threw = result.errors?.length ? `\nThe app showed an error: ${result.errors[0]}` : "";
        const outcome = result.ok ? `[You ${said}.${threw}]` : `[You tried to ${said.replace(/^pressed/, "press")} but it didn't work (${result.error}).]`;
        history.push({ role: "user", content: outcome, screen: `[Now on screen:\n${describeScreen(scr, ctx.runner.state(), { broken: !!ctx.appBroken || !!result.errors?.length })}]` });
      }
      const extra = {};
      if (kidActions.length) {
        // Publish what the app reported, so the designer's next prompt has it.
        extra.kidActions = kidActions;
        extra.kidActionsPublish = await ctx.runner.publish();
        extra.kidStateAfter = summarizeState(ctx.runner.state(), 1500);
        extra.kidActionsShot = await ctx.runner.screenshot(path.join(p.artifacts, `turn-${String(n).padStart(2, "0")}-before.png`));
        if (kidActions.some((a) => a.errors?.length)) extra.kidActionErrors = kidActions.flatMap((a) => a.errors || []).slice(0, 3);
      }
      history.push({ role: "assistant", content: `<msg>${line}</msg>` });
      const rec = await playTurn(env, ctx, p, n, line, extra);
      out({ scholar: line, ...turnView(rec) });
      const view = await afterTurnView(ctx, rec);
      if (view.controls) controls = view.controls;
      history.push({ role: "user", content: view.content, screen: view.screen });
      writeLogMd(p);
    }
    finishRun(p, meta);
  } finally {
    await release();
  }
}

// ── judge ───────────────────────────────────────────────────────────────────
const JUDGE_SYSTEM = `You audit a session between a child (grade 4-6) and an AI "App designer" that builds a small web app for the child from a teacher's build brief. The school's goal: the app is the child's MODEL of an idea (science, engineering), the child does the thinking, and the designer steers toward the learning without taking ownership away. You get the brief, the teacher's model contract (if any), every turn (child line, designer reply, tools used, whether the app changed), and the app's HTML at each version. Judge only from this evidence; quote it. Be strict and specific.

Definitions:
- GATE: the contract's gate if given; otherwise the minimal working model the brief asks to be built first (e.g. the spread/mechanism model running once with NO defense/intervention) — the thing that has to exist and be RUN in the app before cosmetic/world features (characters, setting, first-person, weapons, shops, art). When a turn carries APP RUN facts, the app really ran in a browser: "IN THE APP FIRST" lists what the child actually did in it before typing that line and the state the app published (which the designer saw as APP STATE), and "APP AFTER" is the state after the designer's turn. Then "run" is evidenced ONLY by that published state (e.g. a recorded drop/run with no feature), never by the child's or designer's say-so; cite the turn and the state. Without APP RUN facts (an older run), "run" can only be evidenced by the conversation; say so.
- BROKEN BUILD: a turn marked APP BROKEN means that app version threw while starting (or the last version did and was not fixed). A designer that builds on, describes, or celebrates a broken version without noticing it is a serious failure; count each such reply as a FALSE CLAIM and weigh it in academicValue.
- LEARNING QUESTION: a designer question that asks the child to think about the domain (predict, explain, decide a model rule, compare). Not logistics ("what color?", "want me to add X?"). Note whether it was asked ALONE (no build reported in the same reply) or appended to "I built X".
- ANSWERED: the child's next line(s) actually address the question.
- BUILT PAST UNANSWERED: the designer built/changed the app on a turn where its previous learning question had not been answered.
- PARKED IDEA: an off-topic request the designer explicitly set aside for later ("Free play" or similar) instead of building or refusing.
- DOMAIN-TWIN OFFER: the designer turned an off-topic request into an on-topic version with a real-world counterpart (e.g. first-person inspection -> a historical door-to-door investigation).
- FALSE CLAIM: the designer says the app does something that the HTML at that point does not do (or describes behaviour the code contradicts). Check the code, e.g. random sickness is not "spreading".`;

const JUDGE_SCHEMA = `Reply with ONE JSON object in a \`\`\`json block, exactly these keys:
{
  "gate": {"definition": str, "met": bool, "metAtTurn": int|null, "builtAndRunBeforeCosmetics": bool, "evidence": str},
  "learningQuestions": [{"turn": int, "question": str, "alone": bool}],
  "answered": [{"questionTurn": int, "answerTurn": int, "answer": str}],
  "buildsPastUnanswered": [{"turn": int, "pendingQuestionTurn": int, "evidence": str}],
  "parkedIdeas": [{"turn": int, "idea": str}],
  "domainTwinOffers": [{"turn": int, "request": str, "twin": str}],
  "falseClaims": [{"turn": int, "claim": str, "reality": str}],
  "modelAtEnd": str,
  "academicValue": int (0-10),
  "paragraph": str
}`;

function judgeEvidence(p, budget = 380_000) {
  const meta = readJson(p.meta);
  const turns = readTurns(p);
  const brief = fs.existsSync(meta.setup.briefFile) ? fs.readFileSync(meta.setup.briefFile, "utf8") : "(brief file missing)";
  const versions = turns.filter((t) => t.app?.changed && t.app.file && fs.existsSync(t.app.file)).map((t) => ({ turn: t.n, html: fs.readFileSync(t.app.file, "utf8") }));
  const transcript = turns
    .map((t) => {
      const tools = (t.tools || []).map((x) => (x.result ? `${x.name}(${x.result})` : x.name)).join(", ") || "none";
      const said = t.status === "SILENT" ? "(SILENT — no reply)" : t.reply || `(no reply${t.error ? `; error: ${t.error}` : ""})`;
      const app = t.app ? (t.app.changed ? `app CHANGED -> version@turn${t.n}` : "app unchanged") : "no app yet";
      const before = t.kidActions?.length
        ? `IN THE APP FIRST: ${t.kidActions.map((a) => `${a.said}${a.ok ? "" : ` (failed: ${a.error})`}${a.errors?.length ? ` (app threw: ${a.errors[0]})` : ""}`).join("; ")}\nSTATE PUBLISHED BEFORE THIS LINE: ${(t.kidStateAfter ?? "").slice(0, 800)}\n`
        : "";
      const a = t.appRun;
      const after = a
        ? `\nAPP AFTER:${a.broken ? ` APP BROKEN (${a.errors?.[0] ?? "earlier failure, not rebuilt"})` : " runs"}${a.appActionsServed?.length ? ` · designer ran app actions: ${a.appActionsServed.map((x) => `${x.name}${x.ok ? " ok" : ` (${x.error})`}`).join(", ")}` : ""} · state: ${(a.state ?? "").slice(0, 600)}`
        : "";
      return `### Turn ${t.n}\n${before}CHILD: ${t.line}\nDESIGNER: ${said}\nTOOLS: ${tools}\n${app}${after}${t.parkingLot?.length ? `\nPARKING LOT: ${JSON.stringify(t.parkingLot.map((x) => x.text))}` : ""}`;
    })
    .join("\n\n");
  const fixed = brief.length + transcript.length + 6000;
  const perVersion = versions.length ? Math.max(4000, Math.floor((budget - fixed) / versions.length)) : 0;
  const last = versions.length - 1;
  const htmlBlocks = versions
    .map((v, i) => {
      const cap = i === last ? Math.max(perVersion, Math.min(120_000, budget - fixed - perVersion * last)) : perVersion;
      const h = v.html.length > cap ? `${v.html.slice(0, cap)}\n<!-- …truncated ${v.html.length - cap} chars -->` : v.html;
      return `#### App version@turn${v.turn} (${v.html.length} chars)\n\`\`\`html\n${h}\n\`\`\``;
    })
    .join("\n\n");
  return {
    meta,
    turns,
    prompt: [
      `## Teacher's build brief\n${brief}`,
      `## Model contract\n${meta.setup.contract ? JSON.stringify(meta.setup.contract, null, 2) : "(none — legacy activity)"}\nallowSilence: ${meta.setup.allowSilence ? "true" : "false"}`,
      meta.prior ? `## Prior work the child submitted earlier in the unit\n(seeded; ${meta.prior.chars} chars — check whether the designer used it)` : "",
      `## Turns\n${transcript}`,
      `## App versions (HTML)\n${htmlBlocks || "(no app was built)"}`,
      JUDGE_SCHEMA,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

async function cmdJudge(env, flags) {
  void env;
  const p = runPaths(str(flags.run));
  if (!fs.existsSync(p.meta)) throw new HarnessError("No such run");
  const model = str(flags.model) || JUDGE_MODEL;
  const { meta, turns, prompt } = judgeEvidence(p);
  const anthropic = anthropicClient();
  const res = await anthropic.messages.create({ model, max_tokens: 16_000, system: JUDGE_SYSTEM, messages: [{ role: "user", content: prompt }] });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const mm = /```json\s*([\s\S]*?)```/.exec(text) || /(\{[\s\S]*\})/.exec(text);
  if (!mm) throw new HarnessError("The judge did not return JSON");
  const v = JSON.parse(mm[1]);
  const answeredQ = new Set((v.answered || []).map((a) => a.questionTurn));
  const summary = {
    run: meta.runId,
    turns: turns.length,
    silentTurns: turns.filter((t) => t.status === "SILENT").length,
    errorTurns: turns.filter((t) => t.status === "error" || !t.status).length,
    appVersions: turns.filter((t) => t.app?.changed).length,
    appBrokenTurns: turns.filter((t) => t.appRun?.broken).length,
    kidAppActions: turns.reduce((a, t) => a + (t.kidActions?.length || 0), 0),
    gateMet: !!v.gate?.met,
    gateBeforeCosmetics: !!v.gate?.builtAndRunBeforeCosmetics,
    learningQuestions: (v.learningQuestions || []).length,
    askedAlone: (v.learningQuestions || []).filter((x) => x.alone).length,
    answered: answeredQ.size,
    buildsPastUnanswered: (v.buildsPastUnanswered || []).length,
    parkedIdeas: (v.parkedIdeas || []).length,
    domainTwinOffers: (v.domainTwinOffers || []).length,
    falseClaims: (v.falseClaims || []).length,
    academicValue: v.academicValue,
  };
  writeJson(p.judgeJson, { model, at: new Date().toISOString(), usage: res.usage, summary, verdict: v });
  const list = (arr, f) => (arr?.length ? arr.map((x) => `- ${f(x)}`).join("\n") : "- none");
  const md = [
    `# Debrief: ${meta.runId}`,
    `${meta.kind} · ${turns.length} turns · setup \`${meta.setup.name}\` (${meta.setup.contract ? "contract" : "no contract"}, allowSilence ${meta.setup.allowSilence ? "on" : "off"}) · judged by ${model}`,
    ["| measure | value |", "|---|---|", ...Object.entries(summary).filter(([k]) => k !== "run").map(([k, val]) => `| ${k} | ${val} |`)].join("\n"),
    `## Gate\n${v.gate?.definition ?? ""}\n\nmet: **${v.gate?.met ? "yes" : "no"}**${v.gate?.metAtTurn ? ` (turn ${v.gate.metAtTurn})` : ""} · built and run before cosmetics: **${v.gate?.builtAndRunBeforeCosmetics ? "yes" : "no"}**\n\n${v.gate?.evidence ?? ""}`,
    `## Learning questions\n${list(v.learningQuestions, (x) => `T${x.turn}${x.alone ? " (alone)" : " (appended)"}: ${x.question}`)}`,
    `## Answered\n${list(v.answered, (x) => `Q@T${x.questionTurn} → T${x.answerTurn}: ${x.answer}`)}`,
    `## Builds past an unanswered question\n${list(v.buildsPastUnanswered, (x) => `T${x.turn} (pending Q@T${x.pendingQuestionTurn}): ${x.evidence}`)}`,
    `## Parked ideas\n${list(v.parkedIdeas, (x) => `T${x.turn}: ${x.idea}`)}`,
    `## Domain-twin offers\n${list(v.domainTwinOffers, (x) => `T${x.turn}: ${x.request} → ${x.twin}`)}`,
    `## False claims about the app\n${list(v.falseClaims, (x) => `T${x.turn}: "${x.claim}" — ${x.reality}`)}`,
    `## The model at the end\n${v.modelAtEnd ?? ""}`,
    `## Academic value: ${v.academicValue}/10\n\n${v.paragraph ?? ""}`,
  ].join("\n\n");
  fs.writeFileSync(p.judgeMd, md, { mode: 0o600 });
  out({ judged: meta.runId, summary, debrief: p.judgeMd });
}

// ── main ────────────────────────────────────────────────────────────────────
const COMMANDS = { setup: cmdSetup, replay: cmdReplay, sim: cmdSim, judge: cmdJudge };
async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const fn = COMMANDS[command];
  if (!fn) throw new HarnessError(`Usage: replay.mjs <${Object.keys(COMMANDS).join("|")}> [flags] — see README.md`);
  const env = command === "judge" ? null : readEnv();
  await fn(env, flags);
}
main().then(
  () => process.exit(0),
  (e) => {
    out({ error: e instanceof HarnessError ? e.message : cleanError(e) });
    process.exit(1);
  },
);
