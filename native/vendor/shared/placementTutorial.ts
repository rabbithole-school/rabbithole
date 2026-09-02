/**
 * The pre-test WARM-UP walkthrough — three non-graded beats a scholar plays once,
 * at the very start of a genuinely fresh math pre-test, to learn the surface by
 * DOING before anything counts. Beat 1 teaches how to answer + submit, beat 2
 * teaches the honest "I haven't learned this yet" escape, beat 3 lets them pick
 * either path; then the real, server-scored probes begin. Consumers: the web
 * Placement.tsx and the native NativePlacement.tsx (via the vendored copy).
 *
 * NO REACT, NO CONVEX. This file is vendored VERBATIM into native/vendor/shared/
 * and the vendoring rewrites NO import paths, so an import only survives the copy
 * when the SAME relative specifier resolves on both sides. `./practiceLoop` does
 * (shared/ and vendor/shared/ are siblings in both trees), which is why the real
 * button label is imported rather than re-typed. The GRADER does not: it lives at
 * convex/lib/practice/answers.ts on web but vendor/practice/answers.ts on native,
 * and no one relative path reaches both — so the answer comparison is INJECTED by
 * each caller as `rawAnswersEqual` (web from @/convex/lib/practice/answers, native
 * from the vendored copy). That reuses the REAL grader instead of writing a second
 * comparison (the same "graded client-side, records nothing" property
 * TeachingStep.tsx relies on), so web + native render byte-identical copy and
 * grade beat 1 with identical semantics.
 *
 * These beats never touch a Convex mutation: the walkthrough owns its own client
 * screen and hands off to the existing `prime()` only AFTER it ends, so a warm-up
 * answer can never reach `submitPlacementAnswer` (polluting placement scoring is
 * unrepresentable, not merely avoided).
 */

import { DONT_KNOW_LABEL } from "./practiceLoop";

/** The affordance a beat teaches, which drives how that beat advances:
 *  `answer`  — advances on submit (beat 1);
 *  `dontKnow`— advances ONLY on the honest-escape tap (beat 2);
 *  `free`    — advances on EITHER a submit or the honest-escape tap (beat 3). */
export type TutorialBeatKind = "answer" | "dontKnow" | "free";

// Which affordance wears the single teal highlight ring is NOT a field here —
// it follows from `kind`, and only the `dontKnow` beat ever earns one. That is
// deliberate: the answer box and Check button are ALREADY teal-edged at rest,
// so a teal ring around them reads as a stray double border rather than as
// pointing (verified on screen), and a mark that encodes nothing gets deleted
// (visual-design.md). The escape link is a quiet gray ghost button, so a ring
// there genuinely distinguishes it. Everywhere else the callout line's
// ADJACENCY does the pointing. A `ring` field that no renderer read would be
// the same dead decoration one level down, in the data.

export type TutorialBeat = {
  id: string;
  /** The problem shown on the stem card. */
  stem: string;
  kind: TutorialBeatKind;
  /** Present only on a locally-checked `answer` beat — the expected answer and
   *  its type, fed to the INJECTED comparator. Never sent to the server. */
  expected?: { answer: string; answerType: "integer" };
  /** The one soft boxed note ABOVE the card (beat 2 only) — the honest framing
   *  that makes tapping the escape button truthful rather than theatrical. */
  framing?: string;
  /** The quiet instruction line rendered IN FLOW, adjacent to the affordance it
   *  names (adjacency is the pointing — no arrow, no box). `web`/`native` differ
   *  on beat 1 ONLY, and not for flavour: the native answer pad
   *  (`NativePracticeControls.PracticePadAnswer`) already renders its OWN
   *  standing hint — "Type your answer, then press Return" when a hardware
   *  keyboard is attached (it then hides the number pad), or a visible keypad
   *  when one is not. Repeating the mechanics there would both restate what the
   *  view already draws and mis-describe the keyboard case ("tap the numbers"
   *  when there are no numbers on screen). So native FRAMES the beat and lets
   *  the pad's own per-mode hint carry the how; web, which has no such standing
   *  hint, spells out the Return shortcut itself. Every other string here is
   *  byte-identical across the two surfaces. */
  callout: { web: string; native: string };
};

