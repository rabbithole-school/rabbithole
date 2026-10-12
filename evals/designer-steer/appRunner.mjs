// App runner for the designer-steer harness: runs the App designer's app in a
// headless Chromium exactly as the web host does, so the simulated child can
// press its buttons and the designer sees real APP STATE.
//
// Fidelity choices (each mirrors the shipped web host, CodeArtifactViewer +
// hooks/useAppStateIframeBridge.ts):
// - The iframe document is built by the REAL `prepareCustomAppSandbox`
//   (app-kit inlined, CSP meta) with the REAL `injectAppStateSdk` (snapshot SDK,
//   state SDK, rabbithole-app.css brand stylesheet). Both are bundled from the
//   repo at run time with esbuild, never re-implemented here.
// - The iframe is `sandbox="allow-scripts"` with the same CSP attribute.
// - Bridge messages are parsed with the real `parseAppStateBridgeMessage`; the
//   host answers `ready` with `init` carrying the persisted doc, and persists
//   `change` patches/logs and the `actions` registry through the same mutation
//   the web client calls (`appStates.updateSessionState`).
// - A designer `run_app_action` is served while a turn streams: the pending
//   `actionRequest` is delivered as an `update`, and its `actionResult` is
//   acknowledged separately, as the host does.
//
// What it adds that the host does not: uncaught exceptions are recorded (the
// SDK publishes console output only, so they are NOT published as logs), and
// the page's visible text and controls are read out for the persona.

import { anyApi } from "convex/server";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const api = anyApi;
const VIEWPORT = { width: 1180, height: 820 }; // the fleet iPad, landscape
const SETTLE_FIRST_MS = 1_500;
const SETTLE_POLL_MS = 500;
const SETTLE_STABLE_MS = 1_500;
const SETTLE_MAX_MS = 8_000;
const LOAD_SETTLE_MS = 1_200;
export const MAX_KID_ACTIONS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ── Real host code, bundled from the repo ───────────────────────────────────
async function loadHostModules(repo, cacheDir) {
  const { build } = await import("esbuild");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const entry = path.join(cacheDir, "host-entry.mjs");
  const outfile = path.join(cacheDir, "host-bundle.mjs");
  const rel = (p) => path.relative(cacheDir, path.join(repo, p)).split(path.sep).join("/");
  fs.writeFileSync(
    entry,
    [
      `export { prepareCustomAppSandbox } from "${rel("shared/customAppSandbox.ts")}";`,
      `export { requestedAppAssetIds, appAssetRef } from "${rel("shared/appAssets.ts")}";`,
      `export { injectAppStateSdk, parseAppStateBridgeMessage, createAppStateHostMessage, mergeAppStateDoc, appActionRegistryWriteDecision, APP_STATE_MAX_LOG_ENTRIES } from "${rel("lib/appStateBridge.mjs")}";`,
    ].join("\n"),
  );
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    absWorkingDir: repo,
    tsconfig: path.join(repo, "tsconfig.json"),
    logLevel: "error",
  });
  return import(`${outfile}?v=${Date.now()}`);
}

