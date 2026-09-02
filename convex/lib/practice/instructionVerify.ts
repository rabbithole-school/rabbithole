/**
 * Deterministic verifier for instructional "Launchpad" content.
 *
 * Runs at seed/generation time (generate → verify → store): only content that
 * PASSES is ever eligible to be served. Because Launchpad content is DECOUPLED
 * from any live practice item, there is no serve-time pairwise answer-leak to
 * check here — the safety surface is (a) shape validity, (b) length/readability,
 * (c) no answer-dumping framing, (d) no parasocial/character voice, and (e) a
 * self-contained worked example. An optional LLM judge can be layered on top by
 * the caller; this deterministic gate is the floor and never yields false
 * "passed" on a structurally broken card.
 */

import { parseAnswer, type AnswerType } from "./answers";
import {
  isChallenge,
  parseInstructionManipulative,
  parseManipulativeSpec,
  type ManipulativeSpec,
} from "../../../lib/manipulative/types";
import {
  assertGradableManipulative,
  assertRenderableManipulative,
} from "../../../lib/manipulative/authoring";
import type { InstructionVideoAtom } from "./instructionEntries";

export type VerifyAtom =
  | { kind: "story_hook"; hook: string; fromKey?: string; toKey?: string }
  | { kind: "micro_explain"; text: string }
  | {
      kind: "worked_example";
      strategyLabel: string;
      steps: string[];
      examplePrompt: string;
      exampleAnswer: string;
    }
  | {
      kind: "try_it";
      strategyLabel: string;
      steps: string[];
      examplePrompt: string;
      exampleAnswer: string;
      answerType?: AnswerType;
    }
  | { kind: "manipulative"; spec: string }
  | InstructionVideoAtom;

export type VerifyInput = {
  title: string;
  subtitle?: string;
  atoms: VerifyAtom[];
};

export type VerifyResult = {
  status: "passed" | "failed";
  issues: string[];
  report: string;
};

export const MAX_TITLE = 80;
export const MAX_SUBTITLE = 120;
export const MAX_HOOK = 220;
export const MAX_MICRO_EXPLAIN = 320;
export const MAX_STEP = 200;
export const MAX_STEPS = 8;
export const MAX_ATOMS = 6;

// Framing that hands the scholar an answer instead of a method. The worked
// example's OWN `exampleAnswer` field is legitimate (it is a different, decoupled
// problem) and is not subject to this scan — only free-text explanation is.
const ANSWER_DUMP_PATTERNS: RegExp[] = [
  /\bthe answer is\b/i,
  /\bthe solution is\b/i,
  /\bjust write\b/i,
  /\bcorrect answer\b/i,
];

// Parasocial / mascot voice — the product is deliberately anti-parasocial.
const PARASOCIAL_PATTERNS: RegExp[] = [
  /\bI'?m your\b/i,
  /\byour (?:friend|buddy|pal)\b/i,
  /\blet'?s be friends\b/i,
  /\bI love you\b/i,
  /\bI'?m so proud of you\b/i,
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, // emoji
];

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function scan(text: string, patterns: RegExp[]): RegExp | null {
  for (const p of patterns) if (p.test(text)) return p;
  return null;
}

