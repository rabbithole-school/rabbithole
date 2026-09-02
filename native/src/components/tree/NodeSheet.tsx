// NodeSheet — the tap bottom sheet for a Tree node. Mirrors StarDrawer's
// animation / backdrop / sheet styling, but on the Tree's LIGHT "paper" theme
// (white card, dark text) instead of the night-sky palette. Scholar-facing and
// scholar-redacted (the VM is already redacted upstream — this adds NO new data
// reads): a plain-language mastery read, the dial, an optional depth row, and a
// "Practice this" CTA that routes into /practice for this exact node.

import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
} from "react-native-reanimated";

import { palette } from "@/theme";
import { MASTERY_LABELS } from "../../../vendor/shared/masteryLexicon";
import {
  strandHeadline,
  strandHeadlineFor,
} from "../../../vendor/shared/practiceDomainLabels";
import type { MasteryState, TreeNodeVM } from "../../../vendor/shared/treeMapLayout";
import { TreeDial } from "./treeGlyphs";
import { NodeNeighbourhood } from "./NodeNeighbourhood";
import { canPracticeNode } from "./nodeSheetState";
import type { NodeNeighbourhood as NodeNeighbourhoodData } from "./treeNeighbourhood";

/** Plain-language mastery read (no scores / streaks — scholar-facing).
 *  "locked" is a reachability fact (prereqs unmet), not a proficiency band —
 *  it keeps its own sentence instead of borrowing the lexicon's not_started. */
function masteryLine(m: MasteryState): string {
  switch (m) {
    case "locked":
      return "Not unlocked yet";
    case "frontier":
      return `On your frontier — ${MASTERY_LABELS.practicing} now`;
    case "placed":
      // Provisional (inferred credit) — deliberately NOT the bare word "fluent".
      return "Placed at this level — practice to prove it";
    case "struggling":
      // Teacher/parent-only red state — the server redacts it from a scholar's
      // OWN map, so this scholar-facing native sheet should never receive it.
      // Defensive fallback: show the neutral frontier line, never a deficit mark.
      return `On your frontier — ${MASTERY_LABELS.practicing} now`;
    case "fluent":
    case "overlearned": {
      const label = MASTERY_LABELS[m];
      return label[0].toUpperCase() + label.slice(1);
    }
  }
}

type Props = {
  node: TreeNodeVM | null;
  /** Whether this node's domain still needs placement (the pre-test). When true,
   *  routing into /practice lands on a placement check-in, not practice — so we
   *  suppress the CTA. `undefined` = still loading (treated as "not yet known"). */
  domainNeedsPlacement?: boolean;
  neighbourhood?: NodeNeighbourhoodData | undefined;
  onDismiss: () => void;
  onNavigate: (nodeKey: string) => void;
};

