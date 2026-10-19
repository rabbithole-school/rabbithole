// A one-time page, on this computer only, for pasting an Anthropic API key
// into the local Rabbithole without it passing through an agent's chat.
// Run by `bin/set-key.sh --browser`: it prints a link with a random token,
// opens it, hands whatever is pasted to `bin/set-key.sh --stdin`, and exits
// once a key is saved. It never prints or logs the key.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = randomBytes(24).toString("hex");
const WAIT_MINUTES = 30;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rabbithole: the tutor's key</title>
<style>
  :root { color-scheme: light dark; --ink: #1f1a2e; --muted: #5d566e; --accent: #7b4bb7; --bg: #faf9fc; --card: #fff; --line: #e4dfee; --bad: #b3261e; --good: #1b7a46; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ece8f4; --muted: #b0a8c2; --accent: #c6a3f0; --bg: #17141f; --card: #211d2b; --line: #352f42; --bad: #ff8a80; --good: #7ad6a2; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 34rem; margin: 3rem auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; } .muted { color: var(--muted); font-size: .95rem; }
  label { display: block; font-weight: 600; margin: 1.25rem 0 .4rem; }
  input { width: 100%; font: inherit; padding: .65rem .8rem; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--ink); }
  button { margin-top: 1rem; font: inherit; font-weight: 600; padding: .65rem 1.2rem; border: 0; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { color: #17141f; } }
  .bad { color: var(--bad); } .good { color: var(--good); }
  details { margin-top: 1.5rem; } summary { cursor: pointer; font-weight: 600; }
  ol { padding-left: 1.25rem; } a { color: var(--accent); }
</style></head>
<body><main><div class="card">${body}</div></main></body></html>`;
}

function form(error = "") {
  return page(`
  <h1>Give the tutor a key</h1>
  <p>Rabbithole's tutor thinks with Claude, so it needs an Anthropic API key. Paste yours here.
  It goes straight into Rabbithole on this computer. It doesn't go into your chat with your agent,
  and nobody else sees it.</p>
  <form method="post" autocomplete="off">
    <label for="key">Anthropic API key</label>
    <input id="key" name="key" type="password" placeholder="sk-ant-…" required autofocus spellcheck="false">
    ${error ? `<p class="bad">${esc(error)}</p>` : ""}
    <button type="submit">Save the key</button>
  </form>
  <p class="muted">Anthropic bills the key's owner for what the tutor uses: about 10 to 40 cents a reply,
  so trying it costs a dollar or two. You can set a spending limit in Anthropic's console.</p>
  <details${error ? "" : " open"}><summary>Don't have a key yet?</summary>
    <ol>
      <li>Sign in or sign up at <a href="https://platform.claude.com" target="_blank" rel="noreferrer">platform.claude.com</a>.</li>
      <li>Under Billing, add a few dollars of credit, and set a spending limit if you like.</li>
      <li>Open <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">API keys</a>, choose Create key, and copy it. It's shown only once.</li>
      <li>Come back to this page and paste it above.</li>
    </ol>
  </details>`);
}

const done = page(`
  <h1 class="good">The tutor has its key</h1>
  <p>It's saved in Rabbithole on this computer. You can close this tab and go back to your agent.</p>`);

function save(key) {
  return new Promise((resolve) => {
    const child = spawn(path.join(kit, "bin", "set-key.sh"), ["--stdin"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.split(key).join("[key]") }));
    child.stdin.end(`${key}\n`);
  });
}

let busy = false;
const server = createServer((req, res) => {
  const { port } = server.address();
  // Only this exact local address, with the right token, gets the page.
  const hostOk = req.headers.host === `127.0.0.1:${port}`;
  const originOk = !req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}`;
  if (!hostOk || !originOk || req.url !== `/${token}`) {
    res.writeHead(404).end();
    return;
  }
  const send = (html, status = 200) =>
    res
      .writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // same-origin, not no-referrer: under no-referrer the browser sends the
        // form's POST with "Origin: null", which the origin check refuses.
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
      })
      .end(html);
  if (req.method === "GET") return send(form());
  if (req.method !== "POST") return res.writeHead(405).end();
  let body = "";
  req.on("data", (d) => {
    body += d;
    if (body.length > 4096) req.destroy();
  });
  req.on("end", async () => {
    if (busy) return send(form("Still checking the last key; give it a moment."), 409);
    const key = (new URLSearchParams(body).get("key") || "").trim();
    if (!key) return send(form("Paste a key first."), 400);
    busy = true;
    const result = await save(key);
    busy = false;
    if (!result.ok) {
      const why = /rejected/.test(result.out)
        ? "Anthropic didn't accept that key. Check you copied all of it, or make a new one."
        : "Something went wrong saving the key. Your agent can see what happened.";
      process.stdout.write(result.out);
      return send(form(why), 400);
    }
    send(done);
    process.stdout.write(result.out);
    setTimeout(() => process.exit(0), 500);
  });
});

server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/${token}`;
  console.log(`Open this page to paste the key (it works once, on this computer only):\n  ${url}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : "";
  if (opener) spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  console.log(`Waiting up to ${WAIT_MINUTES} minutes for the key…`);
});

setTimeout(() => {
  console.log("No key arrived, so nothing changed. Run bin/set-key.sh --browser again when ready.");
  process.exit(1);
}, WAIT_MINUTES * 60_000).unref();
