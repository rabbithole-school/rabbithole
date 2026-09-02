/**
 * NativeManipulativeItem — the reusable card that hosts ONE served manipulative
 * practice item (a `practiceItems` row with `answerType: "manipulative"`) on the
 * native iPad app. It is the native analogue of the web `Manipulative` frame in
 * practice mode (components/manipulative/Manipulative.tsx + the `answerType ===
 * "manipulative"` branch of components/practice/PracticeSession.tsx):
 *
 *   1. Read the item's `ManipulativeSpec` from the deliberately-unauthenticated
 *      `getManipulativeItem` query (a spec has no answer to leak — the goal IS
 *      the visible task; see vendor/manipulative/practiceContract.ts).
 *   2. If the spec's kind has a native renderer, render it INLINE with native
 *      chrome (concept eyebrow, prompt, a Done button, a verdict chip) and grade
 *      through the EXACT SAME server path the web uses — the authed
 *      `api.practiceSkills.submitAnswer` mutation, with the locked-in runtime
 *      state as the `answer` payload. The client's own `onSolvedChange` is
 *      optimistic UI only; the SERVER's `gradeManipulativeSubmission` verdict is
 *      the record (identical mutation ⇒ mastery / spaced-review / streak
 *      semantics are preserved, never forked).
 *   3. If the kind has NO native renderer, fall back to the existing #446
 *      WebView embed path (`openManipulativeEmbed` → the chrome-free
 *      `/embed/manipulative` route), which grades server-side the same way.
 *
 * Unlike the WebView, native holds a real Convex Auth session, so the inline
 * path grades directly as the scholar with no embed-token handoff. The card
 * also reuses regular practice's strategy hint as the middle step between
 * working independently and "I haven't learned this yet."
 *
 * Done is controlled through the parent, not a second submit path: an
 * in-playlist caller (native/src/app/practice.tsx) supplies
 * `submitAnswerOverride`, which routes the answer through the shared practice
 * machine's `ui:submit` (the SAME outbox/coordinator/breaker machinery a
 * typed or multiple-choice item uses) instead of calling `submitAnswer`
 * directly here. The override may resolve `{ status: "queued" }` — a durable
 * offline/ambiguous-failure fallback with NO claimed grade — which this
 * component renders honestly (no verdict stamp, a neutral "saved" note) while
 * still letting the scholar advance. Absent `submitAnswerOverride` (the
 * standalone `NativeManipulativeHost` launcher, which has no parent run to
 * route through), Done falls back to the direct mutation with no offline
 * queue — unchanged from before this file supported an override at all.
 */

import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ScrollView } from "react-native-gesture-handler";

import { api, type Id } from "@/lib/convex";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { fonts, useColors } from "@/theme";
import type { PracticeShellStyles } from "@/lib/practiceShell";
import { DONT_KNOW_LABEL } from "@/lib/practicePad";
import { PracticeVerdictStamp } from "@/components/practice/PracticeVerdictStamp";
import {
  PracticePrimaryAction,
  useGuardedPracticeAction,
} from "@/components/practice/NativePracticeControls";
import {
  allowedHostsForUrl,
  manipulativeEmbedUrl,
} from "@/lib/webEmbedConfig";
import { openManipulativeEmbed } from "@/lib/externalAppHost";
import { isChallenge, type ManipulativeSpec } from "../../../vendor/manipulative/types";
import {
  computeTiming,
  payloadClientEventReceipt,
  type PayloadClientEventReceipt,
} from "../../../vendor/shared/practiceLoop";
import { ManipulativeScrollContext, successNotify, warningNotify } from "./kit";
import {
  isNativeManipulativeKind,
  NativeManipulative,
} from "./NativeManipulative";

type Verdict = "idle" | "correct" | "incorrect";
type SubmitAnswerArgs = FunctionArgs<typeof api.practiceSkills.submitAnswer>;
type SubmitAnswerResult = FunctionReturnType<typeof api.practiceSkills.submitAnswer>;
export type NativeManipulativeGradeResult = Pick<SubmitAnswerResult, "correct">;

/** The args `submitAnswerOverride` receives — the exact shape the direct
 *  `submitAnswer` mutation takes, so a parent-supplied override can build an
 *  `OutboxAnswer` (or forward straight to the mutation) without a second,
 *  hand-mirrored argument shape. */
export type NativeManipulativeSubmitArgs = SubmitAnswerArgs;

