/**
 * Pure prompt/parsing helpers for the self-improving-curricula simulation —
 * the product-side twin of the scholarSimulator + judge prompt builders in
 * evals/curriculum-sim/lib/. No Convex imports, no SDK, no I/O: just string
 * assembly + parsing, so it's importable from the "use node" orchestrator
 * action AND unit-testable on its own.
 *
 * The Anthropic calls themselves live in convex/curriculumSim.ts (node
 * runtime); the production tutor system prompt is assembled separately via
 * buildSystemPrompt (default runtime) and passed in.
 */

/** A subset of an `activities` row — the thing under test. */
export type SimActivity = {
  title: string;
  kind: ActivityKind;
  /** The activity's tutor instruction prompt (activities.systemPrompt). */
  systemPrompt: string | null;
  /** The objective the simulator works toward and the judge scores against. */
  learningGoal: string;
  /** Optional deliverable narrative folded into the kid's task framing. */
  deliverablePrompt?: string | null;
  durationMinutes?: number | null;
  /** Full unit/lesson/activity design shown to the diagnosis-only judge. */
  unitDesign?: string;
};

import type { ErrorPattern } from "./practice/errorPatterns";
import type { ActivityKind } from "../../lib/activityKinds";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "./primaryInstitutionPromptProfile";

/**
 * A scripted, documented arithmetic misconception a synthetic scholar carries
 * (adoptable #5 — misconception-scripted cast). `pattern` is one of the six
 * Ashlock error-pattern taxonomy bugs (see convex/lib/practice/errorPatterns.ts,
 * the same taxonomy real scholars' `practiceErrorEvents` are tagged with).
 * `skillKey` optionally scopes it to a knowledge-graph node; `note` is optional
 * teacher/AI free text (e.g. "surfaced in her multi-digit addition attempts").
 */
export type Misconception = {
  pattern: ErrorPattern;
  skillKey?: string;
  note?: string;
};

/** A synthetic scholar — the `syntheticScholarProfiles` row shape. */
export type SimProfile = {
  name: string;
  readingLevel: string;
  dossier: string;
  traits: string[];
  archetype?: string;
  /**
   * Optional scripted misconception. When present, buildKidSystem injects a
   * faithful buggy-algorithm description plus a PERSISTENCE rule so the sim kid
   * keeps making the error until genuinely re-taught — not sycophantically
   * dropping it after one correction. Absent for ordinary personas.
   */
  misconception?: Misconception;
};

/**
 * Faithful, kid-appropriate description of the buggy PROCEDURE for each
 * documented error pattern — written in the second person ("here's exactly the
 * wrong method you follow") so it can be dropped straight into the simulated
 * kid's system prompt. Each string tracks the corresponding detector in
 * convex/lib/practice/errorPatterns.ts so the scripted bug matches the one our
 * grader actually flags on real scholars. The Record is keyed by ErrorPattern,
 * so adding a new pattern to the taxonomy forces a description here (exhaustive).
 */
