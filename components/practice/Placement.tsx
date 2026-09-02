"use client";

/**
 * Placement quiz (v2) — runs once for a new scholar before practice, to find
 * their starting point instead of grinding from "count to 10".
 *
 * This is the SERVER-AUTHORITATIVE, one-item-at-a-time adaptive loop: the server
 * serves a single probe, grades each answer (ternary — correct / incorrect /
 * "I haven't learned this yet"), and picks the next probe by binary-searching each
 * strand's frontier, round-robin across strands. Answers advance directly to the
 * next probe without reporting correctness. See convex/lib/practice/placement.ts
 * + convex/practiceSkills.ts (placementCurrent / submitPlacementAnswer). Native
 * twin: NativePlacement.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  VStack,
  Button,
  Text,
  Heading,
  Progress,
} from "@chakra-ui/react";
import { ArrowRight } from "@phosphor-icons/react";
import {
  applyKey,
  applyUnitKey,
  choiceSubmitValue,
  DONT_KNOW_LABEL,
  isPadAnswerType,
  padAcceptsFraction,
  placementProgress,
  PLACEMENT_SLIP_PROMPT,
  PLACEMENT_SLIP_RETRY_LABEL,
  PLACEMENT_SLIP_CONCEDE_LABEL,
  type PlacementOutcome,
} from "@/shared/practiceLoop";
import { hasUnitToken, rawAnswersEqual } from "@/convex/lib/practice/answers";
import { practiceDomainLabel } from "@/shared/practiceDomainLabels";
import { CHECK_IN_EXIT_LABEL, checkInExitVisible, checkInResultCtaLabel } from "@/shared/checkInResultCta";
import { checkInDomainChipLabel } from "@/shared/checkInMapCopy";
import {
  placementSpotLabel,
  placementStartBody,
  placementStartHeadline,
} from "@/shared/placementResultCopy";
import {
  checkTutorialAnswer,
  closeLine,
  TUTORIAL_BEATS,
  TUTORIAL_LABELS,
} from "@/shared/placementTutorial";
import { superscriptExponents } from "@/shared/mathNotation";
import { VerdictStemCard } from "@/components/practice/VerdictStemCard";
import { Manipulative } from "@/components/manipulative/Manipulative";
import { parseManipulativeSpec } from "@/lib/manipulative/grade";
import { MANIPULATIVE_ANSWER_TYPE } from "@/lib/manipulative/practiceContract";
import { FractionText } from "@/components/FractionText";
import { ExpressionEditor } from "@/components/practice/ExpressionEditor";
import { ExpressionKeypad } from "@/components/practice/ExpressionKeypad";
import { UnitKeys } from "@/components/practice/UnitKeys";
import { FractionKey } from "@/components/practice/FractionKey";
import { UNIT_MISSING_NUDGE } from "@/components/practice/unitAnswerCopy";
import { useMapGates } from "@/hooks/useMapGates";
import { useFlatAnswerKeyboard } from "@/hooks/useFlatAnswerKeyboard";
import { useExpressionTemplate } from "@/hooks/useExpressionTemplate";
import { useExpressionTemplateKeyboard } from "@/hooks/useExpressionTemplateKeyboard";
import { hasPracticeMath } from "@/shared/fractions";
import type { PracticePromptVisual } from "@/shared/practicePromptVisual";

type Probe = {
  itemId: string;
  grade: string;
  skillKey: string;
  strand: string;
  stem: string;
  // Widened to include "manipulative" (U-3): placement now serves the full item
  // union, so a probe can be a tappable manipulative board, not just a typed /
  // multiple-choice item.
  answerType: "integer" | "decimal" | "fraction" | "expression" | "multipleChoice" | "manipulative";
  /** The measurement unit this probe must be answered in, DISPLAY form ("cm³")
   *  — mirrors PlacementProbeWire. Present ⇒ value + unit, and the flat surface
   *  offers the unit keys; absent ⇒ a unit-free probe, unchanged. */
  answerUnit?: string;
  /** Option labels for a multipleChoice probe — rendered as tappable buttons. */
  choices?: string[];
  /** "twoD" when the answer is a single fraction / buildable expression, so the
   *  probe opens the direct-manipulation box editor (with the fraction / power / root
   *  glyph keys) instead of a plain field — the SAME signal the session serves.
   *  Absent ⇒ a flat typed answer. */
  answerShape?: string;
  promptVisual?: PracticePromptVisual;
  /** Present only for a MANIPULATIVE probe: the JSON-serialized `ManipulativeSpec`
   *  the shared stage renders. The scholar builds a configuration; the server
   *  re-grades it (isSolved). */
  manipulativeSpec?: string;
  /** The domain this probe belongs to — present only in a MIXED check-in, drives
   *  the per-item domain chip (#553 labels). */
  domain?: string;
  domainLabel?: string;
};

type Feedback = {
  outcome: PlacementOutcome;
  correctAnswer?: string;
  /** Set only when the VALUE was right and the required unit was absent
   *  ("missing") or not the one asked for ("wrong"). */
  unitOutcome?: "missing" | "wrong";
  /** The domain of the graded probe (mixed check-in). */
  domain?: string;
  /** The placement WARMTH FLOOR reveal line — a warm, deterministic strategy /
   *  worked / generic line the server composed for this miss (never a live LLM
   *  call). Present on a miss/don't-know; absent on a correct answer. */
  revealLine?: string;
  /** "Confirm before you cap": true when this typed miss is a possible SLIP — the
   *  server has NOT capped the ceiling and re-served a fresh item on the same
   *  skill. The surface offers the two-way slip/concede choice instead of moving
   *  straight on. */
  retry?: boolean;
};

/** One domain's line on the mixed check-in's completion screen ("your spots"). */
type PerDomainSummary = {
  domain: string;
  label: string;
  /** Teacher-facing / scheduling grade prior only — NEVER rendered to a scholar
   *  (J3). The scholar sees `startingSkillLabel`. */
  placedThroughGrade: string | null;
  /** The domain's leading frontier skill label — the scholar-facing "your spot". */
  startingSkillLabel: string | null;
  complete: boolean;
};

