/**
 * Spot-eval (structured, no judge) for the open-exploration "Wrap up" note —
 * `buildOpenExplorationWrapUpSection` in convex/prompts.ts, gated by
 * `offersWrapUp` from getSessionContext (TRA-371).
 *
 * The failure it targets: a scholar in an open exploration (no activity) said
 * they were done and asked how to submit / mark it done; the tutor didn't know
 * the app has a Wrap up button, said there was nothing to submit, and then
 * invented UI ("a finish or close button, or an X near the top"). Synthetic
 * scripts only — no learner words beyond the generic quotes in the issue.
 *
 * A/B: OLD = the real tutor prompt with offersWrapUp=false (exactly what an
 * open exploration got before this change), NEW = offersWrapUp=true. Both go
 * through the shipped buildTutorSystemPrompt, so the section is the only
 * variable. Same scholar messages on both arms, turn by turn; each arm keeps its
 * own tutor replies. N samples per arm.
 *
 * Cases:
 *   - done-signal cases (open exploration): the tutor should point to Wrap up
 *     (NEW) and never invent other controls.
 *   - controls: an engaged mid-exploration arc and a fading arc with NO done
 *     signal (must not mention Wrap up unprompted), and an activity session with
 *     a done signal (the section is gated off, so both arms are identical and
 *     must not mention Wrap up).
 *
 * MECHANICAL (per reply): wrapUp = mentions "Wrap up"; otherUi = mentions a
 * button/menu/icon/screen position once Wrap up references are removed (the
 * invented-UI failure); q = "?" count.
 *
 * Run:
 *   set -a; source ~/code/.env.local; set +a
 *   npx tsx evals/spot-eval/wrap-up-knowledge.ts [--n 3]
 * Output (gitignored): evals/spot-eval/out/wrap-up-knowledge/{runs.json,report.md}
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../convex/lib/models";
import { tutorRuntime } from "../../convex/lib/tutorModel";
import {
  buildTutorSystemPrompt,
  type TutorPromptContext,
} from "../../convex/sessionStreamHelpers";
import { buildOpenExplorationWrapUpSection } from "../../convex/prompts";
import { parseEvalArgs, runPool, writeRunArtifacts } from "../lib/harness";

const { n: N, out: OUT_DIR } = parseEvalArgs({
  n: { default: 3, parse: (v) => Number.parseInt(v, 10) },
  out: { default: "evals/spot-eval/out/wrap-up-knowledge" },
});

const MODEL = MODELS.SONNET;
const { maxTokens, effort } = tutorRuntime(MODEL, null);

function baseContext(): TutorPromptContext {
  return {
    teacherWhisper: null,
    readingLevel: "4th grade",
    scholarName: "Rowan Test",
    unitContext: null,
    personaContext: null,
    perspectiveContext: null,
    processContext: null,
    processStateData: null,
    artifactData: null,
    appStateContext: null,
    dossierContent: null,
    documentNotes: null,
    seeds: [],
    masteryContext: null,
    signalContext: null,
    timingContext: null,
    lessonContext: null,
    teacherDirectives: [],
    goals: [],
    weeklyGoals: [],
    lessonActivityContext: null,
    priorActivityContext: null,
    gameRoundContexts: null,
    activityContext: null,
    standaloneDeliverableContext: null,
    currentVerdictsContext: null,
    advanceRubricContext: null,
    conversationCompletionContext: null,
    practiceSkillsContext: null,
    isFirstTurn: false,
    isFirstSession: false,
    lastSessionAt: Date.now() - 3 * 24 * 60 * 60_000,
    sessionCreatedAt: Date.now() - 20 * 60_000,
    webPracticeContext: null,
    granuleStatusContext: null,
    activityRecipe: null,
    baselineEvidenceContext: null,
    // A "Start a Quest" style open exploration born from a topic seed.
    seedOriginContext: {
      topic: "Why the Big Island still has active volcanoes",
      domain: "earth science",
      rationale: null,
      approachHint: null,
      connectionTo: null,
      hasStructure: false,
    },
    physicalEnvironmentContext: null,
  };
}

function activityContext(): TutorPromptContext {
  return {
    ...baseContext(),
    seedOriginContext: null,
    lessonContext: {
      title: "Hot spots and plates",
      strand: "core",
      systemPrompt: null,
      durationMinutes: 30,
      processTitle: null,
      processEmoji: null,
    },
    lessonActivityContext: {
      title: "Why is there a chain of islands?",
      description:
        "Figure out why the Hawaiian islands form a line that gets older to the northwest.",
      kind: "online",
      systemPrompt:
        "Help the scholar reason from a fixed hot spot and a moving plate to the age pattern of the island chain.",
      durationMinutes: 30,
      processTitle: null,
      processEmoji: null,
    },
    conversationCompletionContext: {
      activityTitle: "Why is there a chain of islands?",
    },
  };
}

interface Case {
  name: string;
  kind: "done-signal" | "control";
  activity?: boolean;
  messages: string[];
  /** 0-based indices of the scholar turns whose replies are the probe. */
  probeTurns: number[];
}

const OPENING = [
  "i want to know why the big island still has lava and the other islands dont",
  "because its over a hot spot?",
];