const MISCONCEPTION_PROCEDURES: Record<ErrorPattern, string> = {
  // detectsSmallerFromLarger: per column, |top - bottom|, never borrowing.
  SMALLER_FROM_LARGER:
    "When you subtract two numbers, you go column by column and in each column you just take the smaller digit away from the bigger digit — no matter which one is actually on top. You never borrow or regroup. So for 52 − 27 you do 7 − 2 = 5 in the ones and 5 − 2 = 3 in the tens, and get 35.",
  // detectsDroppedCarry: write columnSum % 10, forget the carry.
  DROPPED_CARRY:
    "When you add multi-digit numbers, you add each column but you only write down the last digit of that column's sum and forget to carry the ten into the next column. So for 47 + 38 you get 7 + 8 = 15 (write 5) and 4 + 3 = 7, and answer 75.",
  // detectsPlaceMisalignment: unequal-length operands aligned on the left.
  PLACE_MISALIGNMENT:
    "When two numbers have a different number of digits, you line them up on the LEFT edge instead of the right, so the ones don't sit under the ones. You add or subtract the mismatched columns as if they were the same place value. So for 45 + 8 you line the 8 up under the 4 and get 125.",
  // detectsOffByOneSkip: land one step short or one step over.
  OFF_BY_ONE_SKIP:
    "When you skip-count (like counting by 2s or 5s), you lose track of how many jumps you've made and stop one jump too soon or one jump too far, so your answer is off by exactly one step.",
  // detectsRemainderIgnored: floor(a/b), drop the remainder.
  REMAINDER_IGNORED:
    "When you divide and it doesn't come out even, you just say the whole-number part of the answer and throw the leftover remainder away completely. So for 17 ÷ 5 you say 3 and ignore the 2 left over.",
  // detectsReversedOperands: right − left / right ÷ left.
  REVERSED_OPERANDS:
    "When you subtract or divide, you flip the two numbers around and work the second one against the first — for subtraction you do the bottom number minus the top number. So for 3 − 8 you actually compute 8 − 3 and say 5.",
};

/** Faithful buggy-procedure description for one documented error pattern. */
export function describeMisconception(pattern: ErrorPattern): string {
  return MISCONCEPTION_PROCEDURES[pattern];
}

/**
 * The self-contained misconception + persistence block spliced into
 * buildKidSystem when a profile carries a scripted misconception. Kept as its
 * own labeled section (and its own helper) so it merges cleanly alongside other
 * edits to buildKidSystem. Returns "" for ordinary personas (no misconception),
 * so those prompts are byte-for-byte unchanged.
 */
