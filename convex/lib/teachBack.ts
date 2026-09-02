/**
 * Teach-the-Tutor — "explain it back" viva mode — the pure core.
 *
 * The Feynman inversion: the strongest anti-cognitive-offloading assessment is
 * making the CHILD do the explaining. The tutor plays a deliberately naive
 * learner ("I don't get it — can you teach me why…?"), the scholar teaches, and
 * a SEPARATE grading pass scores the EXPLANATION for the TEACHER (never shown to
 * the kid). Retrieval + generation + self-explanation in one move — nearly
 * impossible to offload to an AI.
 *
 * This module is deliberately pure (no Convex / SDK deps) so the tests import
 * the SAME text/logic that ships — the thing measured is the thing served, they
 * cannot drift. Mirrors the problems-in-chat pattern (lib/practice/chatPractice.ts):
 *   - `teachBackEnabled()` — the kill-switch (TEACH_BACK_ENABLED, OFF by default).
 *     Gates BOTH the tutor-prompt section and the tools being offered.
 *   - `buildTeachBackSection` — the tutor-visible prompt section (a METHOD, not a
 *     character; novice stance; escalating "but why…?" probes; no grade to the kid).
 *   - `START_TEACH_BACK_TOOL` / `FINISH_TEACH_BACK_TOOL` — the tool specs.
 *   - `buildTeachBackGradingPrompt` + `TEACH_BACK_GRADING_TOOL` + `parseTeachBackRubric`
 *     — the grader's prompt, its structured-output tool, and a strict validator.
 *     The grading call itself (Claude) lives in convex/teachBackGrading.ts; the
 *     logic around it is here so it's unit-testable without the SDK.
 */

import { SCHOLAR_PRONOUN_GUIDANCE } from "./scholarPronouns";

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Is teach-back mode live for the tutor? Reads TEACH_BACK_ENABLED (Convex
 * deployment env). Fail-safe default OFF: an unset / "false" / "0" / empty value
 * keeps the tutor exactly as it is today. Only an explicit "true" / "1" / "on" /
 * "yes" turns it on. Because the section is tutor-visible, shipping it live
 * requires owner review; the gate state is captured in messages.promptVersion.
 */
