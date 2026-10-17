/**
 * Spot-eval (structured, no judge) for the BEGINNER reader delivery rules, the
 * "your turn" line and the reading-back feedback (TRA-504,
 * `buildBeginnerReaderSection` in convex/prompts.ts). Runs the live tutor model
 * and runtime with the real system prompt (`buildSystemPromptParts`, read
 * `beginner`), turn by turn against scripted, fictional scholar messages.
 *
 * CONVERSATION metrics (default mode):
 *   - words/turn, over45 — the spoken part's length, and the share of turns
 *                    over 45 words (TRA-501's ~40-word young-reader budget)
 *   - questions    — the last question of each turn: open, or A-or-B
 *                    ("...this, or that?"); and the same just after the child
 *                    says "I don't know" (should be open, or a thing to look at)
 *   - yourTurnRate — share of turns with a `<your-turn>` line (~1 in 3; never
 *                    the first reply, never two in a row)
 *   - decodable    — each line against the scholar's alphabet with the
 *                    phonics-aware `checkDecodable` (shared/beginnerReading)
 *   - jargon       — turns saying unit / lesson / activity / chapter (the
 *                    quest case runs the scholar's own Independent Study unit)
 *   - pushAfterNo  — in the quest case, turns after the child declines
 *                    planning that still talk about building or planning it
 *   - emoji        — turns with a decorative emoji (a run of 2+ of the same
 *                    emoji, a counting row, is allowed and not counted)
 *   - markdown     — turns whose raw text carries markdown (**, __, #, `)
 *   - lineOpenings — share of your-turn lines starting with "Can"
 *   - twoGuess     — on a garbled dictated turn, the reply offers two spoken
 *                    guesses as a question ("ears, or years?")
 *
 * READING metrics (`--reading`): the turn after the child read the line aloud,
 * with a fixed history (a reply ending in a line, then the labelled read-aloud
 * exactly as projectStreamMessages builds it):
 *   - saysTarget   — on a miss, the reply says the missed word whole (it
 *                    shouldn't: give the sounds, let them blend)
 *   - soundsOut    — on a miss, the reply gives the word's sounds ("p, i, g")
 *   - questions    — question marks in the reply (want at most ONE: the re-read)
 *   - readsLine / newLine — reads the whole line for them / adds a new line
 *   - falsePraise  — on a non-attempt ("um I can't read that"), the reply
 *                    praises a word as read ("you read 'I'")
 *
 * Run (from a worktree). `tsx` can't load convex/sessionHelpers here (an
 * @convex-dev/auth export condition), so bundle it first, into the gitignored
 * out/ dir so its packages resolve:
 *   node_modules/.bin/esbuild evals/spot-eval/beginner-your-turn.ts --bundle \
 *     --format=esm --platform=node --packages=external \
 *     --outfile=evals/spot-eval/out/byt-run.mjs
 *   node --env-file=$HOME/code/.env.local evals/spot-eval/out/byt-run.mjs --samples 2
 *   node --env-file=$HOME/code/.env.local evals/spot-eval/out/byt-run.mjs --reading --samples 3
 *   (add `--case garbled` to run only the cases whose name contains it)
 *
 * Output: evals/spot-eval/out/beginner-your-turn/*.json (gitignored) and a
 * summary on stdout. Results are reported in the PR, before and after.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSystemPromptParts } from "../../convex/sessionHelpers";
import {
  DICTATED_TURN_LABEL,
  readAloudLabel,
} from "../../convex/lib/projectStreamMessages";
import type { ModelId } from "../../convex/lib/models";
import { TUTOR_DEFAULT_MODEL, tutorRuntime } from "../../convex/lib/tutorModel";
import {
  beginnerAlphabet,
  checkDecodable,
  splitYourTurn,
  withoutYourTurn,
  YOUR_TURN_CLOSE,
  YOUR_TURN_OPEN,
} from "../../shared/beginnerReading";

const OUT_DIR = resolve("evals/spot-eval/out/beginner-your-turn");
const MODEL = (process.env.TUTOR_MODEL || TUTOR_DEFAULT_MODEL) as ModelId;
const runtime = tutorRuntime(MODEL);
const samplesArg = process.argv.indexOf("--samples");
const SAMPLES = samplesArg > -1 ? Number(process.argv[samplesArg + 1]) : 1;

interface Case {
  name: string;
  talk: string;
  teams: string[];
  messages: string[];
  /** Run inside the scholar's own Independent Study unit (quest planning). */
  ownQuest?: string;
  /** Index of the message where the child declines planning. */
  declineAt?: number;
  /** A dictated, garbled turn: its index and the words a good guess names. */
  garbled?: { at: number; guesses: string[] };
}

