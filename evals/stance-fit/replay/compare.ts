/**
 * Compare two replay runs paired by decision point.
 *
 *   tsx evals/stance-fit/replay/compare.ts --out <dir> --a <label> --b <label>
 *
 * Writes <out>/replay/compare-<a>-vs-<b>.md (and prints it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GenerationsFile, type VerdictsFile, loadDecisionPoints, renderCompare } from "./lib";

function parseArgs(argv: string[]) {
  const args = { out: "", a: "", b: "" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--out") args.out = v;
    else if (flag === "--a") args.a = v;
    else if (flag === "--b") args.b = v;
    else throw new Error("Usage: tsx evals/stance-fit/replay/compare.ts --out DIR --a LABEL --b LABEL");
  }
  if (!args.out || !args.a || !args.b) {
    throw new Error("Usage: tsx evals/stance-fit/replay/compare.ts --out DIR --a LABEL --b LABEL");
  }
  return args;
}

const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const run = (label: string) => join(args.out, "replay", label);
  const md = renderCompare({
    labelA: args.a,
    labelB: args.b,
    dps: loadDecisionPoints(args.out),
    gensA: read<GenerationsFile>(join(run(args.a), "generations.json")),
    gensB: read<GenerationsFile>(join(run(args.b), "generations.json")),
    verdictsA: read<VerdictsFile>(join(run(args.a), "verdicts.json")),
    verdictsB: read<VerdictsFile>(join(run(args.b), "verdicts.json")),
  });
  const path = join(args.out, "replay", `compare-${args.a}-vs-${args.b}.md`);
  writeFileSync(path, `${md}\n`);
  console.log(md);
  console.log(`\nWrote ${path}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