// The parent document: a bare host page holding one sandboxed iframe, and a
// relay that hands every message from the iframe to Node.
const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><script>
addEventListener("message", (e) => { const f = document.querySelector("iframe"); if (f && e.source === f.contentWindow) window.__hostRecv(e.data); });
window.__mount = (srcDoc, csp) => { document.querySelector("iframe")?.remove(); const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts"); f.setAttribute("csp", csp); f.srcdoc = srcDoc; document.body.appendChild(f); };
window.__post = (m) => document.querySelector("iframe")?.contentWindow?.postMessage(m, "*");
</script></body></html>`;

// Runs inside the app frame: the visible text and every control a child could use.
function readScreenInFrame() {
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const labelFor = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && text(l)) return text(l);
    }
    const wrap = el.closest("label");
    if (wrap && text(wrap)) return text(wrap);
    const prev = el.previousElementSibling;
    if (prev && text(prev) && text(prev).length < 60) return text(prev);
    const parentText = el.parentElement ? text(el.parentElement).replace(text(el), "").trim() : "";
    if (parentText && parentText.length < 60) return parentText;
    return el.getAttribute("placeholder") || el.getAttribute("title") || el.name || el.id || "";
  };
  document.querySelectorAll("[data-steer-ctl]").forEach((el) => el.removeAttribute("data-steer-ctl"));
  const controls = [];
  const seen = new Set();
  const add = (el, info) => {
    if (seen.has(el) || !visible(el) || controls.length >= 40) return;
    seen.add(el);
    const id = controls.length + 1;
    el.setAttribute("data-steer-ctl", String(id));
    controls.push({ id, ...info, disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true" || undefined });
  };
  for (const el of document.querySelectorAll("button, [role=button], input, select, textarea, a[href], [onclick]")) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && type === "range") {
      add(el, { kind: "slider", label: clip2(labelFor(el)), min: Number(el.min || 0), max: Number(el.max || 100), step: el.step || "1", value: el.value });
    } else if (tag === "input" && (type === "checkbox" || type === "radio")) {
      add(el, { kind: type, label: clip2(labelFor(el)), checked: el.checked });
    } else if (tag === "input" && (type === "button" || type === "submit")) {
      add(el, { kind: "button", label: clip2(el.value || labelFor(el)) });
    } else if (tag === "input" || tag === "textarea") {
      if (type === "hidden") continue;
      add(el, { kind: "input", inputType: type || tag, label: clip2(labelFor(el)), value: clip2(el.value || "") });
    } else if (tag === "select") {
      add(el, { kind: "select", label: clip2(labelFor(el)), options: [...el.options].slice(0, 12).map((o) => clip2(o.text)), value: el.value });
    } else {
      const t = text(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "";
      if (!t && tag !== "button") continue;
      add(el, { kind: "button", label: clip2(t || "(unlabelled button)") });
    }
  }
  function clip2(s) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > 60 ? `${s.slice(0, 59)}…` : s;
  }
  const canvases = [...document.querySelectorAll("canvas")].filter(visible).length;
  return { text: text(document.body).slice(0, 2500), controls, canvases };
}

// ── The runner ──────────────────────────────────────────────────────────────
/**
 * One headless browser per run. `load(app)` mounts an app version, `act()`
 * performs one child action, `publish()` writes pending state through the real
 * mutation. All facts the harness records come back as plain objects.
 */
export async function createAppRunner({ repo, cacheDir, getClient }) {
  const host = await loadHostModules(repo, cacheDir);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });

  const st = {
    artifactId: null,
    hash: null,
    nonce: null,
    doc: {},
    pendingPatch: {},
    pendingLogs: [],
    pendingActions: undefined,
    registry: [],
    persistedActions: undefined,
    errors: [], // uncaught exceptions since the last drain
    consoleErrors: [],
    actionResults: new Map(),
    servedRequestIds: new Set(),
    readyWaiters: [],
  };

  await page.exposeFunction("__hostRecv", (raw) => onMessage(raw));
  page.on("pageerror", (err) => st.errors.push(clip(String(err?.message || err), 400)));
  page.on("console", (msg) => {
    if (msg.type() === "error") st.consoleErrors.push(clip(msg.text(), 300));
  });
  await page.setContent(HOST_PAGE);

  function onMessage(raw) {
    const msg = host.parseAppStateBridgeMessage(raw);
    if (!msg) return;
    if (msg.type === "ready") {
      if (st.nonce && msg.nonce !== st.nonce) return; // first ready of a load wins
      if (st.nonce === msg.nonce) return;
      st.nonce = msg.nonce;
      void page.evaluate((m) => window.__post(m), host.createAppStateHostMessage("init", st.doc, msg.nonce, null));
      st.readyWaiters.splice(0).forEach((f) => f());
      return;
    }
    if (msg.nonce !== st.nonce) return;
    if (msg.type === "change") {
      if (msg.patch) {
        st.doc = host.mergeAppStateDoc(st.doc, [msg.patch]);
        st.pendingPatch = { ...st.pendingPatch, ...msg.patch };
      }
      if (msg.logs?.length) st.pendingLogs = [...st.pendingLogs, ...msg.logs].slice(-host.APP_STATE_MAX_LOG_ENTRIES);
    } else if (msg.type === "actions") {
      st.registry = msg.actions;
      st.pendingActions = msg.actions;
    } else if (msg.type === "actionResult") {
      st.actionResults.set(msg.requestId, msg);
    }
  }

  async function frame() {
    return page.frames().find((f) => f !== page.mainFrame()) ?? null;
  }

  /** Visible text, controls, and the state doc as the page has it now. */
  async function screen() {
    const f = await frame();
    if (!f) return { text: "", controls: [], canvases: 0 };
    try {
      return await f.evaluate(readScreenInFrame);
    } catch (e) {
      return { text: "", controls: [], canvases: 0, readError: clip(String(e?.message || e), 200) };
    }
  }

  const fingerprint = async () => {
    const s = await screen();
    return JSON.stringify([st.doc, s.text]);
  };
  async function settle({ first = SETTLE_FIRST_MS } = {}) {
    const started = Date.now();
    await sleep(first);
    let last = await fingerprint();
    let stableSince = Date.now();
    while (Date.now() - started < SETTLE_MAX_MS) {
      await sleep(SETTLE_POLL_MS);
      const now = await fingerprint();
      if (now !== last) {
        last = now;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= SETTLE_STABLE_MS) break;
    }
    return Date.now() - started;
  }

  const drainErrors = () => {
    const errors = st.errors.splice(0);
    const consoleErrors = st.consoleErrors.splice(0);
    return { errors, consoleErrors };
  };

  /** The persisted snapshot for this artifact (owner view, as the host reads it). */
  async function readSnapshot(artifactId) {
    const client = await getClient();
    return client.query(api.appStates.getSessionState, { artifactId });
  }

  /** Mount an app version. Returns load facts; `broken` = an uncaught exception while starting. */
  async function load(app, { sessionId } = {}) {
    void sessionId;
    drainErrors();
    const artifactChanged = app.id !== st.artifactId;
    st.artifactId = app.id;
    st.hash = sha(app.html);
    // Like the host: the iframe's `init` carries the persisted doc for this artifact.
    let snapshot = null;
    try {
      snapshot = await readSnapshot(app.id);
    } catch {}
    st.doc = isObject(snapshot?.doc) ? snapshot.doc : artifactChanged ? {} : st.doc;
    st.persistedActions = snapshot === null ? null : snapshot?.actions;
    st.pendingPatch = {};
    st.pendingLogs = [];
    st.pendingActions = undefined;
    st.registry = [];
    st.nonce = null;
    let assets = new Map();
    const assetIds = host.requestedAppAssetIds(app.html);
    if (assetIds.length) {
      try {
        const client = await getClient();
        const rows = await client.action(api.appAssetHostActions.resolveArtifactAssets, { artifactId: app.id, html: assetIds.map(host.appAssetRef).join("") });
        assets = new Map(rows.map((r) => [r.id, r.url]));
      } catch {}
    }
    let sandbox;
    try {
      sandbox = await host.prepareCustomAppSandbox(app.html, host.injectAppStateSdk, (id) => assets.get(id));
    } catch (e) {
      return { loaded: false, broken: true, brokenAt: "prepare", errors: [clip(String(e?.message || e), 400)], consoleErrors: [] };
    }
    const ready = new Promise((resolve) => st.readyWaiters.push(resolve));
    await page.evaluate(([doc, csp]) => window.__mount(doc, csp), [sandbox.srcDoc, sandbox.csp]);
    const gotReady = await Promise.race([ready.then(() => true), sleep(10_000).then(() => false)]);
    const settledMs = await settle({ first: LOAD_SETTLE_MS });
    const { errors, consoleErrors } = drainErrors();
    return { loaded: gotReady, broken: errors.length > 0, brokenAt: errors.length ? "load" : undefined, errors, consoleErrors, settledMs, assets: assetIds.length || undefined };
  }

  /** Perform one child action on a control id from the last screen read. */
  async function act(action) {
    drainErrors();
    const f = await frame();
    if (!f) return { ...action, ok: false, error: "no app on screen" };
    const loc = f.locator(`[data-steer-ctl="${Number(action.id)}"]`);
    try {
      if ((await loc.count()) === 0) return { ...action, ok: false, error: `no control #${action.id} on screen` };
      const kind = await loc.evaluate((el) => {
        const t = (el.getAttribute("type") || "").toLowerCase();
        return el.tagName === "INPUT" && t === "range" ? "slider" : el.tagName === "SELECT" ? "select" : (el.tagName === "INPUT" && !["button", "submit", "checkbox", "radio"].includes(t)) || el.tagName === "TEXTAREA" ? "input" : "click";
      });
      if (action.kind === "set" && kind === "slider") {
        await loc.evaluate((el, v) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(el, String(v));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, action.value);
      } else if (action.kind === "set" && kind === "select") {
        await loc.selectOption({ label: String(action.value) }).catch(() => loc.selectOption(String(action.value)));
      } else if ((action.kind === "type" || action.kind === "set") && kind === "input") {
        await loc.fill(String(action.value ?? ""), { timeout: 3_000 });
        await loc.press("Enter", { timeout: 2_000 }).catch(() => {});
      } else {
        await loc.click({ timeout: 3_000 });
      }
    } catch (e) {
      const { errors } = drainErrors();
      return { ...action, ok: false, error: clip(String(e?.message || e).split("\n")[0], 200), errors };
    }
    const settledMs = await settle();
    const { errors, consoleErrors } = drainErrors();
    return { ...action, ok: true, settledMs, errors, consoleErrors };
  }

  /** Write pending patch/logs/registry through the web client's mutation. */
  async function publish() {
    if (!st.artifactId) return { skipped: "no app" };
    const update = {};
    if (Object.keys(st.pendingPatch).length) update.patch = st.pendingPatch;
    if (st.pendingLogs.length) update.logs = st.pendingLogs;
    if (st.pendingActions !== undefined) {
      const decision = host.appActionRegistryWriteDecision(st.persistedActions === null ? [] : st.persistedActions, st.pendingActions);
      if (decision === "persist") update.actions = st.pendingActions;
    }
    if (!Object.keys(update).length) return { skipped: "nothing new" };
    try {
      const client = await getClient();
      const snap = await client.mutation(api.appStates.updateSessionState, { artifactId: st.artifactId, ...update });
      st.pendingPatch = {};
      st.pendingLogs = [];
      if (update.actions) st.persistedActions = update.actions;
      st.pendingActions = undefined;
      return { ok: true, version: snap?.version, patchKeys: Object.keys(update.patch || {}), logs: update.logs?.length || 0, actions: update.actions?.length };
    } catch (e) {
      return { ok: false, error: clip(String(e?.message || e).split("\n")[0], 300) };
    }
  }

  /**
   * Serve the designer's `run_app_action` while a turn streams: poll the
   * mailbox; deliver a new request to the app as an `update`; acknowledge the
   * result with `actionResult` alone, as the host does. `currentApp()` reloads
   * the page first when the designer rebuilt the app earlier in the same turn.
   */
  function serveActionRequests({ currentApp }) {
    let stop = false;
    const served = [];
    const loop = (async () => {
      while (!stop) {
        await sleep(1_000);
        if (!st.artifactId) continue;
        let snap;
        try {
          snap = await readSnapshot(st.artifactId);
        } catch {
          continue;
        }
        const req = snap?.actionRequest;
        if (!req || st.servedRequestIds.has(req.id)) continue;
        st.servedRequestIds.add(req.id);
        const entry = { name: req.name, args: req.args };
        try {
          const app = await currentApp();
          if (app && sha(app.html) !== st.hash) entry.reloaded = (await load(app)).broken ? "broken" : "ok";
          await page.evaluate((m) => window.__post(m), host.createAppStateHostMessage("update", st.doc, st.nonce, null, req));
          const deadline = Date.now() + 8_000;
          while (!st.actionResults.has(req.id) && Date.now() < deadline) await sleep(200);
          const res = st.actionResults.get(req.id);
          if (res) {
            const client = await getClient();
            await client.mutation(api.appStates.updateSessionState, {
              artifactId: st.artifactId,
              actionResult: { requestId: res.requestId, ok: res.ok, ...(res.ok ? { result: res.result } : { error: res.error }) },
            });
            entry.ok = res.ok;
            if (!res.ok) entry.error = res.error;
            await sleep(400);
            entry.publish = await publish();
          } else entry.error = "app did not answer";
        } catch (e) {
          entry.error = clip(String(e?.message || e), 200);
        }
        served.push(entry);
      }
    })();
    return async () => {
      stop = true;
      await loop;
      return served;
    };
  }

  return {
    load,
    act,
    publish,
    screen,
    serveActionRequests,
    state: () => st.doc,
    registry: () => st.registry,
    loadedHash: () => st.hash,
    async screenshot(file) {
      try {
        await page.screenshot({ path: file });
        return file;
      } catch {
        return null;
      }
    },
    async close() {
      await browser.close().catch(() => {});
    },
  };
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

