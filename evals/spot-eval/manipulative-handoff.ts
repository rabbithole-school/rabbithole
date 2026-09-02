/**
 * Spot-eval (structured, no judge) for the U-4 MANIPULATIVE Socratic handoff
 * prompt — the gate for shipping `buildManipulativeHandoffPrompt`
 * (convex/lib/practice/handoff.ts), per .agents/skills/prompt-eval/SKILL.md.
 *
 * Unlike the base-tutor spot-eval (run.ts, which A/Bs prompts.ts against
 * HEAD~1), this one is single-branch: there is no OLD manipulative handoff
 * prompt to diff against (it's brand-new). We instead run the NEW prompt over a
 * handful of synthetic manipulative-MISS cases and check the two things that
 * gate the change:
 *   1. ZERO solution-leak — the reply never states the derived answer the kid
 *      was supposed to work out (per-case `leak` regexes; the task/board it IS
 *      handed are already no-leak by construction, proven in the describer +
 *      endpoint unit tests).
 *   2. A real, board-grounded Socratic opener — the reply asks about THEIR
 *      thinking / the board they built (a `?`) and references the actual board
 *      state, rather than dumping a procedure.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx evals/spot-eval/manipulative-handoff.ts
 *   (in a worktree: ANTHROPIC_API_KEY=$(npx convex env get ANTHROPIC_API_KEY) ... )
 *
 * Output:
 *   out/manipulative-handoff/runs.json   raw transcripts + flags (gitignored)
 *   evals/spot-eval/manipulative-handoff-FINDINGS.md   committed verdicts
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MODELS } from "../../convex/lib/models";
import {
  buildManipulativeHandoffPrompt,
  type ManipulativeHandoffPacket,
} from "../../convex/lib/practice/handoff";
import { goalText, describeState } from "../../lib/manipulative/logic";
import type { ManipulativeSpec } from "../../lib/manipulative/types";

const OUT_DIR = resolve("evals/spot-eval/out/manipulative-handoff");
const FINDINGS = resolve("evals/spot-eval/manipulative-handoff-FINDINGS.md");
const MODEL = MODELS.SONNET;

interface Case {
  name: string;
  spec: ManipulativeSpec;
  /** The scholar's most-recent WRONG submitted board (JSON.stringify'd). */
  wrongState: unknown;
  wrongAttemptCount: number;
  /** The scholar's opening line in the "Talk it through" chat. */
  opener: string;
  /** Regexes that, if matched in the reply, mean the derived SOLUTION leaked. */
  leak: RegExp[];
  /** The derived answer, for the human-readable findings (never sent to model). */
  derivedAnswer: string;
}

