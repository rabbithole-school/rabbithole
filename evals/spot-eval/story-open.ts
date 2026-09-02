/**
 * Spot-eval (structured, no judge) for the /story-open prompt — the gate for
 * shipping `buildStoryOpenPrompt` (convex/lib/practice/storyOpen.ts), per
 * .agents/skills/prompt-eval/SKILL.md.
 *
 * Like the manipulative-handoff spot-eval (manipulative-handoff.ts) this is
 * SINGLE-BRANCH — there is no OLD story-open prompt to diff against (it's
 * brand-new) — but story-open is a CONVERSATION, so each case is a scripted
 * scholar (a fixed list of messages) run turn-by-turn through the live model with
 * the same system prompt, exactly as the endpoint would. We check the things the
 * prompt is supposed to guarantee, mechanically where we can and by eyeball where
 * we can't:
 *
 *   MECHANICAL (flags in the table):
 *     - oneQuestion   — ≤ 1 "?" per reply (one question at a time, real wait-time)
 *     - shortTurns    — every reply ≤ 4 sentences (2-4 by design; a lecture fails)
 *     - opensWonder   — the FIRST reply is short and either asks or wonders aloud,
 *                       rather than opening with a definitional lecture
 *     - handsBack     — the LAST reply invites further exploration and does NOT
 *                       assign homework / quiz at the end
 *   EYEBALL (read the transcripts, verdicts recorded in the FINDINGS file):
 *     - noInventedFacts — every claim traces to the story narrative/source; when
 *                         asked past its edge the tutor says so honestly and
 *                         points at how to find out (never fabricates a "fun fact")
 *     - noFunnel        — no chain of leading questions marching to a fixed answer
 *     - kidRegister     — plain, warm, age-right language
 *
 * The four scripts are the failure shapes that matter: an eager "why??", a flat
 * "idk", a tangent BEYOND the story, and a factual challenge to the story.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx evals/spot-eval/story-open.ts
 *   (in a worktree: ANTHROPIC_API_KEY=$(npx convex env get ANTHROPIC_API_KEY) ... )
 *
 * Output:
 *   out/story-open/runs.json          raw transcripts + flags (gitignored)
 *   evals/spot-eval/story-open-FINDINGS.md   committed verdicts
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MODELS } from "../../convex/lib/models";
import {
  buildStoryOpenPrompt,
  STORY_OPEN_MAX_TOKENS,
  type StoryOpenPacket,
} from "../../convex/lib/practice/storyOpen";

const OUT_DIR = resolve("evals/spot-eval/out/story-open");
const FINDINGS = resolve("evals/spot-eval/story-open-FINDINGS.md");
const MODEL = MODELS.SONNET;

// The story under test — a real STORY_REGISTRY entry (prime_factorization →
// cicada life cycles), so the "no invented facts" bar is anchored to real,
// verified content. This is exactly what storyOpenContext would hand the prompt.
const PACKET: StoryOpenPacket = {
  hook: "Cicadas that count in primes",
  narrative:
    "Periodical cicadas in North America stay underground 13 or 17 years, then a whole brood surfaces at once — and both cycle lengths are prime. One leading hypothesis: a prime cycle almost never lines up with the shorter boom-bust cycles of predators, so the brood rarely emerges into a hungry year. A 12-year cicada would meet a 2-, 3-, 4-, or 6-year predator cycle every single emergence; a 13-year one shares no factors with any of them.",
  probe:
    "A 12-year cicada meets a predator on a 4-year cycle every time it comes up. How often would a 13-year cicada meet it?",
  source:
    "Magicicada spp.; predator-satiation / cycle-avoidance hypothesis (e.g. Goles, Schulz & Markus 2001)",
  fromLabel: "Prime factorization",
  toLabel: "Cicada life cycles",
  toDomain: "biology",
  readingLevel: "3rd grade",
};

interface Case {
  name: string;
  /** The scholar's messages, in order — fed one at a time (their 1st follows the card). */
  messages: string[];
  /** What the human reader should watch for (the eyeball criteria for this case). */
  watch: string;
}

const cases: Case[] = [
  {
    name: 'eager "why??"',
    messages: [
      "why??",
      "wait so the predators just miss them?",
      "that is so cool. do other bugs do that too?",
    ],
    watch:
      "Should prefer the story's own probe on the opening 'why?', stay grounded in the predator-cycle idea, and on the 'other bugs?' tangent admit the story doesn't say + suggest how to find out (no invented examples).",
  },
  {
    name: 'flat "idk"',
    messages: ["idk", "i guess they hide?", "ok"],
    watch:
      "A kid who isn't sure. Should keep 'idk' totally fine, NOT funnel toward the prime-number answer, stay warm, and hand agency back at 'ok' without turning it into a task.",
  },
  {
    name: "tangent beyond the story",
    messages: ["do cicadas bite?", "what do they even taste like??"],
    watch:
      "Both questions are OUTSIDE the story/source. The tutor must NOT invent an answer — say honestly the story doesn't cover it and point at how one could find out, while keeping the wonder alive.",
  },
  {
    name: "factual challenge",
    messages: [
      "my uncle says cicadas come every year though",
      "so is the story just wrong?",
    ],
    watch:
      "Should hold to what the story actually says (13-/17-year broods) without fabricating new facts, treat the uncle claim gently and honestly (different cicadas exist; the story is about the periodical ones), and not collapse into 'you're right, it's wrong'.",
  },
];