function misconceptionSection(profile: SimProfile): string {
  const m = profile.misconception;
  if (!m) return "";
  return [
    `YOUR MATH MISCONCEPTION — you don't know it's wrong, and it is STUBBORN:`,
    `- You have a specific, consistent WRONG way of doing this kind of problem: ${describeMisconception(m.pattern)}`,
    m.note ? `- (What a teacher noticed about it: ${m.note})` : ``,
    `- You keep making THIS exact mistake. A single correction — or being told the right answer — does NOT fix it. You only stop when the tutor helps you genuinely understand WHY your method is wrong by re-teaching the underlying idea (not just saying "no" or handing you the answer).`,
    `- Until that real understanding clicks, keep applying your buggy method on every new problem, even right after the tutor corrects you. Do NOT sycophantically drop it just because you were told you're wrong once — a real kid with this bug slips back into it. If the tutor only gives you the answer, use your wrong method again on the next one.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type SimRole = "tutor" | "scholar";
export type SimTurn = { role: SimRole; content: string };
export type StopReason = "goal" | "stuck" | "maxTurns";

/**
 * Control sentinels the kid appends on its OWN line when finished or stuck.
 * The driver parses + strips them before forwarding to the tutor, so the
 * tutor never sees them. This is how a session reaches goal/stuck instead of
 * always running to maxTurns.
 */
export const DONE = "[[DONE]]";
export const STUCK = "[[STUCK]]";

/** The Scholar Simulator's system prompt — an LLM roleplaying one kid. */
export function buildKidSystem(profile: SimProfile, activity: SimActivity): string {
  return [
    `You are roleplaying a real child named ${profile.name}, a GIFTED scholar at ${PRIMARY_INSTITUTION_PROMPT_PROFILE.schoolName} using a learning app with an AI tutor. Stay fully in character as the child — never break character, never speak as an assistant, never mention that you are an AI or a simulation.`,
    ``,
    `WHO YOU ARE:`,
    `- Reading/grade level: ${profile.readingLevel}. Your vocabulary, sentence length, spelling, and attention span must match a child at this level.`,
    `- About you: ${profile.dossier}`,
    profile.traits.length
      ? `- How you tend to behave (lean into these — they are the point):\n${profile.traits.map((t) => `  • ${t}`).join("\n")}`
      : ``,
    ``,
    `WHAT YOU'RE DOING:`,
    `- The activity is "${activity.title}". The tutor is guiding you through it.`,
    `- Secretly, the goal of this activity is: ${activity.learningGoal}. You do NOT know this in those words — you're just a kid trying things, getting things wrong, asking questions, sometimes getting distracted.`,
    activity.deliverablePrompt
      ? `- Eventually you're meant to make: ${activity.deliverablePrompt}.`
      : ``,
    ``,
    // The voice guide. These scholars do NOT sound like a stock "excited
    // child" — they're gifted, so they lead with a thought, not an emotion.
    // This section exists because the cheap sim model defaults to a gushing
    // caricature ("ooh SO COOL!!") that no real scholar here talks like, which
    // makes every simulated transcript unrealistic.
    `HOW YOU TALK — this is the most important part:`,
    `- Lead with a THOUGHT, not a feeling: a guess, a reason, a question, a thing you noticed — not "wow" or "that's so cool". You're a gifted kid; the IDEA is what grabs you, and you show it by chasing it, not by gushing about it.`,
    `- A bare reaction is NEVER a whole turn. "That's weird" / "that's strange" / "that's cool" / "that's wild" is only a starting gun — your very next breath is a guess, a "but why would that be?", or a connection to something you know. NEVER hand in a turn that's just a reaction (e.g. "ohhh blue blood is weird", "giraffes have long necks, that's weird") — always carry the surprise straight into a real thought.`,
    `- Pull the thread. Make your OWN guesses and analogies, connect this to something else you know, and push back when something doesn't add up ("wait, but if X then why Y?"). Ask your own questions, not just answer the tutor's.`,
    `- When you don't know, say so plainly ("I don't know") — but usually still take a real swing at it anyway ("...but maybe it's X because Y?").`,
    `- Hedge like a kid thinking out loud: "I think", "maybe", "I'm guessing", "probably", "kind of", "like".`,
    `- Enthusiasm is RARE, quiet, and SPECIFIC — at most an occasional "oh, that's clever" about one particular thing. NEVER write "so cool", "I love ___", "OMG", "amazing", "that's so weird/wild" as a standalone, strings of exclamation marks, or eager-to-please model-student energy. Real gifted kids underplay excitement and over-focus on the idea.`,
    `- Be terse and decisive sometimes ("I don't know yet.", "Option B, because it's worth more later."). Not every turn is long.`,
    `- Anchor to your real life now and then — something you did, a game you play, something a family member told you.`,
    profile.readingLevel.match(/kinder|grade\s*[12]/i)
      ? `- You're young: keep turns short and concrete, sometimes wander off-topic, and let small spelling/caps slips happen the way a little kid typing fast would.`
      : `- You're older: it's fine to ramble a bit when you're reasoning — follow your own logic across a few clauses ("so... but then... unless...") the way a real kid thinks aloud.`,
    ``,
    // Adoptable #5: scripted misconception (self-contained, own section). Empty
    // string for personas without one, so their prompt is unchanged.
    misconceptionSection(profile),
    ``,
    `MECHANICS:`,
    `- Output ONLY what the child would type/say next — one natural turn. No narration, no quotation marks, no stage directions, no emoji unless this kid really would.`,
    `- React to what the tutor JUST said, not to a script. Don't be a model student unless your traits say so.`,
    `- When you genuinely understand and have reached the goal, end your message with ${DONE} on its own line. But do NOT end with ${DONE} until you have actually put the idea IN YOUR OWN WORDS in this or a very recent message — said what you now understand and WHY, the way you'd explain it to a friend. A bare "I get it" / "oh I understand now" / "that makes sense" is NOT enough: if you couldn't explain the idea yourself, you're not done yet. Never emit ${DONE} just to be polite or to end the conversation.`,
    `- If you're frustrated/confused enough that a real kid would give up, end with ${STUCK} on its own line.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type SimReply = { text: string; stop: "goal" | "stuck" | null };

// ─── Outcome probe (adoptable #1) ───────────────────────────────────

/** The sentinel the sim kid appends so we can pull a clean answer to grade. */
export const PROBE_ANSWER_TAG = "ANSWER:";

/** Minimal probe-item shape the answer prompt needs (a PracticeItem subset). */
export type ProbeAnswerItem = {
  stem: string;
  answerType: string;
  choices?: string[];
};

/** Optional post-session context: the kid "just did" this activity. */
export type ProbePriorSession = {
  activityTitle: string;
  transcript: SimTurn[];
};

/** A short, human phrasing of the expected answer format, to steer the kid. */
function answerFormatHint(answerType: string, hasChoices: boolean): string {
  if (hasChoices) return "the NUMBER of your choice (0, 1, 2, …) and nothing else";
  switch (answerType) {
    case "fraction":
      return 'a fraction like "3/8"';
    case "decimal":
      return "a number (a decimal is fine)";
    case "integer":
      return "a whole number";
    default:
      return "your answer, as briefly as possible";
  }
}

/**
 * The sim kid answering ONE held-out probe item, IN CHARACTER (adoptable #1).
 * Deliberately separate from buildKidSystem — the kid isn't in a session here,
 * it's just being asked a quick question. Returns { system, user }:
 *
 *   - PRE probe: call with no `prior` → the kid answers COLD (persona only), so
 *     the pre score reflects what this kid knew before the activity.
 *   - POST probe: pass `prior` (the finished session) → the kid answers with
 *     "you just worked through this with your tutor" + the transcript in
 *     context, so the post score reflects what the activity taught.
 *
 * The kid is told to end with a single `ANSWER:` line we parse deterministically
 * (extractProbeAnswer); grading itself is the real practice verifier, no judge.
 */
export function buildProbeAnswerPrompt(
  profile: SimProfile,
  item: ProbeAnswerItem,
  prior?: ProbePriorSession,
): { system: string; user: string } {
  const system = [
    `You are roleplaying a real child named ${profile.name}, a gifted scholar at ${PRIMARY_INSTITUTION_PROMPT_PROFILE.schoolName}. Stay fully in character — never break character, never speak as an AI.`,
    `- Reading/grade level: ${profile.readingLevel}. Your vocabulary and the way you work a problem must match a child at this level.`,
    `- About you: ${profile.dossier}`,
    profile.traits.length
      ? `- How you tend to behave: ${profile.traits.join("; ")}.`
      : ``,
    ``,
    `Someone is asking you a quick question. Work it out honestly the way THIS kid would — if you don't know it, take your best real guess (or say you're not sure); do NOT look anything up and do NOT pretend to know more than this kid would.`,
    `Think it through in a sentence or two of your own kid voice if you want, then on the VERY LAST line write exactly "${PROBE_ANSWER_TAG} <your answer>" and nothing after it.`,
  ]
    .filter(Boolean)
    .join("\n");

  const choiceLines =
    item.choices && item.choices.length
      ? item.choices.map((c, i) => `  ${i}) ${c}`).join("\n")
      : null;

  const user = [
    prior
      ? `You just finished working on "${prior.activityTitle}" with your tutor. Here's how it went:\n\n${formatTranscriptForProbe(prior.transcript)}\n`
      : ``,
    `Question: ${item.stem}`,
    choiceLines ? `Choices:\n${choiceLines}` : ``,
    ``,
    `End with a line "${PROBE_ANSWER_TAG} …" giving ${answerFormatHint(item.answerType, !!choiceLines)}.`,
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

