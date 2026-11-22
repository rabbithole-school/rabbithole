/**
 * DeliverableFooter — the "Check my work" action and the earned-flair row under
 * a scholar's deliverable. Presentational: the caller owns the state (busy,
 * criteria, the check itself) and hands it in.
 *
 * Two callers render the same footer so the iPad has ONE rendering of it (T1):
 * `DeliverablePanel` (chat-primary sessions) and `VibecodeScreen` (the app
 * builder, when the app IS the deliverable — TRA-519). Extracted verbatim from
 * the panel.
 *
 * Also home to the two pieces of criteria plumbing both callers need:
 * `criteriaFor` (which rubric the scholar is checked against) and
 * `useDeliverableSetup` (repair + retry of the auto-generated rubric).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { SymbolView } from "expo-symbols";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { api, type Id } from "@/lib/convex";
import { confirmFinishAndSend } from "@/lib/confirmFinishAndSend";
import { useQuestSession } from "@/lib/questSession";
import { fonts, useColors } from "@/theme";
import {
  FINISH_AND_SEND_ACCESSIBILITY_LABEL,
  FINISH_AND_SEND_LABEL,
} from "../../vendor/shared/finishAndSend";
import { FlairChips } from "./FlairChips";

export type Criterion = { id: string; label: string; description?: string };
export type DeliverableMode = "manual" | "auto" | "none";

export function criteriaFor(
  spec: { mode: DeliverableMode; criteria: Criterion[] },
  snapshot: { status: string | null; criteria: Criterion[] | null } | null,
): Criterion[] {
  if (spec.mode === "none") return [];
  if (spec.mode === "auto") {
    return snapshot?.status === "ready" && snapshot.criteria ? snapshot.criteria : [];
  }
  return spec.criteria;
}

/**
 * An auto-rubric that never got prepared (snapshot status still `null`) is
 * repaired once on mount; a failed repair, or the scholar's own retry, goes
 * through the same `ensureActivitySetup` mutation. `snapshotStatus` is
 * `undefined` while the snapshot query loads, `null` when no rubric was ever
 * prepared.
 */
export function useDeliverableSetup({
  sessionId,
  mode,
  snapshotStatus,
}: {
  sessionId: Id<"sessions">;
  mode: DeliverableMode | undefined;
  snapshotStatus: string | null | undefined;
}) {
  const ensureSetup = useMutation(api.sessions.ensureActivitySetup);
  const [setupRepairFailed, setSetupRepairFailed] = useState(false);

  useEffect(() => {
    if (mode !== "auto" || snapshotStatus !== null) return;
    void ensureSetup({ sessionId }).catch((error) => {
      console.warn("[deliverable-setup] repair failed", error);
      setSetupRepairFailed(true);
    });
  }, [mode, ensureSetup, sessionId, snapshotStatus]);

  const retry = async () => {
    await ensureSetup({ sessionId, retryErroredCriteria: true });
    setSetupRepairFailed(false);
  };

  return { setupRepairFailed, retry };
}

export type DeliverableFooterProps = {
  /** A photo is checked from its stored file; everything else from a document. */
  kind: "photo" | "text";
  /** `none` hands the work in without a rubric ("Finish and send", asked first). */
  mode: DeliverableMode;
  /** Hand in without checking, even if criteria are pending or failed. */
  finishOnly?: boolean;
  /** A leading control opts into a single row with horizontally scrolling flair. */
  leading?: React.ReactNode;
  /** Keys the flair row by the work being shown, so switching documents can
   *  never treat the other one's flair as arriving. */
  flairKey: string;
  flairEarned?: React.ComponentProps<typeof FlairChips>["flairEarned"];
  criteria: Criterion[];
  deliverableId?: React.ComponentProps<typeof FlairChips>["deliverableId"];
  /** The session whose spotted flair joins the strip. */
  sessionId: React.ComponentProps<typeof FlairChips>["sessionId"];
  /** The deliverable query has resolved (flair already there is static). */
  resolved: boolean;
  criteriaPending: boolean;
  criteriaFailed: boolean;
  /** The check can't run right now (tutor busy, or nothing written yet). */
  disabled: boolean;
  busy: boolean;
  onCheck: () => void;
  onRetry: () => void;
};