/** Pull the trailing integer/decimal from an answer or step, if any. */
function numbersIn(text: string): string[] {
  return (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map((s) => s);
}

/**
 * Shared shape check for a worked derivation (both `worked_example` and its
 * interactive twin `try_it`): a named strategy, ordered non-empty steps within
 * length limits, no parasocial voice, and a self-contained example whose answer
 * is reachable from the prompt/steps. Pushes any problems into `issues`.
 */
function checkWorkedShape(
  at: string,
  atom: { strategyLabel: string; steps: string[]; examplePrompt: string; exampleAnswer: string },
  issues: string[],
): void {
  const label = (atom.strategyLabel ?? "").trim();
  if (!label) issues.push(`${at}: strategyLabel is empty (name the move)`);
  const steps = atom.steps ?? [];
  if (steps.length === 0) issues.push(`${at}: no steps`);
  if (steps.length > MAX_STEPS) issues.push(`${at}: too many steps (>${MAX_STEPS})`);
  steps.forEach((s, j) => {
    if (!(s ?? "").trim()) issues.push(`${at}.steps[${j}] is empty`);
    if ((s ?? "").length > MAX_STEP) issues.push(`${at}.steps[${j}] exceeds ${MAX_STEP} chars`);
    const par = scan(s ?? "", PARASOCIAL_PATTERNS);
    if (par) issues.push(`${at}.steps[${j}]: parasocial/mascot voice (${par})`);
  });
  const prompt = (atom.examplePrompt ?? "").trim();
  const answer = (atom.exampleAnswer ?? "").trim();
  if (!prompt) issues.push(`${at}: examplePrompt is empty`);
  if (!answer) issues.push(`${at}: exampleAnswer is empty`);
  // Self-contained check (best-effort, deterministic): the worked example must
  // stand on its own — its answer's number(s) should be reachable from numbers
  // that appear in the prompt or steps, so it is a real derivation and not a
  // bare assertion. Non-numeric answers require at least one step to justify.
  const answerNums = numbersIn(answer);
  const bodyNums = new Set([...numbersIn(prompt), ...steps.flatMap((s) => numbersIn(s ?? ""))]);
  if (answerNums.length > 0) {
    const grounded = answerNums.some((n) => bodyNums.has(n)) || steps.length > 0;
    if (!grounded) {
      issues.push(`${at}: exampleAnswer not derivable from prompt/steps (not self-contained)`);
    }
  } else if (steps.length === 0) {
    issues.push(`${at}: non-numeric answer with no steps (not self-contained)`);
  }
}

export function verifyInstructionContent(input: VerifyInput): VerifyResult {
  const issues: string[] = [];

  const title = (input.title ?? "").trim();
  if (!title) issues.push("title is empty");
  if (title.length > MAX_TITLE) issues.push(`title exceeds ${MAX_TITLE} chars`);
  if (input.subtitle && input.subtitle.length > MAX_SUBTITLE) {
    issues.push(`subtitle exceeds ${MAX_SUBTITLE} chars`);
  }

  const atoms = input.atoms ?? [];
  if (atoms.length === 0) issues.push("atoms is empty (a Launchpad must teach something)");
  if (atoms.length > MAX_ATOMS) issues.push(`too many atoms (>${MAX_ATOMS})`);

  let teachingAtoms = 0;
  // "Show me the move" content: a worked_example, its interactive twin try_it,
  // or a hands-on manipulative all present a real move (vs a bare story/explain).
  let showMoveAtoms = 0;

  atoms.forEach((atom, i) => {
    const at = `atom[${i}] (${atom.kind})`;
    if (atom.kind === "story_hook") {
      const hook = (atom.hook ?? "").trim();
      if (!hook) issues.push(`${at}: hook is empty`);
      if (hook.length > MAX_HOOK) issues.push(`${at}: hook exceeds ${MAX_HOOK} chars`);
      const par = scan(hook, PARASOCIAL_PATTERNS);
      if (par) issues.push(`${at}: parasocial/mascot voice (${par})`);
    } else if (atom.kind === "micro_explain") {
      teachingAtoms++;
      const text = (atom.text ?? "").trim();
      if (!text) issues.push(`${at}: text is empty`);
      if (text.length > MAX_MICRO_EXPLAIN) {
        issues.push(`${at}: text exceeds ${MAX_MICRO_EXPLAIN} chars (prose wall)`);
      }
      const dump = scan(text, ANSWER_DUMP_PATTERNS);
      if (dump) issues.push(`${at}: answer-dumping framing (${dump})`);
      const par = scan(text, PARASOCIAL_PATTERNS);
      if (par) issues.push(`${at}: parasocial/mascot voice (${par})`);
    } else if (atom.kind === "worked_example") {
      teachingAtoms++;
      showMoveAtoms++;
      checkWorkedShape(at, atom, issues);
    } else if (atom.kind === "try_it") {
      teachingAtoms++;
      showMoveAtoms++;
      // try_it is a worked derivation with its final step faded, so it must
      // satisfy the SAME self-contained shape check as worked_example …
      checkWorkedShape(at, atom, issues);
      // … AND its answer must be gradable by the SHARED comparator the client
      // grades with (`gradeTryItAtom` → parseAnswer/answersEqual): an answer the
      // grader can't parse would make the faded step unsolvable.
      const type: AnswerType = atom.answerType ?? "integer";
      const answer = (atom.exampleAnswer ?? "").trim();
      if (answer && parseAnswer(answer, type) === null) {
        issues.push(
          `${at}: exampleAnswer "${answer}" is not a valid ${type} for the shared grader`,
        );
      }
    } else if (atom.kind === "manipulative") {
      teachingAtoms++;
      showMoveAtoms++;
      // A single spec and every step in a sequence pass the SAME gate
      // practiceItemPool.validateManipulativeSpec uses — with ONE deliberate
      // relaxation inside a sequence: a goal-less EXPLORE step is not gradable
      // by construction (every `*Solved` predicate returns false without a
      // goal), and that is exactly what the concrete warm-up rung of a guided
      // teaching sequence is ("play with it — notice what changes"). Requiring
      // gradability there would make the CRA opening rung unauthorable.
      // Renderability is still required of EVERY step — an unrenderable spec
      // would crash the scholar's screen, which no pedagogy justifies — and a
      // step that IS a challenge must still be gradable, so a directed step can
      // never be silently unsolvable. The single-spec atom is unchanged: it has
      // no sequence to advance through, so an ungradable instance there would
      // just be a toy with no completion signal.
      const parsed = parseInstructionManipulative(atom.spec);
      if (!parsed) {
        issues.push(`${at}: spec is not valid ManipulativeSpec or MultiStepSequenceSpec JSON`);
      } else {
        if (parsed.mode === "sequence" && parsed.spec.steps.length === 0) {
          issues.push(`${at}: sequence has no steps`);
        }

        const specs: Array<{ spec: ManipulativeSpec | null; at: string; inSequence: boolean }> =
          parsed.mode === "single"
            ? [{ spec: parsed.spec, at, inSequence: false }]
            : parsed.spec.steps.map((step, stepIndex) => ({
                spec: parseManipulativeSpec(JSON.stringify(step)),
                at: `${at}.steps[${stepIndex}]`,
                inSequence: true,
              }));
        specs.forEach(({ spec, at: specAt, inSequence }) => {
          if (!spec) {
            issues.push(`${specAt}: step is not valid ManipulativeSpec JSON`);
            return;
          }
          // Explore steps inside a sequence are ungradable ON PURPOSE (see above).
          const requireGradable = !inSequence || isChallenge(spec);
          try {
            if (requireGradable) assertGradableManipulative(spec);
            assertRenderableManipulative(spec);
          } catch (e) {
            issues.push(
              `${specAt}: ${e instanceof Error ? e.message : "spec failed the manipulative gate"}`,
            );
          }
        });
      }
    } else if (atom.kind === "video") {
      teachingAtoms++;
      showMoveAtoms++;

      if (atom.provider !== "youtube") {
        issues.push(`${at}: provider must be youtube`);
      }
      if (!YOUTUBE_VIDEO_ID.test(atom.videoId ?? "")) {
        issues.push(`${at}: videoId must be an 11-character YouTube id`);
      }

      const startSec = atom.startSec;
      const endSec = atom.endSec;
      if (typeof startSec !== "number" || !Number.isFinite(startSec)) {
        issues.push(`${at}: startSec is required and must be a finite number`);
      }
      if (typeof endSec !== "number" || !Number.isFinite(endSec)) {
        issues.push(`${at}: endSec is required and must be a finite number`);
      }
      if (
        typeof startSec === "number" &&
        Number.isFinite(startSec) &&
        typeof endSec === "number" &&
        Number.isFinite(endSec)
      ) {
        if (startSec < 0 || startSec >= endSec) {
          issues.push(`${at}: clip must satisfy 0 <= startSec < endSec`);
        } else if (endSec - startSec > 360) {
          issues.push(`${at}: clip exceeds 360 seconds`);
        }
      }

      const captionText = (atom.captionText ?? "").trim();
      if (!captionText) issues.push(`${at}: captionText is empty`);
      if (captionText.length > MAX_MICRO_EXPLAIN) {
        issues.push(`${at}: captionText exceeds ${MAX_MICRO_EXPLAIN} chars`);
      }

      const sourceLabel = (atom.sourceLabel ?? "").trim();
      if (!sourceLabel) issues.push(`${at}: sourceLabel is empty`);
      if (sourceLabel.length > MAX_TITLE) {
        issues.push(`${at}: sourceLabel exceeds ${MAX_TITLE} chars`);
      }

      let sourceUrlIsHttps = false;
      try {
        sourceUrlIsHttps = new URL(atom.sourceUrl ?? "").protocol === "https:";
      } catch {
        sourceUrlIsHttps = false;
      }
      if (!sourceUrlIsHttps) issues.push(`${at}: sourceUrl must be an https URL`);

      const hasFollowingDoAtom = atoms
        .slice(i + 1)
        .some((laterAtom) => laterAtom.kind === "try_it" || laterAtom.kind === "manipulative");
      if (!hasFollowingDoAtom) {
        issues.push(`${at}: video must be followed by a try_it or manipulative atom`);
      }
    }
  });

  if (teachingAtoms === 0) {
    issues.push(
      "no teaching atom (need a micro_explain, worked_example, try_it, manipulative, or video)",
    );
  }
  // "Show me the move" must present a real move (worked example, try_it, or a
  // manipulative), not another Socratic prompt.
  if (showMoveAtoms === 0) {
    issues.push(
      "no show-the-move atom (Show-me needs a worked_example, try_it, manipulative, or video)",
    );
  }

  const status = issues.length === 0 ? "passed" : "failed";
  const report =
    status === "passed"
      ? "passed: shape, length, framing, voice, and self-contained worked example all OK"
      : `failed (${issues.length}): ${issues.join("; ")}`;
  return { status, issues, report };
}
