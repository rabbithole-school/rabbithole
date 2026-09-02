"use client";

/**
 * The scholar's silent practice surface — a homegrown, external-practice-style loop.
 * One problem at a time, big tap targets (iPad-first), an optional Socratic hint
 * that withholds the answer, immediate feedback, and a session summary. Mastery
 * updates server-side through the spaced-repetition scheduler (the Skills lens
 * reads it). See review/practice/sketches.html §1.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useConvex, useConvexConnectionState, useMutation, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  HStack,
  VStack,
  Button,
  Text,
  Heading,
  Textarea,
  IconButton,
  Spinner,
} from "@chakra-ui/react";
import {
  Lightbulb,
  ArrowRight,
  ArrowCounterClockwise,
  X,
  ChatCircleDots,
  ArrowUp,
  Microphone,
  WifiSlash,
  Lightning,
  CaretLeft,
  Compass,
  Play,
} from "@phosphor-icons/react";
import { hintForSkill } from "@/lib/mathPracticeHints";
import { practiceDomainLabel } from "@/convex/lib/practice/domains";
import { strandHeadlineFor } from "@/shared/practiceDomainLabels";
import { MASTERY_LABELS } from "@/shared/masteryLexicon";
import type { FadeResult } from "@/convex/lib/practice/fadedSteps";
import { WorkedSteps } from "@/components/practice/WorkedSteps";
import { TeachingStep } from "@/components/practice/TeachingStep";
import type { RehearseGrader } from "@/components/practice/rehearseGrader";
import { HintLadderSteps } from "@/components/practice/HintLadderSteps";
import type {
  CompletedHintLadderRung,
  HintLadderRung,
} from "@/shared/hintLadder";
import { hintLadderBlocksMainSubmit } from "@/shared/hintLadder";
import {
  CONFIDENCE_LEVELS,
  confidenceValue,
  mismatchReveal,
  WELL_CALIBRATED_LINE,
  type ConfidenceLevel,
} from "@/convex/lib/practice/calibration";
import { convexSiteUrl } from "@/lib/convexUrls";
import { uploadPracticeImage } from "@/lib/practiceImageUpload";
import { Placement } from "@/components/practice/Placement";
import { VerdictStemCard } from "@/components/practice/VerdictStemCard";
import { RecoveryArc } from "@/components/practice/RecoveryArc";
import { ReprobeOffer } from "@/components/practice/ReprobeOffer";
import { FrontierMovedReveal } from "@/components/practice/FrontierMovedReveal";
import { BonusChooser, type BonusCardSpec } from "@/components/practice/BonusChooser";
import { DispatchCompletionReceipt } from "@/components/DispatchCompletionReceipt";
import {
  StoryMomentCard,
  type StoryMomentCardHandle,
} from "@/components/practice/StoryMomentCard";
import { LaunchpadCard } from "@/components/practice/LaunchpadCard";
import type { RunLaunchpad } from "@/convex/lib/practice/instructionEntries";
import {
  InstructionExampleSheet,
  type InstructionExampleContent,
} from "@/components/practice/InstructionExampleSheet";
import { resolveCompletionOffers } from "@/shared/completionOffers";
import {
  dedupeDispatchCompletionReceipts,
  type DispatchCompletionReceipt as DispatchCompletionReceiptData,
} from "@/shared/dispatchCompletionReceipt";
import { derivePlaylistDoneness, playlistCompleteEyebrow } from "@/shared/playlistDoneness";
import {
  PRACTICE_SCOPE_BLOCKED_DETAIL,
  PRACTICE_SCOPE_BLOCKED_HEADLINE,
} from "@/shared/mathPlanScope";
import { SummitHandoff } from "@/components/practice/SummitHandoff";
import { DictationMicButton } from "@/components/DictationMicButton";
import { ComposerAttachMenu } from "@/components/ComposerAttachMenu";
import { usePendingImage } from "@/hooks/usePendingImage";
import { spokenToUnitAnswer } from "@/lib/spokenMath";
import { haptic } from "@/lib/native";
import { useBrowserOnline } from "@/lib/practiceOfflineQueue";
import {
  closureGenerationEnabled,
  exampleSheetWriteCaps,
} from "@/components/practice/rehearseZeroWrite";
import {
  isResumableSnapshot,
  loadResumeSnapshot,
  QUICK_FACTS_SCOPE_KEY,
  type ResumeSnapshot,
} from "@/shared/practiceResumeContract";
import { webPracticePersistenceAdapter } from "@/lib/practicePersistenceAdapter";
import {
  breakerCommandId,
  newPracticeState,
} from "@/shared/practiceMachine";
import {
  usePracticeMachine,
  type LoadedPracticeRun,
  type PracticeHostBindings,
} from "@/hooks/usePracticeMachine";
import type { OutboxAnswer } from "@/shared/practiceOutboxContract";
import { Manipulative } from "@/components/manipulative/Manipulative";
import {
  segmentBeatVisibleForKind,
  mappingHeaderLabel,
  segmentBeatLabel,
  withLaunchpadSegment,
  type Segment,
} from "@/shared/practiceSegments";
import { FractionText } from "@/components/FractionText";
import { StemText } from "@/components/practice/StemText";
import { ExpressionEditor } from "@/components/practice/ExpressionEditor";
import { ExpressionKeypad } from "@/components/practice/ExpressionKeypad";
import { UnitKeys } from "@/components/practice/UnitKeys";
import { FractionKey } from "@/components/practice/FractionKey";
import { UNIT_MISSING_NUDGE, unitOutcomeNudge } from "@/components/practice/unitAnswerCopy";
import { useExpressionTemplate } from "@/hooks/useExpressionTemplate";
import { useExpressionTemplateKeyboard } from "@/hooks/useExpressionTemplateKeyboard";
import { hasPracticeMath } from "@/shared/fractions";
import type { PracticePromptVisual } from "@/shared/practicePromptVisual";
import { parseManipulativeSpec } from "@/lib/manipulative/grade";
import { MANIPULATIVE_ANSWER_TYPE } from "@/lib/manipulative/practiceContract";
import {
  applyKey,
  applyUnitKey,
  choiceSubmitValue,
  classifyVerdict,
  comesBackLine,
  computeTiming,
  DONT_KNOW_LABEL,
  formatComesBack,
  isFirstAttempt,
  isLastItem,
  isMultipleChoiceItem,
  isPadAnswerType,
  mappingPretestProgress,
  MAPPING_PRETEST_MAX_QUESTIONS,
  MAPPING_SIT_CAP,
  nextStreak,
  padAcceptsFraction,
  PRACTICE_SESSION_SIZE,
  progressFraction,
  shouldPulseStreak,
  showsMappingFeedback,
  STREAK_PULSE_DELAY_MS,
  summarize,
  challengeFrontierMove,
  CHALLENGE_OFFER_TITLE,
  CHALLENGE_OFFER_ACCEPT,
  challengeOfferBody,
  HANDOFF_OPENER,
  SPIRAL_HANDOFF_OPENER,
  breakerBody,
  breakerCloseLine,
  breakerControlLabel,
  breakerControls,
  breakerRecovered,
  makeClientEventId,
  type BreakerControl,
  PLACEMENT_SLIP_PROMPT,
  PLACEMENT_SLIP_RETRY_LABEL,
  PLACEMENT_SLIP_CONCEDE_LABEL,
} from "@/shared/practiceLoop";
import { superscriptExponents } from "@/shared/mathNotation";
import { hasUnitToken } from "@/convex/lib/practice/answers";
import {
  buildPracticeClosure,
  RECOVERY_CLOSURE_ENABLED,
  effortShape,
  type PracticeWrap,
  type PracticeSignal,
} from "@/shared/closureLines";
import { useEnsuredClosure } from "@/hooks/useEnsuredClosure";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import { useFlatAnswerKeyboard } from "@/hooks/useFlatAnswerKeyboard";
import { MarkdownBlock, StreamingMarkdown } from "@/components/StreamingMarkdown";

type ChatMsg = { role: "user" | "assistant"; content: string };

type ChatMode = "handoff" | "dialogue";

type HandoffState = {
  mode: ChatMode;
  entryMode?: "stuck" | "spiral" | "ladder";
  dialogueItemId?: string;
  dialogueSessionToken?: string;
  messages: ChatMsg[];
  ended: boolean;
  loading: boolean;
  error: string | null;
};

type BreakerRepairPlan = {
  version: 2;
  triggerAttemptId: Id<"practiceAttempts">;
  triggerNodeKey: string;
  domain: string;
  initialRepair?: {
    rung: HintLadderRung | null;
    hasMore: boolean;
    stepCount: number;
  };
};

// The DIALOGUE stretch vessel's opener (rubric'd-chat stretch — the whole item
// IS a conversation; see convex/lib/practice/dialogueStretch.ts).
const DIALOGUE_OPENER =
  "This one's about the WHY — work it out however you like, then tell me your idea. When you've said your whole thinking, tap \u201cCheck my thinking\u201d.";

type ServedItem = {
  itemId: string;
  skillKey: string;
  skillLabel: string;
  // The practice domain this item's skill belongs to (mirrors
  // convex/lib/practice/session.ts's ServedItem). Present on every item; drives
  // the per-item domain chip in a MIXED playlist so the scholar sees the subject
  // switch. Single-domain sessions set it to the session domain (chip suppressed).
  domain?: string;
  stem: string;
  // Widened beyond the template-engine answer types so a stored manipulative
  // practiceItem (lane 2) can be served through the same shape — see
  // convex/lib/practice/session.ts's `ServedItem` (the source of truth this
  // mirrors) + lib/manipulative/practiceContract.ts.
  answerType: "integer" | "decimal" | "fraction" | "expression" | "multipleChoice" | "manipulative" | "dialogue";
  /** The measurement unit this item's answer must carry, DISPLAY form ("cm³") —
   *  mirrors convex/lib/practice/session.ts's ServedItem. Present ⇒ the answer
   *  is value + unit ("112 cm³") and the surface offers the unit keys; absent ⇒
   *  a unit-free item, byte-identical to before. */
  answerUnit?: string;
  choices?: string[];
  /** Hook-only frame for a linked application in the Go deeper tail. */
  storyHook?: string;
  /** Display-only structured prompt visual (answer/grading remains answerType). */
  promptVisual?: PracticePromptVisual;
  /** Present only for a manipulative item: the JSON-serialized `ManipulativeSpec`. */
  manipulativeSpec?: string;
  /** Backward-faded worked-example scaffold (SPIKE) — present only when the
   *  stored item carries `workedSteps` (convex/lib/practice/fadedSteps.ts is
   *  the source of truth this mirrors). Already fade-computed server-side;
   *  never carries a faded step's real text. */
  workedSteps?: FadeResult;
  scaffoldLevel?: number;
  /** Two-dimensional answer entry (fraction/power/root) — mirrors
   *  convex/lib/practice/session.ts's ServedItem. When "twoD", the web + native
   *  clients render the SHARED 2-D ExpressionEditor instead of the flat pad. */
  answerShape?: "twoD";
  /** Non-leaky L1 fraction skeleton (e.g. `F(_/_)`) the server derived from the
   *  canonical answer — present only while the structure is scaffolded, dropped
   *  once the scholar has proven the shape (then it's a blank L3 canvas). */
  answerFormat?: string;
  // Scholar-facing serving lane (P1e) — "review" shows a "· review" chip,
  // "challenge" a "· challenge" chip, "stretch" a "· stretch" chip (a deeper
  // insight problem on an owned node), "mapping" a "· mapping" chip (a placement
  // probe served AS a playlist item — Option D), "new"/absent no chip. Mirrors
  // convex/lib/practice/session.ts's ServedItem.
  lane?: "review" | "new" | "challenge" | "stretch" | "mapping";
  /** Fact-automaticity "Fast math" sprint marker — mirrors
   *  convex/lib/practice/session.ts's ServedItem. Present ⇒ this is a bare
   *  single-digit fact selected for the scholar's weak facts; drives the bigger,
   *  focused retrieval treatment. Grades through the ordinary fact-family path. */
  isFactSprint?: boolean;
  /** The canonical `factKey` this sprint item drills (shared/factKey.ts) —
   *  present only on a fact-sprint item; a display/analysis aid, never leaky. */
  factKey?: string;
};

// Playlist segments: the kind union, `Segment`, and the scholar-facing beat
// copy all live in @/shared/practiceSegments — one owner shared by server, web,
// and native (they used to be hand-mirrored in three files and had drifted).

// Option D (OPTION_D_RULINGS Q1 "honest-and-done"): the day-1 `· mapping` sit
// builds across short served batches until placement converges or the shared
// fixed ceiling is reached. The scholar sees that same "up to" ceiling from the
// first question; recomposition never moves the goalposts, and the server
// finalizes placement when that ceiling is reached.

// Extend a run-length `segments` list with `count` more mapping items: grow the
// trailing mapping segment if the run already ends in one (a seamless
// continuation of the same `· mapping` beat), else append a fresh mapping
// segment. Keeps the segment strip + beat headers aligned with the appended
// items (Option D F1 recomposition).
function appendMappingSegment(prev: Segment[], count: number): Segment[] {
  if (count <= 0) return prev;
  const last = prev[prev.length - 1];
  if (last && last.kind === "mapping") {
    return [...prev.slice(0, -1), { kind: "mapping", count: last.count + count }];
  }
  return [...prev, { kind: "mapping", count }];
}

type SubmitResult = {
  correct: boolean;
  correctAnswer?: string;
  /** Present only when the server recorded this answer as a practice attempt. */
  attemptId?: Id<"practiceAttempts">;
  /** Set only when the VALUE was right and the required unit was absent
   *  ("missing") or not the one asked for ("wrong") — the "so close" signal a
   *  unit-bearing item earns. Still a miss in every other respect. */
  unitOutcome?: "missing" | "wrong";
  skillKey: string;
  skillLabel: string;
  repetition: number;
  proficiency: "not_started" | "practicing" | "fluent" | "overlearned";
  // true when a fast streak-jump credited this skill fluent immediately
  // (Mechanism 1 — the acceleration valve, raise-the-ceiling §4).
  accelerated?: boolean;
  // true when the scholar tapped "I haven't learned this yet" (recorded as a
  // miss for SR, but shown supportive copy + moved on, never the retry/stuck
  // treatment — and still no answer reveal, drills keep withholding).
  dontKnow?: boolean;
  // P1e: this attempt consolidated the skill (turned it fluent). `comesBackAt`
  // is when it next returns as review — the feedback moment shows "comes back
  // ~Thursday to keep it sharp". Both absent when it didn't consolidate.
  turnedFluent?: boolean;
  comesBackAt?: number;
  // Option D (OPTION_D_RULINGS): this result came from grading a `· mapping`
  // item through the PLACEMENT path (submitMappingAnswer) — reveal-only, no
  // mastery/streak framing, and a miss never offers retry (it's measurement).
  mapping?: boolean;
  // Set on the mapping answer that FINISHED placing a domain — drives the
  // done-screen "Your tree just filled in ✨" moment + the Tree lights.
  domainJustMapped?: boolean;
  mappedDomainLabel?: string;
  backOff?: { missStreak: number };
  /** The v2 repair plan that rides alongside `backOff` when the three-miss
   *  breaker fires (see `BreakerRepairPlan`). Optional so the surface still
   *  works against a deployment that only sends `backOff`. */
  breakerRecovery?: BreakerRepairPlan;
  breakerRecoveryVerified?: boolean;
  dispatchCompleted?: DispatchCompletionReceiptData[];
};

const PROFICIENCY_FILL: Record<SubmitResult["proficiency"], string> = {
  not_started: "#cdd2da",
  practicing: "#e0b84e",
  fluent: "#3a9e6b",
  overlearned: "#2f9aa0",
};

