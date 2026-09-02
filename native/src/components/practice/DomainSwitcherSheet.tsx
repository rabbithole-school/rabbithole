import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { fonts, useColors } from "@/theme";
import { practiceDomainLabel } from "../../../vendor/shared/practiceDomainLabels";
import {
  scopeAllowsDomain,
  type PracticeScope,
} from "../../../vendor/shared/mathPlanScope";

type ChevronProps = { size?: number; color: string };

export function ChevronDownIcon({
  size = 12,
  color,
}: ChevronProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <Path
        d="m2.5 4.25 3.5 3.5 3.5-3.5"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ChevronRightIcon({ size = 14, color }: ChevronProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Path
        d="m5 3 4 4-4 4"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function DomainSwitcherSheet({
  open,
  onClose,
  currentDomain,
  activeDomains,
  onSelect,
  practiceScope,
}: {
  open: boolean;
  onClose: () => void;
  currentDomain: string;
  activeDomains: { domain: string; isPrimary: boolean }[];
  onSelect: (domain: string) => void;
  practiceScope?: PracticeScope;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(open);
  const availableDomains =
    practiceScope?.kind === "limited"
      ? activeDomains.filter(({ domain }) => scopeAllowsDomain(practiceScope, domain))
      : activeDomains;
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount latch for the exit animation; same open/close idiom as the other native sheets.
      setMounted(true);
      progress.set(withSpring(1, {
        damping: 25,
        stiffness: 300,
        mass: 0.8,
      }));
    } else if (mounted) {
      progress.set(withTiming(
        0,
        { duration: 180, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        },
      ));
    }
  }, [mounted, open, progress]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.get() * 0.42,
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.get()) * 420 }],
  }));

  const close = () => {
    Haptics.selectionAsync().catch(() => {});
    onClose();
  };

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      supportedOrientations={[
        "landscape",
        "landscape-left",
        "landscape-right",
      ]}
      onRequestClose={close}
    >
      <View style={styles.overlay}>
        <Animated.View
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close math domain switcher"
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, 16) },
            sheetStyle,
          ]}
          accessibilityViewIsModal
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>
              Switch math domain{" "}
              <Text style={styles.titleDetail}>· just for now</Text>
            </Text>
          </View>

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {availableDomains.map(({ domain, isPrimary }) => {
              const current = domain === currentDomain;
              return (
                <Pressable
                  key={domain}
                  accessibilityRole="button"
                  accessibilityState={{ selected: current }}
                  accessibilityLabel={`${practiceDomainLabel(domain)}${
                    isPrimary ? ", primary" : ""
                  }${current ? ", shown" : ""}`}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    if (current) onClose();
                    else onSelect(domain);
                  }}
                  style={({ pressed }) => [
                    styles.domainRow,
                    current && styles.domainRowCurrent,
                    pressed && styles.domainRowPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.domainLabel,
                      current && styles.domainLabelCurrent,
                    ]}
                    numberOfLines={1}
                  >
                    {practiceDomainLabel(domain)}
                  </Text>
                  {isPrimary ? (
                    <Text style={styles.primaryBadge}>Primary</Text>
                  ) : null}
                  {current ? (
                    <View style={styles.shown}>
                      <View style={styles.shownDot} />
                      <Text style={styles.shownText}>shown</Text>
                    </View>
                  ) : (
                    <ChevronRightIcon
                      size={14}
                      color={colors.charcoalSubtle}
                    />
                  )}
                </Pressable>
              );
            })}
            {practiceScope?.kind === "limited" && availableDomains.length === 0 ? (
              <Text style={styles.empty}>
                No practice is available in your current Math plan.
              </Text>
            ) : null}
            <Text style={styles.footer}>
              Dormant domains are not listed here — find them on the skills map.
            </Text>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    overlay: { flex: 1, justifyContent: "flex-end", alignItems: "center" },
    backdrop: { backgroundColor: "#000" },
    sheet: {
      width: "100%",
      maxWidth: 680,
      maxHeight: "72%",
      backgroundColor: c.bg,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: c.border,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.14,
      shadowRadius: 18,
      elevation: 14,
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.gray200,
      alignSelf: "center",
      marginTop: 10,
    },
    header: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8 },
    title: {
      fontFamily: fonts.bold,
      fontSize: 14,
      color: c.charcoal,
    },
    titleDetail: {
      fontFamily: fonts.regular,
      fontSize: 14,
      color: c.charcoalMuted,
    },
    list: { flexShrink: 1 },
    listContent: {
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 4,
      gap: 6,
    },
    domainRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.gray200,
      backgroundColor: c.bg,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    domainRowCurrent: {
      borderColor: c.violet,
      backgroundColor: c.violetSubtle,
    },
    domainRowPressed: { opacity: 0.72 },
    domainLabel: {
      flex: 1,
      minWidth: 0,
      fontFamily: fonts.medium,
      fontSize: 14,
      color: c.charcoal,
    },
    domainLabelCurrent: {
      fontFamily: fonts.bold,
      color: c.violetSolid,
    },
    primaryBadge: {
      flexShrink: 0,
      fontFamily: fonts.bold,
      fontSize: 10,
      letterSpacing: 0.4,
      textTransform: "uppercase",
      color: c.charcoalMuted,
    },
    shown: {
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    shownDot: {
      width: 7,
      height: 7,
      borderRadius: 999,
      backgroundColor: c.violet,
    },
    shownText: {
      fontFamily: fonts.semibold,
      fontSize: 12,
      color: c.violetSolid,
    },
    footer: {
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 18,
      color: c.charcoalMuted,
      paddingHorizontal: 2,
      paddingTop: 6,
      paddingBottom: 12,
    },
    empty: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoalMuted,
      paddingVertical: 12,
    },
  });
}
