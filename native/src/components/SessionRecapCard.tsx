import { useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";

/**
 * Session-end recap card — mirrors the web SessionRecapCard.
 * Shows a short portrait of growth moments from this session, drawn from
 * the scholar's own thinking (never a score or a praise dump).
 * Completed activities render immediately; conversational sessions can request
 * the same observer-backed recap without changing completion state.
 */
export function SessionRecapCard({
  sessionId,
  isComplete,
  canRequest = false,
}: {
  sessionId: Id<"sessions">;
  isComplete: boolean;
  canRequest?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [requested, setRequested] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const requestRecap = useAction(api.masteryObservations.requestRecap);

  const recap = useQuery(
    api.masteryObservations.recapForSession,
    isComplete || requested
      ? { sessionId, allowFallback: requested }
      : "skip",
  );

  const handleRequest = async () => {
    setRequesting(true);
    try {
      await requestRecap({ sessionId });
    } catch (error) {
      console.error("Could not refresh session recap", error);
    }
    setRequested(true);
    setRequesting(false);
  };

  if (!isComplete && !requested) {
    if (!canRequest) return null;
    return (
      <View style={styles.requestWrap}>
        <Pressable
          onPress={handleRequest}
          disabled={requesting}
          accessibilityRole="button"
          accessibilityLabel="Wrap up"
          accessibilityState={{
            busy: requesting,
            disabled: requesting,
          }}
          style={({ pressed }) => [
            styles.requestButton,
            pressed && !requesting && styles.requestButtonPressed,
          ]}
        >
          {requesting ? (
            <ActivityIndicator size="small" color={colors.violet} />
          ) : (
            <SymbolView name="sparkles" size={18} tintColor={colors.violet} />
          )}
          <Text style={styles.requestText}>
            {requesting ? "Reading back through your session…" : "Wrap up"}
          </Text>
        </Pressable>
      </View>
    );
  }

  if (dismissed || !recap?.length) return null;
  const tier = recap[0].tier;
  const title =
    tier === "growth"
      ? "Look what you figured out"
      : tier === "mirror"
        ? "A look back"
        : "Wrapped up";
  const subtitle =
    tier === "growth"
      ? "A few moments from your own thinking in this session."
      : tier === "mirror"
        ? "A true mirror of what you worked on today."
        : "You chose the stopping point.";

  return (
    <Animated.View entering={FadeIn.duration(300)} style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <SymbolView name="sparkles" size={20} tintColor={colors.violet} />
          <View style={styles.headerText}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>
          </View>
        </View>
        <Pressable
          onPress={() => setDismissed(true)}
          hitSlop={12}
          style={styles.dismiss}
          accessibilityLabel="Hide recap"
          accessibilityRole="button"
        >
          <SymbolView name="xmark" size={14} tintColor={colors.charcoalMuted} />
        </Pressable>
      </View>

      <View style={styles.lines}>
        {recap.map((item) => (
          <View key={item.key} style={styles.line}>
            <Text style={styles.lineText}>{item.text}</Text>
            {item.excerpt ? (
              <Text style={styles.excerpt}>&quot;{item.excerpt}&quot;</Text>
            ) : null}
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.violetSubtle,
      borderWidth: 1,
      borderColor: c.violetMuted,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
    },
    requestWrap: {
      alignItems: "center",
      gap: 6,
      marginBottom: 12,
    },
    requestButton: {
      alignItems: "center",
      borderColor: c.violetMuted,
      borderRadius: 12,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    requestButtonPressed: {
      backgroundColor: c.violetSubtle,
    },
    requestText: {
      color: c.violet,
      fontFamily: fonts.semibold,
      fontSize: 15,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: 12,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      flex: 1,
    },
    headerText: {
      flex: 1,
      gap: 2,
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: c.navy,
    },
    subtitle: {
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.charcoalMuted,
      lineHeight: 18,
    },
    dismiss: {
      marginLeft: 8,
      padding: 4,
    },
    lines: {
      gap: 8,
    },
    line: {
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.violetMuted,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      gap: 6,
    },
    lineText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.navy,
    },
    excerpt: {
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.charcoalMuted,
      fontStyle: "italic",
      lineHeight: 18,
    },
  });
}