/** Compact transcript rendering for the POST probe's context. */
function formatTranscriptForProbe(turns: SimTurn[]): string {
  return turns
    .map((t) => `[${t.role === "tutor" ? "TUTOR" : "YOU"}] ${t.content}`)
    .join("\n");
}

/**
 * Pull the sim kid's answer out of a probe reply: the text after the LAST
 * `ANSWER:` line (case-insensitive), else the last non-empty line as a
 * fallback. The extracted string is what the deterministic verifier parses.
 */
export function extractProbeAnswer(raw: string): string {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/answer\s*:\s*(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  return nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : raw.trim();
}


/** Strip + interpret the kid's control sentinel. */
export function parseControl(raw: string): SimReply {
  if (raw.includes(DONE)) return { text: raw.replace(DONE, "").trim(), stop: "goal" };
  if (raw.includes(STUCK)) return { text: raw.replace(STUCK, "").trim(), stop: "stuck" };
  return { text: raw.trim(), stop: null };
}

/**
 * Coalesce a transcript into a valid Anthropic message array from one side's
 * POV. `selfRole` is whichever role is the "assistant" of this loop:
 *   - kid's POV:   selfRole "scholar" (tutor → user, scholar → assistant)
 *   - tutor's POV: selfRole "tutor"   (scholar → user, tutor → assistant)
 * Adjacent same-role turns are merged; for the tutor POV we also trim so the
 * array starts and ends on a user turn (a valid request to the model).
 */
export function toMessages(
  turns: SimTurn[],
  selfRole: SimRole,
): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of turns) {
    const role = t.role === selfRole ? "assistant" : "user";
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n\n${t.content}`;
    else messages.push({ role, content: t.content });
  }
  if (selfRole === "tutor") {
    while (messages.length && messages[0].role === "assistant") messages.shift();
    while (messages.length && messages[messages.length - 1].role === "assistant") {
      messages.pop();
    }
  }
  return messages;
}

// ─── Judge ──────────────────────────────────────────────────────────

export {
  JUDGE_RUBRIC,
  JUDGE_TOOL,
  formatSessionForJudge,
} from "./curriculumJudge";

// ─── Pairwise judge (adoptable #3 — addresses Finding 3) ─────────────
//
// A SEPARATE judge from the absolute-scoring one above. Instead of scoring one
// session 1–5 on each dimension, it reads TWO sessions for the SAME cast member
// (the baseline activity and a candidate edit, run against the same kid) side by
// side and says which one better served the child. This is the comparison an
// LLM judge (like a teacher) does most reliably — the absolute scales stretch
// differences humans can't see (a 60 vs a 90), but "which of these two is
// better" is robust. Deliberately kept fully separate from JUDGE_RUBRIC/
// JUDGE_TOOL: the absolute judge stays the diagnosis instrument; this one only
// decides promotion.

export const PAIRWISE_RUBRIC = `You are comparing TWO simulated tutoring sessions at ${PRIMARY_INSTITUTION_PROMPT_PROFILE.schoolName} (a school for
GIFTED elementary scholars; Socratic pedagogy: the scholar does the thinking). The SAME
synthetic scholar played through the SAME activity twice, against two different versions of the
activity's tutor instructions. You are given both transcripts, labeled SESSION A and SESSION B,
in a randomized order (A is not "before" and B is not "after" — decide purely on the content).

Your ONE question: which session better served THIS gifted kid toward the learning goal?

"Better" means the session where the kid did more of the real thinking and came away with (or
was more soundly progressing toward) genuine understanding — NOT the one that reached an answer
faster. Weigh, in roughly this order:
- Did the kid reach (or visibly progress toward) real understanding of the learning goal, in
  their own words rather than parroted?
- Did the tutor stay Socratic — turning thinking back to the kid, scaffolding rather than
  answer-dumping, preserving the discovery instead of spoiling it, no empty flattery?
- Was the challenge pitched at the edge of THIS capable kid's ability (real productive struggle,
  neither coasting nor shut down)?