export function NodeSheet({
  node,
  domainNeedsPlacement,
  neighbourhood,
  onDismiss,
  onNavigate,
}: Props) {
  const insets = useSafeAreaInsets();

  // Declarative mount/unmount animation (reanimated layout animations): spring in
  // from the bottom + fade the backdrop; slide/fade out on removal. This keeps
  // the exiting content mounted through the close for free — no effects, no
  // imperative shared-value mutation, no setState (StarDrawer's imperative
  // variant trips the React-Compiler lint rules; this is the effect-free port).
  if (!node) return null;

  const domainLabel = node.domainLabel ?? node.domain ?? "";
  const strand = node.strand
    ? node.domain
      ? strandHeadlineFor(node.domain, node.strand)
      : strandHeadline(node.strand)
    : "";
  const secondary = [domainLabel, strand].filter(Boolean).join(" · ");
  const depthPct = Math.round(Math.max(0, Math.min(1, node.depth)) * 100);

  // A "locked" node is a reachability fact: its prerequisites aren't met yet. A
  // node whose whole DOMAIN hasn't been pre-tested is a separate case — and note
  // a domain's ROOT node reads as `frontier` (no prereqs), NOT `locked`, even
  // with zero mastery rows, so the mastery band alone can't catch it. In BOTH
  // cases routing into /practice would silently drop the scholar into that
  // domain's placement check-in ("MATH CHECK-IN") rather than practice, which
  // contradicts the sheet's own read. So only show the CTA for a node whose
  // domain is placed (`domainNeedsPlacement === false`) and isn't locked.
  const isLocked = node.mastery === "locked";
  const canPractice = canPracticeNode(
    node.mastery,
    domainNeedsPlacement,
    neighbourhood?.node.practiceServeable,
  );

  const practice = () => {
    const domain = node.domain;
    onDismiss();
    router.push({
      pathname: "/practice",
      params: {
        skill: node.nodeKey,
        ...(domain ? { domain } : {}),
      },
    });
  };

  return (
    <>
      {/* Backdrop — tap to dismiss */}
      <Animated.View
        entering={FadeIn.duration(220)}
        exiting={FadeOut.duration(190)}
        style={[StyleSheet.absoluteFill, styles.backdrop]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onDismiss}
          accessibilityLabel="Dismiss skill details"
        />
      </Animated.View>

      {/* Sheet */}
      <Animated.View
        entering={SlideInDown.springify().damping(32).stiffness(380).mass(0.85)}
        exiting={SlideOutDown.duration(190).easing(Easing.in(Easing.cubic))}
        style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}
        accessibilityLabel={`${node.label}. ${masteryLine(node.mastery)}`}
      >
        <View>
          <View style={styles.grabber} />

          {secondary ? <Text style={styles.eyebrow}>{secondary.toUpperCase()}</Text> : null}
          <Text style={styles.title}>{node.label}</Text>

          {/* Dial + plain-language mastery read */}
          <View style={styles.masteryRow}>
            <TreeDial
              size={44}
              mastery={node.mastery}
              automaticity={node.automaticity}
              depth={node.depth}
            />
            <Text style={styles.masteryText}>{masteryLine(node.mastery)}</Text>
          </View>

          {/* Optional depth row — kept simple (no arc-semantics explainer). */}
          {node.depth > 0 ? (
            <View style={styles.depthRow}>
              <Text style={styles.depthLabel}>DEPTH</Text>
              <Text style={styles.depthValue}>{depthPct}%</Text>
            </View>
          ) : null}

          <NodeNeighbourhood data={neighbourhood} onNavigate={onNavigate} />

          {/* CTA — dismiss, then route into practice for this exact node.
              Only a practicable node (placed domain, not locked) gets the live
              button; everything else gets a plain-language, anti-deficit note
              instead of routing into a surprise check-in. While placement status
              is still loading we render neither (avoids flashing a misleading
              button that a fast tap could follow into a check-in). */}
          {canPractice ? (
            <Pressable
              onPress={practice}
              style={({ pressed }) => [styles.cta, pressed && { opacity: 0.82 }]}
              accessibilityRole="button"
              accessibilityLabel={`Practice ${node.label}`}
            >
              <Text style={styles.ctaText}>Practice this  ›</Text>
            </Pressable>
          ) : isLocked ? (
            <View style={styles.lockedNote}>
              <Text style={styles.lockedNoteText}>
                This unlocks as you master the skills that come before it.
              </Text>
            </View>
          ) : domainNeedsPlacement === true ? (
            <View style={styles.lockedNote}>
              <Text style={styles.lockedNoteText}>
                {"You'll open this area with a quick check-in first."}
              </Text>
            </View>
          ) : null}
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.38)" },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: palette.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 28,
    paddingTop: 14,
    maxWidth: 720,
    alignSelf: "center",
    width: "100%",
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.gray[300],
    marginBottom: 20,
  },
  eyebrow: {
    fontSize: 12,
    fontFamily: "HankenGrotesk_700Bold",
    letterSpacing: 1.1,
    color: palette.charcoal[400],
    marginBottom: 8,
  },
  title: {
    fontSize: 27,
    lineHeight: 33,
    color: palette.charcoal[500],
    fontFamily: "HankenGrotesk_700Bold",
    marginBottom: 16,
  },
  masteryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 18,
  },
  masteryText: {
    flexShrink: 1,
    fontSize: 18,
    lineHeight: 24,
    color: palette.charcoal[500],
    fontFamily: "HankenGrotesk_600SemiBold",
  },
  depthRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    backgroundColor: palette.gray[50],
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: "flex-start",
    marginBottom: 22,
  },
  depthLabel: {
    fontSize: 10,
    letterSpacing: 0.8,
    fontFamily: "HankenGrotesk_700Bold",
    color: palette.charcoal[300],
  },
  depthValue: {
    fontSize: 14,
    fontFamily: "HankenGrotesk_600SemiBold",
    color: "#5663c6", // indigo — the dial's depth flank colour
  },
  cta: {
    backgroundColor: palette.violet[500],
    borderRadius: 16,
    paddingVertical: 17,
    alignItems: "center",
  },
  ctaText: {
    color: palette.white,
    fontSize: 18,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
  lockedNote: {
    backgroundColor: palette.gray[50],
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  lockedNoteText: {
    color: palette.charcoal[400],
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    fontFamily: "HankenGrotesk_600SemiBold",
  },
});