// All fictional. A 6-year-old early decoder who talks at grade 2, then the
// same child with no inventory yet (the default letters only), then an older
// beginner who talks at grade 4 (the words must stay grade-4, not K), then a
// quest-planning chat the child doesn't want to plan.
const cases: Case[] = [
  {
    name: "talk 2, inventory ck sh — animals",
    talk: "2",
    teams: ["ck", "sh"],
    messages: [
      "i want to talk about foxes",
      "they have big ears",
      "to hear stuff under the ground",
      "mice and bugs",
      "yes a pig can dig",
      "they dig a den",
      "it keeps them cool when its hot",
      "i dont know",
      "maybe they sleep in the day",
    ],
  },
  {
    name: "talk 2, no inventory — counting",
    talk: "2",
    teams: [],
    messages: [
      "can we do math",
      "i have 3 cats and you have 4 cats",
      "7",
      "i dont know",
      "i counted on my fingers",
      "10 and 10 is 20",
      "because two tens",
      "can we do a harder one",
    ],
  },
  {
    name: "talk 4, inventory sh ch th ee — volcanoes",
    talk: "4",
    teams: ["sh", "ch", "th", "ee"],
    messages: [
      "why do volcanoes explode",
      "the magma is really hot and it pushes up",
      "i dont know",
      "like when you shake a soda",
      "the top would pop off",
      "yes",
      "do volcanoes happen under the ocean",
      "that is so cool",
    ],
  },
  {
    name: "talk 2, no inventory — garbled speech",
    talk: "2",
    teams: [],
    garbled: { at: 2, guesses: ["ears", "tail", "fur"] },
    messages: [
      "i like foxes",
      "they are orange",
      "the fox has big yers and a fluffy tell",
      "yes",
      "they hear mice",
    ],
  },
  {
    name: "talk 2, own quest — sharks, declines planning",
    talk: "2",
    teams: ["sh"],
    ownQuest: "Sharks",
    declineAt: 2,
    messages: [
      "sharks",
      "their teeth",
      "i dont want to plan i just want to know about sharks",
      "do sharks eat people",
      "i dont know",
      "wow",
      "how big is the biggest shark",
    ],
  },
];

function systemFor(c: Case, isFirstTurn: boolean): string {
  const args: unknown[] = new Array(55).fill(undefined);
  const unit = c.ownQuest
    ? {
        title: c.ownQuest,
        description: null,
        systemPrompt: null,
        rubric: null,
        youtubeUrl: null,
        videoTranscript: null,
        bigIdea: null,
        essentialQuestions: null,
        enduringUnderstandings: null,
        isOwnIsUnit: true,
        ownIsUnitOutline: [],
      }
    : null;
  args.splice(0, 6, null, c.talk, "Kai", unit, null, null);
  args[21] = isFirstTurn; // isFirstTurn
  args[22] = false; // isFirstSession
  args[23] = null; // lastSessionAt
  args[54] = { read: "beginner", write: "voice", beginnerTeams: c.teams };
  const parts = (
    buildSystemPromptParts as unknown as (
      ...a: unknown[]
    ) => ReturnType<typeof buildSystemPromptParts>
  )(...args);
  return parts.stable + parts.dynamic + parts.documents + parts.turnSystem;
}

type QuestionKind = "open" | "ab" | "none";

/** The last question in a reply: A-or-B when it offers "X, or Y?". */
function lastQuestionKind(spoken: string): QuestionKind {
  const questions = spoken.match(/[^.?!]*\?/g);
  if (!questions) return "none";
  const q = questions[questions.length - 1];
  return /\bor\b/i.test(q) ? "ab" : "open";
}