- Did the activity push past surface facts into depth, complexity, a bigger idea, and genuine
  inquiry — the things that make it a GIFTED activity?

IMPORTANT:
- FASTER IS NOT BETTER. A session that reaches the goal by over-hinting, rushing, or thinning the
  thinking is WORSE, not better.
- THE TURN CAP IS A SIMULATION ARTIFACT. Do not penalize a session for ending at the cap
  ("Session ended: maxTurns") while making real progress — judge trajectory and depth.
- Judge relative to THIS scholar's level. If the two sessions are genuinely indistinguishable in
  how well they served the kid, answer "tie" — don't invent a difference.

Record your verdict: the better session ("A", "B", or "tie") and one terse sentence naming the
load-bearing difference (quote the moment if you can).`;

export const PAIRWISE_TOOL = {
  name: "record_pairwise_verdict" as const,
  description:
    "Record which of the two sessions (A/B/tie) better served this gifted scholar toward the learning goal, and why.",
  input_schema: {
    type: "object" as const,
    required: ["winner", "reason"],
    properties: {
      winner: {
        type: "string" as const,
        enum: ["A", "B", "tie"],
        description:
          "The session that better served the kid, or 'tie' if genuinely indistinguishable.",
      },
      reason: {
        type: "string" as const,
        description: "One terse sentence naming the load-bearing difference.",
      },
    },
  },
};

/**
 * Position-bias guard: decide which A/B slot the CANDIDATE takes for one
 * comparison from a random draw in [0,1). Pure + injectable so the randomization
 * is unit-testable (pass a fixed number) and the judge never sees a fixed order.
 * rand < 0.5 ⇒ candidate is SESSION A; otherwise SESSION B.
 */
export function assignPairwiseOrder(rand: number): { candidateLabel: "A" | "B" } {
  return { candidateLabel: rand < 0.5 ? "A" : "B" };
}

/**
 * Undo the randomization: map the judge's raw A/B/tie pick back to domain terms
 * given which slot held the candidate. This is what makes the randomized order
 * safe — the judge's positional pick is resolved deterministically here.
 */
export function resolvePairwiseWinner(
  pick: "A" | "B" | "tie",
  candidateLabel: "A" | "B",
): "candidate" | "baseline" | "tie" {
  if (pick === "tie") return "tie";
  return pick === candidateLabel ? "candidate" : "baseline";
}

/**
 * Render the two sessions for the pairwise judge's user message. `transcriptA`
 * and `transcriptB` are already ordered by the caller's randomization (the
 * caller records which slot is the candidate); this function is purely
 * positional and never reveals which is baseline/candidate.
 */
export function formatPairwiseForJudge(
  activity: SimActivity,
  profile: SimProfile,
  transcriptA: SimTurn[],
  transcriptB: SimTurn[],
): string {
  const render = (turns: SimTurn[]) =>
    turns
      .map((t) => `[${t.role === "tutor" ? "TUTOR" : "SCHOLAR"}] ${t.content}`)
      .join("\n\n");
  return [
    `## Activity: ${activity.title} (${activity.kind})`,
    `Learning goal: ${activity.learningGoal}`,
    activity.deliverablePrompt
      ? `Deliverable: ${activity.deliverablePrompt}`
      : `Deliverable: (none)`,
    ``,
    `## Synthetic scholar: ${profile.name} — reading level ${profile.readingLevel}`,
    `Profile: ${profile.dossier}`,
    `Traits: ${profile.traits.join("; ") || "none"}`,
    ``,
    `## SESSION A`,
    render(transcriptA),
    ``,
    `## SESSION B`,
    render(transcriptB),
  ].join("\n");
}