export function PracticeSession({
  scholarId,
  skillKeys,
  problemSetActivityId,
  activityTitle,
  domain,
  domains,
  choiceHint,
  excludedStrands,
  isRemote = false,
  checkInAllDomains = false,
  stretchHint,
  storyHint,
  includeMapping = false,
  rehearseGrader,
  quickFacts = false,
}: {
  scholarId: Id<"users">;
  skillKeys?: string[];
  /** Activity provenance enables the server-verified problem-set exception. */
  problemSetActivityId?: Id<"activities">;
  activityTitle?: string;
  /** A standing-practice assignment's domain (defaults to whole-number
   *  arithmetic engine-side when omitted — see practiceSkills.ts). */
  domain?: string;
  /** A MIXED playlist's blended domain set (≥2 domains interleaved). When
   *  present the session runs the cross-domain merge; placement / re-probe /
   *  tune-up (all single-domain notions) are skipped, and the empty-queue
   *  handoff is playlist-level. Ignored for problem-set-scoped runs. */
  domains?: string[];
  /** A bounded scholar choice or standing pin, qualified by domain so a mixed
   *  session applies it only to the matching scheduler queue. */
  choiceHint?: { domain: string; strand: string };
  /** A standing-practice assignment's excluded strands, if any — never served
   *  (enforced in practiceSession → the scheduler). */
  excludedStrands?: string[];
  /** True when a teacher is REHEARSING as another scholar (?remote=). The
   *  scholar-facing calibration summary reads the AUTHENTICATED user
   *  (myCalibrationSummary is self-scoped), which is the teacher here — so the
   *  kid-facing well-calibrated line is suppressed during rehearsal rather than
   *  showing the teacher's own data against the rehearsed scholar's session. */
  isRemote?: boolean;
  /** The DEFAULT (no-pin) practice entry. When set, an unplaced scholar takes the
   *  MIXED multi-domain "Math Check-In" (every registered domain, interleaved)
   *  before practice — folding in any domain they've never reached — instead of
   *  the single-domain placement. Not set for problem-set / standing-pin entries. */
  checkInAllDomains?: boolean;
  /** Stretch-tile entry: when set, practiceSession composes the served set as
   *  due reviews first (unchanged) then the challenge-tail items as the opt-in
   *  stretch block. Wired from ?stretch=1 on the practice page — mirrors native's
   *  stretchHint param. Empty challenge tail → falls through to normal session. */
  stretchHint?: boolean;
  /** Story-archive re-encounter. Graph keys only; practiceSession re-resolves
   * the eligible verifier-backed items and ignores stale hints. */
  storyHint?: { fromKey: string; toKey: string };
  /** Option D (OPTION_D_RULINGS): the DEFAULT (no-pin) Home entry sets this so
   *  the daily playlist folds in the `· mapping` band — placement probes for
   *  unmapped/in-progress domains, served AS playlist items and graded through
   *  the placement path. Supersedes the old standalone check-in gate. Not set
   *  for scoped / standing-pin / stretch entries. */
  includeMapping?: boolean;
  /** REHEARSE MODE (teacher previewing a skill's question pool as a scholar).
   *  When provided, the session grades every submission through this INJECTED
   *  pure grader instead of the `submitAnswer` mutation — so a rehearse run
   *  CANNOT write: it mints no `practiceMastery` / spaced-repetition / attempt
   *  rows, offers no tune-up / re-probe / challenge / breaker, and records no
   *  telemetry. Its presence IS the rehearse flag. Set only for a teacher-gated
   *  scoped (`?skill=`) preview; the scholar path leaves it undefined and is
   *  entirely unaffected. */
  rehearseGrader?: RehearseGrader;
  /** QUICK-FACTS ENTRY (`?quickFacts=1`, from the scholar Math tab's Calculator
   *  license card). Serves the run from `startQuickFactsPractice` — the direct
   *  Fast math round built by the canonical fact generator — instead of
   *  `practiceSession`, whose Sprint band is only ever inserted opportunistically
   *  into another useful run. Grading, mastery, and fact-fluency still flow
   *  through the ordinary `submitAnswer` path: only the SERVE differs. The page
   *  has already confirmed the round is available before mounting this. */
  quickFacts?: boolean;
}) {
  const choiceHintDomain = choiceHint?.domain;
  const choiceHintStrand = choiceHint?.strand;
  const convex = useConvex();
  const reportHelpUsed = useMutation(api.practiceSkills.reportHelpUsed);
  const undoHelpUsed = useMutation(api.practiceSkills.undoHelpUsed);
  const submitMapping = useMutation(api.practiceSkills.submitMappingAnswer);
  const finalizeCappedMappingRuns = useMutation(
    api.practiceSkills.finalizeCappedMappingRuns,
  );
  const startTuneup = useMutation(api.practiceTuneups.start);
  const logPracticeChoiceMutation = useMutation(api.practiceSkills.logPracticeChoice);
  const authToken = useAuthToken();

  // Rehearse mode is defined ENTIRELY by the injected grader's presence — no
  // separate boolean prop to fall out of sync with it. When set, the answering
  // loop routes through `rehearseGrader` (a pure, mutation-free client grader)
  // and every write-bearing side flow below is gated off.
  const rehearse = !!rehearseGrader;
  const browserOnline = useBrowserOnline();
  const connectionState = useConvexConnectionState();
  const isOffline =
    !browserOnline ||
    (connectionState.hasEverConnected &&
      !connectionState.isWebSocketConnected);
  const machineHostRef = useRef<PracticeHostBindings>({
    scholarId,
    loadRun: async () => {
      throw new Error("Practice host bindings are not installed");
    },
    onLoadError: () => {},
    onBreakerItem: () => {},
    onHintRung: () => {},
    onHintError: () => {},
    onSubmitError: () => {},
    onGrade: () => {},
    onCoach: () => {},
    onHandoff: () => {},
    buildResumeSnapshot: () => null,
    onHaptic: () => {},
    onQueuedCount: () => {},
    onDispatchCompleted: () => {},
    gradeLocally: async () => ({ correct: false }),
  });
  const initialMachineState = useMemo(
    () =>
      newPracticeState({
        scholarId: String(scholarId),
        itemCount: 0,
        mode: rehearse ? "rehearse" : "live",
        suppressBreaker: quickFacts,
      }),
    [quickFacts, rehearse, scholarId],
  );
  const machine = usePracticeMachine(
    initialMachineState,
    scholarId,
    machineHostRef,
    { online: !isOffline },
  );
  const sendPracticeEvent = machine.send;

  // A mixed playlist blends ≥2 already-started domains. It has no single-domain
  // placement / re-probe / tune-up notion, so those flows are skipped below.
  const isMixed = !!(domains && domains.length > 1);

  // Tune-up checkpoint (§4B): once accepted, the sampled skillKeys drive an
  // ordinary scoped session (same serve/grade path). `tuneupSkillKeys` non-null
  // means we're inside a tune-up run — it overrides the prop `skillKeys`. The
  // The record id is an imperative mutation handle; terminal completion itself
  // is owned and deduplicated by the machine.
  const [tuneupSkillKeys, setTuneupSkillKeys] = useState<string[] | null>(null);
  const [tuneupDismissed, setTuneupDismissed] = useState(false);
  const tuneupIdRef = useRef<Id<"practiceTuneups"> | null>(null);
  // "More of your pick" done-screen bonus (§C-3): only offered when the
  // session ran with a `choiceHint` (the scholar picked a strand on the home
  // card). Accepting fetches a few more same-strand skills (bonusSkillsForChoice)
  // and re-enters an ordinary scoped session with them — same mechanism as a
  // tune-up's scoped re-entry, just no separate practiceTuneups record.
  const [bonusMoreSkillKeys, setBonusMoreSkillKeys] = useState<string[] | null>(null);
  const [bonusMoreLoading, setBonusMoreLoading] = useState(false);
  // A Quick-facts round is SCOPED in exactly the sense this flag means: it
  // serves one deliberate set, so it must not mount the standalone placement
  // gate or collect the daily playlist's re-probe / tune-up / doneness offers —
  // otherwise the card's action could land an unplaced scholar on Placement
  // instead of the fast math it promised.
  const scopedByProp = !!(skillKeys && skillKeys.length > 0) || quickFacts;
  const inTuneup = tuneupSkillKeys !== null;
  const inBonusMore = bonusMoreSkillKeys !== null;

  // New scholars place first (unless launched into a specific problem-set
  // activity, which has its own scope). `undefined` = loading. A tune-up runs
  // for an already-placed scholar, so this stays resolved (false) throughout —
  // deliberately NOT skipped mid-tune-up (skipping would strand the placement
  // gate on `undefined`).
  const [placed, setPlaced] = useState(false);
  // Latch that we entered placement. `submitPlacementAnswer` writes mastery rows
  // on finalize, which flips the reactive `needsPlacement` true→false; without this latch the
  // gate below would unmount <Placement> before it can paint its "result" phase
  // (the "You're starting at Grade X" / "Start practicing" hand-off screen).
  // `placed` (set only from that screen's button) is the way out, so this can't
  // trap the scholar.
  const [wasPlacing, setWasPlacing] = useState(false);
  // Freeze the `domain` used for the placement gate + query. Rationale: an
  // auto-blend scholar has NO started domain during placement (the `domain` prop
  // is `undefined`), and FINALIZING placement writes mastery → `domainsForScholar`
  // re-emits → the `domain` prop flips undefined→value. That prop change would
  // re-subscribe `needsPlacement` (transient `undefined`) and unmount <Placement>
  // mid-flow, dropping it back to the intro. So we latch the value: `placementDomain`
  // only tracks the live `domain` while we're NOT mid-placement; once placement is
  // underway (`wasPlacing && !placed`) it stays put until the scholar leaves it.
  const [placementDomain, setPlacementDomain] = useState<string | undefined>(domain);
  if (!(wasPlacing && !placed) && placementDomain !== domain) {
    // Render-phase adjustment (converges once `placementDomain === domain`), the
    // same one-shot pattern the Placement boot phase uses — NOT a setState-in-effect.
    setPlacementDomain(domain);
  }
  const needsPlacement = useQuery(
    api.practiceSkills.needsPlacement,
    // Option D: with mapping folded into the playlist, the standalone
    // single-domain placement gate retires too — skip the query entirely so it
    // never mounts <Placement>.
    scopedByProp || isMixed || checkInAllDomains || includeMapping || rehearse
      ? "skip"
      : { scholarId, domain: placementDomain },
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Retain that placement began even when the server query flips false after completion.
    if (needsPlacement) setWasPlacing(true);
  }, [needsPlacement]);

  // MIXED multi-domain "Math Check-In" gate — the DEFAULT (no-pin) practice entry.
  // A scholar who hasn't placed on EVERY registered domain takes the interleaved
  // check-in first (folding in the missing domains); once every domain is placed
  // this resolves false and practice proceeds to the (mixed) playlist. Latched the
  // same way as the single-domain gate so finalizing the check-in (which flips
  // `needsAnyPlacement` true→false) doesn't unmount <Placement> before its result.
  const needsAnyPlacement = useQuery(
    api.practiceSkills.needsAnyPlacement,
    scopedByProp || rehearse || !checkInAllDomains ? "skip" : { scholarId },
  );
  const [checkedIn, setCheckedIn] = useState(false);
  const [wasCheckingIn, setWasCheckingIn] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Retain the check-in transition so completion cannot unmount the result screen.
    if (needsAnyPlacement) setWasCheckingIn(true);
  }, [needsAnyPlacement]);

  // Strand re-probe offer (§4 B1-M2): after a session, the engine may flag a
  // strand where the scholar keeps getting accelerated + has headroom — an
  // under-placement signal. Only outside a scoped problem-set (skillKeys). The
  // offer shows on the done screen; `reprobeResolved` hides it once handled.
  const reprobe = useQuery(
    api.practiceSkills.reprobeCandidates,
    scopedByProp || isMixed || rehearse ? "skip" : { scholarId, domain },
  );
  const [reprobeResolved, setReprobeResolved] = useState(false);

  // The scholar's daily playlist for the SCOPE this run practiced — the ONE
  // signal that tells the done screen whether the playlist is actually finished
  // (so it says "Playlist complete" + Done) or still has skills queued (so it
  // says "Round complete" + Continue), instead of the old flat "Session
  // complete" + a Done link to /scholar that contradicted Home. Same query the
  // home card subscribes to; a mixed blend previews its first domain (mirroring
  // the home card's representative-domain read). Skipped for a scoped
  // activity-embedded run (not the daily playlist) and for teacher rehearsal
  // (?remote=, which reads the teacher's own identity). Subscribed from mount so
  // it has resolved well before the done screen renders — no undefined flash.
  const donenessDomain = isMixed ? domains?.[0] : domain;
  const playlistDoneness = useQuery(
    api.practiceSkills.playlistForScholar,
    scopedByProp || isRemote
      ? "skip"
      : {
          scholarId,
          ...(donenessDomain ? { domain: donenessDomain } : {}),
          ...(choiceHint ? { choiceHint } : {}),
          ...(includeMapping ? { includeMapping: true } : {}),
        },
  );

  // Tune-up offer (§4B): server decides all trigger conditions (pool ≥ 6,
  // interval elapsed). Only in whole-graph practice — never inside a scoped
  // prop session, an active tune-up, a "more of your pick" bonus round, or
  // after a dismiss this wrap.
  const tuneupOffer = useQuery(
    api.practiceTuneups.offerForScholar,
    scopedByProp || isMixed || inTuneup || inBonusMore || tuneupDismissed || rehearse
      ? "skip"
      : { scholarId, domain },
  );

  const [items, setItems] = useState<ServedItem[] | null>(null);
  // Playlist segments v1 — parallel run-length metadata over `items` (see the
  // `Segment` type above). `idx`/`total` (shared/practiceLoop) are untouched.
  const [segments, setSegments] = useState<Segment[]>([]);
  // Option D: the served run is 100% `· mapping` (nothing else servable) — drives
  // the ceremony-lite "Math Check-In" skin + the "Your map is started ✨" beat.
  const [mappingProgressOffset, setMappingProgressOffset] = useState(0);
  // The label of a domain that FINISHED placing during this run (the last
  // mapping answer that converged its domain) — drives the done-screen
  // "Your tree just filled in ✨" moment + Tree lights. Reset each fresh load.
  const [mappedDomainLabel, setMappedDomainLabel] = useState<string | null>(null);
  // The OPTIONAL above-band challenge tail (P1e) the server surfaced alongside
  // the required set — never mixed in. Offered on the done screen ("Want a
  // challenge?"); accepting swaps them in as a labeled challenge round.
  const [challengeItems, setChallengeItems] = useState<ServedItem[]>([]);
  const [inChallenge, setInChallenge] = useState(false);
  // The OPTIONAL "Go deeper" stretch tail — insight problems on nodes she
  // already owns (demonstrated fluent). Offered on the done screen; misses in
  // a stretch round never touch the mastery row (server-enforced).
  const [stretchItems, setStretchItems] = useState<ServedItem[]>([]);
  const [inStretch, setInStretch] = useState(false);
  // True once ANY attempt (first try or retry) solved a stretch item this
  // round — the done wrap distinguishes "cracked it eventually" (persistence,
  // the thing to celebrate) from "not this time". The log only holds first
  // attempts, so this flag is the retry-aware reading.
  const [stretchCracked, setStretchCracked] = useState(false);
  // Verdict of a graded DIALOGUE stretch item (null until "Check my thinking").
  const [dialogueVerdict, setDialogueVerdict] = useState<
    { passed: boolean; metCount: number; total: number } | null
  >(null);
  const [firstPostPlacementBlock, setFirstPostPlacementBlock] = useState(false);
  /** The server declined to compose anything because the scholar's Math plan
   *  leaves nothing servable right now (`practiceSession`'s `blocked` flag).
   *  It arrives shaped exactly like a finished block — zero items — so without
   *  reading it we congratulate a scholar for a boundary someone else drew. */
  const [scopeBlocked, setScopeBlocked] = useState(false);
  const [input, setInput] = useState("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  // The consolidation "comes back ~Thursday" line (P1e), precomputed in the
  // submit handler (Date.now() is impure — never called during render) and shown
  // on the correct-verdict card. Null unless this attempt turned the skill fluent.
  const [comesBackText, setComesBackText] = useState<string | null>(null);
  const [hintRungs, setHintRungs] = useState<CompletedHintLadderRung[]>([]);
  const [activeHintRung, setActiveHintRung] = useState<{
    rung: Extract<HintLadderRung, { kind: "completion" }>;
    hasMore: boolean;
  } | null>(null);
  const [hintStepError, setHintStepError] = useState<string | null>(null);
  const [log, setLog] = useState<SubmitResult[]>([]);
  const [laneBusy, setLaneBusy] = useState(false);
  const [mappingRetry, setMappingRetry] = useState(false);
  // Lazily generated once via useState (Math.random() must not run
  // unconditionally during render — react-hooks/purity); reseeded explicitly
  // in loadSession below, so this ref is otherwise mutable, not derived state.
  const [initialSeed] = useState(() => Math.floor(Math.random() * 2_000_000_000));
  const seedRef = useRef<number>(initialSeed);
  // Guards the async mapping-sit continuation (F1) against a double Next tap /
  // Enter while the re-query is in flight — a second append would duplicate items.
  const continuingMappingRef = useRef(false);

  const wrongAnswersRef = useRef<string[]>([]);
  const [handoff, setHandoff] = useState<HandoffState | null>(null);
  const [handoffInput, setHandoffInput] = useState("");
  const idx = machine.state.run.idx;
  const breaker = machine.state.breaker;
  const missCount = machine.state.item.missCount;
  const hasRecorded = machine.state.item.hasRecorded;
  const allMapping = machine.state.run.allMapping;
  const showHint = machine.state.hint.open;
  const hintItemId = machine.state.hint.itemId;
  const hintStepsExhausted = machine.state.hint.exhausted;
  const hintStepLoading = machine.state.hint.pendingCommandId !== null;
  const breakerEasyLoading =
    !!breaker &&
    (breaker.flow.easy === undefined ||
      breaker.flow.easy === "requested") &&
    breaker.easyItemId !== machine.state.item.itemId &&
    breaker.emitted.includes(
      breakerCommandId(breaker.triggerAttemptId, "easy"),
    );
  const breakerLifecycleBlocked =
    (breaker?.lifecycle.pending.length ?? 0) > 0;
  const breakerLifecycleRecoveryNeeded =
    breaker?.lifecycle.pending[0]?.status === "recoverable";
  const busy =
    laneBusy ||
    machine.state.item.phase.kind === "submitting" ||
    hintStepLoading ||
    breakerEasyLoading ||
    breakerLifecycleBlocked ||
    machine.state.run.pendingLoad !== null;
  const phase:
    | "answering"
    | "feedback"
    | "retry"
    | "handoff"
    | "done"
    | "queued"
    | "breakerRepair"
    | "breakerClose" =
    breaker?.flow.stage === "close"
      ? "breakerClose"
      : machine.state.lane === "handoff" ||
          machine.state.lane === "dialogue"
        ? "handoff"
        : breakerLifecycleRecoveryNeeded
          ? "breakerRepair"
        : breaker?.flow.stage === "repair"
          ? "breakerRepair"
          : machine.state.terminal
            ? "done"
            : mappingRetry
              ? "retry"
              : machine.state.item.phase.kind === "feedback"
                ? "feedback"
                : machine.state.item.phase.kind === "queued"
                  ? "queued"
                  : "answering";
  /** The answer surface is showing one of the breaker's OWN items (the fresh
   *  same-node try, or the easy finish) rather than the playlist. */
  const onBreakerItem =
    breaker?.flow.stage === "fresh" || breaker?.flow.stage === "easy";
  // Photo/sketch attachment for the "talk me through it" chat — same shared
  // pipeline as the tutor chat, so a scholar can SHOW their work here too.
  const chatImage = usePendingImage();
  const clearChatImage = chatImage.clear;
  // Leaving the chat (next item, feedback, done) drops any staged photo so it
  // can't bleed into a fresh problem's chat.
  useEffect(() => {
    if (phase !== "handoff") clearChatImage();
  }, [phase, clearChatImage]);
  // Teach-as-action gate: after "I haven't learned this yet", the scholar does
  // ONE faded worked step (TeachingStep) in the feedback moment, and "Next" is
  // held until they've attempted it (or no step exists / it stalled — then
  // TeachingStep unlocks via onReady so Next never dead-ends).
  const [dontKnowStepReady, setDontKnowStepReady] = useState(false);
  // Transcript auto-scroll anchor — keeps the active item / newest chat turn in
  // view as solved items accumulate above it (chat-family behavior). A STATE-
  // backed callback ref (not a plain useRef) — the anchor div only mounts once
  // `current` has loaded (the component renders a "Loading…" fallback with no
  // anchor in the DOM until then), and a plain ref wouldn't cause the scroll
  // effect below to re-run once it finally attaches. Setting state on mount
  // forces exactly that re-run at the right moment.
  const [bottomEl, setBottomEl] = useState<HTMLDivElement | null>(null);
  // The keypad stage's own scroll container (the overflowY:auto Flex holding the
  // stem card + pad). A problem is NOT a chat: on a fresh item we scroll THIS to
  // the top so the prompt stays visible, rather than pinning its bottom edge
  // (which pushed the whole stem above the clip edge — see the scroll effect).
  // State-backed for the same reason as `bottomEl`: it mounts a beat after the
  // Loading fallback, and a plain ref wouldn't re-fire the effect on attach.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  // Solved-item exit: when the active problem changes, the one you just left
  // gently floats up off the top and fades out (a scrolling-chat vibe without a
  // literal transcript / a persistent receipt stack). Answer-safe — only the
  // stem is ever shown. Suppressed under prefers-reduced-motion (the ghost is
  // display:none there, see MOTION_CSS).
  const prevItemRef = useRef<{ itemId: string; stem: string } | null>(null);
  const [departing, setDeparting] = useState<{ itemId: string; stem: string } | null>(null);

  // Predict-then-Check calibration: the kid's OPTIONAL pre-answer confidence
  // pick for the current item (null = skipped). `revealPrediction` freezes the
  // confidence value used for the RECORDED first attempt, so the gentle
  // per-item mismatch reveal in feedback reflects that attempt only (a retry
  // never carries a prediction, so it clears this). Both reset per new item.
  const [predictedConfidence, setPredictedConfidence] = useState<ConfidenceLevel | null>(null);
  const [revealPrediction, setRevealPrediction] = useState<number | null>(null);
  // A correct answer can still be helped; this latches once the scholar owns that
  // so an item never carries the admission forward to the next one.
  const [helpReported, setHelpReported] = useState(false);
  // In-flight guard so a fast double-tap can't race the press against its undo.
  const [helpPending, setHelpPending] = useState(false);
  // The item the current admission queued, so an un-press can withdraw exactly
  // that one. A ref, not state: it is only ever read on the undo path, which a
  // press in this same feedback view must always precede — so it cannot be
  // stale, and it needs no clearing at the many places the pill resets.
  const helpRetryItemIdRef = useRef<string | null>(null);
  // Self-scoped (reads the authenticated user). Skipped during teacher rehearsal
  // (?remote=), where the authed user is the teacher, not the rehearsed scholar —
  // so the kid-facing well-calibrated line is never sourced from teacher data.
  const calibration = useQuery(
    api.practiceCalibration.myCalibrationSummary,
    isRemote ? "skip" : {},
  );

  // Moments: the story reveal card (§ raise-the-ceiling — one quiet
  // skill→world story after a durable fluency transition, server-arbitrated
  // rarity). Skipped during teacher rehearsal for the same reason as
  // calibration above — a remote/rehearsal view must never record an offered
  // event on the teacher's own identity.
  const storyMomentLive = useQuery(
    api.practiceMoments.storyMomentForScholar,
    isRemote || rehearse ? "skip" : { scholarId },
  );
  // FREEZE the first moment we see: the card's own recordMomentOffered insert
  // is itself a momentEvents row, so this same reactive query flips to null
  // the instant it lands (the 20h global-cooldown check now sees that very
  // insert as "already offered recently") — without freezing, the card would
  // flash and immediately vanish. Once shown, a moment stays shown for the
  // rest of this mount; it only changes if a genuinely different moment
  // arrives (a different edge — the previous one is now terminal/reserved).
  // `storySettled` tracks the completion arbiter's "settled" transition — set
  // when the scholar starts THIS story's own linked application (markTried) —
  // and resets whenever a genuinely new moment (a different edge) arrives.
  const [storyMoment, setStoryMoment] = useState<typeof storyMomentLive>(null);
  const [storySettled, setStorySettled] = useState(false);
  const storyCardSettleRef = useRef<StoryMomentCardHandle | null>(null);
  useEffect(() => {
    if (!storyMomentLive) return;
    // Detect a genuinely new moment (a different edge) from the currently
    // committed `storyMoment` — which is exactly what the functional updater's
    // `prev` was, since this effect is the ONLY writer of `storyMoment`. Then
    // apply the two updates as ordinary top-level sibling calls. Nesting
    // `setStorySettled` inside the `setStoryMoment` updater was a real hazard:
    // React state updaters must be pure and may be replayed (Strict Mode
    // double-invokes them in dev; concurrent rendering can discard and re-run a
    // render), so the nested update could fire twice or fire from an abandoned
    // render.
    const isNewMoment =
      !storyMoment ||
      storyMoment.fromKey !== storyMomentLive.fromKey ||
      storyMoment.toKey !== storyMomentLive.toKey;
    if (isNewMoment) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Commit each new story edge once before resetting its independent settlement latch.
      setStoryMoment(storyMomentLive);
      setStorySettled(false);
    }
  }, [storyMomentLive, storyMoment]);

  // ── Instructional "Launchpad" (instructional segments v1) ──────────────────
  // The Launchpad is a POSITIONED ENTRY ON THIS RUN, resolved server-side from
  // the items the run will actually serve (`practiceSession.launchpad`). It is
  // an ungraded beat: it never grades and never moves mastery, which is
  // structural rather than a flag -- it is not a member of `items`, so no code
  // path can grade it.
  //
  // It replaces a client-side doorway that asked a SEPARATE query
  // (`instructionForDaily`) which picked a strand by graph order and never
  // consulted the playlist, so it could offer a doorway into a strand this run
  // never served. `at` is now the index of the first item of the introduced
  // strand, so the beat lands immediately before the work it introduces -- and
  // the whole class of "wrong strand" bugs is unrepresentable.
  //
  // `launchpadDone` is set when the scholar leaves the doorway by either fork.
  // No latch ref is needed any more: the server's <=1/day governor is scoped to
  // OTHER keys, so the card's own impression claim no longer retracts the offer
  // it is rendering (see selectRunLaunchpad).
  const [launchpad, setLaunchpad] = useState<RunLaunchpad | null>(null);
  const [launchpadDone, setLaunchpadDone] = useState(false);

  // B5 — silent latency instrument (raise-the-ceiling plan §5). Three moments
  // per item: stem render, FIRST keystroke, submit. NO visible clock/timer —
  // this is deliberately invisible to the scholar (§5: timed-pressure is
  // deliberately absent). Refs, not state, so a tick never triggers a
  // re-render; reset whenever `current` changes (a genuinely new item, not a
  // same-item retry — see onRetry).
  const itemRenderAtRef = useRef<number>(0);
  const firstKeyAtRef = useRef<number | null>(null);

  // ⑭ Offline-tolerant answering. The correct answer is server-only (anti-
  // offloading — see submitAnswer), so a submit made while offline can't be
  // graded locally: it's queued and replayed for real once back online. Two
  // signals combine for "can we reach the server right now?" — the browser's
  // own online/offline events (fast, and what Playwright's setOffline flips)
  // and the Convex socket's connection state (catches a dropped socket even
  // when the browser still claims to be online).
  const [queuedCount, setQueuedCount] = useState(0);
  const [dispatchCompleted, setDispatchCompleted] = useState<
    DispatchCompletionReceiptData[]
  >([]);
  const accumulateDispatchCompleted = useCallback(
    (receipts: readonly DispatchCompletionReceiptData[] | undefined) => {
      if (!receipts || receipts.length === 0) return;
      setDispatchCompleted((current) =>
        dedupeDispatchCompletionReceipts([...current, ...receipts]),
      );
    },
    [],
  );
  const streakRef = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const resetHostRun = useCallback(() => {
    setItems(null);
    setLog([]);
    setResult(null);
    setInput("");
    setHintRungs([]);
    setActiveHintRung(null);
    setHintStepError(null);
    wrongAnswersRef.current = [];
    setHandoff(null);
    setHandoffInput("");
    setMappingRetry(false);
    setReprobeResolved(false);
    setPredictedConfidence(null);
    setHelpReported(false);
    setRevealPrediction(null);
    setInChallenge(false);
    setInStretch(false);
    setStretchCracked(false);
    setDialogueVerdict(null);
    setFirstPostPlacementBlock(false);
    setScopeBlocked(false);
    setComesBackText(null);
    setMappingProgressOffset(0);
    setMappedDomainLabel(null);
    setDispatchCompleted([]);
    setLoadError(null);
    setSubmitError(null);
  }, []);

  const restoreHostSnapshot = useCallback(
    (
      snap: ResumeSnapshot<ServedItem, Segment, RunLaunchpad>,
    ): LoadedPracticeRun => {
      setItems(snap.items);
      setSegments(snap.segments ?? []);
      setLaunchpad(snap.launchpad ?? null);
      setLaunchpadDone(false);
      setMappingProgressOffset(snap.mappingProgressOffset ?? 0);
      setMappedDomainLabel(snap.mappedDomainLabel ?? null);
      setChallengeItems([]);
      setStretchItems([]);
      const item = snap.items[snap.resumeIdx];
      return {
        itemCount: snap.items.length,
        itemId: item?.itemId ?? null,
        scopeKey: snap.scopeKey,
        dayKey: snap.dayKey,
        allMapping: !!snap.allMapping,
        tuneupId: tuneupIdRef.current,
        resume: {
          idx: snap.resumeIdx,
          hasRecorded: false,
          itemId: item?.itemId ?? null,
        },
      };
    },
    [],
  );

  const loadSession = useCallback(async (
    inputKey: string,
    forceFresh: boolean,
  ): Promise<LoadedPracticeRun> => {
    resetHostRun();
    let discardResume = !rehearse && forceFresh;

    if (!rehearse && !forceFresh) {
      const current = await convex.query(
        api.practiceSkills.practiceScopeSnapshotKey,
        { scholarId },
      );
      const validity = {
        inputKey,
        scopeKey: quickFacts ? QUICK_FACTS_SCOPE_KEY : current.scopeKey,
        dayKey: current.dayKey,
      };
      const snapshot = await loadResumeSnapshot<
        ServedItem,
        Segment,
        RunLaunchpad
      >(webPracticePersistenceAdapter, String(scholarId));
      if (
        isResumableSnapshot(snapshot, validity) &&
        !(
          snapshot.allMapping &&
          (snapshot.mappingProgressOffset ?? 0) + snapshot.resumeIdx >=
            MAPPING_SIT_CAP
        )
      ) {
        return restoreHostSnapshot(snapshot);
      }
      discardResume = snapshot !== null;
    }

    seedRef.current = Math.floor(Math.random() * 2_000_000_000);
    // Rehearse records nothing — never fire this mapping-finalize MUTATION.
    if (!rehearse) await finalizeCappedMappingRuns({ scholarId });
    // The Quick-facts entry serves the DIRECT Fast math round: no launchpad, no
    // mapping band, no challenge/stretch tail, and none of practiceSession's
    // opportunistic Sprint gates. Availability was already resolved by the page,
    // so an empty result here just leaves the ordinary "nothing served" screen.
    if (quickFacts && !tuneupSkillKeys && !bonusMoreSkillKeys) {
      const quick = await convex.query(
        api.practiceSkills.startQuickFactsPractice,
        { scholarId, seed: seedRef.current, size: PRACTICE_SESSION_SIZE },
      );
      setItems(quick.items as ServedItem[]);
      setSegments((quick.segments as Segment[] | undefined) ?? []);
      setLaunchpad(null);
      setLaunchpadDone(false);
      setChallengeItems([]);
      setStretchItems([]);
      return {
        itemCount: quick.items.length,
        itemId: quick.items[0]?.itemId ?? null,
        scopeKey: quick.scopeKey,
        dayKey: quick.dayKey,
        allMapping: false,
        tuneupId: tuneupIdRef.current,
        ...(discardResume ? { discardResume: true } : {}),
      };
    }
    // A tune-up or a "more of your pick" bonus round scopes the session to its
    // sampled skills; otherwise the prop skillKeys (a problem-set activity) or
    // the whole-graph default.
    const activeSkillKeys = tuneupSkillKeys ?? bonusMoreSkillKeys ?? skillKeys;
    // A tune-up / bonus-more round serves exactly its sampled skills (one item
    // each), so the item count matches the offer's `count` and the recorded
    // `total`. Normal / problem-set practice fills a full PRACTICE_SESSION_SIZE
    // block.
    const size = tuneupSkillKeys
      ? tuneupSkillKeys.length
      : bonusMoreSkillKeys
        ? bonusMoreSkillKeys.length
        : PRACTICE_SESSION_SIZE;
    // A "more of your pick" round is scoped to keys sampled by
    // `bonusSkillsForChoice` from `choiceHintDomain` — which is NOT necessarily
    // this session's `domain`. When a scholar You-Picks an in-set strand while a
    // different started domain leads the auto-blend, `domain` is the blend
    // default (e.g. fractions) while the pick lives in `choiceHintDomain` (e.g.
    // geometry). Serving those geometry keys scoped to the fractions domain
    // filters them all out → an empty round (the wrong-content bug). So a
    // bonus-more round serves against the pick's own domain. A tune-up's keys
    // are sampled from `domain`, so it keeps `domain`.
    const serveDomain =
      bonusMoreSkillKeys && choiceHintDomain ? choiceHintDomain : domain;
    const res = await convex.query(api.practiceSkills.practiceSession, {
      scholarId,
      size,
      seed: seedRef.current,
      skillKeys: activeSkillKeys,
      // Only the original activity launch may use the teacher-assigned exception.
      // Tune-ups, breaker recovery, and direct skill links remain ordinary practice.
      problemSetActivityId:
        activeSkillKeys === skillKeys ? problemSetActivityId : undefined,
      domain: serveDomain,
      // A mixed playlist blends ≥2 domains; ignored for a scoped/tune-up run.
      domains: activeSkillKeys ? undefined : domains,
      choiceHint:
        choiceHintDomain && choiceHintStrand
          ? { domain: choiceHintDomain, strand: choiceHintStrand }
          : undefined,
      excludedStrands,
      // Stretch-tile entry: reviews-first + challenge-tail (mirrors native).
      // Cleared for tune-up/bonus-more runs (those are not stretch sessions).
      stretchHint: activeSkillKeys ? undefined : stretchHint || undefined,
      storyHint: activeSkillKeys ? undefined : storyHint,
      // Option D: fold the `· mapping` band in on the default (no-pin) entry —
      // never for a scoped / tune-up / bonus / stretch run.
      includeMapping:
        activeSkillKeys || stretchHint ? undefined : includeMapping || undefined,
    });
    setItems(res.items as ServedItem[]);
    setSegments((res as { segments?: Segment[] }).segments ?? []);
    // A scoped problem set never carries a doorway (the server declines too).
    setLaunchpad(
      activeSkillKeys ? null : ((res as { launchpad?: RunLaunchpad }).launchpad ?? null),
    );
    setLaunchpadDone(false);
    const loadedAllMapping =
      !activeSkillKeys && !!(res as { allMapping?: boolean }).allMapping;
    setMappingProgressOffset(
      !activeSkillKeys
        ? ((res as { mappingProgressOffset?: number }).mappingProgressOffset ?? 0)
        : 0,
    );
    setFirstPostPlacementBlock(
      !activeSkillKeys && !!(res as { firstPostPlacementBlock?: boolean }).firstPostPlacementBlock,
    );
    // The plan-scope boundary. Kept for scoped runs too: a problem set whose
    // skills all sit outside the scholar's current scope is blocked for exactly
    // the same reason, and "you're caught up" would be just as untrue there.
    setScopeBlocked(!!(res as { blocked?: boolean }).blocked);
    // The challenge tail is only offered after a whole-graph required set — never
    // for a scoped problem set or a tune-up run (both send none).
    setChallengeItems(
      activeSkillKeys ? [] : ((res as { challenge?: ServedItem[] }).challenge ?? []),
    );
    setStretchItems(
      activeSkillKeys ? [] : ((res as { stretch?: ServedItem[] }).stretch ?? []),
    );
    if (!res.scopeKey || !res.dayKey) {
      throw new Error("Practice run is missing its scope/day identity");
    }
    return {
      itemCount: res.items.length,
      itemId: res.items[0]?.itemId ?? null,
      scopeKey: res.scopeKey,
      dayKey: res.dayKey,
      allMapping: loadedAllMapping,
      tuneupId: tuneupIdRef.current,
      ...(discardResume ? { discardResume: true } : {}),
    };
  }, [
    convex,
    scholarId,
    tuneupSkillKeys,
    bonusMoreSkillKeys,
    skillKeys,
    problemSetActivityId,
    domain,
    domains,
    choiceHintDomain,
    choiceHintStrand,
    excludedStrands,
    stretchHint,
    storyHint,
    includeMapping,
    finalizeCappedMappingRuns,
    rehearse,
    quickFacts,
    resetHostRun,
    restoreHostSnapshot,
  ]);

  // ── Option D (F1): the mapping-sit recomposition loop ──────────────────────
  // A day-1 `· mapping` sit is a ~15–20-item sitting that builds ACROSS
  // recompositions: each served batch is short (one probe per strand), and when
  // it's exhausted we re-query `practiceSession` for the NEXT probes (placement
  // not yet converged) and append them so the sit continues seamlessly. Returns
  // the appended mapping items (empty when the server has no more mapping today
  // or the cap is already hit). Only ever called on the default mapping entry.
  const fetchMoreMapping = useCallback(
    async (currentLen: number): Promise<ServedItem[]> => {
      const room =
        MAPPING_PRETEST_MAX_QUESTIONS -
        mappingProgressOffset -
        currentLen;
      if (room <= 0) return [];
      try {
        const res = await convex.query(api.practiceSkills.practiceSession, {
          scholarId,
          size: PRACTICE_SESSION_SIZE,
          seed: Math.floor(Math.random() * 2_000_000_000),
          domain,
          domains,
          choiceHint:
            choiceHintDomain && choiceHintStrand
              ? { domain: choiceHintDomain, strand: choiceHintStrand }
              : undefined,
          excludedStrands,
          includeMapping: true,
        });
        const more = (res.items as ServedItem[]).filter((it) => it.lane === "mapping");
        return more.slice(0, Math.max(0, room));
      } catch {
        return [];
      }
    },
    [convex, scholarId, domain, domains, choiceHintDomain, choiceHintStrand, excludedStrands, mappingProgressOffset],
  );


  // Full client input identity. The machine owns whether a change starts a load
  // or is frozen because an all-mapping ceremony is still underway.
  const sessionInputKey = [
    domain ?? "",
    (domains ?? []).join("\u0000"),
    (skillKeys ?? []).join("\u0000"),
    (tuneupSkillKeys ?? []).join("\u0000"),
    (bonusMoreSkillKeys ?? []).join("\u0000"),
    choiceHintDomain ?? "",
    choiceHintStrand ?? "",
    (excludedStrands ?? []).join("\u0000"),
    stretchHint ? "1" : "",
    storyHint?.fromKey ?? "",
    storyHint?.toKey ?? "",
    includeMapping ? "m" : "",
    // The Quick-facts entry is its own run identity — a direct Fast math round
    // must never restore (or be restored as) an ordinary playlist run.
    quickFacts ? "Q" : "",
    // Mode is part of the run identity: a rehearsal and a live run are never the
    // same persisted run, and a rehearsal must never restore (or be restored as)
    // a live one. (The page also remounts by mode, so this is defence in depth.)
    rehearse ? "R" : "",
  ].join("|");

  const activeBreakerEpisode = useQuery(
    api.practiceSkills.activeBreakerEpisode,
    rehearse ? "skip" : { scholarId },
  );
  useEffect(() => {
    if (!rehearse && activeBreakerEpisode === undefined) return;
    if (activeBreakerEpisode) {
      sendPracticeEvent({
        type: "hydrate:breaker",
        episode: {
          triggerAttemptId: String(activeBreakerEpisode.triggerAttemptId),
          recoveryAvailable: true,
          triggerItemId: activeBreakerEpisode.triggerItemId ?? null,
          triggerNodeKey: activeBreakerEpisode.triggerNodeKey,
          domain: activeBreakerEpisode.domain,
          missStreak: activeBreakerEpisode.missStreak,
          flow: activeBreakerEpisode.flow,
          repairStepIndex: activeBreakerEpisode.repairStepIndex ?? null,
          freshItemId: activeBreakerEpisode.freshItemId ?? null,
          easyItemId: activeBreakerEpisode.easyItemId ?? null,
          confirmedLifecycle: activeBreakerEpisode.confirmedLifecycle,
        },
      });
      return;
    }
    sendPracticeEvent({ type: "run:inputsChanged", inputKey: sessionInputKey });
  }, [
    activeBreakerEpisode,
    machine.state.run.inputKey,
    machine.state.run.pendingLoad?.id,
    rehearse,
    sendPracticeEvent,
    sessionInputKey,
  ]);

  // Accept a tune-up: record it, then re-enter a session scoped to its sampled
  // skills (setting `tuneupSkillKeys` re-runs loadSession via its dependency).
  // If the server declines (interval re-check), just dismiss the offer.
  const onAcceptTuneup = useCallback(async () => {
    if (!tuneupOffer) return;
    try {
      const { tuneupId } = await startTuneup({
        scholarId,
        domain,
        skillKeys: tuneupOffer.skillKeys,
      });
      tuneupIdRef.current = tuneupId;
      setTuneupSkillKeys(tuneupOffer.skillKeys);
    } catch {
      setTuneupDismissed(true);
    }
  }, [tuneupOffer, startTuneup, scholarId, domain]);

  // Accept "More of your pick": fetch a few more same-strand skills
  // (bonusSkillsForChoice), log the pick (best-effort, mirrors PlaylistCard's
  // home_choice logging), then re-enter a session scoped to them (setting
  // `bonusMoreSkillKeys` re-runs loadSession via its dependency). A strand that
  // has nothing left right now is a quiet no-op — the calm default (Done /
  // Practice again) stays available either way.
  const onAcceptBonusMorePick = useCallback(async () => {
    if (!choiceHintDomain || !choiceHintStrand || bonusMoreLoading) return;
    setBonusMoreLoading(true);
    try {
      const res = await convex.query(api.practiceSkills.bonusSkillsForChoice, {
        domain: choiceHintDomain,
        strand: choiceHintStrand,
        count: 4,
      });
      if (res.skillKeys.length === 0) return;
      const clientPickId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `bonus-more-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      logPracticeChoiceMutation({
        domain: choiceHintDomain,
        strand: choiceHintStrand,
        source: "bonus_more_of_pick",
        candidateSkillKeys: res.skillKeys,
        clientPickId,
      }).catch(() => {
        // Best-effort — the scholar still gets the bonus set either way.
      });
      setBonusMoreSkillKeys(res.skillKeys);
    } finally {
      setBonusMoreLoading(false);
    }
  }, [choiceHintDomain, choiceHintStrand, bonusMoreLoading, convex, logPracticeChoiceMutation]);

  // "Practice again": from a finished tune-up or bonus-more round, drop back to
  // normal whole-graph practice (clearing the scope re-runs loadSession);
  // otherwise just reload a fresh normal session.
  const restartPractice = useCallback(() => {
    if (tuneupSkillKeys !== null) {
      tuneupIdRef.current = null;
      setTuneupDismissed(true);
      setTuneupSkillKeys(null);
    } else if (bonusMoreSkillKeys !== null) {
      setBonusMoreSkillKeys(null);
    } else {
      // A fresh normal wrap: a prior decline only suppressed the offer for that
      // wrap, so clear it — the server still governs whether one is due.
      setTuneupDismissed(false);
      machine.send({ type: "run:reloadRequested" });
    }
  }, [tuneupSkillKeys, bonusMoreSkillKeys, machine]);

  const resetItemHostState = useCallback(() => {
    setResult(null);
    setComesBackText(null);
    setInput("");
    setHintRungs([]);
    setActiveHintRung(null);
    setHintStepError(null);
    wrongAnswersRef.current = [];
    setHandoff(null);
    setHandoffInput("");
    setDialogueVerdict(null);
    setPredictedConfidence(null);
    setHelpReported(false);
    setRevealPrediction(null);
    setMappingRetry(false);
  }, []);

  // Opt into the challenge round (P1e): swap the labeled challenge tail in as a
  // fresh run. No server round-trip — the items were served alongside the
  // required set; each carries lane "challenge" so the "· challenge" chip shows.
  const onAcceptChallenge = useCallback(() => {
    if (challengeItems.length === 0) return;
    const next = challengeItems;
    setChallengeItems([]);
    setInChallenge(true);
    setFirstPostPlacementBlock(false);
    setItems(next);
    // The challenge round is a separate labeled tail, not part of playlist
    // segments v1 (no "challenge" segment kind) — clear stale segments from
    // the just-finished required set so no beat/divider misaligns with it.
    setSegments([]);
    setLog([]);
    resetItemHostState();
    machine.send({
      type: "lane:tailAccepted",
      itemCount: next.length,
      itemId: next[0]?.itemId ?? null,
    });
  }, [challengeItems, machine, resetItemHostState]);

  const startStretchRound = useCallback((next: ServedItem[]) => {
    setInStretch(true);
    setStretchCracked(false);
    setFirstPostPlacementBlock(false);
    setItems(next);
    setSegments([]);
    setLog([]);
    resetItemHostState();
    machine.send({
      type: "lane:tailAccepted",
      itemCount: next.length,
      itemId: next[0]?.itemId ?? null,
    });
  }, [machine, resetItemHostState]);

  // Opt into the ordinary "Go deeper" stretch tail. Its items were already
  // resolved alongside the required set, so accepting remains a local swap.
  const onAcceptStretch = useCallback(() => {
    if (stretchItems.length === 0) return;
    // Honest provenance: the Go-deeper tail can serve THIS story's own
    // application (application items are ordinary tier:"stretch" rows and the
    // server attaches the story hook when it picks one). When that is what the
    // scholar just started, the moment was TRIED — record that instead of
    // leaving the ledger reading "offered". Matched on the served hook because
    // that is the only story identity the client is given (the server never
    // sends edge keys here). A bonus start no longer records "dismissed".
    const startedThisStory =
      !!storyMoment?.hook &&
      stretchItems.some((it) => it.storyHook === storyMoment.hook);
    if (startedThisStory) {
      storyCardSettleRef.current?.markTried();
      setStorySettled(true);
    }
    const next = stretchItems;
    setStretchItems([]);
    startStretchRound(next);
  }, [stretchItems, storyMoment, startStretchRound]);


  const current = items?.[idx];
  // Kindergarten (grade "K") items get a tap-to-hear speaker on the question
  // stem so a pre-reader can hear it. `ServedItem` doesn't carry the node's
  // grade band, so resolve it from the served skillKeys (cheap indexed batch
  // read); the speaker only shows for grade-"K" items (and only when the
  // scholar's TTS is on — SpeakableLabel enforces that).
  const stemSkillKeys = useMemo(
    () => (items ? Array.from(new Set(items.map((it) => it.skillKey))) : []),
    [items],
  );
  const gradeBandByKey = useQuery(
    api.practiceSkills.gradeBandsForKeys,
    stemSkillKeys.length > 0 ? { skillKeys: stemSkillKeys } : "skip",
  );
  const currentIsKinder = !!current && gradeBandByKey?.[current.skillKey] === "K";
  const hintRungActiveForCurrent =
    hintItemId === current?.itemId && activeHintRung !== null;
  const hintBlocksMainSubmit = hintLadderBlocksMainSubmit({
    servePending: hintStepLoading,
    activeCompletion: hintRungActiveForCurrent,
  });
  // Option D: the active item is a `· mapping` placement probe — measurement,
  // reveal-only, graded through the placement path (never retry/stuck).
  const isMapping = current?.lane === "mapping";

  // A unit-bearing item ("…in cubic centimeters"): the unit is part of the
  // answer, so the flat surface widens its key allowlist, offers the unit keys,
  // and holds a unit-less submit back. Only typed items — a tapped choice or a
  // manipulative board has no unit to write (and never carries `answerUnit`).
  const answerUnit =
    current &&
    current.answerType !== MANIPULATIVE_ANSWER_TYPE &&
    !isMultipleChoiceItem(current.answerType, current.choices?.length)
      ? current.answerUnit
      : undefined;
  // The item whose submit the unit gate held back. Keyed by itemId rather than a
  // bare flag so advancing retires the nudge on its own — no reset effect.
  const [unitGatedItemId, setUnitGatedItemId] = useState<string | null>(null);
  const unitGateNudge = !!current && unitGatedItemId === current.itemId;

  // Direct-manipulation 2-D answer entry (fraction/power/root). Driven only when the
  // server tags the item `answerShape: "twoD"` (a genuinely structured answer);
  // every other typed answer stays on the flat number pad. The DOM editor and
  // the iPad editor share ONE state machine (shared/expressionTemplateInput.ts),
  // so a scholar gets the same builder on web and native (parity, 2026-07-04).
  const usesTemplateEditor =
    !!current &&
    current.answerShape === "twoD" &&
    (current.answerType === "fraction" || current.answerType === "expression");

  // "See an example" shelf (instructional segments v1): the verified strand-level
  // worked example for the CURRENT item's strand, if any. This is what keeps a
  // skip from ever being a trap — a scholar who chose "Try it myself", or who
  // just missed, can pull the same explainer up on demand. Resolved from the
  // item's skillKey server-side (knowledgeNodes carries the strand); null for a
  // strand with no verified content, so non-seeded strands simply show no shelf.
  const strandExample = useQuery(
    api.instruction.instructionContentForSkill,
    isRemote || !current?.skillKey || isMapping
      ? "skip"
      : { scholarId, skillKey: current.skillKey },
  ) as (InstructionExampleContent & { key: string }) | null | undefined;
  // Post-miss escalation (§4.2): the SAME node-first-with-strand-fallback
  // resolution the node drawer/map reference (§4.3) uses, only resolved once
  // the shelf itself is showing (`strandExample` truthy) — an escalation on
  // top of an existing pull, never its own independent affordance. Gated by
  // the exact same `isRemote`/mapping guards as the shelf so a teacher/parent
  // remote view never sees (or writes) it either.
  const nodeFirstExample = useQuery(
    api.instruction.instructionContentForNode,
    isRemote || !current?.skillKey || isMapping || !strandExample
      ? "skip"
      : { scholarId, nodeKey: current.skillKey },
  ) as (InstructionExampleContent & { key: string }) | null | undefined;
  const [exampleSheet, setExampleSheet] = useState<{ source: "idea_shelf" | "post_miss" } | null>(null);
  // Playlist segments v1: derive per-index segment membership from the
  // run-length `segments` list. `segmentStartIdx[i]` is the flat item index
  // where segment `i` begins; `segmentOfIdx[i]` maps a flat item index back to
  // its segment index. Both derive purely from `segments` + `items.length`, so
  // they stay in lockstep even if a fetch hasn't landed yet (empty arrays).
  const { segmentOfIdx, segmentStartIdx } = useMemo(() => {
    const starts: number[] = [];
    const ofIdx: number[] = [];
    let offset = 0;
    segments.forEach((seg, segIdx) => {
      starts.push(offset);
      for (let i = 0; i < seg.count; i++) ofIdx.push(segIdx);
      offset += seg.count;
    });
    return { segmentOfIdx: ofIdx, segmentStartIdx: starts };
  }, [segments]);
  // Display segments: the wire `segments` RLE is defined over the GRADED items
  // only (its counts sum to `items.length` -- a server invariant that existing
  // tests pin). The Launchpad is ungraded but is still part of the scholar's map
  // of the run, so the playlist it sees splices a one-slot `launchpad` band in
  // at `at`. Display-only: `idx` keeps indexing `items`.
  const displaySegments = useMemo(
    () => (launchpad ? withLaunchpadSegment(segments, launchpad.at) : segments),
    [segments, launchpad],
  );
  const currentSegmentIdx = segmentOfIdx[idx];
  const currentSegment = currentSegmentIdx != null ? segments[currentSegmentIdx] : undefined;
  // A light beat header shows only on the FIRST item of a segment (never
  // repeated for every item inside it).
  const isSegmentStart = currentSegmentIdx != null && segmentStartIdx[currentSegmentIdx] === idx;
  const isFirstCoreDrillSegment =
    currentSegment?.kind === "core_drill" &&
    segments.slice(0, currentSegmentIdx).every((s) => s.kind !== "core_drill");

  // Reset the render/first-key clock whenever a genuinely NEW item lands (a
  // fresh item object — initial load, advance, or a fresh-variant swap). A
  // same-item retry (onRetry) deliberately does NOT reset this — see there.
  useEffect(() => {
    if (!current) return;
    itemRenderAtRef.current = Date.now();
    firstKeyAtRef.current = null;
  }, [current]);

  // Stage auto-scroll. Two very different surfaces share this effect:
  //
  //   • Handoff (chat): the Socratic turn-taking view. A growing transcript
  //     SHOULD scroll up so the newest turn stays pinned to the bottom edge —
  //     classic chat behavior (block:"end").
  //
  //   • Keypad / typed items: a math problem is NOT a chat. Pinning the bottom
  //     edge here was the bug — on a short viewport (or a tall stem) block:"end"
  //     scrolled the whole PROBLEM STEM up past the stage's own clip edge, so
  //     the prompt vanished off the top with only the pad + CTA left in view.
  //     The prompt is the one thing that must always be visible, so a FRESH
  //     answering item reveals the STEM (scroll the stage to its top). The full
  //     digit grid still fits, and the help row + CTA lane live OUTSIDE this
  //     scroll region and are therefore always visible. We still reveal the low
  //     edge when a verdict lands (content appended below) — a small
  //     `block:"nearest"` scroll that only engages on genuine overflow.
  //
  //     The hint is deliberately NOT a trigger here: it now opens inside the
  //     pinned bottom lane, not in this scroll region, so scrolling on it would
  //     chase an anchor that never moved — and worse, the lane growing shrinks
  //     this stage, so the "reveal" would drag the stem toward the clip edge.
  //
  // `bottomEl` / `stageEl` are in the deps (not plain ref reads) because on the
  // FIRST item the component still renders its "Loading…" fallback (no anchor in
  // the DOM yet) at the moment idx/phase first settle — the nodes mount a beat
  // later with those same dependency values unchanged, so a plain ref read would
  // stay the stale `null` it saw on that loading-phase run and this would never
  // fire again for that item. Calm-motion aware.
  useEffect(() => {
    if (!bottomEl) return;
    const reduce =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
    if (phase === "handoff") {
      bottomEl.scrollIntoView({ behavior, block: "end" });
      return;
    }
    if (phase === "feedback" || phase === "queued") {
      // Content appended below the pad (verdict copy) — reveal it with the
      // minimum scroll so the stem isn't pushed off unless the viewport
      // genuinely can't hold both.
      bottomEl.scrollIntoView({ behavior, block: "nearest" });
    } else {
      // A fresh answering item: keep the prompt at the top of the stage.
      (stageEl ?? bottomEl.parentElement)?.scrollTo({ top: 0, behavior });
    }
  }, [idx, phase, current?.itemId, handoff?.messages.length, bottomEl, stageEl]);

  // Track the active item; when it changes, hand the one we just left to the
  // float-up-and-fade exit (see `departing` above).
  useEffect(() => {
    const prev = prevItemRef.current;
    if (!current) return;
    if (prev && prev.itemId !== current.itemId) {
      setDeparting(prev);
      const t = setTimeout(() => setDeparting(null), 460);
      prevItemRef.current = { itemId: current.itemId, stem: current.stem };
      return () => clearTimeout(t);
    }
    prevItemRef.current = { itemId: current.itemId, stem: current.stem };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.itemId]);

  const onKey = useCallback((k: string) => {
    haptic("selection"); // tasteful tick per keypress (no-op off-native)
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setUnitGatedItemId(null); // any edit answers the "include the unit" nudge
    setInput((prev) => {
      const next = applyKey(prev, k);
      // A unit item's hardware-typed caret ("cm^3") reads as the SAME real
      // superscript a tapped unit key already produces ("cm³") — never a bare
      // caret a kid has never seen. Grading is unaffected either way
      // (`splitUnitSuffix`'s alias table recognizes both forms); this just keeps
      // the stored buffer itself canonical so display never diverges from it.
      return answerUnit ? superscriptExponents(next) : next;
    });
  }, [answerUnit]);

  // A tapped unit key REPLACES any trailing unit, so cm² → cm³ is one tap.
  const onUnitKey = useCallback((unit: string) => {
    haptic("selection");
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setUnitGatedItemId(null);
    setInput((prev) => applyUnitKey(prev, unit));
  }, []);

  // The 2-D expression editor's state machine — the SAME hook drives the
  // practice session AND placement (single source of truth). It (re)seeds when
  // entering an answering phase for a twoD item: from the L1 skeleton (structure
  // locked) if the server sent one, else a blank L3 canvas; `input` mirrors the
  // submission so the shared submit / CTA-enable / grader path stays unchanged.
  // A haptic tick (every key) + the answer-latency clock (real edits only) ride
  // along via onKeyDispatched — session-only concerns the hook doesn't own.
  const onTemplateKeyDispatched = useCallback((isNav: boolean) => {
    haptic("selection");
    if (!isNav && firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
  }, []);
  const { templateState, onTemplateKey, onSetCaret, onInsertFraction, onInsertPower, onInsertSquareRoot, onInsertRoot } =
    useExpressionTemplate({
      enabled: usesTemplateEditor && phase === "answering",
      itemKey: current?.itemId,
      seedSkeleton: current?.answerFormat ?? null,
      onSubmissionChange: setInput,
      onKeyDispatched: onTemplateKeyDispatched,
    });

  // Advance to the next item in the session. Mapping answers call this
  // immediately after the server records the outcome, so pretest measurement
  // never detours through a correctness/reveal screen.
  const onNext = useCallback(async () => {
    if (continuingMappingRef.current) return;
    resetItemHostState();
    const atEnd = !items || idx + 1 >= items.length;
    if (atEnd) {
      const isMainMappingSit =
        includeMapping &&
        !scopedByProp &&
        !inChallenge &&
        !inStretch &&
        !inTuneup &&
        !inBonusMore &&
        !!items &&
        allMapping;
      if (
        isMainMappingSit &&
        items &&
        mappingProgressOffset + items.length < MAPPING_PRETEST_MAX_QUESTIONS
      ) {
        continuingMappingRef.current = true;
        setLaneBusy(true);
        const more = await fetchMoreMapping(items.length);
        setLaneBusy(false);
        continuingMappingRef.current = false;
        if (more.length > 0) {
          const nextItems = [...items, ...more];
          setItems(nextItems);
          setSegments((prev) => appendMappingSegment(prev, more.length));
          machine.send({
            type: "lane:batchAppended",
            addedCount: more.length,
          });
          machine.send({
            type: "ui:advance",
            nextItemId: nextItems[idx + 1]?.itemId ?? null,
          });
          return;
        }
      }
      machine.send({ type: "ui:advance" });
    } else {
      machine.send({
        type: "ui:advance",
        nextItemId: items[idx + 1]?.itemId ?? null,
      });
    }
  }, [
    items,
    idx,
    includeMapping,
    scopedByProp,
    inChallenge,
    inStretch,
    inTuneup,
    inBonusMore,
    allMapping,
    mappingProgressOffset,
    fetchMoreMapping,
    machine,
    resetItemHostState,
  ]);

  // A correct result can still have been scaffolded. Record that quiet correction
  // without interrupting the feedback moment the scholar is currently reading.
  // Pressing again takes it back: a mis-tap on an honesty control must not be a
  // trap, so the pill toggles rather than latching.
  const onDoneWithHelp = useCallback(async () => {
    if (!result?.attemptId || busy || helpPending) return;
    const attemptId = result.attemptId;
    const undoing = helpReported;
    setHelpPending(true);
    setHelpReported(!undoing);
    try {
      if (undoing) {
        const res = await undoHelpUsed({ scholarId, attemptId });
        if (!res.undone) {
          setHelpReported(true);
          return;
        }
        const retryItemId = helpRetryItemIdRef.current;
        const lastIdx = (items?.length ?? 0) - 1;
        if (
          retryItemId &&
          items?.[lastIdx]?.itemId === retryItemId &&
          lastIdx > idx
        ) {
          // Withdraw only the item this admission appended, and only while it is
          // still ahead of the scholar.
          setItems(items.slice(0, lastIdx));
          machine.send({ type: "run:itemCountAdjusted", delta: -1 });
          helpRetryItemIdRef.current = null;
        }
        return;
      }
      const res = await reportHelpUsed({
        scholarId,
        attemptId,
        seed: Math.floor(Math.random() * 2_000_000_000),
      });
      const retry = res.items[0] as ServedItem | undefined;
      helpRetryItemIdRef.current = retry?.itemId ?? null;
      if (retry) {
        // Keep the earned verdict in place; the fresh bare retry belongs later in
        // this run, not as an interruption to the moment of honest reflection.
        setItems((prev) => (prev ? [...prev, retry] : prev));
        machine.send({ type: "run:itemCountAdjusted", delta: 1 });
      }
    } catch (error) {
      // A failed admission is quiet too: restore the pill so the scholar can retry.
      console.error("practice help-used report failed:", error);
      setHelpReported(undoing);
    } finally {
      setHelpPending(false);
    }
  }, [
    busy,
    helpPending,
    helpReported,
    idx,
    items,
    machine,
    reportHelpUsed,
    result,
    scholarId,
    undoHelpUsed,
  ]);

  const onSubmit = useCallback(async (rawAnswer?: string) => {
    if (!current || busy || hintStepLoading) return;
    const answer = (rawAnswer ?? input).trim();
    if (!answer) return;
    // A unit-bearing item wants "112 cm³". A bare number now grades INCORRECT,
    // so hold it here rather than spending the kid's attempt on a slip they
    // can fix in one tap. Only the typed answer — the don't-know path and the
    // tapped choice / manipulative commits never reach this gate.
    if (answerUnit && !hasUnitToken(answer)) {
      setUnitGatedItemId(current.itemId);
      return;
    }

    haptic("medium"); // a submit landed
    // The FIRST attempt on an item records to mastery; retries during a handoff
    // loop are graded but not recorded, so the scheduler isn't double-penalized.
    const firstAttempt = isFirstAttempt(hasRecorded);

    // ── Option D: a `· mapping` item grades through the PLACEMENT path
    //    (submitMappingAnswer → inferred credit, never demonstrated fluency).
    //    `allMapping` (the day-1/cold-start "Math Check-In" sit — the ONLY
    //    surface this repo still calls the "pretest") stays silent: record it,
    //    move directly to the next probe, no verdict/reveal/haptic. Folded
    //    into an otherwise NORMAL playlist (an already-placed scholar picking
    //    up an unmapped domain, `allMapping === false`), the scholar gets the
    //    same reveal-only feedback an ordinary drill item gets — just no
    //    retry (the grade is already recorded; see the FeedbackNote/CtaLane
    //    `mappingReveal` branches below). ──
    if (current.lane === "mapping" && !rehearse) {
      setMappingRetry(false);
      machine.send({ type: "lane:entered", lane: "mapping" });
      setLaneBusy(true);
      try {
        const graded = await submitMapping({
          scholarId,
          domain: current.domain ?? domain ?? "",
          itemId: current.itemId,
          seed: seedRef.current,
          answer,
        });
        // A stale/unresolvable item means the current batch is no longer useful;
        // recompose immediately, still without presenting a verdict.
        if (graded.outcome === null || graded.alreadyMapped) {
          setResult(null);
          setRevealPrediction(null);
          machine.send({ type: "lane:exited" });
          machine.send({ type: "run:reloadRequested" });
          return;
        }
        // "Confirm before you cap": a first typed miss with confirm budget is a
        // possible slip. The server already served a FRESH item on the SAME skill
        // (graded.retryItem) without capping — swap it into the current slot and
        // offer the two-way choice instead of moving on. The slip path answers
        // that confirm item; the concede path don't-knows it (the fast cap).
        if (graded.retry && graded.retryItem) {
          const confirm = graded.retryItem as ServedItem;
          setItems((prev) => (prev ? prev.map((it, i) => (i === idx ? confirm : it)) : prev));
          setInput("");
          setResult(null);
          setRevealPrediction(null);
          wrongAnswersRef.current = [];
          setMappingRetry(true);
          machine.send({
            type: "lane:mappingRetry",
            itemId: confirm.itemId,
          });
          return;
        }
        const res: SubmitResult = {
          correct: graded.outcome === "correct",
          correctAnswer: graded.correctAnswer ?? undefined,
          // `submitMappingAnswer` reports the unit verdict at the top level
          // (the placement pair nests it under `graded`).
          unitOutcome: graded.unitOutcome,
          skillKey: current.skillKey,
          skillLabel: current.skillLabel,
          repetition: 0,
          proficiency: "not_started",
          accelerated: false,
          dontKnow: graded.outcome === "unknown",
          turnedFluent: false,
          mapping: true,
          domainJustMapped: graded.domainJustMapped,
          mappedDomainLabel: graded.domainLabel,
        };
        setRevealPrediction(null);
        if (firstAttempt) setLog((l) => [...l, res]);
        if (graded.domainJustMapped) setMappedDomainLabel(res.mappedDomainLabel ?? null);
        machine.send({
          type: "lane:mappingAnswered",
          recorded: true,
          correct: res.correct,
        });
        if (showsMappingFeedback(allMapping)) {
          setResult(res);
          haptic(res.correct ? "success" : "warning");
        } else {
          await onNext();
        }
      } catch {
        // A dropped mapping submit just returns to answering — nothing to queue.
        machine.send({ type: "lane:exited" });
      } finally {
        setLaneBusy(false);
      }
      return;
    }

    const breakerSubmitContext = {
      prepareBreakerRepair: !quickFacts,
      suppressBreaker: quickFacts,
      ...(breaker?.flow.stage === "fresh" &&
      breaker.freshItemId === current.itemId &&
      firstAttempt
        ? { breakerTriggerAttemptId: breaker.triggerAttemptId }
        : {}),
      ...(breaker?.flow.stage === "easy" && firstAttempt
        ? { breakerEasyTriggerAttemptId: breaker.triggerAttemptId }
        : {}),
    };
    const clientEventKey = JSON.stringify({
      itemId: current.itemId,
      answer,
      record: firstAttempt,
      dontKnow: false,
      predictedConfidence: firstAttempt ? predictedConfidence : null,
      ...breakerSubmitContext,
    });
    const reusesClientEvent =
      machine.state.item.clientEventKey === clientEventKey &&
      machine.state.item.clientEventId !== null;
    const clientEventId = reusesClientEvent
      ? machine.state.item.clientEventId!
      : makeClientEventId("practice-answer");
    const timing = computeTiming({
      firstAttempt,
      nowMs: Date.now(),
      renderAtMs: itemRenderAtRef.current,
      firstKeyAtMs: firstKeyAtRef.current,
    });
    const entry: OutboxAnswer = {
      clientEventId,
      itemId: current.itemId,
      answer,
      record: firstAttempt,
      skillLabel: current.skillLabel,
      queuedAt: Date.now(),
      ...(reusesClientEvent &&
      machine.state.item.clientEventReplay !== null
        ? { submissionReplay: machine.state.item.clientEventReplay }
        : {}),
      ...(firstAttempt && predictedConfidence ? { predictedConfidence } : {}),
      ...breakerSubmitContext,
      ...(timing.firstKeyMs !== undefined ? { latencyMs: timing.firstKeyMs } : {}),
      ...(timing.elapsedMs !== undefined ? { thinkTimeMs: timing.elapsedMs } : {}),
    };
    machine.send({
      type: "ui:submit",
      answer,
      clientEventId,
      clientEventKey,
      entry,
    });
  }, [
    allMapping,
    answerUnit,
    breaker,
    busy,
    current,
    domain,
    hasRecorded,
    hintStepLoading,
    idx,
    input,
    machine,
    onNext,
    predictedConfidence,
    quickFacts,
    rehearse,
    scholarId,
    submitMapping,
  ]);

  // "I haven't learned this yet" — an honest don't-know. Recorded as a MISS for
  // spaced repetition (it IS a miss), but flagged distinctly: supportive copy and
  // — instead of a passive streamed explanation a young scholar dismisses — ONE
  // interactive faded worked step in the feedback moment (TeachingStep; doing the
  // step IS the reading). Never the retry/stuck loop, and — like every drill miss
  // — no automatic answer reveal. Skipped while offline (nothing to record) and
  // never on a retry (it's a first-look affordance). Server skips error classification.
  const onDontKnow = useCallback(async () => {
    if (!current || busy || isOffline || !isFirstAttempt(hasRecorded)) return;

    // ── Option D: an honest "I haven't learned this yet" on a `· mapping` item
    //    is placement measurement too. The all-mapping check-in/pretest sit
    //    (`allMapping`) stays silent; folded into a normal playlist it gets
    //    the same reveal-only feedback (no teaching step — Option D never
    //    gave mapping items one) an ordinary don't-know's answer reveal gives. ──
    if (current.lane === "mapping" && !rehearse) {
      setMappingRetry(false);
      machine.send({ type: "lane:entered", lane: "mapping" });
      setLaneBusy(true);
      try {
        const graded = await submitMapping({
          scholarId,
          domain: current.domain ?? domain ?? "",
          itemId: current.itemId,
          seed: seedRef.current,
          dontKnow: true,
        });
        if (graded.outcome === null || graded.alreadyMapped) {
          setResult(null);
          setRevealPrediction(null);
          machine.send({ type: "lane:exited" });
          machine.send({ type: "run:reloadRequested" });
          return;
        }
        const res: SubmitResult = {
          correct: false,
          correctAnswer: graded.correctAnswer ?? undefined,
          skillKey: current.skillKey,
          skillLabel: current.skillLabel,
          repetition: 0,
          proficiency: "not_started",
          accelerated: false,
          dontKnow: true,
          turnedFluent: false,
          mapping: true,
          domainJustMapped: graded.domainJustMapped,
          mappedDomainLabel: graded.domainLabel,
        };
        setRevealPrediction(null);
        setLog((l) => [...l, res]);
        if (graded.domainJustMapped) setMappedDomainLabel(res.mappedDomainLabel ?? null);
        machine.send({
          type: "lane:mappingAnswered",
          recorded: true,
          correct: false,
        });
        if (showsMappingFeedback(allMapping)) {
          setResult(res);
          haptic("warning");
        } else {
          await onNext();
        }
      } catch {
        machine.send({ type: "lane:exited" });
      } finally {
        setLaneBusy(false);
      }
      return;
    }
    const breakerSubmitContext = {
      prepareBreakerRepair: !quickFacts,
      suppressBreaker: quickFacts,
      ...(breaker?.flow.stage === "fresh" &&
      breaker.freshItemId === current.itemId
        ? { breakerTriggerAttemptId: breaker.triggerAttemptId }
        : {}),
      ...(breaker?.flow.stage === "easy"
        ? { breakerEasyTriggerAttemptId: breaker.triggerAttemptId }
        : {}),
    };
    const clientEventKey = JSON.stringify({
      itemId: current.itemId,
      answer: "",
      record: true,
      dontKnow: true,
      predictedConfidence,
      ...breakerSubmitContext,
    });
    const reusesClientEvent =
      machine.state.item.clientEventKey === clientEventKey &&
      machine.state.item.clientEventId !== null;
    const clientEventId = reusesClientEvent
      ? machine.state.item.clientEventId!
      : makeClientEventId("practice-answer");
    const timing = computeTiming({
      firstAttempt: true,
      nowMs: Date.now(),
      renderAtMs: itemRenderAtRef.current,
      firstKeyAtMs: null,
    });
    setRevealPrediction(null);
    setDontKnowStepReady(rehearse);
    const entry: OutboxAnswer = {
      clientEventId,
      itemId: current.itemId,
      answer: "",
      record: true,
      dontKnow: true,
      skillLabel: current.skillLabel,
      queuedAt: Date.now(),
      ...(reusesClientEvent &&
      machine.state.item.clientEventReplay !== null
        ? { submissionReplay: machine.state.item.clientEventReplay }
        : {}),
      ...(predictedConfidence ? { predictedConfidence } : {}),
      ...breakerSubmitContext,
      ...(timing.firstKeyMs !== undefined ? { latencyMs: timing.firstKeyMs } : {}),
      ...(timing.elapsedMs !== undefined ? { thinkTimeMs: timing.elapsedMs } : {}),
    };
    machine.send({
      type: "ui:submit",
      answer: "",
      clientEventId,
      clientEventKey,
      entry,
    });
  }, [
    allMapping,
    breaker,
    busy,
    current,
    domain,
    hasRecorded,
    isOffline,
    machine,
    onNext,
    predictedConfidence,
    quickFacts,
    rehearse,
    scholarId,
    submitMapping,
  ]);

  // "Confirm before you cap" (mapping band): the two-way slip/concede choice
  // shown after a first typed miss, mirroring Placement.tsx. The fresh confirm
  // item is ALREADY the current slot (swapped in by onSubmit above), so:
  //  • slip → just answer it (a correct confirm supersedes the miss);
  //  • concede → a don't-know on that same confirm item caps immediately (the
  //    fast path — no extra question). onDontKnow's first-attempt guard passes
  //    because the swap reset hasRecorded, and it routes through the mapping
  //    branch since the confirm item carries lane "mapping".
  const onSlipRetry = useCallback(() => {
    setInput("");
    setMappingRetry(false);
  }, []);
  const onSlipConcede = useCallback(() => {
    void onDontKnow();
  }, [onDontKnow]);

  // A manipulative item's spec (lane 2) — parsed once per item, not per
  // render. Malformed/missing JSON parses to null; the render below shows a
  // fallback rather than crashing on a bad row.
  const manipulativeSpec = useMemo(
    () =>
      current?.answerType === MANIPULATIVE_ANSWER_TYPE
        ? parseManipulativeSpec(current.manipulativeSpec)
        : null,
    [current],
  );

  // Done on a manipulative item: hand the locked-in state to the SAME submit
  // path a numeric item uses (`onSubmit`'s optional override) — offline
  // queueing, mastery recording, streaks, and the miss/handoff flow all apply
  // unchanged. The server re-runs `isSolved` on this JSON; the answer itself
  // is never sent back to the client (see submitAnswer in practiceSkills.ts).
  const onManipulativeCommit = useCallback(
    (stateJson: string) => {
      void onSubmit(stateJson);
    },
    [onSubmit],
  );

  // Retry the SAME item (after a miss, before the handoff). Keeps missCount +
  // wrongAnswers + hasRecorded so a second miss unlocks "Talk it through".
  const onRetry = useCallback(() => {
    resetItemHostState();
    setUnitGatedItemId(null);
    machine.send({ type: "ui:retry" });
  }, [machine, resetItemHostState]);

  // A first-miss answer still looks like an input, so treat actual edit intent
  // as the retry action instead of making the scholar click the CTA first.
  const implicitRetryAvailable =
    phase === "feedback" &&
    !!result &&
    !result.correct &&
    !result.dontKnow &&
    !!current &&
    !isMapping &&
    onBreakerItem !== true &&
    current.answerType !== MANIPULATIVE_ANSWER_TYPE &&
    current.answerType !== "dialogue" &&
    !isMultipleChoiceItem(current.answerType, current.choices?.length) &&
    classifyVerdict(result, missCount) === "retry" &&
    !busy;
  const implicitRetryStartedRef = useRef(false);
  const pendingTemplateRetryKeysRef = useRef<string[]>([]);

  useEffect(() => {
    if (!implicitRetryAvailable) return;
    implicitRetryStartedRef.current = false;
    pendingTemplateRetryKeysRef.current = [];
  }, [current?.itemId, implicitRetryAvailable]);

  const beginImplicitRetry = useCallback(() => {
    if (!implicitRetryAvailable) return false;
    if (!implicitRetryStartedRef.current) {
      implicitRetryStartedRef.current = true;
      onRetry();
    }
    return true;
  }, [implicitRetryAvailable, onRetry]);

  const onImplicitFlatRetryKey = useCallback(
    (key: string) => {
      if (!beginImplicitRetry()) return;
      onKey(key);
    },
    [beginImplicitRetry, onKey],
  );

  const onImplicitTemplateRetryKey = useCallback(
    (key: string) => {
      if (!beginImplicitRetry()) return;
      pendingTemplateRetryKeysRef.current.push(key);
    },
    [beginImplicitRetry],
  );

  useEffect(() => {
    if (phase !== "answering" || !usesTemplateEditor) return;
    const pending = pendingTemplateRetryKeysRef.current.splice(0);
    pending.forEach(onTemplateKey);
  }, [phase, usesTemplateEditor, onTemplateKey]);

  // Open the Socratic handoff (kid-initiated, after 2 misses).
  const installHandoff = useCallback(
    (entryMode: "stuck" | "spiral" | "ladder") => {
      setHandoff({
        mode: "handoff",
        entryMode,
        messages: [
          {
            role: "assistant",
            content:
              entryMode === "spiral"
                ? SPIRAL_HANDOFF_OPENER
                : HANDOFF_OPENER,
          },
        ],
        ended: false,
        loading: false,
        error: null,
      });
      setHandoffInput("");
    },
    [],
  );
  const openTalkItThrough = useCallback(() => {
    // Rehearse never streams the tutor handoff (it would create chat rows).
    if (rehearse) return;
    installHandoff("stuck");
    machine.send({ type: "lane:entered", lane: "handoff" });
  }, [installHandoff, machine, rehearse]);
  const onTalkItThrough = useCallback(() => openTalkItThrough(), [openTalkItThrough]);

  const onHintLadderPress = useCallback(() => {
    // Rehearse hides the hint ladder (its step-serving is a mutation); nothing to
    // do if a stray call slips through.
    if (rehearse) return;
    if (!current || current.lane === "mapping" || busy || hintStepLoading) return;
    if (hintItemId !== current.itemId) {
      setHintRungs([]);
      setActiveHintRung(null);
    }
    setHintStepError(null);
    machine.send({ type: "ui:hintPressed" });
  }, [
    busy,
    current,
    hintItemId,
    hintStepLoading,
    machine,
    rehearse,
  ]);

  const onHintStepComplete = useCallback((revealedAfterWrong: boolean) => {
    if (!activeHintRung) return;
    setHintRungs((rungs) => [
      ...rungs,
      { rung: activeHintRung.rung, revealedAfterWrong },
    ]);
    setActiveHintRung(null);
  }, [activeHintRung]);

  // ── Breaker mechanics ─────────────────────────────────────────────────────
  // The reducer owns every breaker transition and command. This component only
  // installs the payloads those commands return.

  const finishBreakerRepairStep = useCallback(() => {
    machine.send({ type: "ui:breakerRepairCompleted" });
  }, [machine]);

  // Swap the playlist for exactly ONE item and hand the answer surface back.
  const installBreakerItem = useCallback(
    (item: ServedItem) => {
      setItems([item]);
      setSegments([]);
      resetItemHostState();
    },
    [resetItemHostState],
  );

  const onBreakerControl = useCallback(
    (control: BreakerControl) => {
      if (control === "checkStep") return;
      machine.send({
        type:
          control === "coach"
            ? "ui:breakerCoach"
            : "ui:breakerEasyFinish",
      });
    },
    [machine],
  );

  const finishBreakerItem = useCallback(() => {
    machine.send({ type: "ui:breakerClose" });
  }, [machine]);

  // "Try it again →" — a fresh variant of the SAME skill (roadmap §8②). Replaces
  // the current slot in place; falls back to the next item if none is available.
  const onFreshVariant = useCallback(async () => {
    if (!current) return;
    setLaneBusy(true);
    try {
      const seed = Math.floor(Math.random() * 2_000_000_000);
      const res = await convex.query(api.practiceSkills.practiceSession, {
        scholarId,
        size: 1,
        seed,
        skillKeys: [current.skillKey],
        domain,
      });
      const fresh = (res.items as ServedItem[])[0];
      // Preserve the current item's serving-lane chip on the swapped-in variant
      // (a scoped re-fetch can't re-derive "challenge"), so a challenge round's
      // "try again" stays labeled a challenge.
      if (fresh && current.lane) fresh.lane = current.lane;
      resetItemHostState();
      if (fresh) {
        setItems((prev) => (prev ? prev.map((it, i) => (i === idx ? fresh : it)) : prev));
        machine.send({
          type: "lane:handoffClosed",
          outcome: "fresh-variant",
          itemId: fresh.itemId,
        });
      } else {
        // No fresh variant of this skill available — just move on.
        machine.send({
          type: "lane:handoffClosed",
          outcome: "advance",
          itemId: items?.[idx + 1]?.itemId ?? null,
        });
      }
    } finally {
      setLaneBusy(false);
    }
  }, [
    current,
    convex,
    domain,
    idx,
    items,
    machine,
    resetItemHostState,
    scholarId,
  ]);

  const onHandoffRetry = useCallback(() => {
    resetItemHostState();
    machine.send({
      type: "lane:handoffClosed",
      outcome: "retry-same",
    });
  }, [machine, resetItemHostState]);

  const onHandoffAdvance = useCallback(() => {
    resetItemHostState();
    machine.send({
      type: "lane:handoffClosed",
      outcome: "advance",
      itemId: items?.[idx + 1]?.itemId ?? null,
    });
  }, [idx, items, machine, resetItemHostState]);

  // Send one turn to the handoff tutor. The endpoint re-derives the answer
  // server-side, feeds the tutor ONLY the stem + wrong answers, and redacts any
  // reply that leaks the answer. Buffered (not streamed) so the backstop always
  // runs before the kid sees anything.
  const onHandoffSend = useCallback(async (explicitText?: string) => {
    const text = (explicitText ?? handoffInput).trim();
    const hasImage = !!chatImage.pendingImage;
    if (!current || !handoff || handoff.loading || (!text && !hasImage)) return;
    const isDialogue = handoff.mode === "dialogue";
    if (
      isDialogue &&
      (!handoff.dialogueSessionToken || handoff.dialogueItemId !== current.itemId)
    ) {
      return;
    }
    // A photo-only turn still needs a line of text (the routes + transcript are
    // text-keyed) — stand in a neutral "here's my work" so the tutor reads it off
    // the image.
    const messageText = text || "Here's my work — can you take a look?";
    const nextMessages: ChatMsg[] = [...handoff.messages, { role: "user", content: messageText }];
    setHandoff({ ...handoff, messages: nextMessages, loading: true, error: null });
    setHandoffInput("");
    // Upload the staged scratch photo (if any); a failed upload falls back to a
    // text-only turn rather than dropping the message.
    let imageId: Id<"_storage"> | null = null;
    if (hasImage) {
      try {
        if (authToken && chatImage.pendingImage) {
          imageId = await uploadPracticeImage({
            siteUrl: convexSiteUrl(),
            authToken,
            scholarId,
            itemId: current.itemId,
            source: isDialogue ? "dialogue" : "handoff",
            body: chatImage.pendingImage.file,
          });
        }
      } catch (err) {
        console.error("practice chat image upload failed:", err);
      }
    }
    chatImage.clear();
    const authScheme = "Bearer ";
    try {
      const res = await fetch(
        `${convexSiteUrl()}${isDialogue ? "/practice-dialogue" : "/practice-handoff"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: authScheme + authToken } : {}),
          },
          body: JSON.stringify(
            isDialogue
              ? {
                  itemId: current.itemId,
                  scholarId,
                  message: messageText,
                  phase: "chat",
                  sessionToken: handoff.dialogueSessionToken,
                  ...(imageId ? { imageId } : {}),
                }
              : {
                  itemId: current.itemId,
                  scholarId,
                  wrongAnswers: wrongAnswersRef.current,
                  messages: nextMessages,
                  ...(handoff.entryMode ? { entryMode: handoff.entryMode } : {}),
                  ...(imageId ? { imageId } : {}),
                },
          ),
        },
      );
      const data = (await res.json()) as { reply?: string; ended?: boolean; error?: string };
      if (typeof data.reply === "string") {
        setHandoff((h) =>
          h
            ? {
                ...h,
                messages: [...nextMessages, { role: "assistant", content: data.reply as string }],
                loading: false,
                ended: !!data.ended,
                error: data.error ?? null,
              }
            : h,
        );
        if (data.ended && handoff.entryMode === "spiral") {
          machine.send({ type: "lane:coachEnded" });
        }
      } else {
        setHandoff((h) =>
          h ? { ...h, loading: false, error: data.error ?? "Something hiccuped — try again." } : h,
        );
      }
    } catch {
      setHandoff((h) =>
        h ? { ...h, loading: false, error: "Couldn't reach the tutor — check your connection." } : h,
      );
    }
  }, [current, handoff, handoffInput, authToken, chatImage, machine, scholarId]);

  const handoffSendRef = useRef(onHandoffSend);
  useEffect(() => {
    handoffSendRef.current = onHandoffSend;
  }, [onHandoffSend]);
  const handleHandoffTranscript = useCallback((text: string) => {
    void handoffSendRef.current(text);
  }, []);

  // A DIALOGUE stretch item IS a conversation — entering one skips the pad and
  // opens the chat immediately (mode "dialogue"; the composer + dictation are
  // the same machinery as the miss-handoff).
  useEffect(() => {
    if (phase !== "answering" || current?.answerType !== "dialogue" || !authToken) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Entering a dialogue item atomically initializes its chat before its stream begins.
    setHandoff({
      mode: "dialogue",
      dialogueItemId: current.itemId,
      messages: [{ role: "assistant", content: DIALOGUE_OPENER }],
      ended: false,
      loading: true,
      error: null,
    });
    setHandoffInput("");
    setDialogueVerdict(null);
    machine.send({ type: "lane:entered", lane: "dialogue" });
    void fetch(`${convexSiteUrl()}/practice-dialogue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ itemId: current.itemId, phase: "start" }),
    })
      .then(async (res) => {
        const data = (await res.json()) as { sessionToken?: string; error?: string };
        if (!res.ok || !data.sessionToken) {
          throw new Error(data.error ?? "Dialogue start failed");
        }
        setHandoff((state) =>
          state?.mode === "dialogue" && state.dialogueItemId === current.itemId
            ? {
                ...state,
                dialogueSessionToken: data.sessionToken,
                loading: false,
                error: null,
              }
            : state,
        );
      })
      .catch(() => {
        setHandoff((state) =>
          state?.mode === "dialogue" && state.dialogueItemId === current.itemId
            ? { ...state, loading: false, error: "Couldn't start this dialogue — try again." }
            : state,
        );
      });
  }, [phase, current, authToken, machine]);

  // "Check my thinking" — grade the dialogue transcript against the item's
  // server-only rubric. A pass logs a correct stretch entry (the Deep-water
  // wrap counts it) and writes the depth observation server-side; a non-pass
  // logs a miss-shaped entry and costs nothing (stretch rules).
  const onDialogueCheck = useCallback(async () => {
    if (!current || !handoff || handoff.loading || dialogueVerdict) return;
    if (
      !handoff.dialogueSessionToken ||
      handoff.dialogueItemId !== current.itemId
    ) {
      return;
    }
    if (!handoff.messages.some((m) => m.role === "user")) return;
    setHandoff({ ...handoff, loading: true, error: null });
    try {
      const res = await fetch(`${convexSiteUrl()}/practice-dialogue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
        },
        body: JSON.stringify({
          itemId: current.itemId,
          phase: "grade",
          sessionToken: handoff.dialogueSessionToken,
        }),
      });
      const data = (await res.json()) as {
        passed?: boolean;
        metCount?: number;
        total?: number;
        error?: string;
      };
      if (typeof data.passed === "boolean") {
        const verdict = {
          passed: data.passed,
          metCount: data.metCount ?? 0,
          total: data.total ?? 0,
        };
        setDialogueVerdict(verdict);
        // The log's SubmitResult shape wants scheduler fields a dialogue never
        // has (it doesn't touch mastery) — neutral placeholders; the wrap only
        // reads `correct` + `skillLabel`.
        setLog((l) => [
          ...l,
          {
            correct: verdict.passed,
            skillKey: current.skillKey,
            skillLabel: current.skillLabel,
            repetition: 0,
            proficiency: "practicing" as const,
          },
        ]);
        if (verdict.passed) setStretchCracked(true);
        setHandoff((h) => (h ? { ...h, loading: false, ended: true } : h));
      } else {
        setHandoff((h) =>
          h ? { ...h, loading: false, error: data.error ?? "The check hiccuped — try again." } : h,
        );
      }
    } catch {
      setHandoff((h) =>
        h ? { ...h, loading: false, error: "Couldn't reach the check — try again." } : h,
      );
    }
  }, [current, handoff, dialogueVerdict, authToken]);
  const {
    state: handoffDictationState,
    error: handoffDictationError,
    isTooLoud: handoffIsTooLoud,
    hasSpeech: handoffHasSpeech,
    toggleRecording: toggleHandoffRecording,
    stopRecording: stopHandoffRecording,
    cancelRecording: cancelHandoffRecording,
  } = useVoiceDictation(handleHandoffTranscript);

  // Keep the chat composer focused the whole time the handoff/explain chat is
  // open — on open, and again each time a tutor reply finishes (loading→false)
  // or the recording bar closes. `autoFocus` only fires on mount, so a reply
  // round-trip would otherwise leave the box unfocused; this refocuses so the
  // kid can keep typing without clicking back in.
  const handoffComposerRef = useRef<HTMLTextAreaElement>(null);
  const handoffComposerFocusable =
    !!handoff &&
    !handoff.ended &&
    handoffDictationState === "idle" &&
    !handoff.loading;
  useEffect(() => {
    if (!handoffComposerFocusable) return;
    const t = setTimeout(() => handoffComposerRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [handoffComposerFocusable]);

  // While a placement gate is showing, THIS component's practice session is
  // loaded but invisible (loadSession fires on mount, before the gate renders
  // <Placement>) — and both components attach window keydown handlers. Without
  // this suppression, a hardware-keyboard answer typed INTO PLACEMENT is also
  // fed to the hidden practice item and silently submitted: recordAttempt
  // creates a practiceMastery row, and the scholar's NEXT placement submit hits
  // the already-has-mastery guard, aborting the whole placement un-credited
  // (reproduced live, 2026-07-13). Mirrors the two render gates below exactly.
  const placementGateActive = Boolean(
    (checkInAllDomains && !scopedByProp && (needsAnyPlacement || wasCheckingIn) && !checkedIn) ||
      (!scopedByProp && !isMixed && !checkInAllDomains && !includeMapping && (needsPlacement || wasPlacing) && !placed),
  );

  const buildResumeSnapshot = useCallback(
    (
      resumeIdx: number,
    ): ResumeSnapshot<unknown, unknown, unknown> | null => {
    const isMainRun = !inChallenge && !inStretch && !inTuneup && !inBonusMore;
      const scopeKey = machine.state.run.scopeKey;
      const dayKey = machine.state.run.dayKey;
      if (
        !isMainRun ||
        !items ||
        items.length === 0 ||
        placementGateActive ||
        breaker ||
        machine.state.terminal ||
        resumeIdx <= 0 ||
        resumeIdx >= items.length ||
        !scopeKey ||
        !dayKey
      ) {
        return null;
      }
      return {
        inputKey: machine.state.run.inputKey ?? sessionInputKey,
        scopeKey,
        dayKey,
        items,
        segments,
        resumeIdx,
        launchpad,
        allMapping,
        mappingProgressOffset,
        mappedDomainLabel,
        savedAt: Date.now(),
      };
    },
    [
      allMapping,
      breaker,
      inBonusMore,
      inChallenge,
      inStretch,
      inTuneup,
      items,
      launchpad,
      machine.state.run.dayKey,
      machine.state.run.inputKey,
      machine.state.run.scopeKey,
      machine.state.terminal,
      mappedDomainLabel,
      mappingProgressOffset,
      placementGateActive,
      segments,
      sessionInputKey,
    ],
  );

  const installHintRung = useCallback(
    (
      raw: unknown,
      source: "ladder" | "breaker" | "breakerRestore",
    ) => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("rung" in raw) ||
        !("hasMore" in raw)
      ) {
        return;
      }
      const served = raw as {
        rung: HintLadderRung | null;
        hasMore: boolean;
      };
      if (!served.rung) return;
      if (source !== "ladder") {
        setHintRungs(
          served.rung.kind === "reveal"
            ? [{ rung: served.rung, revealedAfterWrong: false }]
            : [],
        );
        setActiveHintRung(
          served.rung.kind === "completion"
            ? { rung: served.rung, hasMore: served.hasMore }
            : null,
        );
        return;
      }
      if (served.rung.kind === "completion") {
        setActiveHintRung({
          rung: served.rung,
          hasMore: served.hasMore,
        });
      } else {
        setHintRungs((rungs) => [
          ...rungs,
          { rung: served.rung!, revealedAfterWrong: false },
        ]);
      }
    },
    [],
  );

  const installGrade = useCallback(
    (raw: unknown, entry: OutboxAnswer) => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { correct?: unknown }).correct !== "boolean"
      ) {
        throw new Error("Practice grader returned an invalid verdict");
      }
      const res = raw as SubmitResult;
      setResult(res);
      setComesBackText(
        res.turnedFluent && res.comesBackAt != null
          ? comesBackLine(formatComesBack(res.comesBackAt, Date.now()))
          : null,
      );
      setRevealPrediction(
        entry.record && entry.predictedConfidence
          ? confidenceValue(entry.predictedConfidence as ConfidenceLevel)
          : null,
      );
      if (entry.record) setLog((currentLog) => [...currentLog, res]);
      if (res.correct && current?.lane === "stretch") setStretchCracked(true);
      streakRef.current = nextStreak(streakRef.current, res.correct);
      if (res.correct && shouldPulseStreak(streakRef.current)) {
        setTimeout(() => haptic("success"), STREAK_PULSE_DELAY_MS);
      } else if (!res.correct && !res.dontKnow && entry.answer) {
        wrongAnswersRef.current = [...wrongAnswersRef.current, entry.answer];
      }
      if (res.dontKnow) {
        setRevealPrediction(null);
        setDontKnowStepReady(rehearse);
      }
    },
    [current?.lane, rehearse],
  );

  const gradeLocally = useCallback(
    async (entry: OutboxAnswer): Promise<SubmitResult> => {
      if (!rehearseGrader) {
        throw new Error("Rehearsal grader is unavailable");
      }
      const item = items?.find((candidate) => candidate.itemId === entry.itemId);
      if (!item) throw new Error("Rehearsal item is unavailable");
      const verdict = await rehearseGrader({
        itemId: item.itemId,
        domain: item.domain ?? domain,
        submission: entry.dontKnow
          ? { kind: "dontKnow" }
          : { kind: "typed", raw: entry.answer },
      });
      return {
        correct: verdict.correct,
        correctAnswer: verdict.correctAnswer,
        unitOutcome: verdict.unitOutcome,
        skillKey: item.skillKey,
        skillLabel: item.skillLabel,
        repetition: 0,
        proficiency: "not_started",
        accelerated: false,
        dontKnow: entry.dontKnow === true,
        turnedFluent: false,
      };
    },
    [domain, items, rehearseGrader],
  );

  useLayoutEffect(() => {
    machineHostRef.current = {
      scholarId,
      loadRun: loadSession,
      onLoadError: (error) => {
        console.error("practice run load failed:", error);
        setLoadError("That practice round couldn’t load. Try again.");
      },
      onBreakerItem: (item) => installBreakerItem(item as ServedItem),
      onHintRung: installHintRung,
      onHintError: setHintStepError,
      onSubmitError: setSubmitError,
      onGrade: installGrade,
      onCoach: () => installHandoff("spiral"),
      onHandoff: installHandoff,
      buildResumeSnapshot,
      onHaptic: (style) => haptic(style),
      onQueuedCount: setQueuedCount,
      onDispatchCompleted: (receipts) =>
        accumulateDispatchCompleted(
          receipts as DispatchCompletionReceiptData[] | undefined,
        ),
      gradeLocally,
    };
  }, [
    accumulateDispatchCompleted,
    buildResumeSnapshot,
    gradeLocally,
    installBreakerItem,
    installGrade,
    installHandoff,
    installHintRung,
    loadSession,
    scholarId,
  ]);

  useEffect(() => {
    if (placementGateActive) return;
    const handler = (e: KeyboardEvent) => {
      if (phase === "feedback") {
        // Enter advances only on a correct answer; a miss routes through the
        // Try again / Talk it through buttons, never a blind skip. A `· mapping`
        // item is reveal-only measurement, so Enter always advances it.
        if (e.key === "Enter" && (result?.correct || isMapping)) onNext();
        return;
      }
      if (phase === "queued") {
        if (e.key === "Enter") onNext();
        return;
      }
      if (phase !== "answering") return;
      // A flat (integer/decimal) answer is driven entirely by the hardware
      // keyboard via `useFlatAnswerKeyboard` below — nothing to do here.
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [placementGateActive, phase, onNext, result, isMapping]);

  // Flat (non-template) answers: the hardware keyboard is the number pad on web.
  useFlatAnswerKeyboard({
    enabled:
      !placementGateActive &&
      !usesTemplateEditor &&
      ((phase === "answering" && !hintRungActiveForCurrent) || implicitRetryAvailable),
    onKey: phase === "answering" ? onKey : onImplicitFlatRetryKey,
    onEnter: phase === "answering" ? () => void onSubmit() : undefined,
    allowUnit: !!answerUnit,
  });

  // 2-D (fraction/power/root) answers: the hardware keyboard builds the active box
  // via the SAME shared model the on-screen glyph keys use (session + placement).
  useExpressionTemplateKeyboard({
    enabled:
      !placementGateActive &&
      usesTemplateEditor &&
      ((phase === "answering" && !hintRungActiveForCurrent) || implicitRetryAvailable),
    onKey: phase === "answering" ? onTemplateKey : onImplicitTemplateRetryKey,
    onSubmit: phase === "answering" ? () => void onSubmit() : undefined,
    captureNavigation: phase === "answering",
  });

  const verdict = result ? classifyVerdict(result, missCount) : null;
  // The gentle per-item calibration reveal — non-null only when the recorded
  // prediction and the outcome disagreed (see mismatchReveal). Never on a
  // don't-know (that branch owns its own copy).
  const calibrationReveal =
    result && revealPrediction !== null && !result.dontKnow
      ? mismatchReveal(revealPrediction, result.correct)
      : null;
  // The completion arbiter (shared/completionOffers.ts) is the single owner of
  // "what does the done screen's offer stack show" — priority: an in-progress
  // continuation is never interrupted > the one-time story moment as primary
  // > re-probe/tune-up > stretch/challenge/more-of-your-pick. Both frontends
  // consume the SAME pure function so the ordering decision can't drift.
  const inContinuation = inTuneup || inChallenge || inStretch || inBonusMore;
  const reprobeEligible = !inTuneup && !!reprobe && reprobe.candidates.length > 0 && !reprobeResolved;
  const canOfferChallenge =
    challengeItems.length > 0 &&
    !inTuneup &&
    !inChallenge &&
    !inStretch &&
    !inBonusMore &&
    !reprobeEligible &&
    !tuneupOffer;
  // "Go deeper" — the depth sibling of the challenge card: insight problems on
  // nodes she already owns. Same quiet-round exclusions as the challenge offer,
  // EXCEPT a pending tune-up offer: a routine retention check shouldn't crowd
  // out the depth card (the chooser renders both side by side).
  const canOfferStretch =
    stretchItems.length > 0 &&
    !inTuneup &&
    !inChallenge &&
    !inStretch &&
    !inBonusMore &&
    !reprobeEligible;
  // "More of your pick" only makes sense when the session actually ran with a
  // choiceHint (the scholar picked a strand on the home card) — never for a
  // scoped problem set (choiceHint is ignored server-side there) or mid-tune-
  // up / mid-challenge / mid-bonus-round. A MIXED (auto-blend) session still
  // honors choiceHint for its matching domain, so it's eligible too.
  const canOfferBonusMorePick =
    !!choiceHintDomain &&
    !!choiceHintStrand &&
    !scopedByProp &&
    !inTuneup &&
    !inChallenge &&
    !inStretch &&
    !inBonusMore &&
    !reprobeEligible;
  // Also excludes inChallenge/inBonusMore (a latent gap the arbiter refactor
  // surfaced: without this, a tune-up offer could show on a CHALLENGE round's
  // own done screen — a continuation getting interrupted by a new offer).
  const canOfferTuneup =
    !!tuneupOffer && !inTuneup && !inChallenge && !inBonusMore && !reprobeEligible;

  const completionState = resolveCompletionOffers<unknown>({
    inContinuation,
    story: storySettled ? undefined : (storyMoment ?? undefined),
    reprobe: reprobeEligible ? reprobe!.candidates[0].strand : undefined,
    tuneup: canOfferTuneup ? true : undefined,
    stretch: canOfferStretch ? true : undefined,
    challenge: canOfferChallenge ? true : undefined,
    moreOfPick: canOfferBonusMorePick ? true : undefined,
  });
  const showStoryCard = completionState.primary?.kind === "story";
  const showReprobe = completionState.alternatives.some((a) => a.kind === "reprobe");
  const showStretch = completionState.alternatives.some((a) => a.kind === "stretch");
  const showChallenge = completionState.alternatives.some((a) => a.kind === "challenge");
  const showMoreOfPick = completionState.alternatives.some((a) => a.kind === "moreOfPick");
  const showTuneup = completionState.alternatives.some((a) => a.kind === "tuneup");

  // ── When is the story card actually on screen? ──────────────────────────
  // Hoisted from the done-screen block because the "Keep going?" card that
  // BELONGS to the story has to appear under exactly the same condition. The
  // arbiter can make the story the `primary` on a "Round complete" wrap where
  // the card itself is suppressed (showContinue owns the primary there) — so
  // gating the application card on `showStoryCard` alone orphaned it onto a
  // screen with no story above it, and "The math behind it" lost its referent
  // (caught on screen 2026-08-06). One predicate, two consumers.
  const wasMappingRun = allMapping || mappedDomainLabel !== null;
  const isCalibrationClose =
    firstPostPlacementBlock && !inTuneup && !inChallenge && !inStretch;
  const plainPlaylistWrap =
    !inTuneup && !inBonusMore && !wasMappingRun && !inChallenge && !inStretch &&
    !isCalibrationClose && !stretchHint && !scopedByProp && !isRemote;
  // While the reactive doneness query is still resolving (rare — it's
  // subscribed from mount), default to the honest stopping point (Done
  // primary): never flash a Continue toward more work we can't yet confirm.
  const playlistDonenessResolved = playlistDoneness !== undefined;
  const playlistDonenessVerdict = playlistDonenessResolved
    ? derivePlaylistDoneness(playlistDoneness!)
    : null;
  const playlistCaughtUp =
    !plainPlaylistWrap ||
    !playlistDonenessVerdict ||
    // A scope-blocked playlist is an honest stopping point for the CLOSE (there
    // genuinely is nothing more to serve), even though it is not a completion.
    playlistDonenessVerdict.blocked ||
    playlistDonenessVerdict.caughtUp;
  // NOTE the asymmetry with `playlistCaughtUp`: the loading window counts as
  // caught-up for the CLOSE (so we never flash a Continue) but NOT as complete
  // for the story card (so we never flash the payoff early). `storyCardVisible`
  // must track the card's own gate exactly, or its application card orphans.
  // Blocked is the mirror asymmetry: a boundary stops the run without earning
  // the payoff, so it never reads as complete.
  const playlistComplete =
    plainPlaylistWrap && !!playlistDonenessVerdict && playlistDonenessVerdict.caughtUp;
  // P4 ("primary means alone"): when the story announcement is actually on the
  // done screen (the arbiter's story primary AND the playlist-complete gate),
  // it is the ONLY offer — the reprobe offer and the "Keep going?" chooser are
  // suppressed (their eligibility persists to the next story-less close), and
  // the close is Done (showContinue is already false once playlistComplete).
  // Keyed on the card's real visibility, not `phase === "offer"` alone, so a
  // round-complete wrap that has a pending story but hides the card still shows
  // its ordinary Continue + chooser.
  const storyCardVisible = showStoryCard && !!storyMoment && playlistComplete;
  // The story's linked application is DELIBERATELY NOT offered here. The story
  // is a gift earned by this run; a graded task sitting under it reframes the
  // wonder as bait for more work (the overjustification polarity flips when the
  // intrinsic object is the STORY — see review/done-screen-options.html §F2).
  // The problem meets the scholar on the RE-ENCOUNTER instead: application
  // items are ordinary tier:"stretch" rows, so `stretchTailForScholar` already
  // serves them in the Go-deeper tail with their story hook attached, when the
  // kid is choosing freely rather than being handed a task at their most
  // depleted moment.
  // The unified "Keep going?" chooser (§C-3) — up to three tappable bonus
  // cards, each card IS the accept action. Stretch and challenge share the first
  // tail slot; the arbiter guarantees that only one sibling occupies it.
  const bonusCards: BonusCardSpec[] = [
    ...(showStretch
      ? [
          {
            key: "stretch",
            title: "Go deeper?",
            body:
              (stretchItems.length === 1 ? "A puzzle" : "A couple of puzzles") +
              " on skills you already own. These are meant to be hard — lots of people miss them the first try.",
            onAccept: onAcceptStretch,
            acceptLabel: "Try it",
            tone: { bg: "#f4f5fc", border: "#b9c0ea", text: "#3d478f" },
          },
        ]
      : []),
    ...(showChallenge
      ? [
          {
            key: "challenge",
            title: CHALLENGE_OFFER_TITLE,
            body: challengeOfferBody(challengeItems.length),
            onAccept: onAcceptChallenge,
            acceptLabel: CHALLENGE_OFFER_ACCEPT,
            tone: { bg: "#fbf4dd", border: "#e3c766", text: "#7a5f1c" },
          },
        ]
      : []),
    ...(showMoreOfPick
      ? [
          {
            key: "bonus-more-of-pick",
            title: `More ${strandHeadlineFor(choiceHintDomain!, choiceHintStrand!)}?`,
            // When this run mapped the SAME domain the pick belongs to, name the
            // strand↔domain relationship so "More Area & Perimeter?" doesn't read
            // as a different thing from the "You mapped Geometry & measurement"
            // ceremony just above it — Area & Perimeter is a strand OF that
            // domain. Otherwise keep the plain copy.
            body:
              choiceHintDomain &&
              mappedDomainLabel &&
              practiceDomainLabel(choiceHintDomain) === mappedDomainLabel
                ? `A few more on ${strandHeadlineFor(choiceHintDomain!, choiceHintStrand!)} — part of the ${mappedDomainLabel} you just mapped.`
                : "A few more on the topic you picked.",
            onAccept: () => void onAcceptBonusMorePick(),
            acceptLabel: "Let's go",
            disabled: bonusMoreLoading,
            tone: { bg: "#faf6fb", border: "#dbbbe3", text: "#61376c" },
          },
        ]
      : []),
    ...(showTuneup
      ? [
          {
            key: "tuneup",
            title: "Quick tune-up?",
            body: `${tuneupOffer!.count} quick ones from things you've already learned — keeps your map fresh.`,
            onAccept: () => void onAcceptTuneup(),
            acceptLabel: "Let's go",
            tone: { bg: "#eef6f0", border: "#bcdfc7", text: "#2f6b46" },
          },
        ]
      : []),
  ];

  // MIXED multi-domain check-in gate (the default no-pin entry) — takes priority
  // over the single-domain placement + the playlist. Same latch pattern as below.
  if (checkInAllDomains && !scopedByProp && (needsAnyPlacement || wasCheckingIn) && !checkedIn) {
    return (
      <Placement
        scholarId={scholarId}
        multiDomain
        homeHref={isRemote ? null : "/scholar"}
        onDone={() => {
          setCheckedIn(true);
          machine.send({ type: "run:reloadRequested" });
        }}
      />
    );
  }
  if (checkInAllDomains && !scopedByProp && needsAnyPlacement === undefined) {
    return <Centered><Text color="#65706a">Loading…</Text></Centered>;
  }

  // Placement gate: a brand-new scholar takes the placement quiz first. A
  // prop-scoped session (problem-set activity) skips the `needsPlacement` query
  // entirely, so it must bypass this gate too — otherwise `undefined` strands it
  // on "Loading…" forever.
  //
  // Order matters: the `wasPlacing` latch is checked BEFORE the
  // `needsPlacement === undefined` loading branch. Once placement is underway, a
  // transient `undefined` (a query re-subscribe) must NOT fall through to Loading
  // and unmount <Placement> mid-flow — that reset it back to the intro over a
  // completed placement. `placed` (set only from the result screen's button) is
  // the sole way out.
  if (!scopedByProp && !isMixed && !checkInAllDomains && !includeMapping && (needsPlacement || wasPlacing) && !placed) {
    return (
      <Placement
        scholarId={scholarId}
        domain={placementDomain}
        homeHref={isRemote ? null : "/scholar"}
        onDone={() => {
          setPlaced(true);
          machine.send({ type: "run:reloadRequested" });
        }}
      />
    );
  }
  if (!scopedByProp && !isMixed && !checkInAllDomains && !includeMapping && needsPlacement === undefined) {
    return <Centered><Text color="#65706a">Loading…</Text></Centered>;
  }

  if (loadError && items === null && !breaker) {
    return (
      <Centered>
        <VStack gap={3}>
          <Text color="#65706a">{loadError}</Text>
          <Button
            colorPalette="teal"
            onClick={() =>
              sendPracticeEvent({ type: "run:reloadRequested" })
            }
          >
            Try again
          </Button>
        </VStack>
      </Centered>
    );
  }

  if (items === null && !breaker) {
    return <Centered><Text color="#65706a">Loading your practice…</Text></Centered>;
  }
  if (items?.length === 0 && !breaker) {
    // The plan boundary comes FIRST: a blocked run is empty for a reason that
    // has nothing to do with the scholar's progress, so neither the summit read
    // nor "you're caught up" is true. Name the boundary and its horizon —
    // never a verdict about the kid.
    if (scopeBlocked) {
      return (
        <Centered>
          <VStack gap={3}>
            <Heading size="md">{PRACTICE_SCOPE_BLOCKED_HEADLINE}</Heading>
            <Text color="#65706a" textAlign="center" maxW="380px">
              {PRACTICE_SCOPE_BLOCKED_DETAIL}
            </Text>
          </VStack>
        </Centered>
      );
    }
    // Empty queue = either a true summit (whole domain fluent) or merely caught
    // up (unlocked frontier cleared, locked skills remain). SummitHandoff reads
    // the scholar's per-domain progress and picks the right tone + a switcher.
    // A problem-set-scoped run has no whole-domain notion, so keep it simple.
    if (scopedByProp) {
      return (
        <Centered>
          <VStack gap={3}>
            <Heading size="md">Nothing to practice right now 🎉</Heading>
            <Text color="#65706a" textAlign="center" maxW="380px">
              You&apos;re caught up on this set.
            </Text>
          </VStack>
        </Centered>
      );
    }
    return (
      <Centered>
        <VStack gap={4} w="100%" maxW="440px">
          <SummitHandoff scholarId={scholarId} domain={domain} domains={domains} />
          <BonusChooser cards={bonusCards} />
        </VStack>
      </Centered>
    );
  }

  // The three-miss repair card. It replaces a binary ask with work already in
  // progress: one step-card rung is pushed onto the item that broke, the coach
  // is an escalation beside it, and the one quiet exit stays visible.
  if (phase === "breakerRepair" && breaker) {
    const freshAvailable = breaker.recoveryAvailable;
    const controls = breakerControls(breaker.flow, freshAvailable);
    const body = breakerBody(breaker.flow, freshAvailable);
    return (
      <Centered>
        <Box
          w="100%"
          maxW="460px"
          bg="#fffdfa"
          border="1px solid #ded8cb"
          borderRadius="18px"
          p={{ base: 5, md: 6 }}
        >
          <VStack align="stretch" gap={5}>
            {body ? (
              <Text fontSize={{ base: "lg", md: "xl" }} lineHeight="1.55" color="#29332d">
                {body}
              </Text>
            ) : null}
            {breaker.flow.repair === "opening" ? (
              <Text fontSize="14px" color="#65706a">
                Finding it…
              </Text>
            ) : null}
            {breaker.flow.repair === "open" || breaker.flow.repair === "done" ? (
              <HintLadderSteps
                key={`breaker:${breaker.triggerItemId}:${
                  activeHintRung?.rung.stepIndex ?? `done-${hintRungs.length}`
                }`}
                completed={hintRungs}
                active={activeHintRung?.rung ?? null}
                onAttempt={() =>
                  machine.send({ type: "ui:breakerRepairStarted" })
                }
                onComplete={(revealedAfterWrong) => {
                  onHintStepComplete(revealedAfterWrong);
                  finishBreakerRepairStep();
                }}
              />
            ) : null}
            {hintStepError ? (
              <Text fontSize="13px" color="#9b1c1c">
                {hintStepError}
              </Text>
            ) : null}
            {breakerLifecycleRecoveryNeeded ? (
              <VStack align="stretch" gap={2}>
                <Text fontSize="14px" color="#65706a">
                  That step couldn&apos;t be saved yet. Your work is still here.
                </Text>
                <Button
                  alignSelf="start"
                  variant="outline"
                  onClick={() =>
                    machine.send({ type: "ui:retryBreakerLifecycle" })
                  }
                >
                  Try again
                </Button>
              </VStack>
            ) : null}
            <Flex direction={{ base: "column", md: "row" }} gap={3}>
              {controls.primary && controls.primary !== "checkStep" ? (
                <Button
                  flex="1"
                  variant={controls.primary === "easyFinish" ? "ghost" : "solid"}
                  colorPalette={controls.primary === "easyFinish" ? undefined : "teal"}
                  color={controls.primary === "easyFinish" ? "#5a655d" : undefined}
                  size="lg"
                  minH="48px"
                  onClick={() => onBreakerControl(controls.primary!)}
                  disabled={busy}
                >
                  {breakerControlLabel(controls.primary)}
                </Button>
              ) : null}
              {controls.peers.map((peer) => (
                <Button
                  key={peer}
                  flex="1"
                  variant={peer === "easyFinish" ? "ghost" : "outline"}
                  size="lg"
                  minH="48px"
                  color="#5a655d"
                  borderColor={peer === "easyFinish" ? undefined : "#9aa69e"}
                  onClick={() => onBreakerControl(peer)}
                  disabled={busy}
                >
                  {breakerControlLabel(peer)}
                </Button>
              ))}
            </Flex>
          </VStack>
        </Box>
      </Centered>
    );
  }

  if (phase === "breakerClose" && breaker) {
    const controls = breakerControls(breaker.flow);
    // Recognition requires the server's linked fresh-result verdict; matching
    // client state alone can never produce this close.
    const recovered = RECOVERY_CLOSURE_ENABLED && breakerRecovered(breaker.flow);
    const recoverySignal: PracticeSignal = {
      wrap: "session",
      skills: [],
      effortShape: "hardSet",
      challengeMoved: false,
      frontierSkills: [],
      recovery: "sameNodeUnassisted",
    };
    return (
      <Centered>
        <VStack gap={5} w="100%" maxW="440px">
          {recovered ? (
            <>
              <RecoveryArc />
              <PracticeDoneHeadline
                scholarId={scholarId}
                signal={recoverySignal}
                fallback={
                  buildPracticeClosure({
                    wrap: "session",
                    skills: [],
                    correctCount: 0,
                    total: 0,
                    challengeMoved: false,
                    frontierSkills: [],
                    recovery: "sameNodeUnassisted",
                    recoveryVerified: true,
                  }).headline
                }
                enabled={closureGenerationEnabled(isRemote, rehearse)}
              />
            </>
          ) : (
            <Text
              fontSize={{ base: "xl", md: "2xl" }}
              lineHeight="1.5"
              textAlign="center"
              color="#29332d"
            >
              {breakerCloseLine(breaker.flow)}
            </Text>
          )}
          {hintStepError ? (
            <Text fontSize="13px" color="#9b1c1c" textAlign="center">
              {hintStepError}
            </Text>
          ) : null}
          {/* After a missed fresh item the one remaining move is the quiet easy
              finish — never another hard problem or a duplicate stop action. */}
          {controls.primary === "easyFinish" ? (
            <VStack w="100%" gap={2}>
              <Button
                w="100%"
                minH="48px"
                variant="ghost"
                size="lg"
                color="#5a655d"
                onClick={() => onBreakerControl("easyFinish")}
                disabled={busy}
              >
                {breakerControlLabel("easyFinish")}
              </Button>
              <Button asChild w="100%" variant="ghost" size="lg">
                <Link href="/scholar">Done</Link>
              </Button>
            </VStack>
          ) : (
            <Button asChild w="100%" colorPalette="teal" size="lg">
              <Link href="/scholar">Done</Link>
            </Button>
          )}
        </VStack>
      </Centered>
    );
  }

  if (
    !items &&
    breaker?.flow.stage === "easy" &&
    breaker.flow.easy === "requested"
  ) {
    return (
      <Centered>
        <VStack gap={4} w="100%" maxW="440px" textAlign="center">
          <Text color={hintStepError ? "#9b1c1c" : "#65706a"}>
            {hintStepError ?? "Loading your easy finish…"}
          </Text>
          <Button
            w="100%"
            minH="48px"
            variant="ghost"
            size="lg"
            color="#5a655d"
            onClick={() => onBreakerControl("easyFinish")}
            disabled={busy}
          >
            {breakerControlLabel("easyFinish")}
          </Button>
          <Button asChild w="100%" variant="ghost" size="lg">
            <Link href="/scholar">Done</Link>
          </Button>
        </VStack>
      </Centered>
    );
  }

  if (!items) {
    return <Centered><Text color="#65706a">Loading your practice…</Text></Centered>;
  }

  if (phase === "retry") {
    // "Confirm before you cap": a first typed miss offers a two-way choice —
    // treat it as a slip and answer a fresh item on the same skill, or honestly
    // concede (which caps immediately, the fast path). No answer is revealed
    // here: a slip's confirm must stay a fair re-measurement. Presentation
    // matches Placement.tsx exactly (scholar-facing parity is a standing rule).
    return (
      <Centered>
        <VStack gap={5} maxW="440px" textAlign="center">
          <Text fontSize="40px">🤔</Text>
          <Heading size="lg">{PLACEMENT_SLIP_PROMPT}</Heading>
          <VStack gap={3} w="100%">
            <Button colorPalette="teal" size="lg" w="100%" onClick={onSlipRetry}>
              {PLACEMENT_SLIP_RETRY_LABEL}
            </Button>
            <Button variant="outline" size="lg" w="100%" onClick={onSlipConcede}>
              {PLACEMENT_SLIP_CONCEDE_LABEL}
            </Button>
          </VStack>
        </VStack>
      </Centered>
    );
  }

  if (phase === "done") {
    const { correctCount, total, skills } = summarize(log);
    // Option D: this run was a `· mapping` sit iff the whole served set was
    // all-mapping OR a domain finished placing this run (native's truthful
    // predicate — F5). A normal mixed playlist that merely CONTAINED a mapping
    // probe that didn't converge a domain must NOT claim a map/Tree milestone.
    // On an above-band challenge wrap, decide whether her frontier actually moved
    // — cleared even WITH honest "I haven't learned this yet" flags (see
    // challengeFrontierMove). When it did, the reveal (naming the skills she
    // tested into) IS the payoff, so we lead with it instead of a raw score and
    // suppress the redundant "You practiced" list. Suppressed during teacher
    // rehearsal (?remote=), matching the well-calibrated line — it's kid-facing.
    const frontierMove = challengeFrontierMove(log);
    const showFrontierReveal = inChallenge && !isRemote && frontierMove.moved;
    // The reimagined closure headline (review/practice/completion-messaging-plan.html):
    // a growth-framed line that names the thinking, replacing the flat "Session
    // complete" / stock subtitles. `<PracticeDoneHeadline>` renders the governed
    // LLM-generated line when it has arrived (cached, per-scholar) and ALWAYS
    // falls back to the deterministic builder — so the screen never blocks. Only
    // the scholar's own live view generates (never a teacher's remote rehearsal).
    const closureWrap: PracticeWrap = inTuneup
      ? "tuneup"
      : inChallenge
        ? "challenge"
        : isCalibrationClose
          ? "calibration"
          : "session";
    const closure = buildPracticeClosure({
      wrap: closureWrap,
      skills,
      correctCount,
      total,
      challengeMoved: frontierMove.moved,
      frontierSkills: frontierMove.skills,
    });
    const closureSignal: PracticeSignal = {
      wrap: closureWrap,
      skills,
      effortShape: effortShape(correctCount, total),
      challengeMoved: frontierMove.moved,
      frontierSkills: frontierMove.skills,
    };
    // `plainPlaylistWrap` / `playlistCaughtUp` are computed once ABOVE (the
    // story card and its "Keep going?" application card must share one
    // predicate) — the plain daily-playlist wrap is the ONLY arm whose close is
    // state-aware. Tune-up / bonus-more / mapping / challenge / stretch /
    // calibration, a scoped activity-embedded run, the Stretch-TILE entry, and
    // teacher rehearsal all keep the legacy "Session complete" close.
    const showContinue = plainPlaylistWrap && !playlistCaughtUp;
    // The story/quest card is the payoff for FINISHING the daily playlist, so
    // it only appears on a plain playlist wrap once we can CONFIRM the set is
    // caught up — never on a tune-up / challenge / bonus-more / mapping /
    // stretch / calibration / scoped / remote wrap (those aren't a daily-set
    // completion), and never during the doneness-loading window. Suppressing it
    // (rather than firing it mid-playlist) BURNS NOTHING: the card only mints
    // the seed + starts the 20h cooldown when it actually mounts, so the moment
    // stays eligible and waits for the true playlist-complete wrap. Gating here
    // also removes the two-competing-primaries screen — when the playlist isn't
    // caught up, `showContinue` owns the primary and the card is hidden.
    const doneHeadline = (
      <PracticeDoneHeadline
        scholarId={scholarId}
        signal={closureSignal}
        fallback={closure.headline}
        // Rehearsal must not mint a closure line: `ensureClosureLine` records AI
        // usage and upserts `closureLines` under the (staff) scholarId. Disabled
        // here so rehearsal uses ONLY the deterministic `fallback` headline.
        enabled={closureGenerationEnabled(isRemote, rehearse)}
      />
    );
    return (
      <Centered>
        {/* Quiet corner back-to-Home affordance, held through the done summary
            too (the summary is vertically centered, so this is anchored to the
            top-left corner rather than in flow). Mirrors the drill's chevron;
            skipped for a teacher remote-rehearsal. */}
        {!isRemote && (
          <Box position="absolute" top={{ base: 3, md: 5 }} left={{ base: 2, md: 4 }}>
            <BackToHomeButton />
          </Box>
        )}
        <VStack gap={4} maxW="440px">
          {/* A tune-up is a low-stakes retention check — no score for the kid
              (the offer promises "no score/timer/streak"). A cleared challenge
              leads with the frontier reveal. Every other wrap shows ONLY the
              growth headline — the raw correctness count is never shown to the
              scholar (pilot9 J4 ruling A: a portrait, not a scorecard). */}
          {inTuneup ? (
            <>
              <ClosureEyebrow>Tune-up done</ClosureEyebrow>
              {doneHeadline}
            </>
          ) : wasMappingRun ? (
            /* Option D done-screen beat (Q1 cold-start completion + Q5 domain-
               mapped moment). Growth-framed, no score, no "no X, just Y"
               phrasing — the Tree lighting IS the celebration. */
            <>
              <ClosureEyebrow>{mappedDomainLabel ? "A domain mapped" : "Math Check-In"}</ClosureEyebrow>
              {mappedDomainLabel ? (
                <>
                  <Heading size="lg" textAlign="center">
                    You mapped {mappedDomainLabel} ✨
                  </Heading>
                  <Text fontSize="md" color="#65706a" textAlign="center">
                    Your tree just filled in ✨ — we can see where you&apos;re ready to grow.
                  </Text>
                </>
              ) : (
                <>
                  <Heading size="lg" textAlign="center">Your map is started ✨</Heading>
                  <Text fontSize="md" color="#65706a" textAlign="center">
                    Nice mapping today. Your daily playlist picks up right where you&apos;re
                    ready to grow.
                  </Text>
                </>
              )}
              {/* Tree lights: the Knowledge Tree lit its newly-credited prefix.
                  A quiet, honest pointer to the map — never a score/streak. */}
              <HStack
                gap={2}
                bg="#eef6f0"
                border="1px solid #bcdfc7"
                borderRadius="10px"
                px={3}
                py={2}
                color="#2f6b46"
              >
                <Text fontSize="14px">🌳 Your Skills Tree lit up a new branch.</Text>
              </HStack>
            </>
          ) : inChallenge ? (
            <>
              <ClosureEyebrow>Challenge done</ClosureEyebrow>
              {showFrontierReveal ? (
                <FrontierMovedReveal skills={frontierMove.skills} />
              ) : (
                doneHeadline
              )}
            </>
          ) : inStretch ? (
            <>
              <ClosureEyebrow>Deep water</ClosureEyebrow>
              {correctCount > 0 ? (
                <>
                  <Heading size="lg" textAlign="center">
                    You went deeper on {skills.length === 1 ? "a skill you own" : "skills you own"}.
                  </Heading>
                  <Text fontSize="md" color="#65706a" textAlign="center">
                    Problems like these take an idea, not just a method — and you found{" "}
                    {correctCount === total
                      ? total === 1
                        ? "it"
                        : "every one"
                      : `${correctCount} of ${total}`}
                    . Misses here never touch your map.
                  </Text>
                </>
              ) : stretchCracked ? (
                <>
                  <Heading size="lg" textAlign="center">You stuck with it — and cracked it.</Heading>
                  <Text fontSize="md" color="#65706a" textAlign="center">
                    Missing a problem like this on the first try is normal — coming back and
                    finding the idea anyway is exactly what these are for. That went on your
                    depth record.
                  </Text>
                </>
              ) : (
                <>
                  <Heading size="lg" textAlign="center">Those were meant to be hard.</Heading>
                  <Text fontSize="md" color="#65706a" textAlign="center">
                    Wrestling with a problem like that IS the work — most people miss them the
                    first time, and nothing on your map went down. They&apos;ll be here when you
                    want another go.
                  </Text>
                </>
              )}
            </>
          ) : isCalibrationClose ? (
            <>
              <Heading size="lg">We found your edge</Heading>
              <Text fontSize="md" color="#65706a" textAlign="center">
                This first set helped Rabbithole calibrate where to build next. We&apos;ll
                practice from this edge, not from a score.
              </Text>
            </>
          ) : (
            <>
              <ClosureEyebrow>
                {plainPlaylistWrap ? playlistCompleteEyebrow(playlistCaughtUp) : "Session complete"}
              </ClosureEyebrow>
              {doneHeadline}
            </>
          )}
          {/* The "You practiced" roll-up lists every skill she touched. On a
              CLEARED challenge wrap the reveal already names the ones she tested
              into, so this would just repeat them — suppress it there. */}
          {!showFrontierReveal && !wasMappingRun && (
            <Box w="100%" bg="#fffdfa" border="1px solid #ded8cb" borderRadius="14px" p={4}>
              <Text fontSize="13px" color="#65706a" mb={2} textTransform="uppercase" letterSpacing="0.04em">
                You practiced
              </Text>
              {/* A real <ul>: the marker sits OUTSIDE the text column, so a
                  skill long enough to wrap keeps a hanging indent instead of
                  running back under its own bullet. */}
              <Box
                as="ul"
                m={0}
                ps="1.15em"
                listStyleType="disc"
                listStylePosition="outside"
                css={{ "& > li::marker": { color: "#a3aca5" } }}
              >
                {skills.map((s) => (
                  <Box as="li" key={s} fontSize="15px" lineHeight="1.45" mt={1} _first={{ mt: 0 }}>
                    {superscriptExponents(s)}
                  </Box>
                ))}
              </Box>
              {!storyCardVisible && (
                <DispatchCompletionReceipt
                  receipts={dispatchCompleted}
                  kind="math"
                />
              )}
            </Box>
          )}
          {/* Predict-then-Check: the ONLY calibration line a well-calibrated kid
              sees — soft, non-numeric, and only once there's enough signal
              (band requires n ≥ 8). Never a score. */}
          {!inTuneup && !isRemote && calibration?.band === "well_calibrated" && (
            <HStack
              w="100%"
              gap={2}
              bg="#eef6f0"
              border="1px solid #bcdfc7"
              borderRadius="10px"
              px={3}
              py={2}
              color="#2f6b46"
            >
              <Text fontSize="14px">{WELL_CALIBRATED_LINE}</Text>
            </HStack>
          )}
          {/* Moments: the story reveal card — an invitation, never a reward
              pellet. Placed above the reprobe/bonus offers so it reads as
              its own distinct, rare moment. Keyed by the edge identity so a
              genuinely different moment (a later session, past the 20h
              cooldown) remounts fresh instead of inheriting stale state.
              Rendered as the completion arbiter's PRIMARY offer — never
              alongside an in-progress continuation (shared/completionOffers.ts). */}
          {showStoryCard && storyMoment && playlistComplete && (
            <StoryMomentCard
              key={`${storyMoment.fromKey}-${storyMoment.toKey}`}
              scholarId={scholarId}
              moment={storyMoment}
              settleRef={storyCardSettleRef}
            />
          )}
          {storyCardVisible && (
            <DispatchCompletionReceipt
              receipts={dispatchCompleted}
              kind="math"
            />
          )}
          {!storyCardVisible && (showFrontierReveal || wasMappingRun) && (
            <DispatchCompletionReceipt
              receipts={dispatchCompleted}
              kind="math"
            />
          )}
          {/* Strand re-probe offer — "you're on a roll, jump ahead?" (§4). An
              EARNED offer (the engine detected a likely under-placement), not a
              bonus the scholar opts into for its own sake — keeps its own
              distinct slot ABOVE the "Keep going?" chooser. Only when the
              completion arbiter ranks it eligible (never mid-continuation). */}
          {showReprobe && reprobe && !storyCardVisible && (
            <ReprobeOffer
              scholarId={scholarId}
              strand={reprobe.candidates[0].strand}
              domain={domain}
              onResolved={() => setReprobeResolved(true)}
            />
          )}
          {/* The unified "Keep going?" bonus chooser (§C-3) — up to three
              tappable bonus cards (challenge / more-of-your-pick / tune-up).
              Skipping it is always fine; the calm summary above + Done /
              Practice again below are the default path regardless. Suppressed
              under a live story primary (P4) — the story stands alone. */}
          {!storyCardVisible && <BonusChooser cards={bonusCards} />}
          {queuedCount > 0 && (
            <HStack
              w="100%"
              gap={2}
              bg="#fbf4dd"
              border="1px solid #e3c766"
              borderRadius="10px"
              p={3}
              color="#7a5f1c"
            >
              <WifiSlash weight="bold" />
              <Text fontSize="13px">
                {queuedCount} answer{queuedCount === 1 ? "" : "s"} saved while offline — we&apos;ll check{" "}
                {queuedCount === 1 ? "it" : "them"} for real as soon as you&apos;re back online.
              </Text>
            </HStack>
          )}
          {/* The closing CTAs are the screen's committed actions, so they span
              the same column width as the "You practiced" card above them
              instead of floating as narrow pills. */}
          {showContinue ? (
            <>
              {/* The playlist still has skills queued — the primary action stays
                  IN practice (a fresh run in the same scope), and Done is
                  demoted so leaving is a deliberate opt-out, not the default
                  eject. */}
              <Button w="100%" colorPalette="teal" size="lg" onClick={restartPractice}>
                Continue <ArrowRight />
              </Button>
              <Button asChild w="100%" variant="ghost" size="sm" color="#65706a">
                <Link href="/scholar">Done</Link>
              </Button>
            </>
          ) : storyCardVisible ? (
            /* A story reveal is on screen: the reveal is the loud thing, so
               Done goes QUIET — a plain ghost text control, not the full-width
               teal bar. This is the single-CTA hierarchy from the redesign
               (direction B): the celebratory card outranks the quiet exit, and
               there is exactly one teal accent on the screen, on the reward. */
            <Button asChild w="100%" variant="ghost" size="sm" color="#65706a">
              <Link href="/scholar">Done</Link>
            </Button>
          ) : (
            /* Caught up: ONE exit. There is deliberately no "Practice again"
               here — a standing "do it all again" on a set the engine has
               CONFIRMED finished is an engagement-maximizing offer, and the
               practice engine's objective function is retention, never
               time-on-task (rabbithole-practice-engine.md). Spaced repetition
               is explicit that more-today is not better. A scholar who wants
               more has the EARNED routes: the "Keep going?" chooser above when
               the engine has something to offer, or a fresh session tomorrow.
               The `showContinue` arm above still leads with Continue, because
               there the engine genuinely does have queued work. */
            <Button asChild w="100%" colorPalette="teal" size="lg">
              <Link href="/scholar">Done</Link>
            </Button>
          )}
        </VStack>
      </Centered>
    );
  }

  const pretestProgress = allMapping
    ? mappingPretestProgress(mappingProgressOffset + idx)
    : null;
  const progress =
    pretestProgress?.fraction ??
    progressFraction(idx, items.length, phase === "feedback");

  // ── §9 no-shift feedback ────────────────────────────────────────────────────
  // Correctness is an OVERLAY (a corner stamp + a card/field tint), never an
  // inline box that grows the column and jumps the centered card. The active
  // card is vertically centered while you answer, the answer stays visible in a
  // read-only field, and the CTA lives in its own lane pinned to the bottom that
  // only relabels. The handoff phase keeps the shipped bottom-anchored "chat
  // rises and pushes the problem up" choreography.
  const isHandoffPhase = phase === "handoff";
  const fbCorrect = phase === "feedback" && !!result && !result.dontKnow && result.correct;
  const fbMiss = phase === "feedback" && !!result && !result.dontKnow && !result.correct;
  const nextLabel = isLastItem(idx, items.length) ? "Finish" : "Next";
  const isDialogueChat = handoff?.mode === "dialogue";
  const dialogueHasIdea = !!handoff?.messages.some((m) => m.role === "user");
  const handoffLastMessageIndex = (handoff?.messages.length ?? 0) - 1;
  const showHandoffComposer =
    !!handoff && (isDialogueChat ? !dialogueVerdict : !handoff.ended);
  const handoffCanSend = !!handoffInput.trim() || !!chatImage.pendingImage;
  const isTypedItem =
    !!current &&
    current.answerType !== MANIPULATIVE_ANSWER_TYPE &&
    !isMultipleChoiceItem(current.answerType, current.choices?.length);
  const isMcItem =
    !!current && isMultipleChoiceItem(current.answerType, current.choices?.length);
  // A manipulative item (a tappable board, not a typed answer). It's excluded
  // from `isTypedItem` (no number pad / typed field), but it DOES get the same
  // first-look "I haven't learned this yet" affordance typed items have (U-4).
  const isManipulativeItem = !!current && current.answerType === MANIPULATIVE_ANSWER_TYPE;
  // The stem card hides only while a manipulative is being worked (it shows its
  // own prompt); always shown in feedback so the verdict has context.
  const cardVisible = !(phase === "answering" && current?.answerType === MANIPULATIVE_ANSWER_TYPE);
  // The answer field carries the submitted number into feedback (read-only,
  // tinted) so nothing disappears; hidden on an honest don't-know (no answer).
  const showAnswerField =
    isTypedItem && (phase === "answering" || (phase === "feedback" && !result?.dontKnow));

  // The stem card + corner-stamp overlay (shared by answering + feedback) — the
  // shared VerdictStemCard also drives placement's probe card (#unify).
  const stemCard = (
    <VerdictStemCard
      stem={current?.stem ?? ""}
      promptVisual={current?.promptVisual}
      tone={fbCorrect ? "correct" : fbMiss ? "miss" : null}
      speakable={currentIsKinder}
      big={!!current?.isFactSprint}
    />
  );
  const stemCardEl = cardVisible ? (
    current?.storyHook ? (
      <VStack w="100%" gap={2} align="stretch">
        <Text fontSize="14px" lineHeight="1.5" color="#5a655d" textAlign="center">
          {current.storyHook}
        </Text>
        {stemCard}
      </VStack>
    ) : (
      stemCard
    )
  ) : null;

  // The answer field — live while answering, verdict-tinted in feedback. On a
  // first miss, tapping it starts a retry; the mic keeps its space so width stays
  // stable.
  const answerFieldEl = showAnswerField ? (
    <HStack w="100%" gap={2} align="center">
      <Box
        flex="1"
        borderWidth="2px"
        borderStyle="solid"
        borderColor={fbCorrect ? "#8fe3bf" : fbMiss ? "#f2c98a" : "#16707e"}
        borderRadius="12px"
        bg={fbCorrect ? "#eafaf2" : fbMiss ? "#fff6ea" : "#f3fbfc"}
        px={4}
        py={3}
        textAlign="center"
        fontSize="26px"
        fontWeight="700"
        color={fbCorrect ? "#00875a" : "#143"}
        minH="56px"
        userSelect="none"
        style={{ WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
        transition="border-color 0.3s, background 0.3s, color 0.3s"
        cursor={implicitRetryAvailable ? "text" : undefined}
        onClick={implicitRetryAvailable ? beginImplicitRetry : undefined}
        onKeyDown={
          implicitRetryAvailable
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                beginImplicitRetry();
              }
            : undefined
        }
        role={implicitRetryAvailable ? "button" : undefined}
        tabIndex={implicitRetryAvailable ? 0 : undefined}
        aria-label={implicitRetryAvailable ? "Edit answer and try again" : undefined}
        _focusVisible={implicitRetryAvailable ? { outline: "2px solid #16707e", outlineOffset: "2px" } : undefined}
      >
        {usesTemplateEditor && templateState ? (
          <ExpressionEditor
            state={templateState}
            onSetCaret={onSetCaret}
            interactive={phase === "answering" && !hintRungActiveForCurrent}
          />
        ) : (
          input || <Text as="span" color="#9bbcc2">type your answer</Text>
        )}
      </Box>
      {!usesTemplateEditor && (
        <Box
          visibility={phase === "answering" && !hintRungActiveForCurrent ? "visible" : "hidden"}
          aria-hidden={phase !== "answering" || hintRungActiveForCurrent}
        >
          <DictationMicButton
            size="md"
            ariaLabel="Say your answer"
            onTranscript={(text) => {
              if (
                !current ||
                current.answerType === MANIPULATIVE_ANSWER_TYPE ||
                current.answerType === "dialogue"
              )
                return;
              // A unit item's spoken answer carries the unit ("112 cubic
              // centimeters") — the number parser alone would drop it.
              const parsed = spokenToUnitAnswer(text, current.answerType, answerUnit);
              if (parsed !== null) {
                setUnitGatedItemId(null);
                setInput(parsed);
              }
            }}
          />
        </Box>
      )}
    </HStack>
  ) : null;

  // The structure-glyph keypad belongs only to a 2-D (fraction/power/root) item while
  // answering — a real fraction / exponent glyph plus backspace. Digits (and the
  // flat integer/decimal answer) come from the hardware keyboard: on web we
  // assume a laptop, so there is no on-screen number pad (see
  // `useFlatAnswerKeyboard`). A unit-bearing item gets the OTHER accessory row —
  // its dimension family (cm / cm² / cm³), or the single ° key for an angle — for
  // the same reason: the glyph isn't on the keyboard. A flat fraction/decimal/
  // expression item gets a `/` key so a fraction is enterable without a hardware
  // slash (parity with the native pad's `/` key; a touch/embedded scholar has no
  // number grid). These branches are mutually exclusive (a unit item is flat).
  // Feedback removes the pad's reserved height so the relabelled action stays in
  // the viewport.
  const answerPadEl =
    isTypedItem && phase === "answering" && !hintRungActiveForCurrent ? (
      usesTemplateEditor ? (
        <Box w="100%">
          <ExpressionKeypad
            onInsertFraction={onInsertFraction}
            onInsertPower={onInsertPower}
            onInsertSquareRoot={onInsertSquareRoot}
            onInsertRoot={onInsertRoot}
            showRadicals={current.answerType === "expression"}
            onDelete={() => onTemplateKey("⌫")}
            locked={!!templateState?.structureLocked}
          />
        </Box>
      ) : answerUnit ? (
        <Box w="100%">
          <UnitKeys answerUnit={answerUnit} onPick={onUnitKey} />
        </Box>
      ) : current && isPadAnswerType(current.answerType) && padAcceptsFraction(current.answerType) ? (
        <Box w="100%">
          <FractionKey onPick={() => onKey("/")} />
        </Box>
      ) : null
    ) : null;

  // The pinned CTA lane — a single button that only relabels, except a second
  // miss which splits into two equal buttons.
  let ctaEl: React.ReactNode = null;
  if (phase === "answering") {
    ctaEl = isTypedItem ? (
      <Button
        colorPalette="teal"
        size="lg"
        w="100%"
        onClick={() => void onSubmit()}
        disabled={busy || hintBlocksMainSubmit || !input.trim()}
      >
        Check <ArrowRight />
      </Button>
    ) : null;
  } else if (phase === "feedback" && onBreakerItem) {
    // The breaker's own item (the fresh same-node try, or the easy finish) —
    // one graded attempt, then the episode closes. No retry, no next.
    ctaEl = (
      <Button
        colorPalette="teal"
        size="lg"
        w="100%"
        onClick={finishBreakerItem}
      >
        Finish <ArrowRight />
      </Button>
    );
  } else if (isMapping && phase === "feedback") {
    // Option D: a mapping item is reveal-only measurement — always a plain
    // Next, whatever the outcome (never retry / teaching-step gate).
    ctaEl = (
      <Button colorPalette="teal" size="lg" w="100%" onClick={onNext}>
        {nextLabel} <ArrowRight />
      </Button>
    );
  } else if (phase === "feedback" && result?.dontKnow) {
    // Hold Next until the scholar has ATTEMPTED the one teaching step (or it's
    // unavailable/stalled — TeachingStep unlocks via onReady). One attempt is
    // enough; a wrong try still unlocks, so the scholar is never trapped.
    //
    // The SAME two-button row the "stuck" branch gets below: an honest "I
    // haven't learned this yet" must reach the companion tutor at least as
    // easily as two wrong guesses do, or the surface quietly teaches that
    // guessing pays better than telling the truth.
    ctaEl = rehearse ? (
      // Rehearse has no teaching-step gate and no tutor handoff — a single
      // "Next" moves the preview along.
      <Button colorPalette="teal" size="lg" w="100%" onClick={onNext}>
        {nextLabel} <ArrowRight />
      </Button>
    ) : (
      <HStack w="100%" gap={2.5}>
        <Button
          flex="1"
          minW={0}
          size="lg"
          variant="outline"
          color="#5a655d"
          borderColor="#ded8cb"
          fontWeight="600"
          onClick={onNext}
          disabled={!dontKnowStepReady}
        >
          {nextLabel} <ArrowRight />
        </Button>
        <Button flex="1" minW={0} colorPalette="teal" size="lg" onClick={onTalkItThrough} disabled={busy}>
          <ChatCircleDots weight="fill" /> Walk me through it
        </Button>
      </HStack>
    );
  } else if (fbCorrect) {
    ctaEl = (
      <Button colorPalette="teal" size="lg" w="100%" onClick={onNext}>
        {nextLabel} <ArrowRight />
      </Button>
    );
  } else if (fbMiss && verdict === "retry") {
    ctaEl = (
      <Button colorPalette="teal" size="lg" w="100%" onClick={onRetry} disabled={busy}>
        <ArrowCounterClockwise /> Try again
      </Button>
    );
  } else if (fbMiss && verdict === "stuck") {
    // Two equal buttons; a silly slip can just Continue, but the weighting nudges
    // toward the walkthrough (ghost Continue vs. the filled-teal walk button).
    ctaEl = (
      <HStack w="100%" gap={2.5}>
        <Button
          flex="1"
          minW={0}
          size="lg"
          variant="outline"
          color="#5a655d"
          borderColor="#ded8cb"
          fontWeight="600"
          onClick={() => {
            if (current?.lane === "stretch") onNext();
            else void onFreshVariant();
          }}
          disabled={busy || hintBlocksMainSubmit}
        >
          Continue
        </Button>
        {!rehearse && (
          <Button flex="1" minW={0} colorPalette="teal" size="lg" onClick={onTalkItThrough} disabled={busy}>
            <ChatCircleDots weight="fill" /> Walk me through it
          </Button>
        )}
      </HStack>
    );
  } else if (phase === "queued") {
    ctaEl = (
      <Button colorPalette="teal" size="lg" w="100%" onClick={onNext}>
        {nextLabel} <ArrowRight />
      </Button>
    );
  }

  // "I haven't learned this yet" — a first-look affordance. Kept in the help row
  // with its space reserved, so it's invisible once you've answered without moving
  // the CTA (Andy: hide it on a miss but hold its layout space). Shown for a typed,
  // a manipulative, OR a multiple-choice item — every gradeable item type earns the
  // honest escape, so MC never forces a guess that would corrupt measurement (U-4
  // parity; pilot9 J5 founder ruling — same onDontKnow handler + copy as the rest).
  const skipVisible =
    phase === "answering" &&
    !isOffline &&
    isFirstAttempt(hasRecorded) &&
    (isTypedItem || isManipulativeItem || isMcItem);
  // Predict-then-Check confidence lives in the help row (see below), directly
  // above the Check button — part of answering, not of the question. Its slot is
  // reserved across phases so the pinned CTA never moves; it's interactive only on
  // a first look at a typed / multiple-choice item.
  const confidenceSlotActive = (isTypedItem || isMcItem) && !rehearse;
  const confidenceInteractive =
    confidenceSlotActive && phase === "answering" && isFirstAttempt(hasRecorded);
  // A correct answer may still be scaffolded. Mapping and stretch items never
  // contribute ordinary fluency evidence, and rehearsal/offline runs have no
  // recorded attempt to amend, so none earn this admission.
  const helpUsedVisible =
    phase === "feedback" &&
    !!result?.correct &&
    !result.mapping &&
    !result.dontKnow &&
    !!result.attemptId &&
    !rehearse &&
    !isOffline &&
    !breaker &&
    current?.lane !== "stretch";
  // ── The HELP ROW ────────────────────────────────────────────────────────────
  // The confidence prediction, the strategy hint, the worked example and the
  // honest don't-know are one family — everything you can reach for BESIDES
  // answering — so they render as one row of identically-styled pills directly
  // above the primary CTA instead of three scattered places (Andy, 2026-07-26).
  // Every member keeps its slot (visibility only) across phases, so the pinned
  // CTA never moves as members come and go.
  // Rehearse hides the hint ladder — its step-serving is a mutation, and the
  // handoff it escalates to streams the tutor. A rehearse preview grades and
  // reveals; it does not coach.
  const helpLadderItem = (isTypedItem || isMcItem || isManipulativeItem) && !rehearse;
  const hintText = current && !isMapping ? hintForSkill(current.skillKey) : "";
  const hintVisible = phase === "answering" && helpLadderItem && !!hintText;
  const hintStateCurrent = hintItemId === current?.itemId;
  const currentShowHint = hintStateCurrent && showHint;
  const currentHintRungs = hintStateCurrent ? hintRungs : [];
  const currentActiveHintRung = hintStateCurrent ? activeHintRung : null;
  const currentHintStepsExhausted = hintStateCurrent && hintStepsExhausted;
  const hintLadderOpen =
    currentShowHint ||
    currentHintRungs.length > 0 ||
    currentActiveHintRung !== null;
  const hintButtonLabel = currentHintStepsExhausted
    ? "Talk it through →"
    : currentActiveHintRung
      ? "Finish this step"
      : currentShowHint
        ? "Next hint"
        : "Hint";
  // Persistent "See an example" (instructional segments v1): quiet, always
  // reachable while working an item in a strand with verified content, so
  // choosing "Try it myself" is never a trap.
  const exampleVisible = phase === "answering" && !isOffline && !!strandExample;
  const helpRowActive =
    confidenceSlotActive || helpLadderItem || !!strandExample || helpUsedVisible;

  // The Launchpad doorway opens at the item it introduces -- `launchpad.at`, the
  // first item of the strand it explains -- not unconditionally at idx 0. It is
  // rendered INSTEAD of that item, then `launchpadDone` lets the same index fall
  // through to the item itself. One interception point; `idx` never shifts.
  const launchpadDoorwayOpen =
    !!launchpad &&
    !isRemote &&
    !launchpadDone &&
    !placementGateActive &&
    !inContinuation &&
    idx === launchpad.at &&
    !hasRecorded &&
    phase === "answering";
  if (launchpadDoorwayOpen && launchpad) {
    return (
      <Flex
        direction="column"
        align="center"
        h="100%"
        minH={0}
        overflow="hidden"
        bg="#f6f4ef"
        px={5}
        pt={{ base: 6, md: 10 }}
        pb={5}
      >
        <Flex direction="column" w="100%" maxW="460px" flex="1" minH={0}>
          {/* The doorway keeps the playlist's chrome. It is a beat IN the run,
              not an interstitial in front of it, so the scholar sees the same
              beat heading and the same progress bar they see on every other
              slot -- with the Launchpad's own band spliced in. */}
          <VStack gap={5} w="100%">
            {segmentBeatVisibleForKind(displaySegments.length, "launchpad") && (
              <Text alignSelf="flex-start" fontSize="13px" fontWeight="700" color="#3a4a3e">
                {segmentBeatLabel("launchpad")}
              </Text>
            )}
            <Box w="100%">
              <Flex justify="space-between" mb={1} gap={2}>
                <Text fontSize="12px" color="#65706a" lineClamp={1}>
                  {practiceDomainLabel(launchpad.entry.target.domain)}
                </Text>
                <Text flexShrink={0} fontSize="12px" color="#65706a">
                  {idx + 1} of {items.length}
                </Text>
              </Flex>
              <Box h="6px" bg="#e6e0d2" borderRadius="full" overflow="hidden" position="relative">
                <Box
                  h="100%"
                  bg="#3a9e6b"
                  w={`${Math.round(progressFraction(idx, items.length, false) * 100)}%`}
                  transition="width 0.25s"
                />
                {segments.length > 1 &&
                  segmentStartIdx.slice(1).map((startIdx) => (
                    <Box
                      key={startIdx}
                      position="absolute"
                      top={0}
                      bottom={0}
                      left={`${(startIdx / items.length) * 100}%`}
                      w="2px"
                      bg="#fffdfa"
                    />
                  ))}
              </Box>
            </Box>
          </VStack>
          <Flex flex="1" minH={0} align="center" justify="center" w="100%">
            <LaunchpadCard
              scholarId={scholarId}
              entry={launchpad.entry}
              onProceed={() => setLaunchpadDone(true)}
            />
          </Flex>
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex
      direction="column"
      align="center"
      h="100%"
      minH={0}
      overflow="hidden"
      bg="#f6f4ef"
      px={5}
      pt={{ base: 6, md: 10 }}
      pb={5}
    >
      <style dangerouslySetInnerHTML={{ __html: MOTION_CSS }} />
      <Flex direction="column" w="100%" maxW="460px" flex="1" minH={0}>
        {/* Quiet corner back-to-Home affordance (web parity with native's
            practice header back chevron — native/src/app/practice.tsx →
            PracticeProgressHeader `onBack`). A teacher remote-rehearsal already
            has its own "Back to math map" banner, so it's skipped there. */}
        {!isRemote && (
          <HStack w="100%" mb={1} ml={-2}>
            <BackToHomeButton />
          </HStack>
        )}
        {/* Rehearse: a quiet, honest note that this is a preview and nothing the
            teacher answers is recorded — matching the "nothing is saved"
            vocabulary the other Rehearse surfaces use (RehearsePane,
            ManipulativeRehearseModal). Sentence case. */}
        {rehearse && (
          <HStack
            w="100%"
            mb={2}
            gap={2}
            px={3}
            py={2}
            bg="#f3eeff"
            border="1px solid #e4dcff"
            borderRadius="10px"
          >
            <Box color="#6b4bd6" flexShrink={0} lineHeight={0}>
              <Play weight="fill" />
            </Box>
            <Text fontSize="13px" fontWeight="600" color="#5a4b86">
              Rehearsing — nothing you answer here is recorded.
            </Text>
          </HStack>
        )}
        <VStack gap={5} w="100%">
        {activityTitle && (
          <Text fontSize="13px" fontWeight="700" color="#16707e" alignSelf="flex-start" textTransform="uppercase" letterSpacing="0.04em">
            {activityTitle}
          </Text>
        )}
        {(isOffline || queuedCount > 0) && (
          <HStack
            w="100%"
            gap={2}
            bg={isOffline ? "#fbf1de" : "#eef6f0"}
            border={`1px solid ${isOffline ? "#e3c766" : "#bcdfc7"}`}
            borderRadius="10px"
            px={3}
            py={2}
            color={isOffline ? "#8a6d16" : "#2f6b46"}
          >
            <WifiSlash weight="bold" size={16} />
            <Text fontSize="12.5px">
              {isOffline
                ? "You're offline — keep going, we'll check your answers when you're back."
                : `Checking ${queuedCount} saved answer${queuedCount === 1 ? "" : "s"}…`}
            </Text>
          </HStack>
        )}
        {/* Founder amendment (2026-07-19): ceremony HEADER, not ceremony block.
            The all-mapping "Math Check-In" run wears its identity in the header
            marker (`· math check-in`, below) — the extra in-drill title + intro
            copy that used to live here was killed as an oddly-positioned
            duplicate of the Home card's framing. Math Check-In is a special case
            of mapping, so it just relabels the marker; blended runs stay
            `· mapping`. The Home tile copy + the Done "Math Check-In" beat are
            untouched. */}
        {/* Playlist segment beat (raise-the-ceiling §11 / C-4): a light,
            growth-framed heading shown once, on the FIRST item of a segment —
            never repeated per item, never a reward/score. Skipped when the whole
            session is one segment (nothing to announce) and never shown for a
            `· mapping` segment — a mapping segment carries its identity in the
            per-item header marker alone, with no beat (founder amendment
            2026-07-19 #2, superseding the per-segment reassurance ruling). */}
        {(segmentBeatVisibleForKind(displaySegments.length, currentSegment?.kind)) &&
          isSegmentStart &&
          currentSegment && (
          <Text alignSelf="flex-start" fontSize="13px" fontWeight="700" color="#3a4a3e">
            {segmentBeatLabel(currentSegment.kind, isFirstCoreDrillSegment)}
          </Text>
        )}
        {/* Per-item domain chip — shown ONLY in a mixed playlist, so the scholar
            sees when the subject switches between items. A plain even-bordered
            pill (no accent stripe/gradient — see visual-design rules); the human
            label comes from the domain registry, never the raw slug. */}
        {isMixed && current?.domain && (
          <Text
            alignSelf="flex-start"
            fontSize="11px"
            fontWeight="600"
            color="#5a655d"
            bg="#fffdfa"
            border="1px solid #ded8cb"
            borderRadius="full"
            px={2.5}
            py={0.5}
            textTransform="uppercase"
            letterSpacing="0.04em"
          >
            {practiceDomainLabel(current.domain)}
          </Text>
        )}
        <Box w="100%">
          <Flex justify="space-between" mb={1} gap={2}>
            <HStack gap={1.5} minW={0}>
              <Text fontSize="12px" color="#65706a" lineClamp={1}>{superscriptExponents(current?.skillLabel)}</Text>
              {/* Serving-lane chip (P1e): "· review" (keeping an already-learned
                  skill sharp) or "· challenge" (an above-band stretch). Quiet
                  inline text — no pill/stripe — matching the playlist's tag idiom;
                  a "new" item shows nothing. Growth-framed, never a score. A
                  "· mapping" item reads "· math check-in" when the whole run is
                  the all-mapping ceremony sit (founder amendment 2026-07-19). */}
              {current?.lane === "review" && (
                <Text flexShrink={0} fontSize="11px" color="#7c8a86" fontWeight="600">· review</Text>
              )}
              {current?.lane === "challenge" && (
                <Text flexShrink={0} fontSize="11px" color="#a8620f" fontWeight="700">· challenge</Text>
              )}
              {current?.lane === "stretch" && (
                <Text flexShrink={0} fontSize="11px" color="#5663c6" fontWeight="700">· stretch</Text>
              )}
              {current?.lane === "mapping" && (
                <Text flexShrink={0} fontSize="11px" color="#8a6f2f" fontWeight="700">{mappingHeaderLabel(allMapping)}</Text>
              )}
            </HStack>
            <Text flexShrink={0} fontSize="12px" color="#65706a">
              {pretestProgress?.label ?? `${idx + 1} of ${items.length}`}
            </Text>
          </Flex>
          {/* Segment-aware progress: the usual continuous fill bar, plus a thin
              divider at each segment boundary (real data — where one playlist
              beat ends and the next begins — never a decorative stripe). Falls
              back to a plain bar when there's only one segment. */}
          <Box h="6px" bg="#e6e0d2" borderRadius="full" overflow="hidden" position="relative">
            <Box h="100%" bg="#3a9e6b" w={`${Math.round(progress * 100)}%`} transition="width 0.25s" />
            {segments.length > 1 &&
              segmentStartIdx.slice(1).map((startIdx) => (
                <Box
                  key={startIdx}
                  position="absolute"
                  top={0}
                  bottom={0}
                  left={`${(startIdx / items.length) * 100}%`}
                  w="2px"
                  bg="#fffdfa"
                />
              ))}
          </Box>
        </Box>
        </VStack>

        {isHandoffPhase ? (
          /* Handoff keeps the shipped bottom-anchored choreography: the stem
             stays up top as context and the Socratic chat rises from below,
             pushing the problem up. The number-pad slot becomes the text input. */
          <Flex direction="column" w="100%" flex="1" minH={0} justify="flex-end" gap={4} pt={5} position="relative">
            <Box key={current?.itemId ?? "none"} className="rh-rise" w="100%">
              <VStack gap={5} w="100%" align="stretch">
                {stemCardEl}
                {handoff && current && (
                  <VStack w="100%" gap={3} align="stretch">
                    {isDialogueChat ? (
                      <HStack gap={2} color="#5663c6">
                        <ChatCircleDots weight="fill" size={20} />
                        <Text fontWeight="700" fontSize="15px">Talk me through your idea</Text>
                      </HStack>
                    ) : (
                      <HStack gap={2} color="#16707e">
                        <ChatCircleDots weight="fill" size={20} />
                        <Text fontWeight="700" fontSize="15px">Let&apos;s talk it through</Text>
                      </HStack>
                    )}

                    <VStack align="stretch" gap={2.5} w="100%" maxH="320px" overflowY="auto" py={1}>
                      {handoff.messages.map((m, i) => {
                        if (!m.content) return null;
                        const streamingAssistant =
                          m.role === "assistant" &&
                          i > 0 &&
                          i === handoffLastMessageIndex &&
                          !handoff.loading;
                        return (
                          <ChatBubble key={i} role={m.role}>
                            {m.role === "assistant" ? (
                              <Box className="chat-markdown" fontFamily="body" fontSize="md">
                                {streamingAssistant ? (
                                  <StreamingMarkdown content={m.content} />
                                ) : (
                                  <MarkdownBlock content={m.content} />
                                )}
                              </Box>
                            ) : (
                              <Text whiteSpace="pre-wrap">{m.content}</Text>
                            )}
                          </ChatBubble>
                        );
                      })}
                      {handoff.loading && (
                        <ChatBubble role="assistant">
                          <HStack gap={2}>
                            <Spinner size="xs" />
                            <Text fontSize="14px" color="#65706a">
                              thinking…
                            </Text>
                          </HStack>
                        </ChatBubble>
                      )}
                      {handoff.error && (
                        <Text fontSize="13px" color="#9b1c1c" px={1}>{handoff.error}</Text>
                      )}
                    </VStack>

                    {!showHandoffComposer && isDialogueChat ? (
                      /* Graded DIALOGUE verdict — the check happened; land it and move on. */
                      <VStack w="100%" gap={2}>
                        <Text fontSize="15px" fontWeight="700" color={dialogueVerdict?.passed ? "#1f9d6b" : "#5a655d"} textAlign="center">
                          {dialogueVerdict?.passed
                            ? "That's the idea — it went on your depth record."
                            : "Not all the way there yet — and nothing on your map went down."}
                        </Text>
                        <Text className="rh-note" fontSize="13px" color="#65706a" textAlign="center">
                          {dialogueVerdict?.passed
                            ? "You said it in your own words — that's the whole point of these."
                            : "Ideas like this one take a few visits. It'll be here."}
                        </Text>
                        <Button colorPalette="teal" size="lg" w="100%" onClick={onHandoffAdvance} disabled={busy}>
                          {isLastItem(idx, items.length) ? "Finish" : "Next"} <ArrowRight />
                        </Button>
                      </VStack>
                    ) : !showHandoffComposer ? (
                      <VStack w="100%" gap={2}>
                        <Text fontSize="13px" color="#65706a" textAlign="center">
                          {handoff.entryMode === "spiral"
                            ? breaker
                              ? breakerBody(
                                  breaker.flow,
                                  breaker.recoveryAvailable,
                                )
                              : ""
                            : current?.lane === "stretch"
                            ? "Good thinking — now take another run at it."
                            : "Good thinking — now try a fresh one on your own."}
                        </Text>
                        {/* Breaker support auto-advances to its fresh item.
                            Ordinary handoffs keep their explicit return action. */}
                        {handoff.entryMode !== "spiral" ? (
                          <Button
                            colorPalette="teal"
                            size="lg"
                            w="100%"
                            onClick={() => {
                              if (current?.lane === "stretch") {
                                onHandoffRetry();
                              } else void onFreshVariant();
                            }}
                            disabled={busy}
                          >
                            <><ArrowCounterClockwise /> Try it again</>
                          </Button>
                        ) : null}
                        {/* The one quiet escape stays available while the
                            automatic fresh serve starts. */}
                        {handoff.entryMode === "spiral" ? (
                          <Button
                            variant="ghost"
                            size="lg"
                            minH="48px"
                            w="100%"
                            color="#5a655d"
                            onClick={() => onBreakerControl("easyFinish")}
                            disabled={busy}
                          >
                            {breakerControlLabel("easyFinish")}
                          </Button>
                        ) : null}
                      </VStack>
                    ) : (
                      <>
                        {handoffDictationState === "recording" ? (
                          <HStack w="100%" gap={2}>
                            <IconButton
                              aria-label="Cancel recording"
                              variant="ghost"
                              color="charcoal.400"
                              _hover={{ bg: "red.50" }}
                              borderRadius="full"
                              size="md"
                              onClick={cancelHandoffRecording}
                            >
                              <X />
                            </IconButton>
                            <Flex
                              flex="1"
                              align="center"
                              justify="center"
                              gap={3}
                              bg="red.50"
                              border="0.5px solid"
                              borderColor={handoffIsTooLoud ? "red.400" : "red.300"}
                              borderRadius="xl"
                              py={3}
                              px={4}
                              minH="48px"
                            >
                              <Box
                                w="10px"
                                h="10px"
                                borderRadius="full"
                                bg={handoffIsTooLoud ? "red.500" : "red.400"}
                                className="animate-pulse-soft"
                              />
                              <Text fontWeight="700" color={handoffIsTooLoud ? "red.600" : "red.500"}>
                                {handoffIsTooLoud ? "Too loud!" : "Listening…"}
                              </Text>
                            </Flex>
                            <IconButton
                              aria-label="Stop and send recording"
                              bg={handoffHasSpeech ? "red.500" : "charcoal.300"}
                              color="white"
                              _hover={{ bg: handoffHasSpeech ? "red.600" : "charcoal.400" }}
                              borderRadius="full"
                              size="lg"
                              onClick={stopHandoffRecording}
                            >
                              <ArrowUp />
                            </IconButton>
                          </HStack>
                        ) : (
                          <VStack w="100%" gap={2} align="stretch">
                            {chatImage.pendingImage && (
                              <Box position="relative" alignSelf="flex-start" maxH="120px" borderRadius="lg" overflow="hidden" border="1px solid" borderColor="gray.200">
                                {/* eslint-disable-next-line @next/next/no-img-element -- dynamic blob preview; next/image can't optimize it */}
                                <img
                                  src={chatImage.pendingImage.preview}
                                  alt="Attachment preview"
                                  style={{ maxHeight: "120px", objectFit: "cover", borderRadius: "8px" }}
                                />
                                <IconButton
                                  aria-label="Remove image"
                                  size="xs"
                                  bg="blackAlpha.600"
                                  color="white"
                                  _hover={{ bg: "blackAlpha.800" }}
                                  position="absolute"
                                  top={1}
                                  right={1}
                                  borderRadius="full"
                                  onClick={chatImage.clear}
                                >
                                  <X size={12} />
                                </IconButton>
                              </Box>
                            )}
                            <HStack w="100%" gap={2} align="flex-end">
                              <ComposerAttachMenu
                                onPick={chatImage.setPendingImage}
                                overlayPosition="fixed"
                                disabled={handoff.loading || handoffDictationState === "transcribing"}
                                triggerAriaLabel="Add a photo"
                              />
                              <Textarea
                                ref={handoffComposerRef}
                                value={handoffInput}
                                onChange={(e) => setHandoffInput(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    void onHandoffSend();
                                  }
                                }}
                                placeholder="Type what you're thinking…"
                                size="lg"
                                bg="white"
                                rows={1}
                                resize="none"
                                disabled={handoff.loading || handoffDictationState === "transcribing"}
                                autoFocus
                              />
                              {handoffCanSend ? (
                                <IconButton
                                  aria-label="Send"
                                  bg="violet.500"
                                  color="white"
                                  _hover={{ bg: "violet.700" }}
                                  _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                                  borderRadius="xl"
                                  size="lg"
                                  onClick={() => void onHandoffSend()}
                                  disabled={handoff.loading}
                                >
                                  <ArrowUp />
                                </IconButton>
                              ) : (
                                <IconButton
                                  aria-label={
                                    handoffDictationState === "transcribing"
                                      ? "Transcribing…"
                                      : "Start recording — tap to talk, tap again to send"
                                  }
                                  bg="violet.500"
                                  color="white"
                                  _hover={{ bg: "violet.600" }}
                                  _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                                  borderRadius="full"
                                  size="lg"
                                  onClick={() => void toggleHandoffRecording()}
                                  disabled={handoff.loading || handoffDictationState === "transcribing"}
                                >
                                  {handoffDictationState === "transcribing" ? (
                                    <Spinner size="sm" />
                                  ) : (
                                    <Microphone weight="fill" />
                                  )}
                                </IconButton>
                              )}
                            </HStack>
                          </VStack>
                        )}
                        {handoffDictationError && (
                          <Text fontSize="12px" color="red.500" textAlign="center">
                            {handoffDictationError}
                          </Text>
                        )}
                        {isDialogueChat ? (
                          <Button
                            colorPalette="teal"
                            size="lg"
                            w="100%"
                            onClick={() => void onDialogueCheck()}
                            disabled={busy || !dialogueHasIdea || !!handoff?.loading}
                          >
                            ✓ Check my thinking
                          </Button>
                        ) : handoff.entryMode === "spiral" ? (
                          <VStack w="100%" gap={2}>
                            <Button
                              variant="ghost"
                              size="lg"
                              minH="48px"
                              w="100%"
                              color="#5a655d"
                              onClick={() => onBreakerControl("easyFinish")}
                              disabled={busy}
                            >
                              {breakerControlLabel("easyFinish")}
                            </Button>
                          </VStack>
                        ) : current?.lane === "stretch" ? (
                          <Button variant="ghost" color="#5a655d" onClick={onHandoffAdvance} disabled={busy}>
                            {isLastItem(idx, items.length) ? "Finish" : "Done — next"} <ArrowRight />
                          </Button>
                        ) : (
                          <Button variant="ghost" color="#5a655d" onClick={() => void onFreshVariant()} disabled={busy}>
                            I&apos;ve got it — try a fresh one <ArrowRight />
                          </Button>
                        )}
                      </>
                    )}
                  </VStack>
                )}
              </VStack>
            </Box>
            <Box ref={setBottomEl} h="1px" w="100%" />
          </Flex>
        ) : (
          <>
            {/* STAGE — the active problem card is vertically centered (via my=auto,
              which still lets a tall don't-know explanation scroll). Correctness
              is an OVERLAY on the card (the corner stamp + tint), never an inline
              box that grows the column, so the card never jumps between answering
              and feedback. On advance the item you just left floats up + fades off
              the top (the absolutely-positioned `departing` ghost). NOTE: the
              verdict stamp's corner overhang (VerdictStemCard) is kept within this
              box's own bounds rather than fixed with `overflowX` here — per the
              CSS overflow-x/y coupling rule, an explicit `overflowX="visible"`
              is silently forced back to `auto` (clipping) whenever `overflowY`
              on the same box is non-visible, so it can't be fixed at this level. */}
            <Flex ref={setStageEl} direction="column" w="100%" flex="1" minH={0} gap={4} pt={5} position="relative" overflowY="auto">
              {departing && (
                <Box
                  position="absolute"
                  left={0}
                  right={0}
                  top={0}
                  bottom={0}
                  zIndex={1}
                  pointerEvents="none"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                >
                  <Box key={departing.itemId} className="rh-float-up" w="100%">
                    <Box
                      w="100%"
                      bg="#fffdfa"
                      border="1px solid #ded8cb"
                      borderRadius="16px"
                      px={6}
                      py={5}
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                    >
                      <StemText value={superscriptExponents(departing.stem)} fontSize={24} align="center" />
                    </Box>
                  </Box>
                </Box>
              )}
              <Box key={current?.itemId ?? "none"} className="rh-rise" w="100%" my="auto" position="relative">
                <VStack gap={5} w="100%">
                  {/* Predict-then-Check reveal — one gentle line above the card,
                      only when the kid's prediction and the outcome disagreed. */}
                  {phase === "feedback" && calibrationReveal && (
                    <CalibrationReveal text={calibrationReveal} />
                  )}

                  {stemCardEl}

                  {/* Backward-faded worked-example scaffold (SPIKE) — shown while
                      the scholar is working the item. */}
                  {phase === "answering" && current?.workedSteps && (
                    <WorkedSteps steps={current.workedSteps} />
                  )}

                  {/* Teach-as-action — after "I haven't learned this yet", ONE
                      interactive faded step to finish (doing it IS the reading).
                      Degrades to reveal-only when the item has no worked steps.
                      Skipped in rehearse: TeachingStep writes (recordTeachingOutcome)
                      and needs a real earned dont_know attempt. */}
                  {phase === "feedback" &&
                    !rehearse &&
                    result?.dontKnow &&
                    current &&
                    !isMapping &&
                    onBreakerItem !== true && (
                    <TeachingStep
                      key={current.itemId}
                      scholarId={scholarId}
                      itemId={current.itemId}
                      onReady={() => setDontKnowStepReady(true)}
                      onEscalate={onTalkItThrough}
                    />
                  )}

                  {/* Predict-then-Check confidence chips moved to the bottom lane,
                      directly above the Check button — they read as part of the
                      answering step, not the question. See the CTA lane below. */}

                  {phase === "answering" && current && current.answerType === MANIPULATIVE_ANSWER_TYPE && (
                    <>
                      {manipulativeSpec ? (
                        <Manipulative spec={manipulativeSpec} onCommit={onManipulativeCommit} />
                      ) : (
                        <Text color="#9b1c1c" fontSize="14px">
                          This manipulative couldn&apos;t be loaded — try refreshing.
                        </Text>
                      )}
                    </>
                  )}

                  {phase === "answering" && isMcItem && (
                    <>
                      {/* No number pad here — a scholar can't type `<`/`=`/`>`. The
                          options are tappable buttons; a tap submits its index
                          straight through the same onSubmit path a typed answer
                          uses (the server grades by choice index). */}
                      <VStack w="100%" gap={2}>
                        {current!.choices!.map((choice, i) => (
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
                            disabled={busy}
                            onClick={() => void onSubmit(choiceSubmitValue(i))}
                            userSelect="none"
                            style={{
                              WebkitUserSelect: "none",
                              WebkitTouchCallout: "none",
                              touchAction: "manipulation",
                            }}
                            _active={{ bg: "#dff0f2", transform: "scale(0.98)" }}
                            transition="transform 0.06s ease-out, background 0.06s ease-out"
                          >
                            {hasPracticeMath(choice) ? (
                              <FractionText value={choice} inline fontSize={20} color="inherit" align="center" />
                            ) : (
                              choice
                            )}
                          </Button>
                        ))}
                      </VStack>
                    </>
                  )}

                  {/* Typed answer — the field carries the submitted number into
                      feedback (read-only + verdict-tinted). */}
                  {answerFieldEl}
                  {answerPadEl}
                  {/* The help ladder (hint / example / don't-know) lives in the
                      one help row pinned above the CTA — see the lane below. */}

                  {/* Feedback micro-copy — anchored ABSOLUTELY just below the card
                      (top:100% of the relative rise box) so it never adds to the
                      centered column's height. The stamp already carries the
                      verdict; this is a short supportive line, not a growing box.
                      So submit→feedback never moves the card. */}
                  <Box
                    position="absolute"
                    top="100%"
                    left={0}
                    right={0}
                    mt={3}
                    display="flex"
                    flexDir="column"
                    alignItems="center"
                  >
                  {/* Pre-submit gate: the unit is missing, so nothing was spent
                      — the answer field is still live and one unit key fixes it. */}
                  {phase === "answering" && unitGateNudge && (
                    <Text className="rh-note" fontSize="14px" color="#8a6d16" textAlign="center">
                      {UNIT_MISSING_NUDGE}
                    </Text>
                  )}

                  {fbCorrect && result && !result.mapping && (
                    <VStack gap={1.5} w="100%" className="rh-note">
                      {verdict === "accelerated" && (
                        <HStack gap={1.5} color="#146c43">
                          <Lightning weight="fill" />
                          <Text fontWeight="700" fontSize="14px">Two in a row, fast — skill earned!</Text>
                        </HStack>
                      )}
                      <HStack gap={2} justify="center">
                        <Box w="10px" h="10px" borderRadius="full" bg={PROFICIENCY_FILL[result.proficiency]} />
                        <Text fontSize="13px" color="#5a655d">
                          {superscriptExponents(result.skillLabel)} · {MASTERY_LABELS[result.proficiency]}
                        </Text>
                      </HStack>
                      {comesBackText && (
                        <Text fontSize="13px" color="#2f6b46" textAlign="center">{comesBackText}</Text>
                      )}
                    </VStack>
                  )}

                  {/* Option D: a `· mapping` item is measurement, so it REVEALS
                      (placement is locked — showing the answer teaches, never
                      offloads). No mastery/streak framing; the reassurance lives
                      on the segment beat header, so this is just the reveal +
                      a gentle "keep going". */}
                  {phase === "feedback" && result?.mapping && (
                    <VStack gap={1} w="100%" className="rh-note">
                      {result.correctAnswer && !result.correct && (
                        <Text fontSize="14px" color="#5a655d" textAlign="center">
                          The answer was{" "}
                          <FractionText value={result.correctAnswer} inline fontSize={14} color="inherit" align="center" />
                          .
                        </Text>
                      )}
                      {result.unitOutcome && (
                        <Text fontSize="14px" color="#8a6d16" textAlign="center">
                          {unitOutcomeNudge(result.unitOutcome)}
                        </Text>
                      )}
                      <Text
                        fontSize="13px"
                        color={result.correct ? "#00875a" : "#8a6f2f"}
                        textAlign="center"
                      >
                        {result.correct
                          ? "Nice — that helps us place you."
                          : result.dontKnow
                            ? "Good to know — that helps us start you in the right place."
                            : "That's okay — this just finds your level."}
                      </Text>
                    </VStack>
                  )}

                  {/* A miss NEVER reveals the answer (anti-offloading). The stamp
                      says "Not quite"; a short nudge lives here, and the CTA lane
                      offers try-again (1st) or Continue / Walk-me-through (2nd). */}
                  {/* The value was right and only the unit was off — the normal
                      incorrect treatment (stamp, tint, CTA lane), but the nudge
                      names what actually went wrong instead of "take another
                      look". Replaces the generic line rather than stacking. */}
                  {fbMiss && !isMapping && result?.unitOutcome && (
                    <Text className="rh-note" fontSize="14px" color="#8a6d16" textAlign="center">
                      {unitOutcomeNudge(result.unitOutcome)}
                    </Text>
                  )}
                  {fbMiss && !isMapping && !result?.unitOutcome && verdict === "retry" && (
                    <Text className="rh-note" fontSize="14px" color="#8a6d16" textAlign="center">
                      {current?.lane === "stretch"
                        ? "This one's meant to be hard — a miss here never touches your map. Take another look."
                        : "Take another look — you\u2019ve got this."}
                    </Text>
                  )}
                  {fbMiss && !isMapping && !result?.unitOutcome && verdict === "stuck" && (
                    <Text className="rh-note" fontSize="14px" color="#7a3b3b" textAlign="center">
                      {current?.lane === "stretch"
                        ? "A genuinely tough one — wrestling with it IS the work. Talk it through, or move on with nothing lost."
                        : "Want to talk it through? Your tutor won\u2019t give you the answer — they\u2019ll help you find it."}
                    </Text>
                  )}

                  {/* Post-miss retrieval (instructional segments v1): a neutral,
                      equally-valid way back to the SAME strand explainer after a
                      miss — never a deficit flag, never mastery-affecting. Held
                      back for an honest "I haven't learned this yet" (that already
                      routes to a teaching step) so two instructional beats never
                      stack. */}
                  {fbMiss && !isMapping && !result?.dontKnow && strandExample && (
                    <Button
                      mt={2}
                      variant="outline"
                      size="sm"
                      borderColor="#cfdad3"
                      bg="#fbfdfc"
                      color="#2f6b52"
                      _hover={{ bg: "#f1f7f3" }}
                      onClick={() => setExampleSheet({ source: "post_miss" })}
                    >
                      <Compass weight="bold" /> See an example
                    </Button>
                  )}

                  {/* Offline submit: honest — we can't grade without the server, so
                      no fake verdict. A compact note, then Next. */}
                  {phase === "queued" && (
                    <VStack w="100%" gap={2} className="rh-note">
                      <HStack gap={2} color="#1d4ed8" justify="center">
                        <WifiSlash weight="bold" />
                        <Text fontWeight="700" fontSize="14px">Saved — you&apos;re offline</Text>
                      </HStack>
                      <Text fontSize="13px" color="#3a4d73" textAlign="center">
                        We&apos;ll check this one for real as soon as you&apos;re back online. Keep going!
                      </Text>
                    </VStack>
                  )}
                  {submitError ? (
                    <Text
                      className="rh-note"
                      fontSize="13px"
                      color="#9b1c1c"
                      textAlign="center"
                    >
                      {submitError}
                    </Text>
                  ) : null}
                  </Box>
                </VStack>
              </Box>
              <Box ref={setBottomEl} h="1px" w="100%" flexShrink={0} />
            </Flex>

            {/* CTA LANE — pinned to the bottom, own row; it only relabels between
              states (Check → Next / Try again / Continue+Walk-me-through), so the
              action anchor never moves. Above it sits ONE help row carrying every
              secondary control; each member keeps its space reserved so hiding it
              never shifts the CTA. */}
            <VStack w="100%" gap={2.5} pt={3} flex="0 0 auto">
              {/* The hint panel opens directly above its own pill, inside the lane
                  — so revealing it never grows (or re-centers) the problem card. */}
              {hintVisible && hintLadderOpen && (
                <VStack alignSelf="center" w="min(calc(100vw - 40px), 720px)" gap={2.5}>
                  {currentShowHint ? (
                    <Box
                      w="100%"
                      bg="#fbf4dd"
                      border="1px solid #e3c766"
                      borderRadius="12px"
                      px={4}
                      py={2.5}
                    >
                      <Text fontSize="14px" color="#7a5f1c" textAlign="center">
                        {superscriptExponents(hintText)}
                      </Text>
                    </Box>
                  ) : null}
                  <HintLadderSteps
                    key={`${current?.itemId ?? "none"}:${currentActiveHintRung?.rung.stepIndex ?? `done-${currentHintRungs.length}`}`}
                    completed={currentHintRungs}
                    active={currentActiveHintRung?.rung ?? null}
                    onComplete={onHintStepComplete}
                  />
                  {hintStepError ? (
                    <Text fontSize="13px" color="#9b1c1c" textAlign="center">
                      {hintStepError}
                    </Text>
                  ) : null}
                </VStack>
              )}
              {helpRowActive && (
                <Flex
                  alignSelf="center"
                  w="min(calc(100vw - 40px), 720px)"
                  wrap="wrap"
                  justify="center"
                  align="center"
                  gap={2}
                  minH="40px"
                >
                  {/* The prediction slot does double duty across the two phases
                      of one item: while answering it holds the Predict-then-Check
                      chips; once the verdict lands on a correct answer it holds
                      the honest "I did this with help". Same slot, never both — the row
                      is width-budgeted (720px) and every other member still
                      reserves its footprint in feedback, so appending a FIFTH
                      pill here would wrap the row and drop the pinned CTA under
                      the kid's finger. Swapping keeps the row one line wide. */}
                  {(confidenceSlotActive || helpUsedVisible) &&
                    (helpUsedVisible ? (
                      <Button
                        {...HELP_PILL_PROPS}
                        {...(helpReported ? HELP_PILL_ON_PROPS : null)}
                        aria-pressed={helpReported}
                        onClick={() => void onDoneWithHelp()}
                        // A toggle, not a latch: owning up to help is a claim a
                        // scholar may take back, and a mis-tap here shouldn't
                        // cost them a fluency claim they actually earned.
                        disabled={busy || helpPending}
                      >
                        I did this with help
                      </Button>
                    ) : (
                      <Box
                        visibility={confidenceInteractive ? "visible" : "hidden"}
                        aria-hidden={!confidenceInteractive}
                      >
                        <ConfidenceGroup
                          value={predictedConfidence}
                          onChange={setPredictedConfidence}
                          disabled={busy || !confidenceInteractive}
                        />
                      </Box>
                    ))}
                  {helpLadderItem && (
                    <Button
                      {...HELP_PILL_PROPS}
                      {...(hintLadderOpen ? HELP_PILL_ON_PROPS : null)}
                      visibility={hintVisible ? "visible" : "hidden"}
                      aria-hidden={!hintVisible}
                      aria-expanded={hintLadderOpen}
                      onClick={() => void onHintLadderPress()}
                      disabled={!hintVisible || hintStepLoading || currentActiveHintRung !== null}
                      tabIndex={hintVisible ? undefined : -1}
                    >
                      <Lightbulb weight={hintLadderOpen ? "fill" : "regular"} /> {hintButtonLabel}
                    </Button>
                  )}
                  {!!strandExample && (
                    <Button
                      {...HELP_PILL_PROPS}
                      visibility={exampleVisible ? "visible" : "hidden"}
                      aria-hidden={!exampleVisible}
                      aria-label="See an example"
                      onClick={() => setExampleSheet({ source: "idea_shelf" })}
                      disabled={!exampleVisible}
                      tabIndex={exampleVisible ? undefined : -1}
                    >
                      <Compass /> Example
                    </Button>
                  )}
                  {helpLadderItem && (
                    <Button
                      {...HELP_PILL_PROPS}
                      visibility={skipVisible ? "visible" : "hidden"}
                      aria-hidden={!skipVisible}
                      onClick={() => void onDontKnow()}
                      disabled={busy || !skipVisible}
                      tabIndex={skipVisible ? undefined : -1}
                    >
                      {DONT_KNOW_LABEL}
                    </Button>
                  )}
                </Flex>
              )}
              {ctaEl}
              {breaker?.flow.stage === "fresh" &&
              (phase === "answering" ||
                (phase === "feedback" && result?.correct === false)) ? (
                <Button
                  variant="ghost"
                  size="lg"
                  minH="48px"
                  w="100%"
                  color="#5a655d"
                  onClick={() => onBreakerControl("easyFinish")}
                  disabled={busy}
                >
                  {breakerControlLabel("easyFinish")}
                </Button>
              ) : null}
            </VStack>
          </>
        )}
        {strandExample && (
          <InstructionExampleSheet
            open={!!exampleSheet}
            onClose={() => setExampleSheet(null)}
            scholarId={scholarId}
            skillKey={current?.skillKey ?? ""}
            content={strandExample}
            source={exampleSheet?.source ?? "idea_shelf"}
            nodeFirstContent={nodeFirstExample}
            // Rehearsal: the teacher may preview the SAME example a scholar sees,
            // but the sheet must mint nothing — no retrieval log, no on-demand
            // generation (which writes AI-usage telemetry).
            {...exampleSheetWriteCaps(rehearse)}
          />
        )}
      </Flex>
    </Flex>
  );
}

/**
 * The shared chrome for every control in the practice HELP ROW — the optional
 * confidence prediction, the strategy hint, the worked example and the honest
 * "I haven't learned this yet". They're one family (everything you can reach
 * for BESIDES answering), so they get one look: a compact, quiet pill that
 * never competes with the full-width primary CTA directly below them.
 */
const HELP_PILL_PROPS = {
  size: "sm" as const,
  h: "40px",
  px: 3.5,
  borderRadius: "full",
  variant: "outline" as const,
  bg: "#fffdfa",
  borderColor: "#ded8cb",
  color: "#5a655d",
  fontWeight: "600",
  fontSize: "13.5px",
  gap: 2,
  whiteSpace: "nowrap",
  flexShrink: 0,
  _hover: { bg: "#f4f1e9" },
};

/**
 * The "on" state for a TOGGLE pill in the help row (currently just Hint). It
 * reuses the confidence group's selected tint, so "this one is currently on"
 * has ONE vocabulary across the whole row.
 *
 * A toggle pill must never change its LABEL between states ("Hint" → "Hide
 * hint"), because a wider label re-flows every pill beside it and can push the
 * row onto a second line — a layout shift under the kid's finger, from the very
 * control they just tapped (Andy, 2026-07-26). The label is fixed; only the
 * chrome and the icon weight change.
 */
const HELP_PILL_ON_PROPS = {
  bg: "#dff0f2",
  borderColor: "#a9d5db",
  color: "#16707e",
  _hover: { bg: "#d2eaee" },
};

/**
 * Predict-then-Check confidence — an OPTIONAL 3-tap prediction the kid can make
 * before checking. Rendered as an ATTACHED segmented control (one pill, three
 * segments) so it reads unmistakably as a single set of options sitting inside
 * the help row, with no caption to explain it (Andy, 2026-07-26). Tapping the
 * selected segment again clears it — nothing is required.
 */
function ConfidenceGroup({
  value,
  onChange,
  disabled,
}: {
  value: ConfidenceLevel | null;
  onChange: (v: ConfidenceLevel | null) => void;
  disabled: boolean;
}) {
  return (
    <HStack
      gap={0}
      h="40px"
      borderWidth="1px"
      borderColor="#ded8cb"
      borderRadius="full"
      bg="#fffdfa"
      overflow="hidden"
      role="group"
      aria-label="How sure are you?"
      flexShrink={0}
    >
      {CONFIDENCE_LEVELS.map((c, i) => {
        const selected = value === c.level;
        return (
          <Button
            key={c.level}
            h="100%"
            px={3.5}
            minW={0}
            borderRadius={0}
            borderLeftWidth={i === 0 ? "0" : "1px"}
            borderLeftColor="#e8e2d6"
            variant="plain"
            bg={selected ? "#dff0f2" : "transparent"}
            color={selected ? "#16707e" : "#5a655d"}
            fontWeight={selected ? "700" : "600"}
            fontSize="13.5px"
            whiteSpace="nowrap"
            disabled={disabled}
            onClick={() => onChange(selected ? null : c.level)}
            aria-pressed={selected}
            aria-label={`How sure are you: ${c.label}`}
            _hover={{ bg: selected ? "#dff0f2" : "#f4f1e9" }}
          >
            {c.label}
          </Button>
        );
      })}
    </HStack>
  );
}

/** The one-line gentle calibration reveal shown above a verdict (mismatch only). */
function CalibrationReveal({ text }: { text: string }) {
  return (
    <HStack
      w="100%"
      gap={2}
      bg="#f3f7fb"
      border="1px solid #cdddf0"
      borderRadius="10px"
      px={3}
      py={2}
      color="#3a5573"
    >
      <Text fontSize="13.5px">{text}</Text>
    </HStack>
  );
}

export function ChatBubble({ role, children }: { role: "user" | "assistant"; children: ReactNode }) {
  const isUser = role === "user";
  // Match the web tutor chat (SessionInterface MessageBubble): the scholar's own
  // turn is a navy bubble with a tucked bottom-right corner; the tutor voice is a
  // soft gray bubble with a tucked bottom-left corner. Same radii/shadow + the
  // shared `animate-fade-in` entrance, so the handoff reads as the same family.
  return (
    <Flex justify={isUser ? "flex-end" : "flex-start"} w="100%">
      <Box
        className="animate-fade-in"
        maxW="82%"
        bg={isUser ? "navy.500" : "gray.100"}
        color={isUser ? "white" : "charcoal.500"}
        borderRadius="xl"
        borderBottomRightRadius={isUser ? "sm" : "xl"}
        borderBottomLeftRadius={isUser ? "xl" : "sm"}
        shadow="sm"
        px={4}
        py={3}
        fontSize="md"
        lineHeight="1.5"
      >
        {children}
      </Box>
    </Flex>
  );
}

/**
 * Transcript-mode choreography (Option B). The active item's motion is CSS-only
 * so it degrades to nothing under a Reduce-Motion preference — "calm, not
 * confetti" is a pedagogy value here, not just accessibility.
 *   • rhRise    — the active problem rises into place from below. It's
 *                 STAGGERED (a short delay + `both` fill so it stays hidden
 *                 during the wait): the next problem doesn't begin rising until
 *                 the departing one is ~30% through its float-up (0.3 × 0.46s ≈
 *                 0.14s), so the two motions read as one continuous scroll.
 *   • rhFloatUp — the problem you just left floats up off the top and fades out,
 *                 travelling the FULL screen height (-100vh) so it truly reads as
 *                 scrolling off the top (a scrolling-chat vibe, not a literal
 *                 transcript).
 */
const MOTION_CSS = `
@keyframes rhRise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
@keyframes rhFloatUp { from { opacity: 0.92; transform: translateY(0); } to { opacity: 0; transform: translateY(-100vh); } }
@keyframes rhStampPop { from { opacity: 0; transform: scale(0.55); } to { opacity: 1; transform: scale(1); } }
@keyframes rhShakeX { 0%,100%{transform:translateX(0)} 18%{transform:translateX(-7px)} 38%{transform:translateX(6px)} 58%{transform:translateX(-4px)} 78%{transform:translateX(3px)} }
@keyframes rhFade { from { opacity: 0; } to { opacity: 1; } }
.rh-rise { animation: rhRise 0.42s cubic-bezier(0.3,0.7,0.2,1) 0.14s both; }
.rh-float-up { animation: rhFloatUp 0.46s cubic-bezier(0.3,0.7,0.2,1) forwards; }
.rh-stamp { animation: rhStampPop 0.34s cubic-bezier(0.2,1.35,0.4,1) both; }
.rh-shake { animation: rhShakeX 0.42s; }
.rh-note { animation: rhFade 0.3s ease both; }
@media (prefers-reduced-motion: reduce) {
  .rh-rise { animation: none !important; }
  .rh-float-up { display: none !important; }
  .rh-stamp { animation: none !important; opacity: 1 !important; transform: none !important; }
  .rh-shake { animation: none !important; }
}
`;

function Centered({ children, top }: { children: React.ReactNode; top?: boolean }) {
  return (
    <Flex
      position="relative"
      minH="calc(100vh - 64px)"
      align={top ? "flex-start" : "center"}
      justify="center"
      p={5}
      pt={top ? { base: 6, md: 10 } : 5}
      bg="#f6f4ef"
    >
      {children}
    </Flex>
  );
}

/**
 * The drill's quiet back-to-Home affordance — web parity with native's practice
 * header back chevron (native/src/app/practice.tsx → PracticeProgressHeader's
 * `onBack`). Present throughout a run: the answering + feedback + done phases.
 * Leaving is always safe — practiceResumeStore has already snapshotted the
 * served items + exact position, so returning to practice lands on the SAME
 * item; this only navigates, it never touches the run. A calm option, not a
 * tempting escape hatch: an icon-only chevron, muted until hover.
 */
function BackToHomeButton() {
  const router = useRouter();
  return (
    <IconButton
      aria-label="Back to home"
      title="Back to home"
      variant="ghost"
      size="sm"
      color="#9aa39a"
      _hover={{ color: "#3a4a3e", bg: "#efece5" }}
      onClick={() => router.push("/scholar")}
    >
      <CaretLeft weight="bold" />
    </IconButton>
  );
}

// A small uppercase status eyebrow — the old flat "Session complete" heading,
// demoted to a quiet label so the growth headline can be the hero.
function ClosureEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="xs"
      fontWeight="700"
      textTransform="uppercase"
      letterSpacing="0.08em"
      color="#8a9089"
    >
      {children}
    </Text>
  );
}

// The hero growth headline. Its own component so the closure-generation hook
// (useEnsuredClosure) lives outside the done-branch conditional — it renders the
// governed LLM line once it arrives (cached), else the deterministic fallback.
function PracticeDoneHeadline({
  scholarId,
  signal,
  fallback,
  enabled,
}: {
  scholarId: Id<"users">;
  signal: PracticeSignal;
  fallback: string;
  enabled: boolean;
}) {
  const generated = useEnsuredClosure(scholarId, "practice", signal, enabled);
  return (
    <Heading size="lg" textAlign="center">
      {generated ?? fallback}
    </Heading>
  );
}