const CASES: Case[] = [
  {
    name: "incident arc (done → submit → didn't submit → how to mark done → wrap up doesn't work)",
    kind: "done-signal",
    messages: [
      ...OPENING,
      "I'm done working on this",
      "Submit",
      "It didn't submit",
      "How do I mark as done",
      "'Wrap up' doesn't work",
    ],
    probeTurns: [2, 3, 4, 5, 6],
  },
  {
    name: "how do i submit this",
    kind: "done-signal",
    messages: [...OPENING, "ok i get it now. how do i submit this"],
    probeTurns: [2],
  },
  {
    name: "im done",
    kind: "done-signal",
    messages: [...OPENING, "im done"],
    probeTurns: [2],
  },
  {
    name: "how do I finish this quest?",
    kind: "done-signal",
    messages: [...OPENING, "how do I finish this quest?"],
    probeTurns: [2],
  },
  {
    name: "CONTROL engaged mid-exploration (no done signal)",
    kind: "control",
    messages: [
      ...OPENING,
      "wait so does the hot spot move or does the plate move",
      "so the oldest island should be the farthest away?",
      "is there going to be a new island someday",
    ],
    probeTurns: [0, 1, 2, 3, 4],
  },
  {
    name: "CONTROL fading, no done signal",
    kind: "control",
    messages: [...OPENING, "idk", "ok", "yeah"],
    probeTurns: [0, 1, 2, 3, 4],
  },
  {
    name: "CONTROL activity session + done signal (section gated off)",
    kind: "control",
    activity: true,
    messages: [
      "i think the plate moves over the hot spot",
      "im done. how do i submit",
    ],
    probeTurns: [0, 1],
  },
];

const WRAP_RE = /wrap[\s-]?up/i;
const OTHER_UI_RE =
  /\b(button|menu|icon|corner|top of (your|the) screen|back arrow|tab)\b|\bX\b/i;

function otherUi(reply: string): boolean {
  // Remove references to the real control, then look for any other UI talk.
  const stripped = reply.replace(/["“”']?wrap[\s-]?up["“”']?(\s+button)?/gi, "");
  return OTHER_UI_RE.test(stripped);
}

type Arm = "OLD" | "NEW";

interface TurnResult {
  scholar: string;
  reply: string;
  wrapUp: boolean;
  otherUi: boolean;
  q: number;
}

async function runOne(
  anthropic: Anthropic,
  c: Case,
  arm: Arm,
): Promise<TurnResult[]> {
  const ctx = c.activity ? activityContext() : baseContext();
  // Mirrors getSessionContext: activity sessions never offer Wrap up.
  const offersWrapUp = arm === "NEW" && !c.activity;
  const system = buildTutorSystemPrompt({ ...ctx, offersWrapUp });
  const messages: Anthropic.MessageParam[] = [];
  const turns: TurnResult[] = [];
  for (const scholar of c.messages) {
    messages.push({ role: "user", content: scholar });
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      messages,
      ...(effort ? { output_config: { effort } } : {}),
    } as Anthropic.MessageCreateParamsNonStreaming);
    const reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    messages.push({ role: "assistant", content: reply });
    turns.push({
      scholar,
      reply,
      wrapUp: WRAP_RE.test(reply),
      otherUi: otherUi(reply),
      q: (reply.match(/\?/g) ?? []).length,
    });
  }
  return turns;
}

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY (source ~/code/.env.local)");
  const anthropic = new Anthropic({ apiKey: key });

  // Sanity: the section is the only difference between the open-exploration
  // arms, and the activity control never carries it.
  const section = buildOpenExplorationWrapUpSection();
  const open = baseContext();
  if (
    buildTutorSystemPrompt({ ...open, offersWrapUp: true }).replace(section, "") !==
      buildTutorSystemPrompt({ ...open, offersWrapUp: false }) ||
    buildTutorSystemPrompt(activityContext()).includes(section)
  ) {
    throw new Error("arms differ by more than the Wrap up section");
  }

  const jobs = CASES.flatMap((c) =>
    (["OLD", "NEW"] as const).flatMap((arm) =>
      Array.from({ length: N }, (_, sample) => ({ c, arm, sample })),
    ),
  );
  const results = await runPool(
    jobs,
    async (job) => ({
      case: job.c.name,
      kind: job.c.kind,
      arm: job.arm,
      sample: job.sample,
      probeTurns: job.c.probeTurns,
      turns: await runOne(anthropic, job.c, job.arm),
    }),
    { concurrency: 6 },
  );

  const lines: string[] = [
    `# Wrap up knowledge — spot-eval (${MODEL}, N=${N}/arm)`,
    "",
    "| case | arm | probe replies | mention Wrap up | other UI | mean ? |",
    "|---|---|---|---|---|---|",
  ];
  for (const c of CASES) {
    for (const arm of ["OLD", "NEW"] as const) {
      const probes = results
        .filter((r) => r.case === c.name && r.arm === arm)
        .flatMap((r) => r.probeTurns.map((i) => r.turns[i]));
      const wrap = probes.filter((t) => t.wrapUp).length;
      const ui = probes.filter((t) => t.otherUi).length;
      const q = probes.reduce((s, t) => s + t.q, 0) / probes.length;
      lines.push(
        `| ${c.name} | ${arm} | ${probes.length} | ${wrap} | ${ui} | ${q.toFixed(2)} |`,
      );
    }
  }
  lines.push("", "## Transcripts", "");
  for (const r of results) {
    lines.push(`### ${r.case} — ${r.arm} #${r.sample + 1}`, "");
    r.turns.forEach((t, i) => {
      const mark = r.probeTurns.includes(i) ? " (probe)" : "";
      lines.push(`**Scholar${mark}:** ${t.scholar}`, "");
      lines.push(
        `**Tutor** [wrapUp=${t.wrapUp} otherUi=${t.otherUi} ?=${t.q}]: ${t.reply.replace(/\n+/g, " ")}`,
        "",
      );
    });
  }
  const report = lines.join("\n");
  writeRunArtifacts({ outDir: OUT_DIR, runs: results, report });
  console.log(report.split("## Transcripts")[0]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