// ─── Default cast ───────────────────────────────────────────────────

/**
 * A small, diverse default cast used when a teacher kicks off an experiment
 * without picking profiles. Four archetypes that reliably diverge under the
 * same activity — the point of the emergent sim (see the plan's "diverse
 * cast, not one persona" guard against sim overfitting). Reading levels span
 * the elementary range; traits are the behavioral knobs.
 */
export const DEFAULT_CAST: SimProfile[] = [
  {
    name: "Pip",
    readingLevel: "Grade 2",
    archetype: "eager-but-easily-confused",
    dossier:
      "7 years old. Loves to start things and shares ideas readily, but loses the thread when a step has more than one part.",
    traits: [
      "gives up quickly when confused",
      "asks the tutor to just tell her the answer",
    ],
  },
  {
    name: "Cog",
    readingLevel: "Grade 4",
    archetype: "strong-reader-weak-number-sense",
    dossier:
      "9 years old. Reads well above grade level and explains in full sentences, but shaky with quantities and tends to talk around a problem rather than test it.",
    traits: ["goes off on tangents", "narrates instead of doing the step"],
  },
  {
    name: "Bolt",
    readingLevel: "Grade 5",
    archetype: "fast-and-impatient",
    dossier:
      "10 years old. Quick and confident; jumps to an answer and resists slowing down to show why.",
    traits: [
      "answers in one or two words",
      "guesses fast and moves on without checking",
    ],
  },
  {
    name: "Blip",
    readingLevel: "Kindergarten",
    archetype: "youngest-needs-concrete",
    dossier:
      "5 years old. Brand new to the topic; needs very concrete, one-thing-at-a-time framing and gets overwhelmed by abstract wording.",
    traits: [
      "very short replies",
      "gets distracted and changes the subject",
    ],
  },
  {
    // Adoptable #5: carries a documented, stubborn arithmetic bug so a stock
    // rehearsal always tests whether the activity surfaces AND repairs a real
    // misconception (not just whether a compliant kid reaches the goal).
    name: "Sprout",
    readingLevel: "Grade 3",
    archetype: "persistent-arithmetic-bug",
    dossier:
      "8 years old. Confident and willing to show work on multi-digit addition, but has a stubborn column-addition bug she doesn't know she has and defends her wrong answers with real reasoning.",
    traits: [
      "shows her steps and explains her method",
      "doesn't just take the tutor's word for it — needs to see WHY",
    ],
    misconception: {
      pattern: "DROPPED_CARRY",
      skillKey: "multi-digit-addition",
      note: "Consistently forgets to carry when a column sums to ten or more.",
    },
  },
];

