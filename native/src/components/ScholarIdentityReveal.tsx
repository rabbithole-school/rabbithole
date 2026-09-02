import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import {
  AppState,
  type AppStateStatus,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  Keyframe,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/lib/convex";
import { resolveUserImageUri } from "@/lib/webEmbedConfig";
import { fonts, palette, useColors } from "@/theme";
import { ScholarAvatar } from "@/components/ScholarAvatar";

const REVEAL_DURATION_MS = 3_000;

const GrowFromAccountMenu = new Keyframe({
  0: {
    opacity: 0,
    transform: [
      { translateX: 10 },
      { translateY: -10 },
      { scale: 0.84 },
    ],
  },
  100: {
    opacity: 1,
    transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }],
  },
});

const TuckIntoAccountMenu = new Keyframe({
  0: {
    opacity: 1,
    transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }],
  },
  100: {
    opacity: 0,
    transform: [
      { translateX: 10 },
      { translateY: -10 },
      { scale: 0.84 },
    ],
  },
});

function returnedToForeground(
  previous: AppStateStatus,
  next: AppStateStatus,
): boolean {
  return previous !== "active" && next === "active";
}

export function ScholarIdentityReveal() {
  const me = useQuery(api.users.currentUser, {});
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [revealId, setRevealId] = useState(0);
  const [visible, setVisible] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const lastInitiallyRevealedUserId = useRef<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scholarId = me?._id ?? null;

  const reveal = useCallback(() => {
    if (!scholarId) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setRevealId((value) => value + 1);
    setVisible(true);
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      hideTimer.current = null;
    }, REVEAL_DURATION_MS);
  }, [scholarId]);

  useEffect(() => {
    if (!me || lastInitiallyRevealedUserId.current === me._id) return;
    lastInitiallyRevealedUserId.current = me._id;
    reveal();
  }, [me, reveal]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appState.current;
      appState.current = nextState;
      if (returnedToForeground(previousState, nextState)) reveal();
    });

    return () => {
      subscription.remove();
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [reveal]);

  if (!visible || !me) return null;

  const name = me.name ?? me.username ?? "Scholar";
  const image = resolveUserImageUri(me.image);

  return (
    <Animated.View
      key={revealId}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      entering={reduceMotion ? undefined : GrowFromAccountMenu.duration(220)}
      exiting={reduceMotion ? undefined : TuckIntoAccountMenu.duration(180)}
      style={[styles.position, { top: insets.top + 18 }]}
    >
      <View style={styles.nameplate}>
        <Text style={styles.name} numberOfLines={2}>
          {name}
        </Text>
        <ScholarAvatar name={name} image={image} size={64} />
      </View>
    </Animated.View>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    position: {
      position: "absolute",
      right: 14,
      zIndex: 9_000,
      maxWidth: "68%",
      transformOrigin: "top right",
    },
    nameplate: {
      minHeight: 88,
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
      paddingVertical: 12,
      paddingLeft: 24,
      paddingRight: 14,
      backgroundColor: colors.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 22,
      shadowColor: palette.navy[900],
      shadowOpacity: 0.2,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    name: {
      flexShrink: 1,
      color: colors.navy,
      fontFamily: fonts.bold,
      fontSize: 34,
      lineHeight: 38,
    },
  });
}
