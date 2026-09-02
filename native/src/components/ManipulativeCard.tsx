import { Component, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useQuery } from "convex/react";

import { api, type Doc, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import { NativeManipulative } from "./manipulatives/NativeManipulative";
import { parseStoredManipulativeArtifact } from "../../vendor/manipulative/validate";
import { isChallenge, type ManipulativeSpec } from "../../vendor/manipulative/types";

/**
 * The scholar session-screen HANDS-ON MODEL card (native inline).
 *
 * Sibling of GeoMapCard: when the session carries a `type: "manipulative"`
 * artifact (the tutor's `show_manipulative` tool made one), this renders it
 * inline via NativeManipulative — the SAME spec-driven renderer the practice
 * item host uses, but with purely local, EPHEMERAL state. A manipulative shown
 * mid-conversation is a thing to poke, not a graded submission: nothing here is
 * persisted, so the self-check is UI feel only. This is the native parity of the
 * web artifact panel's manipulative surface.
 *
 * Tolerant, like GeoMapCard's parse-null path: an unusable / wrong-version /
 * forward-compat spec renders NOTHING rather than a broken stage
 * (parseStoredManipulativeArtifact returns null; a renderer throw is caught and
 * swapped to null so one bad material can never RCTFatal the app and eject the
 * scholar from their session — the same blast-radius rule NativeManipulativeItem
 * follows).
 *
 * Multi-model switcher: when a session carries MORE than one manipulative (the
 * tutor referenced an earlier model and then put up another), a horizontal chip
 * switcher above the stage lets the scholar return to any of them — the SAME
 * tabs idiom DeliverableCard uses for its multiple text artifacts. The newest is
 * selected by default; an explicit selection persists until the artifact list
 * changes to exclude it, at which point it falls back to the newest.
 */
export function ManipulativeCard({ sessionId }: { sessionId: Id<"sessions"> }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const artifacts = useQuery(api.artifacts.getBySession, { sessionId });
  // All manipulative rows, newest first — the switcher order, and index 0 is the
  // default selection (the one the tutor just put up).
  const rows = useMemo(() => {
    return (artifacts ?? [])
      .filter(isManipulativeArtifact)
      .sort((a, b) => b._creationTime - a._creationTime);
  }, [artifacts]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const artifact = useMemo(() => {
    if (rows.length === 0) return null;
    // Derive the active row rather than syncing selectedId in an effect: a
    // stale pick (its artifact left the list) falls back to the newest here, so
    // there is no separate state to reset. The pick is deliberately sticky —
    // if the row vanished only transiently (a reactive-query flicker) and
    // returns, the scholar's selection is restored rather than lost.
    return rows.find((r) => r._id === selectedId) ?? rows[0];
  }, [rows, selectedId]);

  const stored = useMemo(
    () => (artifact ? parseStoredManipulativeArtifact(artifact.content) : null),
    [artifact],
  );

  if (!artifact || !stored) return null;

  const spec = stored.spec;
  const title = artifact.title?.trim() || "Hands-on model";
  const challenge = isChallenge(spec);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>HANDS-ON MODEL</Text>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.prompt}>{spec.prompt}</Text>
      </View>
      {rows.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabs}
        >
          {rows.map((row) => {
            const selected = row._id === artifact._id;
            return (
              <Pressable
                key={row._id}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setSelectedId(row._id);
                }}
                style={[styles.tab, selected && styles.tabSelected]}
              >
                <Text
                  style={[styles.tabText, selected && styles.tabTextSelected]}
                  numberOfLines={1}
                >
                  {row.title?.trim() || "Model"}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <ManipulativeStage
        key={artifact._id}
        artifactId={artifact._id}
        spec={spec}
        challenge={challenge}
        styles={styles}
      />
    </View>
  );
}

/**
 * The stage + optimistic self-check, split out so its EPHEMERAL local state is
 * reset by React on remount via `key={artifact._id}` — the tutor swapping in a
 * different manipulative gives a fresh, un-checked stage without syncing state
 * in an effect (react-compiler: no setState-in-effect cascade).
 *
 * `solved` tracks the live goal state; `verdict` is what we REVEAL, and only on
 * an explicit Done (mirrors the web <Manipulative> frame): any manipulation
 * resets it to "idle" so a scholar can't scrub into the green light. Local,
 * ephemeral, never a graded record.
 */
function ManipulativeStage({
  artifactId,
  spec,
  challenge,
  styles,
}: {
  artifactId: string;
  spec: ManipulativeSpec;
  challenge: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [solved, setSolved] = useState(false);
  const [verdict, setVerdict] = useState<"idle" | "correct" | "incorrect">("idle");
  const onSolvedChange = (next: boolean) => {
    setSolved(next);
    setVerdict("idle"); // any manipulation invalidates the last check — re-Done required
  };
  const check = () => setVerdict(solved ? "correct" : "incorrect");

  return (
    <>
      <View style={styles.stage}>
        <ManipulativeRendererBoundary artifactId={artifactId}>
          <NativeManipulative spec={spec} onSolvedChange={onSolvedChange} />
        </ManipulativeRendererBoundary>
      </View>
      {challenge ? (
        <View style={styles.checkRow}>
          <Text
            style={[
              styles.verdictText,
              verdict === "correct" && styles.verdictCorrect,
            ]}
          >
            {verdict === "correct"
              ? "That's it! ✓"
              : verdict === "incorrect"
                ? "Not yet — keep going"
                : "Set it up, then tap Done."}
          </Text>
          {verdict !== "correct" ? (
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                check();
              }}
              style={styles.doneButton}
            >
              <Text style={styles.doneButtonText}>Done</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/**
 * A manipulative artifact is flagged by `type: "manipulative"`. The generated
 * union may not yet carry it, so widen the access rather than compare against
 * the current literal union (same idiom as GeoMapCard's `isMapArtifact`).
 */
function isManipulativeArtifact(artifact: Doc<"artifacts">): boolean {
  return (artifact.type as string | undefined) === "manipulative";
}

/**
 * Catches a throw from the native manipulative renderer and renders nothing, so
 * one malformed material can't take the app (and the scholar's session) down.
 * Mirrors `ManipulativeRendererBoundary` in NativeManipulativeItem: on a managed
 * 1:1 iPad an uncaught render throw is RCTFatal -> abort(), not a redbox. Here
 * there is no WebView embed to fall back to (this is an ad-hoc, ungraded
 * surface), so the tolerant outcome is an empty card — consistent with the
 * parse-null path above.
 */
class ManipulativeRendererBoundary extends Component<
  { children: ReactNode; artifactId: string },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(
      `[manipulative] native renderer threw for artifact ${this.props.artifactId} — rendering nothing`,
      error,
    );
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(colors: ColorSet) {
  return StyleSheet.create({
    card: {
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      marginBottom: 12,
      overflow: "hidden",
      shadowColor: colors.navy,
      shadowOpacity: 0.06,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
    },
    header: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 10,
    },
    eyebrow: {
      fontSize: 11.5,
      letterSpacing: 0.4,
      fontFamily: fonts.bold,
      color: colors.teal,
      marginBottom: 2,
    },
    title: {
      fontSize: 16,
      fontFamily: fonts.bold,
      color: colors.navy,
    },
    prompt: {
      fontSize: 17,
      lineHeight: 22,
      fontFamily: fonts.bold,
      color: colors.navy,
      marginTop: 4,
    },
    tabs: {
      gap: 8,
      paddingHorizontal: 16,
      paddingBottom: 10,
    },
    tab: {
      maxWidth: 180,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 7,
      backgroundColor: colors.gray100,
    },
    tabSelected: {
      backgroundColor: colors.navy,
    },
    tabText: {
      fontFamily: fonts.semibold,
      fontSize: 13.5,
      color: colors.charcoalMuted,
    },
    tabTextSelected: {
      color: colors.white,
    },
    stage: {
      width: "100%",
      backgroundColor: colors.bgSubtle,
    },
    checkRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    verdictText: {
      flexShrink: 1,
      fontSize: 15,
      fontFamily: fonts.semibold,
      color: colors.charcoalMuted,
    },
    verdictCorrect: {
      color: colors.green,
    },
    doneButton: {
      borderRadius: 10,
      paddingHorizontal: 18,
      paddingVertical: 9,
      backgroundColor: colors.navy,
    },
    doneButtonText: {
      fontSize: 14,
      fontFamily: fonts.bold,
      color: colors.white,
    },
  });
}
