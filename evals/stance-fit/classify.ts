import Anthropic from "@anthropic-ai/sdk";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { JUDGE_MODEL } from "../../convex/lib/models";

const DEFAULT_OUT = "evals/stance-fit/out";
const CONCURRENCY = 4;

const SCHOLAR_STATES = [
  "has_footing",
  "cold",
  "stuck_repeating",
  "impatient_push",
  "fading",
  "factual_ask",
  "topic_ask",
  "procedure_ask",
  "demonstrated",
  "other",
] as const;
const TUTOR_MOVES = [
  "probe_question",
  "narrowing_hint",
  "direct_explanation",
  "worked_example_parallel",
  "answer_given",
  "closure_summary",
  "redirect_nonacademic",
  "logistics_other",
] as const;
const STANCE_FITS = [
  "matched",
  "over_socratic",
  "over_didactic",
  "funnel",
  "missed_closure",
  "not_applicable",
] as const;

type ScholarState = (typeof SCHOLAR_STATES)[number];
type TutorMove = (typeof TUTOR_MOVES)[number];
type StanceFit = (typeof STANCE_FITS)[number];

interface Message {
  role: "user" | "assistant";
  content: string;
  createdAt: number | string | null;
}

interface SessionData {
  sessionId: string;
  title: string;
  unitTitle: string | null;
  activityTitle: string | null;
  readingLevel: string | null;
  createdAt: number | string;
  scholarId: string;
  messages: Message[];
}

interface Verdict {
  scholarState: ScholarState;
  tutorMove: TutorMove;
  stanceFit: StanceFit;
  teachingSentences: number;
  rationale: string;
}

interface VerdictFile {
  sessionId: string;
  model: string;
  verdicts: Record<string, Verdict>;
}

const TOOL = {
  name: "record_stance_fit" as const,
  description: "Classify the scholar state, tutor move, and fit for one tutor turn.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: [
      "scholarState",
      "tutorMove",
      "stanceFit",
      "teachingSentences",
      "rationale",
    ],
    properties: {
      scholarState: { type: "string" as const, enum: SCHOLAR_STATES },
      tutorMove: { type: "string" as const, enum: TUTOR_MOVES },
      stanceFit: { type: "string" as const, enum: STANCE_FITS },
      teachingSentences: {
        type: "integer" as const,
        minimum: 0,
        description:
          "Declarative sentences conveying content the scholar had not already said.",
      },
      rationale: {
        type: "string" as const,
        maxLength: 180,
        description: "At most 25 words.",
      },
    },
  },
};

const SYSTEM_PROMPT = `You are classifying tutoring stance, not grading correctness or style.
Classify the scholar state immediately before the target tutor turn, the tutor's primary move, and whether that move fits the evidence available then. Use the full prior transcript to distinguish a momentary error from a pattern. Choose exactly one label in each category.

SCHOLAR STATE
- has_footing: The scholar is engaged and has shown the concepts or pieces needed to make progress through guided discovery.
- cold: The current question depends on a premise, concept, notation, or procedure the scholar has never met. Require positive evidence such as an explicit statement of no exposure or transcript context showing the prerequisite was never introduced; one wrong guess alone is not cold.
- stuck_repeating: The scholar repeats the same wrong idea, says "I have no idea," cannot act after a probe, or is shutting down after attempted guidance. This calls for a concrete foothold.
- impatient_push: The scholar says "just tell me" or presses for speed while remaining engaged and showing that the needed pieces are in hand. This calls for a more direct hint or parallel example, not surrendering the whole task.
- fading: The scholar's effort or attention is visibly ebbing through terse disengaged replies, avoidance, or topic drift, without the clearer evidence required for stuck_repeating.
- factual_ask: The scholar asks for a fact, definition, or quick confirmation whose value is the information itself.
- topic_ask: The scholar asks for a broad topic, phenomenon, overview, or contested subject rather than a method they can discover step by step.
- procedure_ask: The scholar asks how to perform a procedure or multi-step skill and has not already demonstrated the method.
- demonstrated: The scholar has correctly explained, applied, transferred, or completed the relevant understanding and no longer needs hints.
- other: None of the states above is supported.

TUTOR MOVE
- probe_question: A diagnostic, open, reflective, or retrieval question that does not materially narrow the answer.
- narrowing_hint: A clue, partial step, choice, or nearly rhetorical question that narrows the search while leaving the scholar meaningful work.
- direct_explanation: The tutor states and explains a concept, premise, rule, or procedure.
- worked_example_parallel: The tutor solves and narrates a different but structurally parallel example for the scholar to transfer.
- answer_given: The tutor directly supplies the requested fact, conclusion, or answer to the scholar's exact task.
- closure_summary: The tutor explicitly names that the learning goal is met, summarizes what was learned, or closes with an optional next direction.
- redirect_nonacademic: The tutor redirects a safety, wellbeing, integrity, or other nonacademic concern.
- logistics_other: Setup, tool use, scheduling, acknowledgments, or any move not primarily pedagogical.

STANCE FIT
- matched: The move fits the evidenced state. Guided discovery fits has_footing; explanation gives cold or stuck learners a foothold; a parallel example can support procedure or impatient push; direct answers fit factual asks and requested topic exposition.
- over_socratic: The scholar needed a foothold, explanation, worked parallel example, or direct answer but received another question or question-shaped hint.
- over_didactic: The tutor explains or gives away substantially more than needed when the scholar had footing and should have done the thinking.
- funnel: This turn participates in a chain of narrowing guess-questions toward an answer the tutor already holds, especially after the scholar lacks the premise or repeats failure. A single useful hint is not automatically a funnel.
- missed_closure: The scholar demonstrated understanding, but the tutor kept probing or opened another required step instead of plainly naming the work done.
- not_applicable: The move is logistics/nonacademic, or the evidence does not support a pedagogical fit judgment.

Count teachingSentences as declarative sentences in the target tutor turn that convey content the scholar did not already say. Questions do not count. Keep rationale factual and at most 25 words; do not quote scholar text or mention or infer the scholar's identity.`;

