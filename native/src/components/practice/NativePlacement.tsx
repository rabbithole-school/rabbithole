/**
 * NativePlacement — the RN analogue of web `components/practice/Placement.tsx`,
 * the one-time placement quiz a brand-new scholar takes before practice so we
 * start them at their real level instead of grinding up from "count to 10".
 *
 * Parity, not a fork: it drives the SAME server-authoritative loop as web
 * (placement v2) — `api.practiceSkills.submitPlacementAnswer` primes the first
 * probe (no answer), grades one probe at a time (ternary: correct / incorrect /
 * "I haven't learned this yet"), and seeds mastery on finalize (the correct
 * answer is never sent to the client to grade). Answers advance directly to the
 * next probe without reporting correctness. It closes the iPad-parity gap where
 * native used to dead-end into a "do this on the web app" message.
 *
 * Input matches web: a multipleChoice probe that carries `choices` (e.g. a
 * fraction comparison — `<`/`=`/`>`, which a scholar can't type) renders
 * tappable options; everything else reuses the native practice keypad
 * (`PracticePadAnswer`) so a fraction/expression probe gets its `/` key without
 * a hardware keyboard, and a non-pad answerType with no choices falls back to
 * the integer pad, mirroring web's coerce-to-digits behaviour.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useMutation, useQuery } from "convex/react";
import { Stack } from "expo-router";
import * as Haptics from "expo-haptics";

import {
  PracticePadAnswer,
  PracticePrimaryAction,
  useGuardedPracticeAction,
} from "@/components/practice/NativePracticeControls";
import { PracticeProgressHeader } from "@/components/practice/PracticeProgressHeader";
import { StemCard } from "@/components/practice/StemCard";
import { api, type Id } from "@/lib/convex";
import { makePracticeShellStyles } from "@/lib/practiceShell";
import {
  applyKey,
  choiceSubmitValue,
  isPadAnswerType,
  DONT_KNOW_LABEL,
  PLACEMENT_SLIP_PROMPT,
  PLACEMENT_SLIP_RETRY_LABEL,
  PLACEMENT_SLIP_CONCEDE_LABEL,
  placementProgress,
  type PadAnswerType,
  type PlacementOutcome,
} from "@/lib/practicePad";
import { hasUnitToken, rawAnswersEqual } from "../../../vendor/practice/answers";
import { hasPracticeMath } from "../../../vendor/shared/fractions";
import { practiceDomainLabel } from "../../../vendor/shared/practiceDomainLabels";
import type { PracticePromptVisual } from "../../../vendor/shared/practicePromptVisual";
import { FractionText } from "@/components/FractionText";
import { useMapGates } from "@/hooks/useMapGates";
import { checkInResultCtaLabel } from "../../../vendor/shared/checkInResultCta";
import { checkInDomainChipLabel } from "../../../vendor/shared/checkInMapCopy";
import {
  placementSpotLabel,
  placementStartBody,
  placementStartHeadline,
} from "../../../vendor/shared/placementResultCopy";
import {
  checkTutorialAnswer,
  closeLine,
  TUTORIAL_BEATS,
  TUTORIAL_LABELS,
} from "../../../vendor/shared/placementTutorial";
import {
  NativeManipulative,
  isNativeManipulativeKind,
} from "@/components/manipulatives/NativeManipulative";
import { MANIPULATIVE_ANSWER_TYPE } from "../../../vendor/manipulative/practiceContract";
import type { ManipulativeSpec } from "../../../vendor/manipulative/types";
import { fonts, useColors } from "@/theme";

const COLUMN_MAX_WIDTH = 480;

type Probe = {
  itemId: string;
  grade: string;
  skillKey: string;
  strand: string;
  stem: string;
  answerType: string;
  /** The measurement unit this probe must be answered in, DISPLAY form ("cm³").
   *  Present ⇒ the unit is part of the answer (the server grades value AND
   *  unit), exactly as in the drill — the pad offers unit keys and an unlabeled
   *  answer is nudged back before it's graded. */
  answerUnit?: string;
  /** "twoD" ⇒ a genuine fraction/power/root answer that should use the 2-D box
   *  editor (stacked fraction / raised exponent), not the flat keypad — the
   *  server threads it onto the placement wire so a pre-test fraction probe
   *  gets the SAME builder web + the practice session use. */
  answerShape?: "twoD";
  choices?: string[];
  promptVisual?: PracticePromptVisual;
  /** Present only for a MANIPULATIVE probe (U-3): the JSON-serialized
   *  `ManipulativeSpec` the shared native stage renders. */
  manipulativeSpec?: string;
  /** The domain this probe belongs to — present only in a MIXED check-in, drives
   *  the per-item domain chip (#553 labels). */
  domain?: string;
  domainLabel?: string;
};

/** Parse a stored spec JSON to a `ManipulativeSpec`, or null if unusable (a
 *  native-only mirror of lib/manipulative/grade.ts's `parseManipulativeSpec`;
 *  native never grades locally, so it needs the parse but not the grader). */
function parsePlacementSpec(json: string | null | undefined): ManipulativeSpec | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { kind?: unknown }).kind === "string") {
      return parsed as ManipulativeSpec;
    }
  } catch {
    /* fall through */
  }
  return null;
}

type Feedback = {
  outcome: PlacementOutcome;
  correctAnswer?: string;
  /** The graded probe's domain (mixed check-in). */
  domain?: string;
  /** The placement WARMTH FLOOR reveal line — warm + deterministic (no live LLM). */
  revealLine?: string;
  /** Why a unit probe missed: "wrong" = right number, wrong unit; "missing" =
   *  no unit at all (the client gate is the first line of defence). */
  unitOutcome?: "missing" | "wrong";
  /** "Confirm before you cap": true when this typed miss is a possible SLIP — the
   *  server re-served a fresh item on the same skill instead of capping, so the
   *  surface offers the two-way slip/concede choice. */
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

type Phase = "boot" | "intro" | "tutorial" | "quiz" | "retry" | "submitting" | "result" | "paused";

/** The warm-up's coach-mark, native twin of web's `TutorialCoachMark`: a dark
 *  rounded bubble with white text and a small triangle "beak" pointing at the
 *  control it names. Laid out IN FLOW at the same position the old quiet callout
 *  line held — `beak="up"` sits BELOW its control (arrow up at the answer pad on
 *  beat 1); `beak="down"` sits ABOVE its control (arrow down at the escape link
 *  on beat 2, or the pad on beat 3). The beak is the usual RN zero-size View with
 *  transparent side borders — EVEN and simple, no shadow, no gradient, no
 *  one-sided stripe (visual-design.md). No animation, so nothing for
 *  useReducedMotion to gate. */
function TutorialCoachBubble({
  text,
  beak,
  styles,
}: {
  text: string;
  beak: "up" | "down";
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.coachWrap}>
      {beak === "up" ? <View style={styles.coachBeakUp} /> : null}
      <View style={styles.coachBubble}>
        <Text style={styles.coachBubbleText}>{text}</Text>
      </View>
      {beak === "down" ? <View style={styles.coachBeakDown} /> : null}
    </View>
  );
}