export function Placement({
  scholarId,
  domain,
  multiDomain = false,
  onDone,
  homeHref = null,
}: {
  scholarId: Id<"users">;
  /** A standing-practice assignment's domain (defaults to whole-number
   *  arithmetic engine-side when omitted). Ignored when `multiDomain`. */
  domain?: string;
  /** MIXED multi-domain "Math Check-In": place across EVERY registered domain in
   *  one interleaved session (the default no-pin practice entry). Drives the
   *  multi-domain server loop, shows a per-item domain chip, and summarizes each
   *  domain's spot on the completion screen. */
  multiDomain?: boolean;
  onDone: () => void;
  /** A real scholar placing themselves (not a teacher remote-rehearsal): the
   *  scholar's home path. When set, finishing the check-in routes HOME — where
   *  the Tree-reveal moment card + the playlists chooser land (f14) — instead of
   *  dumping the scholar straight into more practice. The result CTA relabels
   *  from the (own) reveal-pending state. Null for remote rehearsal, which keeps
   *  the "Start practicing" → onDone flow. */
  homeHref?: string | null;
}) {
  const router = useRouter();
  // The scholar's OWN map-reveal state — only meaningful on the real self-flow
  // (homeHref set); skipped for a teacher remote-rehearsal. Drives the honest
  // result-CTA label: the check-in just unlocked the Tree, so on a first
  // check-in the reveal is pending → "See what you unlocked"; once it's been
  // revealed (a later re-placement) it's a plain "Back to home".
  const { treeRevealPending } = useMapGates(homeHref != null);
  const submitSingle = useMutation(api.practiceSkills.submitPlacementAnswer);
  const submitMixed = useMutation(api.practiceSkills.submitMixedPlacementAnswer);
  // Lazily minted on first use (in a handler, never during render — the loop's
  // deterministic per-probe seed derives from it, so re-fetching a probe is stable).
  const seedRef = useRef<number | null>(null);
  const seedFor = useCallback(() => (seedRef.current ??= Math.floor(Math.random() * 2_000_000_000)), []);

  const [probe, setProbe] = useState<Probe | null>(null);
  const [answered, setAnswered] = useState(0);
  const [input, setInput] = useState("");
  // The pre-submit gate fired on this attempt; cleared by the next input change.
  const [unitGateNudge, setUnitGateNudge] = useState(false);
  const [phase, setPhase] = useState<"boot" | "intro" | "tutorial" | "quiz" | "retry" | "submitting" | "result" | "paused">("boot");
  // J3: the single-domain result is SKILL-anchored — the scholar's leading
  // frontier skill label, never a grade. `placed` (did we place through real
  // ground) only distinguishes the rare all-mastered case from a true beginner in
  // the numberless fallback copy; the grade itself is never stored/rendered here.
  const [startingSkill, setStartingSkill] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  // The per-domain "your spots" summary for the MIXED check-in's result screen.
  const [perDomain, setPerDomain] = useState<PerDomainSummary[] | null>(null);

  // ── The pre-test WARM-UP walkthrough (shared/placementTutorial.ts) ──────────
  // Three non-graded beats that run ONCE, between the fresh intro and the first
  // real probe, teaching the surface by doing. Nothing here calls a Convex
  // mutation, so a warm-up answer can never reach placement scoring — the loop
  // only resumes (via `start()` → `prime()`) after the walkthrough ends.
  const [tutorialIndex, setTutorialIndex] = useState(0);
  // Each walkthrough ENTRY is a new run; the counter makes re-entry at the
  // same index visible to the latch effect's dependencies without a second
  // reset site (placementTutorialLatch.test.ts).
  const [tutorialRun, setTutorialRun] = useState(0);
  const [tutorialInput, setTutorialInput] = useState("");
  // Beat 1 only: the scholar has submitted, so show the warm/close line + Next
  // (nothing is scored, so a wrong answer still advances).
  const [tutorialChecked, setTutorialChecked] = useState(false);
  const [tutorialCorrect, setTutorialCorrect] = useState(false);
  // Beat 2 only: they typed + pressed Check anyway instead of tapping the honest
  // escape — keep the callout up and add the single quiet nudge.
  const [tutorialNudge, setTutorialNudge] = useState(false);
  // Set as the walkthrough hands off, so the priming screen reads the warm
  // "Okay — here we go." line instead of the generic "Getting ready…".
  const [handoff, setHandoff] = useState(false);

  // Resume: a mid-placement reload lands directly back on the SAME served item
  // (the server persisted it), skipping the intro — the intro is for genuinely
  // fresh placements only. One-shot read; the loop itself is mutation-driven.
  const resumeSingle = useQuery(
    api.practiceSkills.placementCurrent,
    multiDomain ? "skip" : { scholarId, ...(domain ? { domain } : {}) },
  );
  const resumeMixed = useQuery(
    api.practiceSkills.mixedPlacementCurrent,
    multiDomain ? { scholarId } : "skip",
  );
  // Single-domain SELF-DIRECTED entry: is this domain still prereq-gated (a
  // cross-domain prerequisite domain isn't placed yet)? We ALLOW the entry — the
  // raise-the-ceiling ethos, never a hard lock — but earn a gentle portrait-
  // voiced note on the intro. Skipped for the mixed check-in (which sequences
  // prereqs itself) and when no domain is pinned.
  const gateInfo = useQuery(
    api.practiceSkills.domainsForScholar,
    !multiDomain && domain ? { scholarId } : "skip",
  );
  const gatedEntry = !multiDomain ? gateInfo?.find((d) => d.domain === domain) : undefined;
  // The specific unmet prerequisite to NAME in the note (Andy: recommend the real
  // prereq X, but still let them proceed). `enteredGatedConcept` is the short noun
  // ("division"); `enteredGatedLabel` is the domain they're entering ("Fractions").
  const enteredGatedConcept = gatedEntry?.prereqGate?.concept ?? null;
  const enteredGatedLabel = gatedEntry?.label ?? (domain ? practiceDomainLabel(domain) : null);
  const resume = multiDomain ? resumeMixed : resumeSingle;
  // The mixed check-in's progress meter is per-SITTING: "Question N of up to 30
  // today" against the day's probe budget, not the full multi-domain sweep.
  const sittingMaxQuestions =
    resume && "sittingMaxQuestions" in resume ? resume.sittingMaxQuestions : undefined;
  const progress = multiDomain
    ? placementProgress(answered, sittingMaxQuestions ?? answered + 1, false, true)
    : placementProgress(answered, resume?.maxQuestions ?? answered + 1);
  // Leave the `boot` phase once the resume query resolves. This is React's
  // render-phase state-adjustment pattern (conditional, one-shot — `phase` flips
  // out of "boot" so it can't loop), NOT a setState-in-effect.
  if (phase === "boot" && resume !== undefined) {
    if (resume.done) {
      // Placement already complete (a reload after finishing, or a mid-flow
      // remount) — go straight to the RESULT screen, NEVER the intro. Re-running
      // a done placement must be impossible.
      if (multiDomain && "perDomain" in resume) setPerDomain(resume.perDomain as PerDomainSummary[]);
      else if ("placedThroughGrade" in resume) {
        setStartingSkill(resume.startingSkillLabel ?? null);
        setPlaced(resume.placedThroughGrade != null);
      }
      setPhase("result");
    } else if ("paused" in resume && resume.paused) {
      // Parked for this sitting — land on the warm pause screen, never the live
      // probe or the intro. Checked BEFORE `resume.probe`, since a soft-parked
      // check-in still carries a served probe. Two ways to get here: the mixed
      // check-in spending the day's probe budget, and the single-domain loop
      // being held behind an already-open placement run (#cap-open-placements),
      // whose CTA lands the scholar in the playlist that serves that open run.
      setPhase("paused");
    } else if (resume.probe) {
      setProbe(resume.probe as Probe);
      // Mixed = per-sitting counter (today's answered); single = lifetime.
      setAnswered(
        multiDomain && "sittingAnswered" in resume ? resume.sittingAnswered : resume.answered,
      );
      setPhase("quiz");
    } else {
      setPhase("intro");
    }
  }

  // Unified submit — one call shape (scholarId + seed + optional itemId/answer/
  // dontKnow) dispatched to the single- or multi-domain server loop, normalized
  // to a common result the phase machine reads.
  const submit = useCallback(
    async (extra: { itemId?: string; answer?: string; dontKnow?: boolean }) => {
      const common = { scholarId, seed: seedFor(), ...extra };
      const res = multiDomain
        ? await submitMixed(common)
        : await submitSingle({ ...common, ...(domain ? { domain } : {}) });
      return {
        done: res.done,
        paused: "paused" in res ? res.paused : false,
        graded: (res.graded ?? null) as Feedback | null,
        probe: (res.probe ?? null) as Probe | null,
        placedThroughGrade: "placedThroughGrade" in res ? res.placedThroughGrade : null,
        startingSkillLabel: "startingSkillLabel" in res ? res.startingSkillLabel : null,
        perDomain: ("perDomain" in res ? res.perDomain : []) as PerDomainSummary[],
      };
    },
    [multiDomain, submitMixed, submitSingle, scholarId, domain, seedFor],
  );

  // Prime the first probe once the scholar starts (a query can't persist the
  // served probe, so we prime through the mutation with no answer).
  const prime = useCallback(async () => {
    const res = await submit({});
    // The walkthrough's handoff line rides ONLY this first priming screen; clear
    // it as soon as the first probe lands, or every later mid-quiz "submitting"
    // would keep flashing "Okay — here we go." instead of "Getting ready…".
    setHandoff(false);
    if (res.done) {
      setStartingSkill(res.startingSkillLabel);
      setPlaced(res.placedThroughGrade != null);
      setPerDomain(res.perDomain);
      setPhase("result");
    } else if (res.paused) {
      // The sitting's probe budget is already spent — park on the warm pause
      // screen instead of serving another probe.
      setPhase("paused");
    } else if (res.probe) {
      setProbe(res.probe);
      setPhase("quiz");
    } else {
      // Not done, not paused, and yet no probe — a server that couldn't serve
      // (a stale/dead parked probe, a mid-deploy old/new skew). The quiz phase
      // with a null probe is a blank card whose buttons are no-op guards, with
      // no way out (the 2026-08-18 stuck check-in). Land on the intro instead:
      // visible, and its Start re-primes.
      setPhase("intro");
    }
  }, [submit]);

  const start = useCallback(() => {
    setPhase("submitting");
    void prime();
  }, [prime]);

  // ── Walkthrough control ─────────────────────────────────────────────────────
  // Enter the walkthrough from the intro's Start button (a genuinely fresh
  // pre-test only — a mid-placement reload lands in `quiz`, never here).
  const beginTutorial = useCallback(() => {
    // Bump the run counter so the latch effect below re-fires even when the
    // walkthrough re-enters at the SAME index (a beat-0 skip → the null-probe
    // intro fallback → Start again previously left both Next and Skip dead:
    // `tutorialIndex` never changed, so the effect never re-armed the latch).
    setTutorialRun((n) => n + 1);
    setTutorialIndex(0);
    setTutorialInput("");
    setTutorialChecked(false);
    setTutorialCorrect(false);
    setTutorialNudge(false);
    setPhase("tutorial");
  }, []);

  // Single-flight latch for every walkthrough exit. A hardware Return reaches
  // BOTH the window keydown hook and the focused button's own activation, so on
  // the last beat two advances would each call `start()` and fire a duplicate
  // priming mutation. Cleared after the next beat commits. (Native gets this from
  // `useGuardedPracticeAction`; web had no equivalent.)
  const tutorialAdvancing = useRef(false);

  // Re-arm only after React has committed a different tutorial beat — or a
  // fresh walkthrough run. This keeps duplicate activations in the same
  // event/render cycle latched, while exits (which change neither) stay
  // latched through priming. The SOLE reset site, by design
  // (placementTutorialLatch.test.ts pins it).
  useEffect(() => {
    tutorialAdvancing.current = false;
  }, [tutorialIndex, tutorialRun]);

  // Move to the next beat, or — past the last beat — hand off to the real probes
  // with the warm one-liner riding the priming screen (no separate "ready?" step).
  const advanceTutorial = useCallback(() => {
    if (tutorialAdvancing.current) return;
    tutorialAdvancing.current = true;
    setTutorialInput("");
    setTutorialChecked(false);
    setTutorialCorrect(false);
    setTutorialNudge(false);
    if (tutorialIndex >= TUTORIAL_BEATS.length - 1) {
      // Leaving the walkthrough for good — the latch stays closed.
      setHandoff(true);
      start();
      return;
    }
    setTutorialIndex((i) => i + 1);
  }, [tutorialIndex, start]);

  // Skipping is an exit too, so it takes the same latch — otherwise a Return
  // landing on Skip mid-advance primes twice.
  const skipTutorial = useCallback(() => {
    if (tutorialAdvancing.current) return;
    tutorialAdvancing.current = true;
    start();
  }, [start]);

  // The current beat's primary action. Beat 1 grades locally (records nothing)
  // then shows the warm/close line; beat 2's Check is a no-op that only nudges
  // toward the honest escape; beat 3 advances on a submitted answer.
  const onTutorialCheck = useCallback(() => {
    const beat = TUTORIAL_BEATS[tutorialIndex];
    if (beat.kind === "dontKnow") {
      setTutorialNudge(true);
      return;
    }
    if (!tutorialInput.trim()) return;
    if (beat.kind === "answer") {
      setTutorialCorrect(checkTutorialAnswer(beat, tutorialInput, rawAnswersEqual));
      setTutorialChecked(true);
      return;
    }
    advanceTutorial(); // free beat: a submitted answer is one valid path
  }, [tutorialIndex, tutorialInput, advanceTutorial]);

  // The honest-escape tap — advances beat 2 (its only exit) and beat 3.
  const onTutorialDontKnow = useCallback(() => {
    advanceTutorial();
  }, [advanceTutorial]);

  // Submit one answer (or a Don't-Know). The server records the measurement,
  // then the scholar moves directly to the next probe without a verdict.
  const gradeAnswer = useCallback(
    async (answer: string, dontKnow: boolean) => {
      if (!probe) return;
      setPhase("submitting");
      const res = await submit({ itemId: probe.itemId, answer, ...(dontKnow ? { dontKnow: true } : {}) });
      setInput("");
      // Staleness guard: a stale/duplicate submit (itemId no longer the served
      // probe — a network retry after the server advanced) grades NOTHING; the
      // server returns `graded: null` and re-serves the same probe. Treat it as
      // "no feedback": re-render that probe, don't flash a fake incorrect/unknown
      // and don't bump the answered count. (A no-op that ALSO finalized — done
      // with no grade — still routes to the result screen.)
      if (res.graded === null) {
        if (res.done) {
          setStartingSkill(res.startingSkillLabel);
          setPlaced(res.placedThroughGrade != null);
          setPerDomain(res.perDomain);
          setPhase("result");
        } else {
          setProbe(res.probe ?? probe);
          setPhase("quiz");
        }
        return;
      }
      setAnswered((n) => n + 1);
      // "Confirm before you cap": a first typed miss is a possible slip. The
      // server already re-served a FRESH item on the SAME skill (res.probe) but
      // did NOT cap yet — offer the two-way choice instead of moving straight on.
      if (res.graded.retry && res.probe) {
        setProbe(res.probe);
        setPhase("retry");
        return;
      }
      if (res.done) {
        setStartingSkill(res.startingSkillLabel);
        setPlaced(res.placedThroughGrade != null);
        setPerDomain(res.perDomain);
        setPhase("result");
      } else if (res.paused) {
        setPhase("paused");
      } else if (res.probe) {
        setProbe(res.probe);
        setPhase("quiz");
      } else {
        // Graded but no next probe and not done/paused — the server couldn't
        // serve (same escape as prime(): never quiz-with-null, it's a blank
        // dead-end). Intro is visible and its Start re-primes.
        setPhase("intro");
      }
    },
    [probe, submit],
  );

  // A unit-bearing probe ("…in cubic centimeters"): the unit is part of the
  // answer, so the flat surface widens its key allowlist, offers the unit keys,
  // and holds a unit-less submit back. Typed probes only — a tapped choice or a
  // manipulative board has no unit to write (and never carries `answerUnit`).
  const answerUnit =
    probe &&
    probe.answerType !== MANIPULATIVE_ANSWER_TYPE &&
    !(probe.answerType === "multipleChoice" && (probe.choices?.length ?? 0) > 0)
      ? probe.answerUnit
      : undefined;

  // `applyKey` (shared with the drill + native) handles ⌫ and the remainder
  // token (R → " R "), so an expression answer round-trips the server's parser.
  const onKey = useCallback((k: string) => {
    setUnitGateNudge(false); // any edit answers the "include the unit" nudge
    setInput((prev) => {
      const next = applyKey(prev, k);
      // A unit item's hardware-typed caret ("cm^3") reads as the SAME real
      // superscript a tapped unit key already produces ("cm³") — grading is
      // unaffected either way (`splitUnitSuffix` recognizes both forms).
      return answerUnit ? superscriptExponents(next) : next;
    });
  }, [answerUnit]);

  // A tapped unit key REPLACES any trailing unit, so cm² → cm³ is one tap.
  const onUnitKey = useCallback((unit: string) => {
    setUnitGateNudge(false);
    setInput((prev) => applyUnitKey(prev, unit));
  }, []);

  const onCheck = useCallback(() => {
    const answer = input.trim();
    if (!answer) return;
    // A unit-bearing probe wants "112 cm³"; a bare number now grades incorrect,
    // so hold it here rather than spending the probe on a fixable slip. The
    // don't-know path and the tapped-choice path never reach this gate.
    if (answerUnit && !hasUnitToken(answer)) {
      setUnitGateNudge(true);
      return;
    }
    void gradeAnswer(answer, false).catch(() => {});
  }, [input, answerUnit, gradeAnswer]);

  const onDontKnow = useCallback(() => {
    void gradeAnswer("", true).catch(() => {});
  }, [gradeAnswer]);

  // The two-way slip/concede choice, shown after a first typed miss.
  // "I just made a silly mistake" → answer the fresh confirm item already served.
  const onRetrySlip = useCallback(() => {
    setInput("");
    setPhase("quiz");
  }, []);
  // "I don't understand this yet" → concede: a don't-know on the confirm item
  // caps the ceiling immediately (the fast path — no extra question to answer).
  const onRetryConcede = useCallback(() => {
    void gradeAnswer("", true).catch(() => {});
  }, [gradeAnswer]);

  // A manipulative probe's spec (U-3), parsed once per probe. A malformed/missing
  // spec renders a fallback rather than crashing. Keyed off `probe` (the state),
  // since `current` is only bound after the early returns below.
  const manipulativeSpec = useMemo(
    () =>
      probe?.answerType === MANIPULATIVE_ANSWER_TYPE
        ? parseManipulativeSpec(probe.manipulativeSpec)
        : null,
    [probe],
  );

  // Done on a manipulative probe: hand the locked-in runtime state to the same
  // grade path a typed/choice answer uses. The answer string is never sent back.
  const onManipulativeCommit = useCallback(
    (stateJson: string) => {
      void gradeAnswer(stateJson, false).catch(() => {});
    },
    [gradeAnswer],
  );

  // Direct-manipulation 2-D answer entry (fraction/power/root), driven only when the
  // server tags the probe `answerShape: "twoD"`. Placement always seeds an
  // EMPTY, unlocked editor (no skeleton), so the fraction / exponent glyph keys
  // are offered and the scholar builds the structure themselves — a fair
  // diagnostic — using the SAME shared model + hook the practice session does.
  const usesTemplateEditor =
    !!probe &&
    probe.answerShape === "twoD" &&
    (probe.answerType === "fraction" || probe.answerType === "expression");
  const { templateState, onTemplateKey, onSetCaret, onInsertFraction, onInsertPower, onInsertSquareRoot, onInsertRoot } =
    useExpressionTemplate({
      enabled: usesTemplateEditor && phase === "quiz",
      itemKey: probe?.itemId,
      seedSkeleton: null,
      onSubmissionChange: setInput,
    });

  // Quiz input is driven by the hardware keyboard — web is a laptop, so there's
  // no on-screen number pad (see `useFlatAnswerKeyboard`). A 2-D probe routes
  // its keys through the shared expression model instead (mutually exclusive).
  useFlatAnswerKeyboard({
    enabled: phase === "quiz" && !usesTemplateEditor,
    onKey,
    onEnter: onCheck,
    allowUnit: !!answerUnit,
  });
  useExpressionTemplateKeyboard({
    enabled: phase === "quiz" && usesTemplateEditor,
    onKey: onTemplateKey,
    onSubmit: onCheck,
  });
  // The walkthrough reuses the SAME flat-answer keyboard routing as the real
  // quiz (never a second key listener): digits build the input, Return submits
  // the beat. Disabled once beat 1 shows its feedback (Return then does nothing).
  useFlatAnswerKeyboard({
    enabled: phase === "tutorial" && !tutorialChecked,
    onKey: (k) => setTutorialInput((prev) => applyKey(prev, k)),
    onEnter: onTutorialCheck,
  });
  // …and once beat 1 shows its feedback the SAME key advances to the next beat,
  // so a scholar being taught "press Return" is never told it stopped working
  // (native gets this from `captureReturn`/HardwareReturnAdvance). Digits are
  // ignored here — there is nothing left to type.
  useFlatAnswerKeyboard({
    enabled: phase === "tutorial" && tutorialChecked,
    onKey: () => {},
    onEnter: advanceTutorial,
  });

  if (phase === "intro") {
    return (
      <Centered>
        <VStack gap={4} maxW="460px" textAlign="center">
          <Text fontSize="40px">🧭</Text>
          {multiDomain ? (
            <>
              <Heading size="lg">Let&apos;s map what you already know</Heading>
              <Text color="#65706a">
                A one-time check-in — a map of what you already know, not a
                test. Nothing here is graded.
              </Text>
            </>
          ) : (
            <>
              <Heading size="lg">Let&apos;s find your starting point</Heading>
              {enteredGatedConcept && (
                <Box
                  bg="#f3f0e8"
                  borderRadius="12px"
                  px={4}
                  py={3}
                  borderWidth="1px"
                  borderColor="#e2dccf"
                >
                  <Text color="#65706a" fontSize="sm">
                    {enteredGatedLabel ?? "This topic"} builds on {enteredGatedConcept} — we
                    recommend getting comfortable with {enteredGatedConcept} first, but you
                    can try it now if you want a challenge. 🌱
                  </Text>
                </Box>
              )}
              <Text color="#65706a">
                A few quick problems so we start you in the right place — not too easy,
                not too hard.
              </Text>
            </>
          )}
          <Button colorPalette="teal" size="lg" onClick={beginTutorial}>
            Start <ArrowRight />
          </Button>
          {checkInExitVisible(homeHref) && <CheckInExitLink homeHref={homeHref!} />}
        </VStack>
      </Centered>
    );
  }

  if (phase === "retry") {
    // "Confirm before you cap": a first typed miss offers a two-way choice —
    // treat it as a slip and try a fresh item on the same skill, or honestly
    // concede (which caps immediately, the fast path). No answer is revealed here:
    // a slip's confirm must stay a fair re-measurement.
    return (
      <Centered>
        <VStack gap={5} maxW="440px" textAlign="center">
          <Text fontSize="40px">🤔</Text>
          <Heading size="lg">{PLACEMENT_SLIP_PROMPT}</Heading>
          <VStack gap={3} w="100%">
            <Button colorPalette="teal" size="lg" w="100%" onClick={onRetrySlip}>
              {PLACEMENT_SLIP_RETRY_LABEL}
            </Button>
            <Button variant="outline" size="lg" w="100%" onClick={onRetryConcede}>
              {PLACEMENT_SLIP_CONCEDE_LABEL}
            </Button>
          </VStack>
        </VStack>
      </Centered>
    );
  }

  if (phase === "boot" || phase === "submitting") {
    // As the walkthrough hands off, the priming screen carries the warm one-liner
    // instead of the generic loader — no separate "ready?" step.
    const loadingLine = handoff && phase === "submitting" ? TUTORIAL_LABELS.handoff : "Getting ready…";
    return <Centered><Text color="#65706a">{loadingLine}</Text></Centered>;
  }

  if (phase === "result") {
    // The result CTA. New in f14: finishing the check-in takes the scholar HOME
    // (where the Tree reveal + playlists chooser land) rather than dumping them
    // into more practice. The label is honest for that destination — "See what
    // you unlocked" while the Tree reveal is still pending (the first check-in),
    // else a plain "Back to home". A teacher remote-rehearsal (no homeHref) keeps
    // the original "Start practicing" → onDone flow.
    const resultCta =
      homeHref != null ? (
        <Button
          colorPalette="teal"
          size="lg"
          onClick={() => router.push(homeHref)}
        >
          {checkInResultCtaLabel(treeRevealPending)} <ArrowRight />
        </Button>
      ) : (
        <Button colorPalette="teal" size="lg" onClick={onDone}>
          Start practicing <ArrowRight />
        </Button>
      );
    // MIXED check-in: summarize each domain's spot ("your spots"). Single-domain
    // keeps the one-grade result.
    if (multiDomain && perDomain) {
      const anyPlaced = perDomain.some((d) => d.startingSkillLabel || d.placedThroughGrade);
      return (
        <Centered>
          <VStack gap={4} maxW="440px" textAlign="center" w="100%">
            <Text fontSize="40px">🎯</Text>
            <Heading size="lg">Here are your spots</Heading>
            <Text color="#65706a">
              {anyPlaced
                ? "We found where you're ready to grow in each area. You can always revisit anything earlier."
                : "We'll build strong foundations together, step by step."}
            </Text>
            <VStack gap={2} w="100%">
              {perDomain.map((d) => (
                <Flex
                  key={d.domain}
                  w="100%"
                  justify="space-between"
                  align="center"
                  bg="#fffdfa"
                  border="1px solid #e6e0d2"
                  borderRadius="12px"
                  px={4}
                  py={3}
                >
                  <Text fontWeight="600" color="#454b45">{practiceDomainLabel(d.domain)}</Text>
                  <Text color="#65706a" fontSize="14px">
                    {placementSpotLabel(d.startingSkillLabel)}
                  </Text>
                </Flex>
              ))}
            </VStack>
            {resultCta}
          </VStack>
        </Centered>
      );
    }
    return (
      <Centered>
        <VStack gap={4} maxW="440px" textAlign="center">
          <Text fontSize="40px">🎯</Text>
          <Heading size="lg">
            {placementStartHeadline(startingSkill, placed)}
          </Heading>
          <Text color="#65706a">
            {placementStartBody(startingSkill, placed)}
          </Text>
          {resultCta}
        </VStack>
      </Centered>
    );
  }

  // Warm per-sitting pause — the mixed check-in's day budget is spent. A calm
  // "good picture already, more tomorrow" with the same "Start practicing" CTA as
  // the result screen: practice proceeds on whatever placed so far; the unplaced
  // domains simply reappear as a check-in entry next sitting. No countdown, no
  // progress-guilt. Checked before the quiz render so a parked sitting never
  // falls through to a live, answerable probe card.
  // (Native twin: NativePlacement.tsx.)
  if (phase === "paused") {
    return (
      <Centered>
        <VStack gap={4} maxW="440px" textAlign="center">
          <Text fontSize="40px">🌱</Text>
          <Heading size="lg">Great mapping today</Heading>
          <Text color="#65706a">
            We&apos;ve got a good picture of where you&apos;re ready to grow already —
            let&apos;s pick up the rest tomorrow. Your practice is ready to go now.
          </Text>
          <Button colorPalette="teal" size="lg" onClick={onDone}>
            Start practicing <ArrowRight />
          </Button>
          {checkInExitVisible(homeHref) && <CheckInExitLink homeHref={homeHref!} />}
        </VStack>
      </Centered>
    );
  }

  if (phase === "tutorial") {
    // ── The warm-up walkthrough screen ──────────────────────────────────────
    // Its OWN screen (never a modal over measured rects — the documented Ark
    // body-lock leak class): callouts sit IN FLOW, adjacent to the affordance
    // they name, and the single teal ring points by proximity, not an arrow.
    const beat = TUTORIAL_BEATS[tutorialIndex];
    const total = TUTORIAL_BEATS.length;
    return (
      <Centered>
        <VStack gap={5} w="100%" maxW="440px">
          <Box w="100%">
            {/* The header must NOT lie: this is a warm-up meter, not the real
                "Finding your level" / "Question N of M" probe meter. */}
            <Flex justify="space-between" mb={1}>
              <Text fontSize="12px" color="#65706a">{TUTORIAL_LABELS.header}</Text>
              <Text fontSize="12px" color="#65706a">{tutorialIndex + 1} of {total}</Text>
            </Flex>
            {/* Fills to match the "N of 3" label beside it — a bar still empty
                on "1 of 3" reads as broken on a three-beat meter, where the
                real probe meter's answered/total convention has room to run. */}
            <Progress.Root value={((tutorialIndex + 1) / total) * 100} size="xs" colorPalette="teal">
              <Progress.Track borderRadius="full" aria-label={`${TUTORIAL_LABELS.header} ${tutorialIndex + 1} of ${total}`}>
                <Progress.Range borderRadius="full" />
              </Progress.Track>
            </Progress.Root>
          </Box>

          {/* Beat 2's honest framing — the ONE place a soft boxed note is right
              (the existing gatedNote treatment: even 1px border, no stripe). */}
          {beat.framing && (
            <Box w="100%" bg="#f3f0e8" borderRadius="12px" px={4} py={3} borderWidth="1px" borderColor="#e2dccf">
              <Text color="#65706a" fontSize="sm">{beat.framing}</Text>
            </Box>
          )}

          <VerdictStemCard stem={beat.stem} tone={null} />

          {tutorialChecked ? (
            // Beat 1, after submit: the warm/close line + a plain Next. Nothing
            // is scored, so a wrong answer still moves forward.
            <VStack w="100%" gap={4}>
              <Text
                className="rh-note"
                fontSize="15px"
                fontWeight="600"
                color={tutorialCorrect ? "#146c43" : "#8a6d16"}
                textAlign="center"
              >
                {tutorialCorrect ? TUTORIAL_LABELS.correct : closeLine(beat)}
              </Text>
              <Button w="100%" colorPalette="teal" size="lg" onClick={advanceTutorial}>
                Next <ArrowRight />
              </Button>
            </VStack>
          ) : beat.kind === "dontKnow" ? (
            // Beat 2: the answer box + Check read as MUTED (the Check is a no-op),
            // and the ring moves to the honest-escape link, which is the only exit.
            <VStack w="100%" gap={4}>
              <Box
                w="100%"
                border="2px solid #d7d2c7"
                borderRadius="12px"
                bg="#f6f4ef"
                px={4}
                py={3}
                textAlign="center"
                fontSize="26px"
                fontWeight="700"
                color="#143"
                minH="56px"
              >
                {tutorialInput || <Text as="span" color="#c3bdae">type your answer</Text>}
              </Box>
              <Button w="100%" size="lg" variant="outline" color="#9aa39a" borderColor="#d7d2c7" onClick={onTutorialCheck}>
                Check
              </Button>
              {tutorialNudge && (
                <Text className="rh-note" fontSize="14px" color="#8a6d16" textAlign="center">
                  {TUTORIAL_LABELS.nudge}
                </Text>
              )}
              {/* The coach-mark sits directly ABOVE the link it names, beak
                  pointing down at it. The teal ring this link used to wear is
                  gone: the beak and a ring are two marks for one variable, and
                  the beak is the more legible of the two. */}
              <TutorialCoachMark text={beat.callout.web} beak="down" />
              <DontKnowButton onClick={onTutorialDontKnow} />
            </VStack>
          ) : (
            // Beat 1 ("how to answer") and beat 3 (either path is fine, so the
            // honest escape is offered alongside Check). Neither wears a ring —
            // these controls are already the teal-edged focus of the screen; the
            // callout's position is what points.
            <VStack w="100%" gap={4}>
              {/* Beat 3's instruction is about the CHOICE, so its bubble sits
                  ABOVE the box (beak down); beat 1's is about this box, so it
                  sits UNDER it (beak up). */}
              {beat.kind === "free" && <TutorialCoachMark text={beat.callout.web} beak="down" />}
              <Box
                w="100%"
                border="2px solid #16707e"
                borderRadius="12px"
                bg="#f3fbfc"
                px={4}
                py={3}
                textAlign="center"
                fontSize="26px"
                fontWeight="700"
                color="#143"
                minH="56px"
              >
                {tutorialInput || <Text as="span" color="#9bbcc2">type your answer</Text>}
              </Box>
              {beat.kind === "answer" && <TutorialCoachMark text={beat.callout.web} beak="up" />}
              <Button w="100%" colorPalette="teal" size="lg" disabled={!tutorialInput.trim()} onClick={onTutorialCheck}>
                Check <ArrowRight />
              </Button>
              {beat.kind === "free" && <DontKnowButton onClick={onTutorialDontKnow} />}
            </VStack>
          )}

          {/* Every beat carries the quiet skip link (styled like CHECK_IN_EXIT_LABEL)
              — always present so nobody is trapped, including the teacher
              remote-rehearsal path (homeHref == null). */}
          <SkipWalkthroughLink onSkip={skipTutorial} />
        </VStack>
      </Centered>
    );
  }

  const current = probe;
  // A manipulative probe uses its own stage and prompt.
  const cardVisible = !(phase === "quiz" && current?.answerType === MANIPULATIVE_ANSWER_TYPE);

  return (
    <Centered>
      <VStack gap={5} w="100%" maxW="440px">
        <Box w="100%">
          {/* Per-item domain chip — shown ONLY in a mixed check-in, so the scholar
              sees when the subject switches. A plain even-bordered pill (no accent
              stripe/gradient — visual-design rules); the human label comes from the
              domain registry, never the raw slug. Mirrors the mixed playlist chip. */}
          {multiDomain && current?.domain ? (
            <Flex justify="center" mb={2}>
              <Box
                bg="#f3fbfc"
                border="1px solid #cfe6ea"
                borderRadius="999px"
                px={3}
                py="2px"
                fontSize="12px"
                fontWeight="600"
                color="#16707e"
              >
                {checkInDomainChipLabel(current.domainLabel ?? practiceDomainLabel(current.domain))}
              </Box>
            </Flex>
          ) : null}
          <Flex justify="space-between" mb={1}>
            <Text fontSize="12px" color="#65706a">Finding your level</Text>
            <Text fontSize="12px" color="#65706a">{progress.label}</Text>
          </Flex>
          <Progress.Root
            value={progress.percent}
            size="xs"
            colorPalette="teal"
          >
            <Progress.Track borderRadius="full" aria-label={progress.label}>
              <Progress.Range borderRadius="full" />
            </Progress.Track>
          </Progress.Root>
        </Box>

        {cardVisible && (
          <VerdictStemCard
            stem={current?.stem ?? ""}
            promptVisual={current?.promptVisual}
            tone={null}
            speakable={current?.grade === "K"}
          />
        )}

        {current?.answerType === MANIPULATIVE_ANSWER_TYPE ? (
          // A manipulative probe — render the SHARED manipulative stage (the same
          // one the drill uses), and keep the honest "I haven't learned this yet"
          // affordance below it. Done hands the locked-in state to the grade path
          // (onManipulativeCommit). No answer pad — a manipulative isn't typed.
          <VStack w="100%" gap={4}>
            {manipulativeSpec ? (
              <Manipulative spec={manipulativeSpec} onCommit={onManipulativeCommit} />
            ) : (
              <Text color="#9b1c1c" fontSize="14px">
                This activity couldn&apos;t be loaded — try refreshing.
              </Text>
            )}
            <DontKnowButton onClick={onDontKnow} />
          </VStack>
        ) : current?.answerType === "multipleChoice" && (current.choices?.length ?? 0) > 0 ? (
          // A comparison probe can't be typed on the number pad — tap an option.
          <VStack w="100%" gap={2}>
            {current.choices!.map((choice, i) => (
              <Button
                key={`${i}-${choice}`}
                w="100%"
                h="auto"
                minH="56px"
                py={3}
                whiteSpace="normal"
                textAlign="center"
                fontSize="20px"
                fontWeight="600"
                variant="outline"
                bg="#f3fbfc"
                borderColor="#16707e"
                color="#143"
                onClick={() => void gradeAnswer(choiceSubmitValue(i), false)}
              >
                {hasPracticeMath(choice) ? (
                  <FractionText value={choice} inline fontSize={20} color="inherit" align="center" />
                ) : (
                  choice
                )}
              </Button>
            ))}
            <DontKnowButton onClick={onDontKnow} />
          </VStack>
        ) : usesTemplateEditor && templateState ? (
          // A structured (fraction / expression) probe → the 2-D box editor with
          // the fraction / exponent glyph keys, identical to the practice session.
          <VStack w="100%" gap={4}>
            <Box w="100%" border="2px solid #16707e" borderRadius="12px" bg="#f3fbfc" px={4} py={3} textAlign="center" color="#143" minH="56px">
              <ExpressionEditor state={templateState} onSetCaret={onSetCaret} interactive />
            </Box>
            <ExpressionKeypad
              onInsertFraction={onInsertFraction}
              onInsertPower={onInsertPower}
              onInsertSquareRoot={onInsertSquareRoot}
              onInsertRoot={onInsertRoot}
              showRadicals={probe.answerType === "expression"}
              onDelete={() => onTemplateKey("⌫")}
              locked={!!templateState.structureLocked}
            />
            <Button w="100%" colorPalette="teal" size="lg" disabled={!input.trim()} onClick={onCheck}>
              Check <ArrowRight />
            </Button>
            <DontKnowButton onClick={onDontKnow} />
          </VStack>
        ) : (
          <>
            <Box w="100%" border="2px solid #16707e" borderRadius="12px" bg="#f3fbfc" px={4} py={3} textAlign="center" fontSize="26px" fontWeight="700" color="#143" minH="56px">
              {input || <Text as="span" color="#9bbcc2">type your answer</Text>}
            </Box>
            {/* The unit keys are the flat surface's only on-screen keys — the
                dimension family isn't on a hardware keyboard (digits are). */}
            {answerUnit && <UnitKeys answerUnit={answerUnit} onPick={onUnitKey} />}
            {/* A flat fraction/decimal/expression probe (no unit) gets a `/` key
                so a fraction is enterable without a hardware slash — parity with
                the native placement pad, whose grid carries `/` for these types.
                Mutually exclusive with the unit row (a unit item is integer). */}
            {!answerUnit &&
              current &&
              isPadAnswerType(current.answerType) &&
              padAcceptsFraction(current.answerType) && (
                <FractionKey onPick={() => onKey("/")} />
              )}
            {unitGateNudge && (
              <Text className="rh-note" fontSize="14px" color="#8a6d16" textAlign="center">
                {UNIT_MISSING_NUDGE}
              </Text>
            )}

            <Button w="100%" colorPalette="teal" size="lg" disabled={!input.trim()} onClick={onCheck}>
              Check <ArrowRight />
            </Button>
            <DontKnowButton onClick={onDontKnow} />
          </>
        )}
        {/* Placement state is resumable server-side, so leaving is always safe. */}
        {checkInExitVisible(homeHref) && <CheckInExitLink homeHref={homeHref!} />}
      </VStack>
    </Centered>
  );
}

function DontKnowButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" color="#6a6f68" fontWeight="500" onClick={onClick}>
      {DONT_KNOW_LABEL}
    </Button>
  );
}

/** The warm-up's coach-mark: a black bubble with white text and a small beak
 *  pointing at the control it names. Native twin: `TutorialCoachBubble` in
 *  NativePlacement.tsx — same shape, same colours, so the two surfaces read
 *  identically.
 *
 *  It is laid out IN FLOW rather than as a floating `Popover`, and that is the
 *  whole design decision. A real popover was built first and it OVERLAID the
 *  column: on the free beat the bubble covered the problem itself ("12 × 4"),
 *  and on the answer beat it covered the Check button the sentence tells you to
 *  press. Reserving exact space for a floating element whose height depends on
 *  its wrapped text is brittle, and hiding the question to explain the question
 *  is not a trade worth making — so the bubble takes its own row and occludes
 *  nothing. The beak is what points; adjacency does the rest. */
function TutorialCoachMark({ text, beak }: { text: string; beak: "up" | "down" }) {
  // The beak is a plain CSS triangle (a zero-size box with transparent sides),
  // the same construction the native bubble uses — even, no shadow, no gradient.
  const beakBox = (
    <Box
      w="0"
      h="0"
      alignSelf="center"
      borderLeft="8px solid transparent"
      borderRight="8px solid transparent"
      {...(beak === "up"
        ? { borderBottom: "8px solid #15181a" }
        : { borderTop: "8px solid #15181a" })}
    />
  );
  return (
    <VStack w="100%" gap={0} align="stretch">
      {beak === "up" && beakBox}
      <Box bg="#15181a" borderRadius="12px" px={4} py="10px" maxW="320px" alignSelf="center">
        <Text fontSize="14.5px" lineHeight="1.45" textAlign="center" color="white">
          {text}
        </Text>
      </Box>
      {beak === "down" && beakBox}
    </VStack>
  );
}