export function teachBackEnabled(): boolean {
  const raw = (process.env.TEACH_BACK_ENABLED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

// ── The tool specs ────────────────────────────────────────────────────────────

export const START_TEACH_BACK_TOOL = {
  name: "start_teach_back",
  description:
    "Enter TEACH-BACK mode: the scholar teaches a concept to you while you play a curious NOVICE who has never heard of it. Treat a teach-back as a whole playlist checkpoint (one full item, not a quick insert), and call this ONLY when a concept looks recently-learned and worth consolidating, or the scholar asks to be quizzed / asks to teach you something. Default cadence is at most once per activity/session stretch unless the scholar explicitly asks for another. Pass the concept in plain words (conceptLabel). After calling it, frame it as a METHOD ('let me play someone who's never heard of this — can you teach it to me?'), NOT a character, then ask the scholar to explain in their own words and let them talk. Do NOT supply the answer, do NOT confirm or correct mid-explanation beyond natural curiosity. You get the concept back so you can ask about it — you do NOT grade it and must never tell the scholar a score.",
  inputSchema: {
    type: "object" as const,
    properties: {
      conceptLabel: {
        type: "string" as const,
        description:
          "The concept the scholar is about to teach you, in plain words (e.g. 'why the moon has phases', 'how regrouping works in subtraction').",
      },
      nodeKey: {
        type: "string" as const,
        description:
          "Optional stable knowledge-node key for the concept, if you know it. Omit if unsure — a plain conceptLabel is enough.",
      },
    },
    required: ["conceptLabel"] as const,
  },
};

export const FINISH_TEACH_BACK_TOOL = {
  name: "finish_teach_back",
  description:
    "Exit TEACH-BACK mode after the scholar has finished teaching you and you've asked your 2–3 naive 'but why…?' probes. Calling this thanks the scholar for teaching (do that warmly in your own words) and quietly hands the explanation off for later teacher review. There is NO grade, score, or verdict to report to the scholar — the reward is that they taught it. Omit teachBackId to finish the session's currently-active teach-back (the usual case).",
  inputSchema: {
    type: "object" as const,
    properties: {
      teachBackId: {
        type: "string" as const,
        description:
          "Optional id of the teach-back to finish. Omit to finish the active one for this session.",
      },
    },
    required: [] as const,
  },
};

// ── Tool-callback guidance (what each tool hands back to the model) ──────────

/**
 * The guidance string the start_teach_back tool returns to the model once the
 * mode has opened. It is what actually steers the tutor into the novice stance
 * (let them teach, withhold the answer, ask naive "but why…?" probes, no grade),
 * so it lives here — pure + exported — rather than inline in the http action.
 * Both the live /project-stream handler AND the teach-back eval hand the model
 * this exact text, so what's measured can't drift from what ships.
 */
export function teachBackStartGuidance(conceptLabel: string): string {
  return `Teach-back mode is on for "${conceptLabel}". Now, in your own words: tell the scholar you'll play someone who's never heard of this and ask them to teach it to you. Then STOP and let them explain — do NOT explain it yourself, do NOT confirm or correct (you're playing a novice, so no "yeah, exactly" / "that's right" / "you've got it"). As they teach, ask 2–3 genuinely naive "but why…?" probes. When they've finished and you've probed, call finish_teach_back. Never give them a grade or score, and don't praise how well they explained it — thank them for teaching you and stay curious.`;
}

export function teachBackStartFailureGuidance(message: string): string {
  return `Couldn't start a teach-back (${message}). Just keep the conversation going naturally.`;
}

/** The guidance finish_teach_back returns when it closed an active teach-back. */
export const TEACH_BACK_FINISH_GUIDANCE =
  `Teach-back closed. Warmly thank the scholar for teaching you — in your own words, thanking the ACT of teaching, not how well they did it — and move the conversation on. Do NOT report any grade, score, or verdict, and do NOT praise the quality of their explanation ("great explanation", "you nailed it", "like a pro"); there is no scoreboard for them to see.`;

/** The guidance finish_teach_back returns when there was no active teach-back. */
export const TEACH_BACK_NO_ACTIVE_GUIDANCE =
  `There's no active teach-back to finish. Just continue the conversation naturally.`;

export function teachBackFinishFailureGuidance(message: string): string {
  return `Couldn't close the teach-back (${message}). Thank the scholar for teaching you and continue.`;
}

// ── The tutor-visible prompt section (gated) ─────────────────────────────────

/**
 * The tutor-visible instructions for teach-back mode. Appended to the tutor
 * system prompt ONLY when the gate is on. Static (no scholar data) — the "when"
 * is judgement the model makes in the moment, the "how" is a fixed method.
 *
 * The heart of it: the scholar teaches, the tutor plays a genuine NOVICE and
 * asks escalating naive "but why…?" probes, NEVER supplies the answer, NEVER
 * grades to the kid. It's a METHOD ("I'll play someone who's never heard of
 * this"), never a named character (anti-parasocial). A wrong or thin
 * explanation is DATA for the teacher, never shame for the kid.
 */
export function buildTeachBackSection(): string {
  return [
    `\nTEACH-BACK (you can invite the scholar to TEACH a concept to you — the Feynman move):`,
    `The single strongest way to know something is to teach it. You have two tools — start_teach_back and finish_teach_back — that let the scholar do exactly that: they explain a concept while you play a curious learner who's never heard of it.`,
    ``,
    `WHEN to offer one:`,
    `  - A concept looks recently-learned and one clean round of explaining it would help it stick, OR`,
    `  - The scholar claims they've got it ("that's easy now", "I totally understand"), OR`,
    `  - The scholar asks to be quizzed or says they want to teach you something.`,
    `Cadence: treat it as one whole playlist item (a short standalone segment), not a quick add-on turn. Offer it lightly — "want to teach it to me?" — never force it, and by default no more than once per activity/session stretch unless the scholar asks for another.`,
    ``,
    `HOW it works once you call start_teach_back:`,
    `  - Frame it as a METHOD, out loud: "I'll play someone who's never heard of this — teach it to me." It is a stance you take, NOT a character or a persona with a name. Never pretend to be a specific younger kid or invent a personality to bond with.`,
    `  - Ask the scholar to explain the whole thing in their OWN words, then stop and let them talk. They can type or use voice.`,
    `  - As a genuine novice, ask 2–3 escalating naive "but why…?" / "how do you know…?" / "what if…?" probes that push on the causal chain and edge cases. Stay curious, not quizzy.`,
    `  - Do NOT supply the answer, do NOT teach it back to them, and do NOT confirm or deny whether they're right beyond honest curiosity ("huh, so that's the reason?"). You are genuinely playing a novice — you don't KNOW if it's right, so you can't agree that it is: no "yeah, exactly", "that's right", "you've got it", or "you're doing great". A shaky or wrong explanation is fine — you keep playing the learner; it's DATA, not a moment to correct or confirm.`,
    `  - When they've explained and you've asked your probes, call finish_teach_back and thank them warmly for teaching you — thank the ACT of teaching ("thanks for walking me through that"), not how well they did it.`,
    ``,
    `NEVER give the scholar a grade, score, verdict, or "you got X right" for a teach-back — and this includes evaluative PRAISE of the explanation itself ("great explanation", "you nailed it", "you totally get it", "like a pro"). There is no scoreboard here for the kid — the reward is that they taught it. Genuine curiosity ("huh, so that's the reason — I hadn't thought of it that way") and thanks for teaching you are welcome; a verdict on how well they explained is not. (A separate, private pass reviews the explanation for their teacher; that is none of the scholar's concern and you must not mention or hint at it.)`,
  ].join("\n");
}

// ── The grader: prompt builder + structured-output tool + validator ──────────

export type TeachBackRubric = {
  completeness: number;
  causalChain: number;
  example: number;
  handledProbes: number;
  summary: string;
};

/**
 * The tool the grading model is forced to call — structured JSON so we never
 * parse prose. Four 0–3 dimensions + a 1–2 sentence teacher-facing summary.
 */
export const TEACH_BACK_GRADING_TOOL = {
  name: "record_teach_back_rubric",
  description:
    "Record the rubric for the scholar's teach-back explanation. Score ONLY the explanation the scholar gave — never the tutor's questions. This is a TEACHER-facing note; write the summary for a teacher, not the child.",
  input_schema: {
    type: "object" as const,
    properties: {
      completeness: {
        type: "integer" as const,
        minimum: 0,
        maximum: 3,
        description:
          "0–3: did the explanation cover the key parts of the concept? 0 = almost nothing, 3 = thorough.",
      },
      causalChain: {
        type: "integer" as const,
        minimum: 0,
        maximum: 3,
        description:
          "0–3: did the scholar explain WHY / the mechanism (cause→effect), not just restate the label? 0 = pure restatement, 3 = clear causal reasoning.",
      },
      example: {
        type: "integer" as const,
        minimum: 0,
        maximum: 3,
        description:
          "0–3: did the scholar ground it in a concrete example, analogy, or worked case? 0 = none, 3 = a strong, apt example.",
      },
      handledProbes: {
        type: "integer" as const,
        minimum: 0,
        maximum: 3,
        description:
          "0–3: how well did the scholar handle the tutor's naive 'but why…?' probes? 0 = couldn't engage them (or none were asked), 3 = extended the explanation to answer them.",
      },
      summary: {
        type: "string" as const,
        description:
          "1–2 sentences for the TEACHER: what the explanation showed about the scholar's understanding, and any gap worth a follow-up. Neutral and specific — no praise filler, no grade to the child.",
      },
    },
    required: [
      "completeness",
      "causalChain",
      "example",
      "handledProbes",
      "summary",
    ],
  },
};

const GRADING_SYSTEM_PROMPT = `You are an assessment reviewer for Rabbithole, a Socratic tutor for gifted learners. You are scoring a TEACH-BACK: a transcript where a scholar TAUGHT a concept to the tutor, and the tutor deliberately played a naive learner asking "but why…?" probes.

${SCHOLAR_PRONOUN_GUIDANCE}

Score ONLY the scholar's EXPLANATION — never the tutor's questions, and never the correctness of any single fact in isolation. You are judging the QUALITY OF THE EXPLANATION as evidence of understanding, on four dimensions, each 0–3:
- completeness: did they cover the key parts of the concept?
- causalChain: did they explain WHY / the mechanism, not just restate the label?
- example: did they ground it in a concrete example, analogy, or worked case?
- handledProbes: how well did they handle the tutor's naive follow-up probes? (0 if none were asked or they couldn't engage.)

Then write a 1–2 sentence summary FOR THE TEACHER: what the explanation reveals about the scholar's understanding and any gap worth following up. Be neutral and specific. A thin or wrong explanation is DATA, not a place for judgement — describe it plainly.

You MUST respond by calling the record_teach_back_rubric tool. Do not write any prose outside the tool call.`;

/**
 * Build the grading model messages for one teach-back. Pure: takes the concept
 * and the already-rendered transcript of the teach-back exchange, returns the
 * system + user strings (the action supplies them to the SDK). Kept out of the
 * action so it's unit-testable without a key.
 */
export function buildTeachBackGradingPrompt(input: {
  conceptLabel: string;
  transcript: string;
}): { system: string; user: string } {
  const transcript = input.transcript.trim() || "(no explanation was recorded)";
  const user = `CONCEPT THE SCHOLAR TAUGHT: ${input.conceptLabel}

TEACH-BACK TRANSCRIPT (the scholar is "Scholar"; the tutor played a naive learner):
${transcript}

Score the scholar's explanation on the four dimensions and record the rubric.`;
  return { system: GRADING_SYSTEM_PROMPT, user };
}

/** Clamp a value to an integer in 0–3, or return null if it isn't a number. */
function clampScore(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const r = Math.round(v);
  return Math.max(0, Math.min(3, r));
}

/**
 * Validate + normalize the grading model's tool input into a TeachBackRubric.
 * Returns null (caller leaves the teach-back active + logs) when the shape is
 * unusable. Scores are clamped to 0–3; the summary is trimmed and required.
 */
export function parseTeachBackRubric(raw: unknown): TeachBackRubric | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const completeness = clampScore(o.completeness);
  const causalChain = clampScore(o.causalChain);
  const example = clampScore(o.example);
  const handledProbes = clampScore(o.handledProbes);
  if (
    completeness === null ||
    causalChain === null ||
    example === null ||
    handledProbes === null
  )
    return null;

  const summary =
    typeof o.summary === "string" ? o.summary.trim() : "";
  if (!summary) return null;

  return { completeness, causalChain, example, handledProbes, summary };
}
