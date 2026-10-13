// Build the drink-me front door into site/dist: the page for people at /, and
// the instructions for agents at /drink-me, pinned to the commit this
// deployment was built from so the page and the kit can't drift apart.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// A Git-linked Vercel build sets VERCEL_GIT_COMMIT_SHA; a CLI deploy passes
// --build-env DRINK_ME_COMMIT=$(git rev-parse HEAD) instead.
let commit = process.env.VERCEL_GIT_COMMIT_SHA || process.env.DRINK_ME_COMMIT || "";
if (!commit) {
  try {
    commit = execSync("git rev-parse HEAD", { cwd: here, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    commit = "";
  }
}
const pin = commit
  ? `       git -C ~/rabbithole-drink-me checkout --quiet ${commit}\n\n` +
    "   The second command pins the kit to the exact version this page was published with.\n\n"
  : "\n";
const md = readFileSync(path.join(here, "drink-me.md"), "utf8").replace("{{PIN}}\n", pin);
writeFileSync(path.join(dist, "drink-me.md"), md);
writeFileSync(
  path.join(dist, "llms.txt"),
  "# Rabbithole: drink-me\n\n" +
    "If a person asked you to take them down the rabbit hole, read " +
    "https://drink-me.rabbithole.school/drink-me and follow it.\n",
);
for (const f of ["index.html", "hg-Regular.woff2", "hg-Bold.woff2"]) copyFileSync(path.join(here, f), path.join(dist, f));
console.log(`built site/dist${commit ? `, pinned to ${commit.slice(0, 7)}` : " (no commit pin available)"}`);