/** The outcome a parent-supplied `submitAnswerOverride` resolves with.
 *  `"graded"` carries the REAL server verdict — the only kind that may show a
 *  correct/incorrect stamp or fire `onGraded`. `"queued"` means the answer was
 *  durably recorded (offline, or a live attempt that failed ambiguously and
 *  fell back to the outbox) with NO verdict to show — the scholar may still
 *  advance, but nothing here claims a grade that hasn't happened yet. */
export type NativeManipulativeSubmission =
  | { status: "graded"; result: NativeManipulativeGradeResult }
  | { status: "queued"; queuedCount: number };

async function routeManipulativeSubmission(
  args: NativeManipulativeSubmitArgs,
  submitAnswer: (value: SubmitAnswerArgs) => Promise<SubmitAnswerResult>,
  override?: (
    value: NativeManipulativeSubmitArgs,
  ) => Promise<NativeManipulativeSubmission>,
): Promise<NativeManipulativeSubmission> {
  if (override) return override(args);
  return { status: "graded", result: await submitAnswer(args) };
}

export interface NativeManipulativeItemProps {
  /** A served practice-item id, e.g. `gen#<practiceItems _id>`. */
  itemId: string;
  /** The scholar being graded — `submitAnswer`'s subject (usually the caller). */
  scholarId: Id<"users">;
  /**
   * The SHARED practice-shell styles (`makePracticeShellStyles`). Passed in
   * (rather than rebuilt) so a manipulative item renders into the EXACT SAME
   * shell every other item type uses — a vertically-centered stage, a corner
   * verdict stamp, and a bottom-pinned CTA lane — with no duplicated pixel
   * values (DRY). The parent practice screen spreads the same factory into its
   * own `styles`, so passing that superset also satisfies this contract.
   */
  shell: PracticeShellStyles;
  /** Whether this is the last item in the run — drives the Finish/Next label. */
  isLast: boolean;
  /** Fired once with the SERVER's graded result (the record), after Done —
   *  ONLY for a real grade. A durably queued Done never fires this: there is
   *  no verdict yet to fold into mastery-adjacent host state. */
  onGraded?: (result: NativeManipulativeGradeResult) => void;
  /** Episode context owned by the parent practice loop and graded atomically. */
  getSubmissionContext?: (itemId: string) => Pick<
    SubmitAnswerArgs,
    | "prepareBreakerRepair"
    | "suppressBreaker"
    | "breakerTriggerAttemptId"
    | "breakerEasyTriggerAttemptId"
  >;
  /**
   * Route Done through the parent's machine-owned submit path instead of this
   * component's own direct `submitAnswer` mutation. Absent ⇒ the standalone
   * behavior (grade directly, no offline queue) — used by
   * `NativeManipulativeHost`, which has no parent practice run/machine to
   * route through. Present ⇒ the in-playlist practice screen ALWAYS supplies
   * this, so an in-run manipulative is controlled entirely through the
   * parent/machine, never a second direct mutation call.
   */
  submitAnswerOverride?: (
    args: NativeManipulativeSubmitArgs,
  ) => Promise<NativeManipulativeSubmission>;
  /**
   * "I haven't learned this yet" — the SAME honest don't-know affordance the
   * typed / multiple-choice pad items carry (U-4 parity). When provided, a ghost
   * skip link renders below Done on a FIRST look; tapping it hands control to the
   * parent's don't-know flow (record a miss + open the worked "explain"), exactly
   * like a pad item. Absent ⇒ no skip link (e.g. an embed with no parent loop).
   */
  onDontKnow?: () => void;
  /**
   * The parent's live connectivity signal (`useConvexOnline`). Offline, the
   * skip link is HIDDEN rather than merely disabled — matching the pad items'
   * `skipVisible` exactly: a documented no-op (see `onDontKnow` on the parent)
   * reads as confusing if the affordance still looks pressable. Absent ⇒
   * always visible — `NativeManipulativeHost`'s standalone usage has no
   * offline-tracking parent to report this, so it keeps its prior behavior.
   */
  online?: boolean;
  /** Ask the host to dismiss (Close, or after handing off to the WebView). */
  onRequestClose?: () => void;
}

/**
 * Parse a stored spec JSON to a `ManipulativeSpec`, or null if unusable. A
 * native-only mirror of `lib/manipulative/grade.ts`'s `parseManipulativeSpec`
 * (native never grades locally, so it needs the parse but not the grader).
 */
