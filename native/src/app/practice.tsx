/**
 * The native full-screen practice surface — the RN analogue of web
 * `components/practice/PracticeSession.tsx` (a homegrown, external-practice-style
 * loop). One item at a time, big tap targets, immediate server-graded feedback,
 * and a calm session summary. It reuses the SAME backend contract as web:
 *
 *   • serve  — `api.practiceSkills.practiceSession` (stems only; no answers)
 *   • grade  — `api.practiceSkills.submitAnswer` (server re-derives + grades;
 *              the correct answer is NEVER sent to the client on a miss)
 *
 * Per item type: numeric / fraction / expression → an on-screen keypad (no
 * system keyboard, iPad-first — native's touch-only counterpart to the web
 * hardware keyboard); multipleChoice →
 * tappable options; manipulative → the existing `NativeManipulativeItem` card
 * (reused, now routed through this screen's machine binding rather than a
 * second direct submit — it still owns its own grade/verdict/haptics render
 * and routes unsupported kinds to the WebView embed).
 *
 * Retry/advance semantics mirror web: a miss keeps you on the item (Try again),
 * a second miss offers a fresh variant of the same skill; the answer is never
 * revealed. Streak is tracked client-side (the grade payload carries none), used
 * for haptic cadence only — there is no scholar-visible streak counter (the
 * objective-function invariant: signals are diagnostics to read, never scores
 * to display).
 *
 * ORCHESTRATION: `usePracticeMachine` (native's own copy of the web host, in
 * `@/hooks/usePracticeMachine`) plus its coordinator are the SOLE canonical
 * owner of run idx/item phase/hasRecorded/missCount/hint progression/breaker
 * state/lane suspension/persistence/terminal/tune-up completion — this
 * component (the "host") retains only served-item payloads, render-only
 * grade/hint content, the summary log, and lane-local UI (mapping/dialogue/
 * teaching/re-probe/offer/tails). The Socratic "Talk it through" handoff and a
 * durable offline answer outbox both exist here now (mirroring web's
 * persistence layer byte-for-byte via the shared vendored contracts);
 * Placement runs in-app (see the placement gate below), mirroring web.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActionSheetIOS,
  ActivityIndicator,
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { StyleProp, TextStyle } from "react-native";
import Reanimated, {
  FadeInDown,
  Keyframe,
} from "react-native-reanimated";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { fetch as expoFetch } from "expo/fetch";
import { Stack, useGlobalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { successNotify, warningNotify } from "@/components/manipulatives/kit";
import {
  NativeManipulativeItem,
  type NativeManipulativeSubmission,
  type NativeManipulativeSubmitArgs,
} from "@/components/manipulatives/NativeManipulativeItem";
import { SummitHandoff } from "@/components/SummitHandoff";
import { NativePlacement } from "@/components/practice/NativePlacement";
import { FrontierMovedReveal } from "@/components/practice/FrontierMovedReveal";
import { RecoveryArc } from "@/components/practice/RecoveryArc";
import { BonusChooser, type BonusCardSpec } from "@/components/practice/BonusChooser";
import { DispatchCompletionReceipt } from "@/components/DispatchCompletionReceipt";
import {
  StoryMomentCard,
  type StoryMomentCardHandle,
} from "@/components/practice/StoryMomentCard";
import { FAST_MATH_NAME } from "../../vendor/shared/fastMathName";
import { resolveCompletionOffers } from "../../vendor/shared/completionOffers";
import {
  dedupeDispatchCompletionReceipts,
  type DispatchCompletionReceipt as DispatchCompletionReceiptData,
} from "../../vendor/shared/dispatchCompletionReceipt";
import { derivePlaylistDoneness, playlistCompleteEyebrow } from "../../vendor/shared/playlistDoneness";
import {
  PRACTICE_SCOPE_BLOCKED_DETAIL,
  PRACTICE_SCOPE_BLOCKED_HEADLINE,
} from "../../vendor/shared/mathPlanScope";
import { HardwareReturnAdvance } from "@/components/practice/HardwareReturnAdvance";
import {
  PracticePadAnswer,
  PracticePrimaryAction,
  useGuardedPracticeAction,
} from "@/components/practice/NativePracticeControls";
import { PracticeProgressHeader } from "@/components/practice/PracticeProgressHeader";
import { LaunchpadCard } from "@/components/practice/LaunchpadCard";
import {
  InstructionExampleSheet,
  type InstructionExampleContent,
} from "@/components/practice/InstructionExampleSheet";
import { GameBeatCard } from "@/components/practice/GameBeatCard";
import { type PracticeCardFeedback } from "@/components/practice/PracticeVerdictStamp";
import { StemCard } from "@/components/practice/StemCard";
import { PromptVisual } from "@/components/practice/PromptVisual";
import { api, convexSiteUrl, type Id } from "@/lib/convex";
import {
  applyKey,
  choiceSubmitValue,
  isPadAnswerType,
  DONT_KNOW_LABEL,
  UNIT_MISSING_NUDGE,
  UNIT_WRONG_NUDGE,
  type PadAnswerType,
} from "@/lib/practicePad";
import {
  applyKeyToInputBuffer,
  advanceStep,
  classifyVerdict,
  comesBackLine,
  computeTiming,
  formatComesBack,
  isFirstAttempt,
  isLastItem,
  isMultipleChoiceItem,
  mappingPretestProgress,
  MAPPING_PRETEST_MAX_QUESTIONS,
  nextStreak,
  PRACTICE_SESSION_SIZE,
  progressFraction,
  shouldPulseStreak,
  showsMappingFeedback,
  setInputBuffer,
  STREAK_PULSE_DELAY_MS,
  summarize,
  challengeFrontierMove,
  CHALLENGE_OFFER_TITLE,
  CHALLENGE_OFFER_ACCEPT,
  challengeOfferBody,
  type PracticeVerdict,
  HANDOFF_OPENER,
  SPIRAL_HANDOFF_OPENER,
  SPIRAL_COACH_COMPLETE_BODY,
  breakerBody,
  breakerCloseLine,
  breakerControlLabel,
  breakerEasySubmitArgs,
  breakerFreshSubmitArgs,
  breakerControls,
  breakerRecovered,
  makeClientEventId,
  MAPPING_SIT_CAP,
  type BreakerControl,
  PLACEMENT_SLIP_PROMPT,
  PLACEMENT_SLIP_RETRY_LABEL,
  PLACEMENT_SLIP_CONCEDE_LABEL,
} from "../../vendor/shared/practiceLoop";
import { nextTeachingMove, stillStuckAvailable } from "../../vendor/shared/teachingLadder";
import {
  completedHintLadderText,
  hintLadderBlocksMainSubmit,
  resolveHintLadderAttempt,
  type CompletedHintLadderRung,
  type HintLadderRung,
} from "../../vendor/shared/hintLadder";
import {
  segmentBeatLabel,
  segmentBeatVisibleForKind,
  type Segment,
} from "../../vendor/shared/practiceSegments";
import {
  practiceDomainLabel,
  strandHeadlineFor,
} from "../../vendor/shared/practiceDomainLabels";
import type { RunLaunchpad } from "../../vendor/practice/instructionEntries";
import type { RunGameBeat } from "../../vendor/practice/gameBeats";
import { MASTERY_LABELS } from "../../vendor/shared/masteryLexicon";
import { hintForSkill } from "../../vendor/shared/mathPracticeHints";
import {
  CONFIDENCE_LEVELS,
  confidenceValue,
  mismatchReveal,
  type ConfidenceLevel,
} from "../../vendor/practice/calibration";
import {
  hasUnitToken,
  rawAnswersEqual,
  type AnswerType as GradeAnswerType,
} from "../../vendor/practice/answers";
import { superscriptExponents } from "../../vendor/shared/mathNotation";
import {
  buildPracticeClosure,
  RECOVERY_CLOSURE_ENABLED,
  effortShape,
  type PracticeWrap,
  type PracticeSignal,
} from "../../vendor/shared/closureLines";
import { useEnsuredClosure } from "@/hooks/useEnsuredClosure";
import { hasPracticeMath } from "../../vendor/shared/fractions";
import type { PracticePromptVisual } from "../../vendor/shared/practicePromptVisual";
import { FractionText } from "@/components/FractionText";
import { StemText } from "@/components/practice/StemText";
import { WorkedSteps, type FadeResult } from "@/components/practice/WorkedSteps";
import { SpeakableLabel } from "@/components/SpeakableLabel";
import { Markdown } from "@/components/Markdown";
import { StreamingText } from "@/components/StreamingText";
import { chatBubbleStyles } from "@/lib/chatBubbles";
import { makePracticeShellStyles } from "@/lib/practiceShell";
import { parsePracticeDeepLinkParams } from "@/lib/practiceDeepLinkParams";
import { SymbolView } from "expo-symbols";
import { RecordingBar } from "@/components/RecordingBar";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import {
  useImageAttachment,
  type ImageUploadTarget,
} from "@/hooks/useImageAttachment";
import { fonts, useColors } from "@/theme";
import { AppTextInput } from "@/components/AppTextInput";
import {
  usePracticeMachine,
  type LoadedPracticeRun,
  type PracticeHostBindings,
} from "@/hooks/usePracticeMachine";
import { useConvexOnline } from "@/lib/useConvexOnline";
import { nativePracticePersistenceAdapter } from "@/lib/practicePersistenceAdapter";
import { breakerHydrationEvent } from "@/lib/breakerHydration";
import {
  restoreBreakerTriggerItemPayload,
  retireBreakerTriggerItemPayload,
} from "@/lib/breakerItemCache";
import {
  newPracticeState,
  breakerCommandId,
} from "../../vendor/shared/practiceMachine";
import {
  isResumableSnapshot,
  loadResumeSnapshot,
  QUICK_FACTS_SCOPE_KEY,
  type ResumeSnapshot,
} from "../../vendor/shared/practiceResumeContract";
import type { OutboxAnswer } from "../../vendor/shared/practiceOutboxContract";

const COLUMN_MAX_WIDTH = 480;
/** The help row (confidence + hint + honest don't-know) is allowed to run wider
 *  than the problem column / primary CTA — five controls crammed into 480px read
 *  as crowded (Andy, 2026-07-26). */
const HELP_ROW_MAX_WIDTH = 720;

// Advance choreography (mirrors web's rhFloatUp/rhRise in PracticeSession.tsx).
// The solved item floats up off the TOP and fades — travelling the full screen
// height so it truly reads as scrolling away (not a small nudge). The next
// problem's rise-in (FadeInDown) is STAGGERED by ~30% of this exit so the two
// motions read as one continuous scroll rather than a cross-fade.
const SCREEN_H = Dimensions.get("window").height;
const FLOAT_OFF_MS = 340;
const RISE_STAGGER_MS = Math.round(FLOAT_OFF_MS * 0.3); // ≈ 100ms
const FloatOffTop = new Keyframe({
  0: { opacity: 0.92, transform: [{ translateY: 0 }] },
  100: { opacity: 0, transform: [{ translateY: -SCREEN_H }] },
});

type AnswerType =
  | "integer"
  | "decimal"
  | "fraction"
  | "expression"
  | "multipleChoice"
  | "manipulative"
  | "dialogue";

type ServedItem = {
  itemId: string;
  skillKey: string;
  skillLabel: string;
  // The practice domain this item's skill belongs to (mirrors
  // convex/lib/practice/session.ts's ServedItem). Drives the per-item domain
  // chip in a MIXED playlist so the scholar sees the subject switch; single-
  // domain sessions set it to the session domain (chip suppressed).
  domain?: string;
  stem: string;
  answerType: AnswerType;
  /** The measurement unit this item must be answered in, DISPLAY form ("cm³").
   *  Present ⇒ the unit is part of the answer (the server grades value AND
   *  unit), so the pad offers unit keys and an unlabeled answer is nudged back
   *  before it's submitted. Absent ⇒ a unit-free item, unchanged. */
  answerUnit?: string;
  choices?: string[];
  /** Hook-only frame for a linked application in the Go deeper tail. */
  storyHook?: string;
  promptVisual?: PracticePromptVisual;
  manipulativeSpec?: string;
  // Backward-faded worked example (SPIKE — convex/lib/practice/fadedSteps.ts).
  // Present only for a stored practiceItem that carries `workedSteps`; the
  // server has already computed the fade from the scholar's mastery row, so
  // this shape NEVER contains a faded step's real text — only `revealed`
  // steps' `text` and `faded` steps' `blankText`. Mirrors web's ServedItem
  // (convex/lib/practice/session.ts).
  workedSteps?: FadeResult;
  /** The fade level actually applied (0 = fully revealed, steps.length =
   *  fully bare); unused by this screen today but kept for parity with the
   *  server shape. */
  scaffoldLevel?: number;
  // Scholar-facing serving lane (P1e) — "review"/"challenge" drive the item
  // chip; "new"/absent no chip. Mirrors convex/lib/practice/session.ts.
  lane?: "review" | "new" | "challenge" | "stretch" | "mapping";
  // 2-D expression editor signals (mirrors convex/lib/practice/session.ts).
  // `answerShape: "twoD"` marks a genuine fraction/power/root answer that should use
  // the box editor (vs. the remainder/plain expression keypad). `answerFormat`
  // is the L1 scaffold — a NON-LEAKY answer skeleton (numbers → boxes, e.g.
  // `F(_/_)`) the server includes only until the skill is fluent; on a fluent
  // skill it's omitted (L3 — the scholar builds the shape unaided).
  answerShape?: "twoD";
  answerFormat?: string;
  // "Fast math" fact-automaticity sprint markers (mirrors
  // convex/lib/practice/session.ts). `isFactSprint` groups contiguous items into
  // the "Fast math" beat and drives the tactile fact card (bigger numerals +
  // springy keypad); `factKey` is the canonical fact identity (e.g. "mul:7x8"),
  // carried for parity with the server shape.
  isFactSprint?: boolean;
  factKey?: string;
};

// Playlist segments: the kind union, `Segment`, the scholar-facing beat copy,
// the beat-visibility gate, and the ungraded-Launchpad display splice all live
// in the vendored shared owner — identical to what web and the server use.
// These used to be hand-maintained copies here, and the kind union had drifted
// (the server could emit "stretch"; this file never declared it).

// Option D: the day-1 `· mapping` sit builds across short served batches until
// placement converges or the shared fixed ceiling is reached. The header keeps
// that same "up to" ceiling throughout the sitting, and the server finalizes
// placement when that ceiling is reached.

// Extend a run-length `segments` list with `count` more mapping items: grow the
// trailing mapping segment if the run already ends in one (a seamless
// continuation of the same `· mapping` beat), else append a fresh mapping
// segment. Keeps the segment strip + beat headers aligned with appended items.
function appendMappingSegment(prev: Segment[], count: number): Segment[] {
  if (count <= 0) return prev;
  const last = prev[prev.length - 1];
  if (last && last.kind === "mapping") {
    return [...prev.slice(0, -1), { kind: "mapping", count: last.count + count }];
  }
  return [...prev, { kind: "mapping", count }];
}

type Proficiency = "not_started" | "practicing" | "fluent" | "overlearned";

type SubmitResult = {
  correct: boolean;
  /** Present only when this verdict recorded a practice attempt. */
  attemptId?: Id<"practiceAttempts">;
  correctAnswer?: string;
  skillKey: string;
  skillLabel: string;
  repetition: number;
  proficiency: Proficiency;
  accelerated?: boolean;
  // true when the scholar tapped "I haven't learned this yet" — a miss for SR,
  // but supportive copy + move on (never the retry/stuck loop), no answer reveal.
  dontKnow?: boolean;
  // Why a unit item missed: "wrong" = right number, wrong unit ("so close");
  // "missing" = no unit at all (the client gate should have caught it first).
  // Absent on a unit-free item and on any correct answer.
  unitOutcome?: "missing" | "wrong";
  // P1e consolidation: this attempt turned the skill fluent; `comesBackAt` is
  // when it next returns as review ("comes back ~Thursday"). Absent otherwise.
  turnedFluent?: boolean;
  comesBackAt?: number;
  // Option D: graded through the placement path (submitMappingAnswer) —
  // reveal-only measurement, no mastery/streak framing, no retry on a miss.
  mapping?: boolean;
  domainJustMapped?: boolean;
  mappedDomainLabel?: string;
  backOff?: { missStreak: number };
  breakerRecovery?: BreakerRepairPlan;
  breakerRecoveryVerified?: boolean;
  dispatchCompleted?: DispatchCompletionReceiptData[];
};

type LogEntry = { correct: boolean; skillLabel: string; dontKnow?: boolean };

type Phase =
  | "answering"
  | "feedback"
  // "Confirm before you cap" (mapping band): a first typed miss shows the
  // two-way slip/concede choice on the freshly-served confirm item.
  | "retry"
  | "handoff"
  | "breakerRepair"
  | "breakerClose"
  // Offline-tolerant answering: the submit was durably queued rather than
  // graded — no server round-trip landed, so there is no verdict to show.
  // Mirrors web's PracticeSession.tsx "queued" phase.
  | "queued";

// Socratic teachable-moment ("Talk it through") — the native mirror of web's
// handoff (components/practice/PracticeSession.tsx). Reuses the SAME answer-safe
// /practice-handoff route: the tutor is fed ONLY the stem + the wrong answers,
// never the correct answer, and the server redacts any reply that leaks it.
type ChatMsg = { role: "user" | "assistant"; content: string };
// A practice chat is either the after-2-misses Socratic handoff or a dialogue
// stretch item. The honest "I haven't learned this yet" moment instead uses the
// interactive teach-as-action step.
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

/** The server's v2 recovery handle (submitAnswer → `breakerRecovery`): which
 *  node broke and which attempt carries the lifecycle. Deliberately NOT a
 *  serve plan — the fresh same-node item comes from `breakerRecoverySession`,
 *  which re-derives skill + domain from this attempt, so the client can neither
 *  widen the target nor smuggle in an easier node. */
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

/**
 * Resolves the ONE thing `usePracticeMachine`'s initial state must never see
 * change out from under it — `scholarId` — before mounting the real screen.
 * `newPracticeState({ scholarId, ... })` is captured into `useReducer` exactly
 * ONCE, on first render of whatever component calls the hook; unlike web
 * (whose page wrapper never mounts `PracticeSession` until its own scholarId
 * query has resolved), native's screen historically resolved `scholarId`
 * INSIDE the same component via `useQuery`, which would otherwise bake in a
 * permanently-empty `state.scholarId` from the render that ran before
 * `me` settled. `key`s `PracticeScreen` by scholar AND quick-facts mode —
 * mirroring web's `PracticeSession` key exactly — so a URL transition that
 * flips either can never continue the old run's machine in place.
 */

export default function Practice() {
  const me = useQuery(api.users.currentUser, {});
  const scholarId = me?._id as Id<"users"> | undefined;
  const rawParams = useGlobalSearchParams<{ quickFacts?: string }>();
  const { quickFacts } = parsePracticeDeepLinkParams(rawParams);
  if (!scholarId) {
    return (
      <>
        <Stack.Screen options={{ title: "Practice", headerShown: true }} />
        <View style={loadingStyles.centered}>
          <ActivityIndicator />
        </View>
      </>
    );
  }
  return (
    <PracticeScreen
      key={`${scholarId}:${quickFacts ? "q" : "n"}`}
      scholarId={scholarId}
    />
  );
}

const loadingStyles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
});

