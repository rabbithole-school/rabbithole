/**
 * The Scholar's Prep tab — the RN twin of components/ScholarPrepSections.tsx.
 * Three plain questions on one surface style:
 *
 *   1. "Due"          — assigned homework with its due chip (teacher-owned,
 *                       always dated). Derived; no checkbox, no remove.
 *   2. "Done today?"  — the close-out of today's still-open activities/quests:
 *                       "✓ Done" (`takeHomePlans.resolveSuggestion`, with a
 *                       durable Undo) or "Keep it open"
 *                       (`takeHomePlans.keepSuggestionOpen`, stop asking today).
 *   3. "Keep going · from your Quests" — the top rows of the scholar's ONE
 *                       queue (`questionQueue.forSelf`), rendered by the same
 *                       row component the Quests tab uses.
 *
 * The old "To do tonight" plan list (adding quests / notes to tonight) is
 * RETIRED. Sections 1–2 read `api.takeHomePlans.forSelf` (its `assigned` /
 * `suggestions` / `resolvedToday`); its `selected` rows are no longer
 * rendered. Copy: shared/questionQueue.ts (vendored).
 */

import { useEffect, useMemo, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";

import { api, type Id } from "@/lib/convex";
import { openWebActivity } from "@/lib/externalAppHost";
import { openGameActivity } from "@/lib/gameHost";
import { webEmbedUrlError } from "@/lib/webEmbedConfig";
import { HOME_GAP } from "@/lib/homeRhythm";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { useExploreSeed } from "@/hooks/useExploreSeed";
import {
  Eyebrow,
  QueueSurface,
  QuestionQueueRowView,
  useQuestionQueue,
} from "@/components/QuestionQueue";
import { DueChip } from "@/components/ui/DueChip";
import { fonts, useColors, type Colors } from "@/theme";
import {
  PREP_KEEP_GOING_COUNT,
  QUESTION_QUEUE_COPY,
} from "../../vendor/shared/questionQueue";

type Plan = FunctionReturnType<typeof api.takeHomePlans.forSelf>;
type AssignedItem = Plan["assigned"][number];
type Suggestion = Plan["suggestions"][number];

const MINUTE_MS = 60_000;
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const TOUCH = 48;

const suggestionArg = (item: Suggestion) =>
  item.kind === "activity"
    ? { kind: "activity" as const, sessionId: item.sessionId }
    : { kind: "quest" as const, unitId: item.unitId };

export function ScholarPrepSections() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const convex = useConvex();
  // Minute-rounded clock as the query's reactive dependency (T11): the plan
  // re-runs across the institution-local midnight and as homework falls due.
  // Smoothed, not plain: each new `now` is a new subscription, and a plain
  // useQuery would drop to `undefined` for that round-trip once a minute.
  const [now, setNow] = useState(() => floorToMinute(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setNow(floorToMinute(Date.now())), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  const plan = useSmoothedQuery(api.takeHomePlans.forSelf, { now });
  const queue = useQuestionQueue();
  const { exploreSeed, exploringSeedId, exploreSeedDialog } = useExploreSeed();

  const resolveSuggestion = useMutation(api.takeHomePlans.resolveSuggestion);
  const keepSuggestionOpen = useMutation(api.takeHomePlans.keepSuggestionOpen);
  const undoResolveSuggestion = useMutation(api.takeHomePlans.undoResolveSuggestion);
  const createSession = useMutation(api.sessions.create);
  const openOfflineHomework = useMutation(api.sessions.openOfflineHomework);
  const [pending, setPending] = useState<string | null>(null);

  // A promise chain, not try/finally: the React Compiler bails out on a try
  // statement in a component (native's compiler baseline is checked).
  const run = (key: string, action: () => Promise<unknown>, failure: string) => {
    if (pending) return;
    setPending(key);
    action()
      .then(
        () => {
          Haptics.selectionAsync().catch(() => {});
        },
        (error: unknown) => {
          console.warn("[scholar-prep]", error);
          Alert.alert(failure, "Please try again.");
        },
      )
      .finally(() => setPending(null));
  };

  const openAssigned = (item: AssignedItem) =>
    run(
      `assigned:${item.id}`,
      async () => {
        if (item.activityKind === "offline") {
          const result = await openOfflineHomework({
            activityId: item.activityId,
            assignmentId: item.assignmentId,
          });
          router.push({
            pathname: "/session/[id]",
            params: { id: result.id, title: item.label },
          });
          return;
        }
        if (item.activityKind === "web") {
          let webUrl = item.webUrl;
          let webAllowedHosts = item.webAllowedHosts;
          let externalAppId: Id<"externalApps"> | null = null;
          if (!webUrl) {
            const activity = await convex.query(api.activities.getPublic, {
              id: item.activityId,
            });
            webUrl = activity?.webUrl ?? null;
            webAllowedHosts = activity?.webAllowedHosts ?? null;
            externalAppId = activity?.externalAppId ?? null;
          }
          if (!webUrl) {
            Alert.alert(
              "No website yet",
              "Ask your teacher to add the website URL for this activity.",
            );
            return;
          }
          const urlError = webEmbedUrlError(webUrl);
          if (urlError) {
            Alert.alert("Couldn’t open this activity", urlError);
            return;
          }
          openWebActivity({
            activityId: item.activityId,
            assignmentId: item.assignmentId,
            title: item.label,
            url: webUrl,
            allowedHosts: webAllowedHosts,
            externalAppId,
            gestureMode: "page",
          });
          return;
        }
        if (item.activityKind === "game") {
          openGameActivity({
            activityId: item.activityId,
            assignmentId: item.assignmentId,
            activityTitle: item.label,
          });
          return;
        }
        if (item.activityKind === "problem_set" && item.practiceSkillKey) {
          router.push({
            pathname: "/practice",
            params: { skill: item.practiceSkillKey },
          });
          return;
        }
        const result = await createSession({
          activityId: item.activityId,
          assignmentId: item.assignmentId,
        });
        if (result?.id) {
          router.push({
            pathname: "/session/[id]",
            params: { id: result.id, title: item.label },
          });
        }
      },
      "Couldn't open that activity",
    );

  // A non-scholar gets the empty plan shape back (dayKey null).
  const planReady = plan !== undefined && plan.dayKey !== null;
  const keepGoing = (queue.rows ?? []).slice(0, PREP_KEEP_GOING_COUNT);
  const closeOutRows = planReady
    ? plan.suggestions.length + plan.resolvedToday.length
    : 0;

  // Nothing to show yet: render no stack, so the Home's gap stack holds no
  // phantom gap for an empty wrapper (see homeRhythm).
  if (!planReady && keepGoing.length === 0) return exploreSeedDialog;

  return (
    <View style={styles.stack}>
      {/* ── 1. Due ─────────────────────────────────────────────────── */}
      {planReady && (
        <QueueSurface>
          <Eyebrow>{QUESTION_QUEUE_COPY.prepDue}</Eyebrow>
          {plan.assigned.length === 0 ? (
            <Text style={styles.empty}>{QUESTION_QUEUE_COPY.prepDueEmpty}</Text>
          ) : (
            plan.assigned.map((item, index) => {
              const meta = [
                item.meta,
                item.teacherName ? `with ${item.teacherName}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.label}`}
                  disabled={pending !== null}
                  onPress={() => openAssigned(item)}
                  style={({ pressed }) => [
                    styles.assignedRow,
                    index > 0 && styles.divided,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <Text style={styles.glyph} accessible={false}>
                    {item.unitEmoji ?? "📘"}
                  </Text>
                  <View style={styles.rowBody}>
                    {meta ? (
                      <Text style={styles.meta} numberOfLines={1}>
                        {meta}
                      </Text>
                    ) : null}
                    <Text style={styles.title}>{item.label}</Text>
                  </View>
                  <DueChip dueAt={item.dueAt} nowMs={now} timeZone={plan.timeZone} />
                  <View style={styles.cta} accessibilityElementsHidden>
                    <Text style={styles.ctaText}>Open</Text>
                    <Text style={styles.ctaCaret}>›</Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </QueueSurface>
      )}

      {/* ── 2. Done today? ─────────────────────────────────────────── */}
      {planReady && closeOutRows > 0 && (
        <QueueSurface>
          <Eyebrow>{QUESTION_QUEUE_COPY.prepDoneToday}</Eyebrow>
          {plan.suggestions.length > 0 ? (
            <Text style={styles.hint}>{QUESTION_QUEUE_COPY.prepDoneTodayHint}</Text>
          ) : null}
          {plan.suggestions.map((item, index) => (
            <View
              key={item.id}
              style={[
                styles.closeOutRow,
                index > 0 && styles.divided,
                pending === `close:${item.id}` && styles.busy,
              ]}
            >
              <View style={styles.head}>
                <Text style={styles.glyph} accessible={false}>
                  {item.kind === "quest" ? (item.meta ?? "🧭") : "📝"}
                </Text>
                <View style={styles.rowBody}>
                  <Text style={styles.meta} numberOfLines={1}>
                    {item.kind === "quest" ? "Quest" : "From today's class"}
                  </Text>
                  <Text style={styles.title}>{item.label}</Text>
                </View>
              </View>
              <View style={styles.pair}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Done with ${item.label}`}
                  disabled={pending !== null}
                  onPress={() =>
                    run(
                      `close:${item.id}`,
                      () => resolveSuggestion({ suggestion: suggestionArg(item) }),
                      "Couldn't mark that done",
                    )
                  }
                  style={({ pressed }) => [
                    styles.button,
                    styles.buttonPrimary,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.buttonPrimaryText}>{QUESTION_QUEUE_COPY.prepDone}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Keep ${item.label} open`}
                  disabled={pending !== null}
                  onPress={() =>
                    run(
                      `close:${item.id}`,
                      () => keepSuggestionOpen({ suggestion: suggestionArg(item) }),
                      "Couldn't update that",
                    )
                  }
                  style={({ pressed }) => [
                    styles.button,
                    styles.buttonSecondary,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.buttonSecondaryText}>
                    {QUESTION_QUEUE_COPY.prepKeepOpen}
                  </Text>
                </Pressable>
              </View>
            </View>
          ))}
          {plan.resolvedToday.map((item, index) => (
            <View
              key={item.itemId}
              style={[
                styles.resolvedRow,
                plan.suggestions.length + index > 0 && styles.divided,
              ]}
            >
              <Text style={styles.resolvedText}>
                {QUESTION_QUEUE_COPY.prepMarkedDone} · {item.label}
              </Text>
              {item.actions.includes("undo") ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Undo ${item.label}`}
                  disabled={pending !== null}
                  onPress={() =>
                    run(
                      `undo:${item.itemId}`,
                      () => undoResolveSuggestion({ itemId: item.itemId }),
                      "Couldn't undo that",
                    )
                  }
                  style={({ pressed }) => [styles.undo, pressed && styles.pressed]}
                >
                  <Text style={styles.undoText}>{QUESTION_QUEUE_COPY.prepUndo}</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </QueueSurface>
      )}

      {/* ── 3. Keep going · from your Quests ───────────────────────── */}
      {keepGoing.length > 0 && (
        <QueueSurface>
          <Eyebrow>{QUESTION_QUEUE_COPY.prepKeepGoing}</Eyebrow>
          {keepGoing.map((row, index) => (
            <QuestionQueueRowView
              key={row.id}
              row={row}
              queue={queue}
              divided={index > 0}
              onStartTeacherQuest={exploreSeed}
              startingSeedId={exploringSeedId}
            />
          ))}
        </QueueSurface>
      )}
      {exploreSeedDialog}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    stack: { width: "100%", gap: HOME_GAP },
    empty: {
      paddingHorizontal: 16,
      paddingBottom: 12,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoalMuted,
    },
    hint: {
      paddingHorizontal: 16,
      paddingBottom: 4,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoalMuted,
    },
    divided: { borderTopWidth: 1, borderTopColor: c.gray100 },
    assignedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 8,
      minHeight: 56,
    },
    rowPressed: { backgroundColor: c.gray50 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    glyph: { fontSize: 22, lineHeight: 26, flexShrink: 0 },
    rowBody: { flex: 1, minWidth: 0, gap: 2 },
    meta: {
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 17,
      color: c.charcoalSubtle,
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 16,
      lineHeight: 22,
      color: c.charcoal,
    },
    cta: { flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 },
    ctaText: { fontFamily: fonts.semibold, fontSize: 13, color: c.violet },
    ctaCaret: { fontFamily: fonts.bold, fontSize: 16, lineHeight: 18, color: c.violet },
    closeOutRow: { paddingHorizontal: 16, paddingVertical: 12 },
    busy: { opacity: 0.6 },
    pair: { flexDirection: "row", gap: 8, alignItems: "stretch", marginTop: 12 },
    button: {
      flex: 1,
      minHeight: TOUCH,
      borderRadius: 10,
      paddingHorizontal: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonPrimary: { backgroundColor: c.violetSolid },
    buttonPrimaryText: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: c.white,
      textAlign: "center",
    },
    buttonSecondary: { borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
    buttonSecondaryText: {
      fontFamily: fonts.semibold,
      fontSize: 15,
      color: c.charcoal,
      textAlign: "center",
    },
    pressed: { opacity: 0.8 },
    resolvedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 8,
      minHeight: 52,
    },
    resolvedText: {
      flex: 1,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoalSubtle,
    },
    undo: {
      minHeight: TOUCH,
      minWidth: TOUCH,
      paddingHorizontal: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    undoText: { fontFamily: fonts.semibold, fontSize: 14, color: c.violet },
  });
}
