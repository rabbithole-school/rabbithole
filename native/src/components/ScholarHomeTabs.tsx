/**
 * ScholarHomeTabs — the pill row for the scholar Home:
 * Now · All · <subjects> · Other · Scholar’s Prep · Quests.
 * Native RN version (no Chakra/DOM). Scrollable horizontally for wide subject lists.
 * Invariant: no text below fontSize 14; even borders, no accent stripes.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { fonts, useColors } from "@/theme";
import type { ScholarHomeTab } from "../../vendor/shared/scholarHomeNow";

export function ScholarHomeTabs({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: ScholarHomeTab[];
  activeTab: string;
  onChange: (tab: string) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // Keep the active pill in view. A swipe (or a mid-day tab reshape) can change
  // the active tab to a pill that's scrolled off this horizontal row, so track
  // each pill's x-offset and scroll it back into view when the active tab
  // changes. This is presentation only — no indicator bar; the active pill's
  // own fill already encodes which tab is selected.
  const scrollRef = useRef<ScrollView>(null);
  const pillOffsets = useRef<Record<string, number>>({});
  useEffect(() => {
    const x = pillOffsets.current[activeTab];
    if (x === undefined) return;
    scrollRef.current?.scrollTo({ x: Math.max(0, x - 12), animated: true });
  }, [activeTab]);

  const renderTab = useCallback(
    (tab: ScholarHomeTab) => {
      const active = activeTab === tab.key;
      return (
        <Pressable
          key={tab.key}
          accessibilityRole="button"
          accessibilityState={{ selected: active }}
          onLayout={(e) => {
            pillOffsets.current[tab.key] = e.nativeEvent.layout.x;
          }}
          onPress={() => onChange(tab.key)}
          style={({ pressed }) => [
            styles.pill,
            active && styles.pillActive,
            pressed && !active && styles.pillPressed,
          ]}
        >
          <Text style={[styles.pillText, active && styles.pillTextActive]}>
            {tab.label}
          </Text>
        </Pressable>
      );
    },
    [activeTab, onChange, styles],
  );

  if (tabs.length === 0) return null;

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.track}
      >
        {tabs.map(renderTab)}
      </ScrollView>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    container: {
      // Hug content vertically + center: without this the native-stack header
      // stretches the row to the full nav-bar height, so the gray track
      // inflates and the pills look tiny floating inside it.
      alignSelf: "center",
      flexGrow: 0,
    },
    scroll: {
      flexGrow: 0,
      alignSelf: "center",
    },
    track: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      padding: 4,
      backgroundColor: c.gray100,
      borderRadius: 999,
    },
    pill: {
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 999,
    },
    pillActive: {
      backgroundColor: c.bg,
      shadowColor: "#000",
      shadowOpacity: 0.08,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
    pillPressed: {
      opacity: 0.7,
    },
    pillText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.charcoalMuted,
    },
    pillTextActive: {
      color: c.violet,
    },
  });
}