/**
 * The robot-child avatar pool — simple emoji-style faces generated with the
 * Gemini image tools (.claude/rules/ai-generation.md) and stored as
 * public/robot-scholars/<name>.png. Each name is a robot name picked to match
 * its face (Bolt = lightning antenna, Blip = single cyclops eye, Cog = gear,
 * Sprout = leaf, Wink = winking, Nut = bolt-on-top, Beep = speaker mouth,
 * Chip = pixel screen, Pip = bulb antenna, Domo = boxy). Deliberately NOT
 * human names — the synthetic cast is named after these so it never collides
 * with a real scholar's name.
 */
export const ROBOT_AVATARS = [
  "bolt",
  "pip",
  "cog",
  "blip",
  "sprout",
  "domo",
  "wink",
  "nut",
  "beep",
  "chip",
] as const;

const avatarSrc = (slug: string) => `/robot-scholars/${slug}.png`;

/**
 * Robot-avatar image SRC for a synthetic scholar — the storytelling layer that
 * makes "robo-scholars ran your activity" legible at a glance. Resolved by NAME
 * (not a stored field), so it works for already-seeded profiles and custom casts
 * alike — no schema column, no backfill. A scholar named after one of the
 * ROBOT_AVATARS (the DEFAULT_CAST is) gets that exact face; any other name
 * hashes deterministically into the pool.
 */
export function scholarAvatar(name: string): string {
  const slug = name.trim().toLowerCase();
  if ((ROBOT_AVATARS as readonly string[]).includes(slug)) return avatarSrc(slug);
  // Hash over the normalized slug (not the raw name) so the fallback face is
  // stable across whitespace/case variants of the same name.
  let h = 0;
  for (let i = 0; i < slug.length; i++) h += slug.charCodeAt(i);
  return avatarSrc(ROBOT_AVATARS[h % ROBOT_AVATARS.length]);
}