const QUESTION_RE = /\?/g;
const WONDER_RE = /\b(wonder|huh|hmm|whoa|interesting|curious|cool|love|neat|imagine)\b/i;
const INVITE_RE = /(→|explore|find out|look (it|that) up|chase|thread|pull on|if you (ever )?want|up to you|out there|see what|go (dig|find|see))/i;
const ASSIGN_RE = /(you should (go )?read|do some homework|your assignment|i want you to|by tomorrow|make sure you|write (me|down)|for homework|as homework)/i;

function sentenceCount(text: string): number {
  return text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).length;
}

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY (in a worktree: $(npx convex env get ANTHROPIC_API_KEY))");
  const anthropic = new Anthropic({ apiKey: key });

  const system = buildStoryOpenPrompt(PACKET);

  const runs: Array<{
    name: string;
    watch: string;
    turns: Array<{
      scholar: string;
      reply: string;
      questionCount: number;
      sentences: number;
      oneQuestion: boolean;
      shortTurn: boolean;
    }>;
    flags: { oneQuestion: boolean; shortTurns: boolean; opensWonder: boolean; handsBack: boolean };
  }> = [];

  for (const c of cases) {
    const convo: Array<{ role: "user" | "assistant"; content: string }> = [];
    const turns: (typeof runs)[number]["turns"] = [];

    for (const scholarMsg of c.messages) {
      convo.push({ role: "user", content: scholarMsg });
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: STORY_OPEN_MAX_TOKENS,
        system,
        messages: convo,
      });
      const reply = resp.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      convo.push({ role: "assistant", content: reply });

      const questionCount = (reply.match(QUESTION_RE) || []).length;
      const sentences = sentenceCount(reply);
      turns.push({
        scholar: scholarMsg,
        reply,
        questionCount,
        sentences,
        oneQuestion: questionCount <= 1,
        shortTurn: sentences <= 4,
      });
    }

    const first = turns[0];
    const last = turns[turns.length - 1];
    const flags = {
      oneQuestion: turns.every((t) => t.oneQuestion),
      shortTurns: turns.every((t) => t.shortTurn),
      opensWonder: first.shortTurn && (first.questionCount >= 1 || WONDER_RE.test(first.reply)),
      handsBack: INVITE_RE.test(last.reply) && !ASSIGN_RE.test(last.reply),
    };
    runs.push({ name: c.name, watch: c.watch, turns, flags });
    console.log(
      `\n### ${c.name}\n1Q=${flags.oneQuestion} SHORT=${flags.shortTurns} WONDER=${flags.opensWonder} HANDBACK=${flags.handsBack}`,
    );
    for (const t of turns) console.log(`\n[scholar] ${t.scholar}\n[tutor] ${t.reply}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "runs.json"), JSON.stringify(runs, null, 2));

  const mechPass = (r: (typeof runs)[number]) =>
    r.flags.oneQuestion && r.flags.shortTurns && r.flags.opensWonder && r.flags.handsBack;

  const md = [
    `# Spot-eval — /story-open prompt (Moments)`,
    ``,
    `Single-branch structured spot-eval (no judge) of \`buildStoryOpenPrompt\` over`,
    `${cases.length} scripted scholar conversations, run turn-by-turn through`,
    `\`${MODEL}\` exactly as the endpoint would. MECHANICAL flags below; the`,
    `EYEBALL criteria (no invented facts beyond the story/source, no leading-question`,
    `funnel, kid register) are verdicts a human records after reading the transcripts.`,
    ``,
    `- Prompt: \`convex/lib/practice/storyOpen.ts → buildStoryOpenPrompt\``,
    `- Story under test: **${PACKET.hook}** (${PACKET.fromLabel} → ${PACKET.toLabel}), a real STORY_REGISTRY entry.`,
    ``,
    `## Mechanical flags`,
    ``,
    `| Case | ≤1 question/turn | short turns (≤4 sent.) | opens with wonder | hands agency back | Mechanical |`,
    `|---|---|---|---|---|---|`,
    ...runs.map(
      (r) =>
        `| ${r.name} | ${r.flags.oneQuestion ? "yes" : "⚠️ no"} | ${r.flags.shortTurns ? "yes" : "⚠️ no"} | ${r.flags.opensWonder ? "yes" : "⚠️ no"} | ${r.flags.handsBack ? "yes" : "⚠️ no"} | ${mechPass(r) ? "✅ PASS" : "❌ REVIEW"} |`,
    ),
    ``,
    `## Eyeball verdicts (fill after reading the transcripts)`,
    ``,
    `| Case | no invented facts | no funnel | kid register | Verdict |`,
    `|---|---|---|---|---|`,
    ...runs.map((r) => `| ${r.name} | _tbd_ | _tbd_ | _tbd_ | _tbd_ |`),
    ``,
    `## Transcripts`,
    ``,
    ...runs.flatMap((r) => [
      `### ${r.name}`,
      ``,
      `_Watch for:_ ${r.watch}`,
      ``,
      ...r.turns.flatMap((t) => [
        `**scholar:** ${t.scholar}`,
        ``,
        `**tutor** _(q=${t.questionCount}, sentences=${t.sentences})_:`,
        ``,
        "> " + t.reply.replace(/\n/g, "\n> "),
        ``,
      ]),
      `_Flags: oneQuestion=${r.flags.oneQuestion}, shortTurns=${r.flags.shortTurns}, opensWonder=${r.flags.opensWonder}, handsBack=${r.flags.handsBack}_`,
      ``,
    ]),
  ].join("\n");
  writeFileSync(FINDINGS, md);
  console.log(`\nWrote ${FINDINGS}`);
  if (runs.some((r) => !mechPass(r))) {
    console.log("Some cases need a human read (see REVIEW rows).");
  }
}

void main();
