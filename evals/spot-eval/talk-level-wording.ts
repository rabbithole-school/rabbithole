/**
 * Spot-eval (structured, no judge) for TRA-514's tutor prompt wording: the
 * TALK level is the grade band of ideas and vocabulary, not a reading level.
 *
 * Before, the generic note said "reading level … frame explanations at this
 * reading level" and the K–2 register said "sentences they can read", which
 * contradicts the listener and beginner delivery sections (the child can't
 * read the reply). After, both size ideas and words only. This A/Bs the two
 * wordings on the live tutor model and runtime, with the real system prompt
 * (`buildSystemPromptParts`), on four fictional profiles:
 *
 *   - talk 5 + reader          — the regression check: an ordinary reader
 *   - talk 7 + beginner        — grade-7 ideas, read aloud word by word
 *   - talk 2 + listener        — hits EARLY GRADES + LISTENER (the contradiction)
 *   - talk K + listener        — control: the pre-reader register, unchanged
 *                                except the base prompt's one "talk level" line
 *
 * OLD is rebuilt from the NEW prompt by swapping the old section text back in
 * (asserted to have happened), so the arms differ only in this wording.
 *
 * Metrics (mechanical, per reply, spoken part):
 *   - words      — mean words per reply
 *   - fk         — Flesch–Kincaid grade of the reply (rough, syllable-count)
 *   - readAsk    — replies that ask the child to read something on screen
 *                  ("read this/it/the…", "look at the words/screen"), outside
 *                  a beginner's own <your-turn> line
 *   - markdown   — replies with markdown (**, __, #, `) or a list
 *   - questions  — mean "?" per reply
 *   - yourTurn   — share of replies carrying a <your-turn> line (beginner)
 *
 * Run (from a worktree), bundled like beginner-your-turn.ts:
 *   node_modules/.bin/esbuild evals/spot-eval/talk-level-wording.ts --bundle \
 *     --format=esm --platform=node --packages=external \
 *     --outfile=evals/spot-eval/out/tlw-run.mjs
 *   node --env-file=$HOME/code/.env.local evals/spot-eval/out/tlw-run.mjs --samples 2
 *
 * Output: evals/spot-eval/out/talk-level-wording/runs.json (gitignored) and a
 * summary table on stdout.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSystemPromptParts } from "../../convex/sessionHelpers";
import { buildEarlyReaderSection, buildTalkLevelSection } from "../../convex/prompts";
import type { ModelId } from "../../convex/lib/models";
import { TUTOR_DEFAULT_MODEL, tutorRuntime } from "../../convex/lib/tutorModel";
import { splitYourTurn, withoutYourTurn } from "../../shared/beginnerReading";

const OUT_DIR = resolve("evals/spot-eval/out/talk-level-wording");
const MODEL = (process.env.TUTOR_MODEL || TUTOR_DEFAULT_MODEL) as ModelId;
const runtime = tutorRuntime(MODEL);
const samplesArg = process.argv.indexOf("--samples");
const SAMPLES = samplesArg > -1 ? Number(process.argv[samplesArg + 1]) : 1;

// ── The OLD wording, verbatim from master before TRA-514 ───────────────────
const OLD_GENERIC = (talk: string) =>
  `\n\nREADING LEVEL: The scholar's reading level is set to "${talk}". Adjust your vocabulary and sentence complexity accordingly. You can still explore advanced topics, but frame explanations at this reading level.`;
const OLD_EARLY_HEAD = (talk: string) =>
  `\n\nEARLY READER: The scholar's reading level is set to "${talk}" (kindergarten to second grade). Same big ideas, smaller pipe: carry grade-level thinking in sentences they can read.`;
const NEW_EARLY_HEAD = (talk: string) => buildEarlyReaderSection(talk).split("\n- ")[0];
const OLD_BASE =
  "- Use age-appropriate language — and match the scholar's reading level in everything you GENERATE too,";
const NEW_BASE =
  "- Use age-appropriate language — and match the scholar's talk level (the ideas and words they follow) in everything you GENERATE too,";

interface Case {
  name: string;
  talk: string;
  read: "listener" | "beginner" | "reader";
  write: "own" | "voice";
  messages: string[];
}

// All fictional.
const cases: Case[] = [
  {
    name: "talk 5 + reader — volcanoes",
    talk: "5",
    read: "reader",
    write: "own",
    messages: [
      "why do volcanoes explode",
      "because the magma is hot and has gas in it",
      "i dont know",
      "like shaking a soda bottle?",
      "so thicker magma traps more gas",
    ],
  },
  {
    name: "talk 7 + beginner — black holes",
    talk: "7",
    read: "beginner",
    write: "voice",
    messages: [
      "how do black holes work",
      "gravity pulls everything in",
      "even light?",
      "i dont know why light cant escape",
      "so its like the escape speed is faster than light",
    ],
  },
  {
    name: "talk 2 + listener — bees",
    talk: "2",
    read: "listener",
    write: "voice",
    messages: [
      "i want to know about bees",
      "they make honey",
      "from flowers",
      "i dont know",
      "they dance to tell where the flowers are",
    ],
  },
  {
    name: "talk K + listener — shadows",
    talk: "K",
    read: "listener",
    write: "voice",
    messages: [
      "why do i have a shadow",
      "the sun",
      "it follows me",
      "i dont know",
      "it gets long at night",
    ],
  },
];

function systemFor(c: Case, isFirstTurn: boolean, arm: "old" | "new"): string {
  const args: unknown[] = new Array(55).fill(undefined);
  args.splice(0, 6, null, c.talk, "Kai", null, null, null);
  args[21] = isFirstTurn;
  args[22] = false; // isFirstSession
  args[23] = null; // lastSessionAt
  args[54] = { read: c.read, write: c.write, beginnerTeams: ["sh", "ck"] };
  const parts = (
    buildSystemPromptParts as unknown as (
      ...a: unknown[]
    ) => ReturnType<typeof buildSystemPromptParts>
  )(...args);
  let system = parts.stable + parts.dynamic;
  if (arm === "new") return system;
  const swaps: [string, string][] = [[NEW_BASE, OLD_BASE]];
  if (system.includes(buildTalkLevelSection(c.talk))) {
    swaps.push([buildTalkLevelSection(c.talk), OLD_GENERIC(c.talk)]);
  }
  if (system.includes(NEW_EARLY_HEAD(c.talk))) {
    swaps.push([NEW_EARLY_HEAD(c.talk), OLD_EARLY_HEAD(c.talk)]);
  }
  for (const [from, to] of swaps) {
    if (!system.includes(from)) throw new Error(`OLD arm: "${from.slice(0, 40)}…" not found`);
    system = system.replace(from, to);
  }
  return system;
}

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = /[^aeiouy]e$/.test(w) && groups > 1 ? 1 : 0;
  return Math.max(1, groups - silentE);
}

function fleschKincaid(text: string): number {
  const words = text.match(/[A-Za-z']+/g) ?? [];
  if (words.length === 0) return 0;
  const sentences = Math.max(1, (text.match(/[.!?]+/g) ?? []).length);
  const syl = words.reduce((s, w) => s + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}

const READ_ASK =
  /\b(read (this|it|that|the|these|those|what|along)|look at the (words?|screen|text)|on (the|your) screen|can you read)\b/i;
const MARKDOWN = /\*\*|__|^#{1,6}\s|`|^\s*[-*]\s|^\s*\d+\.\s/m;

type Turn = {
  text: string;
  words: number;
  fk: number;
  readAsk: boolean;
  markdown: boolean;
  questions: number;
  yourTurn: boolean;
};

function analyse(text: string): Turn {
  const spoken = withoutYourTurn(text);
  return {
    text,
    words: spoken.split(/\s+/).filter(Boolean).length,
    fk: fleschKincaid(spoken),
    readAsk: READ_ASK.test(spoken),
    markdown: MARKDOWN.test(spoken),
    questions: (spoken.match(/\?/g) ?? []).length,
    yourTurn: splitYourTurn(text).some((p) => p.kind === "yourTurn"),
  };
}

async function reply(
  client: Anthropic,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: runtime.maxTokens,
    system,
    messages,
    ...(runtime.effort ? { output_config: { effort: runtime.effort } } : {}),
  } as Anthropic.MessageCreateParamsNonStreaming);
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

async function runCase(client: Anthropic, c: Case, arm: "old" | "new"): Promise<Turn[]> {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  const turns: Turn[] = [];
  for (let i = 0; i < c.messages.length; i++) {
    history.push({ role: "user", content: c.messages[i] });
    const text = await reply(client, systemFor(c, i === 0, arm), history);
    history.push({ role: "assistant", content: text });
    turns.push(analyse(text));
  }
  return turns;
}

async function main() {
  const client = new Anthropic();
  mkdirSync(OUT_DIR, { recursive: true });
  // Fail fast if the OLD swap can't be built for any case.
  for (const c of cases) systemFor(c, true, "old");
  const runs: { case: string; arm: "old" | "new"; sample: number; turns: Turn[] }[] = [];
  // `--case <text>` runs only the cases whose name contains it.
  const onlyArg = process.argv.indexOf("--case");
  const only = onlyArg > -1 ? process.argv[onlyArg + 1] : null;
  await Promise.all(
    cases.filter((c) => !only || c.name.includes(only)).flatMap((c) =>
      (["old", "new"] as const).flatMap((arm) =>
        Array.from({ length: SAMPLES }, async (_, sample) => {
          runs.push({ case: c.name, arm, sample, turns: await runCase(client, c, arm) });
        }),
      ),
    ),
  );
  writeFileSync(`${OUT_DIR}/runs${only ? "-" + only.replace(/\W+/g, "_") : ""}.json`, JSON.stringify(runs, null, 2));

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log(`model=${MODEL} samples=${SAMPLES} turns/run=5`);
  console.log("| case | arm | replies | words | FK grade | readAsk | markdown | ?/reply | yourTurn |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const c of cases.filter((x) => !only || x.name.includes(only))) {
    for (const arm of ["old", "new"] as const) {
      const t = runs.filter((r) => r.case === c.name && r.arm === arm).flatMap((r) => r.turns);
      console.log(
        `| ${c.name} | ${arm.toUpperCase()} | ${t.length} | ${mean(t.map((x) => x.words)).toFixed(1)} | ` +
          `${mean(t.map((x) => x.fk)).toFixed(1)} | ${t.filter((x) => x.readAsk).length} | ` +
          `${t.filter((x) => x.markdown).length} | ${mean(t.map((x) => x.questions)).toFixed(2)} | ` +
          `${t.filter((x) => x.yourTurn).length} |`,
      );
    }
  }
  for (const r of runs.filter((x) => x.sample === 0)) {
    console.log(`\n## ${r.case} — ${r.arm.toUpperCase()}`);
    r.turns.forEach((t, i) => console.log(`  t${i + 1} (${t.words}w, FK ${t.fk.toFixed(1)}): ${t.text.replace(/\n+/g, " ⏎ ")}`));
  }
}

void main();