/** Beat 1's answer, named once so the stem, the local check, and the gentle
 *  wrong-answer line can never disagree about what "2 + 3" comes to. */
const WARM_UP_ANSWER = "5";

// The callouts and the nudge quote the escape button by name, so they
// interpolate the REAL label (`DONT_KNOW_LABEL`) rather than re-typing it — a
// re-typed copy is exactly the hand-maintained mirror that drifts.
export const TUTORIAL_BEATS: readonly TutorialBeat[] = [
  {
    id: "answer",
    stem: "2 + 3",
    kind: "answer",
    expected: { answer: WARM_UP_ANSWER, answerType: "integer" },
    callout: {
      web: "Type your answer, then press Return ⏎ to check it.",
      native: "Start with an easy one — put in your answer, then check it.",
    },
  },
  {
    id: "dontKnow",
    // Deliberately beyond a young scholar, so tapping the escape is HONEST, not
    // theater — a kid who hasn't met quadratics genuinely hasn't learned it yet.
    stem: "x² + 3x = 10",
    kind: "dontKnow",
    framing: "Here's one most people haven't learned yet.",
    callout: {
      web: `You won't know every one — that's the point. Tap “${DONT_KNOW_LABEL}” instead of guessing. It helps us more than a lucky guess.`,
      native: `You won't know every one — that's the point. Tap “${DONT_KNOW_LABEL}” instead of guessing. It helps us more than a lucky guess.`,
    },
  },
  {
    id: "free",
    stem: "12 × 4",
    kind: "free",
    callout: {
      web: `Now you try. Either one is fine — answering or tapping “${DONT_KNOW_LABEL}”. Nothing here is scored.`,
      native: `Now you try. Either one is fine — answering or tapping “${DONT_KNOW_LABEL}”. Nothing here is scored.`,
    },
  },
];

/** Scholar-facing labels the walkthrough shares across both surfaces. Sentence
 *  case; the only emoji is the one the spec specifies (👍). */
export const TUTORIAL_LABELS = {
  /** The progress header label — honest ("warm-up"), never the real probe
   *  meter's "Finding your level" / "Question N of M". */
  header: "Quick warm-up",
  /** The quiet, understated skip link (styled like CHECK_IN_EXIT_LABEL). */
  skip: "Skip the walkthrough",
  /** Beat 1, correct submission. */
  correct: "That's it 👍",
  /** Beat 1, correct-or-not, the escape hatch when a beat carries no expected
   *  answer to name. `closeLine(beat)` is what surfaces actually render. */
  closeFallback: "Close — that's not it.",
  /** Beat 2, if they type + submit anyway instead of tapping the escape. */
  nudge: `Give it a try — tap “${DONT_KNOW_LABEL}”.`,
  /** The one-line handoff shown as the real probes are primed. */
  handoff: "Okay — here we go.",
} as const;

/** A raw-string answer comparator with the shape of the practice grader's
 *  `rawAnswersEqual`. Injected by the caller so this module reuses the REAL
 *  grader (never a second comparison) while importing nothing. The `answerType`
 *  is narrowed to the `"integer"` the warm-up beats use, which keeps the real
 *  `rawAnswersEqual(a, b, AnswerType)` structurally assignable here. */
export type RawAnswerComparator = (
  learnerRaw: string,
  expectedRaw: string,
  answerType: "integer",
) => boolean;

/**
 * The gentle wrong-answer line, read OFF THE BEAT rather than off a module
 * constant — so a second `answer` beat can never be told "close, it's 5" about
 * a problem whose answer is 7.
 */
export function closeLine(beat: TutorialBeat): string {
  return beat.expected ? `Close — it's ${beat.expected.answer}.` : TUTORIAL_LABELS.closeFallback;
}

/**
 * Client-side, records-nothing correctness check for an `answer` beat — the SAME
 * "graded client-side, moves nothing" property TeachingStep relies on, delegated
 * to the injected real comparator so representation still normalizes. A beat with
 * no expected answer (`dontKnow` / `free`) is never "correct" here.
 */
export function checkTutorialAnswer(
  beat: TutorialBeat,
  raw: string,
  compare: RawAnswerComparator,
): boolean {
  if (!beat.expected) return false;
  return compare(raw.trim(), beat.expected.answer, beat.expected.answerType);
}
