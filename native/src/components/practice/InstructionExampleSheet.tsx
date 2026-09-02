/**
 * InstructionExampleSheet (native) — the "See an example" idea shelf, the RN
 * twin of web `components/practice/InstructionExampleSheet.tsx`
 * (#native-idea-shelf-parity). A scholar who skipped the Launchpad ("Try it
 * myself") — or a Launchpad-less native run altogether — can pull the SAME
 * strand-level worked example up on demand, from the quiet "Example" pill in
 * the practice help row (`PracticeHelpRow` in `native/src/app/practice.tsx`).
 *
 * This is the pedagogy-#1/#2 guarantee that skipping is never a trap: the
 * explanation is always one tap away for any item whose strand has verified
 * content (resolved by `instruction.instructionContentForSkill`, the SAME
 * query web reads). Opening it records a NON-terminal `retrieval` (source
 * `idea_shelf`) — pure telemetry, never a deficit signal, never a
 * mastery/credit effect.
 *
 * Native has no teacher-rehearsal (`?remote=`) mode (practice.tsx), so unlike
 * the web sheet this component has no `logRetrieval`/`allowGeneration`
 * write-cap props — every native scholar sitting is live, so the retrieval log
 * and the "Show me another" generation are always on.
 *
 * Scope note (2026-08-07): web also offers this SAME sheet a second way in —
 * a "See an example" link under a miss (`source: "post_miss"`), plus a
 * further "Learn this from the start" node-first escalation once that's
 * showing. Those are a deliberate v1 cut here: this port covers the
 * persistent idea-shelf pill (the gap `TODO.html#native-idea-shelf-parity`
 * names), not the post-miss beat. Flagged explicitly, not silently dropped.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAction, useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { fonts, palette, useColors, type Colors } from "@/theme";
import { LaunchpadAtoms } from "@/components/practice/LaunchpadContent";
import type { InstructionAtom } from "../../../vendor/practice/instructionEntries";

type WorkedExampleAtom = Extract<InstructionAtom, { kind: "worked_example" }>;

/** Cap on-demand generations per sheet-open — same floor as web
 *  (components/practice/InstructionExampleSheet.tsx), which the server-side
 *  `generateAnotherWorkedExample` avoid-prompts budget is sized around. */
const MAX_GENERATIONS = 6;

export type InstructionExampleContent = {
  key: string;
  title: string;
  subtitle?: string;
  atoms: InstructionAtom[];
};

