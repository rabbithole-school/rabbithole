#!/usr/bin/env node
// Kit smoke test: /dev-login lists seeded users, and signing in as a seeded
// teacher lands on a rendered /teacher dashboard.
// Usage: node smoke.mjs <checkout-dir> <base-url> <username> <out-dir> [chromium-path] [to-path]
import { createRequire } from "node:module";
import path from "node:path";
const [dir, base, user, out, exe, to = "/teacher"] = process.argv.slice(2);
const slug = to.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
const { chromium } = createRequire(path.join(dir, "package.json"))("playwright");
const browser = await chromium.launch({ executablePath: exe || undefined });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on("response", (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url().slice(0, 160)}`); });
page.on("requestfailed", (r) => errors.push(`failed: ${r.url().slice(0, 160)}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`); });
const t0 = Date.now();
await page.goto(`${base}/dev-login`, { waitUntil: "domcontentloaded" });
await page.getByText(user, { exact: false }).first().waitFor({ timeout: 90_000 });
const listed = await page.locator("body").innerText();
await page.screenshot({ path: path.join(out, "dev-login-index.png"), fullPage: true });
console.log(`index: '${user}' listed after ${Date.now() - t0}ms; body chars=${listed.length}`);
const t1 = Date.now();
await page.goto(`${base}/dev-login?u=${encodeURIComponent(user)}&to=${encodeURIComponent(to)}`, { waitUntil: "domcontentloaded" });
await page.waitForURL((u) => u.pathname.startsWith(to), { timeout: 180_000 });
await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => {});
await page.waitForTimeout(4000);
const body = await page.locator("body").innerText();
await page.screenshot({ path: path.join(out, `${slug}.png`), fullPage: false });
console.log(`landed: url=${new URL(page.url()).pathname} after ${Date.now() - t1}ms; body chars=${body.length}`);
console.log("landed body (first 600 chars):\n" + body.replace(/\n{2,}/g, "\n").slice(0, 600));
console.log(`errors (${errors.length}):\n` + errors.slice(0, 12).join("\n"));
await browser.close();