/** The quiet "I'll come back later" exit link (pilot7 f18 finding) — a small,
 *  understated text link, never a prominent button, so it reads as a calm
 *  option rather than a tempting escape hatch. Shared copy lives in
 *  shared/checkInResultCta.ts so web + native never drift on the words. */
function CheckInExitLink({ homeHref }: { homeHref: string }) {
  const router = useRouter();
  return (
    <Button
      variant="plain"
      size="sm"
      fontWeight="400"
      color="#9aa39a"
      _hover={{ color: "#6a6f68", textDecoration: "underline" }}
      onClick={() => router.push(homeHref)}
    >
      {CHECK_IN_EXIT_LABEL}
    </Button>
  );
}

/** The quiet "Skip the walkthrough" link — the SAME understated treatment as
 *  CheckInExitLink (small, low-contrast, never a prominent button), so the
 *  escape from the warm-up reads as a calm option, not a tempting bail-out. It
 *  jumps straight to the real probes via `onSkip` (the placement `start()`). */
function SkipWalkthroughLink({ onSkip }: { onSkip: () => void }) {
  return (
    <Button
      variant="plain"
      size="sm"
      fontWeight="400"
      color="#9aa39a"
      _hover={{ color: "#6a6f68", textDecoration: "underline" }}
      onClick={onSkip}
    >
      {TUTORIAL_LABELS.skip}
    </Button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Flex minH="calc(100vh - 64px)" align="center" justify="center" p={5} bg="#f6f4ef">
      {children}
    </Flex>
  );
}