export function DeliverableFooter({
  kind,
  mode,
  finishOnly = false,
  leading,
  flairKey,
  flairEarned,
  criteria,
  deliverableId,
  sessionId,
  resolved,
  criteriaPending,
  criteriaFailed,
  disabled,
  busy,
  onCheck,
  onRetry,
}: DeliverableFooterProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const questSession = useQuestSession();
  const isPhoto = kind === "photo";
  const sendsWithoutCheck = finishOnly || (!isPhoto && mode === "none");
  const preparing = !finishOnly && criteriaPending;
  const failed = !finishOnly && criteriaFailed;
  const inline = leading != null;
  // The button swaps its navy fill for a light gray one whenever it is
  // unavailable — busy included. Derive that state ONCE so the spinner, the
  // symbol, and the label always share a foreground that reads on whichever
  // fill is actually painted (a white spinner on the gray fill was effectively
  // invisible).
  const unavailable = disabled || busy || preparing;
  const muted = !failed && unavailable;
  // Finishing is irreversible, so ask first.
  const press = failed
    ? onRetry
    : unavailable
      ? undefined
      : sendsWithoutCheck
        ? () => {
            void confirmFinishAndSend().then((finish) => {
              if (finish) onCheck();
            });
          }
        : onCheck;

  const flair = (
    <FlairChips
      key={flairKey}
      flairEarned={flairEarned}
      sessionId={sessionId}
      criteria={criteria}
      deliverableId={deliverableId}
      resolved={resolved}
    />
  );

  // A Quest's session hands in from the header's "I'm ready to show"
  // (TRA-720), so it never offers Finish and send here, nor while that is
  // still being looked up. Its flair stays; a check that hands nothing in
  // ("Check my work") would stay too.
  if (sendsWithoutCheck && questSession !== null) {
    return <View style={styles.flairOnly}>{flair}</View>;
  }

  return (
    <View style={[styles.footer, inline && styles.inlineFooter]}>
      {leading}
      {inline ? (
        <ScrollView
          horizontal
          style={styles.flairLane}
          contentContainerStyle={styles.flairContent}
          showsHorizontalScrollIndicator={false}
        >
          {flair}
        </ScrollView>
      ) : (
        flair
      )}
      <Pressable
        onPress={press}
        style={({ pressed }) => [
          styles.checkBtn,
          inline && styles.inlineCheckBtn,
          muted && styles.checkBtnDisabled,
          pressed && !unavailable && styles.checkBtnPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={
          failed
            ? isPhoto
              ? "Try preparing the photo check again"
              : "Try preparing the rubric check again"
            : sendsWithoutCheck
              ? FINISH_AND_SEND_ACCESSIBILITY_LABEL
              : "Check my work"
        }
        accessibilityState={{ disabled: !failed && unavailable }}
      >
        {busy || preparing ? (
          <ActivityIndicator color={muted ? colors.charcoalMuted : colors.white} />
        ) : failed || sendsWithoutCheck ? (
          <SymbolView
            name={failed ? "exclamationmark.triangle.fill" : "paperplane.fill"}
            size={17}
            tintColor={muted ? colors.charcoalMuted : colors.white}
          />
        ) : null}
        <Text style={[styles.checkBtnText, muted && styles.checkBtnTextDisabled]}>
          {failed
            ? "Try preparing check again"
            : preparing
              ? "Preparing check…"
              : sendsWithoutCheck
                ? FINISH_AND_SEND_LABEL
                : "Check my work"}
        </Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    footer: {
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      backgroundColor: c.white,
    },
    // No chrome around flair alone: with none earned yet it takes no room
    // but this bottom inset.
    flairOnly: {
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    inlineFooter: {
      flexDirection: "row",
      alignItems: "center",
    },
    flairLane: {
      flex: 1,
      height: 44,
    },
    flairContent: {
      alignItems: "center",
    },
    inlineCheckBtn: {
      flexShrink: 0,
      paddingHorizontal: 16,
    },
    checkBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: c.navy,
      paddingVertical: 12,
      borderRadius: 14,
    },
    checkBtnDisabled: {
      backgroundColor: c.gray100,
    },
    checkBtnPressed: {
      opacity: 0.82,
    },
    checkBtnText: {
      fontFamily: fonts.semibold,
      fontSize: 15,
      color: c.white,
    },
    checkBtnTextDisabled: {
      // Reads on the gray `checkBtnDisabled` fill in BOTH themes; the old
      // charcoalSubtle was ~2.3:1 on the light fill.
      color: c.charcoalMuted,
    },
  });
}