export function InstructionExampleSheet({
  open,
  onClose,
  scholarId,
  skillKey,
  content,
}: {
  open: boolean;
  onClose: () => void;
  scholarId: Id<"users">;
  /** nodeKey of the served item, so we can generate another example for its strand. */
  skillKey: string;
  content: InstructionExampleContent | null;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const recordRetrieval = useMutation(api.instruction.recordInstructionRetrieval);
  const generateAnother = useAction(api.practiceGen.generateAnotherWorkedExample);
  const loggedForRef = useRef<string | null>(null);

  // On-demand "Show me another" state — a transient worked_example that swaps in
  // for the canonical one, the prompts already seen (so we never repeat), and
  // the loading/error/cap bookkeeping. Mirrors web exactly.
  const [override, setOverride] = useState<WorkedExampleAtom | null>(null);
  const [seenPrompts, setSeenPrompts] = useState<string[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [genCount, setGenCount] = useState(0);

  // Reset the on-demand example whenever the sheet (re)opens or the strand
  // changes, seeding "seen" with the canonical example so we never regenerate
  // it. Done during render (React's endorsed "adjust state on prop change"
  // pattern), same as web, so there is no extra render pass.
  const [resetToken, setResetToken] = useState<string | null>(null);
  const token = `${content?.key ?? ""}:${open ? "open" : "closed"}`;
  if (resetToken !== token) {
    setResetToken(token);
    setOverride(null);
    setMoreError(null);
    setGenCount(0);
    const basePrompt = content?.atoms.find(
      (a): a is WorkedExampleAtom => a.kind === "worked_example",
    )?.examplePrompt;
    setSeenPrompts(basePrompt ? [basePrompt] : []);
  }

  // Log a retrieval once per open (keyed by content key, so reopening for a
  // different strand logs again, but a re-render of the same open sheet does
  // not).
  useEffect(() => {
    if (!open || !content) return;
    if (loggedForRef.current === content.key) return;
    loggedForRef.current = content.key;
    void recordRetrieval({ scholarId, key: content.key, source: "idea_shelf" }).catch(() => {});
  }, [open, content, scholarId, recordRetrieval]);

  useEffect(() => {
    if (!open) loggedForRef.current = null;
  }, [open]);

  // The atoms actually shown: the canonical content, with its worked_example
  // swapped for the freshly generated one when the scholar asked for another.
  const displayAtoms = useMemo<InstructionAtom[]>(() => {
    if (!content) return [];
    if (!override) return content.atoms;
    let replaced = false;
    return content.atoms.map((a) => {
      if (a.kind === "worked_example" && !replaced) {
        replaced = true;
        return override;
      }
      return a;
    });
  }, [content, override]);

  const hasWorkedExample = useMemo(
    () => (content?.atoms ?? []).some((a) => a.kind === "worked_example"),
    [content],
  );
  const atCap = genCount >= MAX_GENERATIONS;

  const onAnother = async () => {
    if (!content || loadingMore || atCap) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await generateAnother({ scholarId, skillKey, avoidPrompts: seenPrompts });
      if (!next) {
        setMoreError("Couldn't make a fresh one just now — try again.");
        return;
      }
      setOverride(next);
      setSeenPrompts((prev) => [...prev, next.examplePrompt].filter(Boolean));
      setGenCount((n) => n + 1);
    } catch {
      setMoreError("Something went wrong — try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 18) }]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>Here&apos;s the idea</Text>
              <Text style={styles.title}>{content?.title ?? "See an example"}</Text>
              {content?.subtitle ? <Text style={styles.subtitle}>{content.subtitle}</Text> : null}
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.closeBtn}
            >
              <Text style={styles.closeGlyph}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            {content ? (
              <>
                <LaunchpadAtoms atoms={displayAtoms} />
                {hasWorkedExample ? (
                  <View style={styles.anotherBlock}>
                    {moreError ? <Text style={styles.errorText}>{moreError}</Text> : null}
                    <Pressable
                      onPress={() => void onAnother()}
                      disabled={loadingMore || atCap}
                      style={({ pressed }) => [
                        styles.anotherBtn,
                        (loadingMore || atCap) && styles.anotherBtnDisabled,
                        pressed && { opacity: 0.85 },
                      ]}
                      accessibilityRole="button"
                    >
                      {loadingMore ? <ActivityIndicator size="small" color={colors.teal} /> : null}
                      <Text style={styles.anotherBtnText}>
                        {loadingMore
                          ? "Thinking of another…"
                          : atCap
                            ? "That's plenty of examples for now"
                            : "Show me another"}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </>
            ) : (
              <Text style={styles.emptyText}>No example is available for this one yet.</Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    overlay: { flex: 1, justifyContent: "flex-end" },
    backdrop: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(8, 13, 30, 0.42)",
    },
    sheet: {
      width: "100%",
      maxHeight: "82%",
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: palette.navy[900],
      shadowOpacity: 0.22,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: -4 },
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 10,
    },
    headerText: { flex: 1, paddingRight: 12 },
    eyebrow: {
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 0.7,
      textTransform: "uppercase",
      color: c.teal,
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 20,
      lineHeight: 25,
      color: c.fg,
      marginTop: 4,
    },
    subtitle: {
      fontFamily: fonts.regular,
      fontSize: 14,
      color: c.fgMuted,
      marginTop: 2,
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
    },
    closeGlyph: { fontSize: 16, color: c.charcoalSubtle },
    body: { paddingHorizontal: 20 },
    bodyContent: { paddingBottom: 24, gap: 16 },
    emptyText: {
      fontFamily: fonts.regular,
      fontSize: 14,
      color: c.fgMuted,
      textAlign: "center",
      paddingVertical: 24,
    },
    anotherBlock: { gap: 8 },
    errorText: { fontFamily: fonts.regular, fontSize: 13, color: "#b4552d" },
    anotherBtn: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 8,
      borderWidth: 1,
      borderColor: c.cyanSubtle,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    anotherBtnDisabled: { opacity: 0.6 },
    anotherBtnText: { fontFamily: fonts.semibold, fontSize: 13.5, color: c.teal },
  });
}