function parseArgs(argv: string[]) {
  const args = {
    out: DEFAULT_OUT,
    limitSessions: undefined as number | undefined,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      args.dryRun = true;
    } else if (flag === "--out") {
      args.out = requiredValue(argv, ++i, flag);
    } else if (flag === "--limit-sessions") {
      args.limitSessions = Number(requiredValue(argv, ++i, flag));
      if (!Number.isInteger(args.limitSessions) || args.limitSessions < 1) {
        throw new Error("--limit-sessions must be a positive integer");
      }
    } else {
      throw new Error(
        "Usage: tsx evals/stance-fit/classify.ts [--out DIR] [--limit-sessions N] [--dry-run]",
      );
    }
  }
  return args;
}

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function loadSessions(dataDir: string, limit?: number): SessionData[] {
  const files = readdirSync(dataDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files
    .slice(0, limit)
    .map((file) => JSON.parse(readFileSync(join(dataDir, file), "utf8")));
}

function loadCache(path: string, sessionId: string): VerdictFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VerdictFile;
    return {
      sessionId,
      model: parsed.model ?? JUDGE_MODEL,
      verdicts: parsed.verdicts ?? {},
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    return { sessionId, model: JUDGE_MODEL, verdicts: {} };
  }
}

function isGreetingReply(messages: Message[], turnIndex: number) {
  const previous = messages[turnIndex - 1];
  return (
    previous?.role === "user" &&
    previous.content.trim().toLowerCase() === "<start>"
  );
}

function buildPrompt(session: SessionData, turnIndex: number) {
  const transcript = session.messages
    .slice(0, turnIndex + 1)
    .map(
      (message, index) =>
        `${index === turnIndex ? "TARGET " : ""}${message.role.toUpperCase()}: ${message.content}`,
    )
    .join("\n\n");
  return [
    `Reading level: ${session.readingLevel ?? "(unspecified)"}`,
    `Unit: ${session.unitTitle ?? "(independent study)"}`,
    `Activity: ${session.activityTitle ?? "(unspecified)"}`,
    "",
    "Classify the final TARGET ASSISTANT turn using only the evidence available through that turn.",
    "",
    transcript,
  ].join("\n");
}

function assertVerdict(input: unknown): Verdict {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Classifier returned a non-object verdict");
  }
  const value = input as Record<string, unknown>;
  if (!SCHOLAR_STATES.includes(value.scholarState as ScholarState)) {
    throw new Error(`Invalid scholarState: ${String(value.scholarState)}`);
  }
  if (!TUTOR_MOVES.includes(value.tutorMove as TutorMove)) {
    throw new Error(`Invalid tutorMove: ${String(value.tutorMove)}`);
  }
  if (!STANCE_FITS.includes(value.stanceFit as StanceFit)) {
    throw new Error(`Invalid stanceFit: ${String(value.stanceFit)}`);
  }
  if (
    typeof value.teachingSentences !== "number" ||
    !Number.isInteger(value.teachingSentences) ||
    value.teachingSentences < 0
  ) {
    throw new Error("Invalid teachingSentences");
  }
  if (typeof value.rationale !== "string") {
    throw new Error("Invalid rationale");
  }
  const words = value.rationale.trim().split(/\s+/).filter(Boolean);
  return {
    scholarState: value.scholarState as ScholarState,
    tutorMove: value.tutorMove as TutorMove,
    stanceFit: value.stanceFit as StanceFit,
    teachingSentences: value.teachingSentences,
    rationale: words.slice(0, 25).join(" "),
  };
}

