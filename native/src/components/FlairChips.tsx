import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, Text, View } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
} from "react-native-reanimated";
import {
  Button as SwiftUIButton,
  Host,
  Popover,
  Text as SwiftUIText,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityHint,
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  tint,
} from "@expo/ui/swift-ui/modifiers";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import { flairChipDelayMs } from "../../vendor/shared/flairMotion";
import { useFlairArrivals } from "../../vendor/shared/useFlairArrivals";

export type FlairEarned = {
  criterionId: string;
  earnedAt: number;
  /** Scholar-facing sentence about the work that earned this mark. */
  note?: string;
};

export type FlairChipsProps = {
  /** The permanent flair awarded on this specific deliverable. */
  flairEarned?: FlairEarned[];
  /** The active deliverable's criteria, including auto-generated snapshots. */
  criteria: Array<{ id: string; label: string; description?: string }>;
  /** True once the deliverable query behind `flairEarned` has answered — a
   *  deliverable with no flair yet has the field ABSENT, so `undefined` alone
   *  cannot tell "still loading" (baselining now would replay the session's
   *  existing flair) from "resolved, nothing earned yet" (baselining now is
   *  exactly right, and skipping it swallows the first award on every
   *  deliverable). Required so a new call site has to answer the question. */
  resolved: boolean;
  /** Whether a newly arriving chip may play its entrance. */
  animateArrivals?: boolean;
  /** Enriches the immediate initial fallback with art scoped to this deliverable. */
  deliverableId?: Id<"deliverables"> | null;
};

/**
 * The chip's spring: ζ ≈ 0.76, so it overshoots ~2.4% and settles in ~290 ms —
 * deliberately under the "boing" threshold, and close enough to the web
 * keyframe that the two surfaces read as the same event.
 */
const CHIP_SPRING = { mass: 0.8, stiffness: 260, damping: 22 } as const;

/**
 * Native twin of the web `FlairChips`. The current native popover stays in
 * charge of the 44px touch target while the generated Bold mark overlays its
 * visual. The complete 36px initial mark is present before art loads or if art
 * generation fails.
 *
 * A criterion earned while this instance is mounted springs in on a fixed delay,
 * just after the transcript notice that announced it has settled. Flair that was
 * already there when the instance mounted is static, forever.
 */
export function FlairChips({
  flairEarned,
  criteria,
  resolved,
  animateArrivals = true,
  deliverableId,
}: FlairChipsProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const colors = useColors();
  const art = useQuery(
    api.flairArt.forDeliverable,
    deliverableId ? { deliverableId } : "skip",
  );
  // Baseline off the raw earned ids, not the rendered chips: criteria and the
  // generated art can resolve after the deliverable does, and baselining on what
  // happens to be renderable would replay every existing award when they land.
  const arriving = useFlairArrivals(
    resolved ? (flairEarned ?? []).map((flair) => flair.criterionId) : undefined,
  );

  if (!flairEarned || flairEarned.length === 0) return null;

  const criterionById = new Map(
    criteria.map((criterion) => [criterion.id, criterion]),
  );
  const artByCriterionId = new Map(
    (art ?? []).map((item) => [item.criterionId, item]),
  );
  const chips = flairEarned.flatMap((flair) => {
    const criterion = criterionById.get(flair.criterionId);
    if (!criterion) return [];
    const generated = artByCriterionId.get(flair.criterionId);
    return [
      {
        key: flair.criterionId,
        label: criterion.label,
        // The criterion's `description` is GRADER-facing rubric text (the
        // criteria generator calls it "a private map for the AI tutor"), and
        // teacher/bot-authored rubrics phrase it as FULL/HALF/NOT instructions.
        // The scholar reads the awarding note instead — the one sentence about
        // their own work — and nothing at all when there isn't one.
        note: flair.note ?? generated?.note,
        initial: generated?.initial ?? flairInitial(criterion.label),
        imageUrl: generated?.imageUrl ?? null,
      },
    ];
  });

  if (chips.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {chips.map((chip) => {
        const arrivingIndex = animateArrivals ? arriving.indexOf(chip.key) : -1;
        return (
          <FlairChip
            key={chip.key}
            label={chip.label}
            note={chip.note}
            initial={chip.initial}
            imageUrl={chip.imageUrl}
            colors={colors}
            open={openKey === chip.key}
            onToggle={() =>
              setOpenKey((current) => (current === chip.key ? null : chip.key))
            }
            onDismiss={() =>
              setOpenKey((current) => (current === chip.key ? null : current))
            }
            enterDelayMs={
              arrivingIndex >= 0 ? flairChipDelayMs(arrivingIndex) : null
            }
          />
        );
      })}
    </View>
  );
}

/**
 * One chip. The entrance animates the Reanimated wrapper AROUND the SwiftUI
 * `Host` and the mark overlaid on it, never the SwiftUI layout itself: opacity +
 * transform on the UI thread, so the host never re-measures and the row never
 * reflows.
 */