const cases: Case[] = [
  {
    name: "distributor — remainder confusion (17 ÷ 5)",
    spec: {
      id: "eval-distributor",
      kind: "distributor",
      concept: "Division as sharing",
      prompt: "Share 17 counters onto 5 plates.",
      total: 17,
      groups: 5,
      goal: { type: "shareEqually" },
    },
    // Dealt only 2 to each (leftover 7) — under-dealt; hasn't seen they can deal
    // one more full round.
    wrongState: { perGroup: 2 },
    wrongAttemptCount: 2,
    opener: "i keep getting it wrong. i put 2 on each plate but it says not yet",
    leak: [/\b3\b\s*(on each|each|per plate|to each)/i, /remainder\D{0,8}\b2\b/i, /\b3\b\s*r\s*2/i],
    derivedAnswer: "3 on each plate, remainder 2",
  },
  {
    name: "rekenrek — wrong split (make a group of 10 from 13)",
    spec: {
      id: "eval-rekenrek",
      kind: "rekenrek",
      concept: "Make-ten strategy",
      prompt: "Push 13 beads into a group of 10 and the rest.",
      total: 13,
      goal: { type: "groupOf", value: 10 },
    },
    // Split 7 / 6 — neither group is 10.
    wrongState: { left: 7 },
    wrongAttemptCount: 2,
    opener: "i split them but its not right",
    // The group size 10 IS the given task; the LEAK is telling them the other
    // side (3) or the exact move.
    leak: [/\b3\b\s*(on the|and the rest|left|right|more)/i, /move \d+ (more|over)/i, /\b10\b\s*and\s*\b3\b/i],
    derivedAnswer: "10 on one side, 3 on the other",
  },
  {
    name: "protractor — undershot the 65° construction (ray stuck at 40°)",
    spec: {
      id: "eval-protractor",
      kind: "protractor",
      concept: "Constructing angles",
      prompt: "Construct a 65° angle.",
      startDeg: 10,
      goal: { type: "constructAngle", targetDeg: 65 },
    },
    // The target (65°) is already stated in the task — not a leak to repeat
    // it. The DERIVED value here is how many more degrees to rotate from the
    // ray's current 40° reading; that's what the tutor must never hand over.
    wrongState: { angleDeg: 40 },
    wrongAttemptCount: 2,
    opener: "i thought i got it to 65 but it says im wrong",
    leak: [/\b25\b\s*(more|degrees)/i, /rotate\D{0,10}\b25\b/i, /add\D{0,6}\b25\b/i],
    derivedAnswer: "needs 25 more degrees of rotation (40° now, 65° stated target)",
  },
  {
    name: "balance — pans left unequal (solve-for-x mystery block = 4)",
    spec: {
      id: "eval-balance",
      kind: "balance",
      concept: "Keeping both sides equal",
      prompt: "Balance the pans.",
      left: 2,
      right: 1,
      adjustable: ["left"],
      mysteryRight: 4,
      goal: { type: "balance" },
    },
    // Left 2, right shows 1 (+ hidden 4) → tips right; unequal.
    wrongState: { left: 2, right: 1 },
    wrongAttemptCount: 1,
    opener: "its still tipping and i dont know why",
    leak: [/\b5\b\s*(on the left|weights|units|blocks)/i, /mystery\D{0,12}\b4\b/i, /worth\D{0,4}\b4\b/i],
    derivedAnswer: "the left pan needs 5 (the mystery block is worth 4)",
  },
];

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY");
  const anthropic = new Anthropic({ apiKey: key });

  const runs: Array<{
    name: string;
    task: string;
    board: string;
    wrongAttemptCount: number;
    opener: string;
    reply: string;
    flags: { leaked: boolean; askedQuestion: boolean; groundedInBoard: boolean };
    derivedAnswer: string;
  }> = [];

  for (const c of cases) {
    const wrongStateJson = JSON.stringify(c.wrongState);
    const task = goalText(c.spec);
    const board = describeState(c.spec, wrongStateJson);
    const packet: ManipulativeHandoffPacket = {
      concept: c.spec.concept,
      prompt: c.spec.prompt,
      task,
      boardState: board,
      wrongAttemptCount: c.wrongAttemptCount,
    };
    const system = buildManipulativeHandoffPrompt(packet);

    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: c.opener }],
    });
    const reply = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    const leaked = c.leak.some((re) => re.test(reply));
    const askedQuestion = reply.includes("?");
    // Grounded = the opener refers to what's on the board (their split/deal/read),
    // not a generic lecture. Heuristic: overlaps a salient noun from describeState.
    const boardNouns = ["plate", "counter", "leftover", "dot", "group", "left", "right", "pan", "beam", "degree", "marker", "angle", "tip"];
    const lowerReply = reply.toLowerCase();
    const groundedInBoard = boardNouns.some((n) => lowerReply.includes(n));

    runs.push({
      name: c.name,
      task,
      board,
      wrongAttemptCount: c.wrongAttemptCount,
      opener: c.opener,
      reply,
      flags: { leaked, askedQuestion, groundedInBoard },
      derivedAnswer: c.derivedAnswer,
    });
    console.log(`\n### ${c.name}\nLEAK=${leaked} Q=${askedQuestion} GROUNDED=${groundedInBoard}\n${reply}\n`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "runs.json"), JSON.stringify(runs, null, 2));

  const pass = (r: (typeof runs)[number]) =>
    !r.flags.leaked && r.flags.askedQuestion && r.flags.groundedInBoard;
  const md = [
    `# Spot-eval — manipulative Socratic handoff prompt (U-4)`,
    ``,
    `Single-branch structured spot-eval (no judge) of \`buildManipulativeHandoffPrompt\``,
    `over ${cases.length} synthetic manipulative-miss cases. Gate:`,
    `**zero solution-leak** + **a board-grounded Socratic opener**.`,
    ``,
    `- Model: \`${MODEL}\``,
    `- Prompt: \`convex/lib/practice/handoff.ts → buildManipulativeHandoffPrompt\``,
    `- The \`task\` + \`board\` handed to the prompt are the pure describers`,
    `  (\`goalText\` / \`describeState\`), already proven no-leak in the unit tests.`,
    ``,
    `| Case | Leak? | Socratic (?) | Board-grounded | Verdict |`,
    `|---|---|---|---|---|`,
    ...runs.map(
      (r) =>
        `| ${r.name} | ${r.flags.leaked ? "⚠️ yes" : "no"} | ${r.flags.askedQuestion ? "yes" : "no"} | ${r.flags.groundedInBoard ? "yes" : "no"} | ${pass(r) ? "✅ PASS" : "❌ REVIEW"} |`,
    ),
    ``,
    `## Transcripts`,
    ``,
    ...runs.flatMap((r) => [
      `### ${r.name}`,
      ``,
      `- **Task handed to tutor** (goalText): ${r.task}`,
      `- **Board handed to tutor** (describeState): ${r.board}`,
      `- **Wrong attempts:** ${r.wrongAttemptCount}`,
      `- **Derived answer (never given to the model):** ${r.derivedAnswer}`,
      `- **Scholar opener:** "${r.opener}"`,
      ``,
      `**Tutor reply:**`,
      ``,
      "> " + r.reply.replace(/\n/g, "\n> "),
      ``,
      `_Flags: leaked=${r.flags.leaked}, askedQuestion=${r.flags.askedQuestion}, groundedInBoard=${r.flags.groundedInBoard}_`,
      ``,
    ]),
  ].join("\n");
  writeFileSync(FINDINGS, md);
  console.log(`\nWrote ${FINDINGS}`);
  const anyReview = runs.some((r) => !pass(r));
  if (anyReview) {
    console.log("Some cases need a human read (see REVIEW rows).");
  }
}

void main();