// ── Formatting for the persona, the record and the judge ────────────────────
export function summarizeState(doc, max = 600) {
  if (!isObject(doc) || !Object.keys(doc).length) return "(nothing recorded)";
  let s;
  try {
    s = JSON.stringify(doc);
  } catch {
    return "(unreadable)";
  }
  return clip(s, max);
}

export function controlLine(c) {
  const dis = c.disabled ? " (greyed out)" : "";
  if (c.kind === "slider") return `#${c.id} slider "${c.label}" ${c.min}–${c.max} (now ${c.value})${dis}`;
  if (c.kind === "input") return `#${c.id} text box "${c.label}"${c.value ? ` (has "${c.value}")` : ""}${dis}`;
  if (c.kind === "select") return `#${c.id} dropdown "${c.label}": ${c.options.join(" / ")} (now ${c.value})${dis}`;
  if (c.kind === "checkbox" || c.kind === "radio") return `#${c.id} ${c.kind} "${c.label}"${c.checked ? " (on)" : ""}${dis}`;
  return `#${c.id} button "${c.label}"${dis}`;
}

/** What the child sees, as text: screen words, controls, the app's recorded data. */
export function describeScreen(scr, doc, { broken } = {}) {
  const parts = [];
  if (broken) parts.push(`The app shows an error and may not work properly.`);
  parts.push(`Words on screen: ${scr.text ? clip(scr.text, 900) : "(none)"}`);
  if (scr.canvases) parts.push(`There is a drawing/animation area on screen.`);
  parts.push(`Things you can use: ${scr.controls.length ? scr.controls.map(controlLine).join("; ") : "(nothing to press)"}`);
  parts.push(`What the app has recorded: ${summarizeState(doc, 400)}`);
  return parts.join("\n");
}

/** Parse one <act> from the persona: "click 3", "set 5 = 40", "type 2 = hello". */
export function parseKidAction(raw) {
  const s = String(raw || "").trim();
  let mm = /^(click|press|tap)\s*#?(\d+)\s*$/i.exec(s);
  if (mm) return { kind: "click", id: Number(mm[2]) };
  mm = /^(set|slide|choose|pick)\s*#?(\d+)\s*(?:=|to)\s*(.+)$/i.exec(s);
  if (mm) return { kind: "set", id: Number(mm[2]), value: mm[3].trim() };
  mm = /^(type|write|enter)\s*#?(\d+)\s*(?:=|:)\s*([\s\S]+)$/i.exec(s);
  if (mm) return { kind: "type", id: Number(mm[2]), value: mm[3].trim().slice(0, 200) };
  return null;
}

export function describeKidAction(a, controls = []) {
  const c = controls.find((x) => x.id === a.id);
  const what = c ? controlLine(c).replace(/^#\d+ /, "") : `control #${a.id}`;
  if (a.kind === "click") return `pressed ${what}`;
  if (a.kind === "set") return `set ${what} to ${a.value}`;
  return `typed "${a.value}" into ${what}`;
}