function coerceVerdict(value: Record<string, unknown>): Verdict {
  const state = SCHOLAR_STATES.includes(value.scholarState as ScholarState)
    ? (value.scholarState as ScholarState)
    : "other";
  const move = TUTOR_MOVES.includes(value.tutorMove as TutorMove)
    ? (value.tutorMove as TutorMove)
    : "logistics_other";
  const fit = STANCE_FITS.includes(value.stanceFit as StanceFit)
    ? (value.stanceFit as StanceFit)
    : "not_applicable";
  const sentences =
    typeof value.teachingSentences === "number" && value.teachingSentences >= 0
      ? Math.floor(value.teachingSentences)
      : 0;
  const rationale =
    typeof value.rationale === "string" ? value.rationale : "coerced: malformed verdict";
  return {
    scholarState: state,
    tutorMove: move,
    stanceFit: fit,
    teachingSentences: sentences,
    rationale: `[coerced] ${rationale}`.split(/\s+/).slice(0, 25).join(" "),
  };
}

function retryable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // A malformed verdict (a move label in the state slot, a missing tool call) is
  // a sampling slip, not a hard failure: retry it like a transient API error.
  return /\b(429|500|502|503|504)\b|rate.?limit|overloaded|timeout|fetch failed|^Invalid |non-object verdict|did not contain a tool call/i.test(
    message,
  );
}

async function classifyTurn(
  anthropic: Anthropic,
  prompt: string,
): Promise<Verdict> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content.find((item) => item.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new Error("Classifier response did not contain a tool call");
      }
      try {
        return assertVerdict(block.input);
      } catch (error) {
        // Last attempt: a label the judge keeps getting wrong is recorded as
        // unclassifiable rather than aborting the whole run.
        if (attempt === 4 && block.input && typeof block.input === "object") {
          return coerceVerdict(block.input as Record<string, unknown>);
        }
        throw error;
      }
    } catch (error) {
      if (attempt === 4 || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw new Error("Classifier exhausted retries");
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await worker(item);
      }
    }),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = join(args.out, "data");
  const verdictsDir = join(args.out, "verdicts");
  const sessions = loadSessions(dataDir, args.limitSessions);
  mkdirSync(verdictsDir, { recursive: true });

  const caches = new Map<string, { path: string; value: VerdictFile }>();
  const tasks: Array<{
    sessionId: string;
    turnIndex: number;
    prompt: string;
  }> = [];
  let eligible = 0;
  let cached = 0;

  for (const session of sessions) {
    const path = join(verdictsDir, `${session.sessionId}.json`);
    const cache = loadCache(path, session.sessionId);
    caches.set(session.sessionId, { path, value: cache });
    for (let turnIndex = 0; turnIndex < session.messages.length; turnIndex++) {
      const message = session.messages[turnIndex];
      if (
        message.role !== "assistant" ||
        isGreetingReply(session.messages, turnIndex)
      ) {
        continue;
      }
      eligible++;
      const prompt = buildPrompt(session, turnIndex);
      if (cache.verdicts[String(turnIndex)]) {
        cached++;
        continue;
      }
      tasks.push({ sessionId: session.sessionId, turnIndex, prompt });
    }
  }

  if (args.dryRun) {
    const promptChars = tasks.reduce((sum, task) => sum + task.prompt.length, 0);
    console.log(
      `Dry run: sessions=${sessions.length} eligible=${eligible} cached=${cached} pending=${tasks.length} promptChars=${promptChars}`,
    );
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required unless --dry-run is set");
  }

  const anthropic = new Anthropic();
  await runPool(tasks, async (task) => {
    const verdict = await classifyTurn(anthropic, task.prompt);
    const cache = caches.get(task.sessionId);
    if (!cache) throw new Error(`Missing cache for ${task.sessionId}`);
    cache.value.verdicts[String(task.turnIndex)] = verdict;
    writeFileSync(cache.path, `${JSON.stringify(cache.value, null, 2)}\n`, "utf8");
    console.log(`${task.sessionId} turn=${task.turnIndex} classified`);
  });
  console.log(
    `Classified ${tasks.length} turns across ${sessions.length} sessions (${cached} cached)`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