export function NativePlacement({
  scholarId,
  domain,
  multiDomain = false,
  topInset,
  onBack,
  onDone,
}: {
  scholarId: Id<"users">;
  /** A standing-practice assignment's domain (defaults to whole-number
   *  arithmetic engine-side when omitted). Ignored when `multiDomain`. */
  domain?: string;
  /** MIXED multi-domain "Math Check-In": place across EVERY registered domain in
   *  one interleaved session (the default no-pin practice entry). */
  multiDomain?: boolean;
  topInset: number;
  onBack: () => void;
  /** Finish the check-in. New in f14: the caller routes the scholar HOME (where
   *  the Tree reveal + playlists chooser land) rather than into more practice. */
  onDone: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // The scholar's OWN Tree-reveal state — drives the honest result-CTA label
  // (the check-in just unlocked the Tree). Native has no remote-rehearsal mode,
  // so this is always the real scholar.
  const { treeRevealPending } = useMapGates();
  const submitSingle = useMutation(api.practiceSkills.submitPlacementAnswer);
  const submitMixed = useMutation(api.practiceSkills.submitMixedPlacementAnswer);
  // Lazily minted on first use (in a handler, never during render).
  const seedRef = useRef<number | null>(null);
  const seedFor = useCallback(() => {
    if (seedRef.current === null) {
      seedRef.current = Math.floor(Math.random() * 2_000_000_000);
    }
    return seedRef.current;
  }, []);

  const [probe, setProbe] = useState<Probe | null>(null);
  const [answered, setAnswered] = useState(0);
  const [input, setInput] = useState("");
  // The probe whose Check was refused for a missing unit — cleared on the next
  // input change. Keyed by itemId (not a bare flag) so it can't outlive its probe.
  const [unitNudgeItemId, setUnitNudgeItemId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const gradeInFlightRef = useRef(false);
  // J3: the single-domain result is SKILL-anchored — the scholar's leading
  // frontier skill label, never a grade. `placed` only distinguishes the rare
  // all-mastered case from a true beginner in the numberless fallback copy.
  const [startingSkill, setStartingSkill] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  // The per-domain "your spots" summary for the MIXED check-in's result screen.
  const [perDomain, setPerDomain] = useState<PerDomainSummary[] | null>(null);

  // ── The pre-test WARM-UP walkthrough (vendor/shared/placementTutorial) ───────
  // Three non-graded beats that run ONCE, between the fresh intro and the first
  // real probe, teaching the surface by doing. Nothing here calls a Convex
  // mutation, so a warm-up answer can never reach placement scoring — the loop
  // only resumes (via `start()`) after the walkthrough ends. Parity with the web
  // twin (components/practice/Placement.tsx), driven by the SAME shared beats.
  const [tutorialIndex, setTutorialIndex] = useState(0);
  const [tutorialInput, setTutorialInput] = useState("");
  // Beat 1 only: the scholar has submitted, so show the warm/close line + Next
  // (nothing is scored, so a wrong answer still advances).
  const [tutorialChecked, setTutorialChecked] = useState(false);
  const [tutorialCorrect, setTutorialCorrect] = useState(false);
  // Beat 2 only: they tapped the muted Check anyway instead of the honest escape
  // — keep the callout up and add the single quiet nudge.
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
  // cross-domain prerequisite domain isn't placed yet)? We ALLOW the entry (the
  // raise-the-ceiling ethos, never a hard lock) but earn a gentle portrait-voiced
  // note on the intro. Skipped for the mixed check-in and when no domain is pinned.
  const gateInfo = useQuery(
    api.practiceSkills.domainsForScholar,
    !multiDomain && domain ? { scholarId } : "skip",
  );
  const gatedEntry = !multiDomain ? gateInfo?.find((d) => d.domain === domain) : undefined;
  // The specific unmet prerequisite to NAME in the note (recommend the real
  // prereq X, but still let them proceed). `enteredGatedConcept` = the short noun
  // ("division"); `enteredGatedLabel` = the domain being entered ("Fractions").
  const enteredGatedConcept = gatedEntry?.prereqGate?.concept ?? null;
  const enteredGatedLabel = gatedEntry?.label ?? (domain ? practiceDomainLabel(domain) : null);
  const resume = multiDomain ? resumeMixed : resumeSingle;
  // Leave the `boot` phase once the resume query resolves. React's render-phase
  // state-adjustment pattern (conditional, one-shot — `phase` flips out of
  // "boot"), NOT a setState-in-effect.
  if (phase === "boot" && resume !== undefined) {
    if (resume.done) {
      // Placement already complete (a reload after finishing, or a remount) — go
      // straight to the RESULT screen, NEVER the intro. Re-running a done placement
      // must be impossible.
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

  // Unified submit — one call shape dispatched to the single- or multi-domain
  // server loop, normalized to a common result the phase machine reads.
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

  // Prime the first probe (a query can't persist the served probe, so we prime
  // through the mutation with no answer).
  const start = useCallback(() => {
    setPhase("submitting");
    void (async () => {
      const res = await submit({});
      // The walkthrough's handoff line rides ONLY this first priming screen; clear
      // it as soon as the first probe lands, so a later mid-quiz "submitting"
      // never flashes "Okay — here we go." instead of "Getting ready…".
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
        // (a stale/dead parked probe, a mid-deploy old/new skew). Quiz with a
        // null probe is a blank card with no way out (the 2026-08-18 stuck
        // check-in); land on the intro instead — visible, and Start re-primes.
        // (Parity with web Placement.tsx prime().)
        setPhase("intro");
      }
    })().catch(() => {});
  }, [submit]);

  // ── Walkthrough control (parity with web Placement.tsx) ──────────────────────
  // Enter the walkthrough from the intro's Start button (a genuinely fresh
  // pre-test only — a mid-placement reload lands in `quiz`, never here).
  const beginTutorial = useCallback(() => {
    setTutorialIndex(0);
    setTutorialInput("");
    setTutorialChecked(false);
    setTutorialCorrect(false);
    setTutorialNudge(false);
    setPhase("tutorial");
  }, []);

  // Move to the next beat, or — past the last beat — hand off to the real probes
  // with the warm one-liner riding the priming screen (no separate "ready?" step).
  const advanceTutorial = useCallback(() => {
    setTutorialInput("");
    setTutorialChecked(false);
    setTutorialCorrect(false);
    setTutorialNudge(false);
    if (tutorialIndex >= TUTORIAL_BEATS.length - 1) {
      setHandoff(true);
      start();
      return;
    }
    setTutorialIndex((i) => i + 1);
  }, [tutorialIndex, start]);

  // Single-flight the advance so a tap and a hardware Return can't fire the same
  // advance twice before React commits the next beat (the SAME guard the graded
  // quiz uses for Check). Re-arms per beat (and per beat-1 feedback). Every
  // advance path — beat-1 Next, the honest-escape tap, beat-3's submitted answer
  // — routes through this.
  const onTutorialAdvance = useGuardedPracticeAction(
    advanceTutorial,
    phase === "tutorial",
    `tutorialAdvance:${tutorialIndex}:${tutorialChecked ? "checked" : "open"}`,
  );

  // Skipping is an exit too, so it takes the SAME single-flight guard — a
  // hardware Return landing on Skip mid-advance would otherwise prime twice.
  const onTutorialSkip = useGuardedPracticeAction(
    start,
    phase === "tutorial",
    `tutorialSkip:${tutorialIndex}`,
  );

  // Beat 1: grade locally (records nothing — the injected REAL grader normalizes
  // representation) then show the warm/close line. A wrong answer still advances.
  const gradeTutorialBeat = useCallback(() => {
    if (!tutorialInput.trim()) return;
    const beat = TUTORIAL_BEATS[tutorialIndex];
    setTutorialCorrect(checkTutorialAnswer(beat, tutorialInput, rawAnswersEqual));
    setTutorialChecked(true);
  }, [tutorialIndex, tutorialInput]);

  // Beat 2's Check is a no-op that only nudges toward the honest escape.
  const nudgeTutorial = useCallback(() => setTutorialNudge(true), []);

  // Input building — reuse the SAME flat-answer key routing as the real quiz
  // (never a second key handler): a pad tap or a hardware key builds the input.
  const onTutorialKey = useCallback((k: string) => {
    Haptics.selectionAsync().catch(() => {});
    setTutorialInput((prev) => applyKey(prev, k));
  }, []);
  const onTutorialInput = useCallback((next: string) => setTutorialInput(next), []);

  const current = probe;
  const reduceMotion = useReducedMotion();
  // The mixed check-in's progress meter is per-SITTING: "N of up to 30 today"
  // against the day's probe budget, not the full multi-domain sweep.
  const sittingMaxQuestions =
    resume && "sittingMaxQuestions" in resume ? resume.sittingMaxQuestions : undefined;
  const progress = multiDomain
    ? placementProgress(answered, sittingMaxQuestions ?? answered + 1, false, true)
    : placementProgress(answered, resume?.maxQuestions ?? answered + 1);
  const standardHeader = <Stack.Screen options={{ title: "Practice", headerShown: true }} />;
  const placementHeader = (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <PracticeProgressHeader
        title="Finding your level"
        progressLabel={`${progress.questionNumber} of up to ${progress.maxQuestions}${multiDomain ? " today" : ""}`}
        progressAccessibilityLabel={progress.label}
        progressPercent={progress.percent}
        topInset={topInset}
        onBack={onBack}
      />
    </>
  );

  const onKey = useCallback((k: string) => {
    Haptics.selectionAsync().catch(() => {});
    setUnitNudgeItemId(null);
    setInput((prev) => applyKey(prev, k));
  }, []);

  // Typed input (and the pad's unit keys, which rewrite the value rather than
  // append) — any input change retires the nudge.
  const onInput = useCallback((next: string) => {
    setUnitNudgeItemId(null);
    setInput(next);
  }, []);

  // Submit one answer (or a Don't-Know). The server records the measurement,
  // then the scholar moves directly to the next probe without a verdict.
  const gradeAnswer = useCallback(
    (answer: string, dontKnow: boolean) => {
      if (!current || gradeInFlightRef.current) return;
      gradeInFlightRef.current = true;
      setPhase("submitting");
      void (async () => {
        const res = await submit({ itemId: current.itemId, answer, ...(dontKnow ? { dontKnow: true } : {}) });
        setInput("");
        // Staleness guard: a stale/duplicate submit (itemId no longer the served
        // probe) grades NOTHING — the server returns `graded: null` and re-serves
        // the same probe. Treat it as "no feedback": re-render that probe, don't
        // flash a fake incorrect/unknown or bump the answered count. (A no-op that
        // ALSO finalized still routes to the result screen.)
        if (res.graded === null) {
          if (res.done) {
            setStartingSkill(res.startingSkillLabel);
            setPlaced(res.placedThroughGrade != null);
            setPerDomain(res.perDomain);
            setPhase("result");
          } else {
            setProbe(res.probe ?? current);
            setPhase("quiz");
          }
          return;
        }
        setAnswered((n) => n + 1);
        // "Confirm before you cap": a first typed miss is a possible slip — the
        // server re-served a FRESH item on the SAME skill (res.probe) and did NOT
        // cap. Offer the two-way choice instead of moving straight on.
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
          // serve (same escape as start(): never quiz-with-null, it's a blank
          // dead-end). Intro is visible and its Start re-primes.
          setPhase("intro");
        }
      })()
        .catch(() => setPhase("quiz"))
        .finally(() => {
          gradeInFlightRef.current = false;
        });
    },
    [current, submit],
  );

  const onCheck = useCallback(() => {
    const answer = input.trim();
    if (!answer) return;
    gradeAnswer(answer, false);
  }, [input, gradeAnswer]);

  // The two-way slip/concede choice, shown after a first typed miss.
  const onRetrySlip = useCallback(() => {
    setInput("");
    setPhase("quiz");
  }, []);
  const onRetryConcede = useCallback(() => {
    gradeAnswer("", true);
  }, [gradeAnswer]);
  const checkEnabled = phase === "quiz" && !!current && !!input.trim();
  // A unit probe's answer isn't finished until it carries a unit — an unlabeled
  // number grades INCORRECT server-side, so a formatting slip would cost a
  // measurement. Any trailing unit token passes: a WRONG unit is the grader's
  // call ("so close"), never the client's. Only a genuinely TYPED probe is
  // gated — a don't-know never comes through here, and a multipleChoice probe
  // coerced onto the pad (no `choices` payload) answers with an option index,
  // not a measurement, even when its family declares a unit.
  const unitAnswerRequired =
    !!current?.answerUnit && isPadAnswerType(current?.answerType ?? "");
  const unitReady = !unitAnswerRequired || hasUnitToken(input.trim());
  const unitNudge = !!current && unitNudgeItemId === current.itemId;
  // Refusing INSIDE the guarded action would latch it (its fired-flag only
  // releases when `enabled` or the reset key changes), leaving Check dead.
  const onCheckGuarded = useGuardedPracticeAction(
    onCheck,
    checkEnabled && unitReady,
    `check:${current?.itemId ?? "none"}:${phase}`,
  );
  const onCheckPrimary = useCallback(() => {
    // Refuse only a Check that would otherwise have graded.
    if (checkEnabled && current && !unitReady) {
      setUnitNudgeItemId(current.itemId);
      return;
    }
    onCheckGuarded();
  }, [checkEnabled, current, unitReady, onCheckGuarded]);

  const onDontKnow = useCallback(() => gradeAnswer("", true), [gradeAnswer]);

  // ── Manipulative probe (U-3) — the full item union on placement ─────────────
  // A manipulative probe renders the shared native stage instead of the pad; the
  // scholar builds a configuration and taps Done, which grades through the SAME
  // ternary placement path a typed answer uses (the server re-runs isSolved).
  const isManipulativeProbe = current?.answerType === MANIPULATIVE_ANSWER_TYPE;
  const manipSpec = useMemo(
    () => (isManipulativeProbe ? parsePlacementSpec(current?.manipulativeSpec) : null),
    [isManipulativeProbe, current?.manipulativeSpec],
  );
  // The kind's latest runtime state, lifted so Done can submit it. Reset whenever
  // the served probe changes so a new manipulative starts blank.
  const [manipState, setManipState] = useState<unknown>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Changing the probe identity must clear the lifted runtime state before the new manipulative renders.
    setManipState(null);
  }, [current?.itemId]);
  const onManipDone = useCallback(() => {
    if (manipState === null) return;
    gradeAnswer(JSON.stringify(manipState), false);
  }, [manipState, gradeAnswer]);
  const manipDoneEnabled =
    phase === "quiz" && isManipulativeProbe && !!manipSpec && manipState !== null;
  const onManipDonePrimary = useGuardedPracticeAction(
    onManipDone,
    manipDoneEnabled,
    `placeManipDone:${current?.itemId ?? "none"}:${phase}`,
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  if (phase === "intro") {
    return (
      <>
        {standardHeader}
        <View style={styles.centered}>
          <View style={styles.messageCard}>
          <Text style={styles.emoji}>🧭</Text>
          {multiDomain ? (
            <>
              <Text style={styles.messageTitle}>Let&apos;s map what you already know</Text>
              <Text style={styles.messageBody}>
                A one-time check-in — a map of what you already know, not a
                test. Nothing here is graded.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.messageTitle}>Let&apos;s find your starting point</Text>
              {enteredGatedConcept ? (
                <View style={styles.gatedNote}>
                  <Text style={styles.gatedNoteText}>
                    {enteredGatedLabel ?? "This topic"} builds on {enteredGatedConcept} — we
                    recommend getting comfortable with {enteredGatedConcept} first, but you
                    can try it now if you want a challenge. 🌱
                  </Text>
                </View>
              ) : null}
              <Text style={styles.messageBody}>
                A few quick problems so we start you in the right place — not too easy,
                not too hard.
              </Text>
            </>
          )}
          <Pressable
            onPress={beginTutorial}
            style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="Start the math check-in"
          >
            <Text style={styles.primaryBtnText}>Start  →</Text>
          </Pressable>
          </View>
        </View>
      </>
    );
  }

  if (phase === "retry") {
    // "Confirm before you cap": a first typed miss offers a two-way choice —
    // treat it as a slip (a fresh item on the same skill) or honestly concede
    // (caps immediately, the fast path). No answer is revealed: a slip's confirm
    // must stay a fair re-measurement.
    return (
      <>
        {standardHeader}
        <View style={styles.centered}>
          <View style={styles.messageCard}>
            <Text style={styles.emoji}>🤔</Text>
            <Text style={styles.messageTitle}>{PLACEMENT_SLIP_PROMPT}</Text>
            <Pressable
              onPress={onRetrySlip}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
              accessibilityLabel={PLACEMENT_SLIP_RETRY_LABEL}
            >
              <Text style={styles.primaryBtnText}>{PLACEMENT_SLIP_RETRY_LABEL}</Text>
            </Pressable>
            <Pressable
              onPress={onRetryConcede}
              style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel={PLACEMENT_SLIP_CONCEDE_LABEL}
            >
              <Text style={styles.linkBtnText}>{PLACEMENT_SLIP_CONCEDE_LABEL}</Text>
            </Pressable>
          </View>
        </View>
      </>
    );
  }

  if (phase === "boot" || (phase === "submitting" && !current)) {
    return (
      <>
        {current ? placementHeader : standardHeader}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={styles.loadingText}>
            {handoff ? TUTORIAL_LABELS.handoff : "Getting ready…"}
          </Text>
        </View>
      </>
    );
  }

  if (phase === "result") {
    // MIXED check-in: summarize each domain's spot ("your spots").
    if (multiDomain && perDomain) {
      const anyPlaced = perDomain.some((d) => d.startingSkillLabel || d.placedThroughGrade);
      return (
        <>
          {standardHeader}
          <View style={styles.centered}>
            <View style={styles.messageCard}>
            <Text style={styles.emoji}>🎯</Text>
            <Text style={styles.messageTitle}>Here are your spots</Text>
            <Text style={styles.messageBody}>
              {anyPlaced
                ? "We found where you're ready to grow in each area. You can always revisit anything earlier."
                : "We'll build strong foundations together, step by step."}
            </Text>
            <View style={styles.perDomainList}>
              {perDomain.map((d) => (
                <View key={d.domain} style={styles.perDomainRow}>
                  <Text style={styles.perDomainLabel}>{practiceDomainLabel(d.domain)}</Text>
                  <Text style={styles.perDomainGrade}>
                    {placementSpotLabel(d.startingSkillLabel)}
                  </Text>
                </View>
              ))}
            </View>
            <PracticePrimaryAction
              label={`${checkInResultCtaLabel(treeRevealPending)}  →`}
              accessibilityLabel={checkInResultCtaLabel(treeRevealPending)}
              captureReturn
              styles={styles}
              indicatorColor={colors.white}
              onAction={onDone}
            />
            </View>
          </View>
        </>
      );
    }
    return (
      <>
        {standardHeader}
        <View style={styles.centered}>
          <View style={styles.messageCard}>
          <Text style={styles.emoji}>🎯</Text>
          <Text style={styles.messageTitle}>
            {placementStartHeadline(startingSkill, placed)}
          </Text>
          <Text style={styles.messageBody}>
            {placementStartBody(startingSkill, placed)}
          </Text>
          <PracticePrimaryAction
            label={`${checkInResultCtaLabel(treeRevealPending)}  →`}
            accessibilityLabel={checkInResultCtaLabel(treeRevealPending)}
            captureReturn
            styles={styles}
            indicatorColor={colors.white}
            onAction={onDone}
          />
          </View>
        </View>
      </>
    );
  }

  // Warm per-sitting pause — the mixed check-in's day budget is spent. A calm
  // "good picture already, more tomorrow" with the same "Start practicing" CTA as
  // the result screen: practice proceeds on whatever placed so far; the unplaced
  // domains simply reappear as a check-in entry next sitting. No countdown, no
  // progress-guilt. (Web twin: components/practice/Placement.tsx.)
  if (phase === "paused") {
    return (
      <>
        {standardHeader}
        <View style={styles.centered}>
          <View style={styles.messageCard}>
            <Text style={styles.emoji}>🌱</Text>
            <Text style={styles.messageTitle}>Great mapping today</Text>
            <Text style={styles.messageBody}>
              We&apos;ve got a good picture of where you&apos;re ready to grow already —
              let&apos;s pick up the rest tomorrow. Your practice is ready to go now.
            </Text>
            <PracticePrimaryAction
              label="Start practicing  →"
              accessibilityLabel="Start practicing"
              captureReturn
              styles={styles}
              indicatorColor={colors.white}
              onAction={onDone}
            />
          </View>
        </View>
      </>
    );
  }

  if (phase === "tutorial") {
    // ── The pre-test WARM-UP walkthrough screen (parity with web Placement.tsx) ──
    // Its OWN screen: the callouts sit IN FLOW, adjacent to the affordance they
    // name (adjacency is the pointing — no arrow), and the single teal ring points
    // by proximity. The header reuses the SAME PracticeProgressHeader as the real
    // probes but with an HONEST "Quick warm-up" label + a 1-of-3 meter, so the
    // meter never lies and the transition into the graded probes keeps the
    // identical header. No animation is introduced (the ring is a static border),
    // so there is nothing for useReducedMotion to gate.
    const beat = TUTORIAL_BEATS[tutorialIndex];
    const total = TUTORIAL_BEATS.length;
    const isDontKnowBeat = beat.kind === "dontKnow";
    const isFreeBeat = beat.kind === "free";
    // Beat 3: a submitted answer is one valid path (guarded so a tap + Return
    // can't double-advance); an empty submit is a no-op.
    const onFreeSubmit = () => {
      if (tutorialInput.trim()) onTutorialAdvance();
    };
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <PracticeProgressHeader
          title={TUTORIAL_LABELS.header}
          progressLabel={`${tutorialIndex + 1} of ${total}`}
          progressAccessibilityLabel={`${TUTORIAL_LABELS.header} ${tutorialIndex + 1} of ${total}`}
          // Fills to match the "N of 3" label beside it — a bar still empty on
          // "1 of 3" reads as broken on a three-beat meter, where the real probe
          // meter's answered/total convention has room to run.
          progressPercent={((tutorialIndex + 1) / total) * 100}
          topInset={topInset}
          onBack={onBack}
        />
        <View style={styles.screen}>
          <ScrollView style={styles.stageScrollFlex} contentContainerStyle={styles.stageScroll}>
            <View style={styles.quizColumn}>
              {/* Beat 2's honest framing — the ONE place a soft boxed note is right
                  (the existing even-bordered gatedNote treatment: no accent stripe,
                  no gradient). */}
              {beat.framing ? (
                <View style={styles.gatedNote}>
                  <Text style={styles.gatedNoteText}>{beat.framing}</Text>
                </View>
              ) : null}

              {/* Neutral stem card (no verdict stamp — nothing here is scored). */}
              <StemCard
                stem={beat.stem}
                feedback={null}
                reduceMotion={reduceMotion}
                styles={styles}
              />

              {tutorialChecked ? (
                // Beat 1, after submit: the warm/close line + a plain Next. Nothing
                // is scored, so a wrong answer still moves forward. The pad has
                // unmounted, so Next captures the hardware Return itself.
                <View style={styles.answerBlock}>
                  <Text
                    style={[
                      styles.tutorialFeedback,
                      tutorialCorrect ? styles.tutorialFeedbackCorrect : styles.tutorialFeedbackClose,
                    ]}
                  >
                    {tutorialCorrect ? TUTORIAL_LABELS.correct : closeLine(beat)}
                  </Text>
                  <PracticePrimaryAction
                    label="Next  →"
                    accessibilityLabel="Next"
                    captureReturn
                    styles={styles}
                    indicatorColor={colors.white}
                    onAction={onTutorialAdvance}
                  />
                </View>
              ) : isDontKnowBeat ? (
                // Beat 2: the Check reads as MUTED and only nudges (never advances);
                // the single ring moves to the honest-escape link, its only exit.
                // The pad stays visible + typeable so a kid CAN try — the Check/pad
                // Return just redirect them to the honest tap.
                <View style={styles.answerBlock}>
                  <PracticePadAnswer
                    answerType="integer"
                    value={tutorialInput}
                    enabled
                    focusKey={`tutorial:${beat.id}`}
                    placeholderColor={colors.charcoalSubtle}
                    styles={styles}
                    onChange={onTutorialInput}
                    onKey={onTutorialKey}
                    onSubmit={nudgeTutorial}
                  />
                  <Pressable
                    onPress={nudgeTutorial}
                    style={styles.tutorialCheckMuted}
                    accessibilityRole="button"
                    accessibilityLabel="Check answer"
                  >
                    <Text style={styles.tutorialCheckMutedText}>Check</Text>
                  </Pressable>
                  {tutorialNudge ? (
                    <Text style={styles.noteMiss}>{TUTORIAL_LABELS.nudge}</Text>
                  ) : null}
                  {/* The coach-mark bubble sits directly ABOVE the link it names,
                      its beak pointing down at it. The teal ring this link used
                      to wear is gone — the beak and a ring are two marks for one
                      variable, and the beak is the more legible of the two. */}
                  <TutorialCoachBubble text={beat.callout.native} beak="down" styles={styles} />
                  <Pressable
                    onPress={onTutorialAdvance}
                    style={styles.linkBtn}
                    accessibilityRole="button"
                    accessibilityLabel={DONT_KNOW_LABEL}
                  >
                    <Text style={styles.linkBtnText}>{DONT_KNOW_LABEL}</Text>
                  </Pressable>
                </View>
              ) : (
                // Beat 1 ("how to answer") and beat 3 (either path is fine, so the
                // honest escape is offered alongside Check). Neither wears a ring —
                // these controls are already the teal-edged focus of the screen; the
                // callout's position is what points. The pad's own field captures
                // the hardware Return during answering.
                <View style={styles.answerBlock}>
                  {/* Beat 3's instruction is about the CHOICE, not about one
                      control, so it sits above both, beak pointing down at the pad. */}
                  {isFreeBeat ? (
                    <TutorialCoachBubble text={beat.callout.native} beak="down" styles={styles} />
                  ) : null}
                  <PracticePadAnswer
                    answerType="integer"
                    value={tutorialInput}
                    enabled
                    focusKey={`tutorial:${beat.id}`}
                    placeholderColor={colors.charcoalSubtle}
                    styles={styles}
                    onChange={onTutorialInput}
                    onKey={onTutorialKey}
                    onSubmit={isFreeBeat ? onFreeSubmit : gradeTutorialBeat}
                  />
                  {/* Beat 1's coach-mark sits directly UNDER the pad it names, its
                      beak pointing up at it. */}
                  {beat.kind === "answer" ? (
                    <TutorialCoachBubble text={beat.callout.native} beak="up" styles={styles} />
                  ) : null}
                  <PracticePrimaryAction
                    label="Check  →"
                    accessibilityLabel="Check answer"
                    disabled={!tutorialInput.trim()}
                    styles={styles}
                    indicatorColor={colors.white}
                    onAction={isFreeBeat ? onFreeSubmit : gradeTutorialBeat}
                  />
                  {isFreeBeat ? (
                    <Pressable
                      onPress={onTutorialAdvance}
                      style={styles.linkBtn}
                      accessibilityRole="button"
                      accessibilityLabel={DONT_KNOW_LABEL}
                    >
                      <Text style={styles.linkBtnText}>{DONT_KNOW_LABEL}</Text>
                    </Pressable>
                  ) : null}
                </View>
              )}

              {/* Every beat carries the quiet skip link — always present so nobody
                  is trapped (incl. the teacher remote-rehearsal path). Understated
                  + low-contrast, never a prominent button; jumps to the real probes
                  via start(). */}
              <Pressable
                onPress={onTutorialSkip}
                style={styles.linkBtn}
                accessibilityRole="button"
                accessibilityLabel={TUTORIAL_LABELS.skip}
              >
                <Text style={styles.tutorialSkipText}>{TUTORIAL_LABELS.skip}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </>
    );
  }

  // quiz — probes are numeric anchors; a non-pad answerType coerces to the
  // integer pad (mirrors web's fixed digit grid).
  const padType: PadAnswerType = isPadAnswerType(current?.answerType ?? "")
    ? (current!.answerType as PadAnswerType)
    : "integer";
  const showChoices =
    current?.answerType === "multipleChoice" && (current.choices?.length ?? 0) > 0;
  const quizActive = phase === "quiz";
  // A manipulative probe with a spec whose kind native can render inline.
  const supportedManip = isManipulativeProbe && !!manipSpec && isNativeManipulativeKind(manipSpec.kind);

  return (
    <>
      {placementHeader}
      <View style={styles.screen}>
        <ScrollView style={styles.stageScrollFlex} contentContainerStyle={styles.stageScroll}>
          <View style={styles.quizColumn}>
          {/* Per-item domain chip — shown ONLY in a mixed check-in, so the scholar
              sees when the subject switches. A plain even-bordered pill (no accent
              stripe/gradient — visual-design rules); the human label comes from the
              domain registry, never the raw slug. Mirrors web + the mixed playlist. */}
          {multiDomain && current?.domain ? (
            <View style={styles.domainChipRow}>
              <View style={styles.domainChip}>
                <Text style={styles.domainChipText}>
                  {checkInDomainChipLabel(current.domainLabel ?? practiceDomainLabel(current.domain))}
                </Text>
              </View>
            </View>
          ) : null}

          {/* Stem — hidden for a manipulative probe with a usable spec, whose
              own concept + prompt block below carries the question (no
              duplicate), matching the drill and web. A probe whose spec won't
              parse has no such block, so it keeps the stem card rather than
              rendering nothing readable.
              Neutral (no verdict) here — the quiz phase never carries a stamp. */}
          {!isManipulativeProbe || !manipSpec ? (
            <StemCard
              stem={current?.stem}
              promptVisual={current?.promptVisual}
              feedback={null}
              reduceMotion={reduceMotion}
              styles={styles}
              speakable={current?.grade === "K"}
            />
          ) : null}

        {isManipulativeProbe ? (
          // A manipulative probe — the shared native stage (the same one the drill
          // uses). Done grades the locked-in state through the placement path
          // (onManipDonePrimary in the CTA lane); the answer is never revealed.
          <View style={styles.answerBlock}>
            {/* THE QUESTION. A manipulative stage renders only MECHANICS — a
                number line's caption is "Start at 3. Drag the dot left or
                right." — so without this block the probe is unanswerable, and a
                placement probe's answer is written into the scholar's map as
                evidence. Rendering the spec's concept + prompt is the same
                single rendering the native drill card (NativeManipulativeItem)
                and the web twin (components/manipulative/Manipulative.tsx) show;
                the served `stem` is the same authored sentence, so only one of
                the two is ever on screen. */}
            {manipSpec ? (
              <View style={styles.manipPromptBlock}>
                {manipSpec.concept ? (
                  <Text style={styles.manipConcept}>{manipSpec.concept.toUpperCase()}</Text>
                ) : null}
                <Text style={styles.manipPrompt}>{manipSpec.prompt}</Text>
              </View>
            ) : null}
            {supportedManip && manipSpec ? (
              <View style={styles.manipStage} pointerEvents={quizActive ? "auto" : "none"}>
                <NativeManipulative
                  key={current?.itemId}
                  spec={manipSpec}
                  onSolvedChange={() => {}}
                  onStateChange={setManipState}
                />
              </View>
            ) : (
              <Text style={styles.manipFallback}>
                This activity can&apos;t be shown here yet — tap &ldquo;{DONT_KNOW_LABEL}&rdquo; below.
              </Text>
            )}
          </View>
        ) : showChoices ? (
          /* multipleChoice with choices (e.g. `<`/`=`/`>`) — tappable options,
             matching web; a scholar can't type these on the number pad. */
          <View style={styles.choices}>
            {current!.choices!.map((choice, i) => (
              <Pressable
                key={`${i}-${choice}`}
                disabled={!current || !quizActive}
                onPress={() => gradeAnswer(choiceSubmitValue(i), false)}
                style={({ pressed }) => [styles.choice, pressed && styles.choicePressed]}
                accessibilityRole="button"
              >
                {hasPracticeMath(choice) ? (
                  <FractionText value={choice} inline fontSize={18} align="center" />
                ) : (
                  <Text style={styles.choiceText}>{choice}</Text>
                )}
              </Pressable>
            ))}
          </View>
        ) : (
          <View style={styles.answerBlock}>
            <PracticePadAnswer
              answerType={padType}
              answerShape={current?.answerShape}
              answerUnit={unitAnswerRequired ? current?.answerUnit : undefined}
              unitNudge={unitNudge}
              value={input}
              enabled={quizActive && !!current}
              focusKey={current?.itemId ?? "none"}
              placeholderColor={colors.charcoalSubtle}
              styles={styles}
              onChange={onInput}
              onKey={onKey}
              onSubmit={onCheckPrimary}
            />
          </View>
        )}
          </View>
        </ScrollView>
        <View style={styles.ctaLane}>
          {isManipulativeProbe ? (
            supportedManip ? (
              <PracticePrimaryAction
                label="Done  →"
                accessibilityLabel="Done"
                disabled={!manipDoneEnabled}
                loading={phase === "submitting"}
                styles={styles}
                indicatorColor={colors.white}
                onAction={onManipDonePrimary}
              />
            ) : null
          ) : !showChoices ? (
            <PracticePrimaryAction
              label="Check  →"
              accessibilityLabel="Check answer"
              disabled={!checkEnabled}
              loading={phase === "submitting"}
              styles={styles}
              indicatorColor={colors.white}
              onAction={onCheckPrimary}
            />
          ) : null}
          <View
            style={[styles.skipSlot, !quizActive && styles.skipSlotHidden]}
            pointerEvents={quizActive ? "auto" : "none"}
          >
            <Pressable
              onPress={onDontKnow}
              disabled={!quizActive}
              style={styles.linkBtn}
              accessibilityRole="button"
              accessibilityElementsHidden={!quizActive}
              importantForAccessibility={quizActive ? "auto" : "no-hide-descendants"}
            >
              <Text style={styles.linkBtnText}>{DONT_KNOW_LABEL}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(c: ColorSet) {
  return StyleSheet.create({
    ...makePracticeShellStyles(c),
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: 24,
      backgroundColor: c.bgSubtle,
    },
    loadingText: { fontFamily: fonts.regular, fontSize: 14, color: c.fgMuted },

    // Manipulative probe (U-3): the shared native stage sits in the answer block,
    // centered; a forward-compat/unrenderable kind shows a calm fallback line.
    manipStage: { width: "100%", alignItems: "center", justifyContent: "center" },
    // The probe's question, above the stage — same eyebrow + prompt pairing the
    // drill card uses, so a manipulative reads identically wherever it appears.
    manipPromptBlock: { width: "100%", marginBottom: 12 },
    manipConcept: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
      letterSpacing: 1,
      color: c.charcoalSubtle,
    },
    manipPrompt: {
      fontFamily: fonts.bold,
      fontSize: 19,
      lineHeight: 24,
      color: c.navy,
      marginTop: 2,
    },
    manipFallback: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.fgMuted,
      textAlign: "center",
      paddingHorizontal: 12,
    },

    // Intro / result message card
    messageCard: {
      width: "100%",
      maxWidth: 420,
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 24,
      gap: 12,
      alignItems: "center",
    },
    emoji: { fontSize: 40, lineHeight: 46 },
    messageTitle: { fontFamily: fonts.bold, fontSize: 20, color: c.fg, textAlign: "center" },
    messageBody: {
      fontFamily: fonts.regular,
      fontSize: 14.5,
      lineHeight: 21,
      color: c.fgMuted,
      textAlign: "center",
    },
    // Gentle portrait-voiced note for a self-directed entry into a still-gated
    // domain — a calm callout, never a "locked" wall.
    gatedNote: {
      backgroundColor: c.bgSubtle,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    gatedNoteText: {
      fontFamily: fonts.regular,
      fontSize: 13.5,
      lineHeight: 20,
      color: c.fgMuted,
      textAlign: "center",
    },

    // Mixed check-in "your spots" summary — one calm even-bordered row per domain.
    perDomainList: { width: "100%", gap: 8 },
    perDomainRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: c.bgSubtle,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    perDomainLabel: { fontFamily: fonts.semibold, fontSize: 14.5, color: c.fg },
    perDomainGrade: { fontFamily: fonts.regular, fontSize: 13.5, color: c.fgMuted },

    // Per-item domain chip (mixed check-in) — a plain even-bordered pill.
    domainChipRow: { flexDirection: "row", justifyContent: "center" },
    domainChip: {
      backgroundColor: c.bgSubtle,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      paddingVertical: 3,
    },
    domainChipText: { fontFamily: fonts.semibold, fontSize: 12, color: c.cyan },

    // ── Warm-up walkthrough (tutorial phase) ────────────────────────────────
    // The warm-up coach-mark bubble — a dark rounded bubble with white text and
    // a small triangle beak pointing at the control it names. Fixed near-black
    // (not a theme token) so it reads as the same coach-mark on light + dark, the
    // web twin's #15181a. Even, simple, no shadow/gradient (visual-design.md).
    coachWrap: { width: "100%", alignItems: "center" },
    coachBubble: {
      maxWidth: 300,
      backgroundColor: "#15181a",
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    coachBubbleText: {
      fontFamily: fonts.regular,
      fontSize: 14.5,
      lineHeight: 20,
      color: "#ffffff",
      textAlign: "center",
    },
    // Beak pointing UP (bubble below its control) — flat base overlaps the bubble
    // top by 1px so there's no seam.
    coachBeakUp: {
      width: 0,
      height: 0,
      borderLeftWidth: 8,
      borderRightWidth: 8,
      borderBottomWidth: 9,
      borderLeftColor: "transparent",
      borderRightColor: "transparent",
      borderBottomColor: "#15181a",
      marginBottom: -1,
    },
    // Beak pointing DOWN (bubble above its control).
    coachBeakDown: {
      width: 0,
      height: 0,
      borderLeftWidth: 8,
      borderRightWidth: 8,
      borderTopWidth: 9,
      borderLeftColor: "transparent",
      borderRightColor: "transparent",
      borderTopColor: "#15181a",
      marginTop: -1,
    },
    // Beat 2's Check reads as inactive (blends into the screen shoulder) but is
    // pressable, so it can fire the single quiet nudge toward the honest escape.
    tutorialCheckMuted: {
      minHeight: 52,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bgSubtle,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    tutorialCheckMutedText: { fontFamily: fonts.semibold, fontSize: 16, color: c.fgMuted },
    // Beat 1's warm/close feedback line (correctness carried by text + color; no
    // verdict stamp, since nothing is scored).
    tutorialFeedback: {
      fontFamily: fonts.semibold,
      fontSize: 15,
      lineHeight: 21,
      textAlign: "center",
    },
    tutorialFeedbackCorrect: { color: c.green },
    tutorialFeedbackClose: { color: c.orange },
    // The quiet skip link — low-contrast, never a prominent button.
    tutorialSkipText: {
      fontFamily: fonts.regular,
      fontSize: 14,
      color: c.fgMuted,
      textAlign: "center",
    },

    // Quiz
    quizColumn: { width: "100%", maxWidth: COLUMN_MAX_WIDTH, gap: 18 },
    answerBlock: { width: "100%", gap: 10 },

    stemBox: {
      minHeight: 116,
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 20,
      paddingVertical: 24,
      alignItems: "center",
      justifyContent: "center",
      gap: 14,
    },
    stemText: {
      fontFamily: fonts.semibold,
      fontSize: 28,
      lineHeight: 38,
      textAlign: "center",
      color: c.fg,
    },

    inputBox: {
      minHeight: 56,
      borderWidth: 2,
      borderColor: c.cyan,
      borderRadius: 12,
      backgroundColor: c.cyanSubtle,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    inputText: { fontFamily: fonts.bold, fontSize: 26, color: c.fg },
    inputPlaceholder: { color: c.charcoalSubtle, fontFamily: fonts.regular, fontSize: 18 },
    keyboardHint: {
      color: c.charcoalSubtle,
      fontFamily: fonts.regular,
      fontSize: 14,
      textAlign: "center",
      paddingVertical: 4,
    },

    padWrap: { gap: 10 },
    padGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
    padKey: {
      width: "31.5%",
      height: 58,
      borderRadius: 12,
      backgroundColor: c.gray50,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    padKeyHidden: { opacity: 0, borderWidth: 0, backgroundColor: "transparent" },
    padKeyPressed: { backgroundColor: c.gray200, transform: [{ scale: 0.96 }] },
    padKeyText: { fontFamily: fonts.semibold, fontSize: 22, color: c.fg },
    padWide: {
      height: 50,
      borderRadius: 12,
      backgroundColor: c.gray50,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },

    choices: { gap: 10 },
    choice: {
      minHeight: 56,
      borderRadius: 12,
      backgroundColor: c.bg,
      borderWidth: 1.5,
      borderColor: c.border,
      paddingHorizontal: 18,
      paddingVertical: 14,
      justifyContent: "center",
    },
    choicePressed: { backgroundColor: c.gray50, borderColor: c.cyan },
    choiceText: { fontFamily: fonts.semibold, fontSize: 18, color: c.fg },

    skipSlot: { minHeight: 36, justifyContent: "center" },
    skipSlotHidden: { opacity: 0 },
    linkBtn: { alignItems: "center", justifyContent: "center", paddingVertical: 8 },
    linkBtnText: { fontFamily: fonts.semibold, fontSize: 14, color: c.violet },
  });
}