function FlairChip({
  label,
  note,
  initial,
  imageUrl,
  colors,
  open,
  onToggle,
  onDismiss,
  enterDelayMs,
}: {
  label: string;
  note: string | undefined;
  initial: string;
  imageUrl: string | null;
  colors: ReturnType<typeof useColors>;
  open: boolean;
  onToggle: () => void;
  onDismiss: () => void;
  /** Null when this chip was already earned — it paints settled and stays put. */
  enterDelayMs: number | null;
}) {
  const reduceMotion = useReducedMotion();
  // Read once: a chip decides how it arrives when it mounts, and a later award
  // must not restart or cancel an entrance already in flight.
  const [entrance] = useState(() =>
    enterDelayMs !== null && !reduceMotion ? enterDelayMs : null,
  );
  const progress = useSharedValue(entrance === null ? 1 : 0);

  useEffect(() => {
    if (entrance === null) return;
    // `.get()`/`.set()` is the compiler-compliant shared-value API this repo
    // uses — a bare `.value =` makes the React Compiler bail out of the chip.
    progress.set(withDelay(entrance, withSpring(1, CHIP_SPRING)));
  }, [entrance, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [
      { translateY: (1 - progress.get()) * 6 },
      { scale: 0.88 + progress.get() * 0.12 },
    ],
  }));

  return (
    <Reanimated.View style={[styles.touchTarget, animatedStyle]}>
      <Host matchContents>
        <Popover
          isPresented={open}
          attachmentAnchor="top"
          arrowEdge="bottom"
          onIsPresentedChange={(isPresented) => {
            if (!isPresented) onDismiss();
          }}
        >
          <Popover.Trigger>
            <SwiftUIButton
              onPress={onToggle}
              modifiers={[
                buttonStyle("bordered"),
                buttonBorderShape("roundedRectangle", 12),
                controlSize("large"),
                tint(colors.charcoalMuted),
                frame({ minWidth: 44, minHeight: 44 }),
                accessibilityLabel(`Flair earned: ${label}`),
                accessibilityHint("Shows the Flair details"),
              ]}
            >
              <SwiftUIText modifiers={[font({ size: 1 })]}> </SwiftUIText>
            </SwiftUIButton>
          </Popover.Trigger>
          <Popover.Content>
            <VStack
              alignment="leading"
              spacing={4}
              modifiers={[frame({ maxWidth: 280 }), padding()]}
            >
              <SwiftUIText
                modifiers={[font({ family: fonts.semibold, size: 14 })]}
              >
                {label}
              </SwiftUIText>
              {note ? (
                <SwiftUIText
                  modifiers={[
                    font({ family: fonts.regular, size: 13 }),
                    foregroundStyle(colors.charcoalMuted),
                    lineLimit(),
                    fixedSize({ horizontal: false, vertical: true }),
                  ]}
                >
                  {note}
                </SwiftUIText>
              ) : null}
            </VStack>
          </Popover.Content>
        </Popover>
      </Host>
      <View pointerEvents="none" style={styles.markOverlay}>
        <FlairMark imageUrl={imageUrl} initial={initial} label={label} />
      </View>
    </Reanimated.View>
  );
}

export function FlairMark({
  imageUrl,
  initial,
  label,
}: {
  imageUrl: string | null;
  initial: string;
  label: string;
}) {
  const reduceMotion = useReducedMotion();
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const imageLoaded = imageUrl !== null && loadedUrl === imageUrl;

  return (
    <View
      style={styles.mark}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.initialMark, imageLoaded && styles.hidden]}>
        <LinearGradient
          colors={["#FFC64D", "#FFC64D", "#FF6B57", "#FF6B57"]}
          locations={[0, 0.499, 0.501, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Text style={styles.initialText}>{initial}</Text>
      </View>
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          contentFit="contain"
          transition={reduceMotion ? 0 : 220}
          alt={label}
          onLoad={() => setLoadedUrl(imageUrl)}
          onError={() => setLoadedUrl(null)}
          style={[styles.art, !imageLoaded && styles.hidden]}
        />
      ) : null}
    </View>
  );
}

function flairInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?";
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  touchTarget: {
    position: "relative",
    width: 44,
    height: 44,
  },
  markOverlay: {
    position: "absolute",
    left: 4,
    top: 4,
    zIndex: 1,
  },
  mark: {
    width: 36,
    height: 36,
    position: "relative",
  },
  initialMark: {
    ...StyleSheet.absoluteFill,
    overflow: "hidden",
    borderWidth: 3,
    borderColor: "#17171C",
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  initialText: {
    fontFamily: fonts.bold,
    fontSize: 16,
    lineHeight: 19,
    color: "#17171C",
  },
  art: {
    ...StyleSheet.absoluteFill,
    width: 36,
    height: 36,
  },
  hidden: {
    opacity: 0,
  },
});