function PracticeScreen({ scholarId }: { scholarId: Id<"users"> }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const convex = useConvex();
  // `submitAnswer`/`serveHintStep`/`recordBreakerRecoveryLifecycle`/
  // `recordBreakerOutcome`/`practiceTuneups.complete` are now called ONLY
  // inside usePracticeMachine's executor — the machine is the sole canonical
  // owner of submit/hint/breaker-lifecycle/tune-up-completion orchestration,
  // so this component never calls them directly.
  const submitMapping = useMutation(api.practiceSkills.submitMappingAnswer);
  const finalizeCappedMappingRuns = useMutation(
    api.practiceSkills.finalizeCappedMappingRuns,
  );

  const startTuneup = useMutation(api.practiceTuneups.start);
  const logPracticeChoiceMutation = useMutation(api.practiceSkills.logPracticeChoice);

  // Read the practice URL params GLOBALLY, not locally. A native deep link
  // (e.g. `native:///practice?domain=fraction-arithmetic`) mounts this screen's
  // navigator LATE — the whole <Stack> lives behind the async, SecureStore-backed
  // <AuthGate> in _layout.tsx, so it isn't mounted until auth resolves. On that
  // late first paint the focus-scoped `useLocalSearchParams` context can settle
  // EMPTY while the global URL still carries the query, so `?domain=` was silently
  // dropped and practice fell back to the default whole-number mapping check-in.
  // `useGlobalSearchParams` reads the current URL's params directly (the same
  // global-URL semantics web gets from Next's useSearchParams), so the query
  // survives the deep link. `checkin` stays in the type only to document the
  // retired `?checkin=all` param (neutralized exactly like web).
  const rawParams = useGlobalSearchParams<{
    domain?: string;
    domains?: string | string[];
    skill?: string;
    checkin?: string;
    quickFacts?: string;
    choiceDomain?: string;
    choiceStrand?: string;
    // Stretch-tile entry accepts BOTH names: `?stretch=1` (web deep-link
    // contract, app/scholar/practice/page.tsx) and `?stretchHint=1` (native
    // in-app nav from PracticePlaylistCard). Both wire stretchHint into
    // practiceSession (reviews-first + challenge tail).
    stretch?: string;
    stretchHint?: string;
    blend?: string;
  }>();
  // Normalize the raw params in one pure, unit-tested place (mirrors web's
  // param contract): resolve `?domain=` / `?choiceDomain=` to REGISTERED slugs
  // (accepting aliases like "fractions" → "fraction-arithmetic"; an UNKNOWN value
  // becomes undefined = the scholar's default, never a silent whole-number
  // restart), fold `?stretch=`/`?stretchHint=` into one flag, and hand back a
  // value-stable `domainSetKey` for the mixed-playlist memo below.
  const {
    domain: domainParam,
    domainSetKey,
    choiceDomain,
    choiceStrand,
    skillKey,
    isStretch: isStretchHint,
    foldsMappingBand,
    checkInAllDomains,
    quickFacts,
  } = parsePracticeDeepLinkParams(rawParams);
  // A bounded scholar choice from PracticePlaylistCard's "You pick" moment
  // (?choiceDomain=/?choiceStrand=) — mirrors web's choiceHint exactly. Only
  // built when BOTH resolve to something real; passed to practiceSession's
  // choiceHint arg (session.ts weights that strand ×2 in its own domain,
  // ignored for any other blended domain).
  const choiceHint = useMemo(
    () => (choiceDomain && choiceStrand ? { domain: choiceDomain, strand: choiceStrand } : undefined),
    [choiceDomain, choiceStrand],
  );
  // A MIXED playlist blends ≥2 domains (expo-router delivers a repeated param as
  // string[] and a single one as string). ≥2 ⇒ the cross-domain merge; the
  // single-domain placement / re-probe / tune-up flows are skipped for a blend.
  // A stable string key (from the parser) keeps `domainSet` referentially stable
  // across renders (search-param objects are fresh each render) so `loadRun`
  // doesn't churn.
  const domainSet = useMemo(
    () => (domainSetKey ? domainSetKey.split("\u0000") : []),
    [domainSetKey],
  );
  const isMixed = domainSet.length > 1;

  const targetedNode = useQuery(
    api.nodeNeighbourhood.neighbourhood,
    scholarId && skillKey && !quickFacts ? { nodeKey: skillKey } : "skip",
  );
  const targetedSkillKeys = useMemo(
    () => (targetedNode?.node.practiceServeable ? [targetedNode.node.nodeKey] : undefined),
    [targetedNode],
  );
  const domain = quickFacts ? undefined : targetedNode?.node.domain ?? domainParam;

  // The shared practice state machine (vendor/shared/practiceMachine.ts) — the
  // SOLE canonical owner of run idx/item phase/hasRecorded/missCount/hint
  // progression/breaker state/lane suspension/persistence/terminal/tune-up
  // completion. This screen (the "host") retains only served-item payloads,
  // render-only grade/hint content, the summary log, and lane-local UI state.
  // Native's own Convex WebSocket connection state IS the online signal
  // (there is no separate `navigator.onLine` the way web combines one with
  // the socket) — see useConvexOnline.
  const online = useConvexOnline();
  const machineHostRef = useRef<PracticeHostBindings>({
    scholarId,
    loadRun: async () => {
      throw new Error("Practice host bindings are not installed");
    },
    onLoadError: () => {},
    onSubmitError: () => {},
    getTriggerItemPayload: () => null,
    onTriggerItemPersistenceError: () => {},
    onBreakerItem: () => {},
    onHintRung: () => {},
    onHintError: () => {},
    onGrade: () => {},
    onCoach: () => {},
    onHandoff: () => {},
    buildResumeSnapshot: () => null,
    onQueuedCount: () => {},
    onDispatchCompleted: () => {},
    onAnswerQueued: () => {},
  });
  const initialMachineState = useMemo(
    () =>
      newPracticeState({
        scholarId: String(scholarId),
        itemCount: 0,
        suppressBreaker: quickFacts,
      }),
    [quickFacts, scholarId],
  );
  const machine = usePracticeMachine(initialMachineState, scholarId, machineHostRef, {
    online,
  });
  const sendPracticeEvent = machine.send;

  // Auth token for the don't-know explanation stream, held in a ref so a
  // mid-stream refresh doesn't restart it (mirrors NativePlacement).
  const authToken = useAuthToken();
  const authTokenRef = useRef(authToken);
  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  // Transcript choreography (Option B). Wrong answers feed the answer-safe
  // handoff; the ScrollView ref + reduce-motion flag drive the auto-scroll and
  // the rise-in enter motion. "Calm, not confetti" — real Reduce-Motion respect.
  const wrongAnswersRef = useRef<string[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (mounted) setReduceMotion(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) =>
      setReduceMotion(v),
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  // Option D: the default (no-pin) native entry folds the `· mapping` band into
  // the playlist (`loadRun` sets includeMapping) — so the standalone
  // single-domain placement gate retires for it. Only a stretch entry keeps its
  // own (non-mapping) path. The retired `?checkin=all` MIXED check-in surface is
  // gone (neutralized where the search params are read, above).
  const mappingEntry = !isStretchHint;
  const needsPlacement = useQuery(
    api.practiceSkills.needsPlacement,
    scholarId && !quickFacts && !isMixed && !mappingEntry
      ? { scholarId, ...(domain ? { domain } : {}) }
      : "skip",
  );

  // The scholar's daily playlist for the SCOPE this run practiced — the ONE
  // signal that tells the done screen whether the playlist is actually finished
  // (so it says "Playlist complete" + Done) or still has skills queued (so it
  // says "Round complete" + Continue), instead of the old flat "Session
  // complete" + Done eject that contradicted Home. Same query the home card
  // subscribes to; a mixed blend previews its first domain (mirroring the home
  // card's representative-domain read). Subscribed from mount so it has resolved
  // well before the done screen renders — no undefined flash on wrap.
  //
  // QUICK-FACTS CONTAINMENT (web parity, `scopedByProp` in
  // components/practice/PracticeSession.tsx): a Quick-facts round is SCOPED —
  // it serves one deliberate set of facts from the Calculator-license card — so
  // it must not read the daily playlist's doneness at all. Reading it would let
  // the round wrap as a plain playlist wrap and offer a Continue (or a story
  // payoff) into unrelated playlist work the card never promised. Same reason
  // the re-probe and tune-up subscriptions below are skipped for it.
  const donenessDomain = isMixed ? domainSet[0] : domain;
  const playlistDoneness = useQuery(
    api.practiceSkills.playlistForScholar,
    scholarId && !skillKey && !quickFacts
      ? {
          scholarId,
          ...(donenessDomain ? { domain: donenessDomain } : {}),
          ...(choiceHint ? { choiceHint } : {}),
          ...(foldsMappingBand ? { includeMapping: true } : {}),
          platform: "native",
        }
      : "skip",
  );

  const [items, setItems] = useState<ServedItem[] | null>(null);
  const [quickFactsUnavailableReason, setQuickFactsUnavailableReason] = useState<string | null>(null);
  // Playlist segments v1 — parallel run-length metadata over `items` (see the
  // `Segment` type above). `idx`/`total` (shared/practiceLoop) are untouched.
  const [segments, setSegments] = useState<Segment[]>([]);
  // The instructional "Launchpad" — a positioned, UNGRADED beat on this run
  // (`practiceSession.launchpad` = `{at, entry}`). Native had no Launchpad at
  // all before this; the web client also excluded every mixed-domain run, so a
  // scholar on iPad never met instruction. `at` is the index of the first item
  // of the strand it introduces, so the beat lands immediately before the work
  // it explains, and it can only ever introduce a strand this run actually
  // serves. It is a SIBLING of `items`, never a member, which is what makes
  // "never grades, never moves mastery" structural rather than a flag.
  const [launchpad, setLaunchpad] = useState<RunLaunchpad | null>(null);
  const [launchpadDone, setLaunchpadDone] = useState(false);
  // The game BEAT — the Launchpad's sibling, and the answer to "can a game show
  // up in a practice set?" once D-3 forbids a game paying out skill credit. Same
  // shape, same reason: `{at, entry}` beside `items`, never inside it, so `idx`
  // never shifts and nothing here can reach an attempt row. Games are iPad-only
  // (D-5), which a beat handles gracefully where a practice ITEM could not — web
  // renders the capability notice and passes through at zero cost, because the
  // beat was never worth credit in the first place.
  const [gameBeat, setGameBeat] = useState<RunGameBeat | null>(null);
  const [gameBeatDone, setGameBeatDone] = useState(false);
  // Option D: the run is 100% `· mapping` — drives the ceremony-lite skin + the
  // "Your map is started ✨" completion beat. `mappedDomainLabel` names a domain
  // that FINISHED placing this run ("Your tree just filled in ✨").
  const [mappingProgressOffset, setMappingProgressOffset] = useState(0);
  const [mappedDomainLabel, setMappedDomainLabel] = useState<string | null>(null);
  // The OPTIONAL above-band challenge tail (P1e) served alongside the required
  // set — offered on the done screen ("Want a challenge?"), never mixed in.
  const [challengeItems, setChallengeItems] = useState<ServedItem[]>([]);
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
  const [inChallenge, setInChallenge] = useState(false);
  const [firstPostPlacementBlock, setFirstPostPlacementBlock] = useState(false);
  /** The server declined to compose anything because the scholar's Math plan
   *  leaves nothing servable right now (`practiceSession`'s `blocked` flag).
   *  It arrives shaped exactly like a finished block — zero items — so without
   *  reading it we congratulate a scholar for a boundary someone else drew.
   *  Mirrors the web twin (components/practice/PracticeSession.tsx). */
  const [scopeBlocked, setScopeBlocked] = useState(false);
  const [input, setInput] = useState("");
  // The item whose Check was refused for a missing unit — the nudge shows until
  // the next input change. Never a graded outcome: the attempt was not spent.
  // Keyed by itemId (not a bare flag) so it cannot outlive its own item.
  const [unitNudgeItemId, setUnitNudgeItemId] = useState<string | null>(null);
  // "Confirm before you cap" (mapping band): a first typed miss shows the
  // two-way slip/concede choice on the freshly-served confirm item. Lane-local
  // to the mapping band — the machine has no notion of it (mirrors web's
  // `mappingRetry`).
  const [mappingRetry, setMappingRetry] = useState(false);
  const [hintRungs, setHintRungs] = useState<CompletedHintLadderRung[]>([]);
  const [activeHintRung, setActiveHintRung] = useState<{
    rung: Extract<HintLadderRung, { kind: "completion" }>;
    hasMore: boolean;
  } | null>(null);
  const [hintStepError, setHintStepError] = useState<string | null>(null);
  // Teach-as-action gate: after "I haven't learned this yet", the scholar does
  // ONE faded worked step (TeachingStep) in the feedback moment, and Continue is
  // held until they've ATTEMPTED it (or there's no step / the query stalled —
  // TeachingStep unlocks via onReady so Continue never dead-ends). Mirrors web.
  const [dontKnowStepReady, setDontKnowStepReady] = useState(false);
  // Socratic handoff (native mirror of web). null until the kid opens it after
  // 2 misses; then it holds the transcript of the answer-safe tutor chat.
  const [handoff, setHandoff] = useState<HandoffState | null>(null);
  const [handoffInput, setHandoffInput] = useState("");
  // ── Canonical reads from the machine — idx/item phase/hasRecorded/
  // missCount/hint progression/breaker state/lane suspension/terminal are
  // ALL owned by `machine.state`; this component reads them, never mutates
  // them directly. Bound to the SAME local names the JSX below already used,
  // exactly like the web migration, so the render body needed no rewrite.
  const idx = machine.state.run.idx;
  const breaker = machine.state.breaker;
  const missCount = machine.state.item.missCount;
  const hasRecorded = machine.state.item.hasRecorded;
  const allMapping = machine.state.run.allMapping;
  const showHint = machine.state.hint.open;
  const hintItemId = machine.state.hint.itemId;
  const hintStepsExhausted = machine.state.hint.exhausted;
  const hintStepLoading = machine.state.hint.pendingCommandId !== null;
  const done = machine.state.terminal;
  const breakerLifecycleBlocked =
    (breaker?.lifecycle.pending.length ?? 0) > 0;
  const breakerLifecycleRecoveryNeeded =
    breaker?.lifecycle.pending[0]?.status === "recoverable";
  // The rendered phase — DERIVED, not owned state: breaker close/repair and
  // the handoff/dialogue lane outrank everything, the mapping band's own
  // "confirm before you cap" retry is lane-local, and otherwise the item's
  // phase from the machine decides feedback vs. queued vs. answering. Mirrors
  // web's PracticeSession `phase` derivation exactly.
  const phase: Phase =
    breaker?.flow.stage === "close"
      ? "breakerClose"
      : machine.state.lane === "handoff" || machine.state.lane === "dialogue"
        ? "handoff"
        : breakerLifecycleRecoveryNeeded
          ? "breakerRepair"
        : breaker?.flow.stage === "repair"
          ? "breakerRepair"
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
  // ONE staged image for the "talk me through it" chat. The send body carries
  // exactly one `imageId`, so a second parallel slot would silently drop one.
  const chatImage = useImageAttachment();
  const clearChatImage = chatImage.clear;
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  // Host-local "something async and lane-specific is in flight" flag — the
  // mapping submit/continuation fetch, "try a fresh variant", and reporting
  // help-used all live entirely outside the machine. `busy` (below) is the
  // WIDELY-consumed prop every CTA/lane component disables on; it folds this
  // in alongside the machine's OWN busy signals so neither surface needs two
  // separate "disable me" props.
  const [laneBusy, setLaneBusy] = useState(false);
  const breakerEasyLoading =
    !!breaker &&
    breaker.flow.easy === undefined &&
    breaker.easyItemId === null &&
    (breaker.easyRequested ||
      breaker.emitted.includes(
        breakerCommandId(breaker.triggerAttemptId, "easy"),
      ));
  const busy =
    laneBusy ||
    machine.state.item.phase.kind === "submitting" ||
    hintStepLoading ||
    breakerEasyLoading ||
    breakerLifecycleBlocked ||
    machine.state.run.pendingLoad !== null;
  const [error, setError] = useState<string | null>(null);
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
  // How many answers currently sit in the offline outbox — render-only; the
  // machine tells the host via `onQueuedCount` on mount and after every
  // enqueue/drain pass. Surfaced on the done screen (mirrors web).
  const [queuedCount, setQueuedCount] = useState(0);
  const outboxStatusText = !online
    ? "You're offline — keep going. We'll check saved answers when you're back."
    : queuedCount > 0
      ? `Checking ${queuedCount} saved answer${queuedCount === 1 ? "" : "s"}…`
      : null;
  // Consecutive-correct count — no longer shown (the scholar-visible streak chip
  // was removed per the objective-function invariant); retained only to drive the
  // hidden milestone haptic in the grade path. A REF, not state: `onGrade`
  // fires a side effect (a delayed haptic) alongside updating it, and a React
  // state updater may be replayed (Strict Mode double-invokes it in dev), which
  // would double the haptic. Mirrors the web PracticeSession fix exactly.
  const streakRef = useRef(0);

  // Predict-then-Check calibration: the kid's OPTIONAL pre-answer confidence for
  // the current item (null = skipped). `revealPrediction` freezes the confidence
  // value used for the RECORDED first attempt so the feedback mismatch reveal
  // reflects that attempt only. Both reset per new item.
  const [predictedConfidence, setPredictedConfidence] = useState<ConfidenceLevel | null>(null);
  const [helpReported, setHelpReported] = useState(false);
  // In-flight guard so a fast double-tap can't race the press against its undo.
  const [helpPending, setHelpPending] = useState(false);
  // The item the current admission queued, so an un-press can withdraw exactly
  // that one. A ref, not state: it is only ever read on the undo path, which a
  // press in this same feedback view must always precede — so it cannot be
  // stale, and it needs no clearing at the many places the pill resets.
  const helpRetryItemIdRef = useRef<string | null>(null);
  const [revealPrediction, setRevealPrediction] = useState<number | null>(null);
  // The consolidation "comes back ~Thursday" line (P1e), precomputed in the
  // submit handler (Date.now() is impure — must not be called during render) and
  // shown on the correct-verdict card. Null when the attempt didn't consolidate.
  const [comesBackText, setComesBackText] = useState<string | null>(null);

  // Tune-up checkpoint (§4B) — the RN analogue of web's PracticeSession flow.
  // Once accepted, the sampled skills drive an ordinary scoped session (same
  // serve/grade path); `tuneupSkillKeys` non-null means we're inside a run. The
  // record id lives in a ref (the mutation handle `completeTuneup` needs); the
  // reducer owns "has this run's completion already been patched" via the
  // terminal transition — no separate completed-latch on this side.
  const [tuneupSkillKeys, setTuneupSkillKeys] = useState<string[] | null>(null);
  const [tuneupDismissed, setTuneupDismissed] = useState(false);
  const tuneupIdRef = useRef<Id<"practiceTuneups"> | null>(null);
  const inTuneup = tuneupSkillKeys !== null;

  // "More of your pick" done-screen bonus (§C-3) — the RN analogue of the same
  // web flow. Only offered when the session ran with a `choiceHint` (the
  // scholar picked a strand on the home card / PracticePlaylistCard). Accepting
  // fetches a few more same-strand skills (bonusSkillsForChoice) and re-enters
  // an ordinary scoped session with them — same mechanism as a tune-up's scoped
  // re-entry, just no separate practiceTuneups record.
  const [bonusMoreSkillKeys, setBonusMoreSkillKeys] = useState<string[] | null>(null);
  const [bonusMoreLoading, setBonusMoreLoading] = useState(false);
  const inBonusMore = bonusMoreSkillKeys !== null;

  // Server decides every trigger condition (pool ≥ 6, interval elapsed). Only
  // in whole-graph practice — never inside an active tune-up, a "more of your
  // pick" bonus round, after a dismiss, or in a scoped Quick-facts round
  // (containment: accepting a tune-up here would swap the promised facts for
  // unrelated retention work AND write a `practiceTuneups` record).
  const tuneupOffer = useQuery(
    api.practiceTuneups.offerForScholar,
    scholarId && !quickFacts && !isMixed && !inTuneup && !inBonusMore && !tuneupDismissed
      ? { scholarId, ...(domain ? { domain } : {}) }
      : "skip",
  );

  // Strand re-probe offer (§4 B1-M2) — the RN analogue of web's ReprobeOffer.
  // After a session the engine may flag a strand where the scholar keeps getting
  // accelerated + has headroom (an under-placement signal). The offer shows on
  // the done screen and takes priority over the tune-up offer (the higher-value
  // jump-ahead signal). `reprobeResolved` hides it once handled; it resets on the
  // next session load, so a fresh wrap can surface a new one. Skipped for a
  // scoped Quick-facts round for the same containment reason as above.
  const [reprobeResolved, setReprobeResolved] = useState(false);
  const reprobe = useQuery(
    api.practiceSkills.reprobeCandidates,
    scholarId && !quickFacts && !isMixed && !inTuneup
      ? { scholarId, ...(domain ? { domain } : {}) }
      : "skip",
  );

  // Moments: the story reveal card (§ raise-the-ceiling — one quiet
  // skill→world story after a durable fluency transition, server-arbitrated
  // rarity). Native has no teacher-rehearsal (?remote=) mode, so no gate is
  // needed beyond having a resolved scholarId.
  const storyMomentLive = useQuery(
    api.practiceMoments.storyMomentForScholar,
    scholarId ? { scholarId } : "skip",
  );
  // FREEZE the first moment we see — the card's own recordMomentOffered insert
  // is itself a momentEvents row, so this same reactive query flips to null
  // the instant it lands (the 20h global-cooldown check now sees that very
  // insert as "already offered recently"); without freezing, the card would
  // flash and immediately vanish. Mirrors the web PracticeSession fix exactly.
  // `storySettled` tracks the completion arbiter's "settled" transition (see
  // shared/completionOffers.ts, vendored) — set either by the card itself
  // (reveal/save/dismiss) or imperatively by this parent when the scholar
  // starts a bonus run without touching the card, and reset whenever a
  // genuinely new moment (a different edge) arrives.
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
    // render. Mirrors the web PracticeSession fix exactly.
    const isNewMoment =
      !storyMoment ||
      storyMoment.fromKey !== storyMomentLive.fromKey ||
      storyMoment.toKey !== storyMomentLive.toKey;
    if (isNewMoment) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- commits a server-arbitrated new moment before its reactive query clears after recording.
      setStoryMoment(storyMomentLive);
      setStorySettled(false);
    }
  }, [storyMomentLive, storyMoment]);

  // The seed the CURRENT run was loaded with — plain state (not a ref): it is
  // set once per `loadRun` call alongside the many other per-run resets there,
  // and read back only by the mapping submission path (which grades through
  // its own `submitMappingAnswer` mutation, keyed by the same seed the item
  // was served with).
  const [runSeed, setRunSeed] = useState(0);
  const itemRenderAtRef = useRef<number>(0);
  const firstKeyAtRef = useRef<number | null>(null);

  // Placement gate (§iPad parity): a brand-new scholar takes the placement quiz
  // first, in-app (NativePlacement), mirroring web — no more "do it on the web".
  // `needsPlacement` flips false the instant submitPlacementAnswer seeds mastery
  // on finalize, so we latch that we entered placement (`enteredPlacement`) and keep
  // the flow mounted until the scholar taps "Start practicing" (`placementDone`);
  // otherwise the result screen would be yanked out from under them.
  //
  // The latch is COMMITTED state set from an effect, not a ref written during
  // render. It is monotonic and decides which screen renders, so a render React
  // abandons (concurrent rendering, StrictMode's double invoke) must not be able
  // to set it: once wrongly true it would stay true for the whole mount and
  // permanently suppress the Launchpad and game doorways further down.
  const [placementDone, setPlacementDone] = useState(false);
  const [enteredPlacement, setEnteredPlacement] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- latches entry after the server placement gate arrives so its result screen cannot be yanked away.
    if (needsPlacement === true) setEnteredPlacement(true);
  }, [needsPlacement]);

  const current = items?.[idx];
  // Kindergarten (grade "K") items get a tap-to-hear speaker on the question
  // stem for pre-readers. `ServedItem` doesn't carry the node's grade band, so
  // resolve it from the served skillKeys (cheap indexed batch read); the
  // speaker shows only for grade-"K" items (and only when the scholar's TTS is
  // on — SpeakableLabel enforces that).
  const stemSkillKeys = useMemo(
    () => (items ? Array.from(new Set(items.map((it) => it.skillKey))) : []),
    [items],
  );
  const gradeBandByKey = useQuery(
    api.practiceSkills.gradeBandsForKeys,
    stemSkillKeys.length > 0 ? { skillKeys: stemSkillKeys } : "skip",
  );
  const currentIsKinder = !!current && gradeBandByKey?.[current.skillKey] === "K";
  // "See an example" idea shelf (instructional segments v1, native parity —
  // #native-idea-shelf-parity): the verified strand-level worked example for
  // the CURRENT item's strand, if any. The RN twin of web's `strandExample`
  // (components/practice/PracticeSession.tsx) — same query, `platform:
  // "native"` so an author who only verified a web-shaped Launchpad never
  // surfaces it here. Skipped for a `· mapping` placement probe (silent
  // measurement, no instructional beat) exactly as web skips it there.
  const strandExample = useQuery(
    api.instruction.instructionContentForSkill,
    scholarId && current?.skillKey && current.lane !== "mapping"
      ? { scholarId, skillKey: current.skillKey, platform: "native" }
      : "skip",
  ) as (InstructionExampleContent & { key: string }) | null | undefined;
  const [exampleSheetOpen, setExampleSheetOpen] = useState(false);
  const hintRungActiveForCurrent =
    hintItemId === current?.itemId && activeHintRung !== null;
  const hintBlocksMainSubmit = hintLadderBlocksMainSubmit({
    servePending: hintStepLoading,
    activeCompletion: hintRungActiveForCurrent,
  });
  const currentItemId = current?.itemId;
  const practiceImageTarget = useCallback(
    (source: "handoff" | "dialogue"): ImageUploadTarget | null => {
      if (!scholarId || !currentItemId || !authToken) return null;
      const query = new URLSearchParams({
        scholarId,
        itemId: currentItemId,
        source,
      });
      return {
        url: `${convexSiteUrl}/practice-image-upload?${query.toString()}`,
        headers: { Authorization: `Bearer ${authToken}` },
      };
    },
    [authToken, currentItemId, scholarId],
  );

  // A staged image belongs to THIS problem only — drop it when the problem
  // changes, so last problem's work can never bleed into the next one's chat.
  // Phase changes within a problem keep it, while a retry keeps the same item.
  useEffect(() => {
    clearChatImage();
  }, [currentItemId, clearChatImage]);

  // Playlist segments v1: derive per-index segment membership from the
  // run-length `segments` list. Mirrors web's PracticeSession.tsx.
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
  const currentSegmentIdx = segmentOfIdx[idx];
  const currentSegment = currentSegmentIdx != null ? segments[currentSegmentIdx] : undefined;
  // A light beat header shows only on the FIRST item of a segment — never
  // repeated per item inside it.
  const isSegmentStart = currentSegmentIdx != null && segmentStartIdx[currentSegmentIdx] === idx;
  const isFirstCoreDrillSegment =
    currentSegment?.kind === "core_drill" &&
    segments.slice(0, currentSegmentIdx).every((s) => s.kind !== "core_drill");

  // Keep the active item / newest handoff turn pinned to the bottom as solved
  // items accumulate above (chat-family behavior). Calm-motion aware — jumps
  // instead of animating when the OS asks to reduce motion.
  //
  // `current?.itemId` is in the deps (not just `idx`) because on the FIRST
  // item this screen still renders its "Loading your practice…" placeholder
  // (no ScrollView, so `scrollRef.current` is null) at the moment idx/phase
  // first settle — `items` (and so `current`) arrives a beat later with those
  // same dependency values unchanged, so without this the effect never
  // re-fires once the ScrollView actually mounts. H3 web twin:
  // components/practice/PracticeSession.tsx.
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: !reduceMotion });
  }, [idx, phase, current?.itemId, handoff?.messages.length, reduceMotion]);

  const resetHostRun = useCallback(() => {
    setInput("");
    setResult(null);
    setHandoff(null);
    setHandoffInput("");
    wrongAnswersRef.current = [];
    setLog([]);
    setError(null);
    setQuickFactsUnavailableReason(null);
    streakRef.current = 0;
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
    setMappingProgressOffset(0);
    setMappedDomainLabel(null);
    setDispatchCompleted([]);
    setMappingRetry(false);
    setHintRungs([]);
    setActiveHintRung(null);
    setHintStepError(null);
    setDontKnowStepReady(false);
    setComesBackText(null);
  }, []);

  // The narrower per-ITEM reset (a fresh variant, a breaker item install) —
  // everything `resetHostRun` resets EXCEPT the whole-run bookkeeping
  // (log/streak/challenge-tail/scope-blocked/mapping-progress/dispatch
  // receipts) that only makes sense when a NEW RUN loads, not when one item
  // in an ongoing run is swapped for another. Mirrors web's
  // `resetItemHostState`.
  const resetItemHostState = useCallback(() => {
    setResult(null);
    setComesBackText(null);
    setInput("");
    setHintRungs([]);
    setActiveHintRung(null);
    setHintStepError(null);
    setError(null);
    wrongAnswersRef.current = [];
    setHandoff(null);
    setHandoffInput("");
    setDialogueVerdict(null);
    setPredictedConfidence(null);
    setHelpReported(false);
    setRevealPrediction(null);
    setMappingRetry(false);
  }, []);

  // The `loadRun` half of `PracticeHostBindings` — the machine decides WHEN a
  // payload may replace the current run (`run:loaded`'s freshness/all-mapping
  // rules); this owns WHAT gets served: resume-first (unless `forceFresh`),
  // then Quick Facts' own direct round, then an ordinary/targeted/tune-up/
  // bonus-more serve. `inputKey` is accepted but not re-derived here — the
  // caller (the effect below) is the one place `sessionInputKey` is built.
  const loadRun = useCallback(
    async (inputKey: string, forceFresh: boolean): Promise<LoadedPracticeRun> => {
      setItems(null);
      resetHostRun();
      let discardResume = forceFresh;
      const seed = Math.floor(Math.random() * 2_000_000_000);
      setRunSeed(seed);

      if (!forceFresh) {
        const currentScope = await convex.query(
          api.practiceSkills.practiceScopeSnapshotKey,
          { scholarId },
        );
        // Quick Facts is scheduled from factFluency rather than a Math-plan
        // scope, so `practiceScopeSnapshotKey` (an ordinary-domain query)
        // can't name its scope — substitute the same fixed sentinel the
        // server stamps on a Quick Facts serve (see startQuickFactsPractice),
        // so a Quick Facts snapshot only ever validates against a Quick
        // Facts inputKey, never an ordinary domain's (or vice versa).
        // `dayKey` still tracks the real institution-local calendar day
        // regardless of mode.
        const validity = {
          inputKey,
          scopeKey: quickFacts ? QUICK_FACTS_SCOPE_KEY : currentScope.scopeKey,
          dayKey: currentScope.dayKey,
        };
        const snapshot = await loadResumeSnapshot<ServedItem, Segment, RunLaunchpad>(
          nativePracticePersistenceAdapter,
          String(scholarId),
        );
        if (
          isResumableSnapshot(snapshot, validity) &&
          !(
            snapshot.allMapping &&
            (snapshot.mappingProgressOffset ?? 0) + snapshot.resumeIdx >= MAPPING_SIT_CAP
          )
        ) {
          setItems(snapshot.items);
          setSegments(snapshot.segments ?? []);
          setLaunchpad(snapshot.launchpad ?? null);
          setLaunchpadDone(false);
          setGameBeat(null);
          setGameBeatDone(false);
          setMappingProgressOffset(snapshot.mappingProgressOffset ?? 0);
          setMappedDomainLabel(snapshot.mappedDomainLabel ?? null);
          setChallengeItems([]);
          setStretchItems([]);
          const item = snapshot.items[snapshot.resumeIdx];
          return {
            itemCount: snapshot.items.length,
            itemId: item?.itemId ?? null,
            scopeKey: snapshot.scopeKey,
            dayKey: snapshot.dayKey,
            allMapping: !!snapshot.allMapping,
            tuneupId: tuneupIdRef.current,
            resume: {
              idx: snapshot.resumeIdx,
              hasRecorded: false,
              itemId: item?.itemId ?? null,
            },
          };
        }
        // A snapshot existed but didn't validate (a different run, a scope/day
        // rollover, or an all-mapping sit already past its cap) — drop it so
        // a stale outbox-adjacent artifact can never resurrect.
        discardResume = snapshot !== null;
      }

      // Quick Facts serves the DIRECT Fast math round (its own generator, its
      // own QUICK_FACTS_SCOPE_KEY sentinel scopeKey) — no launchpad, no mapping
      // band, no challenge/stretch tail, none of practiceSession's Sprint gates.
      if (quickFacts) {
        const res = await convex.query(api.practiceSkills.startQuickFactsPractice, {
          scholarId,
          seed,
          size: PRACTICE_SESSION_SIZE,
        });
        setItems(res.items as ServedItem[]);
        setSegments((res as { segments?: Segment[] }).segments ?? []);
        setLaunchpad(null);
        setLaunchpadDone(false);
        setGameBeat(null);
        setGameBeatDone(false);
        setChallengeItems([]);
        setStretchItems([]);
        setQuickFactsUnavailableReason(
          res.available ? null : (res.unavailableReason ?? "generator_unavailable"),
        );
        return {
          itemCount: res.items.length,
          itemId: (res.items[0] as ServedItem | undefined)?.itemId ?? null,
          scopeKey: res.scopeKey,
          dayKey: res.dayKey,
          allMapping: false,
          tuneupId: tuneupIdRef.current,
          ...(discardResume ? { discardResume: true } : {}),
        };
      }
      await finalizeCappedMappingRuns({ scholarId });
      // A tune-up or "more of your pick" bonus round scopes to its sampled
      // skills; otherwise a targeted `?skill=` deep link, else the whole-graph
      // default. Read from closure (not a param) — the SAME reason web's
      // `loadSession` (this file's `loadRun`) does: setting `tuneupSkillKeys`/`bonusMoreSkillKeys`
      // changes `sessionInputKey`, which re-runs this through the effect below
      // with the freshest values already committed.
      const activeKeys = tuneupSkillKeys ?? bonusMoreSkillKeys ?? targetedSkillKeys;
      const isTargetedRun =
        tuneupSkillKeys === null && bonusMoreSkillKeys === null && targetedSkillKeys !== undefined;
      // A tune-up / bonus-more round serves exactly its sampled skills (one
      // item each) so the item count matches the offer's `count` / recorded
      // `total`; normal and map-targeted practice fill a full block.
      const size =
        activeKeys && activeKeys.length > 0 && !isTargetedRun
          ? activeKeys.length
          : PRACTICE_SESSION_SIZE;
      // Scoped serve domain: a "more of your pick" bonus round's keys come
      // from `choiceHint.domain`, which is NOT necessarily this session's
      // `domain` (an in-set You-Pick runs the blend on another domain — see
      // the web twin, PracticeSession.tsx). Everything else keeps this
      // session's `domain` (omitted for a blend).
      const serveDomain = bonusMoreSkillKeys && choiceHint ? choiceHint.domain : domain;
      const res = await convex.query(api.practiceSkills.practiceSession, {
        scholarId,
        size,
        seed,
        ...(activeKeys ? { skillKeys: activeKeys } : isMixed ? { domains: domainSet } : {}),
        ...(serveDomain && !isMixed ? { domain: serveDomain } : {}),
        ...(choiceHint ? { choiceHint } : {}),
        // Stretch-tile entry: reviews-first + challenge-tail (mirrors web).
        // Cleared for tune-up/bonus-more runs (those are not stretch sessions).
        ...(isStretchHint && !activeKeys ? { stretchHint: true } : {}),
        // Option D: fold the `· mapping` band into the DEFAULT (no-pin) daily
        // playlist — never for a scoped / tune-up / bonus / stretch run, and
        // never for an explicit single-domain entry.
        ...(!activeKeys && !isStretchHint && foldsMappingBand ? { includeMapping: true } : {}),
        // This is the iPad. Games are iPad-only (D-5), so only this client asks
        // for a game beat — see the arg's comment in practiceSkills.ts.
        canPlayGames: true,
        // §4/finding-4: this IS the native client — a Launchpad authored
        // web-only (or native-only) must be gated accordingly.
        platform: "native",
      });
      setItems(res.items as ServedItem[]);
      setSegments((res as { segments?: Segment[] }).segments ?? []);
      setLaunchpad(activeKeys ? null : ((res as { launchpad?: RunLaunchpad }).launchpad ?? null));
      setLaunchpadDone(false);
      setGameBeat(activeKeys ? null : ((res as { gameBeat?: RunGameBeat }).gameBeat ?? null));
      setGameBeatDone(false);
      const loadedAllMapping = !activeKeys && !!(res as { allMapping?: boolean }).allMapping;
      setMappingProgressOffset(
        !activeKeys
          ? ((res as { mappingProgressOffset?: number }).mappingProgressOffset ?? 0)
          : 0,
      );
      setFirstPostPlacementBlock(
        !activeKeys && !!(res as { firstPostPlacementBlock?: boolean }).firstPostPlacementBlock,
      );
      // The plan-scope boundary. Kept for scoped runs too: a targeted set whose
      // skills all sit outside the scholar's current scope is blocked for
      // exactly the same reason, and a summit read would be just as untrue.
      setScopeBlocked(!!(res as { blocked?: boolean }).blocked);
      // Challenge tail: only after a whole-graph required set (never a tune-up
      // scoped run, which sends none).
      setChallengeItems(
        activeKeys ? [] : ((res as { challenge?: ServedItem[] }).challenge ?? []),
      );
      setStretchItems(
        activeKeys ? [] : ((res as { stretch?: ServedItem[] }).stretch ?? []),
      );
      if (!res.scopeKey || !res.dayKey) {
        throw new Error("Practice run is missing its scope/day identity");
      }
      return {
        itemCount: res.items.length,
        itemId: (res.items[0] as ServedItem | undefined)?.itemId ?? null,
        scopeKey: res.scopeKey,
        dayKey: res.dayKey,
        allMapping: loadedAllMapping,
        tuneupId: tuneupIdRef.current,
        ...(discardResume ? { discardResume: true } : {}),
      };
    },
    [
      convex,
      scholarId,
      domain,
      isMixed,
      domainSet,
      tuneupSkillKeys,
      bonusMoreSkillKeys,
      targetedSkillKeys,
      choiceHint,
      isStretchHint,
      foldsMappingBand,
      finalizeCappedMappingRuns,
      quickFacts,
      resetHostRun,
    ],
  );

  // ── Option D (F1): the mapping-sit recomposition loop ──────────────────────
  // A day-1 `· mapping` sit builds ACROSS recompositions: each served batch is
  // short, and when it's exhausted we re-query `practiceSession` for the NEXT
  // probes (placement not yet converged) and append them so the sit continues
  // seamlessly. Returns the appended mapping items (empty when the server has no
  // more mapping today or the cap is already hit). Mirrors web.
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
          ...(isMixed ? { domains: domainSet } : {}),
          ...(domain && !isMixed ? { domain } : {}),
          ...(choiceHint ? { choiceHint } : {}),
          includeMapping: true,
          platform: "native",
        });
        const more = (res.items as ServedItem[]).filter((it) => it.lane === "mapping");
        return more.slice(0, Math.max(0, room));
      } catch {
        return [];
      }
    },
    [convex, scholarId, domain, isMixed, domainSet, choiceHint, mappingProgressOffset],
  );

  // The full input-identity fingerprint for this run — every axis that
  // defines what this screen serves. Mirrors web's PracticeSession
  // `sessionInputKey` exactly: the machine treats a change here as "a
  // different run", and a persisted resume snapshot must match it exactly to
  // restore.
  const sessionInputKey = [
    domain ?? "",
    isMixed ? domainSet.join("\u0000") : "",
    skillKey ?? "",
    (tuneupSkillKeys ?? []).join("\u0000"),
    (bonusMoreSkillKeys ?? []).join("\u0000"),
    choiceHint?.domain ?? "",
    choiceHint?.strand ?? "",
    isStretchHint ? "1" : "",
    foldsMappingBand ? "m" : "",
    quickFacts ? "Q" : "",
  ].join("|");

  // Reactively query the scholar's active breaker episode (survives a
  // relaunch — the server, not client memory, is authoritative) and hydrate
  // the machine from its projection. A live episode outranks loading an
  // ordinary run: the effect returns after `hydrate:breaker` without ever
  // dispatching `run:inputsChanged`, so a relaunch mid-breaker never re-serves
  // (or re-alerts on) the interrupted playlist underneath it. `hydrate:breaker`
  // itself is idempotent against the SAME episode (`sameBreakerEpisode`), so
  // two consecutive relaunches settle into the identical breaker state rather
  // than re-alerting or regrading.
  const activeBreakerEpisode = useQuery(api.practiceSkills.activeBreakerEpisode, {
    scholarId,
  });
  const breakerPayloadLoadRef = useRef<string | null>(null);
  const projectedBreakerRef = useRef<{
    triggerAttemptId: string;
    triggerItemId: string | null;
  } | null>(null);
  useEffect(() => {
    // Option D: the default mapping entry doesn't wait for a placement gate —
    // the `· mapping` band loads with the playlist. Other single-domain
    // entries still wait until `needsPlacement` resolves false. The check-in
    // accelerator replaces the ambient playlist for this mount (NativePlacement
    // renders instead), so don't waste a load on a playlist we won't show.
    if (skillKey && (!targetedNode || !targetedNode.node.practiceServeable)) return;
    if (checkInAllDomains) return;
    if (!quickFacts && !isMixed && !mappingEntry && needsPlacement !== false) return;
    if (activeBreakerEpisode === undefined) return;
    if (activeBreakerEpisode) {
      projectedBreakerRef.current = {
        triggerAttemptId: String(activeBreakerEpisode.triggerAttemptId),
        triggerItemId: activeBreakerEpisode.triggerItemId ?? null,
      };
      // A cold relaunch mid-"repair"/"coach" short-circuits BEFORE this point
      // ever reaches `run:inputsChanged` (see the early return two lines
      // down), so `items` — whatever a fresh mount's initial null is — would
      // otherwise never get populated at all: there is no OTHER load path
      // this render can take. Install the durably-cached trigger item's
      // payload (written the moment this same episode originally opened) so
      // the repair/coach screen has something real to paint. Fresh/easy
      // stages don't need this: those items are server-pinned and get
      // reconstructed by the reducer's own `serveBreakerFresh`/
      // `serveBreakerEasy` commands (idempotent re-serves), which the
      // executor already handles.
      const stage = activeBreakerEpisode.flow.stage;
      const triggerAttemptId = String(activeBreakerEpisode.triggerAttemptId);
      const triggerItemId = activeBreakerEpisode.triggerItemId ?? null;
      const payloadKey =
        stage === "repair" || stage === "coach"
          ? `${triggerAttemptId}:${triggerItemId ?? ""}`
          : null;
      const alreadyInstalled =
        triggerItemId !== null &&
        items?.some((item) => item.itemId === triggerItemId) === true;
      if (payloadKey && !triggerItemId) {
        if (breakerPayloadLoadRef.current !== payloadKey) {
          breakerPayloadLoadRef.current = payloadKey;
          void Promise.resolve().then(() => {
            if (breakerPayloadLoadRef.current !== payloadKey) return;
            setError(
              "This repair is missing its saved practice item. Return home and try practice again.",
            );
          });
        }
        return;
      }
      if (
        payloadKey &&
        triggerItemId &&
        !alreadyInstalled &&
        breakerPayloadLoadRef.current !== payloadKey
      ) {
        breakerPayloadLoadRef.current = payloadKey;
        void restoreBreakerTriggerItemPayload<ServedItem>(
          nativePracticePersistenceAdapter,
          String(scholarId),
          triggerAttemptId,
          triggerItemId,
        ).then((restored) => {
          if (breakerPayloadLoadRef.current !== payloadKey) return;
          if (restored.status === "ready") {
            if (!restored.bindingOutcome.ok) {
              console.error(
                "practice breaker trigger-item binding failed:",
                restored.bindingOutcome.error,
              );
            }
            setItems([restored.item]);
          } else if (restored.status === "unreadable") {
            console.error(
              "practice breaker trigger-item cache is unreadable:",
              restored.error,
            );
            setError(
              "This iPad couldn't read the saved repair safely. Return home and try practice again.",
            );
          } else if (restored.status === "mismatch") {
            console.error("practice breaker trigger-item cache mismatch:", {
              triggerAttemptId,
              triggerItemId,
              cachedItemIds: restored.cachedItemIds,
              cachedTriggerAttemptIds: restored.cachedTriggerAttemptIds,
            });
            setError(
              "The saved repair doesn't match this practice episode. Return home and try practice again.",
            );
          } else {
            setError(
              "That repair wasn't saved on this iPad, so it can't be restored. Return home and try practice again.",
            );
          }
        });
        // Do not acknowledge the server episode to the local machine until a
        // committed render payload is installed. The next render observes the
        // exact item in `items`, then dispatches the canonical hydration event.
        return;
      }
      if (payloadKey && triggerItemId && !alreadyInstalled) {
        return;
      }
      sendPracticeEvent(breakerHydrationEvent(activeBreakerEpisode));
      return;
    }
    breakerPayloadLoadRef.current = null;
    const retired = projectedBreakerRef.current;
    projectedBreakerRef.current = null;
    if (retired) {
      void retireBreakerTriggerItemPayload<ServedItem>(
        nativePracticePersistenceAdapter,
        String(scholarId),
        retired.triggerAttemptId,
      ).then((outcome) => {
        if (!outcome.ok) {
          console.error(
            "practice breaker trigger-item retirement failed:",
            outcome.error,
          );
        }
      });
    }
    sendPracticeEvent({ type: "run:inputsChanged", inputKey: sessionInputKey });
  }, [
    activeBreakerEpisode,
    checkInAllDomains,
    machine.state.run.inputKey,
    machine.state.run.pendingLoad?.id,
    mappingEntry,
    needsPlacement,
    isMixed,
    items,
    quickFacts,
    scholarId,
    sendPracticeEvent,
    sessionInputKey,
    skillKey,
    targetedNode,
  ]);

  // Accept a tune-up: record it, then re-enter a session scoped to its sampled
  // skills. Setting `tuneupSkillKeys` changes `sessionInputKey`, which re-runs
  // `loadRun` through the effect above — no explicit reload dispatch needed.
  // A server decline (interval re-check) just dismisses the offer.
  const onAcceptTuneup = useCallback(async () => {
    if (!tuneupOffer) return;
    try {
      const { tuneupId } = await startTuneup({
        scholarId,
        ...(domain ? { domain } : {}),
        skillKeys: tuneupOffer.skillKeys,
      });
      tuneupIdRef.current = tuneupId;
      setTuneupSkillKeys(tuneupOffer.skillKeys);
    } catch {
      setTuneupDismissed(true);
    }
  }, [tuneupOffer, scholarId, startTuneup, domain]);

  // Accept "More of your pick": fetch a few more same-strand skills
  // (bonusSkillsForChoice), log the pick (best-effort, mirrors
  // PracticePlaylistCard's home_choice logging), then re-enter a session
  // scoped to them (setting `bonusMoreSkillKeys` re-runs `loadRun` via the
  // effect above). A strand that has nothing left right now is a quiet no-op
  // — the calm default (Done / Practice again) stays available either way.
  const onAcceptBonusMorePick = useCallback(async () => {
    if (!choiceHint || bonusMoreLoading) return;
    setBonusMoreLoading(true);
    try {
      const res = await convex.query(api.practiceSkills.bonusSkillsForChoice, {
        domain: choiceHint.domain,
        strand: choiceHint.strand,
        count: 4,
      });
      if (res.skillKeys.length === 0) return;
      const clientPickId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `bonus-more-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      logPracticeChoiceMutation({
        domain: choiceHint.domain,
        strand: choiceHint.strand,
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
  }, [choiceHint, bonusMoreLoading, convex, logPracticeChoiceMutation]);

  // "Practice again": from a finished tune-up or bonus-more round, drop back to
  // whole-graph practice (clearing the scope); otherwise reload a fresh normal
  // session. Clearing a scoped tail changes `sessionInputKey`, so that path
  // reloads through `run:inputsChanged`; an ordinary run has no identity
  // change, so it explicitly sends `run:reloadRequested`.
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

  // Leave practice for the home screen ("My Sessions"). Practice can be reached
  // via a deep push chain (Home → Sky → NodeSheet → Practice), so pop the whole
  // stack back to its root rather than a single router.back() that could strand
  // the scholar on an intermediate screen.
  const goHome = useCallback(() => {
    if (router.canDismiss()) router.dismissAll();
    else router.replace("/");
  }, [router]);

  // Opt into the challenge round (P1e): swap the labeled challenge tail in as a
  // fresh run (no server round-trip — served alongside the required set). Each
  // item carries lane "challenge" so the "· challenge" chip shows. A tail
  // REPLACES the run — `lane:tailAccepted` resets idx/correctCount/answeredCount
  // /terminal in the machine the SAME way `onAcceptStretch` below does, so both
  // tails share one owner instead of each hand-resetting different fields.
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
    setInput("");
    setResult(null);
    setLog([]);
    setError(null);
    streakRef.current = 0;
    setPredictedConfidence(null);
    setHelpReported(false);
    setRevealPrediction(null);
    setComesBackText(null);
    machine.send({
      type: "lane:tailAccepted",
      itemCount: next.length,
      itemId: next[0]?.itemId ?? null,
    });
  }, [challengeItems, machine]);

  const startStretchRound = useCallback(
    (next: ServedItem[]) => {
      setInStretch(true);
      setStretchCracked(false);
      setFirstPostPlacementBlock(false);
      setItems(next);
      setSegments([]);
      setLaunchpad(null);
      setLaunchpadDone(false);
      setInput("");
      setResult(null);
      setLog([]);
      setError(null);
      streakRef.current = 0;
      setPredictedConfidence(null);
      setHelpReported(false);
      setRevealPrediction(null);
      setComesBackText(null);
      machine.send({
        type: "lane:tailAccepted",
        itemCount: next.length,
        itemId: next[0]?.itemId ?? null,
      });
    },
    [machine],
  );

  // Opt into the ordinary "Go deeper" stretch tail. Its items were already
  // resolved alongside the required set, so accepting remains a local swap.
  const onAcceptStretch = useCallback(() => {
    if (stretchItems.length === 0) return;
    // Honest provenance — mirrors the web twin: when the Go-deeper round the
    // scholar just started IS this story's own application (matched on the
    // served story hook, the only story identity the client is given), the
    // moment was TRIED. A bonus start no longer records "dismissed".
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


  // Tune-up completion is patched automatically: the machine's `terminate()`
  // transition emits `completeTuneup` (idempotent server-side) whenever
  // `run.tuneupId` is set, using its OWN `run.correctCount` — no host-side
  // "wait for done, patch once" effect needed.

  // Reset the render / first-key clock when a genuinely new item lands.
  useEffect(() => {
    if (!current) return;
    itemRenderAtRef.current = Date.now();
    firstKeyAtRef.current = null;
  }, [current]);

  const onKey = useCallback((k: string) => {
    Haptics.selectionAsync().catch(() => {});
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setUnitNudgeItemId(null);
    setInput((prev) => applyKey(prev, k));
  }, []);

  // Hardware-keyboard typing on the answer field (and the pad's unit keys, which
  // rewrite the value rather than append). Already sanitized to the answer
  // type's charset by the field; here we just seed the first-key clock (same
  // instrument as the pad) and set the value.
  const onInput = useCallback((next: string) => {
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setUnitNudgeItemId(null);
    setInput(next);
  }, []);

  // Advance to the next item (or finish). Resets host render state; the
  // machine owns idx/missCount/hasRecorded/terminal via `ui:advance`.
  const advance = useCallback(async () => {
    // A mapping-sit re-query is in flight — `busy` already brackets it below,
    // replacing the old dedicated re-entrancy ref (the CTA that calls this is
    // ALSO disabled while busy, so this is a second, defense-in-depth check).
    if (busy) return;
    resetItemHostState();
    const outcome = items ? advanceStep(idx, items.length) : null;
    if (outcome?.done) {
      // Option D (F1): a `· mapping` sit builds across recompositions. When the
      // served batch is exhausted AND this was a mapping sit AND we're under the
      // day-1 cap, re-query for the next probes and append them so the sit
      // continues seamlessly — Done shows only when the server has no more mapping
      // today or the cap is hit.
      const isMainMappingSit =
        mappingEntry &&
        !inChallenge &&
        !inStretch &&
        !inTuneup &&
        !inBonusMore &&
        !!items &&
        // ALL-mapping only (Q1 "honest-and-done"). A BLENDED run must NOT extend
        // itself with further mapping bands — Q2 rules mapping in a blend to a
        // fixed cap of ≤ 2 items (MAPPING_BLEND_CAP), and looping here would
        // ratchet a mixed sit toward the all-mapping pretest ceiling.
        allMapping;
      if (
        isMainMappingSit &&
        items &&
        mappingProgressOffset + items.length < MAPPING_PRETEST_MAX_QUESTIONS
      ) {
        setLaneBusy(true);
        const more = await fetchMoreMapping(items.length);
        setLaneBusy(false);
        if (more.length > 0) {
          const nextItems = [...items, ...more];
          setItems(nextItems);
          setSegments((prev) => appendMappingSegment(prev, more.length));
          machine.send({ type: "lane:batchAppended", addedCount: more.length });
          machine.send({
            type: "ui:advance",
            nextItemId: nextItems[idx + 1]?.itemId ?? null,
          });
          return;
        }
      }
      machine.send({ type: "ui:advance", nextItemId: null });
    } else {
      machine.send({
        type: "ui:advance",
        nextItemId: items?.[idx + 1]?.itemId ?? null,
      });
    }
  }, [
    busy,
    items,
    idx,
    mappingEntry,
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

  // The three-miss breaker is now entirely machine-owned: `server:submitSucceeded`
  // creates `state.breaker` from the grade's `backOff` automatically (never a
  // host-built `openBreakerOffer`), and `breakerCommands()` in the reducer
  // auto-emits the repair-serve/coach/fresh commands as the flow advances —
  // this component only installs the payloads those commands return
  // (`onHintRung`/`onBreakerItem`, wired in the host bindings below).

  const onSubmit = useCallback(
    (rawAnswer?: string) => {
      if (!current || busy) return;
      setError(null);
      const answer = (rawAnswer ?? input).trim();
      if (!answer) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

      // First attempt records to mastery; a retry after a miss is graded but not
      // recorded (record:false), so the scheduler isn't double-penalized.
      const firstAttempt = isFirstAttempt(hasRecorded);
      const timing = computeTiming({
        firstAttempt,
        nowMs: Date.now(),
        renderAtMs: itemRenderAtRef.current,
        firstKeyAtMs: firstKeyAtRef.current,
      });

      // ── Option D: a `· mapping` item grades through the PLACEMENT path.
      //    `allMapping` (the day-1/cold-start "Math Check-In" sit — the ONLY
      //    surface this repo still calls the "pretest") stays silent: record
      //    it, advance immediately, no verdict/reveal/notification. Folded
      //    into an otherwise NORMAL playlist (`allMapping === false`) the
      //    scholar gets the same reveal-only feedback an ordinary drill item
      //    gets — just no retry, since the grade is already recorded. Mapping
      //    grades through its OWN `submitMappingAnswer` mutation (never
      //    `ui:submit` — see the migration notes at the top of this file); the
      //    outcome is reported to the machine through the typed lane bridges
      //    (`lane:entered`/`lane:mappingAnswered`/`lane:mappingRetry`/
      //    `lane:exited`) so idx/hasRecorded/missCount/correctCount/resume stay
      //    canonical even for a lane the machine never directly grades. ──
      if (current.lane === "mapping") {
        void (async () => {
          setLaneBusy(true);
          machine.send({ type: "lane:entered", lane: "mapping" });
          try {
            const graded = await submitMapping({
              scholarId,
              domain: current.domain ?? domain ?? "",
              itemId: current.itemId,
              seed: runSeed,
              answer,
            });
            // A stale/unresolvable item means the current batch is no longer
            // useful; recompose immediately, still without presenting a verdict.
            if (graded.outcome === null || graded.alreadyMapped) {
              setResult(null);
              setRevealPrediction(null);
              machine.send({ type: "lane:exited" });
              machine.send({ type: "run:reloadRequested" });
              return;
            }
            // "Confirm before you cap": a first typed miss with confirm budget is a
            // possible slip. The server already served a FRESH item on the SAME
            // skill (graded.retryItem) without capping — swap it into the current
            // slot and offer the two-way choice instead of advancing. The slip path
            // answers that confirm item; the concede path don't-knows it (fast cap).
            if (graded.retry && graded.retryItem) {
              const confirm = graded.retryItem as ServedItem;
              setItems((prev) => (prev ? prev.map((it, i) => (i === idx ? confirm : it)) : prev));
              setInput("");
              setResult(null);
              setRevealPrediction(null);
              wrongAnswersRef.current = [];
              setMappingRetry(true);
              machine.send({ type: "lane:mappingRetry", itemId: confirm.itemId });
              return;
            }
            const res: SubmitResult = {
              correct: graded.outcome === "correct",
              correctAnswer: graded.correctAnswer ?? undefined,
              skillKey: current.skillKey,
              skillLabel: current.skillLabel,
              repetition: 0,
              proficiency: "not_started",
              accelerated: false,
              dontKnow: graded.outcome === "unknown",
              unitOutcome: graded.unitOutcome,
              turnedFluent: false,
              mapping: true,
              domainJustMapped: graded.domainJustMapped,
              mappedDomainLabel: graded.domainLabel,
            };
            setRevealPrediction(null);
            if (firstAttempt) {
              setLog((l) => [...l, { correct: res.correct, skillLabel: res.skillLabel, dontKnow: res.dontKnow }]);
            }
            if (graded.domainJustMapped) setMappedDomainLabel(graded.domainLabel ?? null);
            setMappingRetry(false);
            machine.send({
              type: "lane:mappingAnswered",
              recorded: true,
              correct: res.correct,
            });
            if (showsMappingFeedback(allMapping)) {
              setResult(res);
              if (res.correct) successNotify();
              else warningNotify();
            } else {
              await advance();
            }
          } catch {
            setError("Couldn't check that — check your connection and try again.");
            machine.send({ type: "lane:exited" });
          } finally {
            setLaneBusy(false);
          }
        })();
        return;
      }

      const breakerSubmitContext = {
        prepareBreakerRepair: !quickFacts,
        suppressBreaker: Boolean(quickFacts),
        ...breakerFreshSubmitArgs({
          flow: breaker?.flow,
          freshItemId: breaker?.freshItemId ?? null,
          itemId: current.itemId,
          triggerAttemptId: breaker?.triggerAttemptId,
          firstAttempt,
        }),
        ...breakerEasySubmitArgs({
          flow: breaker?.flow,
          triggerAttemptId: breaker?.triggerAttemptId,
          firstAttempt,
        }),
      };
      // The receipt lives in `machine.state.item` (not a host ref): a retry of
      // the SAME logical answer reuses it, so the server's dedup is exact
      // rather than over-eager; anything else mints a new one.
      const clientEventKey = JSON.stringify({
        itemId: current.itemId,
        answer,
        record: firstAttempt,
        predictedConfidence: firstAttempt ? predictedConfidence : null,
        ...breakerSubmitContext,
      });
      const reusesClientEvent =
        machine.state.item.clientEventKey === clientEventKey &&
        machine.state.item.clientEventId !== null;
      const clientEventId = reusesClientEvent
        ? machine.state.item.clientEventId!
        : makeClientEventId("practice-answer");
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
        ...(timing.firstKeyMs !== undefined
          ? { latencyMs: timing.firstKeyMs }
          : {}),
        ...(timing.elapsedMs !== undefined
          ? { thinkTimeMs: timing.elapsedMs }
          : {}),
      };
      machine.send({
        type: "ui:submit",
        answer,
        clientEventId,
        clientEventKey,
        entry,
      });
    },
    [
      current,
      busy,
      input,
      hasRecorded,
      submitMapping,
      scholarId,
      domain,
      runSeed,
      idx,
      allMapping,
      advance,
      machine,
      quickFacts,
      breaker,
      predictedConfidence,
    ],
  );
  const checkEnabled =
    phase === "answering" &&
    !!current &&
    isPadAnswerType(current.answerType) &&
    !busy &&
    !!input.trim();
  // A unit item's answer isn't finished until it carries a unit — an unlabeled
  // number is graded INCORRECT server-side, so submitting it would spend the
  // attempt on a formatting slip. The gate reads any trailing unit token, right
  // or wrong: a wrong unit belongs to the grader ("so close"), not to us. Only
  // typed items reach here (multiple-choice submits its option index directly,
  // and the honest don't-know has its own path — neither is ever gated).
  const unitReady = !current?.answerUnit || hasUnitToken(input.trim());
  const unitNudge = !!current && unitNudgeItemId === current.itemId;
  // The nudge sits OUTSIDE the guarded action, whose fired-latch only releases
  // when `enabled` or the reset key changes — a refusal handled inside it would
  // leave Check dead until the item changed.
  const onCheckGuarded = useGuardedPracticeAction(
    () => void onSubmit(),
    checkEnabled && unitReady,
    `${current?.itemId ?? "none"}:${phase}`,
  );
  const onCheck = useCallback(() => {
    // Refuse only a Check that would otherwise have submitted — `checkEnabled`
    // already excludes the item kinds that answer without a measurement.
    if (checkEnabled && current && !unitReady) {
      setUnitNudgeItemId(current.itemId);
      return;
    }
    onCheckGuarded();
  }, [checkEnabled, current, unitReady, onCheckGuarded]);

  const onReportHelpUsed = useCallback(async () => {
    const attemptId = result?.attemptId;
    if (!attemptId || busy || helpPending) return;
    const undoing = helpReported;
    setHelpPending(true);
    setHelpReported(!undoing);
    try {
      if (undoing) {
        const res = await convex.mutation(api.practiceSkills.undoHelpUsed, {
          scholarId,
          attemptId,
        });
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
      const res = await convex.mutation(api.practiceSkills.reportHelpUsed, {
        scholarId,
        attemptId,
        seed: Math.floor(Math.random() * 2_000_000_000),
      });
      const retry = res.items[0] as ServedItem | undefined;
      helpRetryItemIdRef.current = retry?.itemId ?? null;
      if (retry) {
        // Append rather than interrupting the verdict; the fresh shot arrives later in this run.
        setItems((prev) => (prev ? [...prev, retry] : prev));
        machine.send({ type: "run:itemCountAdjusted", delta: 1 });
      }
    } catch (error) {
      console.error("[practice] report help used failed", error);
      setHelpReported(undoing);
    } finally {
      setHelpPending(false);
    }
  }, [busy, convex, helpPending, helpReported, idx, items, machine, result?.attemptId, scholarId]);

  // "I haven't learned this yet" — an honest don't-know (drill parity with web +
  // placement). Recorded as a MISS for spaced repetition, but flagged distinctly:
  // supportive copy, move on (never the retry/stuck loop), and no answer reveal.
  // A first-look affordance only (hidden on a retry); server skips error
  // classification. Routes through the SAME `ui:submit`/lane bridges as
  // `onSubmit` — an honest don't-know is still an answer, just a different one.
  const onDontKnow = useCallback(async () => {
    if (!current || busy || !online || !isFirstAttempt(hasRecorded)) return;
    setError(null);
    // ── Option D: an honest "I haven't learned this yet" on a `· mapping`
    //    item is placement measurement too. The all-mapping check-in/pretest
    //    sit (`allMapping`) stays silent; folded into a normal playlist it
    //    gets the same reveal-only feedback (no teaching step — Option D
    //    never gave mapping items one). ──
    if (current.lane === "mapping") {
      setLaneBusy(true);
      machine.send({ type: "lane:entered", lane: "mapping" });
      try {
        const graded = await submitMapping({
          scholarId,
          domain: current.domain ?? domain ?? "",
          itemId: current.itemId,
          seed: runSeed,
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
        setLog((l) => [...l, { correct: false, skillLabel: res.skillLabel, dontKnow: true }]);
        if (graded.domainJustMapped) setMappedDomainLabel(graded.domainLabel ?? null);
        setMappingRetry(false);
        machine.send({ type: "lane:mappingAnswered", recorded: true, correct: false });
        if (showsMappingFeedback(allMapping)) {
          setResult(res);
          warningNotify();
        } else {
          await advance();
        }
      } catch {
        setError("Couldn't save that — check your connection and try again.");
        machine.send({ type: "lane:exited" });
      } finally {
        setLaneBusy(false);
      }
      return;
    }
    const breakerSubmitContext = {
      prepareBreakerRepair: !quickFacts,
      suppressBreaker: Boolean(quickFacts),
      ...breakerFreshSubmitArgs({
        flow: breaker?.flow,
        freshItemId: breaker?.freshItemId ?? null,
        itemId: current.itemId,
        triggerAttemptId: breaker?.triggerAttemptId,
        firstAttempt: true,
      }),
      ...breakerEasySubmitArgs({
        flow: breaker?.flow,
        triggerAttemptId: breaker?.triggerAttemptId,
        firstAttempt: true,
      }),
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
      // An explicit Don't-Know is a tap, not a retrieval keystroke.
      firstKeyAtMs: null,
    });
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
      // A prediction paired with an honest don't-know is still calibration data.
      ...(predictedConfidence ? { predictedConfidence } : {}),
      ...breakerSubmitContext,
      ...(timing.firstKeyMs !== undefined
        ? { latencyMs: timing.firstKeyMs }
        : {}),
      ...(timing.elapsedMs !== undefined
        ? { thinkTimeMs: timing.elapsedMs }
        : {}),
    };
    machine.send({
      type: "ui:submit",
      answer: "",
      clientEventId,
      clientEventKey,
      entry,
    });
  }, [
    current,
    busy,
    online,
    hasRecorded,
    submitMapping,
    scholarId,
    domain,
    runSeed,
    allMapping,
    advance,
    machine,
    quickFacts,
    breaker,
    predictedConfidence,
  ]);

  // "Confirm before you cap" (mapping band): the two-way slip/concede choice
  // shown after a first typed miss, mirroring web + Placement. The fresh confirm
  // item is ALREADY the current slot (swapped in by onSubmit above), so:
  //  • slip → just answer it (a correct confirm supersedes the miss);
  //  • concede → a don't-know on that same confirm item caps immediately (the
  //    fast path). onDontKnow's first-attempt guard passes because the swap reset
  //    hasRecorded, and it routes through the mapping branch (lane "mapping").
  const onSlipRetry = useCallback(() => {
    setInput("");
    setMappingRetry(false);
  }, []);
  const onSlipConcede = useCallback(() => {
    void onDontKnow();
  }, [onDontKnow]);

  // Retry the SAME item after a first miss (keeps missCount + hasRecorded, and
  // the accumulated wrong answers so a 2nd miss can open the handoff).
  // `ui:retry` moves item.phase from "feedback" to "retry" — an allowed phase
  // for the NEXT `ui:submit`, exactly the transition `phase==="feedback"`
  // otherwise blocks.
  const onRetry = useCallback(() => {
    setInput("");
    setResult(null);
    setError(null);
    setHandoff(null);
    setHandoffInput("");
    machine.send({ type: "ui:retry" });
  }, [machine]);

  // "Try a fresh one" — a new variant of the SAME skill (mirrors web). Replaces
  // the current slot in place; falls back to advancing if none is available.
  // Reached from EITHER the ordinary feedback CTA (no lane active) or the
  // handoff chat's exit — `lane:handoffClosed` is safe either way (it forces
  // `lane: null`, a no-op when already null).
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
        ...(domain ? { domain } : {}),
      });
      const fresh = (res.items as ServedItem[])[0];
      resetItemHostState();
      if (fresh) {
        if (current.lane) fresh.lane = current.lane;
        setItems((prev) => (prev ? prev.map((it, i) => (i === idx ? fresh : it)) : prev));
        machine.send({
          type: "lane:handoffClosed",
          outcome: "fresh-variant",
          itemId: fresh.itemId,
        });
      } else {
        machine.send({
          type: "lane:handoffClosed",
          outcome: "advance",
          itemId: items?.[idx + 1]?.itemId ?? null,
        });
      }
    } finally {
      setLaneBusy(false);
    }
  }, [current, scholarId, convex, domain, idx, items, machine, resetItemHostState]);

  // Install the handoff/coach chat's RENDER content — a pure setter, no lane
  // dispatch. Used both by machine-driven opens (`onCoach`/`onHandoff`
  // bindings below, where the reducer's OWN transition already set
  // `lane:"handoff"` as part of processing `ui:breakerCoach`/
  // `server:coachOpened`/`ui:hintLadderPulled`) and by the one SCHOLAR-
  // initiated open below, which has nothing else driving the lane transition
  // and so dispatches it explicitly.
  const installHandoff = useCallback((entryMode: "stuck" | "spiral" | "ladder") => {
    setHandoff({
      mode: "handoff",
      entryMode,
      messages: [
        {
          role: "assistant",
          content: entryMode === "spiral" ? SPIRAL_HANDOFF_OPENER : HANDOFF_OPENER,
        },
      ],
      ended: false,
      loading: false,
      error: null,
    });
    setHandoffInput("");
  }, []);

  // Open the Socratic handoff (kid-initiated, after 2 misses). Native mirror of
  // web's onTalkItThrough.
  const openTalkItThrough = useCallback(() => {
    installHandoff("stuck");
    machine.send({ type: "lane:entered", lane: "handoff" });
  }, [installHandoff, machine]);
  const onTalkItThrough = useCallback(() => openTalkItThrough(), [openTalkItThrough]);

  // The handoff/dialogue lane's two exits — a stretch item retries the SAME
  // item, everything else advances. Both clear the lane through the typed
  // bridge (`lane:handoffClosed`) rather than a raw `advance()`/`setPhase`
  // call: a lane-suspended machine refuses an `ui:advance` it didn't route
  // through this event, so this is the ONLY correct way to leave a lane and
  // move on (or retry) in one step.
  const onHandoffAdvance = useCallback(() => {
    resetItemHostState();
    machine.send({
      type: "lane:handoffClosed",
      outcome: "advance",
      itemId: items?.[idx + 1]?.itemId ?? null,
    });
  }, [idx, items, machine, resetItemHostState]);
  const onHandoffRetry = useCallback(() => {
    resetItemHostState();
    machine.send({ type: "lane:handoffClosed", outcome: "retry-same" });
  }, [machine, resetItemHostState]);

  // The reducer owns the whole hint ladder: whether this tap opens the panel,
  // serves the next rung, or (the ladder already exhausted) escalates straight
  // to the coach handoff (`ui:hintLadderPulled`, dispatched internally by
  // `ui:hintPressed` — see practiceMachine.ts). This component only resets the
  // RENDER content (`hintRungs`/`activeHintRung`) when the tap targets a
  // different item than the ladder was last open for.
  const onHintLadderPress = useCallback(() => {
    if (!current || current.lane === "mapping" || busy) return;
    if (hintItemId !== current.itemId) {
      setHintRungs([]);
      setActiveHintRung(null);
    }
    setHintStepError(null);
    machine.send({ type: "ui:hintPressed" });
  }, [busy, current, hintItemId, machine]);

  const onHintStepComplete = useCallback((revealedAfterWrong: boolean) => {
    if (!activeHintRung) return;
    setHintRungs((rungs) => [
      ...rungs,
      { rung: activeHintRung.rung, revealedAfterWrong },
    ]);
    // `hintStepsExhausted` is derived from `machine.state.hint.exhausted`,
    // already set the moment this rung was SERVED (`server:hintServed`'s
    // `exhausted: !hasMore`) — nothing to set here.
    setActiveHintRung(null);
  }, [activeHintRung]);

  // ── Breaker mechanics ─────────────────────────────────────────────────────
  // The reducer owns EVERY breaker transition and command: `server:submitSucceeded`
  // creates the episode from `result.backOff` automatically (never a host-built
  // `openBreakerOffer`), `breakerCommands()` auto-emits the repair-serve /
  // coach-escalation / fresh-serve sequence as `flow` advances (no more
  // `queueMicrotask` effects or one-shot latch refs to guard them), and the
  // executor calls the real mutations (recordBreakerRecoveryLifecycle,
  // breakerRecoverySession, breakerEasyFinishSession, recordBreakerOutcome —
  // the "legacy staff telemetry" effect below is GONE because the reducer
  // itself emits `recordBreakerOutcome` exactly once per episode, keyed by
  // semantic id, the moment `flow.stage === "close"`). This component only
  // installs the payloads those commands return (`onHintRung`/`onBreakerItem`,
  // wired into the host bindings further down) and forwards the scholar's own
  // taps as typed events.

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
      if (control === "coach") {
        machine.send({ type: "ui:breakerCoach" });
        return;
      }
      machine.send({ type: "ui:breakerEasyFinish" });
    },
    [machine],
  );

  const finishBreakerRepairStep = useCallback(() => {
    machine.send({ type: "ui:breakerRepairCompleted" });
  }, [machine]);

  const finishBreakerItem = useCallback(() => {
    machine.send({ type: "ui:breakerClose" });
  }, [machine]);

  // Send one turn to the handoff tutor. The endpoint re-derives the answer
  // server-side, feeds the tutor ONLY the stem + wrong answers, and redacts any
  // reply that leaks the answer. Buffered (not streamed) so the backstop always
  // runs before the kid sees anything. Contract mirror of web's onHandoffSend.
  // `explicitText` lets voice send a transcribed take directly (no drop-to-input).
  const onHandoffSend = useCallback(async (explicitText?: string) => {
    const text = (explicitText ?? handoffInput).trim();
    const imageId = chatImage.imageId;
    if (!current || !handoff || handoff.loading || (!text && !imageId)) return;
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
    chatImage.clear();
    const token = authTokenRef.current;
    try {
      const res = await expoFetch(
        `${convexSiteUrl}${isDialogue ? "/practice-dialogue" : "/practice-handoff"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  }, [current, handoff, handoffInput, chatImage, scholarId, machine]);

  // A DIALOGUE stretch item IS a conversation — entering one skips the pad and
  // opens the chat immediately (mode "dialogue"), mirroring web.
  useEffect(() => {
    if (
      phase !== "answering" ||
      current?.answerType !== "dialogue" ||
      !authToken
    ) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- entering a dialogue item must atomically show its opening handoff before starting the stream.
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
    void expoFetch(`${convexSiteUrl}/practice-dialogue`, {
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
  // server-only rubric (mirrors web; stretch rules: a non-pass costs nothing).
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
    const token = authTokenRef.current;
    try {
      const res = await expoFetch(`${convexSiteUrl}/practice-dialogue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
        setLog((l) => [...l, { correct: verdict.passed, skillLabel: current.skillLabel }]);
        if (verdict.passed) {
          setStretchCracked(true);
          successNotify();
        }
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
  }, [current, handoff, dialogueVerdict]);

  // A manipulative item's Done is routed through the SAME machine `ui:submit`
  // path a typed/MC answer uses (never a second direct `submitAnswer` call) —
  // see `submitManipulativeAnswer` below, passed to NativeManipulativeItem as
  // `submitAnswerOverride`. `onGrade` (the shared host binding, further down)
  // does ALL the canonical bookkeeping generically; this bridge exists only
  // because NativeManipulativeItem's Done is promise-based (it awaits its OWN
  // outcome) while the machine is event-based — so a pending resolver is
  // matched by `clientEventId` against whichever arrives first: a real grade
  // (`onGrade`), a durable queue (`onAnswerQueued`), or neither (rejected
  // below once the item's phase settles back to "answering" without a grade).
  const pendingManipulativeSubmitRef = useRef<{
    clientEventId: string;
    resolve: (value: NativeManipulativeSubmission) => void;
    reject: (error: unknown) => void;
  } | null>(null);

  // The breaker/quick-facts submission context — the SAME shape `onSubmit`
  // builds inline, exposed as NativeManipulativeItem's `getSubmissionContext`
  // prop so it lands in `args` BEFORE `submitManipulativeAnswer` (below) sees
  // it, exactly like the direct-mutation default path already worked.
  const breakerManipulativeSubmitContext = useCallback(
    (itemId: string): Pick<
      NativeManipulativeSubmitArgs,
      "prepareBreakerRepair" | "suppressBreaker" | "breakerTriggerAttemptId" | "breakerEasyTriggerAttemptId"
    > => ({
      prepareBreakerRepair: !quickFacts,
      suppressBreaker: Boolean(quickFacts),
      // `breaker.triggerAttemptId` is a plain string in the shared machine's
      // BreakerState (it flows through `OutboxAnswer`/JSON too); the direct
      // mutation args this feeds want the branded `Id`. Same server-derived
      // value either way — the mutation itself validates it.
      ...breakerFreshSubmitArgs({
        flow: breaker?.flow,
        freshItemId: breaker?.freshItemId ?? null,
        itemId,
        triggerAttemptId: breaker?.triggerAttemptId as Id<"practiceAttempts"> | undefined,
        firstAttempt: true,
      }),
      ...breakerEasySubmitArgs({
        flow: breaker?.flow,
        triggerAttemptId: breaker?.triggerAttemptId as Id<"practiceAttempts"> | undefined,
        firstAttempt: true,
      }),
    }),
    [quickFacts, breaker],
  );

  const submitManipulativeAnswer = useCallback(
    (args: NativeManipulativeSubmitArgs): Promise<NativeManipulativeSubmission> => {
      if (
        !current ||
        machine.state.item.itemId !== args.itemId ||
        (machine.state.item.phase.kind !== "answering" &&
          machine.state.item.phase.kind !== "retry")
      ) {
        return Promise.reject(new Error("No active item"));
      }
      const firstAttempt = !machine.state.item.hasRecorded;
      const clientEventKey = JSON.stringify({
        itemId: args.itemId,
        answer: args.answer,
        record: firstAttempt,
        predictedConfidence: args.predictedConfidence ?? null,
        breakerTriggerAttemptId: args.breakerTriggerAttemptId ?? null,
        breakerEasyTriggerAttemptId: args.breakerEasyTriggerAttemptId ?? null,
        suppressBreaker: args.suppressBreaker ?? false,
        prepareBreakerRepair: args.prepareBreakerRepair ?? false,
      });
      const reusesClientEvent =
        machine.state.item.clientEventKey === clientEventKey &&
        machine.state.item.clientEventId !== null;
      const clientEventId = reusesClientEvent
        ? machine.state.item.clientEventId!
        : (args.clientEventId ?? makeClientEventId("practice-answer"));
      const entry: OutboxAnswer = {
        clientEventId,
        itemId: args.itemId,
        answer: args.answer,
        record: firstAttempt,
        skillLabel: current.skillLabel,
        queuedAt: Date.now(),
        ...(reusesClientEvent &&
        machine.state.item.clientEventReplay !== null
          ? { submissionReplay: machine.state.item.clientEventReplay }
          : {}),
        ...(args.predictedConfidence !== undefined
          ? { predictedConfidence: args.predictedConfidence }
          : {}),
        ...(args.breakerTriggerAttemptId
          ? { breakerTriggerAttemptId: args.breakerTriggerAttemptId }
          : {}),
        ...(args.breakerEasyTriggerAttemptId
          ? { breakerEasyTriggerAttemptId: args.breakerEasyTriggerAttemptId }
          : {}),
        ...(args.suppressBreaker !== undefined ? { suppressBreaker: args.suppressBreaker } : {}),
        ...(args.prepareBreakerRepair !== undefined
          ? { prepareBreakerRepair: args.prepareBreakerRepair }
          : {}),
        ...(args.firstKeyMs !== undefined ? { latencyMs: args.firstKeyMs } : {}),
        ...(args.elapsedMs !== undefined ? { thinkTimeMs: args.elapsedMs } : {}),
      };
      return new Promise<NativeManipulativeSubmission>((resolve, reject) => {
        pendingManipulativeSubmitRef.current = { clientEventId, resolve, reject };
        machine.send({
          type: "ui:submit",
          answer: entry.answer,
          clientEventId,
          clientEventKey,
          entry,
        });
      });
    },
    [current, machine],
  );

  // Neither `onGrade` nor `onAnswerQueued` fired for the pending manipulative
  // submission — the item's phase settled back to "answering" WITHOUT
  // clearing its receipt (`server:submitFailed`'s own transition retains it,
  // exactly so a retry reuses the SAME clientEventId), so this was neither
  // graded nor durably queued. Reject so NativeManipulativeItem's Done
  // re-enables for a retry.
  useEffect(() => {
    const pending = pendingManipulativeSubmitRef.current;
    if (!pending) return;
    if (
      machine.state.item.phase.kind === "answering" &&
      machine.state.item.clientEventId === pending.clientEventId
    ) {
      pendingManipulativeSubmitRef.current = null;
      pending.reject(new Error("Couldn't check that — try Done again."));
    }
  }, [machine.state.item.phase.kind, machine.state.item.clientEventId]);

  // ── Host bindings — installed into the machine every render via a layout
  // effect (below), so a command always sees the JUST-committed closures. ──

  // Install the server/client grade payload — RENDER data only; every piece
  // of canonical bookkeeping (correctCount/answeredCount/hasRecorded/breaker
  // creation/resume-save/the per-grade haptic) already happened inside the
  // reducer before this fires. Shared by typed/MC AND manipulative submits —
  // a manipulative resolves its OWN pending promise here too (matched by
  // clientEventId), never a second haptic or a second submit.
  const onGrade = useCallback(
    (raw: unknown, entry: OutboxAnswer) => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { correct?: unknown }).correct !== "boolean"
      ) {
        throw new Error("Practice grader returned an invalid verdict");
      }
      const res = raw as SubmitResult;
      const pending = pendingManipulativeSubmitRef.current;
      if (pending && pending.clientEventId === entry.clientEventId) {
        pendingManipulativeSubmitRef.current = null;
        pending.resolve({ status: "graded", result: res });
      }
      accumulateDispatchCompleted(res.dispatchCompleted);
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
      if (entry.record) {
        setLog((l) => [...l, { correct: res.correct, skillLabel: res.skillLabel, dontKnow: res.dontKnow }]);
      }
      if (res.correct && current?.lane === "stretch") setStretchCracked(true);
      streakRef.current = nextStreak(streakRef.current, res.correct);
      if (res.correct && shouldPulseStreak(streakRef.current)) {
        // Milestone flourish: a second HAPTIC only (no second chime) — the
        // per-grade haptic+chime already came through the machine's `onHaptic`
        // binding below.
        setTimeout(
          () =>
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
          STREAK_PULSE_DELAY_MS,
        );
      } else if (!res.correct && !res.dontKnow && entry.answer) {
        // Feed the answer-safe handoff (the tutor sees these, never the answer).
        wrongAnswersRef.current = [...wrongAnswersRef.current, entry.answer];
      }
      if (res.dontKnow) {
        setRevealPrediction(null);
        // Teach-as-action: show the feedback moment with ONE interactive faded
        // worked step (TeachingStep) instead of a passive streamed explanation a
        // young scholar dismisses — doing the step IS the reading. Hold Continue
        // until it's attempted (TeachingStep fires onReady → dontKnowStepReady).
        setDontKnowStepReady(false);
      }
    },
    [current?.lane, accumulateDispatchCompleted],
  );

  // The manipulative-only counterpart to `onGrade`'s pending-promise
  // resolution: an entry was durably queued rather than graded. Native-only
  // extension on `PracticeHostBindings` (web has no promise-based submit
  // caller, so it has no equivalent).
  const onAnswerQueued = useCallback((entry: OutboxAnswer, count: number) => {
    const pending = pendingManipulativeSubmitRef.current;
    if (pending && pending.clientEventId === entry.clientEventId) {
      pendingManipulativeSubmitRef.current = null;
      pending.resolve({ status: "queued", queuedCount: count });
    }
  }, []);

  // Render a served hint rung — content only; ladder progress (open/itemId/
  // nextStepIndex/exhausted/pendingCommandId) all live in `machine.state.hint`.
  const installHintRung = useCallback(
    (raw: unknown, source: "ladder" | "breaker" | "breakerRestore") => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("rung" in raw) ||
        !("hasMore" in raw)
      ) {
        return;
      }
      const served = raw as { rung: HintLadderRung | null; hasMore: boolean };
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
        setActiveHintRung({ rung: served.rung, hasMore: served.hasMore });
      } else {
        setHintRungs((rungs) => [
          ...rungs,
          { rung: served.rung!, revealedAfterWrong: false },
        ]);
      }
    },
    [],
  );

  // The snapshot payload for a resume write; null when there is nothing to
  // save (a tail/tune-up/bonus round, mid-breaker, terminal, or an
  // out-of-bounds position).
  const buildResumeSnapshot = useCallback(
    (resumeIdx: number): ResumeSnapshot<unknown, unknown, unknown> | null => {
      const isMainRun = !inChallenge && !inStretch && !inTuneup && !inBonusMore;
      const scopeKey = machine.state.run.scopeKey;
      const dayKey = machine.state.run.dayKey;
      if (
        !isMainRun ||
        !items ||
        items.length === 0 ||
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
      inChallenge,
      inStretch,
      inTuneup,
      inBonusMore,
      items,
      breaker,
      machine.state.terminal,
      machine.state.run.scopeKey,
      machine.state.run.dayKey,
      machine.state.run.inputKey,
      segments,
      launchpad,
      allMapping,
      mappingProgressOffset,
      mappedDomainLabel,
      sessionInputKey,
    ],
  );

  // The host bindings installer. Runs in a LAYOUT effect (before the
  // machine's passive command-draining effect) so a command that fires this
  // same commit always sees the just-committed closures, never a stale one
  // from the render before.
  useLayoutEffect(() => {
    machineHostRef.current = {
      scholarId,
      loadRun,
      onLoadError: (error) => {
        console.error("[practice] run load failed:", error);
        setError("That practice round couldn't load. Try again.");
      },
      onSubmitError: setError,
      getTriggerItemPayload: (itemId) =>
        items?.find((item) => item.itemId === itemId) ?? null,
      onTriggerItemPersistenceError: () => {
        setError("This answer couldn't be saved safely on this iPad. Try again.");
      },
      onBreakerItem: (item) => installBreakerItem(item as ServedItem),
      onHintRung: installHintRung,
      onHintError: setHintStepError,
      onGrade,
      onCoach: () => installHandoff("spiral"),
      onHandoff: installHandoff,
      buildResumeSnapshot,
      // Native completion remains silent: the machine's `terminate()` ALSO
      // emits a "success" haptic command (mirroring the per-grade one), but
      // that is a WEB behavior this surface never had — suppressing it here
      // (rather than inventing a native completion haptic) is the one
      // deliberate delta from a byte-for-byte `haptic` binding. The check is
      // `machine.state.terminal` at the moment this SPECIFIC command drains:
      // a real grade's haptic always fires from a transition that has not
      // yet terminated (terminate() only follows a LATER `ui:advance`, in an
      // entirely separate dispatch/batch), so this can never suppress one.
      onHaptic: (style) => {
        if (machine.state.terminal) return;
        if (style === "success") successNotify();
        else warningNotify();
      },
      onQueuedCount: setQueuedCount,
      onDispatchCompleted: (receipts) =>
        accumulateDispatchCompleted(
          receipts as DispatchCompletionReceiptData[] | undefined,
        ),
      onAnswerQueued,
    };
  }, [
    accumulateDispatchCompleted,
    buildResumeSnapshot,
    installBreakerItem,
    installHandoff,
    installHintRung,
    items,
    loadRun,
    machine.state.terminal,
    onAnswerQueued,
    onGrade,
    scholarId,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────

  // These non-active-skill states (check-in, placement, done/summary) use the
  // NATIVE nav header. The active-skill render hides it (headerShown:false) to
  // draw its own bar, and setOptions MERGES — so we must explicitly restore
  // headerShown:true here, or a summary reached after answering inherits the
  // hidden header and loses its title/back affordance.
  const header = <Stack.Screen options={{ title: "Practice", headerShown: true }} />;
  // The completion arbiter (shared/completionOffers.ts, vendored) is the
  // single owner of "what does the done screen's offer stack show" — priority:
  // an in-progress continuation is never interrupted > the one-time story
  // moment as primary > re-probe/tune-up > stretch/challenge/more-of-your-pick.
  // Both frontends consume the SAME pure function so the ordering can't drift.
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
  // choiceHint (the scholar picked a strand on the home card) — never mid-
  // tune-up / mid-challenge / mid-bonus-round.
  const canOfferBonusMorePick =
    !!choiceHint &&
    !inTuneup &&
    !inChallenge &&
    !inStretch &&
    !inBonusMore &&
    !reprobeEligible;
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
  // The story's linked application is DELIBERATELY NOT offered here — the gift
  // stands alone at the close; the problem meets the scholar on the
  // re-encounter via the ordinary Go-deeper tail (which already attaches the
  // story hook). See review/done-screen-options.html §F2 + option E.
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
            tone: { bg: colors.indigoSubtle, border: colors.indigoMuted, text: colors.fg },
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
            tone: { bg: colors.orangeSubtle, border: colors.orange, text: colors.fg },
          },
        ]
      : []),
    ...(showMoreOfPick
      ? [
          {
            key: "bonus-more-of-pick",
            title: `More ${strandHeadlineFor(choiceHint!.domain, choiceHint!.strand)}?`,
            // When this run mapped the SAME domain the pick belongs to, name the
            // strand↔domain relationship so "More Area & Perimeter?" doesn't read
            // as a different thing from the "You mapped Geometry & measurement"
            // ceremony just above it — Area & Perimeter is a strand OF that
            // domain. Otherwise keep the plain copy. Mirrors the web twin.
            body:
              mappedDomainLabel &&
              practiceDomainLabel(choiceHint!.domain) === mappedDomainLabel
                ? `A few more on ${strandHeadlineFor(choiceHint!.domain, choiceHint!.strand)} — part of the ${mappedDomainLabel} you just mapped.`
                : "A few more on the topic you picked.",
            onAccept: () => void onAcceptBonusMorePick(),
            acceptLabel: "Let's go",
            disabled: bonusMoreLoading,
            tone: { bg: colors.violetSubtle, border: colors.violetMuted, text: colors.fg },
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
            tone: { bg: "rgba(0,221,145,0.12)", border: colors.green, text: colors.fg },
          },
        ]
      : []),
  ];


  if (
    (skillKey && targetedNode === undefined) ||
    (!isMixed && !mappingEntry && needsPlacement === undefined)
  ) {
    return (
      <>
        {header}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.violet} />
        </View>
      </>
    );
  }

  if (
    skillKey &&
    targetedNode !== undefined &&
    (targetedNode === null || !targetedNode.node.practiceServeable)
  ) {
    return (
      <>
        {header}
        <View style={styles.centered}>
          <Text style={styles.doneTitle}>Practice couldn’t start</Text>
          <Text style={styles.loadingText}>
            {targetedNode === null
              ? "We couldn’t find that skill. Return to your map and choose another node."
              : "That node doesn’t have practice available yet."}
          </Text>
        </View>
      </>
    );
  }

  // The finish-the-check-in accelerator (PR2, Surfaces 1/2): `?checkin=all`
  // (CheckInHomeCard's link) explicitly requests the full multi-domain
  // orchestrator INSTEAD OF Option D's ambient `· mapping` playlist band.
  // Checked BEFORE the single-domain placement gate (mutually exclusive:
  // `parsePracticeDeepLinkParams` only sets `checkInAllDomains` on the true
  // default no-pin entry, the same entry the single-domain gate never fires
  // for once a scholar has ≥1 started domain). Mirrors web
  // app/scholar/practice/page.tsx's `checkInAllDomains` prop exactly.
  if (checkInAllDomains && !placementDone) {
    return (
      <>
        <NativePlacement
          scholarId={scholarId}
          multiDomain
          topInset={insets.top}
          onBack={() => router.back()}
          onDone={() => {
            // f14: finishing the check-in goes HOME (the Tree reveal +
            // playlists chooser land there), not straight into more practice.
            setPlacementDone(true);
            router.replace("/");
          }}
        />
      </>
    );
  }

  // Placement gate: a brand-new scholar takes the placement quiz first — now
  // in-app, matching web (was a "do this on the web app" dead-end). Kept mounted
  // through its result screen via the latch (see enteredPlacement above).
  // A mixed playlist blends already-started domains, so placement never applies.
  // Option D: the default mapping entry retires this gate — an unmapped spot is
  // a `· mapping` band in the playlist instead.
  if (!isMixed && !mappingEntry && !placementDone && (needsPlacement === true || enteredPlacement)) {
    return (
      <>
        <NativePlacement
          scholarId={scholarId}
          {...(domain ? { domain } : {})}
          topInset={insets.top}
          onBack={() => router.back()}
          onDone={() => {
            // f14: finishing placement goes HOME (the Tree reveal + playlists
            // chooser land there), not straight into more practice.
            setPlacementDone(true);
            router.replace("/");
          }}
        />
      </>
    );
  }

  // A cache failure is not "still loading": the active server episode forbids
  // an ordinary replacement run, so surface the fail-closed reason truthfully.
  if (items === null && !breaker && error) {
    return (
      <>
        {header}
        <View style={styles.centered}>
          <Text style={styles.doneTitle}>Practice couldn’t continue</Text>
          <Text style={styles.loadingText}>{error}</Text>
        </View>
      </>
    );
  }

  // A hydrated breaker episode bypasses ordinary run loading only after its
  // exact render payload is installed (repair/coach) or its server-pinned
  // recovery item can be reconstructed (fresh/easy).
  if (items === null && !breaker) {
    return (
      <>
        {header}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.violet} />
          <Text style={styles.loadingText}>Loading your practice…</Text>
        </View>
      </>
    );
  }

  if (quickFacts && quickFactsUnavailableReason) {
    return (
      <>
        {header}
        <View style={styles.centered}>
          <Text style={styles.doneTitle}>No practice available yet</Text>
          <Text style={styles.loadingText}>
            {FAST_MATH_NAME} isn’t available yet. Try again later.
          </Text>
        </View>
      </>
    );
  }

  if (items?.length === 0 && !breaker) {
    // The plan boundary comes FIRST: a blocked run is empty for a reason that
    // has nothing to do with the scholar's progress, so neither the summit read
    // nor "no practice available yet" is the true story. Name the boundary and
    // its horizon — never a verdict about the kid. Mirrors the web twin.
    if (scopeBlocked) {
      return (
        <>
          {header}
          <View style={styles.centered}>
            <Text style={styles.doneTitle}>{PRACTICE_SCOPE_BLOCKED_HEADLINE}</Text>
            <Text style={styles.loadingText}>{PRACTICE_SCOPE_BLOCKED_DETAIL}</Text>
          </View>
        </>
      );
    }
    if (skillKey) {
      return (
        <>
          {header}
          <View style={styles.centered}>
            <Text style={styles.doneTitle}>No practice available yet</Text>
            <Text style={styles.loadingText}>
              Return to your map and choose another node.
            </Text>
          </View>
        </>
      );
    }
    // Empty queue = a true summit (whole domain fluent) or merely caught up.
    // SummitHandoff reads per-domain progress and picks the tone + a switcher.
    return (
      <>
        {header}
        <View style={styles.centered}>
          <SummitHandoff scholarId={scholarId} domain={domain} domains={isMixed ? domainSet : undefined} />
          <BonusChooser cards={bonusCards} />
        </View>
      </>
    );
  }

  if (phase === "retry") {
    // "Confirm before you cap": a first typed miss offers a two-way choice —
    // treat it as a slip and answer a fresh item on the same skill, or honestly
    // concede (which caps immediately, the fast path). No answer is revealed
    // here: a slip's confirm must stay a fair re-measurement. Mirrors web's
    // Placement retry screen (scholar-facing parity is a standing rule): the 🤔
    // prompt, the same wording, and slip-primary-then-concede order.
    return (
      <>
        {header}
        <View style={styles.centered}>
          <View style={{ width: "100%", maxWidth: COLUMN_MAX_WIDTH, gap: 20, alignItems: "center" }}>
            <Text style={{ fontSize: 40 }}>🤔</Text>
            <Text style={styles.doneTitle}>{PLACEMENT_SLIP_PROMPT}</Text>
            <View style={{ width: "100%", gap: 12 }}>
              <PracticePrimaryAction
                label={PLACEMENT_SLIP_RETRY_LABEL}
                accessibilityLabel={PLACEMENT_SLIP_RETRY_LABEL}
                styles={styles}
                indicatorColor={colors.white}
                onAction={onSlipRetry}
                style={{ width: "100%" }}
              />
              <Pressable
                disabled={busy}
                onPress={onSlipConcede}
                style={({ pressed }) => [
                  styles.ghostBtn,
                  { width: "100%" },
                  pressed && styles.ghostBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={PLACEMENT_SLIP_CONCEDE_LABEL}
              >
                <Text style={styles.ghostBtnText}>{PLACEMENT_SLIP_CONCEDE_LABEL}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </>
    );
  }

  // The three-miss repair card. It replaces a binary ask with work already in
  // progress: one step-card rung is pushed onto the item that broke, the coach
  // is an escalation beside it, and "Easy one, then stop" is a full-weight peer
  // at every step (never a low-contrast afterthought). Mirrors web exactly.
  if (phase === "breakerRepair" && breaker) {
    const freshAvailable = breaker.recoveryAvailable;
    const controls = breakerControls(breaker.flow, freshAvailable);
    const body = breakerBody(breaker.flow, freshAvailable);
    const showRung =
      breaker.flow.repair === "open" || breaker.flow.repair === "done";
    return (
      <>
        {header}
        <View style={styles.centered}>
          <View style={[styles.practicedCard, { width: "100%", maxWidth: COLUMN_MAX_WIDTH }]}>
            {body ? (
              <Text style={[styles.doneSubtle, { fontSize: 20, lineHeight: 30 }]}>
                {body}
              </Text>
            ) : null}
            {breaker.flow.repair === "opening" ? (
              <Text style={[styles.doneSubtle, { marginTop: 12 }]}>Finding it…</Text>
            ) : null}
            {showRung ? (
              <HintLadderSteps
                key={`breaker:${breaker.triggerItemId}:${
                  activeHintRung?.rung.stepIndex ?? `done-${hintRungs.length}`
                }`}
                completed={hintRungs}
                active={activeHintRung?.rung ?? null}
                styles={styles}
                colors={colors}
                onAttempt={() => machine.send({ type: "ui:breakerRepairStarted" })}
                onComplete={(revealedAfterWrong) => {
                  onHintStepComplete(revealedAfterWrong);
                  finishBreakerRepairStep();
                }}
              />
            ) : null}
            {hintStepError ? (
              <Text style={[styles.doneSubtle, { marginTop: 8 }]}>{hintStepError}</Text>
            ) : null}
            {breakerLifecycleRecoveryNeeded ? (
              <View style={{ gap: 8, marginTop: 12 }}>
                <Text style={styles.doneSubtle}>
                  That step couldn’t be saved yet. Your work is still here.
                </Text>
                <Pressable
                  onPress={() =>
                    machine.send({ type: "ui:retryBreakerLifecycle" })
                  }
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    { alignSelf: "flex-start" },
                    pressed && { opacity: 0.85 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Try again"
                >
                  <Text style={styles.secondaryBtnText}>Try again</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={[styles.twoBtnRow, { marginTop: 20 }]}>
              {controls.primary && controls.primary !== "checkStep" ? (
                controls.primary === "easyFinish" ? (
                  <Pressable
                    disabled={busy}
                    onPress={() => onBreakerControl("easyFinish")}
                    style={({ pressed }) => [
                      styles.ghostBtn,
                      styles.twoBtnHalf,
                      pressed && styles.ghostBtnPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={breakerControlLabel("easyFinish")}
                  >
                    <Text style={styles.ghostBtnText}>
                      {breakerControlLabel("easyFinish")}
                    </Text>
                  </Pressable>
                ) : (
                  <PracticePrimaryAction
                    label={breakerControlLabel(controls.primary)}
                    accessibilityLabel={breakerControlLabel(controls.primary)}
                    disabled={busy}
                    styles={styles}
                    indicatorColor={colors.white}
                    onAction={() => onBreakerControl(controls.primary!)}
                    style={styles.twoBtnHalf}
                  />
                )
              ) : null}
              {controls.peers.map((peer) => (
                <Pressable
                  key={peer}
                  disabled={busy}
                  onPress={() => onBreakerControl(peer)}
                  style={({ pressed }) => [
                    peer === "easyFinish" ? styles.ghostBtn : styles.secondaryBtn,
                    styles.twoBtnHalf,
                    pressed &&
                      (peer === "easyFinish"
                        ? styles.ghostBtnPressed
                        : { opacity: 0.85 }),
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={breakerControlLabel(peer)}
                >
                  <Text
                    style={
                      peer === "easyFinish"
                        ? styles.ghostBtnText
                        : styles.secondaryBtnText
                    }
                  >
                    {breakerControlLabel(peer)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      </>
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
      <>
        {header}
        <View style={styles.centered}>
          <View style={[styles.doneColumn, { width: "100%", maxWidth: COLUMN_MAX_WIDTH }]}>
            {recovered ? (
              <>
                <RecoveryArc reduceMotion={reduceMotion} />
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
                  style={styles.doneTitle}
                />
              </>
            ) : (
              <Text style={styles.doneTitle}>{breakerCloseLine(breaker.flow)}</Text>
            )}
            {/* After a missed fresh item the one remaining move is the quiet easy
                finish — never another hard problem or a duplicate stop action. */}
            {controls.primary === "easyFinish" ? (
              <Pressable
                disabled={busy}
                onPress={() => onBreakerControl("easyFinish")}
                style={({ pressed }) => [
                  styles.ghostBtn,
                  pressed && styles.ghostBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={breakerControlLabel("easyFinish")}
              >
                <Text style={styles.ghostBtnText}>
                  {breakerControlLabel("easyFinish")}
                </Text>
              </Pressable>
            ) : (
              <PracticePrimaryAction
                label="Done"
                accessibilityLabel="Done"
                styles={styles}
                indicatorColor={colors.white}
                onAction={() => router.replace("/")}
              />
            )}
          </View>
        </View>
      </>
    );
  }

  if (done) {
    const { correctCount, total, skills } = summarize(log);
    // Option D: an all-mapping run (or a domain that finished placing) closes on
    // the ceremony beat / domain-mapped moment — never a score.
    const wasMappingRun = allMapping || mappedDomainLabel !== null;
    const isCalibrationClose = firstPostPlacementBlock && !inTuneup && !inChallenge && !inStretch;
    // On an above-band challenge wrap, did her frontier actually move? Cleared
    // even WITH honest "I haven't learned this yet" flags (challengeFrontierMove).
    // When it did, the reveal (naming the skills she tested into) IS the payoff —
    // lead with it, drop the raw score, and suppress the redundant "You practiced"
    // list. Native has no teacher-rehearsal (?remote=) mode, so no gate is needed.
    const frontierMove = challengeFrontierMove(log);
    const showFrontierReveal = inChallenge && frontierMove.moved;
    // The reimagined growth headline (review/practice/completion-messaging-plan.html):
    // a specific, growth-framed line that LEADS the screen, replacing the flat
    // "Session complete" + hero score. The status word drops to a quiet eyebrow
    // and the count becomes a deemphasized receipt (D1). Calibration + a cleared
    // challenge keep their own portraits and aren't routed through this.
    // <PracticeDoneHeadline> renders the governed LLM line (cached) when ready,
    // else the deterministic fallback — so the screen never blocks.
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
    // The plain daily-playlist wrap — the ONLY arm whose close is state-aware.
    // Tune-up / bonus-more / challenge / mapping / stretch / calibration keep
    // their own portraits + the legacy Done / Practice again buttons. The
    // Stretch-TILE entry (isStretchHint) is the opt-in challenge tail, not the
    // daily set, so it keeps the legacy "Session complete" close too — and a
    // scoped Quick-facts round (`quickFacts`) is likewise NOT the daily
    // playlist, so it must never be classified as one (web parity: its
    // `plainPlaylistWrap` excludes `scopedByProp`). This is what keeps the
    // Continue-into-unrelated-playlist-work close and the story payoff off a
    // Fast math round's done screen.
    const plainPlaylistWrap =
      !inTuneup && !inChallenge && !inBonusMore && !wasMappingRun && !inStretch &&
      !isCalibrationClose && !showFrontierReveal && !isStretchHint && !skillKey &&
      !quickFacts;
    // While the reactive doneness query is still resolving (rare — it's
    // subscribed from mount), default to the honest stopping point (Done
    // primary): never flash a Continue toward more work we can't yet confirm.
    const playlistVerdict =
      playlistDoneness === undefined ? null : derivePlaylistDoneness(playlistDoneness);
    const playlistCaughtUp =
      !plainPlaylistWrap ||
      !playlistVerdict ||
      // A scope-blocked playlist is an honest stopping point for the CLOSE
      // (there genuinely is nothing more to serve), though never a completion.
      playlistVerdict.blocked ||
      playlistVerdict.caughtUp;
    const showContinue = plainPlaylistWrap && !playlistCaughtUp;
    // The story/quest card is the payoff for FINISHING the daily playlist, so
    // it only appears on a plain playlist wrap once we can CONFIRM the set is
    // caught up — never on a tune-up / challenge / bonus-more / mapping /
    // stretch / calibration / frontier / stretch-hint wrap, and never during
    // the doneness-loading window. Suppressing it (rather than firing it
    // mid-playlist) BURNS NOTHING: the card only mints the seed + starts the
    // 20h cooldown when it actually mounts, so the moment stays eligible and
    // waits for the true playlist-complete wrap. Gating here also removes the
    // two-competing-primaries screen — when the playlist isn't caught up,
    // `showContinue` owns the primary and the card is hidden.
    // Blocked is the mirror asymmetry of the loading window above: a boundary
    // stops the run without earning the payoff, so it never reads as complete.
    const playlistComplete = plainPlaylistWrap && !!playlistVerdict && playlistVerdict.caughtUp;
    // P4 ("primary means alone"): when the story announcement is actually on the
    // done screen (the arbiter's story primary AND the playlist-complete gate),
    // it is the ONLY offer — the reprobe offer and the "Keep going?" chooser are
    // suppressed (their eligibility persists to the next story-less close), and
    // the close is Done (showContinue is already false once playlistComplete).
    // Mirrors the web twin.
    const storyCardVisible =
      showStoryCard && !!storyMoment && !!scholarId && playlistComplete;
    return (
      <>
        {header}
        <ScrollView contentContainerStyle={styles.doneScroll}>
          <View style={styles.doneColumn}>
            {wasMappingRun ? (
              <>
                <Text style={styles.doneEyebrow}>{mappedDomainLabel ? "A DOMAIN MAPPED" : "MATH CHECK-IN"}</Text>
                {mappedDomainLabel ? (
                  <>
                    <Text style={styles.doneTitle}>You mapped {mappedDomainLabel} ✨</Text>
                    <Text style={styles.doneSubtle}>
                      Your tree just filled in ✨ — we can see where you&apos;re ready to grow.
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.doneTitle}>Your map is started ✨</Text>
                    <Text style={styles.doneSubtle}>
                      Nice mapping today. Your daily playlist picks up right where you&apos;re
                      ready to grow.
                    </Text>
                  </>
                )}
                <Text style={styles.doneSubtle}>🌳 Your Skills Tree lit up a new branch.</Text>
              </>
            ) : inStretch ? (
              <>
                <Text style={styles.doneEyebrow}>DEEP WATER</Text>
                {correctCount > 0 ? (
                  <>
                    <Text style={styles.doneTitle}>
                      You went deeper on {skills.length === 1 ? "a skill you own" : "skills you own"}.
                    </Text>
                    <Text style={styles.doneSubtle}>
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
                    <Text style={styles.doneTitle}>You stuck with it — and cracked it.</Text>
                    <Text style={styles.doneSubtle}>
                      Missing a problem like this on the first try is normal — coming back and
                      finding the idea anyway is exactly what these are for. That went on your
                      depth record.
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.doneTitle}>Those were meant to be hard.</Text>
                    <Text style={styles.doneSubtle}>
                      Wrestling with a problem like that IS the work — most people miss them the
                      first time, and nothing on your map went down. They&apos;ll be here when you
                      want another go.
                    </Text>
                  </>
                )}
              </>
            ) : isCalibrationClose ? (
              <>
                <Text style={styles.doneTitle}>We found your edge</Text>
                <Text style={styles.doneSubtle}>
                  This first set helped Rabbithole calibrate where to build next. We&apos;ll
                  practice from this edge, not from a score.
                </Text>
              </>
            ) : showFrontierReveal ? (
              <>
                <Text style={styles.doneEyebrow}>CHALLENGE DONE</Text>
                <FrontierMovedReveal skills={frontierMove.skills} />
              </>
            ) : (
              <>
                {/* Quiet status eyebrow; the growth headline is the hero. The
                    plain daily-playlist wrap names the real state — "Round
                    complete" when more is queued, "Playlist complete" when the
                    set is finished — instead of the old flat "Session complete". */}
                <Text style={styles.doneEyebrow}>
                  {inTuneup
                    ? "TUNE-UP DONE"
                    : inChallenge
                      ? "CHALLENGE DONE"
                      : plainPlaylistWrap
                        ? playlistCompleteEyebrow(playlistCaughtUp).toUpperCase()
                        : "SESSION COMPLETE"}
                </Text>
                <PracticeDoneHeadline
                  scholarId={scholarId}
                  signal={closureSignal}
                  fallback={closure.headline}
                  style={styles.doneTitle}
                />
                {/* The raw correctness count is never shown to the scholar
                    (pilot9 J4 ruling A: a portrait, not a scorecard) — the growth
                    headline is the whole close. */}
              </>
            )}
            {/* The "You practiced" roll-up would just repeat the reveal's named
                skills on a cleared challenge wrap — suppress it there. */}
            {!showFrontierReveal && !wasMappingRun ? (
              <View style={styles.practicedCard}>
                <Text style={styles.practicedEyebrow}>YOU PRACTICED</Text>
                {/* Bullet in its own column so a wrapping skill name keeps a
                    hanging indent (RN has no list-style; web uses a real <ul>). */}
                {skills.map((s) => (
                  <View key={s} style={styles.practicedRow}>
                    <Text style={[styles.practicedItem, styles.practicedBullet]}>•</Text>
                    <Text style={[styles.practicedItem, styles.practicedItemText]}>
                      {superscriptExponents(s)}
                    </Text>
                  </View>
                ))}
                {!storyCardVisible ? (
                  <DispatchCompletionReceipt
                    receipts={dispatchCompleted}
                    kind="math"
                  />
                ) : null}
              </View>
            ) : null}
            {/* Moments: the story reveal card — an invitation, never a reward
                pellet. Placed above the reprobe/bonus offers so it reads as
                its own distinct, rare moment. Keyed by edge identity so a
                genuinely different moment remounts fresh. Rendered as the
                completion arbiter's PRIMARY offer — never alongside an
                in-progress continuation (shared/completionOffers.ts). */}
            {showStoryCard && storyMoment && scholarId && playlistComplete ? (
              <StoryMomentCard
                key={`${storyMoment.fromKey}-${storyMoment.toKey}`}
                scholarId={scholarId}
                moment={storyMoment}
                settleRef={storyCardSettleRef}
              />
            ) : null}
            {storyCardVisible ? (
              <DispatchCompletionReceipt
                receipts={dispatchCompleted}
                kind="math"
              />
            ) : null}
            {!storyCardVisible && (showFrontierReveal || wasMappingRun) ? (
              <DispatchCompletionReceipt
                receipts={dispatchCompleted}
                kind="math"
              />
            ) : null}
            {/* Strand re-probe offer — "you're on a roll, jump ahead?" (§4). An
                EARNED offer (the engine detected a likely under-placement), not
                a bonus the scholar opts into for its own sake — keeps its own
                distinct slot ABOVE the "Keep going?" chooser. Only when the
                completion arbiter ranks it eligible (never mid-continuation). */}
            {showReprobe && reprobe && !storyCardVisible ? (
              <NativeReprobeOffer
                scholarId={scholarId}
                strand={reprobe.candidates[0].strand}
                domain={domain}
                styles={styles}
                onResolved={() => setReprobeResolved(true)}
              />
            ) : null}
            {/* The unified "Keep going?" bonus chooser (§C-3) — up to three
                tappable bonus cards (challenge / more-of-your-pick / tune-up).
                Skipping it is always fine; the calm summary above + Done /
                Practice again below are the default path regardless. Suppressed
                under a live story primary (P4) — the story stands alone. */}
            {!storyCardVisible ? <BonusChooser cards={bonusCards} /> : null}
            {queuedCount > 0 ? (
              <View style={styles.connectionBanner}>
                <Text style={styles.connectionBannerText}>
                  {queuedCount} answer{queuedCount === 1 ? "" : "s"} saved while
                  offline — we&apos;ll check {queuedCount === 1 ? "it" : "them"} for
                  real as soon as you&apos;re back online.
                </Text>
              </View>
            ) : null}
            {showContinue ? (
              <>
                {/* The playlist still has skills queued — the primary action
                    stays IN practice (a fresh run in the same scope), and Done
                    is demoted so leaving is a deliberate opt-out, not the
                    default eject. */}
                <Pressable
                  onPress={restartPractice}
                  style={({ pressed }) => [styles.primaryBtn, styles.doneCta, pressed && { opacity: 0.85 }]}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryBtnText}>Continue  →</Text>
                </Pressable>
                <Pressable onPress={goHome} style={[styles.linkBtn, styles.doneCta]} accessibilityRole="button">
                  <Text style={styles.linkBtnText}>Done</Text>
                </Pressable>
              </>
            ) : storyCardVisible ? (
              /* A story reveal is on screen: the reveal is the loud thing, so
                 Done goes QUIET — the demoted link control, not the primary
                 bar. Single-CTA hierarchy from the redesign (direction B): the
                 celebratory card outranks the quiet exit. Mirrors the web twin. */
              <Pressable onPress={goHome} style={[styles.linkBtn, styles.doneCta]} accessibilityRole="button">
                <Text style={styles.linkBtnText}>Done</Text>
              </Pressable>
            ) : (
              /* Caught up: ONE exit — no "Practice again". A standing "do it
                 all again" on a set the engine CONFIRMED finished is an
                 engagement-maximizing offer, and the objective function is
                 retention, never time-on-task. Mirrors the web twin exactly. */
              <Pressable
                onPress={goHome}
                style={({ pressed }) => [styles.primaryBtn, styles.doneCta, pressed && { opacity: 0.85 }]}
                accessibilityRole="button"
              >
                <Text style={styles.primaryBtnText}>Done</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </>
    );
  }

  // Defensive fallback for TypeScript's sake AND a genuine edge case: every
  // caller of a null `items` above either handled it directly (the loading
  // gate) or only applies while `breaker` is truthy AND its flow is
  // "repair"/"close" (both render from breaker+hint state alone). If a
  // breaker episode is hydrated but sitting in "coach" with no item installed
  // yet, land here instead of crashing on `items.length` below.
  if (!items) {
    return (
      <>
        {header}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.violet} />
          <Text style={styles.loadingText}>Loading your practice…</Text>
        </View>
      </>
    );
  }

  const pretestProgress = allMapping
    ? mappingPretestProgress(mappingProgressOffset + idx)
    : null;
  const progress =
    pretestProgress?.fraction ??
    progressFraction(idx, items.length, phase === "feedback");
  const isManipulative = current?.answerType === "manipulative";
  // Option D: the active item is a `· mapping` placement probe — silent
  // measurement (no reveal, teaching step, or retry/stuck).
  const isMapping = current?.lane === "mapping";
  const isHandoff = phase === "handoff";
  // Teach-as-action: an honest "I haven't learned this yet" shows the feedback
  // moment as ONE interactive faded worked step (TeachingStep) — for typed AND
  // manipulative items — so the manipulative branch yields to it. A mapping item
  // is placement measurement (reveal-only), so it never shows a teaching step.
  const showTeaching =
    phase === "feedback" &&
    !!result?.dontKnow &&
    !!current &&
    !isMapping &&
    onBreakerItem !== true;
  const verdict = result ? classifyVerdict(result, missCount) : null;
  // The stem card's overlay state: a stamp/ring/tint on correct or miss; nothing
  // on an honest don't-know (its own supportive note carries the moment).
  const cardFeedback: PracticeCardFeedback =
    phase === "feedback" && result && !result.dontKnow ? (result.correct ? "correct" : "miss") : null;
  // Predict-then-Check reveal — one gentle mismatch-only line above the card.
  const calibrationReveal =
    phase === "feedback" && result && revealPrediction !== null && !result.dontKnow
      ? mismatchReveal(revealPrediction, result.correct)
      : null;
  const isTypedItem = !!current && isPadAnswerType(current.answerType);
  const isMcItem =
    !!current && isMultipleChoiceItem(current.answerType, current.choices?.length);
  // Predict-then-Check confidence lives in the bottom lane, stacked above the Check
  // button (part of answering, not the question). Its slot is reserved (opacity 0)
  // across phases so the pinned CTA never moves; interactive only on a first look
  // at a typed / multiple-choice item.
  const confidenceSlotActive = isTypedItem || isMcItem;
  const confidenceInteractive =
    confidenceSlotActive && phase === "answering" && isFirstAttempt(hasRecorded);
  // Native has no rehearsal mode; that web-only flow cannot reach this screen.
  // The remaining gates mirror the shared help-used contract. Help-used is
  // gated on a REAL grade (`phase === "feedback"`), so a durably `queued`
  // answer (no verdict yet) never shows it — nothing to admit help on yet.
  const helpUsedVisible =
    phase === "feedback" &&
    result?.correct === true &&
    !isMapping &&
    !result.dontKnow &&
    !!result.attemptId &&
    onBreakerItem !== true &&
    current?.lane !== "stretch";
  const exampleVisible = phase === "answering" && !!strandExample;

  // The Launchpad doorway opens at the item it introduces (`launchpad.at`) and
  // is rendered INSTEAD of that item; `launchpadDone` then lets the same index
  // fall through to the item itself. One interception point, and `idx` never
  // shifts — it keeps indexing the graded `items` array exactly as before.
  const launchpadDoorwayOpen =
    !!launchpad &&
    !launchpadDone &&
    !enteredPlacement &&
    idx === launchpad.at &&
    !hasRecorded &&
    phase === "answering";
  if (launchpadDoorwayOpen && launchpad) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.screen}>
          {/* The doorway keeps the playlist's chrome — the same header and the
              same progress track the scholar sees on every other slot — so it
              reads as a beat IN the run rather than an interstitial in front of
              it. Web does exactly the same (parity is EXPERIENCE, not merely
              feature existence). */}
          <PracticeProgressHeader
            title={launchpad.entry.title}
            subtitle="FIRST LOOK"
            subtitleTone="muted"
            progressLabel={pretestProgress?.label ?? `${idx + 1} of ${items.length}`}
            progressAccessibilityLabel={
              pretestProgress
                ? `Question ${pretestProgress.label}`
                : `Question ${idx + 1} of ${items.length}`
            }
            progressPercent={Math.round(progress * 100)}
            segmentBoundaries={
              segments.length > 1 ? segmentStartIdx.slice(1).map((i) => i / items.length) : undefined
            }
            topInset={insets.top}
            onBack={() => router.back()}
          />
          <ScrollView
            style={styles.launchpadScroll}
            contentContainerStyle={styles.launchpadScrollContent}
            showsVerticalScrollIndicator={false}
          >
            <LaunchpadCard
              scholarId={scholarId}
              entry={launchpad.entry}
              onProceed={() => {
                setLaunchpadDone(true);
                // Generic bridge — harmless no-op if a lane was never entered
                // for this beat (the doorway is a separate render branch
                // nothing else runs alongside), and keeps every "a beat/tail
                // moved past" transition going through the SAME typed event.
                machine.send({ type: "lane:beatProceeded" });
              }}
            />
          </ScrollView>
        </View>
      </>
    );
  }

  // The game doorway, in exactly the Launchpad's shape. If both want the same
  // run, the Launchpad wins by being tested first: a first look at a strand
  // precedes a game about it, and the game will still be offered on a later run
  // (its cooldown is keyed to actual PLAY, not to having been passed over).
  const gameBeatDoorwayOpen =
    !!gameBeat &&
    !gameBeatDone &&
    !launchpadDoorwayOpen &&
    !enteredPlacement &&
    idx === gameBeat.at &&
    !hasRecorded &&
    phase === "answering";
  if (gameBeatDoorwayOpen && gameBeat) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.screen}>
          <PracticeProgressHeader
            title={gameBeat.entry.title}
            subtitle="A GAME"
            subtitleTone="muted"
            progressLabel={pretestProgress?.label ?? `${idx + 1} of ${items.length}`}
            progressAccessibilityLabel={
              pretestProgress
                ? `Question ${pretestProgress.label}`
                : `Question ${idx + 1} of ${items.length}`
            }
            progressPercent={Math.round(progress * 100)}
            segmentBoundaries={
              segments.length > 1 ? segmentStartIdx.slice(1).map((i) => i / items.length) : undefined
            }
            topInset={insets.top}
            onBack={() => router.back()}
          />
          <ScrollView
            style={styles.launchpadScroll}
            contentContainerStyle={styles.launchpadScrollContent}
            showsVerticalScrollIndicator={false}
          >
            <GameBeatCard
              entry={gameBeat.entry}
              onProceed={() => {
                setGameBeatDone(true);
                machine.send({ type: "lane:beatProceeded" });
              }}
            />
          </ScrollView>
        </View>
      </>
    );
  }

  return (
    <>
      {/* Custom header (native header hidden). We render our own bar so the
          progress cluster can sit TOP-RIGHT without iOS 26's Liquid Glass
          capsule — react-native-screens wraps any native `headerRight` item in a
          glass pill on iOS 26, which read as a tappable control. A plain view
          gives us the corner placement Andy wants with no button affordance.
          Layout: back chevron (left) · 2-line skill title (centered, so a long
          name never truncates the lane) · progress (right). Early/finished
          states keep the plain native `header` (no active skill to name). */}
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.screen}>
        <PracticeProgressHeader
          title={superscriptExponents(current?.skillLabel ?? "Practice")}
          subtitle={
            current?.lane === "review"
              ? "REVIEW"
              : current?.lane === "challenge"
                ? "CHALLENGE"
                : current?.lane === "stretch"
                  ? "STRETCH"
                  : current?.lane === "mapping"
                    ? allMapping
                      ? "MATH CHECK-IN"
                      : "MAPPING"
                    : undefined
          }
          subtitleTone={
            current?.lane === "challenge"
              ? "challenge"
              : current?.lane === "stretch"
                ? "stretch"
                : current?.lane === "mapping"
                  ? "mapping"
                  : "muted"
          }
          progressLabel={pretestProgress?.label ?? `${idx + 1} of ${items.length}`}
          progressAccessibilityLabel={
            pretestProgress
              ? `Question ${pretestProgress.label}`
              : `Question ${idx + 1} of ${items.length}`
          }
          progressPercent={Math.round(progress * 100)}
          // Playlist segments v1 (raise-the-ceiling §11 / C-4): segment-boundary
          // offsets for the progress track's divider ticks (real data — where
          // one beat ends and the next begins). Falls back to no dividers when
          // there's only one segment.
          segmentBoundaries={
            segments.length > 1 ? segmentStartIdx.slice(1).map((i) => i / items.length) : undefined
          }
          topInset={insets.top}
          onBack={() => router.back()}
        />
        {outboxStatusText ? (
          <View style={styles.connectionBanner}>
            <Text style={styles.connectionBannerText}>{outboxStatusText}</Text>
          </View>
        ) : null}

        {/* Founder amendment (2026-07-19): ceremony HEADER, not ceremony block.
            The all-mapping "Math Check-In" run wears its identity in the header
            eyebrow ("MATH CHECK-IN" instead of "MAPPING", above) — the extra
            in-drill title + intro copy that used to sit here was killed as an
            oddly-positioned duplicate of the Home card's framing. */}

        {/* Playlist segment beat: a light, growth-framed heading shown once, on
            the FIRST item of a segment — never repeated per item, never a
            reward/score. Skipped when the whole session is one segment (nothing to
            announce) and never shown for a `· mapping` segment — mapping carries
            its identity in the header eyebrow alone, with no beat (founder
            amendment 2026-07-19 #2, superseding the per-segment reassurance). */}
        {segmentBeatVisibleForKind(segments.length, currentSegment?.kind) &&
        isSegmentStart &&
        currentSegment ? (
          <View style={styles.segmentBeatRow}>
            <Text style={styles.segmentBeatText}>
              {segmentBeatLabel(currentSegment.kind, !!isFirstCoreDrillSegment)}
            </Text>
          </View>
        ) : null}

        {/* Per-item domain chip — shown ONLY in a mixed playlist, so the scholar
            sees when the subject switches. A plain even-bordered pill (no accent
            stripe/gradient — visual-design rules); the human label comes from the
            domain registry, never the raw slug. Mirrors web. */}
        {isMixed && current?.domain ? (
          <View style={styles.domainChipRow}>
            <View style={styles.domainChip}>
              <Text style={styles.domainChipText}>{practiceDomainLabel(current.domain)}</Text>
            </View>
          </View>
        ) : null}

        {isManipulative && current && !isHandoff && !showTeaching ? (
          // Reuse the shared manipulative item card verbatim — it grades through
          // the SAME `ui:submit` path a typed/MC answer uses (never a second
          // direct `submitAnswer` mutation — see `submitManipulativeAnswer`),
          // shows its own verdict/queued note + extraCredit badge, and routes
          // unsupported kinds to the WebView embed. onRequestClose is our
          // advance (its "Done ›" and "Close" both call it). onDontKnow wires
          // the SAME honest don't-know flow the pad items use → the teach-as-action
          // moment (which is why this branch yields to `showTeaching`). No
          // `onGraded` — the canonical bookkeeping (log/streak/breaker/resume)
          // already happens generically in `onGrade`, the machine's OWN host
          // binding, fired from the executor independently of this card.
          <NativeManipulativeItem
            key={current.itemId}
            itemId={current.itemId}
            scholarId={scholarId}
            shell={styles}
            isLast={onBreakerItem || isLastItem(idx, items.length)}
            getSubmissionContext={breakerManipulativeSubmitContext}
            submitAnswerOverride={submitManipulativeAnswer}
            onDontKnow={() => void onDontKnow()}
            online={online}
            onRequestClose={
              onBreakerItem ? finishBreakerItem : advance
            }
          />
        ) : isHandoff ? (
          // Teachable-moment phase keeps the bottom-anchored choreography: the
          // stem stays as context and the Socratic chat rises from below,
          // pushing the problem up (the pad→text morph in the same low slot).
          // Answer-safe by the same server backstop as web.
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.transcriptScroll}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            keyboardShouldPersistTaps="handled"
          >
            <Reanimated.View
              key={current?.itemId ?? "none"}
              entering={reduceMotion ? undefined : FadeInDown.duration(420).delay(RISE_STAGGER_MS)}
              exiting={reduceMotion ? undefined : FloatOffTop.duration(FLOAT_OFF_MS)}
              style={styles.itemColumn}
            >
              {current?.storyHook ? (
                <Text style={styles.storyHook}>{current.storyHook}</Text>
              ) : null}
              <StemCard
                stem={current?.stem}
                promptVisual={current?.promptVisual}
                feedback={null}
                reduceMotion={reduceMotion}
                styles={styles}
                speakable={currentIsKinder}
                big={!!current?.isFactSprint}
              />
              {current ? (
                <HandoffChat
                  handoff={handoff}
                  input={handoffInput}
                  onChangeInput={setHandoffInput}
                  onSend={(t) => void onHandoffSend(t)}
                  image={chatImage}
                  imageUploadTarget={practiceImageTarget(
                    handoff?.mode === "dialogue" ? "dialogue" : "handoff",
                  )}
                  // A stretch puzzle has no fresh VARIANT — after the walkthrough
                  // she takes another run at the SAME item (onHandoffRetry exits
                  // the lane with outcome "retry-same"; the answer was never
                  // revealed).
                  onFreshVariant={
                    current?.lane === "stretch"
                      ? onHandoffRetry
                      : () => void onFreshVariant()
                  }
                  breakerFreshAvailable={breaker?.recoveryAvailable}
                  {...(handoff?.entryMode === "spiral"
                    ? { onBreakerEasyFinish: () => machine.send({ type: "ui:breakerEasyFinish" }) }
                    : {})}
                  stretchLane={current?.lane === "stretch"}
                  dialogueVerdict={dialogueVerdict}
                  onDialogueCheck={() => void onDialogueCheck()}
                  onAdvance={onHandoffAdvance}
                  isLast={isLastItem(idx, items.length)}
                  busy={busy || hintRungActiveForCurrent}
                  styles={styles}
                  colors={colors}
                />
              ) : null}
            </Reanimated.View>
          </ScrollView>
        ) : (
          // §9 no-shift: answering + feedback share ONE layout. The problem card
          // is vertically centered on a stage that still scrolls a tall don't-know
          // explanation; correctness is an OVERLAY on the card (stamp + ring +
          // field tint), never an inline box; and the CTA lives in a lane pinned
          // to the bottom of the screen. So submit→feedback never moves the card.
          //
          // The float-up choreography is preserved: on advance the solved item's
          // wrapper floats the full screen height off the top (FloatOffTop) while
          // the next problem rises in, staggered (FadeInDown.delay).
          <>
            <ScrollView
              ref={scrollRef}
              style={styles.stageScrollFlex}
              contentContainerStyle={styles.stageScroll}
              keyboardShouldPersistTaps="handled"
            >
              <Reanimated.View
                key={current?.itemId ?? "none"}
                entering={reduceMotion ? undefined : FadeInDown.duration(420).delay(RISE_STAGGER_MS)}
                exiting={reduceMotion ? undefined : FloatOffTop.duration(FLOAT_OFF_MS)}
                style={styles.itemColumn}
              >
                {calibrationReveal ? (
                  <View style={styles.calibrationReveal}>
                    <Text style={styles.calibrationRevealText}>{calibrationReveal}</Text>
                  </View>
                ) : null}

                {current?.storyHook ? (
                  <Text style={styles.storyHook}>{current.storyHook}</Text>
                ) : null}
                <StemCard
                  stem={current?.stem}
                  promptVisual={current?.promptVisual}
                  feedback={cardFeedback}
                  reduceMotion={reduceMotion}
                  styles={styles}
                  speakable={currentIsKinder}
                  big={!!current?.isFactSprint}
                />

                {/* Backward-faded worked-example scaffold — answering only. */}
                {phase === "answering" && current?.workedSteps ? (
                  <WorkedSteps steps={current.workedSteps} />
                ) : null}

                {showTeaching && current ? (
                  // Teach-as-action — after "I haven't learned this yet", ONE
                  // interactive faded step to finish (doing it IS the reading).
                  // Records nothing; degrades to reveal-only for a step-less item
                  // or a manipulative. Holds Continue until attempted (onReady).
                  <TeachingStep
                    key={current.itemId}
                    scholarId={scholarId}
                    itemId={current.itemId}
                    styles={styles}
                    colors={colors}
                    onReady={() => setDontKnowStepReady(true)}
                    onEscalate={onTalkItThrough}
                  />
                ) : (
                  <>
                    {current ? (
                      <AnswerArea
                        item={current}
                        phase={phase}
                        result={phase === "feedback" ? result : null}
                        input={input}
                        busy={busy}
                        error={error}
                        unitNudge={unitNudge}
                        styles={styles}
                        colors={colors}
                        onKey={onKey}
                        onInput={onInput}
                        onSubmit={onSubmit}
                        onCheck={onCheck}
                        onSkip={advance}
                        onRetryIntent={
                          phase === "feedback" &&
                          !!result &&
                          !result.correct &&
                          !result.dontKnow &&
                          !isMapping &&
                          onBreakerItem !== true &&
                          verdict === "retry" &&
                          !busy
                            ? onRetry
                            : undefined
                        }
                      />
                    ) : null}

                    {phase === "feedback" && result ? (
                      <View style={styles.noteAnchor} pointerEvents="box-none">
                        <FeedbackNote
                          result={result}
                          verdict={verdict}
                          comesBackText={comesBackText}
                          stretchLane={current?.lane === "stretch"}
                          mappingReveal={isMapping}
                          styles={styles}
                          colors={colors}
                        />
                      </View>
                    ) : null}
                  </>
                )}
              </Reanimated.View>
            </ScrollView>

            <PracticeHelpRow
              // Keyed on the item AND the phase so the hint collapses both on a
              // new item and on "Try again" — without the phase, `showHint`
              // would survive the feedback round-trip and the panel would pop
              // back open by itself on retry, shoving the pinned CTA down with
              // nothing touched. (Web does the same explicitly in `onRetry`.)
              key={`${current?.itemId ?? "none"}:${phase}`}
              skillKey={isMapping ? undefined : current?.skillKey}
              phase={phase}
              showHint={hintItemId === current?.itemId && showHint}
              hintRungs={hintItemId === current?.itemId ? hintRungs : []}
              activeHintRung={hintItemId === current?.itemId ? activeHintRung?.rung ?? null : null}
              hintStepsExhausted={hintItemId === current?.itemId && hintStepsExhausted}
              hintStepLoading={hintStepLoading}
              hintStepError={hintItemId === current?.itemId ? hintStepError : null}
              onHintPress={() => void onHintLadderPress()}
              onHintStepComplete={onHintStepComplete}
              confidenceSlotActive={confidenceSlotActive}
              confidenceInteractive={confidenceInteractive}
              confidence={predictedConfidence}
              onConfidenceChange={setPredictedConfidence}
              helpUsedVisible={helpUsedVisible}
              helpReported={helpReported}
              helpPending={helpPending}
              onReportHelpUsed={() => void onReportHelpUsed()}
              exampleVisible={exampleVisible}
              onExamplePress={() => setExampleSheetOpen(true)}
              // The honest "I haven't learned this yet" escape — offered on a first
              // look at a typed OR a multiple-choice item, so MC never forces a guess
              // (pilot9 J5 founder ruling; same onDontKnow + copy as typed). A
              // manipulative item carries its own escape in NativeManipulativeItem.
              // Hidden (not merely disabled) while offline — matching web's
              // `skipVisible` exactly: a documented no-op reads as confusing if
              // the affordance still looks pressable.
              showSkip={
                phase === "answering" &&
                online &&
                isFirstAttempt(hasRecorded) &&
                (isTypedItem || isMcItem)
              }
              onDontKnow={() => void onDontKnow()}
              busy={busy}
              styles={styles}
              colors={colors}
            />

            <CtaLane
              phase={phase}
              result={phase === "feedback" ? result : null}
              verdict={verdict}
              online={online}
              mappingReveal={isMapping}
              recoveryMode={onBreakerItem}
              isLast={isLastItem(idx, items.length)}
              busy={busy}
              dontKnowReady={dontKnowStepReady}
              showCheck={phase === "answering" && isTypedItem}
              checkDisabled={busy || hintBlocksMainSubmit || !input.trim()}
              onSubmit={onCheck}
              onNext={advance}
              onRetry={onRetry}
              onTalkItThrough={onTalkItThrough}
              // A stretch puzzle has no fresh VARIANT (the insight is the item) —
              // the stuck "Continue" just advances instead.
              onFreshVariant={current?.lane === "stretch" ? advance : onFreshVariant}
              onRecoveryDone={finishBreakerItem}
              showBreakerEasyExit={
                breaker?.flow.stage === "fresh" &&
                (phase === "answering" ||
                  (phase === "feedback" && result?.correct === false))
              }
              onBreakerEasyFinish={() => machine.send({ type: "ui:breakerEasyFinish" })}
              styles={styles}
              colors={colors}
            />
          </>
        )}

        {strandExample && scholarId ? (
          <InstructionExampleSheet
            open={exampleSheetOpen}
            onClose={() => setExampleSheetOpen(false)}
            scholarId={scholarId}
            skillKey={current?.skillKey ?? ""}
            content={strandExample}
          />
        ) : null}
      </View>
    </>
  );
}

// ── Strand re-probe (§4) ───────────────────────────────────────────────────────

type ReprobeProbe = {
  itemId: string;
  skillKey: string;
  stem: string;
  answerType: string;
  /** The measurement unit this probe must be answered in, DISPLAY form ("cm³").
   *  Present ⇒ the unit is part of the answer (the finalizer grades value AND
   *  unit), exactly as in the drill — the pad offers unit keys and an unlabeled
   *  answer is nudged back before it's committed. */
  answerUnit?: string;
  choices?: string[];
  promptVisual?: PracticePromptVisual;
  answerShape?: "twoD";
};

type ReprobeAnswer = { itemId: string; answer: string };

/**
 * PracticeDoneHeadline — mounts the closure hook inside the done branch (hooks
 * can't run inside the conditional render above), and renders the governed
 * generated growth line when it arrives, else the deterministic fallback. The
 * fallback paints immediately, so the screen never waits on the model.
 */
function PracticeDoneHeadline({
  scholarId,
  signal,
  fallback,
  style,
}: {
  scholarId: Id<"users"> | undefined;
  signal: PracticeSignal;
  fallback: string;
  style: StyleProp<TextStyle>;
}) {
  const generated = useEnsuredClosure(scholarId, "practice", signal);
  return <Text style={style}>{generated ?? fallback}</Text>;
}

/**
 * NativeReprobeOffer — the RN analogue of web `components/practice/ReprobeOffer.tsx`
 * (the "you're on a roll, jump ahead?" strand re-probe). Same backend contract:
 * `reprobeProbes` serves one adaptive probe at a time given the answers so far,
 * finalized by `submitReprobe`, which credits any newly-cleared nodes and moves
 * the frontier. Framed as a learning event ("your frontier moved") — never a
 * score, timer, or streak. Reuses the practice number pad for the probe input
 * (probes are numeric; a non-pad answerType is coerced to a keypad, mirroring web),
 * unit keys and all when the probe carries an `answerUnit`. One asymmetry with the
 * drill: a re-probe grades ONCE at finalize over the accumulated answers, so no
 * per-item verdict — and no `unitOutcome` — ever comes back. The pre-submit gate
 * is the only thing standing between a slip and a spent probe.
 */
function NativeReprobeOffer({
  scholarId,
  strand,
  domain,
  styles,
  onStart,
  onResolved,
}: {
  scholarId: Id<"users">;
  strand: string;
  domain?: string;
  styles: Styles;
  /** Called once, the instant the kid taps "Jump ahead" — before any network
   *  round-trip. Lets the parent settle a still-pending Moments story card
   *  (the completion arbiter's contract — see shared/completionOffers.ts).
   *  Optional — declining never calls it. */
  onStart?: () => void;
  onResolved: () => void;
}) {
  const convex = useConvex();
  const submit = useMutation(api.practiceSkills.submitReprobe);
  const [phase, setPhase] = useState<"offer" | "probing" | "submitting" | "result">("offer");
  const [probe, setProbe] = useState<ReprobeProbe | null>(null);
  const [answers, setAnswers] = useState<ReprobeAnswer[]>([]);
  const [input, setInput] = useState("");
  // The probe whose Next was refused for a missing unit — cleared on the next
  // input change. Keyed by itemId (not a bare flag) so it can't outlive its probe.
  const [unitNudgeItemId, setUnitNudgeItemId] = useState<string | null>(null);
  const [seed] = useState(() => Math.floor(Math.random() * 2_000_000_000));
  const [movedCount, setMovedCount] = useState(0);
  const commitInFlightRef = useRef(false);

  const advance = useCallback(
    async (all: ReprobeAnswer[]) => {
      const res = await convex.query(api.practiceSkills.reprobeProbes, {
        scholarId,
        strand,
        answers: all,
        seed,
        ...(domain ? { domain } : {}),
      });
      if (res.done || !res.probe) {
        setPhase("submitting");
        const finished = await submit({
          scholarId,
          strand,
          answers: all,
          ...(domain ? { domain } : {}),
        });
        setMovedCount(finished.creditedKeys.length);
        setPhase("result");
        return;
      }
      setProbe(res.probe as ReprobeProbe);
    },
    [convex, scholarId, strand, domain, seed, submit],
  );

  const start = useCallback(() => {
    onStart?.();
    setPhase("probing");
    void advance([]);
  }, [advance, onStart]);

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

  const commitAnswer = useCallback(
    (answer: string) => {
      if (!probe || commitInFlightRef.current) return;
      commitInFlightRef.current = true;
      const all = [...answers, { itemId: probe.itemId, answer }];
      setAnswers(all);
      setInput("");
      setUnitNudgeItemId(null);
      setProbe(null);
      void advance(all).finally(() => {
        commitInFlightRef.current = false;
      });
    },
    [probe, answers, advance],
  );

  const onNext = useCallback(() => {
    if (!probe) return;
    commitAnswer(input.trim() || "skip");
  }, [probe, input, commitAnswer]);
  // A unit probe's answer isn't finished until it carries a unit — an unlabeled
  // number grades INCORRECT at finalize (`submitReprobe` → `gradeOutcomes`), and
  // a re-probe answer is spent the instant it's committed: the run accumulates
  // answers client-side and grades them once at the end, so no per-item verdict
  // ever comes back to soften the slip. This gate is the whole protection. Any
  // trailing unit token passes — a WRONG unit is the grader's call, not ours.
  // Only a genuinely TYPED probe is gated: a multipleChoice probe commits an
  // option index (and a choice-less one coerced onto the pad answers with no
  // measurement either), and Skip is deliberately exempt below.
  const unitAnswerRequired =
    !!probe?.answerUnit && isPadAnswerType(probe?.answerType ?? "");
  // An EMPTY field is the skip path (Next commits "skip"), so it passes — unlike
  // the drill, whose Check is disabled until something is typed.
  const unitReady = !unitAnswerRequired || !input.trim() || hasUnitToken(input.trim());
  const unitNudge = !!probe && unitNudgeItemId === probe.itemId;
  // Refusing INSIDE the guarded action would latch it (its fired-flag only
  // releases when `enabled` or the reset key changes), leaving Next dead.
  const onNextGuarded = useGuardedPracticeAction(
    onNext,
    phase === "probing" && !!probe && unitReady,
    `reprobe:${probe?.itemId ?? "none"}:${phase}`,
  );
  const onNextPrimary = useCallback(() => {
    // `unitReady` is false only when something unit-less was typed.
    if (probe && !unitReady) {
      setUnitNudgeItemId(probe.itemId);
      return;
    }
    onNextGuarded();
  }, [probe, unitReady, onNextGuarded]);
  // Skip — deliberately UNGATED: a scholar bailing out of a probe must never be
  // held behind a formatting nudge. Commits whatever is in the field, as before.
  const onSkipPrimary = useGuardedPracticeAction(
    onNext,
    phase === "probing" && !!probe,
    `reprobe-skip:${probe?.itemId ?? "none"}:${phase}`,
  );

  if (phase === "offer") {
    return (
      <View style={styles.reprobeCard}>
        <Text style={styles.reprobeTitle}>You&apos;re on a roll 🔥</Text>
        <Text style={styles.reprobeBody}>Want to jump ahead and find your real frontier?</Text>
        <Pressable
          onPress={start}
          style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
        >
          <Text style={styles.primaryBtnText}>Jump ahead  →</Text>
        </Pressable>
        <Pressable onPress={onResolved} style={styles.linkBtn} accessibilityRole="button">
          <Text style={styles.linkBtnText}>Keep going here</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === "submitting") {
    return (
      <View style={styles.reprobeCard}>
        <Text style={styles.reprobeBody}>Finding your edge…</Text>
      </View>
    );
  }

  if (phase === "result") {
    return (
      <View style={styles.reprobeCard}>
        {movedCount > 0 ? (
          <>
            <Text style={styles.reprobeTitle}>⛰ Your frontier moved</Text>
            <Text style={styles.reprobeBody}>
              {movedCount} more skill{movedCount === 1 ? " is" : "s are"} yours now — your next
              practice picks up from there.
            </Text>
          </>
        ) : (
          <Text style={styles.reprobeBody}>
            Nice — you&apos;re right at your edge already. Let&apos;s keep building from here.
          </Text>
        )}
        <Pressable
          onPress={onResolved}
          style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
        >
          <Text style={styles.primaryBtnText}>Keep going  →</Text>
        </Pressable>
        <HardwareReturnAdvance onReturn={onResolved} />
      </View>
    );
  }

  // phase === "probing": adaptive probe stem + input. A multipleChoice probe
  // (fraction comparison) renders tappable options — a scholar can't type
  // `<`/`=`/`>`; anything else uses the number pad. Mirrors web's ReprobeOffer.
  const probeAnswerType = probe?.answerType;
  const padType: PadAnswerType =
    probeAnswerType && isPadAnswerType(probeAnswerType) ? probeAnswerType : "integer";
  const showChoices =
    probe?.answerType === "multipleChoice" && (probe.choices?.length ?? 0) > 0;
  return (
    <View style={styles.reprobeProbeCard}>
      <Text style={styles.reprobeEyebrow}>Jumping ahead — a few tougher ones</Text>
      <View style={styles.stemBox}>
        <StemText value={superscriptExponents(probe?.stem ?? "…")} fontSize={28} align="center" />
        {probe?.promptVisual ? <PromptVisual spec={probe.promptVisual} /> : null}
      </View>
      {showChoices ? (
        <View style={styles.choices}>
          {probe!.choices!.map((choice, i) => (
            <Pressable
              key={`${i}-${choice}`}
              disabled={!probe}
              onPress={() => commitAnswer(choiceSubmitValue(i))}
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
          <Pressable onPress={onSkipPrimary} style={styles.linkBtn} accessibilityRole="button">
            <Text style={styles.linkBtnText}>Skip this one</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <PracticePadAnswer
            answerType={padType}
            answerShape={probe?.answerShape}
            answerUnit={unitAnswerRequired ? probe?.answerUnit : undefined}
            unitNudge={unitNudge}
            value={input}
            enabled={!!probe}
            focusKey={`${probe?.itemId ?? "none"}:answering`}
            placeholderColor={styles.inputPlaceholder.color}
            styles={styles}
            onChange={onInput}
            onKey={onKey}
            onSubmit={onNextPrimary}
          />
          <PracticePrimaryAction
            label="Next  →"
            accessibilityLabel="Next probe"
            disabled={!probe}
            styles={styles}
            indicatorColor="#fff"
            onAction={onNextPrimary}
          />
          <Pressable onPress={onSkipPrimary} style={styles.linkBtn} accessibilityRole="button">
            <Text style={styles.linkBtnText}>Skip this one</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

// ── Teach-as-action (the "I haven't learned this yet" moment) ─────────────────

/** Grace period before an unresolved query unlocks Continue on its own — a query
 *  stalling on flaky wifi must never trap the scholar behind a gated CTA.
 *  Mirrors web's TeachingStep RESOLVE_WATCHDOG_MS. */
const TEACH_RESOLVE_WATCHDOG_MS = 8_000;

/**
 * TeachingStep (native) — the RN mirror of web `components/practice/TeachingStep.tsx`.
 * On "I haven't learned this yet", instead of a passive streamed explanation a
 * young scholar dismisses, we reveal every worked step EXCEPT the final,
 * answer-producing one and ask the scholar to finish that single step: doing the
 * step IS the reading. The parent gates its Continue on `onReady`, which fires
 * once the scholar has ATTEMPTED the blank (one attempt is enough — a wrong try
 * briefly reveals the value, then continues; never trapped).
 *
 * Purely instructional: it records NOTHING. The one blank is graded CLIENT-SIDE
 * with the SAME pure `parseAnswer`/`answersEqual` the server grader uses (so
 * 6/8 ≡ 0.75 still matches), and no mutation is called — the step can never move
 * mastery or placement scoring. Steps + reveal value come from the read-only
 * `api.practiceSkills.teachingStep` query.
 *
 * When the item has no worked steps (a template drill item, a one-step item, or
 * a manipulative), the query returns `steps: null` and this degrades to
 * reveal-only: a supportive line + the answer, and `onReady` fires so Continue
 * never dead-ends. No auto-TTS — the revealed steps + reveal line are tap-to-hear
 * only (SpeakableLabel), never played on their own.
 *
 * ── THE HINT LADDER ────────────────────────────────────────────────────────
 * "I'm still stuck" always has somewhere to go that isn't the answer:
 *   tier 1  the blank NAMES the move       — "Add the partial quotients: ?"
 *   tier 2  the move, SET UP but not done  — "…: 100 + 30 + 6 = ?"  (`hint`)
 *   tier 3  a person — the Socratic handoff (`onEscalate`), the same companion
 *           two wrong guesses already unlock. Honesty must earn at least what
 *           guessing earns; before this it earned strictly less.
 * An item with no honest tier 2 (`hint: null`) escalates straight to tier 3.
 *
 * The rung reached is reported through `recordTeachingOutcome` — the one thing
 * this component writes. It patches the scholar's existing don't-know row, is
 * best-effort, and still cannot move mastery: the blank stays client-graded.
 */
function TeachingStep({
  scholarId,
  itemId,
  styles,
  colors,
  onReady,
  onEscalate,
}: {
  scholarId: Id<"users">;
  itemId: string;
  styles: Styles;
  colors: ColorSet;
  /** Fired once the scholar may proceed — they attempted the step, OR there's no
   *  step to do (reveal-only) / the query stalled. */
  onReady: () => void;
  /** Tier 3 — hand off to the Socratic companion. Omit to hide the escalation
   *  (the ladder then ends at the tier-2 hint). */
  onEscalate?: () => void;
}) {
  const step = useQuery(api.practiceSkills.teachingStep, { scholarId, itemId });
  const recordOutcome = useMutation(api.practiceSkills.recordTeachingOutcome);
  const [input, setInput] = useState("");
  const inputBuffer = useRef("");
  const [attempt, setAttempt] = useState<{ correct: boolean; input: string } | null>(null);
  const [hintShown, setHintShown] = useState(false);
  const [missedOnce, setMissedOnce] = useState(false);

  // Bookkeeping only — a failure here must never break the teaching moment.
  const report = useCallback(
    (outcome: "solved" | "hint" | "stuck") => {
      void recordOutcome({ scholarId, itemId, outcome }).catch(() => {});
    },
    [recordOutcome, scholarId, itemId],
  );

  // Fire `onReady` at most once — the parent gates a boolean on it, so a stray
  // second call is harmless, but a ref keeps the effects from re-notifying.
  const readyRef = useRef(false);
  const notifyReady = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    onReady();
  }, [onReady]);

  const stepsResult = step?.steps ?? null;
  const answerType = step?.answerType ?? "integer";
  const padType: PadAnswerType | null = isPadAnswerType(answerType) ? answerType : null;

  // No interactive step (reveal-only, or a non-pad answer we can't collect) →
  // unlock the moment immediately.
  useEffect(() => {
    if (step === undefined) return;
    if (stepsResult === null || padType === null) notifyReady();
  }, [step, stepsResult, padType, notifyReady]);

  // Watchdog: if the query hasn't resolved in time, unlock anyway.
  useEffect(() => {
    if (step !== undefined) return;
    const t = setTimeout(notifyReady, TEACH_RESOLVE_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [step, notifyReady]);

  const onInput = useCallback(
    (value: string) => setInput(setInputBuffer(inputBuffer, value)),
    [],
  );
  const onKey = useCallback(
    (key: string) => setInput(applyKeyToInputBuffer(inputBuffer, key)),
    [],
  );

  if (step === undefined) {
    return <Text style={styles.teachSetup}>Setting up one step…</Text>;
  }

  const answer = step.answer ?? "";

  // Reveal-only degrade: no worked steps for this item (a template/one-step drill
  // or a manipulative). A supportive line + the answer, both tap-to-hear.
  if (stepsResult === null || padType === null) {
    return (
      <View style={styles.teachRevealOnly}>
        <Text style={styles.teachHeading}>Good to know 👍 Telling us is the smart move.</Text>
        {answer ? (
          <SpeakableLabel
            text={`The answer is ${answer} — now you've seen it.`}
            tapAnywhere
            accessibilityLabel="Hear the answer"
          >
            <Text style={styles.teachRevealText}>
              The answer is {superscriptExponents(answer)} — now you&apos;ve seen it.
            </Text>
          </SpeakableLabel>
        ) : null}
      </View>
    );
  }

  const hint = step.hint ?? null;
  const onCheck = () => {
    if (attempt) return;
    const submittedInput = inputBuffer.current.trim();
    const correct = rawAnswersEqual(submittedInput, answer, answerType as GradeAnswerType);
    // Either way the scholar has now ATTEMPTED, so Next unlocks — a wrong guess
    // must never trap them, whatever the ladder does next.
    notifyReady();
    const move = nextTeachingMove(correct, { hasHint: !!hint, hintShown });
    report(move.outcome);
    if (move.kind === "hint") {
      setHintShown(true);
      setMissedOnce(true);
      setInput("");
      inputBuffer.current = "";
      return;
    }
    setAttempt({ correct, input: submittedInput });
  };

  // "I'm still stuck" — step DOWN the ladder, never straight to the answer:
  // the tier-2 hint first if there is one, then the companion tutor.
  const onStillStuck = () => {
    if (hint && !hintShown) {
      setHintShown(true);
      return;
    }
    report("stuck");
    notifyReady();
    onEscalate?.();
  };
  const stillStuckAvail = stillStuckAvailable({ hasHint: !!hint, hintShown }, !!onEscalate);

  // Once attempted, show the fully-worked scaffold with the last step filled —
  // the scholar's value if they got it, otherwise the correct one.
  const completed: FadeResult = {
    revealed: [...stepsResult.revealed, { text: attempt?.correct ? attempt.input : answer }],
    faded: [],
  };

  return (
    <View style={styles.teachStack}>
      <Text style={styles.teachHeading}>Good to know 👍 Let&apos;s do the last step together.</Text>

      <WorkedSteps steps={attempt ? completed : stepsResult} speakable />

      {!attempt && missedOnce ? (
        <Text style={styles.teachRetryNudge}>Not quite — here&apos;s a nudge. Have another go.</Text>
      ) : null}

      {!attempt && hintShown && hint ? (
        <SpeakableLabel text={hint} tapAnywhere accessibilityLabel="Hear the hint">
          <View style={styles.teachHintCard}>
            <SymbolView name="lightbulb.fill" size={16} tintColor={colors.statusYellow} />
            <Text style={styles.teachHintText}>{superscriptExponents(hint)}</Text>
          </View>
        </SpeakableLabel>
      ) : null}

      {attempt ? (
        attempt.correct ? (
          <View style={styles.teachCorrectRow}>
            <SymbolView name="checkmark" size={16} tintColor={colors.statusGreen} />
            <Text style={styles.teachCorrectText}>Nice — that&apos;s the step!</Text>
          </View>
        ) : (
          <SpeakableLabel
            text={`Not quite — the answer is ${answer} — now you've seen it.`}
            tapAnywhere
            accessibilityLabel="Hear the answer"
          >
            <Text style={styles.teachRevealText}>
              Not quite — the answer is {superscriptExponents(answer)} — now you&apos;ve seen it.
            </Text>
          </SpeakableLabel>
        )
      ) : (
        <View style={styles.answerBlock}>
          <PracticePadAnswer
            answerType={padType}
            value={input}
            enabled
            focusKey={`teach:${itemId}`}
            placeholderColor={colors.charcoalSubtle}
            styles={styles}
            onChange={onInput}
            onKey={onKey}
            onSubmit={onCheck}
          />
          <PracticePrimaryAction
            label="Check this step"
            accessibilityLabel="Check this step"
            disabled={!input.trim()}
            captureReturn
            styles={styles}
            indicatorColor={colors.white}
            onAction={onCheck}
          />
          {stillStuckAvail ? (
            <Pressable
              onPress={onStillStuck}
              accessibilityRole="button"
              accessibilityLabel="I'm still stuck"
              hitSlop={10}
              style={styles.teachStuckLink}
            >
              <Text style={styles.teachStuckLinkText}>I&apos;m still stuck</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

// ── Answer input by type ──────────────────────────────────────────────────────

function HintLadderSteps({
  completed,
  active,
  styles,
  colors,
  onAttempt,
  onComplete,
}: {
  completed: CompletedHintLadderRung[];
  active: Extract<HintLadderRung, { kind: "completion" }> | null;
  styles: Styles;
  colors: ColorSet;
  onAttempt?: () => void;
  onComplete: (revealedAfterWrong: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const inputBuffer = useRef("");

  const onInput = useCallback(
    (value: string) => setInput(setInputBuffer(inputBuffer, value)),
    [],
  );
  const onKey = useCallback(
    (key: string) => setInput(applyKeyToInputBuffer(inputBuffer, key)),
    [],
  );
  const check = () => {
    if (!active) return;
    const result = resolveHintLadderAttempt(
      active,
      inputBuffer.current.trim(),
      rawAnswersEqual,
    );
    onAttempt?.();
    onComplete(result.revealedAfterWrong);
  };

  if (completed.length === 0 && !active) return null;
  const revealed = completed.map(({ rung }) => ({
    text:
      rung.kind === "completion"
        ? completedHintLadderText(rung)
        : rung.text,
  }));
  const acknowledgedRevealedIndexes = completed.flatMap((entry, index) =>
    entry.revealedAfterWrong ? [index] : [],
  );
  const lastWasRevealed =
    completed[completed.length - 1]?.revealedAfterWrong ?? false;

  return (
    <View style={styles.teachStack}>
      <WorkedSteps
        label="Let’s work through it"
        steps={{
          revealed,
          faded: active ? [{ blankText: active.prompt }] : [],
        }}
        speakable
        showWhenOnlyFaded
        acknowledgedRevealedIndexes={acknowledgedRevealedIndexes}
      />
      {!active && lastWasRevealed ? (
        <Text style={styles.teachRetryNudge}>
          Not quite — here’s that step. Keep going.
        </Text>
      ) : null}
      {active ? (
        <View style={styles.answerBlock}>
          <PracticePadAnswer
            answerType={active.answerType as PadAnswerType}
            value={input}
            enabled
            focusKey={`hint:${active.stepIndex}`}
            placeholderColor={colors.charcoalSubtle}
            styles={styles}
            onChange={onInput}
            onKey={onKey}
            onSubmit={check}
          />
          <PracticePrimaryAction
            label="Check this step"
            accessibilityLabel="Check this step"
            disabled={!input.trim()}
            captureReturn
            styles={styles}
            indicatorColor={colors.white}
            onAction={check}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The practice HELP ROW — every secondary control in ONE row, directly above the
 * primary CTA: the optional Predict-then-Check confidence group first (an
 * ATTACHED 3-segment control, so it reads unmistakably as a single set of
 * options), then the help ladder — the strategy hint, then the honest
 * "I haven't learned this yet".
 *
 * They used to sit in three different places (the hint under the keypad, the
 * confidence chips in their own lane, the don't-know link BELOW the CTA) even
 * though they're one family: everything you can reach for BESIDES answering.
 * Andy, 2026-07-26 — same shape shipped on web (components/practice/PracticeSession.tsx),
 * this is the RN parity implementation.
 *
 * The help ladder itself is deliberate: a strategy nudge that withholds the
 * answer first, and only then "I haven't learned this yet" (which triggers the
 * teach path and records a different, more consequential signal). The hint text
 * comes from the same client-side `hintForSkill(skillKey)` web calls — no server
 * round-trip, and no answer is ever in the payload to leak.
 *
 * Every member keeps its footprint (opacity only) as it comes and goes, so the
 * pinned CTA below never moves between answering, feedback, and retry.
 */
function PracticeHelpRow({
  skillKey,
  phase,
  showHint,
  hintRungs,
  activeHintRung,
  hintStepsExhausted,
  hintStepLoading,
  hintStepError,
  onHintPress,
  onHintStepComplete,
  confidenceSlotActive,
  confidenceInteractive,
  confidence,
  onConfidenceChange,
  helpUsedVisible,
  helpReported,
  helpPending,
  onReportHelpUsed,
  exampleVisible,
  onExamplePress,
  showSkip,
  onDontKnow,
  busy,
  styles,
  colors,
}: {
  skillKey: string | undefined;
  phase: Phase;
  showHint: boolean;
  hintRungs: CompletedHintLadderRung[];
  activeHintRung: Extract<HintLadderRung, { kind: "completion" }> | null;
  hintStepsExhausted: boolean;
  hintStepLoading: boolean;
  hintStepError: string | null;
  onHintPress: () => void;
  onHintStepComplete: (revealedAfterWrong: boolean) => void;
  confidenceSlotActive: boolean;
  confidenceInteractive: boolean;
  confidence: ConfidenceLevel | null;
  onConfidenceChange: (v: ConfidenceLevel | null) => void;
  helpUsedVisible: boolean;
  helpReported: boolean;
  helpPending: boolean;
  onReportHelpUsed: () => void;
  /** Whether the "See an example" idea-shelf pill is offered — phase
   *  `answering` and the current item's strand has verified content. */
  exampleVisible: boolean;
  onExamplePress: () => void;
  showSkip: boolean;
  onDontKnow: () => void;
  busy: boolean;
  styles: Styles;
  colors: ColorSet;
}) {
  const hint = skillKey ? hintForSkill(skillKey) : "";
  const hintVisible = phase === "answering" && !!hint;
  const hintLadderOpen = showHint || hintRungs.length > 0 || activeHintRung !== null;
  const hintLabel = hintStepLoading
    ? "Thinking…"
    : hintStepsExhausted
    ? "Talk it through →"
    : activeHintRung
      ? "Finish this step"
      : showHint
        ? "Next hint"
        : "Hint";
  if (!confidenceSlotActive && !hint && !showSkip && !exampleVisible && !helpUsedVisible) return null;
  return (
    <View style={styles.helpLane}>
      {/* The hint opens directly above its own pill, inside this lane — so
          revealing it never grows (or re-centers) the problem card. */}
      {hintVisible && hintLadderOpen ? (
        <View style={styles.teachStack}>
          {showHint ? (
            <View style={styles.helpHintBox}>
              <Text style={styles.helpHintText}>{superscriptExponents(hint)}</Text>
            </View>
          ) : null}
          <HintLadderSteps
            key={`${skillKey ?? "none"}:${activeHintRung?.stepIndex ?? `done-${hintRungs.length}`}`}
            completed={hintRungs}
            active={activeHintRung}
            styles={styles}
            colors={colors}
            onComplete={onHintStepComplete}
          />
          {hintStepError ? (
            <Text style={styles.handoffError}>{hintStepError}</Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.helpRow}>
        {/* The prediction slot does double duty across the two phases of one
            item: while answering it holds the Predict-then-Check chips; once the
            verdict lands on a correct answer it holds the honest "I did this
            with help". Same slot, never both — this row is width-budgeted and every
            other member still reserves its footprint, so a FIFTH pill would wrap
            it onto a second line and shift the CTA under the kid's finger. */}
        {confidenceSlotActive || helpUsedVisible ? (
          helpUsedVisible ? (
            <Pressable
              onPress={onReportHelpUsed}
              // A toggle, not a latch: owning up to help is a claim a scholar
              // may take back, and a mis-tap here shouldn't cost them a fluency
              // claim they actually earned.
              disabled={busy || helpPending}
              style={({ pressed }) => [
                styles.helpPill,
                helpReported && styles.helpPillActive,
                pressed && !helpReported && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: helpReported, disabled: busy || helpPending }}
              accessibilityLabel="I did this with help"
            >
              <Text style={[styles.helpPillText, helpReported && styles.helpPillTextActive]}>
                I did this with help
              </Text>
            </Pressable>
          ) : (
            <View
              style={!confidenceInteractive && styles.helpHidden}
              pointerEvents={confidenceInteractive ? "auto" : "none"}
              accessibilityElementsHidden={!confidenceInteractive}
              importantForAccessibility={confidenceInteractive ? "auto" : "no-hide-descendants"}
            >
              <ConfidenceSegments
                value={confidence}
                onChange={onConfidenceChange}
                disabled={busy || !confidenceInteractive}
                styles={styles}
              />
            </View>
          )
        ) : null}
        {hint ? (
          <View
            style={!hintVisible && styles.helpHidden}
            pointerEvents={hintVisible ? "auto" : "none"}
            accessibilityElementsHidden={!hintVisible}
            importantForAccessibility={hintVisible ? "auto" : "no-hide-descendants"}
          >
            {/* The label stays "Hint" in BOTH states — a wider "Hide hint"
                re-flows every pill beside it and can push the row onto a second
                line, i.e. a layout shift under the kid's finger from the very
                control they just tapped (Andy, 2026-07-26). Only the chrome
                changes, reusing the confidence group's selected tint so "on"
                has one vocabulary across the row. */}
            <Pressable
              onPress={onHintPress}
              disabled={!hintVisible || hintStepLoading || activeHintRung !== null}
              style={({ pressed }) => [
                styles.helpPill,
                hintLadderOpen && styles.helpPillActive,
                pressed && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityState={{ expanded: hintLadderOpen }}
            >
              <Text style={[styles.helpPillText, hintLadderOpen && styles.helpPillTextActive]}>
                💡  {hintLabel}
              </Text>
            </Pressable>
          </View>
        ) : null}
        <View
          style={!exampleVisible && styles.helpHidden}
          pointerEvents={exampleVisible ? "auto" : "none"}
          accessibilityElementsHidden={!exampleVisible}
          importantForAccessibility={exampleVisible ? "auto" : "no-hide-descendants"}
        >
          <Pressable
            onPress={onExamplePress}
            disabled={!exampleVisible}
            style={({ pressed }) => [styles.helpPill, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="See an example"
          >
            <Text style={styles.helpPillText}>🧭  Example</Text>
          </Pressable>
        </View>
        <View
          style={!showSkip && styles.helpHidden}
          pointerEvents={showSkip ? "auto" : "none"}
          accessibilityElementsHidden={!showSkip}
          importantForAccessibility={showSkip ? "auto" : "no-hide-descendants"}
        >
          <Pressable
            onPress={onDontKnow}
            disabled={busy || !showSkip}
            style={({ pressed }) => [styles.helpPill, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
          >
            <Text style={styles.helpPillText}>{DONT_KNOW_LABEL}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function AnswerArea({
  item,
  phase,
  result,
  input,
  busy,
  error,
  unitNudge,
  styles,
  colors,
  onKey,
  onInput,
  onSubmit,
  onCheck,
  onSkip,
  onRetryIntent,
}: {
  item: ServedItem;
  phase: Phase;
  result: SubmitResult | null;
  input: string;
  busy: boolean;
  error: string | null;
  /** The Check was refused because this unit item's answer carries no unit. */
  unitNudge: boolean;
  styles: Styles;
  colors: ColorSet;
  onKey: (k: string) => void;
  onInput: (next: string) => void;
  onSubmit: (raw?: string) => void;
  onCheck: () => void;
  onSkip: () => void;
  onRetryIntent?: () => void;
}) {
  const isAnswering = phase === "answering";
  const isFeedback = phase === "feedback";
  const fbCorrect = isFeedback && !!result && !result.dontKnow && result.correct;
  const fbMiss = isFeedback && !!result && !result.dontKnow && !result.correct;

  // Predict-then-Check confidence chips now render in the bottom lane (directly
  // above the Check button), not inside the answer stack — see the parent render.

  // multipleChoice → tappable options while answering. In feedback the choices
  // step away entirely (the card stamp + note carry the verdict), so nothing
  // reflows in place.
  if (item.answerType === "multipleChoice" && item.choices && item.choices.length > 0) {
    if (!isAnswering) return null;
    return (
      <View style={styles.choices}>
        {item.choices.map((choice, i) => (
          <Pressable
            key={`${i}-${choice}`}
            disabled={busy}
            onPress={() => onSubmit(choiceSubmitValue(i))}
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
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  // Numeric / fraction / expression → the answer field. The SAME field stays
  // mounted across answering→feedback: editable while answering, then tinted in
  // feedback. A first-miss tap or hardware edit starts the retry immediately.
  // The keypad stays mounted too, faded to opacity 0 (space reserved), so
  // submit→feedback never moves the card. On an honest don't-know there's no
  // answer to show, so we step away.
  if (isPadAnswerType(item.answerType)) {
    if (!isAnswering && (!isFeedback || result?.dontKnow)) return null;
    const padType = item.answerType;
    return (
      <View style={styles.answerBlock}>
        <PracticePadAnswer
          answerType={padType}
          answerShape={item.answerShape}
          answerFormat={item.answerFormat}
          answerUnit={item.answerUnit}
          unitNudge={unitNudge}
          value={input}
          enabled={isAnswering && !busy}
          focusKey={`${item.itemId}:${phase}`}
          controlsHidden={!isAnswering}
          tactile={!!item.isFactSprint}
          fieldStyle={[
            fbCorrect && styles.inputBoxCorrect,
            fbMiss && styles.inputBoxMiss,
          ]}
          placeholderColor={colors.charcoalSubtle}
          styles={styles}
          onChange={onInput}
          onKey={onKey}
          onSubmit={onCheck}
          onRetryIntent={onRetryIntent}
        />
        {isAnswering && error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  // Any other union member (e.g. a rare multipleChoice with no choices payload)
  // → a graceful "do this one on the web" skip card. Self-contained (its own skip
  // button), and it steps away in feedback.
  if (!isAnswering) return null;
  return (
    <View style={styles.skipCard}>
      <Text style={styles.skipTitle}>Best on the web</Text>
      <Text style={styles.skipBody}>
        This kind of question works better on the web app. Skip it for now and keep going.
      </Text>
      <Pressable onPress={onSkip} style={styles.secondaryBtn} accessibilityRole="button">
        <Text style={styles.secondaryBtnText}>Skip  →</Text>
      </Pressable>
    </View>
  );
}

/**
 * Predict-then-Check confidence — an OPTIONAL 3-tap prediction the kid can make
 * before checking (mirrors the web ConfidenceGroup). Rendered as an ATTACHED
 * segmented control (one pill, three segments) so it reads unmistakably as a
 * single set of options inside the help row, with no caption to explain it.
 * Tapping the selected segment again clears it; nothing is required. No score,
 * no streak — a low-friction judgment-of-learning prompt.
 */
function ConfidenceSegments({
  value,
  onChange,
  disabled,
  styles,
}: {
  value: ConfidenceLevel | null;
  onChange: (v: ConfidenceLevel | null) => void;
  disabled: boolean;
  styles: Styles;
}) {
  return (
    <View style={styles.segGroup} accessibilityRole="radiogroup" accessibilityLabel="How sure are you?">
      {CONFIDENCE_LEVELS.map((c, i) => {
        const selected = value === c.level;
        return (
          <Pressable
            key={c.level}
            disabled={disabled}
            onPress={() => onChange(selected ? null : c.level)}
            style={({ pressed }) => [
              styles.segItem,
              i > 0 && styles.segItemDivider,
              selected && styles.segItemSelected,
              pressed && !selected && { opacity: 0.7 },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`How sure are you: ${c.label}`}
          >
            <Text
              style={[styles.segText, selected && styles.segTextSelected]}
              numberOfLines={1}
            >
              {c.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Feedback (verdict + retry/advance) ─────────────────────────────────────────
// StemCard now lives in components/practice/StemCard.tsx — shared with
// NativePlacement.tsx (#unify) so the drill and placement render the identical
// corner-stamp + tint overlay instead of two hand-maintained copies.

// FeedbackNote — the compact under-card micro-copy for the feedback phase. The
// stamp already carries the verdict, so this is a short supportive line, NOT a
// growing verdict box. Lives INSIDE the scrollable stage so a long don't-know
// explanation can grow here without pushing the pinned CTA lane.
function FeedbackNote({
  result,
  verdict,
  comesBackText,
  stretchLane = false,
  mappingReveal = false,
  styles,
  colors,
}: {
  result: SubmitResult;
  verdict: PracticeVerdict | null;
  /** The precomputed "comes back ~Thursday" line (P1e), or null. */
  comesBackText: string | null;
  /** The current item is a stretch (insight) problem — misses are expected
   *  and never touch the mastery row, so the nudge copy pre-frames that. */
  stretchLane?: boolean;
  /** Option D: the current item is a `· mapping` placement probe — reveal-only
   *  measurement, so a miss REVEALS the answer (locked; showing it teaches, never
   *  offloads) with warm copy, never the retry nudge. */
  mappingReveal?: boolean;
  styles: Styles;
  colors: ColorSet;
}) {
  const profFill: Record<Proficiency, string> = {
    not_started: colors.gray300,
    practicing: colors.yellow,
    fluent: colors.green,
    overlearned: colors.cyan,
  };

  // `unitOutcome` is only ever set when the VALUE was right and the unit wasn't
  // (the grader checks the unit second), so it REPLACES the generic miss copy
  // below rather than stacking on it — "take another look" would send the
  // scholar back over work that was already correct. The mapping reveal is the
  // one exception: there the line joins the reveal, which models the full form.
  const unitNote =
    result.unitOutcome === "wrong"
      ? UNIT_WRONG_NUDGE
      : result.unitOutcome === "missing"
        ? UNIT_MISSING_NUDGE
        : null;

  // Option D: a `· mapping` item reveals + warm copy (no mastery/streak framing,
  // no retry nudge). The reassurance sentence lives on the segment beat header.
  if (mappingReveal) {
    return (
      <View style={styles.noteBlock}>
        {result.correctAnswer && !result.correct ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "stretch",
              minWidth: 0,
            }}
          >
            <Text style={[styles.noteMiss, { flexShrink: 1 }]}>The answer was </Text>
            <FractionText
              value={result.correctAnswer}
              inline
              fontSize={14}
              color={colors.orange}
              weight="regular"
              align="center"
            />
            <Text style={[styles.noteMiss, { flexShrink: 1 }]}>.</Text>
          </View>
        ) : null}
        {unitNote ? <Text style={styles.noteMiss}>{unitNote}</Text> : null}
        <Text style={result.correct ? styles.noteMappingCorrect : styles.noteMiss}>
          {result.correct
            ? "Nice — that helps us place you."
            : result.dontKnow
              ? "Good to know — that helps us start you in the right place."
              : "That\u2019s okay — this just finds your level."}
        </Text>
      </View>
    );
  }

  // Honest don't-know renders the teach-as-action step (TeachingStep) instead of
  // this note, so it never reaches here. Defensive guard.
  if (result.dontKnow) return null;

  if (result.correct) {
    return (
      <View style={styles.noteBlock}>
        {verdict === "accelerated" ? (
          <Text style={styles.noteAccelerated}>⚡  Two in a row, fast — skill earned!</Text>
        ) : null}
        <View style={styles.profRow}>
          <View style={[styles.profDot, { backgroundColor: profFill[result.proficiency] }]} />
          <Text style={styles.profText}>
            {result.skillLabel} · {MASTERY_LABELS[result.proficiency]}
          </Text>
        </View>
        {/* Consolidation moment (P1e): this attempt turned the skill fluent. */}
        {comesBackText ? <Text style={styles.comesBackText}>{comesBackText}</Text> : null}
      </View>
    );
  }

  // A miss NEVER reveals the answer (anti-offloading). A short nudge; the CTA
  // lane offers the action (try-again on the 1st miss, Continue / Walk-me-through
  // on the 2nd).
  if (verdict === "retry") {
    return (
      <View style={styles.noteBlock}>
        <Text style={styles.noteMiss}>
          {unitNote ??
            (stretchLane
              ? "This one\u2019s meant to be hard — a miss here never touches your map. Take another look."
              : "Take another look — you\u2019ve got this.")}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.noteBlock}>
      {unitNote ? (
        <Text style={styles.noteMiss}>{unitNote}</Text>
      ) : (
        <Text style={styles.noteStuck}>
          {stretchLane
            ? "A genuinely tough one — wrestling with it IS the work. Talk it through, or move on with nothing lost."
            : "Want to talk it through? Your tutor won\u2019t give you the answer — they\u2019ll help you find it."}
        </Text>
      )}
    </View>
  );
}

// CtaLane — the action row PINNED to the bottom of the screen, below the scrolling
// stage. A single button that only relabels across states, except a 2nd miss which
// splits into two equal buttons ([Continue] [💬 Walk me through it]) with the
// emphasis on the walkthrough. The "I haven't learned this yet" skip link keeps its
// own slot (space reserved) so it goes invisible after answering without moving the
// CTA. Hosts the HardwareReturnAdvance so Return fires the primary action in
// feedback (answering's Return is handled by the answer field itself).
function CtaLane({
  phase,
  result,
  verdict,
  online,
  mappingReveal = false,
  recoveryMode = false,
  isLast,
  busy,
  dontKnowReady,
  showCheck,
  checkDisabled,
  onSubmit,
  onNext,
  onRetry,
  onTalkItThrough,
  onFreshVariant,
  onRecoveryDone,
  showBreakerEasyExit = false,
  onBreakerEasyFinish,
  styles,
  colors,
}: {
  phase: Phase;
  result: SubmitResult | null;
  verdict: PracticeVerdict | null;
  online: boolean;
  /** Option D: a `· mapping` item is reveal-only measurement — the feedback CTA
   *  is always a plain Next (never retry / walk-through / teaching-step gate). */
  mappingReveal?: boolean;
  recoveryMode?: boolean;
  isLast: boolean;
  busy: boolean;
  /** Teach-as-action gate: the don't-know Continue stays disabled until the
   *  scholar has attempted the one faded step (TeachingStep fires onReady). */
  dontKnowReady: boolean;
  showCheck: boolean;
  checkDisabled: boolean;
  onSubmit: () => void;
  onNext: () => void;
  onRetry: () => void;
  onTalkItThrough: () => void;
  onFreshVariant: () => void;
  onRecoveryDone: () => void;
  showBreakerEasyExit?: boolean;
  onBreakerEasyFinish: () => void;
  styles: Styles;
  colors: ColorSet;
}) {
  const nextLabel = isLast ? "Finish" : "Next";
  const fbCorrect = phase === "feedback" && !!result && !result.dontKnow && result.correct;
  const fbMiss = phase === "feedback" && !!result && !result.dontKnow && !result.correct;
  // Teach-as-action: an honest don't-know advances with a plain Next, gated until
  // the one faded step has been attempted (dontKnowReady).
  const fbDontKnow = phase === "feedback" && !!result && !!result.dontKnow;
  // Option D: a `· mapping` feedback (any outcome) advances with a plain Next.
  const fbMapping = phase === "feedback" && !!result && mappingReveal;
  const fbRecovery = phase === "feedback" && !!result && recoveryMode;

  let cta: React.ReactNode = null;
  const guardedNext = useGuardedPracticeAction(
    onNext,
    fbCorrect || fbMapping,
    `next:${phase}:${result?.repetition ?? "none"}`,
  );
  const guardedDontKnowNext = useGuardedPracticeAction(
    onNext,
    fbDontKnow && dontKnowReady && !busy,
    `dontknow-next:${phase}:${result?.repetition ?? "none"}`,
  );
  const guardedRetry = useGuardedPracticeAction(
    onRetry,
    fbMiss && verdict === "retry" && !busy,
    `retry:${phase}:${result?.repetition ?? "none"}`,
  );
  const guardedTalk = useGuardedPracticeAction(
    onTalkItThrough,
    ((fbMiss && verdict === "stuck") || fbDontKnow) && !busy,
    `talk:${phase}:${result?.repetition ?? "none"}`,
  );
  const guardedRecoveryDone = useGuardedPracticeAction(
    onRecoveryDone,
    fbRecovery && !busy,
    `recovery-done:${phase}:${result?.repetition ?? "none"}`,
  );
  const guardedQueuedNext = useGuardedPracticeAction(
    onNext,
    phase === "queued" && !busy,
    `queued-next:${phase}`,
  );

  if (phase === "answering") {
    if (showCheck) {
      cta = (
        <PracticePrimaryAction
          label="Check  →"
          accessibilityLabel="Check answer"
          disabled={checkDisabled}
          loading={busy}
          styles={styles}
          indicatorColor={colors.white}
          onAction={onSubmit}
        />
      );
    }
  } else if (fbRecovery) {
    cta = (
      <PracticePrimaryAction
        label="Finish  →"
        accessibilityLabel="Finish practice"
        captureReturn
        styles={styles}
        indicatorColor={colors.white}
        onAction={guardedRecoveryDone}
      />
    );
  } else if (fbMapping) {
    // Option D: reveal-only measurement — always a plain Next.
    cta = (
      <PracticePrimaryAction
        label={`${nextLabel}  →`}
        accessibilityLabel={isLast ? "Finish practice" : "Next question"}
        captureReturn
        styles={styles}
        indicatorColor={colors.white}
        onAction={guardedNext}
      />
    );
  } else if (fbCorrect) {
    cta = (
      <PracticePrimaryAction
        label={`${nextLabel}  →`}
        accessibilityLabel={isLast ? "Finish practice" : "Next question"}
        captureReturn
        styles={styles}
        indicatorColor={colors.white}
        onAction={guardedNext}
      />
    );
  } else if (fbDontKnow) {
    // Next is held until the scholar attempts the one faded step; then it advances.
    //
    // The SAME two-button row the "stuck" branch gets below: an honest "I haven't
    // learned this yet" must reach the companion tutor at least as easily as two
    // wrong guesses do, or the surface quietly teaches that guessing pays better
    // than telling the truth.
    cta = (
      <View style={styles.twoBtnRow}>
        <Pressable
          disabled={!dontKnowReady || busy}
          onPress={guardedDontKnowNext}
          style={({ pressed }) => [
            styles.secondaryBtn,
            styles.twoBtnHalf,
            (!dontKnowReady || busy) && { opacity: 0.5 },
            pressed && { opacity: 0.85 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={isLast ? "Finish practice" : "Next question"}
        >
          <Text style={styles.secondaryBtnText}>{nextLabel}  →</Text>
        </Pressable>
        <PracticePrimaryAction
          label="💬  Walk me through it"
          accessibilityLabel="Walk me through it"
          disabled={busy}
          captureReturn
          styles={styles}
          indicatorColor={colors.white}
          onAction={guardedTalk}
          style={styles.twoBtnHalf}
        />
      </View>
    );
  } else if (fbMiss && verdict === "retry") {
    cta = (
      <PracticePrimaryAction
        label="↻  Try again"
        accessibilityLabel="Try again"
        disabled={busy}
        captureReturn
        styles={styles}
        indicatorColor={colors.white}
        onAction={guardedRetry}
      />
    );
  } else if (fbMiss && verdict === "stuck") {
    // Two equal buttons; a silly slip can just Continue (a fresh variant), but the
    // weighting nudges toward the walkthrough (ghost Continue vs. filled walk).
    cta = (
      <View style={styles.twoBtnRow}>
        <Pressable
          disabled={busy}
          onPress={onFreshVariant}
          style={({ pressed }) => [styles.secondaryBtn, styles.twoBtnHalf, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryBtnText}>Continue</Text>
        </Pressable>
        <PracticePrimaryAction
          label="💬  Walk me through it"
          accessibilityLabel="Walk me through it"
          disabled={busy}
          captureReturn
          styles={styles}
          indicatorColor={colors.white}
          onAction={guardedTalk}
          style={styles.twoBtnHalf}
        />
      </View>
    );
  } else if (phase === "queued") {
    cta = (
      <View style={{ width: "100%", gap: 10 }}>
        <View style={styles.queuedNote}>
          <Text style={styles.queuedTitle}>
            {online ? "Saved — we'll confirm this in a moment" : "Saved — you're offline"}
          </Text>
          <Text style={styles.queuedBody}>
            {online
              ? "Keep going while Rabbithole checks the saved answer."
              : "We'll check this one for real as soon as you're back online."}
          </Text>
        </View>
        <PracticePrimaryAction
          label={`${nextLabel}  →`}
          accessibilityLabel={isLast ? "Finish practice" : "Next question"}
          captureReturn
          styles={styles}
          indicatorColor={colors.white}
          onAction={guardedQueuedNext}
        />
      </View>
    );
  }

  // The honest "I haven't learned this yet" escape now lives in the help row
  // ABOVE this lane, with the hint and the confidence group it belongs with
  // (PracticeHelpRow) — this lane carries only the primary action.
  return (
    <View style={styles.ctaLane}>
      {cta}
      {showBreakerEasyExit ? (
        <Pressable
          disabled={busy}
          onPress={onBreakerEasyFinish}
          style={({ pressed }) => [
            styles.ghostBtn,
            pressed && styles.ghostBtnPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={breakerControlLabel("easyFinish")}
        >
          <Text style={styles.ghostBtnText}>
            {breakerControlLabel("easyFinish")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── Transcript choreography (Option B) ────────────────────────────────────────

/**
 * The inline teachable-moment chat — the after-2-misses Socratic "handoff".
 * Rises in the same low slot the keypad occupied (the pad→text
 * morph) and pushes the problem up. Fully DRY with the native tutor chat: navy
 * scholar bubbles + bare tutor text (`@/lib/chatBubbles`), wet-ink `StreamingText`
 * reveal, AND one-shot voice dictation (mic → ✓ → transcribe → send), so a
 * teachable moment reads as part of the same family as a real chat session.
 * Answer-safe by construction: every reply routes through /practice-handoff,
 * which feeds the tutor only the stem + wrong answers and redacts any leak.
 */
function HandoffChat({
  handoff,
  input,
  onChangeInput,
  onSend,
  image,
  imageUploadTarget,
  onFreshVariant,
  onBreakerEasyFinish,
  breakerFreshAvailable = true,
  stretchLane = false,
  dialogueVerdict = null,
  onDialogueCheck,
  onAdvance,
  isLast,
  busy,
  styles,
  colors,
}: {
  handoff: HandoffState | null;
  input: string;
  onChangeInput: (t: string) => void;
  onSend: (text?: string) => void;
  image: ReturnType<typeof useImageAttachment>;
  imageUploadTarget: ImageUploadTarget | null;
  onFreshVariant: () => void;
  /** False for a deeper miss that still needs the brake but has no server-issued
   * recovery handle. Repair, coach, and easy exit remain; fresh stays hidden. */
  breakerFreshAvailable?: boolean;
  /** The breaker's peer escape, passed only while the spiral coach is open so
   *  "Easy one, then stop" stays visible beside the fresh-item primary. */
  onBreakerEasyFinish?: () => void;
  /** Stretch (insight) item: relabel the exits — she retries the SAME item
   *  rather than a fresh variant (the caller passes a retry as onFreshVariant). */
  stretchLane?: boolean;
  /** DIALOGUE stretch verdict (mode "dialogue"): null until "Check my thinking". */
  dialogueVerdict?: { passed: boolean; metCount: number; total: number } | null;
  onDialogueCheck?: () => void;
  onAdvance: () => void;
  isLast: boolean;
  busy: boolean;
  styles: Styles;
  colors: ColorSet;
}) {
  // Voice dictation — same one-shot flow as the tutor-chat composer: the mic
  // starts recording; the RecordingBar's ✓ finishes → transcribe → send in one
  // step (nothing is dropped into the box to review). Instantiated per-mount, so
  // it's live only while a teachable-moment chat is open.
  const voice = useVoiceDictation();
  const onMicStart = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    void voice.start();
  }, [voice]);
  const onMicStop = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const text = await voice.stop();
    if (text) onSend(text);
  }, [voice, onSend]);
  const onMicCancel = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    voice.cancel();
  }, [voice]);

  // Attach a scratch photo — same iOS action sheet as the tutor-chat composer.
  const onAttach = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Cancel", "Take Photo", "Choose Photo"], cancelButtonIndex: 0 },
      (i) => {
        if (!imageUploadTarget) return;
        if (i === 1) void image.attach("camera", imageUploadTarget);
        else if (i === 2) void image.attach("library", imageUploadTarget);
      },
    );
  }, [image, imageUploadTarget]);

  // Keep the composer focused the whole time the chat is open — on open, and
  // again each time a tutor reply finishes (loading→false) or the recording bar
  // closes. `autoFocus` only fires on mount, so a reply round-trip would other-
  // wise leave the box unfocused; this refocuses so the kid can keep typing
  // without tapping. A single derived boolean keeps the effect from thrashing.
  const composerFocusable =
    !!handoff &&
    !handoff.ended &&
    !voice.isRecording &&
    !voice.isTranscribing &&
    !handoff.loading;
  const composerRef = useRef<TextInput>(null);
  useEffect(() => {
    if (!composerFocusable) return;
    const t = setTimeout(() => composerRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [composerFocusable]);

  if (!handoff) return null;

  const isDialogue = handoff.mode === "dialogue";
  const dialogueHasIdea = handoff.messages.some((m) => m.role === "user");
  const lastIdx = handoff.messages.length - 1;
  const canSend = (!!input.trim() || !!image.imageId) && !image.uploading;
  const showComposer = isDialogue ? !dialogueVerdict : !handoff.ended;

  // One chat turn, rendered with the SAME treatment as the native tutor chat
  // (`app/session/[id].tsx` via `@/lib/chatBubbles`): the scholar's own turn is a
  // navy bubble; the tutor voice is bare, book-like text (no bubble). The freshest
  // tutor reply — and the streaming explain opener — reveal with the same wet-ink
  // `StreamingText` used in the chat session.
  const renderTurn = (
    key: string,
    role: "user" | "assistant",
    content: string,
    streaming: boolean,
  ) => {
    const mine = role === "user";
    return (
      <View key={key} style={[styles.row, mine ? styles.rowMine : styles.rowTutor]}>
        <View style={mine ? styles.colMine : styles.colTutor}>
          <View style={mine ? [styles.bubble, styles.mine] : styles.tutorBare}>
            {mine ? (
              <Text style={[styles.bubbleText, styles.textMine]}>{content}</Text>
            ) : streaming ? (
              <StreamingText
                content={content}
                done={false}
                color={colors.charcoal}
                fadeMs={420}
                style={styles.bubbleText}
              />
            ) : (
              <Markdown content={content} color={colors.charcoal} />
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.handoffBlock}>
      {/* Dialogue stretches and stuck-after-2-misses handoffs share one chat. */}
      <View style={styles.handoffHeaderRow}>
        <Text style={styles.handoffHeaderIcon}>💬</Text>
        <Text style={styles.handoffHeaderText}>
          {isDialogue ? "Talk me through your idea" : "Let\u2019s talk it through"}
        </Text>
      </View>

      <View style={styles.handoffThread}>
        {handoff.messages.map((m, i) =>
          renderTurn(
            String(i),
            m.role,
            m.content,
            i === lastIdx && m.role === "assistant" && !handoff.loading,
          ),
        )}
        {handoff.loading ? (
          <View style={[styles.row, styles.rowTutor]}>
            <View style={styles.colTutor}>
              <View style={styles.tutorBare}>
                <Text style={[styles.bubbleText, styles.thinking]}>…</Text>
              </View>
            </View>
          </View>
        ) : null}
        {handoff.error ? <Text style={styles.handoffError}>{handoff.error}</Text> : null}
      </View>

      {!showComposer && isDialogue ? (
        // Graded DIALOGUE verdict — the check happened; land it and move on.
        <View style={styles.handoffEnded}>
          <Text
            style={[
              styles.handoffEndedText,
              dialogueVerdict?.passed ? { color: colors.green } : null,
            ]}
          >
            {dialogueVerdict?.passed
              ? "That's the idea — it went on your depth record."
              : "Not all the way there yet — and nothing on your map went down."}
          </Text>
          <Pressable
            disabled={busy}
            onPress={onAdvance}
            style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={isLast ? "Finish practice" : "Next question"}
          >
            <Text style={styles.primaryBtnText}>{isLast ? "Finish" : "Next"}  →</Text>
          </Pressable>
        </View>
      ) : !showComposer ? (
        // Socratic handoff the server marked done — nudge back to solo practice.
        <View style={styles.handoffEnded}>
          <Text style={styles.handoffEndedText}>
            {handoff.entryMode === "spiral"
              ? breakerFreshAvailable
                ? breakerBody(
                    { stage: "coach", repair: "done", coachUsed: true },
                    true,
                  )
                : SPIRAL_COACH_COMPLETE_BODY
              : stretchLane
              ? "Good thinking — now take another run at it."
              : "Good thinking — now try a fresh one on your own."}
          </Text>
          {handoff.entryMode !== "spiral" ? (
            <Pressable
              disabled={busy}
              onPress={onFreshVariant}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
              accessibilityLabel="Try it again"
            >
              <Text style={styles.primaryBtnText}>↻  Try it again</Text>
            </Pressable>
          ) : null}
          {/* The one quiet escape stays available while the automatic fresh
              serve starts (mirrors web). */}
          {handoff.entryMode === "spiral" && onBreakerEasyFinish ? (
            <Pressable
              disabled={busy}
              onPress={onBreakerEasyFinish}
              style={({ pressed }) => [
                styles.ghostBtn,
                pressed && styles.ghostBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={breakerControlLabel("easyFinish")}
            >
              <Text style={styles.ghostBtnText}>{breakerControlLabel("easyFinish")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          {image.previewUri && (
            <View style={styles.handoffPreviewRow}>
              <View style={styles.handoffPreviewChip}>
                <Image source={{ uri: image.previewUri }} style={styles.handoffPreviewImg} alt="Attached photo" />
                {image.uploading && (
                  <View style={styles.handoffPreviewOverlay}>
                    <ActivityIndicator color={colors.white} />
                  </View>
                )}
                <Pressable
                  onPress={image.clear}
                  hitSlop={8}
                  style={styles.handoffPreviewRemove}
                  accessibilityRole="button"
                  accessibilityLabel="Remove photo"
                >
                  <SymbolView name="xmark.circle.fill" size={22} tintColor={colors.charcoal} />
                </Pressable>
              </View>
            </View>
          )}
          {voice.isRecording || voice.isTranscribing ? (
            <View style={styles.handoffInputRow}>
              <RecordingBar
                level={voice.level}
                durationMs={voice.durationMs}
                isTranscribing={voice.isTranscribing}
                isMaxed={voice.isMaxed}
                onCancel={onMicCancel}
                onStop={onMicStop}
              />
            </View>
          ) : (
            <View style={styles.handoffInputRow}>
              {/* Attach a scratch photo — parity with the tutor-chat composer. */}
              <Pressable
                onPress={onAttach}
                hitSlop={8}
                style={styles.handoffAttachBtn}
                disabled={handoff.loading || image.uploading}
                accessibilityRole="button"
                accessibilityLabel="Add a photo"
              >
                <SymbolView
                  name="plus.circle.fill"
                  size={32}
                  tintColor={
                    handoff.loading || image.uploading ? colors.gray300 : colors.fgMuted
                  }
                />
              </Pressable>
              <AppTextInput
                ref={composerRef}
                style={styles.handoffInput}
                value={input}
                onChangeText={onChangeInput}
                onSubmitEditing={() => onSend()}
                placeholder="Type what you're thinking…"
                placeholderTextColor={colors.fgMuted}
                editable={!handoff.loading}
                returnKeyType="send"
                multiline
                // Return sends (matches the tutor-chat composer) instead of
                // inserting a newline; without this a multiline input swallows it.
                submitBehavior="submit"
              />
              {/* Mic when there's nothing to send; send button otherwise — the
                  identical affordance as the tutor chat, so voice comes for free. */}
              {canSend ? (
                <Pressable
                  disabled={handoff.loading}
                  onPress={() => onSend()}
                  hitSlop={8}
                  style={styles.handoffIconBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Send"
                >
                  <SymbolView
                    name="arrow.up.circle.fill"
                    size={38}
                    tintColor={handoff.loading ? colors.gray300 : colors.violet}
                  />
                </Pressable>
              ) : (
                <Pressable
                  disabled={handoff.loading}
                  onPress={onMicStart}
                  hitSlop={8}
                  style={styles.handoffIconBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Start recording — tap to talk, tap the check to send"
                >
                  <SymbolView
                    name="mic.circle.fill"
                    size={38}
                    tintColor={handoff.loading ? colors.gray300 : colors.violet}
                  />
                </Pressable>
              )}
            </View>
          )}
          {/* A dialogue's finish line is the rubric check; a handoff nudges back
              to a solo attempt. */}
          {isDialogue ? (
            <Pressable
              disabled={busy || !dialogueHasIdea || handoff.loading}
              onPress={onDialogueCheck}
              style={({ pressed }) => [
                styles.primaryBtn,
                (busy || !dialogueHasIdea || handoff.loading) && { opacity: 0.5 },
                pressed && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Check my thinking"
            >
              <Text style={styles.primaryBtnText}>✓  Check my thinking</Text>
            </Pressable>
          ) : handoff.entryMode === "spiral" ? (
            <View style={{ gap: 8, width: "100%" }}>
              {onBreakerEasyFinish ? (
                <Pressable
                  disabled={busy}
                  onPress={onBreakerEasyFinish}
                  style={({ pressed }) => [
                    styles.ghostBtn,
                    pressed && styles.ghostBtnPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={breakerControlLabel("easyFinish")}
                >
                  <Text style={styles.ghostBtnText}>
                    {breakerControlLabel("easyFinish")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <Pressable
              disabled={busy}
              onPress={onFreshVariant}
              style={styles.linkBtn}
              accessibilityRole="button"
            >
              <Text style={styles.linkBtnText}>
                {stretchLane
                  ? "I\u2019ve got it — back to it →"
                  : "I\u2019ve got it — try a fresh one →"}
              </Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

type ColorSet = ReturnType<typeof useColors>;
type Styles = ReturnType<typeof makeStyles>;

function makeStyles(c: ColorSet) {
  return StyleSheet.create({
    // Shared chat-bubble treatment (bubble / mine / tutorBare / bubbleText /
    // textMine / thinking) — the SAME source of truth as the native tutor chat,
    // so the handoff can never drift from a real chat session.
    ...chatBubbleStyles(c),
    // The SHARED no-shift practice shell — the centered scrolling stage,
    // correctness ring + un-rotated corner stamp, absolutely-anchored under-card
    // note, and bottom-pinned CTA lane. Spread here so this screen and the
    // self-grading manipulative item card render into the identical shell.
    ...makePracticeShellStyles(c),
    // Chat row layout (mirrors app/session/[id].tsx): scholar turns align right,
    // the bare tutor voice aligns left.
    row: { flexDirection: "row" },
    rowMine: { justifyContent: "flex-end" },
    rowTutor: { justifyContent: "flex-start" },
    colMine: { maxWidth: "82%", alignItems: "flex-end" },
    colTutor: { maxWidth: "100%", alignItems: "flex-start" },
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    launchpadScroll: { flex: 1 },
    launchpadScrollContent: {
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 40,
      alignItems: "center",
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: 24,
      backgroundColor: c.bgSubtle,
    },
    loadingText: { fontFamily: fonts.regular, fontSize: 14, color: c.fgMuted },

    // Per-item domain chip (mixed playlist only) — a plain even-bordered pill on
    // white, left-aligned in a slim row above the card. Mirrors the web chip's
    // type scale + treatment (no accent stripe/gradient).
    domainChipRow: {
      width: "100%",
      maxWidth: COLUMN_MAX_WIDTH,
      alignSelf: "center",
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    domainChip: {
      alignSelf: "flex-start",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 2,
    },
    domainChipText: {
      fontFamily: fonts.semibold,
      fontSize: 11,
      letterSpacing: 0.4,
      textTransform: "uppercase",
      color: c.fgMuted,
    },

    // Playlist segment beat (raise-the-ceiling §11 / C-4) — a light,
    // growth-framed heading shown once per segment. Mirrors the web copy.
    segmentBeatRow: {
      width: "100%",
      maxWidth: COLUMN_MAX_WIDTH,
      alignSelf: "center",
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    segmentBeatText: {
      fontFamily: fonts.bold,
      fontSize: 14,
      color: c.navy,
    },

    // Item column
    itemScroll: { alignItems: "center", paddingHorizontal: 16, paddingBottom: 32 },
    // Transcript-mode scroll: bottom-anchored (content sits low, at composer
    // height, when short; scrolls once the history grows tall).
    transcriptScroll: {
      flexGrow: 1,
      justifyContent: "flex-end",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 24,
      gap: 14,
    },
    itemColumn: { width: "100%", maxWidth: COLUMN_MAX_WIDTH, gap: 18, paddingTop: 8, position: "relative" },

    // Socratic handoff (the inline teachable moment). The thread is a plain
    // vertical stack of chat turns — no bordered card — so it reads as the same
    // family as a real chat session (the turns carry the shared bubble styles).
    handoffBlock: { gap: 10 },
    handoffHeaderRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    handoffHeader: { gap: 3 },
    handoffHeaderIcon: { fontSize: 16 },
    handoffHeaderText: { fontFamily: fonts.bold, fontSize: 15, color: c.teal },
    handoffHeaderSub: { fontFamily: fonts.regular, fontSize: 13, color: c.fgMuted, lineHeight: 18 },
    handoffThread: { gap: 4, paddingTop: 2 },
    handoffError: { fontFamily: fonts.semibold, fontSize: 13, color: c.statusRed, paddingHorizontal: 4 },
    handoffEnded: { gap: 10 },
    handoffEndedText: {
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.fgMuted,
      textAlign: "center",
    },
    handoffInputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
    handoffInput: {
      flex: 1,
      minHeight: 48,
      maxHeight: 120,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.bg,
      paddingHorizontal: 14,
      paddingTop: 12,
      paddingBottom: 12,
      fontFamily: fonts.regular,
      fontSize: 15,
      color: c.fg,
    },
    // Mic / send icon button — the SymbolView is its own filled circle (matching
    // the tutor-chat composer), so the button is just tap padding, no background.
    handoffIconBtn: { paddingBottom: 5, paddingLeft: 2 },
    handoffAttachBtn: { paddingBottom: 8 },
    handoffPreviewRow: { marginBottom: 8 },
    handoffPreviewChip: {
      width: 88,
      height: 88,
      borderRadius: 14,
      overflow: "hidden",
      backgroundColor: c.gray100,
    },
    handoffPreviewImg: { width: "100%", height: "100%" },
    handoffPreviewOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.3)",
    },
    handoffPreviewRemove: {
      position: "absolute",
      top: 2,
      right: 2,
      backgroundColor: c.white,
      borderRadius: 11,
    },
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
    storyHook: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.fgMuted,
      textAlign: "center",
    },
    stemText: {
      fontFamily: fonts.semibold,
      fontSize: 28,
      lineHeight: 38,
      textAlign: "center",
      color: c.fg,
    },

    // Numeric input
    answerBlock: { gap: 14 },
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

    // Keypad
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

    // Multiple choice
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

    // Skip card
    skipCard: {
      backgroundColor: c.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      padding: 18,
      gap: 10,
    },
    skipTitle: { fontFamily: fonts.bold, fontSize: 16, color: c.navy },
    skipBody: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: c.fgMuted },

    // Feedback
    profRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    profDot: { width: 11, height: 11, borderRadius: 999 },
    profText: { fontFamily: fonts.regular, fontSize: 13, color: c.charcoalMuted },
    // Consolidation "comes back ~Thursday" line (P1e) — a calm green note under
    // the correct verdict; matches the verdict's green, no accent stripe.
    comesBackText: { fontFamily: fonts.regular, fontSize: 13, color: c.statusGreen, marginTop: 4 },

    // §9 no-shift feedback stage. The centered scrolling stage, the correctness
    // ring + un-rotated corner stamp, the absolutely-anchored under-card note,
    // and the bottom-pinned CTA lane all come from the SHARED practice shell
    // (`...makePracticeShellStyles(c)` spread above) so typed / multiple-choice /
    // manipulative items can never drift. Only the keys UNIQUE to this screen's
    // typed + MC paths live here.
    // Answer-field tint in feedback (read-only): green wash on correct, orange on
    // a miss. Border WIDTH unchanged (inputBox is already 2px) — color only.
    inputBoxCorrect: { borderColor: c.green, backgroundColor: "rgba(0,221,145,0.14)", color: c.statusGreen },
    inputBoxMiss: { borderColor: c.orange, backgroundColor: "rgba(255,166,57,0.14)", color: c.fg },
    // Extra feedback micro-copy variants — the shared shell owns the compact
    // `noteMiss`; these accelerated / stuck lines are unique to the typed + MC
    // flow (a manipulative miss reuses `noteMiss`).
    noteAccelerated: { fontFamily: fonts.bold, fontSize: 14, color: c.statusGreen, textAlign: "center" },
    // A correct `· mapping` reveal reads green to match the "Correct" indicator
    // (Andy: the placement caption should match the green Correct stamp); a miss/
    // don't-know keeps the neutral-warm `noteMiss` orange.
    noteMappingCorrect: { fontFamily: fonts.regular, fontSize: 14, color: c.statusGreen, textAlign: "center" },
    noteStuck: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: c.statusRed, textAlign: "center" },
    // Teach-as-action (the "I haven't learned this yet" moment). Calm, no accent
    // stripe/flourish (visual-design rules) — a heading, the worked-steps card,
    // then the pad; the reveal lines match the drill's warm miss tone.
    teachStack: { width: "100%", gap: 14 },
    teachRevealOnly: { width: "100%", gap: 8, alignItems: "center" },
    teachSetup: {
      fontFamily: fonts.regular,
      fontSize: 14,
      fontStyle: "italic",
      color: c.charcoalSubtle,
      textAlign: "center",
    },
    teachHeading: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.fg,
      textAlign: "center",
    },
    teachRevealText: {
      fontFamily: fonts.regular,
      fontSize: 15,
      color: c.fgMuted,
      textAlign: "center",
    },
    teachCorrectRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
    teachCorrectText: { fontFamily: fonts.bold, fontSize: 14, color: c.statusGreen },
    // Tier-2 hint card + the "I'm still stuck" rung link (see TeachingStep).
    teachHintCard: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    teachHintText: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: c.fg },
    teachRetryNudge: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.statusYellow,
      textAlign: "center",
    },
    teachStuckLink: { alignSelf: "center", paddingVertical: 6 },
    teachStuckLinkText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.fgMuted,
      textDecorationLine: "underline",
    },

    twoBtnRow: { flexDirection: "row", gap: 10, width: "100%" },
    twoBtnHalf: { flex: 1, minWidth: 0 },

    // Buttons
    secondaryBtn: {
      minHeight: 48,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.gray50,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    secondaryBtnText: { fontFamily: fonts.semibold, fontSize: 15, color: c.navy },
    // Ghost button: the RN twin of Chakra's variant=ghost. No fill, no border —
    // only the label in a muted-but-readable colour (fgMuted, not disabled-grey),
    // keeping the SAME generous hit area (minHeight 48) and label size (15) as
    // secondaryBtn so the opt-out stays obviously tappable; only the chrome is
    // gone. A pressed background gives visible touch feedback.
    ghostBtn: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: "transparent",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    ghostBtnPressed: { backgroundColor: c.gray50 },
    ghostBtnText: { fontFamily: fonts.semibold, fontSize: 15, color: c.fgMuted },
    linkBtn: { alignItems: "center", justifyContent: "center", paddingVertical: 8 },
    linkBtnText: { fontFamily: fonts.semibold, fontSize: 14, color: c.violet },
    error: { fontFamily: fonts.semibold, fontSize: 13, color: c.statusRed },
    queuedNote: {
      width: "100%",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bgSubtle,
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 4,
      alignItems: "center",
    },
    queuedTitle: {
      fontFamily: fonts.bold,
      fontSize: 14,
      color: c.navy,
      textAlign: "center",
    },
    queuedBody: {
      fontFamily: fonts.regular,
      fontSize: 13,
      lineHeight: 19,
      color: c.fgMuted,
      textAlign: "center",
    },
    connectionBanner: {
      width: "100%",
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.bgSubtle,
      paddingHorizontal: 18,
      paddingVertical: 8,
      alignItems: "center",
    },
    connectionBannerText: {
      fontFamily: fonts.semibold,
      fontSize: 12.5,
      lineHeight: 18,
      color: c.fgMuted,
      textAlign: "center",
    },

    // Message cards (placement / empty)
    messageCard: {
      width: "100%",
      maxWidth: 420,
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 22,
      gap: 12,
      alignItems: "center",
    },
    messageTitle: { fontFamily: fonts.bold, fontSize: 19, color: c.fg, textAlign: "center" },
    messageBody: {
      fontFamily: fonts.regular,
      fontSize: 14.5,
      lineHeight: 21,
      color: c.fgMuted,
      textAlign: "center",
    },

    // Completion
    doneScroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    doneColumn: { width: "100%", maxWidth: 420, gap: 16, alignItems: "center" },
    // The done screen centres its children, which makes a Pressable shrink to
    // its label. The closing CTAs are the screen's committed actions, so they
    // span the same column width as the "You practiced" card above them
    // instead of floating as narrow pills.
    doneCta: { width: "100%" },
    doneTitle: { fontFamily: fonts.bold, fontSize: 24, color: c.fg, textAlign: "center" },
    doneEyebrow: {
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 1,
      color: c.charcoalSubtle,
      textAlign: "center",
    },
    doneSubtle: {
      fontFamily: fonts.regular,
      fontSize: 15,
      lineHeight: 22,
      color: c.fgMuted,
      textAlign: "center",
    },
    practicedCard: {
      width: "100%",
      backgroundColor: c.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 6,
    },
    practicedEyebrow: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
      letterSpacing: 1,
      color: c.charcoalSubtle,
      marginBottom: 2,
    },
    practicedRow: { flexDirection: "row", alignItems: "flex-start" },
    practicedItem: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: c.fg },
    practicedBullet: { width: 16, color: c.charcoalSubtle },
    practicedItemText: { flex: 1 },

    // Strand re-probe ("jump ahead 🔥") — warm amber, mirrors web's reprobe card.
    reprobeCard: {
      width: "100%",
      backgroundColor: c.orangeSubtle,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.orange,
      padding: 16,
      gap: 10,
    },
    reprobeProbeCard: {
      width: "100%",
      backgroundColor: c.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 14,
    },
    reprobeTitle: { fontFamily: fonts.bold, fontSize: 16, color: c.fg },
    reprobeBody: { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: c.fgMuted },
    reprobeEyebrow: {
      fontFamily: fonts.semibold,
      fontSize: 12,
      letterSpacing: 0.4,
      textTransform: "uppercase",
      color: c.orangeMuted,
    },

    // ── The HELP ROW ───────────────────────────────────────────────────────
    // One row of identically-styled secondary pills directly above the pinned
    // primary CTA: the confidence segmented group, the strategy hint, and the
    // honest "I haven't learned this yet". Deliberately allowed to run WIDER
    // than the CTA / problem column (Andy) — five controls squeezed into the
    // 480px column read as crowded. Calm, no accent stripe (visual-design rule).
    helpLane: {
      paddingHorizontal: 16,
      paddingTop: 2,
      paddingBottom: 8,
      gap: 8,
      alignItems: "center",
    },
    helpRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      alignItems: "center",
      gap: 8,
      minHeight: 40,
      maxWidth: HELP_ROW_MAX_WIDTH,
    },
    /** Reserved footprint — a member that steps away holds its space (opacity
     *  only), so the CTA below never moves between phases. */
    helpHidden: { opacity: 0 },
    helpPill: {
      minHeight: 40,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bg,
      paddingHorizontal: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    helpPillActive: { backgroundColor: c.cyanSubtle, borderColor: c.cyan },
    helpPillText: { fontFamily: fonts.semibold, fontSize: 13.5, color: c.fgMuted },
    helpPillTextActive: { color: c.cyan, fontFamily: fonts.bold },
    helpHintBox: {
      maxWidth: HELP_ROW_MAX_WIDTH,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "#e3c766",
      backgroundColor: "#fbf4dd",
    },
    helpHintText: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: "#7a5f1c",
      textAlign: "center",
    },
    // Predict-then-Check confidence — an ATTACHED 3-segment control (one pill,
    // three segments) so the three options read as a single set with no caption.
    segGroup: {
      flexDirection: "row",
      minHeight: 40,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bg,
      overflow: "hidden",
    },
    segItem: {
      paddingHorizontal: 14,
      alignSelf: "stretch",
      alignItems: "center",
      justifyContent: "center",
    },
    segItemDivider: { borderLeftWidth: 1, borderLeftColor: c.border },
    segItemSelected: { backgroundColor: c.cyanSubtle },
    segText: { fontFamily: fonts.semibold, fontSize: 13.5, color: c.fgMuted },
    segTextSelected: { color: c.cyan, fontFamily: fonts.bold },
    calibrationReveal: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.gray50,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    calibrationRevealText: { fontFamily: fonts.regular, fontSize: 13.5, color: c.charcoalMuted },
  });
}
