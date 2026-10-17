/**
 * ArtifactChipStrip — the native twin of the web ArtifactPanel's document
 * switcher (components/ArtifactPanel.tsx), rendered as a horizontal chip strip
 * rather than a dropdown (TRA-274). One chip per selectable artifact; the
 * active chip is a solid violet fill, idle chips are outlined. It only exists
 * when a session holds two or more artifacts — the caller renders nothing for
 * the one-artifact common case.
 *
 * The active fill is a filled pill (visual-design.md: no tab-indicator edge
 * styles / accent stripes). Each chip is a >= 44pt touch target and reports the
 * `tab` accessibility role with its selected state; the strip is a `tablist`.
 */
import { useMemo } from "react";
import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

import { fonts, useColors } from "@/theme";
import { type Doc, type Id } from "@/lib/convex";

export function ArtifactChipStrip({
  artifacts,
  activeArtifactId,
  onSelect,
}: {
  artifacts: readonly Doc<"artifacts">[];
  activeArtifactId: Id<"artifacts"> | null;
  onSelect: (id: Id<"artifacts">) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.strip}
      accessibilityRole="tablist"
    >
      {artifacts.map((artifact) => {
        const selected = artifact._id === activeArtifactId;
        const title = artifact.title || "Untitled";
        return (
          <Pressable
            key={artifact._id}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              onSelect(artifact._id);
            }}
            style={({ pressed }) => [
              styles.chip,
              selected ? styles.chipActive : styles.chipIdle,
              pressed && !selected && styles.chipPressed,
            ]}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={title}
          >
            <SymbolView
              name={chipIcon(artifact.type)}
              size={13}
              tintColor={selected ? colors.white : colors.charcoalMuted}
            />
            <Text
              style={[
                styles.chipText,
                selected ? styles.chipTextActive : styles.chipTextIdle,
              ]}
              numberOfLines={1}
            >
              {title}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function chipIcon(type: string | undefined): SymbolViewProps["name"] {
  // A code artifact is the session's app (AppCard), not source to read.
  return type === "code" ? "macwindow" : "doc.text";
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    strip: {
      flexDirection: "row",
      gap: 8,
      paddingVertical: 2,
      paddingRight: 4,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: 999,
    },
    chipActive: {
      backgroundColor: c.violetSolid,
    },
    chipIdle: {
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipPressed: {
      opacity: 0.82,
    },
    chipText: {
      fontFamily: fonts.semibold,
      fontSize: 13.5,
      maxWidth: 168,
    },
    chipTextActive: {
      color: c.white,
    },
    chipTextIdle: {
      color: c.charcoal,
    },
  });
}