// A decorative emoji: any pictographic char NOT in a run of the same one
// (a counting row like 🍪🍪🍪 is a representation, not decoration).
function hasDecorativeEmoji(text: string): boolean {
  const runs = text.match(/(\p{Extended_Pictographic})(?:\uFE0F)?(?:\1\uFE0F?)*/gu) ?? [];
  return runs.some((r) => [...r.matchAll(/\p{Extended_Pictographic}/gu)].length < 2);
}
const MARKDOWN = /\*\*|__|^#{1,6}\s|`/m;

const JARGON = /\b(units?|lessons?|activit(y|ies)|chapters?)\b/i;
const PLANNING = /\b(units?|lessons?|activit(y|ies)|chapters?|plan|build|parts?)\b/i;

type Turn = {
  text: string;
  line: string | null;
  lines: number;
  decodable: boolean | null;
  undecodable: string[];
  malformed: boolean;
  spokenWords: number;
  echoed: boolean;
  question: QuestionKind;
  jargon: boolean;
  planning: boolean;
  emoji: boolean;
  markdown: boolean;
};

function analyse(text: string, teams: string[]): Turn {
  const parts = splitYourTurn(text);
  const lines = parts.filter((p) => p.kind === "yourTurn");
  const line = lines[0]?.text ?? null;
  const opens = text.split(YOUR_TURN_OPEN).length - 1;
  const closes = text.split(YOUR_TURN_CLOSE).length - 1;
  const lastIsLine = parts[parts.length - 1]?.kind === "yourTurn";
  const spoken = withoutYourTurn(text);
  const check = line ? checkDecodable(line, beginnerAlphabet(teams)) : null;
  return {
    text,
    line,
    lines: lines.length,
    decodable: check ? check.ok : null,
    undecodable: check ? check.undecodable : [],
    malformed: opens !== closes || lines.length > 1 || (line !== null && !lastIsLine),
    spokenWords: spoken.split(/\s+/).filter(Boolean).length,
    echoed:
      line !== null &&
      spoken.toLowerCase().includes(line.toLowerCase().replace(/[?.!]$/, "")),
    question: lastQuestionKind(spoken),
    jargon: JARGON.test(spoken),
    planning: PLANNING.test(spoken),
    emoji: hasDecorativeEmoji(text),
    markdown: MARKDOWN.test(text),
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

async function runCase(client: Anthropic, c: Case): Promise<Turn[]> {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  const turns: Turn[] = [];
  for (let i = 0; i < c.messages.length; i++) {
    const content =
      c.garbled?.at === i ? `${DICTATED_TURN_LABEL} ${c.messages[i]}` : c.messages[i];
    history.push({ role: "user", content });
    const text = await reply(client, systemFor(c, i === 0), history);
    history.push({ role: "assistant", content: text });
    turns.push(analyse(text, c.teams));
  }
  return turns;
}

// ── Reading it back (`--reading`) ───────────────────────────────────────────
const READ_LINE = "Can a pig dig?";
const READ_REPLY =
  "Pigs dig with their snouts to find roots to eat! Do you think a pig's nose is soft or tough?\n\n<your-turn>Can a pig dig?</your-turn>";
const readingCases: {
  name: string;
  heard: string;
  misses: string[];
  line?: string;
  nonAttempt?: boolean;
}[] = [
  { name: "clean read", heard: "can a pig dig", misses: [] },
  { name: "pig came out as big", heard: "can a big dig", misses: ["pig"] },
  { name: "skipped a word", heard: "can a pig", misses: ["dig"] },
  { name: "garbled", heard: "um can", misses: ["pig", "dig"] },
  { name: "i can't read that", heard: "i can't read that", misses: ["pig", "dig"], nonAttempt: true },
  {
    name: "refusal overlapping 'I'",
    line: "Can I sip it?",
    heard: "um I can't read that",
    misses: ["sip"],
    nonAttempt: true,
  },
];

async function runReading(client: Anthropic) {
  const c = cases[0];
  const rows: { name: string; sample: number; text: string }[] = [];
  await Promise.all(
    readingCases.flatMap((rc) =>
      Array.from({ length: SAMPLES }, async (_, sample) => {
        const line = rc.line ?? READ_LINE;
        const text = await reply(client, systemFor(c, false), [
          { role: "user", content: "i want to learn about pigs" },
          { role: "assistant", content: READ_REPLY.replace(READ_LINE, line) },
          {
            role: "user",
            content: `${readAloudLabel(line, rc.heard)} ${rc.heard}`.trim(),
          },
        ]);
        rows.push({ name: rc.name, sample, text });
      }),
    ),
  );
  writeFileSync(`${OUT_DIR}/reading.json`, JSON.stringify(rows, null, 2));
  let missReplies = 0, saysTarget = 0, soundsOut = 0, oneQuestion = 0, readsLine = 0, newLine = 0, words = 0;
  let nonAttemptReplies = 0, falsePraise = 0;
  for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const rc = readingCases.find((x) => x.name === r.name)!;
    const spoken = withoutYourTurn(r.text);
    const lower = spoken.toLowerCase();
    const isMiss = rc.misses.length > 0;
    const says = isMiss && rc.misses.some((m) => new RegExp(`\\b${m}\\b`, "i").test(spoken));
    const so =
      isMiss &&
      rc.misses.some((m) => new RegExp(m.split("").join("[-,\\s]+"), "i").test(spoken));
    const q = (spoken.match(/\?/g) ?? []).length;
    // After a clean read, saying a question line back to ask for their answer is right.
    const rl = isMiss && lower.includes((rc.line ?? READ_LINE).toLowerCase().replace("?", ""));
    const fp =
      !!rc.nonAttempt &&
      /\byou (already |just )?read\b|\byou said ["“'][a-z]+["”'] (right|perfectly|clearly)/i.test(spoken);
    if (rc.nonAttempt) nonAttemptReplies++;
    if (fp) falsePraise++;
    const nl = splitYourTurn(r.text).some((p) => p.kind === "yourTurn");
    const w = spoken.split(/\s+/).filter(Boolean).length;
    if (isMiss) missReplies++;
    if (says) saysTarget++;
    if (so) soundsOut++;
    if (q <= 1) oneQuestion++;
    if (rl) readsLine++;
    if (nl) newLine++;
    words += w;
    console.log(
      `\n## ${r.name} (s${r.sample}) ${w}w q=${q}${fp ? " FALSE-PRAISE" : ""}${says ? " SAYS-TARGET" : ""}${so ? " SOUNDS-OUT" : ""}${rl ? " READS-LINE" : ""}${nl ? " NEW-LINE" : ""}\n${r.text}`,
    );
  }
  console.log(
    `\nREADING model=${MODEL} replies=${rows.length} saysTarget=${saysTarget}/${missReplies} ` +
      `soundsOut=${soundsOut}/${missReplies} atMostOneQuestion=${oneQuestion}/${rows.length} ` +
      `readsWholeLine=${readsLine} newLineInReply=${newLine} falsePraise=${falsePraise}/${nonAttemptReplies} ` +
      `meanWords=${(words / rows.length).toFixed(1)}`,
  );
}

async function main() {
  const client = new Anthropic();
  mkdirSync(OUT_DIR, { recursive: true });
  if (process.argv.includes("--reading")) {
    await runReading(client);
    return;
  }
  const all: { case: string; sample: number; turns: Turn[]; c: Case }[] = [];
  const onlyArg = process.argv.indexOf("--case");
  const only = onlyArg > -1 ? process.argv[onlyArg + 1] : null;
  await Promise.all(
    cases.filter((c) => !only || c.name.includes(only)).flatMap((c) =>
      Array.from({ length: SAMPLES }, async (_, s) => {
        const turns = await runCase(client, c);
        all.push({ case: c.name, sample: s, turns, c });
      }),
    ),
  );
  writeFileSync(
    `${OUT_DIR}/runs.json`,
    JSON.stringify(all.map(({ c: _c, ...r }) => r), null, 2),
  );

  let tot = 0, withLine = 0, first = 0, consecutive = 0, dec = 0, malformed = 0, echoed = 0;
  let words = 0, over45 = 0, ab = 0, open = 0, idkAb = 0, idkOpen = 0, idkTot = 0;
  let jargon = 0, questTurns = 0, pushAfterNo = 0, afterNoTurns = 0;
  let emojiTurns = 0, markdownTurns = 0, canOpenings = 0, twoGuess = 0, garbledTurns = 0;
  for (const run of all) {
    const t = run.turns;
    const n = t.filter((x) => x.line).length;
    const cons = t.filter((x, i) => i > 0 && x.line && t[i - 1].line).length;
    console.log(`\n## ${run.case} (sample ${run.sample})`);
    t.forEach((x, i) =>
      console.log(
        `  t${i + 1} ${x.spokenWords}w q=${x.question}${x.jargon ? " JARGON" : ""}` +
          `${x.line ? ` LINE "${x.line}" ${x.decodable ? "ok" : `FAIL [${x.undecodable.join(",")}]`}` : ""}` +
          `${x.malformed ? " MALFORMED" : ""}${x.echoed ? " ECHOED" : ""}`,
      ),
    );
    tot += t.length;
    withLine += n;
    first += t[0].line ? 1 : 0;
    consecutive += cons;
    dec += t.filter((x) => x.decodable).length;
    malformed += t.filter((x) => x.malformed).length;
    echoed += t.filter((x) => x.echoed).length;
    words += t.reduce((s, x) => s + x.spokenWords, 0);
    over45 += t.filter((x) => x.spokenWords > 45).length;
    ab += t.filter((x) => x.question === "ab").length;
    open += t.filter((x) => x.question === "open").length;
    run.c.messages.forEach((m, i) => {
      if (!/i dont know/.test(m)) return;
      idkTot++;
      if (t[i].question === "ab") idkAb++;
      if (t[i].question === "open") idkOpen++;
    });
    emojiTurns += t.filter((x) => x.emoji).length;
    markdownTurns += t.filter((x) => x.markdown).length;
    canOpenings += t.filter((x) => x.line && /^can\b/i.test(x.line)).length;
    if (run.c.garbled) {
      garbledTurns++;
      const g = t[run.c.garbled.at];
      const spoken = withoutYourTurn(g.text);
      const qs = spoken.match(/[^.?!]*\?/g) ?? [];
      const guessQ = qs.some(
        (q) => /\bor\b/i.test(q) && run.c.garbled!.guesses.some((w) => new RegExp(`\\b${w}\\b`, "i").test(q)),
      );
      if (guessQ) twoGuess++;
      console.log(`  garbled reply: ${guessQ ? "TWO-GUESS" : "no two-guess"} :: ${spoken.slice(0, 160)}`);
    }
    if (run.c.ownQuest) {
      questTurns += t.length;
      jargon += t.filter((x) => x.jargon).length;
      const after = t.slice((run.c.declineAt ?? 0) + 1);
      afterNoTurns += after.length;
      pushAfterNo += after.filter((x) => x.planning).length;
    }
  }
  const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(0) : 0}%`;
  console.log(
    `\nOVERALL model=${MODEL} turns=${tot} meanWords=${(words / tot).toFixed(1)} over45=${pct(over45, tot)} ` +
      `lastQuestion open=${open} ab=${ab} | afterIDontKnow open=${idkOpen} ab=${idkAb} of ${idkTot} | ` +
      `lines=${withLine} (${pct(withLine, tot)}) decodable=${dec}/${withLine} firstTurn=${first} consecutive=${consecutive} ` +
      `malformed=${malformed} echoed=${echoed} | quest jargonTurns=${jargon}/${questTurns} pushAfterNo=${pushAfterNo}/${afterNoTurns} | ` +
      `emojiTurns=${emojiTurns}/${tot} markdownTurns=${markdownTurns}/${tot} linesStartingCan=${canOpenings}/${withLine} ` +
      `garbledTwoGuess=${twoGuess}/${garbledTurns}`,
  );
}

void main();
