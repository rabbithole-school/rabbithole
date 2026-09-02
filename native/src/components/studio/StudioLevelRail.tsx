/**
 * The native level rail — chrome that changes rarely (a level switch is one
 * bridge hop per tap), so it gets native touch feel instead of living inside
 * the WebView document.
 *
 * 11 puzzle levels grouped into 3 rungs (the 3 teaching sessions), plus a
 * trailing "Art" section. Every level is always tappable — these are gifted
 * kids in a 90-minute session; a locked level is an insult and a support
 * call, so there is no gating and no progression wall here. The rung
 * grouping is a caption, not a barrier: a small uppercase section label
 * (the native ALL-CAPS-eyebrow convention), never a lock icon or greyed-out
 * row.
 *
 * Deliberately NOT here: a "change the world" control. Rolling a new world is
 * a move made in the run loop — solve it, then press 🎲 and run the same
 * program against a world you've never seen — and the sandbox's own verdict
 * text already names that button, eighteen pixels from Run. A second copy at
 * the rail edge would be a second answer to a signal that already has a
 * canonical rendering. The rail is which level you're on and how far you've
 * got; everything you do to a running program is the sandbox's.
 *
 * Per `.claude/rules/visual-design.md`: "solved" is a small pip, not an
 * edge-only accent stripe; the active row gets a full-row tint (not a border
 * stripe) since that's a legitimate single-region highlight, not decoration
 * riding the edge of an otherwise-plain row.
 */
import { Fragment, useCallback, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import * as Haptics from "expo-haptics";

import { fonts, useColors } from "@/theme";
// NOTE: not yet vendored to native/vendor/shared/ at the time this screen was
// built — see the report for the exact vendor-manifest entry needed.
import type { StudioLevel, StudioRung } from "../../../vendor/shared/studioContract";

const RUNG_LABELS: Record<StudioRung, string> = {
  1: "Session 1",
  2: "Session 2",
  3: "Session 3",
};

export interface StudioLevelRailProps {
  levels: readonly StudioLevel[];
  activeLevelId: string | undefined;
  solvedLevelIds: ReadonlySet<string>;
  orientation: "vertical" | "horizontal";
  onSelectLevel: (levelId: string) => void;
}

export function StudioLevelRail({
  levels,
  activeLevelId,
  solvedLevelIds,
  orientation,
  onSelectLevel,
}: StudioLevelRailProps) {
  const colors = useColors();
  const horizontal = orientation === "horizontal";

  const rungs = useMemo(() => {
    const puzzle = levels.filter((level) => level.mode === "puzzle");
    const art = levels.filter((level) => level.mode === "art");
    const groups: Array<{ label: string; levels: StudioLevel[] }> = ([1, 2, 3] as StudioRung[])
      .map((rung) => ({
        label: RUNG_LABELS[rung],
        levels: puzzle.filter((level) => level.rung === rung),
      }))
      .filter((group) => group.levels.length > 0);
    if (art.length > 0) groups.push({ label: "Art", levels: art });
    return groups;
  }, [levels]);

  return (
    <View style={[styles.root, horizontal ? styles.rootHorizontal : styles.rootVertical, { backgroundColor: colors.bgSubtle }]}>
      <ScrollView
        horizontal={horizontal}
        showsVerticalScrollIndicator={!horizontal}
        showsHorizontalScrollIndicator={horizontal}
        contentContainerStyle={[styles.content, horizontal ? styles.contentHorizontal : styles.contentVertical]}
      >
        {rungs.map((group) => (
          <Fragment key={group.label}>
            <Text
              style={[
                styles.rungLabel,
                { color: colors.fgMuted },
                horizontal ? styles.rungLabelHorizontal : undefined,
              ]}
            >
              {group.label.toUpperCase()}
            </Text>
            <View style={horizontal ? styles.rowGroupHorizontal : undefined}>
              {group.levels.map((level) => (
                <LevelChip
                  key={level.id}
                  level={level}
                  active={level.id === activeLevelId}
                  solved={solvedLevelIds.has(level.id)}
                  onPress={onSelectLevel}
                  horizontal={horizontal}
                />
              ))}
            </View>
          </Fragment>
        ))}
      </ScrollView>
    </View>
  );
}

function LevelChip({
  level,
  active,
  solved,
  onPress,
  horizontal,
}: {
  level: StudioLevel;
  active: boolean;
  solved: boolean;
  onPress: (levelId: string) => void;
  horizontal: boolean;
}) {
  const colors = useColors();
  const handlePress = useCallback(() => {
    void Haptics.selectionAsync();
    onPress(level.id);
  }, [level.id, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      // Without an explicit label iOS synthesizes one by concatenating the
      // chip's children, so VoiceOver announces "Go, walk straight ahead"
      // as one run-on string and the chip has no stable identity. Title as
      // the label and idea as the hint is the honest split: what it is,
      // then what it teaches.
      accessibilityLabel={level.title}
      accessibilityHint={level.idea || undefined}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.chip,
        horizontal ? styles.chipHorizontal : undefined,
        {
          backgroundColor: active ? colors.violetSubtle : colors.bg,
          borderColor: active ? colors.violetSolid : colors.border,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <View style={styles.chipTextWrap}>
        <Text style={[styles.chipTitle, { color: colors.fg }]} numberOfLines={1}>
          {level.title}
        </Text>
        {level.idea ? (
          <Text style={[styles.chipIdea, { color: colors.fgMuted }]} numberOfLines={1}>
            {level.idea}
          </Text>
        ) : null}
      </View>
      {solved ? (
        <View style={[styles.solvedPip, { backgroundColor: colors.statusGreen }]} />
      ) : null}
    </Pressable>
  );
}

const CHIP_MIN_HEIGHT = 48; // ≥44pt touch target

const styles = StyleSheet.create({
  root: {},
  rootVertical: {
    width: 160,
  },
  rootHorizontal: {
    height: 96,
    flexDirection: "row",
    alignItems: "center",
  },
  content: {
    gap: 6,
  },
  contentVertical: {
    padding: 10,
    paddingBottom: 4,
  },
  contentHorizontal: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    gap: 12,
  },
  rowGroupHorizontal: {
    flexDirection: "row",
    gap: 6,
  },
  rungLabel: {
    fontFamily: fonts.bold,
    fontSize: 11,
    letterSpacing: 1.2,
    marginTop: 10,
    marginBottom: 4,
  },
  rungLabelHorizontal: {
    marginTop: 0,
    marginBottom: 0,
    marginRight: 2,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: CHIP_MIN_HEIGHT,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  chipHorizontal: {
    width: 150, // fixed, so text truncates predictably in a scrolling row
  },
  chipTextWrap: {
    flex: 1,
  },
  chipTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
  },
  chipIdea: {
    fontFamily: fonts.regular,
    fontSize: 12,
    marginTop: 1,
  },
  solvedPip: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