function parseSpec(json: string | null | undefined): ManipulativeSpec | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { kind?: unknown }).kind === "string"
    ) {
      return parsed as ManipulativeSpec;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function NativeManipulativeItem({
  itemId,
  scholarId,
  shell,
  isLast,
  onGraded,
  getSubmissionContext,
  submitAnswerOverride,
  onDontKnow,
  online = true,
  onRequestClose,
}: NativeManipulativeItemProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const scrollRef = useRef(null);
  // The standalone launcher has no parent machine to retain a failed attempt's
  // receipt. In-playlist practice omits this field and lets the machine remain
  // the sole owner of clientEventId/clientEventKey. The payload fingerprint
  // rotates the standalone receipt if the material changes before a retry.
  const standaloneClientEventReceiptRef =
    useRef<PayloadClientEventReceipt | null>(null);

  const item = useQuery(api.practiceSkills.getManipulativeItem, { itemId });
  const submitAnswer = useMutation(api.practiceSkills.submitAnswer);

  const spec = useMemo(() => parseSpec(item?.manipulativeSpec), [item]);

  // The kind's latest runtime state, lifted so Done can submit it. The Done
  // button stays disabled until the scholar has actually shaped a state.
  const [state, setState] = useState<unknown>(null);
  const [committed, setCommitted] = useState(false);
  const [grading, setGrading] = useState(false);
  const gradingInFlightRef = useRef(false);
  const [verdict, setVerdict] = useState<Verdict>("idle");
  /** Durably queued, NOT graded — no claimed verdict; Next/Finish still
   *  enables, exactly as a real grade would. Null once the item is answered
   *  with a real grade instead, or before Done has been tapped at all. */
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);
  const itemRenderAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (spec && itemRenderAtRef.current === null) {
      itemRenderAtRef.current = Date.now();
    }
  }, [spec]);

  const onSolvedChange = useCallback(() => {
    // Optimistic self-check is UI feel only; the card never reveals a verdict
    // from it. Any manipulation before Done just re-arms (nothing to do here).
  }, []);
  const onStateChange = useCallback((s: unknown) => {
    setState(s);
  }, []);

  // A native renderer that THROWS is treated exactly like an unsupported kind:
  // hand the item off to the WebView embed rather than take the app down.
  //
  // Why this exists: a render throw here is not a redbox on a fleet iPad. In a
  // Release build React Native escalates an unhandled JS error to RCTFatal ->
  // abort(), so one bad manipulative hard-crashes the app — and a crash also
  // ejects the scholar from their session. That happened in the field: an
  // `Array`/`CoordinatePlane` worklet captured a Pan gesture and every scholar
  // served one crashed out of practice. The specific bug is fixed, but the
  // blast radius is what matters — a kid on a locked-down 1:1 iPad must never
  // lose the whole app because one material failed to draw. The embed grades
  // through the same server path, so the fallback costs the scholar nothing.
  const [rendererCrashed, setRendererCrashed] = useState(false);

  // Unsupported kind → hand off to the WebView embed (which grades server-side
  // the same way) and dismiss. Effect (not render) so the store write + close
  // don't happen mid-render. Guarded so it fires once per unsupported item.
  const handedOff = useRef(false);
  const unsupported =
    (!!spec && !isNativeManipulativeKind(spec.kind)) || rendererCrashed;
  useEffect(() => {
    if (!unsupported || handedOff.current || !item) return;
    handedOff.current = true;
    const url = manipulativeEmbedUrl({ itemId, scholarId: String(scholarId) });
    openManipulativeEmbed({
      id: `manipulative:${itemId}`,
      title: "Practice",
      subtitle: item.stem,
      url,
      allowedHosts: allowedHostsForUrl(url),
    });
    onRequestClose?.();
  }, [unsupported, item, itemId, scholarId, onRequestClose]);

  const onDone = useCallback(async () => {
    if (committed || grading || gradingInFlightRef.current || state === null) return;
    gradingInFlightRef.current = true;
    setGrading(true);
    setError(null);
    setCommitted(true);
    const timing =
      itemRenderAtRef.current === null
        ? {}
        : computeTiming({
            firstAttempt: true,
            nowMs: Date.now(),
            renderAtMs: itemRenderAtRef.current,
            firstKeyAtMs: null,
          });
    const answer = JSON.stringify(state);
    const submissionContext = getSubmissionContext?.(itemId);
    const payloadKey = JSON.stringify({
      itemId,
      answer,
      ...submissionContext,
    });
    const standaloneReceipt = submitAnswerOverride
      ? null
      : payloadClientEventReceipt(
          standaloneClientEventReceiptRef.current,
          payloadKey,
          "practice-answer",
        );
    if (standaloneReceipt) {
      standaloneClientEventReceiptRef.current = standaloneReceipt;
    }
    const args: NativeManipulativeSubmitArgs = {
      scholarId,
      itemId,
      answer,
      ...(standaloneReceipt
        ? { clientEventId: standaloneReceipt.clientEventId }
        : {}),
      ...submissionContext,
      ...timing,
    };
    let submission: NativeManipulativeSubmission;
    try {
      submission = await routeManipulativeSubmission(
        args,
        submitAnswer,
        submitAnswerOverride,
      );
    } catch (e) {
      // Neither graded nor durably queued (e.g. storage itself failed): let
      // the scholar try Done again on the SAME answer rather than silently
      // losing it or advancing past an attempt that was never recorded.
      setCommitted(false);
      setError(e instanceof Error ? e.message : "Couldn't check that — try Done again.");
      gradingInFlightRef.current = false;
      setGrading(false);
      return;
    }

    // Either a real grade or a durable queue both consume this attempt's
    // receipt — a genuinely NEW answer (after tapping Done again on a
    // reshaped material) mints its own. Only a thrown, non-durable failure
    // (above) keeps it, so that retry replays as the SAME logical answer.
    if (!submitAnswerOverride) {
      standaloneClientEventReceiptRef.current = null;
    }
    if (submission.status === "queued") {
      // Durably recorded, no verdict yet — the scholar may still advance
      // (Next/Finish enables via `committed`, already set above), but
      // nothing here claims a grade that hasn't happened.
      setQueued(true);
      gradingInFlightRef.current = false;
      setGrading(false);
      return;
    }
    const { result } = submission;
    setVerdict(result.correct ? "correct" : "incorrect");
    // Success / warning notification — a hardware no-op on iPad (no Taptic
    // engine), felt only on haptic-capable hardware; the visual verdict chip
    // carries it on iPad.
    if (!submitAnswerOverride) {
      if (result.correct) successNotify();
      else warningNotify();
    }
    onGraded?.(result);
    gradingInFlightRef.current = false;
    setGrading(false);
  }, [
    committed,
    grading,
    state,
    submitAnswer,
    submitAnswerOverride,
    scholarId,
    itemId,
    getSubmissionContext,
    onGraded,
  ]);
  const doneDisabled = committed || grading || state === null;
  // First-look "I haven't learned this yet" gate — mirrors the pad items: shown
  // only before the scholar has committed / been graded/queued, only while
  // online (matching web's `skipVisible`'s `!isOffline` exactly — a
  // documented offline no-op reads as a broken button if the link stays
  // visible), and only when a parent don't-know handler is wired in.
  const showSkip =
    !!onDontKnow && online && !committed && !grading && !queued && verdict === "idle";
  const onDonePrimary = useGuardedPracticeAction(
    () => void onDone(),
    !doneDisabled,
    `done:${itemId}:${committed}:${grading}`,
  );
  const onAdvancePrimary = useGuardedPracticeAction(
    () => onRequestClose?.(),
    committed && !grading && !!onRequestClose,
    `advance:${itemId}:${verdict}`,
  );

  // ── loading / not-found / handoff states ──────────────────────────────────
  if (item === undefined || (unsupported && !error)) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.violet} />
      </View>
    );
  }
  if (!item || !spec) {
    return (
      <View style={styles.centered}>
        <View style={[styles.card, { maxWidth: 460 }]}>
          <Text style={styles.fallback}>
            This activity couldn&apos;t be loaded. Head back and tap it again.
          </Text>
          {onRequestClose ? (
            <Pressable onPress={onRequestClose} style={styles.reset} accessibilityRole="button">
              <Text style={styles.resetText}>Close</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  const challenge = isChallenge(spec);
  const graded = verdict !== "idle";
  const badgeLabel = spec.extraCredit ? "EXTRA ★" : challenge ? "CHALLENGE" : "EXPLORE";
  const badgeStyle = spec.extraCredit
    ? styles.badgeExtra
    : challenge
      ? styles.badgeChallenge
      : styles.badgeExplore;
  const badgeColor = spec.extraCredit ? colors.navy : challenge ? colors.violet : colors.cyan;

  // The under-card note — the SAME short supportive line the standard feedback
  // note shows. The corner stamp carries the verdict badge; this is the
  // sentence. `queued` NEVER claims a grade — it says only that the answer is
  // safe, exactly like web's PracticeSession "queued" phase.
  const noteText = error
    ? error
    : grading
      ? "Checking…"
      : queued
        ? "Saved — we'll check this one when the earlier answers finish."
        : verdict === "correct"
          ? "That's it! ✓"
          : verdict === "incorrect"
            ? "Not quite — take another look."
            : null;

  return (
    <ManipulativeScrollContext.Provider value={scrollRef}>
      <View style={styles.screen}>
        {/* Vertically-centered stage — the SAME scroll container every other item
            type uses, so a manipulative's question sits centered, not top-pinned. */}
        <ScrollView
          ref={scrollRef}
          style={shell.stageScrollFlex}
          contentContainerStyle={shell.stageScroll}
        >
          <View style={styles.column}>
            <View
              style={[
                styles.card,
                verdict === "correct" && shell.stemBoxCorrect,
                verdict === "incorrect" && shell.stemBoxMiss,
              ]}
            >
              <View style={styles.head}>
                <View style={styles.headText}>
                  <Text style={styles.concept}>{spec.concept.toUpperCase()}</Text>
                  <Text style={styles.prompt}>{spec.prompt}</Text>
                </View>
                <View style={[styles.badge, badgeStyle]}>
                  <Text style={[styles.badgeText, { color: badgeColor }]}>{badgeLabel}</Text>
                </View>
              </View>

              {/* Anti-scrub lock: once Done is tapped the stage freezes so the
                  scholar can't keep reshaping a submitted material mid-grade. */}
              <View
                style={[styles.stage, committed && styles.stageCommitted]}
                pointerEvents={committed ? "none" : "auto"}
              >
                <ManipulativeRendererBoundary
                  itemId={itemId}
                  onCrash={() => setRendererCrashed(true)}
                >
                  <NativeManipulative
                    spec={spec}
                    onSolvedChange={onSolvedChange}
                    onStateChange={onStateChange}
                  />
                </ManipulativeRendererBoundary>
              </View>

              <PracticeVerdictStamp
                feedback={
                  graded && !grading ? (verdict === "correct" ? "correct" : "miss") : null
                }
                shell={shell}
              />
            </View>

            {!committed ? (
              <>
                <Pressable
                  onPress={() => setShowHint((shown) => !shown)}
                  style={styles.hintButton}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showHint }}
                >
                  <Text style={styles.hintButtonText}>
                    {showHint ? "Hide hint" : "Stuck? Hint"}
                  </Text>
                </Pressable>
                {showHint ? (
                  <View style={styles.hintBox}>
                    <Text style={styles.hintText}>{item.hint}</Text>
                  </View>
                ) : null}
              </>
            ) : null}

            {/* Under-card note anchored ABSOLUTELY at the column's bottom
                (top:100%) so it never grows the centered column — the same
                no-shift feedback anchor the typed items use. */}
            {noteText ? (
              <View style={shell.noteAnchor} pointerEvents="box-none">
                <View style={shell.noteBlock}>
                  <Text
                    style={
                      error
                        ? styles.error
                        : verdict === "incorrect"
                          ? shell.noteMiss
                          : queued
                            ? styles.noteQueued
                            : styles.noteOk
                    }
                  >
                    {noteText}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
        </ScrollView>

        {/* Action lane — PINNED to the bottom of the screen, the SAME lane the
            typed / multiple-choice items use, so Done/Continue sit exactly where a
            scholar expects across every item type. */}
        <View style={shell.ctaLane}>
          {grading ? (
            <PracticePrimaryAction
              label="Checking…"
              accessibilityLabel="Checking answer"
              loading
              styles={shell}
              indicatorColor={colors.white}
              onAction={onDonePrimary}
            />
          ) : !committed ? (
            <PracticePrimaryAction
              label="Done"
              accessibilityLabel="Done"
              disabled={doneDisabled}
              captureReturn
              styles={shell}
              indicatorColor={colors.white}
              onAction={onDonePrimary}
            />
          ) : (
            <PracticePrimaryAction
              label={`${isLast ? "Finish" : "Next"}  →`}
              accessibilityLabel={isLast ? "Finish practice" : "Next question"}
              captureReturn
              styles={shell}
              indicatorColor={colors.white}
              onAction={onAdvancePrimary}
            />
          )}
          {/* "I haven't learned this yet" — same reserved-slot skip link the pad
              items use, in the same place with the same copy. First look only
              (before Done); the slot holds its space via opacity so hiding it
              never nudges the primary action. */}
          {onDontKnow ? (
            <View
              style={[shell.skipSlot, !showSkip && shell.skipSlotHidden]}
              pointerEvents={showSkip ? "auto" : "none"}
            >
              <Pressable
                onPress={onDontKnow}
                disabled={!showSkip}
                style={shell.linkBtn}
                accessibilityRole="button"
                accessibilityElementsHidden={!showSkip}
                importantForAccessibility={showSkip ? "auto" : "no-hide-descendants"}
              >
                <Text style={shell.linkBtnText}>{DONT_KNOW_LABEL}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </ManipulativeScrollContext.Provider>
  );
}

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(c: ColorSet) {
  return StyleSheet.create({
    // Full-screen root: a flex column so the centered stage takes the remaining
    // height and the CTA lane pins to the bottom (mirrors the parent screen).
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 40,
      backgroundColor: c.bgSubtle,
    },
    // Positioning context for the absolute verdict stamp (on the card) and the
    // note anchored at the column's bottom (top:100%). A touch wider than the
    // typed-item column since a manipulative stage needs room to be worked.
    column: { width: "100%", maxWidth: 600, gap: 14 },
    card: {
      width: "100%",
      backgroundColor: c.bg,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.border,
      padding: 18,
      gap: 12,
    },
    head: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
    },
    headText: { flex: 1, minWidth: 0 },
    concept: {
      fontFamily: fonts.bold,
      fontSize: 11.5,
      letterSpacing: 1,
      color: c.charcoalSubtle,
    },
    prompt: {
      fontFamily: fonts.bold,
      fontSize: 19,
      lineHeight: 24,
      color: c.navy,
      marginTop: 2,
    },
    badge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: 1,
    },
    badgeExplore: { backgroundColor: c.cyanSubtle, borderColor: c.cyanMuted },
    badgeChallenge: { backgroundColor: c.violetSubtle, borderColor: c.violetMuted },
    badgeExtra: { backgroundColor: c.orangeSubtle, borderColor: c.orangeMuted },
    badgeText: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1 },
    stage: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 6,
    },
    stageCommitted: { opacity: 0.6 },
    hintButton: {
      alignSelf: "flex-start",
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 10,
    },
    hintButtonText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: "#7a5f1c",
    },
    hintBox: {
      width: "100%",
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: "#e3c766",
      backgroundColor: "#fbf4dd",
    },
    hintText: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: "#7a5f1c",
    },
    // Correct-verdict note line (mirrors the standard feedback note's tone). A
    // miss reuses the shared `noteMiss`; an error reuses `error`; a durable
    // queue (no claimed grade yet) gets its own neutral tone — never the
    // success green, which would read as a verdict that hasn't happened.
    noteOk: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.statusGreen,
      textAlign: "center",
    },
    noteQueued: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.charcoalSubtle,
      textAlign: "center",
    },
    error: { fontFamily: fonts.semibold, fontSize: 13, color: c.statusRed, textAlign: "center" },
    reset: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.gray50,
    },
    resetText: { fontFamily: fonts.semibold, fontSize: 14, color: c.navy },
    fallback: {
      fontFamily: fonts.regular,
      fontSize: 15,
      lineHeight: 21,
      color: c.fgMuted,
    },
  });
}

/**
 * Catches a throw from any native manipulative renderer and reports it, so the
 * host can fall back to the WebView embed. Mirrors `GameErrorBoundary` in
 * GameHost.tsx — on a managed 1:1 iPad an uncaught render throw is not a
 * redbox, it is RCTFatal -> abort(), which takes the whole app (and the
 * scholar's session) down. It stops here.
 *
 * Renders nothing while crashed: the host swaps to the embed on the same tick,
 * and a half-drawn stage would be worse than an empty one.
 */
class ManipulativeRendererBoundary extends Component<
  { children: ReactNode; itemId: string; onCrash: () => void },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(
      `[manipulative] native renderer threw for item ${this.props.itemId} — falling back to the embed`,
      error,
    );
    this.props.onCrash();
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}
